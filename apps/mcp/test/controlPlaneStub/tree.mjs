/**
 * The control plane's tree, for the stub: `/gateway/tree/manifest` and
 * `/gateway/tree/facts`, answered from a store a test hands it.
 *
 * The real routes answer from Convex rows that a sweep copied out of the
 * bucket and every change re-checks (`apps/convex/functions/lib/nodes/`). The
 * gateway's listing tools now list only from those routes
 * (`src/tree/served.js`), so a suite that wants a listing must say which
 * bucket the workspace's tree was copied from: `serveTree(workspaceId, store)`,
 * or `serveTreesFrom(env)` for every workspace bound to one of `env`'s R2
 * bindings, read at request time so `env` may be filled in later.
 * A workspace with none answers `{ served: false }`, which is what a
 * workspace whose first copy has not finished answers, and the gateway says
 * it is still loading.
 *
 * Read at request time, so a note a test writes is in the tree at once; the
 * real tree hears of a gateway write a second or so later. A logical-delete
 * marker (storage without conditional delete) is a deleted note, as the real
 * tree records it.
 *
 * What it does not reproduce, deliberately: the clearance filter. The real
 * route hands back only what the grant may see, and the gateway filters again
 * with its own engine; this sends every note key and leaves the narrowing to
 * the gateway, so a test of the gateway's own privacy filter still has
 * something to filter. `apps/convex/__tests__/nodes/gatewayManifest.test.ts`
 * and `gatewayFacts.test.ts` hold the real route to its clearance.
 *
 * Facts: a move's link candidates are every note (each counted as changed
 * since its links were read, which the real route also answers for a note it
 * has not parsed), so a rewrite reads every note it may rewrite; the chaos
 * score's facts are not kept (`chaos: null`); props are parsed from each
 * note's text with the same `propsOf` the real fill runs. A write's names
 * (`ask: "names"`) are what the source holds, unfiltered, and only for a
 * grant with `context:write`, as `gatewayNames.ts` answers them; the count
 * is every note.
 */

import { propsOf } from "../../src/tree/props.js";
import { isLogicalDeleteMarker } from "../../src/store/logicalDelete.js";

const NOT_SERVED = { served: false };

function plumbing(key) {
  return key.startsWith(".") || key.includes("/.");
}

async function allKeys(source, prefix = "") {
  const objects = [];
  let cursor;
  for (let pages = 0; pages < 1000; pages += 1) {
    const page = await source.list({ prefix, ...(cursor === undefined ? {} : { cursor }), limit: 1000 });
    for (const object of page.objects || []) objects.push(object);
    if (!page.truncated) return objects;
    cursor = page.cursor;
  }
  throw new Error("tree stub: listing did not end");
}

/**
 * A backend's object map (S3: `key → { body, etag, lastModified? }`; Dropbox:
 * `/path → { body, rev }`) as a store, with the binding's root prefix (`strip`)
 * taken off every key the way the gateway's adapter takes it off.
 */
function mapSource(objects, strip = "") {
  const keyOf = (stored) => (stored.startsWith(strip) ? stored.slice(strip.length) : null);
  return {
    async list({ prefix = "" } = {}) {
      const found = [];
      for (const [stored, value] of objects) {
        const key = keyOf(stored);
        if (key === null || !key.startsWith(prefix)) continue;
        // A store without conditional delete deletes by leaving a marker;
        // the real tree hears of that delete and drops the row.
        if (isLogicalDeleteMarker(value.body)) continue;
        found.push({
          key,
          etag: value.etag ?? value.rev,
          size: value.body.length,
          uploaded: new Date(value.lastModified ?? "2026-08-01T10:00:00.000Z"),
        });
      }
      return { objects: found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)), truncated: false };
    },
    async get(key) {
      const object = objects.get(`${strip}${key}`);
      return object && !isLogicalDeleteMarker(object.body) ? { etag: object.etag ?? object.rev, text: async () => object.body } : null;
    },
  };
}

/**
 * @param {(token: string) => Promise<object | null>} grantForAccessToken
 * @param {Map<string, object>} bindings workspaceId → its binding descriptor
 */
