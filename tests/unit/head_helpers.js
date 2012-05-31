/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */
 
function httpd_setup (handlers, port) {
  let port   = port || 8080;
  let server = new nsHttpServer();
  for (let path in handlers) {
    server.registerPathHandler(path, handlers[path]);
  }
  try {
    server.start(port);
  } catch (ex) {
    do_print("==========================================");
    do_print("Got exception starting HTTP server on port " + port);
    do_print("Error: " + CommonUtils.exceptionStr(ex));
    do_print("Is there a process already listening on port " + port + "?");
    do_print("==========================================");
    do_throw(ex);
  }
}