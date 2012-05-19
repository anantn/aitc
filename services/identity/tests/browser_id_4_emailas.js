/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * We're already logged in to the marketplace, so let's see if we can 
 * get an assertion for the dashboard with the same email address without
 * knowing which email was used to sign in earlier. 
 */
function test() {
  loadURL(dashboard, function() {
    BrowserID.getAssertion(
      gotassertion,
      {audience: dashboard, sameEmailAs: marketplace}
    );
  });
  waitForExplicitFinish();
}

function gotassertion(err, val) {
  // Check if we got a valid assertion
  is(err, null, "No error for 4_emailas");
  let assert = parseAssertion(val);
  is(assert.issuer, "browserid.org", "Issuer for 4_emailas matches");
  is(assert.email, testEmail, "Email for 4_emailas matches");
  is(assert.audience, dashboard, "Audience for 4_emailas matches");
  finish();
}