export function createTreeRoutes(grantForAccessToken, bindings) {
  /** workspaceId → the store its tree is copied from. */
  const sources = new Map();
  /** The worker `env`s whose R2 bindings every bound workspace's tree is copied from. */
  const envs = [];

  /** S3 backends (`s3Backend.mjs`) whose buckets every S3-bound workspace's tree is copied from. */
  const backends = [];
  /** The Dropbox backend (`dropboxBackend.mjs`) Dropbox-bound workspaces' trees are copied from. */
  let dropbox = null;

  function boundSource(workspaceId) {
    const binding = bindings.get(workspaceId);
    if (binding?.provider === "r2-binding") {
      for (const env of envs) {
        const bucket = env?.[binding.bindingName];
        if (bucket && typeof bucket.list === "function") return bucket;
      }
    }
    if (binding?.provider === "s3") {
      const backend = backends.find((candidate) => binding.endpoint === candidate.endpoint);
      if (backend) return mapSource(backend.bucketFor(binding.bucket), binding.rootPrefix ?? "");
    }
    if (binding?.provider === "dropbox" && dropbox) {
      return mapSource(dropbox.accountFor(binding.accessToken), `/${binding.rootPrefix ?? ""}`);
    }
    return null;
  }
  /** Every request, for a test that counts them. */
  const requests = [];
  /** Requests being answered now: the reads they make are the tree's, not the gateway's. */
  let reading = 0;

  async function sourceFor(body) {
    const grant = await grantForAccessToken(body.accessToken);
    if (!grant || !grant.scopes?.includes("context:read")) return null;
    const expected = body.expectedWorkspaceId;
    const reaches =
      grant.workspaceId === expected || (grant.alsoMemberOf || []).some((entry) => entry.workspaceId === expected);
    if (!reaches) return null;
    return sources.has(expected) ? sources.get(expected) : boundSource(expected);
  }

  async function manifest(body) {
    const source = await sourceFor(body);
    if (!source) return NOT_SERVED;
    const prefix = typeof body.folder === "string" && body.folder !== "" ? `${body.folder}/` : "";
    const entries = (await allKeys(source, prefix))
      .filter(({ key }) => !plumbing(key))
      .map((object) => ({
        path: object.key,
        ...(typeof object.etag === "string" ? { etag: object.etag } : {}),
        ...(Number.isFinite(object.size) ? { size: object.size } : {}),
        ...(object.uploaded instanceof Date ? { updatedAt: object.uploaded.valueOf() } : {}),
      }));
    return { served: true, entries, cursor: null };
  }

  async function facts(body) {
    const source = await sourceFor(body);
    // A stopped workspace is one on its first copy: a write's names say so.
    if (!source && body.ask === "names" && sources.get(body.expectedWorkspaceId) === null) return { served: false, loading: true };
    if (!source) return NOT_SERVED;
    if (body.ask === "links") {
      const notes = (await allKeys(source)).map(({ key }) => key).filter((key) => key.endsWith(".md") && !plumbing(key));
      return { served: true, candidates: { pointing: [], unparsed: notes } };
    }
    if (body.ask === "chaos") return { served: true, chaos: null };
    if (body.ask === "props" && Array.isArray(body.paths)) {
      const props = [];
      for (const path of body.paths) {
        if (typeof path !== "string" || plumbing(path)) continue;
        const object = await source.get(path);
        if (!object) continue;
        const parsed = propsOf(await object.text());
        props.push({
          path,
          version: typeof object.etag === "string" ? object.etag : null,
          sealed: parsed === null,
          props: parsed === null ? null : JSON.stringify(parsed),
        });
      }
      return { served: true, props };
    }
    if (body.ask === "names") return await names(body, source);
    return NOT_SERVED;
  }

  async function names(body, source) {
    const grant = await grantForAccessToken(body.accessToken);
    if (!grant?.scopes?.includes("context:write")) return NOT_SERVED;
    const files = [];
    const folders = [];
    for (const path of Array.isArray(body.paths) ? body.paths : []) {
      if (typeof path !== "string" || path === "") continue;
      // A logical-delete marker is a deleted note, as the real tree records it.
      const object = await source.get(path);
      if (object && !isLogicalDeleteMarker(await object.text())) files.push(path);
      if ((await allKeys(source, `${path}/`)).some(({ key }) => !plumbing(key))) folders.push(path);
    }
    if (body.count !== true) return { served: true, files, folders };
    let notes = 0;
    for (const { key } of await allKeys(source)) {
      if (!key.toLowerCase().endsWith(".md") || key.split("/").some((part) => part.startsWith("."))) continue;
      // A logical-delete marker is a deleted note, as the real tree records it.
      const object = await source.get(key);
      if (object && !isLogicalDeleteMarker(await object.text())) notes += 1;
    }
    return { served: true, files, folders, notes };
  }

  return {
    requests,
    get reading() {
      return reading;
    },
    serveTree(workspaceId, source) {
      sources.set(workspaceId, source);
    },
    /**
     * Every workspace bound to one of `env`'s R2 bindings, to a bucket of
     * the S3 backend `s3`, or to a folder of the Dropbox backend, has its tree
     * copied from it. Read straight from
     * the backend's map, so the bucket's own request counters do not move.
     */
    serveTreesFrom(env, { s3, dropbox: folders } = {}) {
      if (env) envs.push(env);
      if (s3) backends.push(s3);
      if (folders) dropbox = folders;
    },
    /** The workspace answers `served: false`, as one whose first copy has not finished. */
    stopServing(workspaceId) {
      sources.set(workspaceId, null);
    },
    /** Back to serving from whatever it was served from before. */
    resumeServing(workspaceId) {
      sources.delete(workspaceId);
    },
    /** The answer for a tree route, or undefined for any other path. */
    async handle(path, body) {
      if (path !== "/gateway/tree/manifest" && path !== "/gateway/tree/facts") return undefined;
      requests.push({ path, body });
      reading += 1;
      try {
        return path === "/gateway/tree/manifest" ? await manifest(body) : await facts(body);
      } finally {
        reading -= 1;
      }
    },
  };
}
