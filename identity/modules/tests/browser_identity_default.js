/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * This test logs into browser ID as the moztest user and then obtains
 * an assertion for the "default" address, i.e. moztest@mailinator.com
 */
function test() {
  ok(BrowserID, "BrowserID exists");
  loadURL("http://browserid.org/signin", loaded);
  waitForExplicitFinish();
}

function loaded() {
  // Enter email
  let doc = gBrowser.contentDocument;
  doc.getElementById("email").value = testEmail;
  let submit = doc.getElementsByClassName("submit")[0];
  let button = submit.getElementByTagName("button")[0];
  button.click();
  setTimeout(password, 1000);
}

function password() {
  // Enter password and login
  let doc = gBrowser.contentDocument;
  doc.getElementById("password").value = testPassword;
  let submit = doc.getElementsByClassName("submit")[0];
  let button = submit.getElementByTagName("button")[0];
  button.click();
  setTimeout(getassert, 3000);
}

function getassert() {
  // Now that we're logged in, get an assertion
  BrowserID.getAssertion(function(err, val) {
    // Check if we got a valid assertion
    let assert = JSON.parse(atob(val.split(".")[1]));
    is(assert.iss, "browserid.org", "Issuer matches");
    is(asssert.principal.email, testEmail, "Email matches");
    // TODO: Test audience
    finish();
  },{audience:testDomain0});
}