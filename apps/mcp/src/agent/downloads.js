/**
 * FILES TEX DOWNLOADED, KEPT FOR A WHILE (the owner, 2026-10-22: "it should be
 * able to download a pdf and email it"). Tex found a Google Voice invoice in
 * the Admin console and told the owner to download it and attach it himself.
 * Now the browser's `download` step (`browse.js`, `infra/site-shots/src/download.ts`)
 * hands the file back, and it is kept here, in the person's own bucket, under
 * an id the model passes on:
 *
 *  - `send_email` / `save_email_draft` `attach: ["download:<id>"]` (`tools/email.js`);
 *  - a browse `upload` step with `file: "download:<id>"` (`uploads.js`).
 *
 * Where: `.context/agent/downloads/<id>.json`, a hidden folder of the
 * workspace's own bucket, so a later text, or a background job, can still
 * use it (the owner, 2026-10-22: "store it in a hidden folder in the bucket
 * just so that it persists across Tex sessions"). How long: a file up to
 * `LONG_KEEP_BYTES` for `LONG_KEEP_MS`, a bigger one (up to the 10 MB a file
 * is read at) for `SHORT_KEEP_MS`, enough for an email waiting on a yes. The
 * id carries when it was kept, so an expired file is refused without reading
 * it and swept on the next download.
 *
 * The id is random: knowing one names nothing outside this bucket, and the
 * bucket is the tenancy boundary, so another person's id finds nothing here.
 */

export const DOWNLOADS_PREFIX = ".context/agent/downloads/";
export const LONG_KEEP_BYTES = 5 * 1024 * 1024;
export const LONG_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export const SHORT_KEEP_MS = 24 * 60 * 60 * 1000;
export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/** `download:<ms>-<s|l>-<hex>`: when it was kept, for how long, and 16 random bytes. */
const ID = /^download:(\d{13})-([sl])-([a-f0-9]{32})$/;

const TYPE = /^[a-z]+\/[a-z0-9.+-]{1,100}$/;

/** A file name a person may be shown: its last part, no control characters or slashes. */
export function downloadName(raw, fallback = "download") {
  const leaf = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = leaf.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 200);
  return clean || fallback;
}

/** Whether a string is a download id at all. */
export const isDownloadId = (value) => typeof value === "string" && ID.test(value.trim());

function keyOf(id) {
  const m = ID.exec(id);
  return m ? `${DOWNLOADS_PREFIX}${m[1]}-${m[2]}-${m[3]}.json` : null;
}

function expired(id, now) {
  const m = ID.exec(id);
  if (!m) return true;
  return now - Number(m[1]) > (m[2] === "l" ? LONG_KEEP_MS : SHORT_KEEP_MS);
}

function sizeOf(data) {
  return Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

/**
 * Keep a file the browser handed back, `{ name, type, data }` with `data` as
 * base64, and answer `{ id, name, type, size, keptFor }` or `{ error }`.
 */
export async function keepDownload(store, file, { now = Date.now() } = {}) {
  if (typeof store?.put !== "function") return { error: "files can't be kept here" };
  const data = typeof file?.data === "string" ? file.data : "";
  if (!data || !/^[A-Za-z0-9+/]+=*$/.test(data)) return { error: "the browser gave back no file" };
  const size = sizeOf(data);
  if (size > MAX_DOWNLOAD_BYTES) return { error: "that file is over the 10 MB a file can be" };
  const name = downloadName(file.name);
  const type = typeof file.type === "string" && TYPE.test(file.type) ? file.type : "application/octet-stream";
  const long = size <= LONG_KEEP_BYTES;
  const random = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const id = `download:${now}-${long ? "l" : "s"}-${random}`;
  await sweepDownloads(store, now).catch(() => undefined);
  await store.put(keyOf(id), JSON.stringify({ version: 1, name, type, size, keptAt: new Date(now).toISOString(), data }));
  return { id, name, type, size, keptFor: long ? "30 days" : "24 hours" };
}

/**
 * A kept file by its id: `{ file: { name, type, size, data } }`, or `{ error }`
 * in words the model is shown.
 */
export async function readDownload(store, rawId, { now = Date.now() } = {}) {
  const id = String(rawId ?? "").trim();
  if (!ID.test(id)) return { error: "a downloaded file is named by the download:… id the download step gave" };
  if (expired(id, now)) return { error: `${id} is no longer kept; download it again` };
  let parsed = null;
  try {
    const object = await store.get(keyOf(id));
    parsed = object ? JSON.parse(await object.text()) : null;
  } catch {
    parsed = null;
  }
  if (typeof parsed?.data !== "string") return { error: `${id} is not kept here; download it again` };
  return {
    file: {
      name: downloadName(parsed.name),
      type: typeof parsed.type === "string" && TYPE.test(parsed.type) ? parsed.type : "application/octet-stream",
      size: sizeOf(parsed.data),
      data: parsed.data,
    },
  };
}

/** Delete every kept file past its time. Best-effort: a missed sweep only leaves a file a little longer. */
export async function sweepDownloads(store, now = Date.now()) {
  if (typeof store?.list !== "function" || typeof store?.delete !== "function") return 0;
  let swept = 0;
  let cursor;
  for (let page = 0; page < 5; page += 1) {
    const listed = await store.list({ prefix: DOWNLOADS_PREFIX, ...(cursor ? { cursor } : {}) });
    for (const object of listed?.objects ?? []) {
      const leaf = String(object.key ?? "").slice(DOWNLOADS_PREFIX.length).replace(/\.json$/, "");
      if (!expired(`download:${leaf}`, now)) continue;
      await store.delete(object.key).catch(() => undefined);
      swept += 1;
    }
    if (!listed?.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return swept;
}

/** One line for the model about a kept file. */
export function keptLine(kept) {
  const kb = kept.size < 1024 * 1024 ? `${Math.max(1, Math.round(kept.size / 1024))} KB` : `${(kept.size / 1024 / 1024).toFixed(1)} MB`;
  return (
    `Downloaded "${kept.name}" (${kb}), kept for ${kept.keptFor} as ${kept.id}. ` +
    `To email it, pass attach: ["${kept.id}"] to send_email or save_email_draft (it goes in as a real attachment); ` +
    `to put it into another page, an upload step with file: "${kept.id}". Never ask the person to download or attach it.`
  );
}
