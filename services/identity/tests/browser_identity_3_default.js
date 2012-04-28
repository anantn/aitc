/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Now, we obtain an assertion for the test user silently, which should succeed
 * since test 2_login signed us in already.
 */
function test() {
  loadURL(google, function() {
    BrowserID.getAssertion(
      gotassertion,
      {audience: google, requiredEmail: testEmail}
    );
  });
  waitForExplicitFinish();
}

function gotassertion(err, val) {
  // Check if assertion is valid.
  is(err, null, "No error for 3_default");
  let assert = parseAssertion(val);
  is(assert.issuer, "browserid.org", "Issuer for 3_default matches");
  is(assert.email, testEmail, "Email for 3_default matches");
  is(assert.audience, google, "Audience for 3_default matches");
  finish();
}