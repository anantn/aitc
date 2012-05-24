/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["AitcClient"];

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-common/preferences.js");
Cu.import("resource://services-common/rest.js");
Cu.import("resource://services-common/utils.js");
Cu.import("resource://services-crypto/utils.js");

/**
 * First argument is a token as returned by CommonUtils.TokenServerClient.
 * Second argument is a key-value store object that exposes two methods:
 *   set(key, value);     Sets the value of a given key
 *   get(key, default);   Returns the value of key, if it doesn't exist,
 *                        return default
 * The values should be stored persistently. The Preferences object from
 * services-common/preferences.js is an example of such an object.
 */
function AitcClient(token, state) {
  this.uri = token.endpoint.replace(/\/+$/, "");
  this.token = {id: token.id, key: token.key};

  this._log = Log4Moz.repository.getLogger("Service.AITC.Client");
  this._log.level = Log4Moz.Level[
    Preferences.get("services.aitc.client.log.level")
  ];
  
  this._state = state;
  this._backoff = !!state.get("backoff", false);

  this._appsLastModified = parseInt(state.get("lastModified", "0"), 10);
  this._log.info("Client initialized with token endpoint: " + this.uri);
}
AitcClient.prototype = {
  _requiredLocalKeys: [
    "origin", "receipts", "manifestURL", "installOrigin"
  ],
  _requiredRemoteKeys: [
    "origin", "receipts", "manifestPath", "installOrigin",
    "installedAt", "modifiedAt"
  ],

  /**
   * Initiates an update of a newly installed app to the AITC server. Call this
   * when an application is installed locally.
   *
   * @param app
   *        (Object) The app record of the application that was just installed.
   */
  remoteInstall: function remoteInstall(app, cb) {
    if (!cb) {
      throw new Error("remoteInstall called without callback");
    }

    this._putApp(this._makeRemoteApp(app), cb);
  },

  /**
   * Initiates an update of an uinstalled app to the AITC server. Call this
   * when an application is uninstalled locally.
   *
   * @param app
   *        (Object) The app record of the application that was uninstalled.
   */
  remoteUninstall: function remoteUninstall(app, cb) {
    if (!cb) {
      throw new Error("remoteUninstall called without callback");
    }

    let record = this._makeRemoteApp(app);
    record.deleted = true;
    this._putApp(record, cb);
  },

  /**
   * Fetch remote apps from server with GET.
   */
  getApps: function getApps(cb) {
    if (!cb) {
      throw new Error("getApps called but no callback provided");
    }

    if (!this._isRequestAllowed()) {
      cb(null, null);
      return;
    }

    let uri = this.uri + "/apps/?full=1";
    let req = new TokenAuthenticatedRESTRequest(uri, this.token);
    if (this._appsLastModified) {
      req.setHeader("X-If-Modified-Since", this._appsLastModified);
    }

    let self = this;
    req.get(function(err) {
      self._processGetApps(err, cb);
    });
  },

  /**
   * GET request returned from getApps, process.
   */
  _processGetApps: function _processGetApps(error, cb) {
    if (error) {
      this._log.error("getApps request error " + error);
      cb(error, null);
      return;
    }

    // Set X-Backoff or Retry-After, if needed.
    this._setBackoff(req);
    
    // Process response.
    if (req.response.status == 304) {
      this._log.info("getApps returned 304");
      cb(null, null);
      return;
    }
    if (req.response.status != 200) {
      this._error(req);
      cb(new Error("Unexpected error with getApps"), null);
      return;
    }

    let apps = [];
    try {
      let tmp = JSON.parse(req.response.body);
      tmp = tmp["apps"];
      // Convert apps from remote to local format.
      apps = tmp.map(this._makeLocalApp, this);
      this._log.info("getApps succeeded and got " + apps.length);
    } catch (e) {
      let err = new Error("Exception in getApps " + e);
      this._log.error(err);
      cb(err, null);
      return;
    }
    
    // Return success.
    try {
      cb(null, apps);
      // Don't update lastModified until we know cb succeeded.
      this._appsLastModified = parseInt(req.response.headers["X-Timestamp"]);
      this._state.put("lastModified", ""  + this._appsLastModified);
    } catch (e) {
      this._log("Exception in getApps callback " + e);
    }
  },

  /**
   * Change a given app record to match what the server expects.
   * Change manifestURL to manifestPath, and trim out manifests since we 
   * don't store them on the server.
   */
  _makeRemoteApp: function _makeRemoteApp(app) {
    for each (let key in this.requiredLocalKeys) {
      if (!(key in app)) {
        throw new Error("Local app missing key " + key);
      }
    }

    let record = {
      origin:        app.origin,
      receipts:      app.receipts,
      manifestPath:  app.manifestURL,
      installOrigin: app.installOrigin
    };
    if ("modifiedAt" in app) {
      record.modifiedAt = app.modifiedAt;
    }
    if ("installedAt" in app) {
      record.installedAt = app.installedAt;
    }
    return record;
  },

  /**
   * Change a given app record received from the server to match what the local
   * registry expects. (Inverse of _makeRemoteApp)
   */
  _makeLocalApp: function _makeLocalApp(app) {
    for each (let key in this._requiredRemoteKeys) {
      if (!(key in app)) {
        throw new Error("Remote app missing key " + key);
      }
    }

    let record = {
      origin:         app.origin,
      installOrigin:  app.installOrigin,
      installedAt:    app.installedAt,
      modifiedAt:     app.modifiedAt,
      manifestURL:    app.manifestPath,
      receipts:       app.receipts
    };
    if ("deleted" in app) {
      record.deleted = app.deleted;
    }
    return record;
  },

  /**
   * Try PUT for an app on the server and determine if we should retry
   * if it fails.
   */
  _putApp: function _putApp(app, cb) {
    if (!this._isRequestAllowed()) {
      // PUT requests may qualify as the "minimum number of additional requests
      // required to maintain consistency of their stored data". However, it's
      // better to keep server load low, even if it means user's apps won't
      // reach their other devices during the early days of AITC. We should
      // revisit this when we have a better of idea of server load curves.
      err = new Error("X-Backoff in effect, aborting PUT");
      err.processed = false;
      cb(err, null);
      return;
    }

    let uri = this._makeAppURI(app.origin);
    let req = new TokenAuthenticatedRESTRequest(uri, this.token);
    if (app.modifiedAt) {
      req.setHeader("X-If-Unmodified-Since", "" + app.modified);
    }

    let self = this;
    this._log.info("Trying to _putApp to " + uri);
    req.put(JSON.stringify(app), function(err) {
      self._setBackoff(req);
      self._processPutApp(err, cb);
    });
  },

  /**
   * PUT from _putApp finished, process.
   */
  _processPutApp: function _processPutApp(error, cb) {
    if (error) {
      this._log.error("_putApp request error " + error);
      cb(error, null);
      return;
    }

    let err = null;
    switch (req.response.status) {
      case 201:
      case 204:
        this._log.info("_putApp succeeded");
        cb(null, true);
        break;

      case 400:
      case 412:
      case 413:
        let msg = "_putApp returned: " + req.response.status;
        this._log.warn(msg);
        err = new Error(msg);
        err.processed = true;
        cb(err, null);
        break;

      default:
        this._error(req);
        err = new Error("Unexpected error with _putApp");
        err.processed = false;
        cb(err, null);
        break;
    }
  },

  /**
   * Utility methods.
   */
  _error: function _error(req) {
    this._log.error("Catch-all error for request: " + 
      req.uri.asciiSpec + req.response.status + " with: " + req.response.body);
  },

  _makeAppURI: function _makeAppURI(origin) {
    let part = CommonUtils.encodeBase64URL(
      CryptoUtils.UTF8AndSHA1(origin)
    ).replace("=", "");
    return this.uri + "/apps/" + part;
  },

  // Before making a request, check if we are allowed to.
  _isRequestAllowed: function _isRequestAllowed() {
    if (!this._backoff) {
      return true;
    }

    let time = Date.now();
    let backoff = parseInt(this._state.get("backoff", 0), 10);

    if (time < backoff) {
      this._log.warn(backoff - time + " left for backoff, not making request");
      return false;
    }

    this._backoff = false;
    this._state.set("backoff", "0");
    return true;
  },

  // Set values from X-Backoff and Retry-After headers, if present
  _setBackoff: function _setBackoff(req) {
    let backoff = 0;
    let time = Date.now();

    if (req.response.headers["X-Backoff"]) {
      backoff = parseInt(req.response.headers["X-Backoff"], 10);
      this._log.warn("X-Backoff header was seen: " + backoff);
    }
    if (req.response.headers["Retry-After"]) {
      backoff = parseInt(req.response.headers["Retry-After"], 10);
      this._log.warn("Retry-Header header was seen: " + backoff);
    }
    if (backoff) {
      this._backoff = true;
      this._state.set("backoff", "" + (time + (backoff * 1000)));
    }
  },
};