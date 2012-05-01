/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["AitcStorage", "AitcQueue"];

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/Webapps.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

Cu.import("resource://services-common/rest.js");
Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-common/preferences.js");

/**
 * Provides a file-backed queue. Currently used by manager.js as persistent
 * storage to manage pending installs and uninstalls.
 *
 * @param filename     
 *        (String)    The file backing this queue will be named as this string.
 *
 * @param cb          
 *        (Function)  This function will be called when the queue is ready to
 *                    use. *DO NOT* call any methods on this object until the
 *                    callback is invoked, if you do so, none of your operations
 *                    will be persisted on disk.
 *
 */
function AitcQueue(filename, cb) {
  this._log = Log4Moz.repository.getLogger("Service.AITC.Storage.Queue");
  this._log.level = Log4Moz.Level[Preferences.get(
    "services.aitc.storage.log.level"
  )];

  this._queue = [];
  this._writeLock = false;
  this._file = FileUtils.getFile("ProfD", ["webapps", filename], true);

  this._log.info("AitcQueue instance loading");

  let self = this;
  if (this._file.exists()) {
    this._getFile(function _gotFile(data) {
      if (data) {
        self._queue = data;
      }
      self._log.info("AitcQueue instance created");
      cb(true);
    });
  } else {
    self._log.info("AitcQueue instance created");
    cb(true);
  }
}
AitcQueue.prototype = {
  /**
   * Add an object to the queue.
   */
  enqueue: function enqueue(obj, cb) {
    this._log.info("Adding to queue " + obj);

    if (!cb) {
      throw new Error("enqueue called without callback");
    }

    let self = this;
    this._queue.push(obj);
    this._putFile(this._queue, function _enqueuePutFile(err) {
      if (!err) {
        // Successful write.
        cb(null, true);
        return;
      }
      // Write unsuccessful, don't add to queue.
      self._queue.pop();
      cb(new Error(err), false);
    });
  },

  /**
   * Remove the object at the head of the queue.
   */
  dequeue: function dequeue(cb) {
    this._log.info("Removing head of queue");

    if (!cb) {
      throw new Error("dequeue called without callback");
    }
    if (!this._queue.length) {
      throw new Error("Queue is empty");
    }

    let self = this;
    let obj = this._queue.shift();
    this._putFile(this._queue, function _dequeuePutFile(err) {
      if (!err) {
        // Successful write.
        cb(null, true);
        return;
      }
      // Unsuccessful write, put back in queue.
      self._queue.unshift(obj);
      cb(err, false);
    });
  },

  /**
   * Return the object at the front of the queue without removing it.
   */
  peek: function peek(cb) {
    if (!this._queue.length) {
      throw new Error("Queue is empty");
    }
    this._log.info("Peek returning head of queue");
    return this._queue[0];
  },

  /**
   * Find out the length of the queue.
   */
  length: function length(cb) {
    return this._queue.length;
  },

  /**
   * Get contents of cache file and parse it into an array. Will throw an
   * exception if there is an error while reading the file.
   */
  _getFile: function _getFile(cb) {
    let channel = NetUtil.newChannel(this._file);
    channel.contentType = "application/json";

    let self = this;
    NetUtil.asyncFetch(channel, function _asyncFetched(stream, res) {
      if (!Components.isSuccessCode(res)) {
        self._log.error("Could not read from json file " + this._file.path);
        cb(null);
        return;
      }

      let data = [];
      try {
        data = JSON.parse(
          NetUtil.readInputStreamToString(stream, stream.available())
        );
        stream.close();
        cb(data);
      } catch (e) {
        self._log.error("Could not parse JSON " + e);
        cb(null);
      }
    });
  },

  /**
   * Put an array into the cache file. Will throw an exception if there is
   * an error while trying to write to the file.
   */
  _putFile: function _putFile(value, cb) {
    if (this._writeLock) {
      throw new Error("_putFile already in progress");
    }

    this._writeLock = true;
    try {
      let ostream = FileUtils.openSafeFileOutputStream(this._file);

      let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"].
                      createInstance(Ci.nsIScriptableUnicodeConverter);
      converter.charset = "UTF-8";
      let istream = converter.convertToInputStream(JSON.stringify(value));

      // Asynchronously copy the data to the file.
      let self = this;
      this._log.info("Writing queue to disk");
      NetUtil.asyncCopy(istream, ostream, function _asyncCopied(result) {
        self._writeLock = false;
        if (Components.isSuccessCode(result)) {
          self._log.info("asyncCopy succeeded");
          cb(null);
        } else {
          let msg = "asyncCopy failed with " + result;
          self._log.info(msg);
          cb(msg);
        }
      });
    } catch (e) {
      this._writeLock = false;
      cb(msg);
    }
  },
};

/**
 * An interface to DOMApplicationRegistry, used by manager.js to process
 * remote changes received and apply them to the local registry.
 */
