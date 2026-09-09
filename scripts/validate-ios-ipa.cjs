#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const plist = require("@expo/plist").default;

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
  const versionParts = typeof version === "string" ? version.split(".") : [];
  const numericVersion = versionParts.length >= 1 && versionParts.length <= 3 && versionParts.every((part) => /^\d+$/.test(part));
  const [major = 0n, minor = 0n, patch = 0n] = numericVersion ? versionParts.map((part) => BigInt(part)) : [];
  const capable = numericVersion && (major > 1n || (major === 1n && (minor > 0n || (minor === 0n && patch >= 1n))));
  if (!capable || !audio) {
    throw new Error(`IPA is not the capable iOS release: version=${version ?? "missing"}, audio=${audio}`);
  }
  return { version, audio };
}

function validateIpa(path) {
  let entries;
  try {
    execFileSync("unzip", ["-t", path], { stdio: "ignore" });
    entries = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    throw new Error("IPA is not a valid ZIP archive");
  }
  for (const entry of entries) {
    if (entry.includes("\\") || entry.includes("\0") || entry.startsWith("/") || entry.split("/").includes("..") || entry.split("/").includes(".")) {
      throw new Error("IPA contains an unsafe ZIP entry path");
    }
  }
  const appRoots = new Set(entries.map((entry) => entry.match(/^Payload\/([^/]+\.app)(?:\/|$)/)?.[1]).filter(Boolean));
  if (appRoots.size !== 1) throw new Error("IPA must contain exactly one top-level Payload app");
  const plistEntries = entries.filter((entry) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(entry));
  if (plistEntries.length !== 1) throw new Error("IPA must contain exactly one Payload app Info.plist");
  const listing = execFileSync("zipinfo", ["-l", path], { encoding: "utf8" });
  const plistLine = listing.split("\n").find((line) => line.endsWith(` ${plistEntries[0]}`));
  if (plistLine?.startsWith("l")) throw new Error("IPA Info.plist must be a regular file");
  const binary = execFileSync("unzip", ["-p", path, plistEntries[0]]);
  const xml = execFileSync("plutil", ["-convert", "xml1", "-o", "-", "-"], {
    input: binary,
    encoding: "utf8",
  });
  return validateInfoPlistXml(xml);
}

if (require.main === module) {
  const result = validateIpa(process.argv[2]);
  console.log(`iOS IPA validated: CFBundleShortVersionString=${result.version}, UIBackgroundModes includes audio`);
}

module.exports = { validateInfoPlistXml, validateIpa };
