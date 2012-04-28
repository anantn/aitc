/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/identity/browserid.js");

const testDomain0 = "http://google.com";
const testDomain1 = "http://myapps.mozillalabs.com";
const testDomain2 = "https://marketplace.mozilla.org";

const testEmail = "moztest@mailinator.com";
const testPassword = "moztestpassword";

function loadURL(aURL, aCB) {
  gBrowser.selectedBrowser.addEventListener("load", function () {
    gBrowser.selectedBrowser.removeEventListener("load", arguments.callee, true);
    is(gBrowser.currentURI.spec, aURL, "loaded expected URL");
    aCB();
  }, true);
  gBrowser.loadURI(aURL);
}