function AitcStorageImpl() {
  this._log = Log4Moz.repository.getLogger("Service.AITC.Storage");
  /*this._log.level = Log4Moz.Level[Preferences.get(
    "services.aitc.storage.log.level"
  )];*/
  this._log.info("Loading AitC storage module");

  this._file = FileUtils.getFile(
    "ProfD", ["webapps", "webapps-pending.json"], true
  );
}
AitcStorageImpl.prototype = {
  /**
   * Determines what changes are to be made locally, given a list of
   * remote apps.
   *
   * @param remoteApps
   *        (Array)     An array of app records fetched from the AITC server.
   *
   * @param callback
   *        (function)  A callback to be invoked when processing is finished.
   */
  processApps: function processApps(remoteApps, callback) {
    let self = this;
    this._log.info("Server check got " + remoteApps.length + " apps");

    // Get the set of local apps, and then pass to _processApps.
    // _processApps will check for the validity of remoteApps.
    DOMApplicationRegistry.getAllWithoutManifests(
      function _processAppsGotLocalApps(localApps) {
        self._processApps(remoteApps, localApps, callback);
      }
    );
  },

  /**
   * Take a list of remote and local apps and figured out what changes (if any)
   * are to be made to the local DOMApplicationRegistry.
   */
  _processApps: function _processApps(remoteApps, lApps, callback) {
    let toDelete = {};
    let localApps = {};
    
    // Convert lApps to a dictionary of origin -> app (instead of id -> app).
    for (let [id, app] in Iterator(localApps)) {
      app.id = id;
      toDelete[app.origin] = app;
      localApps[app.origin] = app;
    }

    // Iterate over remote apps, and find out what changes we must apply.
    let toInstall = [];
    for each (let app in remoteApps) {
      // Don't delete apps that are both local & remote.
      let origin = app.origin;
      delete toDelete[origin];

      // If there is a remote app that isn't local or 
      // if the remote app was installed later.
      let id = null;
      if (!localApps[origin]) {
        id = DOMApplicationRegistry.makeAppId();
      }
      if (localApps[origin] &&
          (localApps[origin].installTime < app.installTime)) {
        id = localApps[origin].id;
      }
      
      // We should (re)install this app locally
      if (id) {
        try {          
          let record = {id: id, value: app};
          toInstall.push(record);
        } catch (e) {
          // App was an invalid record
          this._log.error("A remote app was found to be invalid " + e);
        }
      }
    }

    // Uninstalls only need the ID & deleted flag.
    let toUninstall = [];
    for (let origin in toDelete) {
      toUninstall.push({id: toDelete[origin].id, deleted: true});
    }

    // Apply installs & uninstalls.
    this._applyUpdates(toInstall, toUninstall, callback);
    return;
  },

  /**
   * Applies a list of commands as determined by processApps locally.
   */
  _applyUpdates: function _applyUpdates(toInstall, toUninstall, callback) {
    let finalCommands = [];
    let toUpdate = toInstall.length;

    let self = this;
    function onManifestsUpdated() {
      if (toUninstall.length) {
        finalCommands.push(toUninstall);
      }
      if (finalCommands.length) {
        self._log.info(
          "processUpdates finished fetching manifests, calling updateApps"
        );
        DOMApplicationRegistry.updateApps(finalCommands, callback);
      } else {
        self._log.info(
          "processUpdates finished fetching, no finalCommands were found"
        );
        callback();
      }
    }

    // Update manifests for all the new remote apps we have.
    let done = 0;
    for (let j = 0; j < toUpdate; j++) {
      let app = toInstall[j];
      let url = app.value.manifestURL;
      if (url[0] == "/") {
        url = app.value.origin + app.value.manifestURL;
      }

      this._log.info("Updating manifest " + url + "\n");
      this._getManifest(url, function(err, manifest) {
        if (!err) {
          app.value.manifest = manifest;
          finalCommands.push(app);
          self._log.info(app.id + " was added to finalCommands");
        } else {
          self._log.debug("Couldn't fetch manifest at " + url + ": " + err);
        }

        // Not a big deal if we couldn't get a manifest, we will try to fetch
        // it again in the next cycle. Carry on.
        done += 1;
        if (done == toUpdate) {
          onManifestsUpdated();
        }
      });
    }
  },

  /**
   * Fetch a manifest from given URL. No retries are made on failure.
   */
  _getManifest: function _getManifest(url, callback)  {
    let req = new RESTRequest(url);
    req.get(function(error) {
      if (error) {
        callback(error, null);
        return;
      }
      if (!req.response.success) {
        callback(new Error("Non-200 while fetching manifest"), null);
        return;
      }

      let err = null;
      let manifest = null;
      try {
        manifest = JSON.parse(req.response.body);
        if (!manifest.name) {
          self._log.warn(
            "_getManifest got invalid manifest: " + req.response.body
          );
          err = new Error("Invalid manifest fetched");
          manifest = null;
        }
      } catch (e) {
        self._log.warn(
          "_getManifest got invalid JSON response: " + req.response.body
        );
        err = new Error("Invalid manifest fetched");
        manifest = null;
      }

      callback(err, manifest);
    });
  },

};

XPCOMUtils.defineLazyGetter(this, "AitcStorage", function() {
  return new AitcStorageImpl();
});