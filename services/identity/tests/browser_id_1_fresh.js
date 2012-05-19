/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * This test is the first in the series of the BrowserID module tests.
 * We being by testing various combinations of invalid arguments, and then
 * proceeding to check that we don't get an assertion even with valid
 * arguments because nobody is signed in to BrowserID.
 */
function test() {
  ok(BrowserID, "BrowserID exists");
 
  try {
    BrowserID.getAssertion();
  } catch (e) {
    is(
      e.message,
      "getAssertion called without a callback",
      "No callback provided, caught correctly"
    );
  }

  try {
    BrowserID.getAssertion(function(){});
  } catch(e) {
    is(
      e.message,
      "getAssertion called without any options",
      "No options provided, caught correctly"
    );
  }

  try {
    BrowserID.getAssertion(function(){}, {foo: "bar"});
  } catch(e) {
    is(
      e.message,
      "getAssertion called without an audience",
      "No audience provided, caught correctly"
    );
  }

  try {
    BrowserID.getAssertion(
      function(){},
      {foo: "bar", audience: "rab", sameEmailAs: "baz", requiredEmail: "oof"}
    );
  } catch (e) {
    is(
      e.message,
      "getAssertion sameEmailAs and requiredEmail are mutually exclusive",
      "Cannot provide both sameEmailAs and requiredEmail, caught correctly"
    );
  }

  // Now, test that we get no assertion because a user isn't logged in.
  BrowserID.getAssertion(gotassertion, {audience: google});
  waitForExplicitFinish();
}

function gotassertion(err, val) {
  is(val, null, "No assertion received");
  is(
    err.toString(),
    "Error: User is not logged in, or no emails were found",
    "User is not logged in, no assertion received"
  );
  finish();
}