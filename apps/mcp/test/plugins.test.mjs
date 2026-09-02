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

import { R2Store } from "../src/store/r2.js";
import {
  MAX_SCAN_BYTES,
  VERDICTS,
  parseManifest,
  scanBundle,
  scanPlugin,
  summarize,
} from "../src/plugins/scan.js";
import { PLUGIN_PREFIX, inventoryPlugins, listPluginFolders } from "../src/plugins/inventory.js";
import { renderPluginReport } from "../src/plugins/report.js";

/**
 * A bucket stub with the two behaviours real backends differ on.
 *
 * `delimiter: false` makes it ignore the delimiter, which is what the in-memory
 * stub in `test.mjs` does and what at least one S3-compatible provider does —
 * the case where the inventory has to derive folder names from keys instead.
 * `pageSize` forces pagination, so the cursor discipline is exercised rather
 * than asserted.
 */
function makeBucket({ delimiter = true, pageSize = 1000 } = {}) {
  const objects = new Map();
  let etagCounter = 0;
  const encoder = new TextEncoder();
  const writes = [];
  return {
    objects,
    writes,
    seed(key, text) {
      objects.set(key, { bytes: encoder.encode(text), etag: `e${++etagCounter}` });
    },
    async get(key) {
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

const CLEAN_BUNDLE = `
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

function manifestFor(id, extra = {}) {
  return JSON.stringify({
    id,
    name: extra.name || id,
    version: extra.version || "1.0.0",
    author: extra.author || "someone",
    ...extra,
  });
}

export async function runPluginChecks(check) {
  // ---------------------------------------------------------------- manifest
  check(
    "a well-formed manifest yields its id and name",
    parseManifest(manifestFor("dataview", { name: "Dataview" })).manifest?.name === "Dataview"
  );
  check("manifest that is not JSON is an error, not a throw", Boolean(parseManifest("{").error));
  check("manifest that is an array is refused", Boolean(parseManifest("[]").error));
  check("manifest with no id is refused", Boolean(parseManifest('{"name":"x"}').error));
  check(
    "an id that is not a string is refused rather than coerced",
    Boolean(parseManifest('{"id":{"a":1}}').error)
  );
  check(
    "isDesktopOnly is recorded but is not itself a refusal",
    parseManifest(manifestFor("x", { isDesktopOnly: true })).manifest?.isDesktopOnly === true &&
      scanPlugin({
        id: "x",
        manifestText: manifestFor("x", { isDesktopOnly: true }),
        source: CLEAN_BUNDLE,
      }).verdict === "runs"
  );

  // -------------------------------------------------------------- the scan
  const clean = scanPlugin({ id: "demo", manifestText: manifestFor("demo"), source: CLEAN_BUNDLE });
  check("a bundle with no outside calls runs here", clean.verdict === "runs");
  check("a running plugin carries no evidence against it", clean.evidence.length === 0);
  check(
    "the supported members it touches are named",
    clean.supported.includes("registerMarkdownCodeBlockProcessor") &&
      clean.supported.includes("getMarkdownFiles")
  );

  const shell = scanPlugin({
    id: "sh",
    manifestText: manifestFor("sh"),
    source: `${CLEAN_BUNDLE}\nconst cp = require("child_process");`,
  });
  check("a bundle that spawns a process will not run here", shell.verdict === "wont-run");
  check(
    "and the refusal names the call, not a category",
    shell.evidence.some((item) => item.id === "child_process" && /process to start/.test(item.reason))
  );

  check(
    "node: prefixed builtins are the same reach and are caught",
    scanPlugin({ id: "n", manifestText: manifestFor("n"), source: `require("node:fs")` }).verdict ===
      "wont-run"
  );
  check(
    "an ESM import of a builtin is caught too",
    scanBundle(`import { readFile } from "fs/promises";`).blocked.some(
      (item) => item.id === "fs/promises"
    )
  );
  check(
    "Obsidian's private internals are a refusal",
    scanPlugin({
      id: "p",
      manifestText: manifestFor("p"),
      source: `${CLEAN_BUNDLE}\nthis.app.internalPlugins.getPluginById("x")`,
    }).verdict === "wont-run"
  );

  // "path" is polyfilled by every bundler and is pure string arithmetic. A
  // false refusal costs somebody a working plugin, which is worse than a miss.
  check(
    "path is not treated as a blocker",
    scanPlugin({
      id: "pa",
      manifestText: manifestFor("pa"),
      source: `${CLEAN_BUNDLE}\nconst path = require("path");`,
    }).verdict === "runs"
  );
  check(
    "a module name is matched whole, not as a substring",
    scanBundle(`require("lodash.throttle"); const closed = true; const composed = 1;`).blocked
      .length === 0
  );

  // ------------------------------------------------------------- network
  const readwise = scanPlugin({
    id: "readwise-official",
    manifestText: manifestFor("readwise-official"),
    source: `${CLEAN_BUNDLE}\nawait requestUrl({ url: "https://readwise.io/api/v2/export" });`,
  });
  check("a plugin that calls a host needs approval", readwise.verdict === "needs-approval");
  check("and the host it names travels with the verdict", readwise.hosts.includes("readwise.io"));
  check(
    "a host is reported without its port or path",
    scanBundle(`requestUrl("https://api.example.com:8443/v1/sync")`).hosts.includes(
      "api.example.com"
    )
  );
  check(
    "a template placeholder is not offered as a host",
    !scanBundle("requestUrl(`https://${server}/api`)").hosts.some((h) => h.includes("$"))
  );
  check(
    "hosts are not collected from a plugin that makes no network call",
    scanBundle(`// see https://docs.example.com for details\n${CLEAN_BUNDLE}`).hosts.length === 0
  );

  // --------------------------------------------- what the scan refuses to say
  //
  // The heart of it. Each of these bundles contains no blocker a text scan can
  // find, and each must fail to earn "runs" anyway.
  for (const [label, source] of [
    ["eval", `${CLEAN_BUNDLE}\neval(atob(payload));`],
    ["new Function", `${CLEAN_BUNDLE}\nconst f = new Function("return process")();`],
    ["a computed require", `${CLEAN_BUNDLE}\nconst mod = require("child_" + "process");`],
    ["a computed import", `${CLEAN_BUNDLE}\nconst mod = await import(name);`],
  ]) {
    const result = scanPlugin({ id: "ob", manifestText: manifestFor("ob"), source });
    check(`a bundle using ${label} is never reported as running`, result.verdict === "unknown");
    check(
      `and ${label} is named as the reason the check could not answer`,
      result.evidence.some((item) => item.kind === "dynamic")
    );
  }

  // The two bounds the scan puts on its own cost, each of which was a real
  // problem in the first version of this file: forty-six full passes over every
  // bundle, and a full-tail `slice` per `require(` call site.
  check(
    "a module specifier longer than the read window reads as computed, not clean",
    scanPlugin({
      id: "w",
      manifestText: manifestFor("w"),
      source: `require("${"x".repeat(600)}")`,
    }).verdict === "unknown"
  );
  const bigBundle = `${CLEAN_BUNDLE}\n${'const q = require("obsidian");\n'.repeat(20000)}`;
  const started = Date.now();
  const bigResult = scanPlugin({ id: "b", manifestText: manifestFor("b"), source: bigBundle });
  const elapsed = Date.now() - started;
  check(
    "a large minified bundle is scanned in one pass per table, not one per name",
    bigResult.verdict === "runs" && elapsed < 2000
  );

  const oversize = scanPlugin({
    id: "big",
    manifestText: manifestFor("big"),
    source: "a".repeat(MAX_SCAN_BYTES + 1),
  });
  check("a bundle past the read cap is unknown, not clean", oversize.verdict === "unknown");
  check(
    "and it says so rather than reporting on the part it reached",
    oversize.evidence.some((item) => /larger than/.test(item.reason))
  );
  check(
    "a missing main.js is unknown, not clean",
    scanPlugin({ id: "m", manifestText: manifestFor("m"), source: null }).verdict === "unknown"
  );
  check(
    "an unreadable manifest is unknown even when the bundle is spotless",
    scanPlugin({ id: "mm", manifestText: "not json", source: CLEAN_BUNDLE }).verdict === "unknown"
  );

  // ------------------------------------------------------------- curation
  const templater = scanPlugin({
    id: "templater-obsidian",
    manifestText: manifestFor("templater-obsidian", { name: "Templater" }),
    source: `${CLEAN_BUNDLE}\nconst cp = require("child_process");`,
  });
  check(
    "a blocker confined to one optional feature does not fail the whole plugin",
    templater.verdict === "runs"
  );
  check(
    "and the feature that stays off is stated",
    templater.limitations.some((line) => /User System Commands/.test(line))
  );
  check(
    "the same blocker in a plugin with no such entry still refuses",
    scanPlugin({
      id: "other",
      manifestText: manifestFor("other"),
      source: `require("child_process")`,
    }).verdict === "wont-run"
  );
  // Curation is keyed on the manifest's id, never the folder it was found in,
  // so renaming a folder to a curated name cannot buy a softer verdict.
  check(
    "curation follows the manifest id, not the folder name",
    scanPlugin({
      id: "templater-obsidian",
      manifestText: manifestFor("something-else"),
      source: `require("child_process")`,
    }).verdict === "wont-run"
  );
  // The one thing curation must never be able to do.
  check(
    "curation cannot lift an obfuscated bundle to running",
    scanPlugin({
      id: "templater-obsidian",
      manifestText: manifestFor("templater-obsidian"),
      source: `${CLEAN_BUNDLE}\neval(x);`,
    }).verdict === "unknown"
  );
  check(
    "a known-format plugin that cannot run is files-only, not a dead end",
    scanPlugin({
      id: "remotely-save",
      manifestText: manifestFor("remotely-save"),
      source: `require("fs")`,
    }).verdict === "files-only"
  );
  check(
    "a known-format plugin that CAN run is not demoted to files-only",
    scanPlugin({
      id: "remotely-save",
      manifestText: manifestFor("remotely-save"),
      source: CLEAN_BUNDLE,
    }).verdict === "runs"
  );

  check(
    "every verdict a scan can return is one the report knows how to draw",
    [templater, shell, readwise, oversize, clean].every((r) => VERDICTS.includes(r.verdict))
  );
  check(
    "summarize counts by verdict and ignores nothing it was given",
    summarize([clean, shell, readwise]).runs === 1 &&
      summarize([clean, shell, readwise])["wont-run"] === 1 &&
      summarize([clean, shell, readwise])["needs-approval"] === 1
  );

  // ------------------------------------------------------------ inventory
  const bucket = makeBucket();
  const store = new R2Store(bucket);
  bucket.seed(`${PLUGIN_PREFIX}dataview/manifest.json`, manifestFor("dataview", { name: "Dataview" }));
  bucket.seed(`${PLUGIN_PREFIX}dataview/main.js`, CLEAN_BUNDLE);
  bucket.seed(`${PLUGIN_PREFIX}dataview/styles.css`, ".x{}");
  bucket.seed(`${PLUGIN_PREFIX}obsidian-git/manifest.json`, manifestFor("obsidian-git", { name: "Obsidian Git" }));
  bucket.seed(`${PLUGIN_PREFIX}obsidian-git/main.js`, `require("child_process")`);
  bucket.seed(`${PLUGIN_PREFIX}broken/manifest.json`, manifestFor("broken"));
  bucket.seed("1-projects/real-note.md", "# a note\n");
  bucket.seed(".obsidian/app.json", "{}");

  const folders = await listPluginFolders(store);
  check(
    "the inventory finds each plugin folder exactly once",
    folders.join(",") === "broken,dataview,obsidian-git"
  );

  const report = await inventoryPlugins(store);
  check("every folder found is checked when under the cap", report.scanned === 3 && !report.truncated);
  check(
    "a clean plugin runs and a shelling one does not, in the same report",
    report.plugins.find((p) => p.id === "dataview").verdict === "runs" &&
      report.plugins.find((p) => p.id === "obsidian-git").verdict === "wont-run"
  );
  check(
    "a plugin with a manifest but no bundle is unknown, and the others still get verdicts",
    report.plugins.find((p) => p.id === "broken").verdict === "unknown" && report.scanned === 3
  );
  check("the report dates itself", /^\d{4}-\d{2}-\d{2}/.test(report.checkedAt));

  // The rule this module exists to keep.
  check("reading the inventory writes nothing at all", bucket.writes.length === 0);
  check(
    "and it does not touch notes, only .obsidian/plugins/",
    [...bucket.objects.keys()].includes("1-projects/real-note.md")
  );

  // A backend that ignores the delimiter must produce the same folder list, or
  // the report is empty on exactly the providers most likely to be self-hosted.
  const flatBucket = makeBucket({ delimiter: false });
  for (const [key, value] of bucket.objects) {
    flatBucket.seed(key, new TextDecoder().decode(value.bytes));
  }
  check(
    "a backend that ignores the delimiter yields the same folders",
    (await listPluginFolders(new R2Store(flatBucket))).join(",") === "broken,dataview,obsidian-git"
  );

  // Pagination, with a page size small enough that a single plugin spans pages.
  const pagedBucket = makeBucket({ pageSize: 2 });
  for (const [key, value] of bucket.objects) {
    pagedBucket.seed(key, new TextDecoder().decode(value.bytes));
  }
  check(
    "a paginated listing still finds every folder",
    (await listPluginFolders(new R2Store(pagedBucket))).join(",") === "broken,dataview,obsidian-git"
  );

  // One unreadable object must cost that plugin its verdict and nothing else —
  // the failure mode the note count hit, where a single bad folder suppressed
  // the whole bucket's total forever.
  const hostileBucket = makeBucket();
  for (const [key, value] of bucket.objects) {
    hostileBucket.seed(key, new TextDecoder().decode(value.bytes));
  }
  hostileBucket.objects.get(`${PLUGIN_PREFIX}dataview/main.js`).explode = true;
  // Awaited into a settled result rather than called bare: written the direct
  // way, a regression here rejects, and a rejecting suite reports no failing
  // check at all — which is how this exact gap survived its first sabotage run.
  const hostileSettled = await inventoryPlugins(new R2Store(hostileBucket)).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
  check("a throwing backend never rejects the report for the whole bucket", hostileSettled.ok);
  const hostileReport = hostileSettled.ok
    ? hostileSettled.value
    : { plugins: [], counts: {}, found: 0, scanned: 0 };
  check(
    "one object the backend refuses does not cost the other plugins their verdicts",
    hostileReport.plugins.find((p) => p.id === "dataview").verdict === "unknown" &&
      hostileReport.plugins.find((p) => p.id === "obsidian-git").verdict === "wont-run"
  );

  // A folder name the adapter would throw on is skipped, not fatal.
  const oddBucket = makeBucket();
  for (const [key, value] of bucket.objects) {
    oddBucket.seed(key, new TextDecoder().decode(value.bytes));
  }
  oddBucket.seed(`${PLUGIN_PREFIX}bad\\name/manifest.json`, manifestFor("bad"));
  const oddFolders = await listPluginFolders(new R2Store(oddBucket));
  check(
    "a folder name the storage adapter would refuse is skipped, not fatal",
    oddFolders.join(",") === "broken,dataview,obsidian-git"
  );

  // The cap, and the floor it produces.
  const manyBucket = makeBucket();
  for (let i = 0; i < 25; i += 1) {
    const id = `plugin-${String(i).padStart(2, "0")}`;
    manyBucket.seed(`${PLUGIN_PREFIX}${id}/manifest.json`, manifestFor(id));
    manyBucket.seed(`${PLUGIN_PREFIX}${id}/main.js`, CLEAN_BUNDLE);
  }
  const capped = await inventoryPlugins(new R2Store(manyBucket), { cap: 5 });
  check("a vault past the cap reports what it checked", capped.scanned === 5);
  check("and says the number found is a floor", capped.truncated === true && capped.found === 25);
  check(
    "a floor is rendered as one, never as a total",
    renderPluginReport(capped).includes("25+")
  );

  // A bucket with no vault at all is a normal state, not an error.
  const emptyReport = await inventoryPlugins(new R2Store(makeBucket()));
  check("a bucket with no plugins is available and empty", emptyReport.available && !emptyReport.found);
  check(
    "and the empty report explains where Context looked",
    renderPluginReport(emptyReport).includes(".obsidian/plugins/")
  );

  // A listing that will not finish is reported, not thrown at the caller.
  const brokenListing = {
    async list() {
      return { objects: [], delimitedPrefixes: [], truncated: true };
    },
    async get() {
      return null;
    },
    async put() {},
    async delete() {},
  };
  const unavailable = await inventoryPlugins(new R2Store(brokenListing));
  check("a listing that cannot finish is reported, not thrown", unavailable.available === false);
  check(
    "and it says the failure is about the vault, not the notes",
    renderPluginReport(unavailable).includes("not about your notes")
  );

  // ------------------------------------------------------------- the copy
  const text = renderPluginReport(report);
  check("the report names the specific call that refused a plugin", text.includes("child_process"));
  check(
    "a plugin that cannot run here still carries the route that works",
    text.includes("Keep it in Obsidian")
  );
  check(
    "the report says a verdict is a floor rather than a guarantee",
    text.includes("floor, not a guarantee") && text.includes("does not run it")
  );
  check(
    "an unreadable plugin is framed as unchecked, not as refused",
    text.includes("Not a refusal")
  );
  const approvalText = renderPluginReport({
    available: true,
    reason: null,
    plugins: [readwise],
    counts: summarize([readwise]),
    found: 1,
    scanned: 1,
    truncated: false,
    checkedAt: "2026-09-02T00:00:00.000Z",
  });
  check("an approval verdict shows the host on the consent path", approvalText.includes("readwise.io"));
}
