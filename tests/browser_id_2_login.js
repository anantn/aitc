/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Ok, in test 1 the user was logged out. Now we'll use getAssertionWithLogin
 * to force a popup to appear that we will then use to login to marketplace,
 * as the test user. We also check if the assertion obtained as a result is
 * valid.
 */
function test() {
  loadURL(marketplace + "/en-US/login", function() {
    BrowserID.getAssertionWithLogin(gotassertion, gBrowser.contentWindow);
    // Wait a couple of seconds for the BrowserID popup to appear.
    setTimeout(signin, 2000);
  });
  waitForExplicitFinish();
}

function signin() {
  // BrowserID popup will be the front-most window, proceed to sign in as
  // the test user.

  // Enter email.
  let browser = Services.wm.getMostRecentWindow("navigator:browser").gBrowser;
  let doc = browser.contentDocument;
  doc.getElementById("email").value = testEmail;
  let submit = doc.getElementsByClassName("submit")[0];
  let button = submit.getElementsByTagName("button")[0];
  button.click();

  // Wait a second for password field to appear.
  setTimeout(function() {
    // Enter password and login.
    doc.getElementById("password").value = testPassword;
    let submit = doc.getElementsByClassName("submit")[0];
    let button = submit.getElementsByTagName("button")[0];
    button.click();
    // Now, gotassertion should be called.
  }, 1000);
}

function gotassertion(err, val) {
  // Check if we got a valid assertion
  is(err, null, "No error for 2_login");

  let assert = parseAssertion(val);
  is(assert.issuer, "browserid.org", "Issuer for 2_login matches");
  is(assert.email, testEmail, "Email for 2_login matches");
  is(assert.audience, marketplace, "Audience for 2_login matches")

  finish();
}