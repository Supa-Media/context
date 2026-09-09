#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const pathModule = require("node:path");
const plist = require("@expo/plist").default;

const HOST_BUNDLE_ID = "lc.context.mobile";
const EXTENSION_BUNDLE_ID = `${HOST_BUNDLE_ID}.widgets`;
const APP_GROUP = `group.${HOST_BUNDLE_ID}`;

function validateInfoPlistXml(xml) {
  let info;
  try {
    info = plist.parse(xml);
  } catch {
    throw new Error("IPA Info.plist is malformed");
  }
  const version = info.CFBundleShortVersionString;
  const modes = info.UIBackgroundModes;
  const audio = Array.isArray(modes) && modes.includes("audio");
  if (typeof version !== "string" || !audio || info.NSSupportsLiveActivities !== true || info.CFBundleIdentifier !== HOST_BUNDLE_ID) {
    throw new Error(`IPA host is not Live Activity capable: bundle=${info.CFBundleIdentifier ?? "missing"}, audio=${audio}, live=${info.NSSupportsLiveActivities === true}`);
  }
  return { version, audio, info };
}

function validateIpa(path, options = {}) {
  let entries;
  try {
    execFileSync("unzip", ["-t", path], { stdio: "ignore" });
    const listing = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" }).trim();
    entries = listing ? listing.split("\n") : [];
  } catch {
    throw new Error("IPA is not a valid ZIP archive");
  }
  validateZipEntries(entries);
  const plistEntries = entries.filter((entry) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(entry));
  if (plistEntries.length !== 1) throw new Error("IPA must contain exactly one Payload app Info.plist");
  const appRoot = plistEntries[0].slice(0, -"/Info.plist".length);
  const extensionPlists = entries.filter((entry) => entry === `${appRoot}/PlugIns/ContextWidgets.appex/Info.plist`);
  if (extensionPlists.length !== 1) throw new Error("IPA must contain exactly one embedded ContextWidgets.appex");
  const archive = require("node:fs").readFileSync(path);
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("IPA ZIP central directory is missing");
  const count = archive.readUInt16LE(eocd + 10);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  let cursor = centralOffset;
  const records = [];
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("IPA ZIP central directory is malformed");
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const madeBy = archive.readUInt8(cursor + 5);
    const mode = archive.readUInt32LE(cursor + 38) >>> 16;
    records.push({ name, regular: madeBy === 0 ? (archive.readUInt8(cursor + 38) & 0x10) === 0 : (mode & 0xf000) === 0x8000 });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  for (const wanted of [plistEntries[0], extensionPlists[0]]) {
    const record = records.filter((candidate) => candidate.name === wanted);
    if (record.length !== 1 || !record[0].regular) throw new Error("IPA plist must be exactly one regular file");
  }
  const readPlist = (entry) => {
    const binary = execFileSync("unzip", ["-p", path, entry]);
    const xml = execFileSync("plutil", ["-convert", "xml1", "-o", "-", "-"], { input: binary, encoding: "utf8" });
    return plist.parse(xml);
  };
  const host = validateInfoPlistXml(readPlistXml(path, plistEntries[0]));
  const extension = readPlist(extensionPlists[0]);
  if (extension.CFBundleIdentifier !== EXTENSION_BUNDLE_ID || extension.NSExtension?.NSExtensionPointIdentifier !== "com.apple.widgetkit-extension") {
    throw new Error("ContextWidgets extension has the wrong bundle id or extension point");
  }
  if (
    extension.CFBundleVersion !== host.info.CFBundleVersion ||
    extension.CFBundleShortVersionString !== host.info.CFBundleShortVersionString
  ) {
    throw new Error("ContextWidgets extension version must exactly match its host app");
  }
  if (options.verifySignatures !== false) verifySignedPayload(path, appRoot);
  return { version: host.version, audio: host.audio, extension: EXTENSION_BUNDLE_ID };
}

function readPlistXml(archivePath, entry) {
  const binary = execFileSync("unzip", ["-p", archivePath, entry]);
  return execFileSync("plutil", ["-convert", "xml1", "-o", "-", "-"], { input: binary, encoding: "utf8" });
}

function verifySignedPayload(ipaPath, appRoot) {
  const root = fs.mkdtempSync(pathModule.join(os.tmpdir(), "context-ipa-"));
  try {
    execFileSync("unzip", ["-q", ipaPath, "-d", root]);
    const app = pathModule.join(root, appRoot);
    const extension = pathModule.join(app, "PlugIns", "ContextWidgets.appex");
    execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "ignore" });
    const signedGroups = [app, extension].map((target) => {
      const xml = execFileSync("codesign", ["-d", "--entitlements", ":-", target], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const entitlements = plist.parse(xml);
      return entitlements["com.apple.security.application-groups"];
    });
    const provisionedGroups = [app, extension].map((target) => {
      const profile = pathModule.join(target, "embedded.mobileprovision");
      const xml = execFileSync("security", ["cms", "-D", "-i", profile], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return plist.parse(xml).Entitlements?.["com.apple.security.application-groups"];
    });
    if (![...signedGroups, ...provisionedGroups].every(hasExactAppGroup)) {
      throw new Error("host and ContextWidgets signatures must share exactly the Context App Group");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function hasExactAppGroup(value) {
  return Array.isArray(value) && value.length === 1 && value[0] === APP_GROUP;
}

function validateZipEntries(entries) {
  for (const entry of entries) if (entry.includes("\\") || entry.includes("\0") || entry.startsWith("/") || entry.split("/").includes("..") || entry.split("/").includes(".")) throw new Error("IPA contains an unsafe ZIP entry path");
  const appRoots = new Set(entries.map((entry) => entry.match(/^Payload\/([^/]+\.app)(?:\/|$)/)?.[1]).filter(Boolean));
  if (appRoots.size !== 1) throw new Error("IPA must contain exactly one top-level Payload app");
}

if (require.main === module) {
  const result = validateIpa(process.argv[2]);
  console.log(`iOS IPA validated: ${result.version}, background audio, signed ContextWidgets extension`);
}

module.exports = { hasExactAppGroup, validateInfoPlistXml, validateIpa, validateZipEntries };
