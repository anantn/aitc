/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ['AitcClient'];

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://services-common/rest.js");
Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-common/preferences.js");

const PREFS = new Preferences("services.aitc.client.");

function AitcClient(token) {
  this.uri = token.endpoint.replace(/\/+$/, "");
  this.token = {id: token.id, key: token.key};

  this._log = Log4Moz.repository.getLogger("Services.AITC.Client");
  this._log.level = Log4Moz.Level[PREFS.get("log.level")];
  let dapp = new Log4Moz.DumpAppender();
  dapp.level = Log4Moz.Level["Info"];
  this._log.addAppender(dapp);
  
  this._backoff = false;
  if (PREFS.get("backoff", 0)) {
    this._backoff = true;
  }

  this._appsLastModified = null;
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

    if (!this._checkBackoff()) {
      cb(null, null);
      return;
    }

    let uri = this.uri + "/apps/?full=1";
    let req = new TokenAuthenticatedRESTRequest(uri, this.token);
    if (this._appsLastModified) {
      req.setHeader("x-if-modified-since", this._appsLastModified);
    }

    let self = this;
    req.get(function(error) {
      if (error) {
        self._log.error("getApps request error " + error);
        cb(error, null);
        return;
      }

      // Set X-Backoff or Retry-After, if needed
      self._setBackoff(req);
      
      // Process response
      if (req.response.status == 304) {
        self._log.info("getApps returned 304");
        cb(null, null);
        return;
      }
      if (req.response.status != 200) {
        self._error(req);
        cb(new Error("Unexpected error with getApps"), null);
        return;
      }

      try {
        let tmp = JSON.parse(req.response.body);
        self._log.info("getApps succeeded and got " + tmp.length + " apps");
        cb(null, tmp["apps"]);
        // Don't update lastModified until we know cb succeeded.
        self._appsLastModified = parseInt(req.response.headers['x-timestamp']);
      } catch (e) {
        self._log.error("Exception in getApps " + e);
      }
    });
  },

  /**
   * Change a given app record to match what the server expects.
   * Change manifestURL to manifestPath, and trim out manifests since we 
   * don't store them on the server.
   */
  _makeRemoteApp: function _makeRemoteApp(app) {
    for each (let key in this.requiredLocalKeys) {
      if (!app.key) {
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
      if (!app.key) {
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
    if (!this._checkBackoff) {
      // PUT requests may qualify as the "minimum number of additional requests
      // required to maintain consistency of their stored data". However, it's
      // better to keep server load low, even if it means user's apps won't
      // reach their other devices during the early days of AITC. We should
      // revisit this when we have a better of idea of server load curves.
      err = new Error("X-Backoff in effect, aborting PUT");
      err.removeFromQueue = false;
      cb(err, null);
      return;
    }

    let uri = this._makeAppURI(app.record.origin);
    let req = new TokenAuthenticatedRESTRequest(uri, this.token);
    if (app.modified) {
      req.setHeader("X-If-Unmodified-Since", app.modified);
    }

    req.put(JSON.stringify(appRec), function _tryPuttingAppFinished(error) {
      if (error) {
        self._log.error("_putApp request error " + error);
        cb(error, null);
        return;
      }

      self._setBackoff(req);

      let err = null;
      switch (req.response.status) {
        case 201:
        case 204:
          self._log.info("_putApp succeeded");
          cb(null, true);
          break;

        case 400:
        case 412:
        case 413:
          let msg = "_putApp returned: " + req.response.status;
          self._log.warn(msg);
          err = new Error(msg);
          err.removeFromQueue = true;
          cb(err, null);
          break;

        default:
          self._error(req);
          err = new Error("Unexpected error with _putApp");
          err.removeFromQueue = false;
          cb(err, null);
          break;
      }
    });
  },

  /**
   * Utility methods.
   */
  _error: function _error(req) {
    this._log.error("Catch-all error for request for: " + 
      req.uri.asciiSpec + req.response.status + " with: " + req.response.body);
  },

  _makeAppURI: function _makeAppURI(origin) {
    let part = CryptoUtils.sha1Base64URLFriendly(origin);
    return this.uri + "/apps/" + part;
  },

  // Before making a request, check if we are allowed to.
  _checkBackoff: function _checkBackoff() {
    if (!this._backoff) {
      return true;
    }

    let time = new Date().getTime();
    let lastReq = PREFS.get("lastReq", 0);
    let backoff = PREFS.get("backoff", 0);

    if (lastReq + (backoff * 1000) < time) {
      this._log.warn("X-Backoff is " + backoff + ", not making request");
      return false;
    }

    this._backoff = false;
    PREFS.put("backoff", 0);
    return true;
  },

  // Set values from X-Backoff and Retry-After headers, if present
  _setBackoff: function _setBackoff(req) {
    let backoff = 0;
    PREFS.put("lastReq", new Date().getTime());
    if (req.response.headers['x-backoff']) {
      backoff = req.response.headers['x-backoff'];
    }
    if (req.response.headers['retry-after']) {
      backoff = req.response.headers['retry-after'];
    }
    if (backoff) {
      self._backoff = true;
      PREFS.put("backoff", backoff);
    }
  },
};