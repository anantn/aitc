/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://gre/modules/Webapps.jsm");
Cu.import("resource://services-aitc/storage.js");

const SERVER = "http://localhost";

var fakeApp1 = {
  origin: SERVER + ":8081",
  receipts: [],
  manifestURL: "/manifest.webapp",
  installOrigin: "http://localhost",
  installedAt: Date.now(),
  modifiedAt: Date.now()
};

// Valid manifest for app1
var manifest1 = {
  name: "Appasaurus",
  description: "Best fake app ever",
  launch_path: "/",
  fullscreen: true,
  required_features: ["webgl"]
};

var fakeApp2 = {
  origin: SERVER + ":8082",
  receipts: ["fake.jwt.token"],
  manifestURL: "/manifest.webapp",
  installOrigin: "http://localhost",
  installedAt: Date.now(),
  modifiedAt: Date.now()
};

// Invalid manifest for app2
var manifest2_bad = {
  not: "a manifest",
  fullscreen: true
};

// Valid manifest for app2
var manifest2_good = {
  name: "Supercalifragilisticexpialidocious",
  description: "Did we blow your mind yet?",
  launch_path: "/"
};

function create_servers() {
  // Serve manifests for test apps
  let app1 = httpd_setup({"/manifest.webapp": function(req, res) {
    let manifest = JSON.stringify(manifest1);
    res.setStatusLine(req.httpVersion, 200, "OK");
    res.setHeader("Content-Type", "application/x-web-app-manifest+json");
    res.bodyOutputStream.write(manifest, manifest.length);
  }}, 8081);

  let app2_bad = httpd_setup({"/manifest.webapp": function(req, res) {
    let manifest = JSON.stringify(manifest2_bad);
    res.setStatusLine(req.httpVersion, 200, "OK");
    res.setHeader("Content-Type", "application/x-web-app-manifest+json");
    res.bodyOutputStream.write(manifest, manifest.length);
  }}, 8082);

  let app2_good = httpd_setup({"/manifest.webapp": function(req, res) {
    let manifest = JSON.stringify(manifest2_good);
    res.setStatusLine(req.httpVersion, 200, "OK");
    res.setHeader("Content-Type", "application/x-web-app-manifest+json");
    res.bodyOutputStream.write(manifest, manifest.length);
  }}, 8083);
}

function run_test() {
  run_next_test();
}

add_test(function test_storage_process() {
  create_servers();

  let apps = [fakeApp1, fakeApp2];
  AitcStorage.processApps(apps, function() {
    // Verify that app1 got added to registry
    let id = DOMApplicationRegistry._appId(fakeApp1.origin);
    do_check_eq(DOMApplicationRegistry.itemExists(id), true);

    // app2 should be missing because of bad manifest
    do_check_eq(DOMApplicationRegistry._appId(fakeApp2.origin), null);

    // Now associate fakeApp2 with a good manifest and process again
    fakeApp2.origin = SERVER + ":8083";
    AitcStorage.processApps([fakeApp1, fakeApp2], function() {
      // Both apps must be installed
      let id1 = DOMApplicationRegistry._appId(fakeApp1.origin);
      let id2 = DOMApplicationRegistry._appId(fakeApp2.origin);
      do_check_eq(DOMApplicationRegistry.itemExists(id1), true);
      do_check_eq(DOMApplicationRegistry.itemExists(id2), true);
      run_next_test();
    });
  });
});

add_test(function test_storage_delete() {
  // Set app1 as deleted
  fakeApp1.deleted = true;
  AitcStorage.processApps([fakeApp1, fakeApp2], function() {
    // It should be missing
    do_check_eq(DOMApplicationRegistry._appId(fakeApp1.origin), null);
    run_next_test();
  });
});