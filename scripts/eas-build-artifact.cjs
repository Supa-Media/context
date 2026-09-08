const fs = require("node:fs");

function parseBuildResult(value) {
  const build = Array.isArray(value) ? value[0] : value;
  const id = build?.id;
  const url = build?.artifacts?.applicationArchiveUrl;
  if (typeof id !== "string" || typeof url !== "string") {
    throw new Error("EAS JSON did not contain one build id and artifact URL");
  }
  return { id, url };
}

function parseDownloadResult(value) {
  const result = Array.isArray(value) ? value[0] : value;
  const path = result?.path ?? result?.localPath ?? result?.filePath;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("EAS download JSON did not contain a local IPA path");
  }
  return path;
}

async function downloadArtifact(value, destination) {
  const { id, url } = parseBuildResult(value);
  if (!/^https:\/\//.test(url)) throw new Error("EAS artifact URL must use HTTPS");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`EAS artifact download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("EAS artifact is not an IPA ZIP archive");
  }
  fs.writeFileSync(destination, bytes, { mode: 0o600 });
  return { id, path: destination };
}

if (require.main === module) {
  const [field, file] = process.argv.slice(2);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  if (field === "download-path") {
    process.stdout.write(parseDownloadResult(json));
    return;
  }
  if (field === "download") {
    const destination = process.argv[4];
    if (!destination) throw new Error("download requires an output path");
    downloadArtifact(json, destination).then(({ id }) => process.stdout.write(id));
    return;
  }
  const result = parseBuildResult(json);
  if (field !== "id" && field !== "url") throw new Error("field must be id or url");
  process.stdout.write(result[field]);
}

module.exports = { parseBuildResult, parseDownloadResult, downloadArtifact };
