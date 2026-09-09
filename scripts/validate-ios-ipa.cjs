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
    const listing = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" }).trim();
    entries = listing ? listing.split("\n") : [];
  } catch {
    throw new Error("IPA is not a valid ZIP archive");
  }
  validateZipEntries(entries);
  const plistEntries = entries.filter((entry) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(entry));
  if (plistEntries.length !== 1) throw new Error("IPA must contain exactly one Payload app Info.plist");
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
  const plistRecord = records.filter((record) => record.name === plistEntries[0]);
  if (plistRecord.length !== 1 || !plistRecord[0].regular) throw new Error("IPA Info.plist must be exactly one regular file");
  const binary = execFileSync("unzip", ["-p", path, plistEntries[0]]);
  const xml = execFileSync("plutil", ["-convert", "xml1", "-o", "-", "-"], {
    input: binary,
    encoding: "utf8",
  });
  return validateInfoPlistXml(xml);
}

function validateZipEntries(entries) {
  for (const entry of entries) if (entry.includes("\\") || entry.includes("\0") || entry.startsWith("/") || entry.split("/").includes("..") || entry.split("/").includes(".")) throw new Error("IPA contains an unsafe ZIP entry path");
  const appRoots = new Set(entries.map((entry) => entry.match(/^Payload\/([^/]+\.app)(?:\/|$)/)?.[1]).filter(Boolean));
  if (appRoots.size !== 1) throw new Error("IPA must contain exactly one top-level Payload app");
}

if (require.main === module) {
  const result = validateIpa(process.argv[2]);
  console.log(`iOS IPA validated: CFBundleShortVersionString=${result.version}, UIBackgroundModes includes audio`);
}

module.exports = { validateInfoPlistXml, validateIpa, validateZipEntries };
