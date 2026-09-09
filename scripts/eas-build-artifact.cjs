const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const EAS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseBuildResult(value) {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("EAS JSON must contain exactly one build");
  const build = value[0];
  const id = build?.id;
  const url = build?.artifacts?.applicationArchiveUrl;
  if (typeof id !== "string" || !EAS_ID.test(id) || typeof url !== "string") {
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
  const destinationDir = path.dirname(destination);
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  try { if (fs.lstatSync(destination)) throw new Error("IPA destination already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  let current = url;
  let response;
  const seen = new Set();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed;
    try { parsed = new URL(current); } catch { throw new Error("EAS artifact URL is invalid"); }
    if (parsed.protocol !== "https:") throw new Error("EAS artifact URL must use HTTPS");
    if (seen.has(current)) throw new Error("EAS artifact redirect loop");
    seen.add(current);
    response = await fetch(current, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || hop === MAX_REDIRECTS) throw new Error("EAS artifact redirect limit exceeded");
    try { current = new URL(location, current).toString(); } catch { throw new Error("EAS artifact redirect is invalid"); }
  }
  if (!response?.ok) throw new Error(`EAS artifact download failed: HTTP ${response?.status ?? "unknown"}`);
  const declared = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(declared) || declared <= 0 || declared > MAX_ARTIFACT_BYTES) throw new Error("EAS artifact has unacceptable Content-Length");
  const temp = path.join(destinationDir, `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temp, "wx", 0o600);
    let total = 0;
    let magic = Buffer.alloc(0);
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_ARTIFACT_BYTES || total > declared) throw new Error("EAS artifact exceeds declared size");
      if (magic.length < 4) magic = Buffer.concat([magic, bytes]).subarray(0, 4);
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written);
        if (!result || result.bytesWritten <= 0) throw new Error("EAS artifact write made no progress");
        written += result.bytesWritten;
      }
    }
    if (total !== declared || magic.length < 4 || magic.readUInt32LE(0) !== 0x04034b50) throw new Error("EAS artifact is not a complete IPA ZIP archive");
    await handle.sync();
    await handle.close(); handle = undefined;
    await fs.promises.link(temp, destination);
    await fs.promises.unlink(temp);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temp).catch(() => {});
    throw error;
  }
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
