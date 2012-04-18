/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["Aitc"];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/Webapps.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/identity/browserid.js");

Cu.import("resource://services-aitc/client.js");
Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-common/preferences.js");
Cu.import("resource://services-common/tokenserverclient.js");

function AitcSvc() {
  this._log = Log4Moz.repository.getLogger("Service.AITC");
  this._log.level = Log4Moz.Level[Preferences.get(
    "services.aitc.log.logger.service"
  )];
  let dapp = new Log4Moz.DumpAppender();
  dapp.level = Log4Moz.Level["Info"];
  this._log.addAppender(dapp);
  this._log.info("Loading AitC");
  this._manager = new AitcClientManager();
}
AitcSvc.prototype = {
  get DASHBOARD() {
    return Preferences.get("services.aitc.dashboard.url");
  },

  // The goal of the init function is to be ready to activate the AITC
  // client whenever the user is looking at the dashboard
  init: function init() {
    let self = this;

    // This is called iff the user is currently looking the dashboard
    function dashboardLoaded(browser) {
      self._log.info("Dashboard was accessed");
      self._manager.userOnDashboard(browser.contentWindow);
    }
    // This is called when the user's attention is elsewhere
    function dashboardUnloaded() {
      self._log.info("Dashboard closed or in background");
      self._manager.userOffDashboard();
    }

    // Called when a URI is loaded in any tab. We have to listen for this
    // because tabSelected is not called if I open a new tab which loads
    // about:home and then navigate to the dashboard, or navigation via
    // links on the currently open tab
    let listener = {
      onLocationChange: function onLocationChange(browser, progress, req, location, flags) {
        let win = Services.wm.getMostRecentWindow("navigator:browser");
        if (win.gBrowser.selectedBrowser == browser) {
          let uri = location.spec.substring(0, self.DASHBOARD.length);
          if (uri == self.DASHBOARD) {
            dashboardLoaded(browser);
          }
        }
      }
    };
    // Called when the current tab selection changes
    function tabSelected(event) {
      let browser = event.target.linkedBrowser;
      let uri = browser.currentURI.spec.substring(0, self.DASHBOARD.length);
      if (uri == self.DASHBOARD) {
        dashboardLoaded(browser);
      } else {
        dashboardUnloaded();
      }
    }

    // Add listeners for all windows opened in the future
    function winWatcher(subject, topic) {
      if (topic != "domwindowopened") return;
      subject.addEventListener("load", function winWatcherLoad() {
        subject.removeEventListener("load", winWatcherLoad, false);
        let doc = subject.document.documentElement;
        if (doc.getAttribute("windowtype") == "navigator:browser") {
          let browser = subject.gBrowser;
          browser.addTabsProgressListener(listener);
          browser.tabContainer.addEventListener("TabSelect", tabSelected);
        }
      }, false);
    }
    Services.ww.registerNotification(winWatcher);

    // Add listeners for all current open windows
    let enumerator = Services.wm.getEnumerator("navigator:browser");
    while (enumerator.hasMoreElements()) {
      let browser = enumerator.getNext().gBrowser;
      browser.addTabsProgressListener(listener);
      browser.tabContainer.addEventListener("TabSelect", tabSelected);

      // Also check the currently open URI
      let uri = browser.contentDocument.location.toString().substring(
        0, self.DASHBOARD.length
      );
      if (uri == self.DASHBOARD) {
        dashboardLoaded(browser);
      }
    }

    // Add listeners for app installs/uninstall
    Services.obs.addObserver(this, "webapps-sync-install", false);
    Services.obs.addObserver(this, "webapps-sync-uninstall", false);
  },

  observe: function(aSubject, aTopic, aData) {
    let app;
    switch (aTopic) {
      case "webapps-sync-install":
        app = JSON.parse(aData);
        this._log.info(app.origin + " was installed, initiating PUT");
        this._manager.appEvent("install", app);
        break;
      case "webapps-sync-uninstall":
        app = JSON.parse(aData);
        this._log.info(app.origin + " was uninstalled, initiating PUT");
        this._manager.appEvent("uninstall", app);
        break;
    }
  }
};

