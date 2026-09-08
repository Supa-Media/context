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

if (require.main === module) {
  const [field, file] = process.argv.slice(2);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  if (field === "download-path") {
    process.stdout.write(parseDownloadResult(json));
    return;
  }
  const result = parseBuildResult(json);
  if (field !== "id" && field !== "url") throw new Error("field must be id or url");
  process.stdout.write(result[field]);
}

module.exports = { parseBuildResult, parseDownloadResult };
