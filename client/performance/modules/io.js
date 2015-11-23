/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const { Cc, Ci, Cu, Cr } = require("chrome");

const { Services } = require("devtools/sham/services");
const { promise } = require("devtools/sham/promise");
const RecordingUtils = require("devtools/shared/performance/recording-utils");

const { FileUtils } = require("devtools/sham/fileutils");
const { NetUtil } = require("devtools/sham/netutil");

// This identifier string is used to tentatively ascertain whether or not
// a JSON loaded from disk is actually something generated by this tool.
// It isn't, of course, a definitive verification, but a Good Enough™
// approximation before continuing the import. Don't localize this.
const PERF_TOOL_SERIALIZER_IDENTIFIER = "Recorded Performance Data";
const PERF_TOOL_SERIALIZER_LEGACY_VERSION = 1;
const PERF_TOOL_SERIALIZER_CURRENT_VERSION = 2;

/**
 * Helpers for importing/exporting JSON.
 */

/**
 * Gets a nsIScriptableUnicodeConverter instance with a default UTF-8 charset.
 * @return object
 */
function getUnicodeConverter () {
  let className = "@mozilla.org/intl/scriptableunicodeconverter";
  let converter = Cc[className].createInstance(Ci.nsIScriptableUnicodeConverter);
  converter.charset = "UTF-8";
  return converter;
}

/**
 * Saves a recording as JSON to a file. The provided data is assumed to be
 * acyclical, so that it can be properly serialized.
 *
 * @param object recordingData
 *        The recording data to stream as JSON.
 * @param nsILocalFile file
 *        The file to stream the data into.
 * @return object
 *         A promise that is resolved once streaming finishes, or rejected
 *         if there was an error.
 */
function saveRecordingToFile (recordingData, file) {
  let deferred = promise.defer();

  recordingData.fileType = PERF_TOOL_SERIALIZER_IDENTIFIER;
  recordingData.version = PERF_TOOL_SERIALIZER_CURRENT_VERSION;

  let string = JSON.stringify(recordingData);
  let inputStream = this.getUnicodeConverter().convertToInputStream(string);
  let outputStream = FileUtils.openSafeFileOutputStream(file);

  NetUtil.asyncCopy(inputStream, outputStream, deferred.resolve);
  return deferred.promise;
}

/**
 * Loads a recording stored as JSON from a file.
 *
 * @param nsILocalFile file
 *        The file to import the data from.
 * @return object
 *         A promise that is resolved once importing finishes, or rejected
 *         if there was an error.
 */
function loadRecordingFromFile (file) {
  let deferred = promise.defer();

  let channel = NetUtil.newChannel({
    uri: NetUtil.newURI(file),
    loadUsingSystemPrincipal: true});

  channel.contentType = "text/plain";

  NetUtil.asyncFetch(channel, (inputStream, status) => {
    try {
      let string = NetUtil.readInputStreamToString(inputStream, inputStream.available());
      var recordingData = JSON.parse(string);
    } catch (e) {
      deferred.reject(new Error("Could not read recording data file."));
      return;
    }
    if (recordingData.fileType != PERF_TOOL_SERIALIZER_IDENTIFIER) {
      deferred.reject(new Error("Unrecognized recording data file."));
      return;
    }
    if (!isValidSerializerVersion(recordingData.version)) {
      deferred.reject(new Error("Unsupported recording data file version."));
      return;
    }
    if (recordingData.version === PERF_TOOL_SERIALIZER_LEGACY_VERSION) {
      recordingData = convertLegacyData(recordingData);
    }
    if (recordingData.profile.meta.version === 2) {
      RecordingUtils.deflateProfile(recordingData.profile);
    }
    if (!recordingData.label) {
      // set the label to the filename without its extension
      recordingData.label = file.leafName.replace(/\..+$/, "");
    }
    deferred.resolve(recordingData);
  });

  return deferred.promise;
}

/**
 * Returns a boolean indicating whether or not the passed in `version`
 * is supported by this serializer.
 *
 * @param number version
 * @return boolean
 */
function isValidSerializerVersion (version) {
  return !!~[
    PERF_TOOL_SERIALIZER_LEGACY_VERSION,
    PERF_TOOL_SERIALIZER_CURRENT_VERSION
  ].indexOf(version);
}

/**
 * Takes recording data (with version `1`, from the original profiler tool), and
 * massages the data to be line with the current performance tool's property names
 * and values.
 *
 * @param object legacyData
 * @return object
 */
function convertLegacyData (legacyData) {
  let { profilerData, ticksData, recordingDuration } = legacyData;

  // The `profilerData` and `ticksData` stay, but the previously unrecorded
  // fields just are empty arrays or objects.
  let data = {
    label: profilerData.profilerLabel,
    duration: recordingDuration,
    markers: [],
    frames: [],
    memory: [],
    ticks: ticksData,
    allocations: { sites: [], timestamps: [], frames: [], sizes: [] },
    profile: profilerData.profile,
    // Fake a configuration object here if there's tick data,
    // so that it can be rendered
    configuration: {
      withTicks: !!ticksData.length,
      withMarkers: false,
      withMemory: false,
      withAllocations: false
    },
    systemHost: {},
    systemClient: {},
  };

  return data;
}

exports.getUnicodeConverter = getUnicodeConverter;
exports.saveRecordingToFile = saveRecordingToFile;
exports.loadRecordingFromFile = loadRecordingFromFile;
