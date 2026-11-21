/**
 * Reading a public dataset from the Hugging Face Hub, pinned: the revision the Hub names when it is asked, every file
 * read at that revision, a busy answer tried again. Every public benchmark here is fetched this way at run time into
 * the run's own folder, and never kept in this repository.
 */

export const HF = "https://huggingface.co";
const WAITS_MS = [2_000, 5_000, 15_000, 30_000];
const SHA = /^[0-9a-f]{40}$/;

/** A fetch tried again on a failed answer or a dropped connection: the Hub is a CDN, but a run must not die of one 503. */
export async function fetchOk(url, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let tried = 0; ; tried += 1) {
    const response = await fetchImpl(url).catch((error) => ({ ok: false, status: String(error?.message ?? error) }));
    if (response.ok) return response;
    if (tried >= WAITS_MS.length) throw new Error(`${url}: ${response.status}`);
    await sleep(WAITS_MS[tried]);
  }
}

/** A dataset's revision (its commit, or null when the Hub names none) and every file in it. */
export async function hubDataset(repo, options = {}) {
  const info = await (await fetchOk(`${HF}/api/datasets/${repo}`, options)).json();
  const revision = typeof info?.sha === "string" && SHA.test(info.sha) ? info.sha : null;
  const files = (info?.siblings ?? []).map((f) => f?.rfilename).filter((f) => typeof f === "string");
  return { revision, files };
}

/** The address of one file of a dataset at one revision. */
export const hubFile = (repo, revision, path) => `${HF}/datasets/${repo}/resolve/${revision ?? "main"}/${path}`;

/** One JSON file of a dataset. */
export async function hubJson(repo, revision, path, options = {}) {
  return (await fetchOk(hubFile(repo, revision, path), options)).json();
}

/** Parquet bytes as row objects (hyparquet: pure JavaScript, no native code). */
export async function readParquet(bytes) {
  const { parquetReadObjects } = await import("hyparquet");
  return parquetReadObjects({ file: bytes });
}

/**
 * Every row of one config of a dataset: its parquet files under `<config>/` at one revision, downloaded whole. (The
 * dataset viewer's paged rows API was tried first: on GitHub's runners it slowed to minutes per set and answered 503,
 * 2026-11-21.)
 */
export async function hubParquet(repo, revision, files, config, options = {}) {
  const parts = files.filter((f) => f.startsWith(`${config}/`) && f.endsWith(".parquet")).sort();
  if (parts.length === 0) throw new Error(`${repo} has no ${config}/*.parquet`);
  const rows = [];
  for (const path of parts) {
    const response = await fetchOk(hubFile(repo, revision, path), options);
    rows.push(...(await (options.readParquet ?? readParquet)(await response.arrayBuffer())));
  }
  return rows;
}
