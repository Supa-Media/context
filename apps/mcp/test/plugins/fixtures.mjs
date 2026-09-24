/**
 * The Obsidian plugin compatibility check.
 *
 * Three layers, matching the three modules: the scan is a pure function over
 * text and is tested as one; the inventory is tested against a bucket stub that
 * can be made to behave like the awkward backends (no delimiter support,
 * pagination, an unreadable object); the report is tested for the four phrasing
 * rules it exists to keep.
 *
 * The checks that matter most are the ones asserting what the scan *refuses* to
 * conclude. A text scan proves presence, never absence, so every path where a
 * missing finding could be mistaken for a clean bill has a check here — an
 * over-long bundle, an unreadable one, and above all an obfuscated one. A
 * plugin that can build `require("child_" + "process")` after it starts must
 * never come back "runs here", and curation must never be able to make it.
 */

import { readFile } from "node:fs/promises";

import { R2Store } from "../../src/store/r2.js";
import {
  MAX_REPORTED_HOSTS,
  MAX_SCAN_BYTES,
  VERDICTS,
  parseManifest,
  scanBundle,
  scanPlugin,
  summarize,
} from "../../src/plugins/scan.js";
import {
  MANAGED_PLUGIN_PREFIX,
  PLUGIN_PREFIX,
  inventoryPlugins,
  listManagedInstalls,
  listPluginFolders,
} from "../../src/plugins/inventory.js";
import { renderPluginReport } from "../../src/plugins/report.js";

/**
 * A bucket stub with the two behaviours real backends differ on.
 *
 * `delimiter: false` makes it ignore the delimiter, which is what the in-memory
 * stub in `test.mjs` does and what at least one S3-compatible provider does —
 * the case where the inventory has to derive folder names from keys instead.
 * `pageSize` forces pagination, so the cursor discipline is exercised rather
 * than asserted.
 */
export function makeBucket({ delimiter = true, pageSize = 1000 } = {}) {
  const objects = new Map();
  let etagCounter = 0;
  const encoder = new TextEncoder();
  const writes = [];
  // Every key anybody asked for, so "this does not open a bundle" can be a
  // check rather than a claim. `listManagedInstalls` exists to be cheap, and a
  // cheapness nobody measured is the kind that grows a manifest read back.
  const reads = [];
  return {
    objects,
    writes,
    reads,
    seed(key, text) {
      objects.set(key, { bytes: encoder.encode(text), etag: `e${++etagCounter}` });
    },
    async get(key) {
      reads.push(key);
      const entry = objects.get(key);
      if (!entry) return null;
      if (entry.explode) throw new Error("backend refused this object");
      return {
        etag: entry.etag,
        text: async () => new TextDecoder().decode(entry.bytes),
      };
    },
    async put(key, value) {
      writes.push(key);
      objects.set(key, { bytes: encoder.encode(String(value)), etag: `e${++etagCounter}` });
      return { etag: `e${etagCounter}` };
    },
    async delete(key) {
      writes.push(`delete:${key}`);
      objects.delete(key);
    },
    async list({ prefix, delimiter: wanted, cursor, limit } = {}) {
      const all = [...objects.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const size = Math.min(limit || pageSize, pageSize);
      const slice = all.slice(start, start + size);
      const end = start + slice.length;
      const page = { objects: [], delimitedPrefixes: [], truncated: end < all.length };
      if (page.truncated) page.cursor = String(end);
      if (wanted && delimiter) {
        const seen = new Set();
        for (const key of slice) {
          const remainder = key.slice((prefix || "").length);
          const at = remainder.indexOf(wanted);
          if (at === -1) {
            page.objects.push({ key, size: objects.get(key).bytes.length });
          } else {
            seen.add(`${prefix || ""}${remainder.slice(0, at + 1)}`);
          }
        }
        page.delimitedPrefixes = [...seen];
      } else {
        for (const key of slice) page.objects.push({ key, size: objects.get(key).bytes.length });
      }
      return page;
    },
  };
}

export const CLEAN_BUNDLE = `
  const { Plugin, Notice } = require("obsidian");
  module.exports = class extends Plugin {
    async onload() {
      const files = this.app.vault.getMarkdownFiles();
      this.registerMarkdownCodeBlockProcessor("demo", (src, el) => { el.textContent = src; });
      this.addCommand({ id: "demo", callback: () => new Notice(String(files.length)) });
      await this.saveData({ ok: true });
    }
  };
`;

export function manifestFor(id, extra = {}) {
  return JSON.stringify({
    id,
    name: extra.name || id,
    version: extra.version || "1.0.0",
    author: extra.author || "someone",
    ...extra,
  });
}


export {
  readFile,
  R2Store,
  MAX_REPORTED_HOSTS,
  MAX_SCAN_BYTES,
  VERDICTS,
  parseManifest,
  scanBundle,
  scanPlugin,
  summarize,
  MANAGED_PLUGIN_PREFIX,
  PLUGIN_PREFIX,
  inventoryPlugins,
  listManagedInstalls,
  listPluginFolders,
  renderPluginReport,
};
