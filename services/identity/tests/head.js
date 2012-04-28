/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://services-identity/browserid.js");

const google = "http://www.google.com/";
const dashboard = "https://myapps.mozillalabs.com/";
const marketplace = "https://marketplace.mozilla.org";

const testEmail = "moztest@mailinator.com";
const testPassword = "moztestpassword";
const signInPage = "https://browserid.org/signin";

function loadURL(aURL, aCB) {
  gBrowser.selectedBrowser.addEventListener("load", function () {
    gBrowser.selectedBrowser.removeEventListener("load", arguments.callee, true);
    is(gBrowser.currentURI.spec, aURL, "loaded expected URL");
    aCB();
  }, true);
  gBrowser.loadURI(aURL);
}

function parseAssertion(assertion) {
  let chain = assertion.split("~");
  let len = chain.length;
  if (len < 2) {
    return {};
  }

  let cert = JSON.parse(atob(
    chain[0].split(".")[1].replace("-", "+", "g").replace("_", "/", "g")
  ));
  let assert = JSON.parse(atob(
    chain[len-1].split(".")[1].replace("-", "+", "g").replace("_", "/", "g")
  ));

  return {
    issuer: cert.iss,
    email: cert.principal.email,
    audience: assert.aud
  };
}