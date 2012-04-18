/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["BrowserID"];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-common/preferences.js");

const PREFS = new Preferences("identity.browserid.");

/**
 * This object must be refactored into an XPCOM service at some point.
 * Bug 746398
 */
function BrowserIDSvc() {
  this._frame = null;
  this._container = null;
  this._log = Log4Moz.repository.getLogger("Identity.BrowserID");
  this._log.level = Log4Moz.Level[PREFS.get("log")];
}
BrowserIDSvc.prototype = {
  get ID_URI() {
    return PREFS.get("url");
  },

  /**
   * Attempt to obtain a BrowserID assertion with the specified characteristics
   * without user interaction.
   *
   * @param cb
   *        (function) Callback to be called with (err, assertion)
   *        where "err" can be an Error or NULL, and "assertion" can
   *        be NULL or a valid BrowserID assertion. If no callback
   *        is provided, an exception is thrown.
   *
   * @param audience
   *        (string) The domain for which the assertion is to be issued.
   *        If one is not provided, an exception is thrown.
   *
   * @param options
   *        (Object) An (optional) object that may contain the following
   *        properties:
   *
   *          "requiredEmail" : An email for which the assertion is to be
   *                            issued. If one could not be obtained, the call
   *                            will fail. If this property is not specified,
   *                            and "sameEmailAs" is also absent, the default
   *                            email as set by the user will be chosen. If both
   *                            this property and "sameEmailAs" are set, an
   *                            exception will be thrown.
   *
   *          "sameEmailAs"   : If set, instructs the function to issue an
   *                            assertion for the same email that was provided
   *                            to the domain specified by this value. If this
   *                            information could not be obtained, the call
   *                            will fail. If both this property and
   *                            "requiredEmail" are set, an exception will be
   *                            thrown.
   *
   *        Any properties not listed above will be ignored.
   */
  getAssertion: function getAssertion(cb, audience, options) {
    if (!cb) {
      throw new Error("getAssertion called without a callback");
    }
    if (!audience) {
      throw new Error("getAssertion called without an audience");
    }
    if (options) {
      if (options.requiredEmail && options.sameEmailAs) {
        throw new Error("requiredEmail and sameEmailAs are mutually exclusive");
      }
    }

    let self = this;
    this._getSandbox(function _gotSandbox(sandbox) {
      self._getEmails(sandbox, cb, audience, options);
    });
  },

  /**
   * Attempt to obtain a BrowserID assertion with user interaction. You will
   * almost always want to call getAssertion(...) to see if you can obtain
   * one silently, and only use this method to force the user to login.
   *
   * @param cb
   *        (function) Callback to be called with (err, assertion)
   *        where 'err' can be an Error or NULL, and 'assertion' can
   *        be NULL or a valid BrowserID assertion. If no callback
   *        is provided, an exception is thrown.
   *
   * @param audience
   *        (string) The domain for which this assertion is to be issued.
   *        If one is not provided, an exception is thrown.
   *
   * @param options
   *        (Object) getAssertionWithWindow does not support any options at
   *        the moment, but may accept some at a later point. Pass in {}.
   *
   * @param iframe
   *        (XUL:iframe) A XUL iframe in which the BrowserID login prompt
   *        will be rendered. If you would like to be notified when the prompt
   *        has finished rendering, please create an empty iframe and listen
   *        for the "DOMContentLoaded" event. cb will be called when the user
   *        finishes interacting with the iframe to login. It is the caller's
   *        responsibility to correctly clean up the iframe, but do not do it
   *        before you receive the callback from this function!
   *
   */
  getAssertionWithLogin: function getAssertionWithLogin(
    cb, audience, options, iframe) {

    if (!cb) {
      throw new Error("getAssertionWithLogin called without a callback");
    }
    if (!audience) {
      throw new Error("getAssertionWithLogin called without an audience");
    }
    if (!options) {
      throw new Error("getAssertionWithLogin called without any options");
    }
    if (!iframe) {
      throw new Error("getAssertionWithLogin called without an iframe");
    }

    //TODO: Executing the code directly in win will blocks the BrowserID popup.
    let sandbox = new Cu.Sandbox(win, {
      wantXrays:        false,
      sandboxPrototype: win
    });

    let self = this;
    function callback(val) {
      if (val) {
        self._log.info("getAssertionWithLogin succeeded");
        cb(null, val);
      } else {
        let msg = "Could not obtain assertion in _getAssertionWithLogin";
        self._log.error(msg);
        cb(new Error(msg), null);
      }
    }
    sandbox.importFunction(callback, "callback");

    function doGetAssertion() {
      self._log.info("getAssertionWithLogin Started");
      let scriptText = "window.navigator.id.get(" +
                       "  callback, {allowPersistent: true}" +
                       ");";
      Cu.evalInSandbox(scriptText, sandbox, "1.8", self.ID_URI, 1);
    }

    // Sometimes the provided win hasn't fully loaded yet
    let cWin = win.wrappedJSObject;
    if (!cWin.document || (cWin.document.readyState != "complete")) {
      cWin.addEventListener("DOMContentLoaded", function _contentLoaded() {
        cWin.removeEventListener("DOMContentLoaded", _contentLoaded, false);
        doGetAssertion();
      }, false);
    } else {
      doGetAssertion();
    }
  },

  // Try to get the user's email(s). If user isn't logged in, this will be empty
  _getEmails: function _getEmails(sandbox, cb, audience, options) {
    let self = this;
    function onGetEmails(res) {
      let emails = {};
      try {
        emails = JSON.parse(res);
      } catch (e) {
        self._log.error("Exception in JSON.parse for _getEmails: " + e);
      }
      self._gotEmails(emails, sandbox, cb, audience, options);
    }
    sandbox.importFunction(onGetEmails);
    let scriptText = 
      "var list = window.BrowserID.User.getStoredEmailKeypairs();" + 
      "onGetEmails(JSON.stringify(list));";
    Cu.evalInSandbox(scriptText, sandbox, "1.8", self.ID_URI, 1);
  },
  
  // Received a list of emails from BrowserID for current user
  _gotEmails: function _gotEmails(emails, sandbox, cb, audience, options) {
    let keys = Object.keys(list);

    // If list is empty, user is not logged in, or doesn't have a default email.
    if (!keys.length) {
      let err = "User is not logged in, or no emails were found";
      this._log.error(err);
      cb(new Error(err), null);
      return;
    }

    // User is logged in. For which email shall we get an assertion?

    // Case 1: Explicitly provided
    if (options.requiredEmail) {
      this._getAssertionWithEmail(
        sandbox, cb, options.requiredEmail, audience
      );
      return;
    }

    // Case 2: Derive from a given domain
    if (options.sameEmailAs) {
      this._getAssertionWithDomain(
        sandbox, cb, options.sameEmailAs, audience
      );
      return;
    }

    // Case 3: Default email address
    this._getAssertionWithEmail(
      sandbox, cb, list[0], audience
    );
    return;
  },

  /**
   * Gets an assertion for the specified 'email' and 'audience'
   */
  _getAssertionWithEmail: function _getAssertionWithEmail(
    sandbox, cb, email, audience) {

    let self = this;
    function onSuccess(res) {
      // The internal API sometimes calls onSuccess even though no assertion
      // could be obtained! Double check:
      if (!res) {
        let msg = "BrowserID.User.getAssertion empty assertion";
        self._log.error(msg);
        cb(new Error(msg), null);
        return;
      }
      self._log.info("BrowserID.User.getAssertion succeeded");
      cb(null, res);
    }
    function onError(err) {
      self._log.info("BrowserID.User.getAssertion failed");
      cb(err, null);
    }
    sandbox.importFunction(onSuccess, "onSuccess");
    sandbox.importFunction(onError, "onError");

    self._log.info("getAssertionWithEmail Started");
    let scriptText = 
      "window.BrowserID.User.getAssertion(" +
        "'" + email + "', "     +
        "'" + audience + "', "  +
        "onSuccess, "           +
        "onError"               +
      ");";
    Cu.evalInSandbox(scriptText, sandbox, "1.8", self.ID_URI, 1);
  },

  /**
   * Gets the email which was used to login to 'domain'. If one was found,
   * _getAssertionWithEmail is called to obtain the assertion.
   */
  _getAssertionWithDomain: function _getAssertionWithDomain(
    sandbox, cb, domain) {

    let self = this;
    function onDomainSuccess(email) {
      if (email) {
        self.getAssertionWithEmail(sandbox, cb, email, domain);
      } else {
        cb(new Error("No email found for _getAssertionWithDomain"), null);
      }
    }
    sandbox.importFunction(onDomainSuccess);

    self._log.info("getAssertionWithDomain Started");
    let scriptText = 
      "onDomainSuccess(window.BrowserID.Storage.site.get(" +
        "'" + domain + "', "  +
        "'email'"             +
      "));";
    Cu.evalInSandbox(scriptText, sandbox, "1.8", self.ID_URI, 1);
  },


  /**
   * Creates an empty, hidden iframe and sets it to the _iframe
   * property of this object.
   *
   * @return frame
   *         (iframe) An empty, hidden iframe
   */
  _createFrame: function _createFrame() {
    if (this._frame) {
      // TODO: Figure out how we can reuse the same iframe (bug 745414).
      // Recreate each time, for now.
      this._container.removeChild(this._frame);
      this._frame = null;
    }

    // TODO: What if there is no most recent browser window? (bug 745415).
    let doc = Services.wm.getMostRecentWindow("navigator:browser").document;

    // Insert iframe in to create docshell.
    let frame = doc.createElement("iframe");
    frame.setAttribute("type", "content");
    frame.setAttribute("collapsed", "true");
    doc.documentElement.appendChild(frame);

    // Set instance properties for reuse.
    this._frame = frame;
    this._container = doc.documentElement;

    // Stop about:blank from being loaded.
    let webNav = frame.docShell.QueryInterface(Ci.nsIWebNavigation);
    webNav.stop(Ci.nsIWebNavigation.STOP_NETWORK);

    return this._frame;
  },

  /**
   * Creates a sandbox in an iframe loaded with ID_URI.
   * The callback provided will be invoked when the sandbox is ready
   * to be used, and the only argument to the callback will be a 
   * Sandbox object for the iframe.
   *
   * @param cb
   *        (function) Callback to be invoked with a Sandbox, when ready.
   */
  _getSandbox: function _getSandbox(cb) {
    let frame = this._createFrame();

    let parseHandler = {
      handleEvent: function handleEvent(event) {
        event.target.removeEventListener("DOMContentLoaded", this, false);
        let workerWindow = frame.contentWindow;
        let sandbox = new Cu.Sandbox(workerWindow, {
          wantXrays:        false,
          sandboxPrototype: workerWindow
        });
        cb(sandbox);
      }
    };

    // Load the iframe.
    this._log.info("Creating BrowserID sandbox");
    this._frame.addEventListener("DOMContentLoaded", parseHandler, true);
    this._frame.docShell.loadURI(
      this.ID_URI,
      this._frame.docShell.LOAD_FLAGS_NONE,
      null, // referrer
      null, // postData
      null  // headers
    );
  }
};

XPCOMUtils.defineLazyGetter(this, "BrowserID", function() {
  return new BrowserIDSvc();
});