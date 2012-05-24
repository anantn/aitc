/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["AitcManager"];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/Webapps.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");

Cu.import("resource://services-aitc/client.js");
Cu.import("resource://services-aitc/browserid.js");
Cu.import("resource://services-aitc/storage.js");
Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-common/preferences.js");
Cu.import("resource://services-common/tokenserverclient.js");
Cu.import("resource://services-common/utils.js");

const PREFS = new Preferences("services.aitc.");

/**
 * The constructor for the manager takes a callback, which will be invoked when
 * the manager is ready (construction is asynchronous). *DO NOT* call any
 * methods on this object until the callback has been invoked, doing so will
 * lead to undefined behaviour.
 */
function AitcManager(cb) {
  this._client = null;
  this._getTimer = null;
  this._putTimer = null;

  this._log = Log4Moz.repository.getLogger("Service.AITC.Manager");
  this._log.level = Log4Moz.Level[Preferences.get("manager.log.level")];
  this._log.info("Loading AitC manager module");

  // Check if we have pending PUTs from last time.
  let self = this;
  this._pending = new AitcQueue("webapps-pending.json", function _queueDone() {
    // Inform the AitC service that we're good to go!
    self._log.info("AitC manager has finished loading");
    cb(true);

    // Schedule them, but only if we can get a silent assertion.
    self._makeClient(function(err, client) {
      if (!err && client) {
        self._client = client;
        self._processQueue();
      }
    }, false);
  });
}
AitcManager.prototype = {
  get MARKETPLACE() {
    return PREFS.get("marketplace.url");
  },

  get DASHBOARD() {
    return PREFS.get("dashboard.url");
  },

  get TOKEN_SERVER() {
    return PREFS.get("tokenServer.url");
  },

  /**
   * Local app was just installed or uninstalled, ask client to PUT if user
   * is logged in.
   */
  appEvent: function appEvent(type, app) {
    // Add this to the equeue.
    let self = this;
    let obj = {type: type, app: app, retries: 0, lastTime: 0};
    this._pending.enqueue(obj, function _enqueued(err, rec) {
      if (err) {
        self._log.error("Could not add " + type + " " + app + " to queue");
        return;
      }

      // If we already have a client (i.e. user is logged in), attempt to PUT.
      if (self._client) {
        self._processQueue();
        return;
      }

      // If not, try a silent client creation.
      self._makeClient(function(err, client) {
        if (!err && client) {
          self._client = client;
          self._processQueue();
        }
        // If user is not logged in, we'll just have to try later.
      });
    });
  },

  /**
   * User is looking at dashboard. Start polling, but if user isn't logged in,
   * prompt for them to login via a dialog.
   */
  userOnDashboard: function userOnDashboard(win) {
    if (this._client) {
      this._startPoll();
      return;
    }

    // Make client will first try silent login, if it doesn't work, a popup
    // will be shown in the context of the dashboard. We shouldn't be
    // trying to make a client every time this function is called, there is
    // room for optimization (Bug 750607).
    let self = this;
    this._makeClient(function(err, client) {
      if (err) {
        // Notify user of error (Bug 750610).
        self._log.error("Client not created at Dashboard");
        return;
      }
      self._client = client;
      self._startPoll();
    }, true, win);
  },

  /**
   * User is not on the dashboard, we may stop polling (though PUTs will
   * still continue to be tried).
   */
  userOffDashboard: function userOffDashboard() {
    if (this._client) {
      this._stopPoll();
      return;
    }
  },

  /**
   * Poll the AITC server for any changes and process them. Call this whenever
   * the user is actively looking at the apps dashboard. It is safe to call
   * this function multiple times.
   */
  _startPoll: function _startPoll() {
    if (!this._client) {
      throw new Error("_startPoll called without client");
    }
    if (this._getTimer) {
      return;
    }

    // Check if there are any PUTs pending first.
    if (this._pending.length() && !(this._putTimer)) {
      // There are pending PUTs and no timer, so let's process them.
      this._processQueue();
    } else {
      // Do one GET soon.
      CommonUtils.nextTick(this._checkServer, this);
    }

    // Start the timer for GETs. In case there were pending PUTs, _checkServer
    // will automatically abort, and we'll retry after getFreq.
    let self = this;
    let getFreq = PREFS.get("manager.getFreq");
    this._log.info("Starting GET timer");
    this._getTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this._getTimer.initWithCallback(
      {
        notify: function _getTimerNotify() {
          self._checkServer();
        },
      }, getFreq, Ci.nsITimer.TYPE_REPEATING_SLACK
    );
    this._log.info("GET timer set, next attempt in " + getFreq + "ms");
  },

  /**
   * Stop polling for changes. Call this as soon as the user
   * isn't looking at the apps dashboard anymore. It is safe to call
   * this function even if runPeriodically() wasn't called before.
   */
  _stopPoll: function _stopPoll() {
    if (!this._getTimer) {
      return;
    }
    this._getTimer.cancel();
    this._getTimer = null;
  },

  /**
   * Do a GET check on the server to see if we have any new apps. Abort if
   * there are pending PUTs. If we GET some apps, send to storage for
   * further processing.
   */
  _checkServer: function _checkServer() {
    if (!this._client) {
      throw new Error("_checkServer called without a client");
    }

    if (this._pending.length()) {
      this._log.warn("_checkServer aborted because of pending PUTs");
      return;
    }

    // Do a GET
    let self = this;
    this._log.info("Attempting to getApps");
    this._client.getApps(function gotApps(err, apps) {
      if (err) {
        // Error was logged in client.
        return;
      }
      if (!apps) {
        // No changes, got 304.
        return;
      }
      if (!apps.length) {
        // Empty array, nothing to process
        self._log.info("No apps found on remote server");
        return;
      }

      // Send list of remote apps to storage to apply locally
      AitcStorage.processApps(apps, function processedApps() {
        self._log.info("processApps completed successfully, changes applied");
      });
    });
  },

  /**
   * Go through list of apps to PUT and attempt each one. If we fail, try
   * again in PUT_FREQ.
   */
  _processQueue: function _processPutQueue() {
    if (!this._client) {
      throw new Error("_processQueue called without a client");
    }

    if (!this._pending.length()) {
      this._log.info("There are no pending items, _processQueue closing");
      if (this._putTimer) {
        this._putTimer.clear();
      }
      return;
    }

    if (this._putInProgress) {
      // The network request sent out as a result to the last call to
      // _processPutQueue still isn't done. A timer is created they all
      // finish to make sure this function is called again if neccessary.
      return;
    }

    let self = this;
    this._putInProgress = true;
    let record = this._pending.peek();

    this._log.info("Processing record type " + record.type);
    function _clientCallback(err, done) {
      // Send to end of queue if unsuccessful or err.removeFromQueue is false.
      if (err && !err.removeFromQueue) {
        self._log.info("PUT failed, re-adding to queue");

        // Update retries and time
        record.retries += 1;
        record.lastTime = new Date().getTime();

        // Add updated record to the end of the queue.
        self._pending.enqueue(record, function(err, done) {
          if (err) {
            self._log.error("Enqueue failed " + err);
            _reschedule();
            return;
          }
          // If record was successfully added, remove old record.
          self._pending.dequeue(function(err, done) {
            if (err) {
              self._log.error("Dequeue failed " + err);
            }
            _reschedule();
            return;
          });
        });
      }

      // If succeeded or client told us to remove from queue
      self._log.info("_putApp asked us to remove it from queue");
      self._pending.dequeue(function(err, done) {
        if (err) {
          self._log.error("Dequeue failed " + e);
        }
        _reschedule();
      });
    }

    function _reschedule() {
      // Release PUT lock
      self._putInProgress = false;

      // We just finished PUTting an object, try the next one immediately,
      // but only if haven't tried it already in the last putFreq (ms).
      if (!self._pending.length()) {
        return;
      }

      let obj = self._pending.peek();
      let cTime = new Date().getTime();
      let freq = PREFS.get("manager.putFreq");

      // We tried this object recently, we'll come back to it later.
      if (obj.lastTime && ((cTime - obj.lastTime) < freq)) {
        self._log.info("Scheduling next processQueue in " + freq);
        CommonUtils.namedTimer(self._processQueue, freq, self, "_putTimer");
        return;
      }

      // Haven't tried this PUT yet, do it immediately.
      self._log.info("Queue non-empty, processing next PUT");
      self._processQueue();
    }

    switch (record.type) {
      case "install":
        this._client.remoteInstall(record.app, _clientCallback);
        break;
      case "uninstall":
        record.app.deleted = true;
        this._client.remoteUninstall(record.app, _clientCallback);
        break;
      default:
        this._log.warn(
          "Unrecognized type " + record.type + " in queue, removing"
        );
        let self = this;
        this._pending.dequeue(function _dequeued(err) {
          if (err) {
            self._log.error("Dequeue of unrecognized app type failed");
          }
          _reschedule();
        });
    }
  },

  /* Obtain a token from Sagrada token server, given a BrowserID assertion
   * cb(err, token) will be invoked on success or failure.
   */
  _getToken: function _getToken(assertion, cb) {
    let url = this.TOKEN_SERVER + "/1.0/aitc/1.0";
    let client = new TokenServerClient();

    let self = this;
    this._log.info("Obtaining token from " + url);
    client.getTokenFromBrowserIDAssertion(url, assertion, function(err, tok) {
      if (!err) {
        self._log.info("Got token from server: " + JSON.stringify(tok));
        cb(null, tok);
        return;
      }

      if (!err.response) {
        self._log.error(err);
        cb(err, null);
        return;
      }
      if (!err.response.success) {
        self._log.error(err);
        cb(err, null);
        return;
      }

      let msg = "Unknown error in _getToken " + err.message;
      self._log.error(msg);
      cb(new Error(msg), null);
    });
  },

  /* To start the AitcClient we need a token, for which we need a BrowserID
   * assertion. If login is true, makeClient will ask the user to login in
   * the context of win. cb is called with (err, client).
   */
  _makeClient: function makeClient(cb, login, win) {
    if (!cb) {
      throw new Error("makeClient called without callback");
    }
    if (login && !win) {
      throw new Error("makeClient called with login as true but no win");
    }

    if (this._client) {
      let msg = "Client already exists, not creating";
      self._log.info(msg);
      cb(new Error(msg), null);
      return;
    }

    let self = this;
    let ctxWin = win;
    function processAssertion(val) {
      self._log.info("Got assertion from BrowserID, creating token");
      self._getToken(val, function(err, token) {
        if (err) {
          cb(err, null);
          return;
        }
        cb(null, new AitcClient(token));
      });
    }
    function gotSilentAssertion(err, val) {
      self._log.info("gotSilentAssertion called");
      if (err) {
        // If we were asked to let the user login, do the popup method.
        if (login) {
          self._log.info("Could not obtain silent assertion, retrying login");
          BrowserID.getAssertionWithLogin(function gotAssertion(err, val) {
            if (err) {
              self._log.error(err);
              cb(err, false);
              return;
            }
            processAssertion(val);
          }, ctxWin);
          return;
        }
        self._log.warn("Could not obtain assertion in _makeClient");
        cb(err, false);
      } else {
        processAssertion(val);
      }
    }

    // Check if we can get assertion silently first
    self._log.info("Attempting to obtain assertion silently")
    BrowserID.getAssertion(gotSilentAssertion, {
      audience: this.DASHBOARD, sameEmailAs: this.MARKETPLACE
    });
  },

};
