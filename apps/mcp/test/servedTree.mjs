import { propsOf } from "../src/tree/props.js";

/**
 * A fake store's control-plane tree, read from the fake's own keys. The tree is
 * the only source of names (`src/tree/served.js`, `src/tree/names.js`), so a
 * test store that lists or checks names must serve them, as the control plane
 * does in production: `treeManifest` for its subtree under `folder` (dot
 * folders left out, one page), and `treeFacts` answering `ask: "names"` and
 * `ask: "props"`. Other facts answer `served: false`.
 *
 * @param {{ list: (options: { prefix?: string, cursor?: string, limit?: number }) => Promise<{ objects: { key: string, etag?: string, size?: number }[], truncated: boolean, cursor?: string }> }} store
 * @param {{ list: typeof store.list }} [source] where the tree's keys are read from, when not the store itself (a
 *   test that counts the store's own operations reads the tree elsewhere, as production's comes from Convex)
 * @returns {typeof store} the same store, with `treeManifest` and `treeFacts` defined
 */
export function withServedTree(store, source = store) {
  const keysUnder = async (folder) => {
    const prefix = folder === "" ? "" : `${folder}/`;
    const found = [];
    for (let cursor; ; ) {
      const page = await source.list({ prefix: prefix || undefined, cursor, limit: 1000 });
      for (const object of page.objects ?? []) {
        if (object.key.startsWith(".") || object.key.includes("/.")) continue;
        found.push(object);
      }
      if (!page.truncated || !page.cursor) break;
      cursor = page.cursor;
    }
    return found;
  };
  Object.defineProperty(store, "treeManifest", {
    configurable: true,
    writable: true,
    value: async ({ folder = "" } = {}) => {
      const entries = (await keysUnder(folder)).map((object) => ({ path: object.key, etag: object.etag, size: object.size }));
      return { served: true, entries, cursor: null };
    },
  });
  Object.defineProperty(store, "treeFacts", {
    configurable: true,
    writable: true,
    value: async (request) => {
      const keys = new Set((await keysUnder("")).map((object) => object.key));
      if (request.ask === "names") {
        const files = request.paths.filter((path) => keys.has(path));
        const folders = request.paths.filter((path) => [...keys].some((key) => key.startsWith(`${path}/`)));
        return { served: true, files, folders };
      }
      if (request.ask === "props") {
        // Each note's props as the tree's own fill reads them (`propsOf`); a sealed note has none.
        const props = [];
        for (const path of request.paths) {
          if (!keys.has(path)) continue;
          const object = await store.get(path);
          const parsed = propsOf(await object.text());
          props.push({ path, version: object.etag, sealed: parsed === null, props: parsed && JSON.stringify(parsed) });
        }
        return { served: true, props };
      }
      return { served: false };
    },
  });
  return store;
}
