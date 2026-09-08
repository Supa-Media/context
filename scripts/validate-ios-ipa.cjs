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
  const versionParts = String(version ?? "").split(".");
  const numericVersion = versionParts.length >= 1 && versionParts.length <= 3 && versionParts.every((part) => /^\d+$/.test(part));
  const [major = 0, minor = 0, patch = 0] = numericVersion ? versionParts.map(Number) : [];
  const capable = Number.isSafeInteger(major) &&
    (major > 1 || (major === 1 && (minor > 0 || (minor === 0 && patch >= 1))));
  if (!capable || !audio) {
    throw new Error(`IPA is not the capable iOS release: version=${version ?? "missing"}, audio=${audio}`);
  }
  return { version, audio };
}

function validateIpa(path) {
  const binary = execFileSync("unzip", ["-p", path, "Payload/*.app/Info.plist"]);
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
