/**
 * A store as a gateway session sees it: the same store, with the Convex tree
 * attached the way `attachLinkCalls` attaches it per request (`treeManifest`,
 * `treeFacts`). A store with no tree answers every listing `TreeUnavailable`,
 * so a suite that exercises listing, name checks or front matter must hand the
 * code under test one of these, not the bare bucket.
 *
 * The tree here is the control plane's copy of the store, built live from the
 * store's own `list` and `get` on every call: a write made by the test is in
 * the next answer, as it is in the real tree a second later. It answers what
 * the control plane answers for names, the manifest and props. Links, chaos and
 * forwarding are `{ served: false }`, the same as a tree that is not serving,
 * so a caller degrades exactly as it does there.
 *
 * Plumbing (`.context/`, any dot segment) is never in the tree, as in the real
 * one, so the code under test reads it from the store directly.
 */

import { R2Store as BareR2Store } from "../src/store/r2.js";
import { listAllKeys } from "../src/notes/storage.js";
import { propsOf } from "../src/tree/props.js";
import { compareKeys } from "../src/tree/served.js";

const isPlumbing = (key) => key.startsWith(".") || key.includes("/.");

/** Every non-plumbing key of `store`, sorted the way the tree sorts them. */
async function treeKeys(store) {
  const objects = (await listAllKeys(store, "")).filter(({ key }) => !isPlumbing(key));
  return objects.sort((a, b) => compareKeys(a.key, b.key));
}

/**
 * `store` with the tree attached. `pageSize` pages the manifest, so a suite can
 * exercise a manifest that runs over several pages.
 *
 * @param {object} store any store with `list` and `get`
 * @param {{ pageSize?: number }} [options]
 */
export function treeBacked(store, { pageSize = 1000, source = store } = {}) {
  const bound = Object.create(store);
  const manifest = async ({ folder, cursor } = {}) => {
    const prefix = folder ? `${folder}/` : "";
    const keys = (await treeKeys(source))
      .filter(({ key }) => key.startsWith(prefix))
      .filter(({ key }) => cursor === undefined || compareKeys(key, cursor) > 0);
    const page = keys.slice(0, pageSize);
    const more = keys.length > page.length;
    return {
      served: true,
      entries: page.map(({ key, etag, size, uploaded }) => ({
        path: key,
        etag,
        size,
        updatedAt: uploaded instanceof Date ? uploaded.getTime() : uploaded,
      })),
      cursor: more ? page[page.length - 1].key : null,
    };
  };
  const facts = async (request = {}) => {
    if (request.ask === "names") {
      const files = (await treeKeys(source)).map(({ key }) => key);
      const folders = new Set();
      for (const file of files) {
        for (let slash = file.indexOf("/"); slash !== -1; slash = file.indexOf("/", slash + 1)) folders.add(file.slice(0, slash));
      }
      const asked = Array.isArray(request.paths) ? new Set(request.paths) : null;
      return {
        served: true,
        files: asked ? files.filter((path) => asked.has(path)) : files,
        folders: asked ? [...folders].filter((path) => asked.has(path)) : [...folders],
      };
    }
    if (request.ask === "props" && Array.isArray(request.paths)) {
      const props = [];
      for (const path of request.paths) {
        if (isPlumbing(path)) continue;
        const object = await source.get(path).catch(() => null);
        if (!object) continue;
        const parsed = propsOf(await object.text());
        props.push({ path, version: object.etag, sealed: parsed === null, props: parsed && JSON.stringify(parsed) });
      }
      return { served: true, props };
    }
    return { served: false };
  };
  // Writable, as a test may replace one answer for its own case (`contacts.test.mjs`).
  Object.defineProperty(bound, "treeManifest", { value: manifest, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(bound, "treeFacts", { value: facts, enumerable: false, configurable: true, writable: true });
  return bound;
}

/**
 * `R2Store` with the tree attached: the store a session holds, for a suite
 * that builds its bucket directly. Same constructor, same methods.
 */
export function R2Store(bucket, options) {
  return treeBacked(new BareR2Store(bucket, options), { source: bucket?.untracked });
}