function AitcClientManager() {
  this._timer = null,
  this._client = null;
  this._log = Log4Moz.repository.getLogger("Service.AITC.Manager");
  this._log.level = Log4Moz.Level[Preferences.get(
    "services.aitc.log.logger.service"
  )];
  let dapp = new Log4Moz.DumpAppender();
  dapp.level = Log4Moz.Level["Info"];
  this._log.addAppender(dapp);
  this._pending = {"install": [], "uninstall": []};
}
AitcClientManager.prototype = {
  get MARKETPLACE() {
    return Preferences.get("services.aitc.marketplace.url");
  },

  get TOKEN_SERVER() {
    return Preferences.get("services.aitc.tokenServer.url");
  },

  /**
   * Local app was just installed or uninstalled, ask client to PUT if user
   * is logged in.
   */
  appEvent: function appEvent(type, app) {
    if (this._client) {
      this._doAppEvent(type, app);
    }

    // Silent client creation
    let self = this;
    this._makeClient(function(err, client) {
      if (!err && client) {
        self._client = client;
        self._doAppEvent(type, app);
      } else {
        // Put in pending list and try later
        self._pending[type].push(app);
      }
    });
  },

  /**
   * User is looking at dashboard. Start polling, if user isn't logged in,
   * prompt for one.
   */
  userOnDashboard: function userOnDashboard(win) {
    if (this._client) {
      this._startPoll();
      return;
    }

    let self = this;
    this._makeClient(function(err, client) {
      if (err) {
        // TODO: Surface this error the user, somehow
        self._log.error("Client not created at Dashboard");
        return;
      }
      self._client = client;
      self._startPoll();
    }, true, win);
  },

  /**
   * User is not on the dashboard, we may stop polling (though PUTs will
   * still continue in AitcClient).
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
    if (this._timer) {
      return;
    }

    // XXX: If pending, process those first.

    // Do one GET check right now.
    this._client.checkServer();

    // And then once every FREQ seconds.
    // TODO: Honor backoff values when we poll.
    this._timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);

    let self = this;
    let event = {
      notify: function notify(timer) {
        self._client.checkServer();
      }
    };

    this._timer.initWithCallback(event, FREQ, Ci.nsITimer.TYPE_REPEATING_SLACK);
  },

  /**
   * Stop polling for changes. Call this as soon as the user
   * isn't looking at the apps dashboard anymore. It is safe to call
   * this function even if runPeriodically() wasn't called before.
   */
  _stopPoll: function _stopPoll() {
    if (!this._timer) {
      return;
    }
    this._timer.cancel();
    this._timer = null;
  },

  /**
   * Perform a remote install or uninstall.
   */
  _doAppEvent: function _doAppEvent(type, app) {
    if (!this._client) {
      throw "_doAppEvent called without client";
    }
    switch (type) {
      case "install":
        this._client.remoteInstall(app); break;
      case "uninstall":
        this._client.remoteUninstall(app); break;
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
        let msg = "Error while fetching token " + err.message;
        self._log.error(msg);
        cb(new Error(msg), null);
        return;
      }
      if (!err.response.success) {
        let msg = "Error while fetching token (non-200) " + err.message;
        self._log.error(msg);
        cb(new Error(msg), null);
        return;
      }

      let msg = "Unknown error while fetching token " + err.message;
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
    function processAssertion(val) {
      self._log.info("Got assertion from BrowserID, creating token");
      self._getToken(val, function(err, token) {
        if (err) {
          self._log.error("Could not obtain token from token server " + err);
          cb(err, null);
          return;
        }
        cb(null, new AitcClient(token));
      });
    }
    function gotSilentAssertion(err, val) {
      self._log.info("gotSilentAssertion called");
      if (err) {
        // If we were asked to let the user login, do the popup method
        if (login) {
          self._log.info("Could not obtain silent assertion, retrying login");
          BrowserID.getAssertion(function gotAssertion(err, val) {
            if (err) {
              self._log.error("Could not obtain assertion even with login");
              cb(err, false);
              return;
            }
            processAssertion(val);
          }, {}, win);
          return;
        }
        self._log.error("Could not obtain assertion in _makeClient");
        cb(err, false);
      } else {
        processAssertion(val);
      }
    }

    // Check if we can get assertion silently first
    BrowserID.getAssertion(gotSilentAssertion, {sameEmailAs: this.MARKETPLACE});
  }
};

XPCOMUtils.defineLazyGetter(this, "Aitc", function() {
  return new AitcSvc();
});
