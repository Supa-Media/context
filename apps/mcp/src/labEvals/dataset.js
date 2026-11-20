/**
 * LongMemEval's files on Hugging Face, read from the gateway (`longMemEval.js` for the format; decision
 * `docs/decisions/texting-assistant/lab-evals.md`).
 *
 *  - `discover`: the dataset's current commit and the file a variant reads, so every offset kept is that commit's;
 *  - `buildIndex`: streams the whole file once and keeps where each question's bytes are (the S file is about 280 MB:
 *    never held whole, only scanned as it passes);
 *  - `fetchItem`: one question's bytes with a range request, parsed; a server that ignores the range is read as a
 *    stream up to the question's end.
 *
 * Public data, read without a token; nothing here sends anything of anyone's.
 */

import { benchOf, createScanner, indexEntry } from "./longMemEval.js";

const HF = "https://huggingface.co";
/** Past this, a file is not the dataset this adapter knows. */
const MAX_FILE_BYTES = 1_200_000_000;
const SHA = /^[0-9a-f]{40}$/;

export class DatasetError extends Error {}

/** The variant's file at the dataset's current commit: `{ url, sha, file }`. */
export async function discover(benchId, fetchImpl = fetch) {
  const bench = benchOf(benchId);
  if (bench === null) throw new DatasetError(`There is no benchmark ${benchId}.`);
  const response = await fetchImpl(`${HF}/api/datasets/${bench.repo}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new DatasetError(`Hugging Face answered ${response.status} for ${bench.repo}.`);
  const info = await response.json().catch(() => null);
  const sha = typeof info?.sha === "string" && SHA.test(info.sha) ? info.sha : null;
  const files = (Array.isArray(info?.siblings) ? info.siblings : []).map((s) => s?.rfilename).filter((name) => typeof name === "string");
  const matching = files.filter((name) => bench.file.test(name) && !/\.(md|py|txt|parquet)$/i.test(name));
  const file = matching.find((name) => /cleaned/i.test(name)) ?? matching.find((name) => /\.json$/i.test(name)) ?? matching[0] ?? null;
  if (sha === null || file === null) throw new DatasetError(`${bench.repo} has no ${bench.variant} file.`);
  return { url: `${HF}/datasets/${bench.repo}/resolve/${sha}/${file.split("/").map(encodeURIComponent).join("/")}`, sha, file };
}

/** Every question's place in the file, read once as a stream: `[{ i, id, type, ability, start, end, question, answer, date }]`. */
export async function buildIndex(url, fetchImpl = fetch) {
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) throw new DatasetError(`The dataset file answered ${response.status}.`);
  const scanner = createScanner();
  const reader = response.body.getReader();
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    if (read > MAX_FILE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new DatasetError("The dataset file is larger than LongMemEval's.");
    }
    scanner.push(value);
  }
  const entries = scanner.found.map((found, i) => indexEntry(found, i)).filter((entry) => entry !== null);
  if (entries.length === 0) throw new DatasetError("The dataset file held no questions.");
  return entries;
}

/** One question, whole: its range of the file, parsed, checked to be the question asked for. */
export async function fetchItem(url, entry, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { range: `bytes=${entry.start}-${entry.end}` } });
  let text;
  if (response.status === 206) {
    text = await response.text();
  } else if (response.ok && response.body) {
    // The whole file came back: keep only this question's bytes as they pass.
    const reader = response.body.getReader();
    const parts = [];
    let at = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const from = Math.max(entry.start - at, 0);
      const to = Math.min(entry.end + 1 - at, value.byteLength);
      if (to > from) parts.push(value.subarray(from, to));
      at += value.byteLength;
      if (at > entry.end) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    const bytes = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    text = new TextDecoder().decode(bytes);
  } else {
    throw new DatasetError(`The dataset file answered ${response.status}.`);
  }
  let item;
  try {
    item = JSON.parse(text);
  } catch {
    throw new DatasetError(`Question ${entry.id} could not be read from the file.`);
  }
  if (item?.question_id !== entry.id) throw new DatasetError(`The file changed: ${entry.id} is not where it was.`);
  return item;
}
