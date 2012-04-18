/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ['AitcClient'];

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/Webapps.jsm");
Cu.import("resource://services-common/rest.js");
Cu.import("resource://services-common/utils.js");
Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-common/preferences.js");

const PREFS = new Preferences("services.aitc.client.");

// XXX: Inline these
const GET_FREQ = PREFS.get("getFrequency");
const PUT_FREQ = PREFS.get("putFrequency");

function AitcClient(token, registry) {
  this.uri = token.endpoint.replace(/\/+$/, "");
  this.token = {id: token.id, key: token.key};

  this.registry = registry || DOMApplicationRegistry;
  this._log = Log4Moz.repository.getLogger("Services.AITC.Client");
  this._log.level = Log4Moz.Level[PREFS.get("log.level")];

  this.appsLastModified = null;
  this._log.info("Client initialized with token endpoint: " + this.uri);
}
AitcClient.prototype = {
  _putQueue: [],
  _putTimer: null,
  _putInProgress: false,

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
    let record = this._makeRemoteApp(app);
    record.deleted = true;
    this._putApp(record, cb);
  },

  /**
   * Do a GET to see if there's anything new for us.
   */
  checkServer: function checkServer(cb) {
    this._log.info("Starting scheduled server check");
    
    if (this._putQueue.length) {
      let msg = "checkServer aborted due to PUTs in progress";
      this._log.warn(msg);
      throw new Error(msg);
    }

    this._getApps(cb, this._gotRemoteApps);
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
   * Receive remote apps, proceed to get local apps for processing.
   */
  _gotRemoteApps: function _gotRemoteApps(error, remoteApps) {
    if (error) {
      this._log.error("_getApps failed, will retry on next _checkServer");
      return;
    } else if (!remoteApps) {
      this._log.info("_getApps got no new apps");
      return;
    }
    
    // _processApps checks for the validity of remoteApps.
    let self = this;
    this._log.info("Server check got " + remoteApps.length + "apps");
    DOMApplicationRegistry.getAllWithoutManifests(
      function _checkServerGotLocalApps(localApps) {
        self._processApps(remoteApps, localApps, function _checkServerGotApps() {
          self._log.info("processResponse completed and saved result");
        });
      }
    );
  },

  /**
   * Fetch remote apps from server.
   */
  _getApps: function _getApps(originalCb, cb) {
    if (!cb) {
      throw new Error("getApps called but no callback provided");
    }

    // If there's an unfinished PUT or a PUT that didn't succeed, just bail.
    if (this._putQueue.length) {
      this._log.warn("getApps called, but aborting due to outstanding PUT(s)!");
      throw new Error("PUT(s) in progress, aborting GET!");
    }

    let req = new TokenAuthenticatedRESTRequest(this.uri + "/apps/?full=1",
                                                this.token);
    if (this.appsLastModified) {
      req.setHeader("X-If-Modified-Since", this.appsLastModified);
    }

    let self = this;
    req.get(function(error) {
      if (error) {
        self._log.error("_getApps request error " + error);
        originalCb(error, null);
        return;
      }
      if (req.response.status == 304) {
        self._log.info("_getApps returned 304");
        originalCb(null, null);
        return;
      }
      if (req.response.status != 200) {
        self._error(req);
        originalCb(new Error("Unexpected error with getApps"), null);
        return;
      }

      try {
        let tmp = JSON.parse(req.response.body);
        self._log.info("_getApps succeeded");
        cb(null, tmp["apps"]);
        // Don't update lastModified until we know cb succeeded.
        self.appsLastModified = parseInt(req.response.headers['x-timestamp']);
      } catch (e) {
        self._log.error("Exception in _getApps " + e);
      }
    });
  },

  /**
   * Add a PUT request to the queue.
   */
  _putApp: function _putApp(appRec, appLastModified) {
    this._putQueue.push({
      record:   appRec,
      modified: appLastModified
    });
    this._processPutQueue();
  },

  /**
   * Go through list of apps to PUT and attempt them. If we fail any, try
   * them again PUT_FREQ.
   * XXX: Sequentiall fire PUT requests from the queueu.
   */
  _processPutQueue: function _processPutQueue() {
    if (this._putInProgress) {
      // The network requests sent out as a result to the last call to
      // _processPutQueue still aren't done. A timer is created they all
      // finish to make sure this function is called again if neccessary.
      return;
    }

    // If we're done with PUTs, stop timer
    if (!this._putQueue.length) {
      if (this._putTimer) {
        this._putTimer.cancel();
      }
      return;
    }
    
    // Copy current state of _putQueue.
    let done = 0;
    let unfinished = [];

    // XXX: copy
    let processNow = this._putQueue;

    // We should empty out _putQueue now so we can know if there were any new
    // apps added by calls to _putApp when we are finished. However, many
    // places in the code check for _putQueue.length to know if there are
    // outstanding PUTs, so we put a dummy value in it.
    this._putQueue = ["DUMMY_APP"];

    let self = this;
    for (let i = 0; i < processNow.length; i++) {

      let app = processNow[i];
      this._tryPuttingApp(app, function(err, success) {
        // Add back to queue if unsuccessful or err.removeFromQueue is false.
        if (err && !err.removeFromQueue) {
          unfinished.push(app);
        }

        // Check if this the last app in the queue to finish
        done += 1
        if (done == processNow.length) {
          // Merge any apps that were added while we were busy and the
          // unfinished ones (put new apps first).
          self._putQueue = self._putQueue.concat(unfinished);

          // Remove our DUMMY_APP.
          self._putQueue.splice(0, 1);

          // _processPutQueue is open for business again!
          self._putInProgress = false;

          // If any apps remain in the queue, try again in a bit.
          if (self._putQueue.length) {
            CommonUtils.namedTimer(
              self._processPutQueue, PUT_FREQ, self, "_putTimer"
            );
          }
        }
      });
    }
  },

  /**
   * Try PUT for an app on the server and determine if we should retry
   * if it fails.
   */
  _tryPuttingApp: function _tryPuttingApp(app, cb) {
    let uri = this._makeAppURI(app.record.origin);
    let req = new TokenAuthenticatedRESTRequest(uri, this.token);
    if (app.modified) {
      req.setHeader("X-If-Unmodified-Since", app.modified);
    }

    req.put(JSON.stringify(appRec), function _tryPuttingAppFinished(error) {
      if (error) {
        self._log.error("_tryPuttingApp request error " + error);
        cb(error, null);
        return;
      }

      let err = null;
      switch (req.response.status) {
        case 201:
        case 204:
          self._log.info("_tryPuttingApp succeeded");
          cb(null, true);
          break;

        case 400:
        case 412:
        case 413:
          let msg = "_tryPuttingApp returned: " + req.response.status;
          self._log.warn(msg);
          err = new Error(msg);
          err.removeFromQueue = true;
          cb(err, null);
          break;

        default:
          self._error(req);
          err = new Error("Unexpected error with _tryPuttingApp");
          err.removeFromQueue = false;
          cb(err, null);
          break;
      }
    });
  },

  /**
   * Fetch a manifest from given URL. No retries are made on failure.
   */
  _getManifest: function _getManifest(url, callback)  {
    let req = new RESTRequest(url);
    req.get(function(error) {
      if (error) {
        callback(error, null);
        return;
      }
      if (!req.response.success) {
        callback(new Error("Non-200 while fetching manifest"), null);
        return;
      }

      let err = null;
      let manifest = null;
      try {
        manifest = JSON.parse(req.response.body);
        if (!manifest.name) {
          self._log.warn(
            "_getManifest got invalid manifest: " + req.response.body
          );
          err = new Error("Invalid manifest fetched");
          manifest = null;
        }
      } catch (e) {
        self._log.warn(
          "_getManifest got invalid JSON response: " + req.response.body
        );
        err = new Error("Invalid manifest fetched");
        manifest = null;
      }

      callback(err, manifest);
    });
  },

  /**
   * Determines what changes are to be made locally, given a list of local
   * and remote apps.
   */
  _processApps: function _processApps(remoteApps, lApps, callback) {
    let toDelete = {};
    let localApps = {};
    
    // Convert lApps to a dictionary of origin -> app (instead of id -> app)
    for (let [id, app] in Iterator(localApps)) {
      app.id = id;
      toDelete[app.origin] = app;
      localApps[app.origin] = app;
    }


    // Iterate over remote apps, and find out what changes we must apply.
    let toInstall = [];
    for each (let app in remoteApps) {
      // Don't delete apps that are both local & remote.
      let origin = app.origin;
      delete toDelete[origin];

      // If there is a remote app that isn't local or 
      // if the remote app was installed later
      if ((!(origin in localApps)) ||
           localApps[origin].installTime < app.installTime) {
        
        let id = localApps[origin].id || DOMApplicationRegistry.makeAppId();

        // We should install this app locally
        try {          
          let record = {id: id, value: this._makeLocalApp(app)};
          toInstall.push(record);
        } catch (e) {
          // App was an invalid record
          this._log.error("A remote app was found to be invalid " + e);
        }
      }
    }

    // Uninstalls only need the ID & deleted flag
    let toUninstall = [];
    for (let origin in toDelete) {
      toUninstall.push({id: toDelete[origin].id, deleted: true});
    }

    // Apply installs & uninstalls
    this._applyUpdates(toInstall, toUninstall, callback);
    return;
  },

  /**
   * Applies a list of commands as determined by _processApps locally
   */
  _applyUpdates: function _applyUpdates(toInstall, toUninstall, callback) {
    let finalCommands = [];
    let toUpdate = toInstall.length;

    let self = this;
    function onManifestsUpdated() {
      finalCommands.push(toUninstall);
      if (finalCommands.length) {
        self._log.info(
          "processUpdates finished fetching manifests, calling updateApps"
        );
        DOMApplicationRegistry.updateApps(finalCommands, callback);
      } else {
        self._log.info(
          "processUpdates finished fetching, no finalCommands were found"
        );
        callback();
      }
    }

    // Update manifests for all the new remote apps we have.
    let done = 0;
    for (let j = 0; j < toUpdate; j++) {
      let app = toInstall[j];
      let url = app.value.manifestURL;
      if (url[0] == "/") {
        url = app.value.origin + app.value.manifestURL;
      }

      this._log.info("Updating manifest " + url + "\n");
      this._getManifest(url, function(err, manifest) {
        if (!err) {
          app.value.manifest = manifest;
          finalCommands.push({id: app.id, value: app.value});
          self._log.info(app.id + " was added to finalCommands");
        } else {
          self._log.debug("Couldn't fetch manifest at " + url + ": " + err);
        }

        // Not a big deal if we couldn't get a manifest, we will try to fetch
        // it again on the next checkServer. Carry on.
        done += 1;
        if (done == toUpdate) {
          onManifestsUpdated();
        }
      });
    }
  }

};