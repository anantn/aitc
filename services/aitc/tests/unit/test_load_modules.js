const modules = [
  "main.js",
  "client.js",
];

function run_test() {
  for each (let m in modules) {
    _("Attempting to load resource://services-aitc/" + m);
    Cu.import("resource://services-aitc/" + m, {});
  }
}
