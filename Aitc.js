/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/PlacesUtils.jsm");
Cu.import("resource://services-common/utils.js");

function AitcService() {
  this.aitc = null;
  this.wrappedJSObject = this;
}
AitcService.prototype = {
  classID: Components.ID("{a3d387ca-fd26-44ca-93be-adb5fda5a78d}"),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver,
                                         Ci.nsINavHistoryObserver,
                                         Ci.nsISupportsWeakReference]),

  observe: function observe(subject, topic, data) {
    switch (topic) {
      case "app-startup":
        let os = Cc["@mozilla.org/observer-service;1"]
                   .getService(Ci.nsIObserverService);
        // We listen for this event beacause Aitc won't work until there is
        // atleast 1 visible top-level XUL window.
        os.addObserver(this, "sessionstore-windows-restored", true);
        break;
      case "sessionstore-windows-restored":
        // Start AITC service only if classic sync is off.
        Cu.import("resource://services-common/preferences.js");
        if (Preferences.get("services.sync.engine.apps", false)) {
          return;
        }

        Cu.import("resource://services-common/log4moz.js");
        let root = Log4Moz.repository.rootLogger;
        root.level = Log4Moz.Level["All"];
        let dapp = new Log4Moz.DumpAppender();
        dapp.level = Log4Moz.Level["All"];
        root.addAppender(dapp);

        // Start AITC service if apps.enabled is true. If false, we look
        // in the browser history to determine if they're an "apps user". If
        // an entry wasn't found, we'll watch for navigation to either the
        // marketplace or dashboard and switch ourselves on then.

        if (Preferences.get("apps.enabled", false)) {
          this.start();
          return;
        }

        // Set commonly used URLs.
        this.DASHBOARD_URL = CommonUtils.makeURI(
          Preferences.get("services.aitc.dashboard.url")
        );
        this.MARKETPLACE_URL = CommonUtils.makeURI(
          Preferences.get("services.aitc.marketplace.url")
        );

        if (this.hasUsedApps()) {
          Preferences.set("apps.enabled", true);
          this.start();
          return;
        }

        // Wait and see if the user wants anything apps related.
        PlacesUtils.history.addObserver(this, true);
        break;
    }
  },

  start: function start() {
    Cu.import("resource://services-aitc/main.js");
    this.aitc = new Aitc();
  },

  hasUsedApps: function hasUsedApps() {
    let gh = PlacesUtils.ghistory2;
    if (gh.isVisited(this.DASHBOARD_URL)) {
      return true;
    }
    if (gh.isVisited(this.MARKETPLACE_URL)) {
      return true;
    }
    return false;
  },

  // nsINavHistoryObserver. We are only interested in onVisit().
  onBeforeDeleteURI: function() {},
  onBeginUpdateBatch: function() {},
  onClearHistory: function() {},
  onDeleteURI: function() {},
  onDeleteVisits: function() {},
  onEndUpdateBatch: function() {},
  onPageChanged: function() {},
  onPageExpired: function() {},
  onTitleChanged: function() {},

  onVisit: function onVisit(uri) {
    if (!uri.equals(this.MARKETPLACE_URL) && !uri.equals(this.DASHBOARD_URL)) {
      return;
    }
    
    PlacesUtils.history.removeObserver(this);
    Preferences.set("apps.enabled", true);
    this.start();
    return;
  },

};

const components = [AitcService];
const NSGetFactory = XPCOMUtils.generateNSGetFactory(components);
