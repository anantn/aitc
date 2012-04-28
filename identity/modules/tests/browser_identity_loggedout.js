/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * This test is the first in the series of the BrowserID module tests.
 * We begin by verifying that the user is logged out.
 */
function test() {
  ok(BrowserID, "BrowserID exists");
  BrowserID.getAssertion(function(err, val) {
    is(
      err.toString(),
      "Error: User is not logged in, or no emails were found",
      "User is not logged in"
    );
    finish();
  },{audience:testDomain0});
  waitForExplicitFinish();
}
