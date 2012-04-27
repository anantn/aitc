/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["Aitc"];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/Webapps.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

Cu.import("resource://services-aitc/manager.js");
Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-common/preferences.js");

function AitcSvc() {
  this._log = Log4Moz.repository.getLogger("Service.AITC");
  this._log.level = Log4Moz.Level[Preferences.get(
    "services.aitc.log.logger.service"
  )];
  let dapp = new Log4Moz.DumpAppender();
  dapp.level = Log4Moz.Level["Info"];
  this._log.addAppender(dapp);
  this._log.info("Loading AitC");
  this._manager = new AitcManager();
}
AitcSvc.prototype = {
  get DASHBOARD() {
    return Preferences.get("services.aitc.dashboard.url");
  },

  // The goal of the init function is to be ready to activate the AITC
  // client whenever the user is looking at the dashboard.
  init: function init() {
    let self = this;

    // This is called iff the user is currently looking the dashboard.
    function dashboardLoaded(browser) {
      self._log.info("Dashboard was accessed");
      self._manager.userOnDashboard(browser.contentWindow);
    }
    // This is called when the user's attention is elsewhere.
    function dashboardUnloaded() {
      self._log.info("Dashboard closed or in background");
      self._manager.userOffDashboard();
    }

    // Called when a URI is loaded in any tab. We have to listen for this
    // because tabSelected is not called if I open a new tab which loads
    // about:home and then navigate to the dashboard, or navigation via
    // links on the currently open tab.
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
    // Called when the current tab selection changes.
    function tabSelected(event) {
      let browser = event.target.linkedBrowser;
      let uri = browser.currentURI.spec.substring(0, self.DASHBOARD.length);
      if (uri == self.DASHBOARD) {
        dashboardLoaded(browser);
      } else {
        dashboardUnloaded();
      }
    }

    // Add listeners for all windows opened in the future.
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

    // Add listeners for all current open windows.
    let enumerator = Services.wm.getEnumerator("navigator:browser");
    while (enumerator.hasMoreElements()) {
      let browser = enumerator.getNext().gBrowser;
      browser.addTabsProgressListener(listener);
      browser.tabContainer.addEventListener("TabSelect", tabSelected);

      // Also check the currently open URI.
      let uri = browser.contentDocument.location.toString().substring(
        0, self.DASHBOARD.length
      );
      if (uri == self.DASHBOARD) {
        dashboardLoaded(browser);
      }
    }

    // Add listeners for app installs/uninstall.
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

XPCOMUtils.defineLazyGetter(this, "Aitc", function() {
  return new AitcSvc();
});
