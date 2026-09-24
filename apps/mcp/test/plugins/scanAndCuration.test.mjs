/**
 * The scan: what it finds in a bundle, refused only where the text itself is
 * evidence — not by silence — plus the network claim it makes, what it
 * refuses to say when it cannot tell, and curation's own verdict rules. One
 * file because curation's "every verdict... knows how to draw" checks reuse
 * the scan results (`clean`, `shell`, `readwise`, `oversize`, `templater`)
 * built up across all four of these sections.
 *
 * Split out of plugins.test.mjs; see fixtures.mjs for the shared bucket stub
 * and manifest/bundle builders.
 */

import {
  CLEAN_BUNDLE,
  MAX_SCAN_BYTES,
  VERDICTS,
  manifestFor,
  readFile,
  renderPluginReport,
  scanBundle,
  scanPlugin,
  summarize,
} from "./fixtures.mjs";

export async function runPluginScanAndCurationChecks(check) {
  // -------------------------------------------------------------- the scan
  const clean = scanPlugin({ id: "demo", manifestText: manifestFor("demo"), source: CLEAN_BUNDLE });
  check("a bundle with no outside calls runs here", clean.verdict === "runs");
  check("a running plugin carries no evidence against it", clean.evidence.length === 0);
  /*
    This used to assert `registerMarkdownCodeBlockProcessor` was *supported*,
    and that was the over-claim this split exists to end: the shim does not
    implement it, and a bundle using it scanned clean, read as "everything these
    use, Context implements", loaded, registered, and rendered nothing.

    It is now named on the other list, and the row says so.
  */
  check(
    "the supported members it touches are named",
    clean.supported.includes("getMarkdownFiles")
  );
  check(
    "a member the shim has not implemented is not called supported",
    !clean.supported.includes("registerMarkdownCodeBlockProcessor") &&
      clean.planned.includes("registerMarkdownCodeBlockProcessor")
  );
  check(
    "and it becomes a limitation the reader can act on, rather than silence",
    clean.limitations.some((line) => line.includes("code blocks are not drawn yet"))
  );
  check(
    "a planned member never changes the verdict — the plugin still runs",
    clean.verdict === "runs"
  );
  {
    // Four link-graph members, one sentence: a row listing the same reason four
    // times is a row nobody finishes reading.
    const graph = scanPlugin({
      id: "graph",
      manifestText: manifestFor("graph"),
      source:
        "const a = this.app.metadataCache.resolvedLinks;\n" +
        "const b = this.app.metadataCache.unresolvedLinks;\n" +
        "const c = this.app.metadataCache.getFirstLinkpathDest('x');\n" +
        "const d = this.app.metadataCache.fileToLinktext(e);\n",
    });
    check(
      "four members with one cause produce one sentence",
      graph.limitations.filter((line) => line.includes("link graph")).length === 1
    );
  }

  /*
    A PLANNED MEMBER USED AS A BASE CLASS IS NOT A MISSING FEATURE.

    `PLANNED_MEMBERS` holds two kinds, and `surface.js` has always said so:
    **present and inert** — `addSettingTab` accepts a registration and drops it
    — and **absent**, which is not on the shim at all. The wording above is
    written for the first kind and is right about it: the plugin loads, and one
    part of it does nothing.

    It is wrong about the second kind in one specific place. `class X extends
    api.SuggestModal {}` evaluates `extends undefined` and throws, so the bundle
    never finishes loading and *nothing* of the plugin arrives — reported, until
    now, as `runs` with a "not yet" note under a heading that reads "everything
    these use, Context implements".

    That is this file's own asymmetry arriving from a new direction: `runs` rests
    on evidence we did not find, and here we had the evidence and filed it as a
    footnote. Found on Bible Reference (obsidian-bible-reference), which extends
    `SuggestModal`. It is 4.11MB, so until the read cap moved to 16MB in this
    same change it never reached this path at all — the bug was live only for
    smaller plugins doing the same thing, which is the worst way for one to be
    live: invisible on the plugin that would have shown it to you.
  */
  {
    const base = scanPlugin({
      id: "suggest",
      manifestText: manifestFor("suggest"),
      source: 'const o = require("obsidian");\nvar M = class extends o.MarkdownRenderer { };\n',
    });
    check(
      "a bundle extending a class the shim does not provide will not run here",
      base.verdict === "wont-run"
    );
    check(
      "and the evidence names the class, not the category",
      base.evidence.some((entry) => entry.id === "MarkdownRenderer")
    );
    // `report.js` draws the route out for `wont-run`, which is the correct
    // advice here and the reason the verdict is this one rather than `unknown`.
    check(
      "it is not reported as a limitation on a row that says it runs",
      !base.limitations.some((line) => line.includes("rendering markdown"))
    );
    check(
      "a bare identifier works too — a bundler may not namespace the import",
      scanPlugin({
        id: "bare",
        manifestText: manifestFor("bare"),
        source: 'import { MarkdownRenderer } from "obsidian";\nclass M extends MarkdownRenderer {}\n',
      }).verdict === "wont-run"
    );
  }
  /*
    The positive companion, and the half that stops this widening onto every
    plugin: naming an absent member without extending it is unchanged. A
    `TypeError` on a call is a crash in whatever path calls it; `extends` is a
    crash before `onload` runs at all, and only the second makes the whole
    plugin unavailable.
  */
  check(
    "naming an absent member without extending it is still a limitation on a running plugin",
    (() => {
      const called = scanPlugin({
        id: "called",
        manifestText: manifestFor("called"),
        source: "const m = new obsidian.MarkdownRenderer(this.app);\n",
      });
      return (
        called.verdict === "runs" &&
        called.limitations.some((line) => line.includes("rendering markdown"))
      );
    })()
  );
  /*
    THE HALF NO LIST COULD HAVE ANSWERED.

    `SuggestModal` was found because somebody had written it down as absent.
    `Events` and `Modal` were on no list in this repository — not supported, not
    planned, not absent — so a bundle extending either scanned clean, was
    labelled "runs here: everything these use, Context implements", and then
    died on `extends undefined` before `onload`. Verified against the real
    Bible Reference release, which extends both.

    `undeclaredBases` derives the answer from what the shim exports instead, so
    a base class nobody thought of is caught by construction. The name is
    reported without a claim about it: "not built yet" would be a promise about
    somebody else's API.
  */
  /*
    A PLUGIN THAT USES PLAIN fetch ASKS FOR APPROVAL.

    It did not, and the omission was invisible while the sandbox CSP refused
    every direct call: the scan said "no network" and the plugin reached
    nothing, so the wrong reading and the right outcome agreed. Once the shim
    brokers `fetch` the plugin really does reach outward, and a verdict of
    `runs` would hand it the network without its owner ever naming a host.
  */
  check(
    "a bundle that calls fetch needs approval rather than running unasked",
    (() => {
      const scanned = scanPlugin({
        id: "fetcher",
        manifestText: manifestFor("fetcher"),
        source: 'const { Plugin } = require("obsidian");\nmodule.exports = class extends Plugin { async onload() { await fetch("https://example.invalid/x"); } };\n',
      });
      return (
        scanned.verdict === "needs-approval" &&
        scanned.evidence.some((entry) => entry.id === "fetch" && entry.kind === "network")
      );
    })()
  );
  check(
    "a base class nobody ever listed is still a blocker, derived from what the shim exports",
    (() => {
      const scanned = scanPlugin({
        id: "unlisted-base",
        manifestText: manifestFor("unlisted-base"),
        source: 'var eo = require("obsidian");\nclass V extends eo.NeverHeardOfIt {}\n',
      });
      return (
        scanned.verdict === "wont-run" &&
        scanned.evidence.some((entry) => entry.id === "NeverHeardOfIt") &&
        !scanned.evidence.some((entry) => /not built yet/.test(entry.reason))
      );
    })()
  );
  check(
    "and a class the shim does export is not one, however it was reached",
    (() => {
      const source =
        'var eo = require("obsidian");\n' +
        "class A extends eo.Events {}\nclass B extends eo.Modal { }\n" +
        "class C extends eo.Plugin {}\nmodule.exports = C;\n";
      return scanPlugin({ id: "real-bases", manifestText: manifestFor("real-bases"), source }).verdict === "runs";
    })()
  );
  /*
    AND THE OTHER WAY EVERY OBSIDIAN PLUGIN IS WRITTEN.

    `const { Plugin, Modal } = require("obsidian")` is the form the official
    sample plugin uses and the one every hand-written `main.js` in the ecosystem
    copies; `import { Modal } from "obsidian"` is its ESM twin, and
    `import * as obsidian from "obsidian"` the namespace one. The derived check
    read only `var x = require("obsidian")`, so a bundle written any of the
    other three ways extended whatever it liked and scanned clean — the exact
    verdict this check exists to stop, surviving in the import style most
    plugins are actually written in.

    Measured before it was fixed: the namespace form answered `wont-run`, the
    destructured form answered `runs`, for the same unknown base class.
  */
  for (const [style, binding] of [
    ["destructured from require", 'const { Plugin, NeverHeardOfIt } = require("obsidian");'],
    ["destructured and renamed", 'const { NeverHeardOfIt: Base } = require("obsidian");'],
    ["a named ESM import", 'import { NeverHeardOfIt } from "obsidian";'],
    ["an ESM namespace import", 'import * as eo from "obsidian";'],
  ]) {
    const extendee = style === "destructured and renamed"
      ? "Base"
      : style === "an ESM namespace import"
        ? "eo.NeverHeardOfIt"
        : "NeverHeardOfIt";
    check(
      `a base class nobody listed is caught when it arrives ${style}`,
      (() => {
        const scanned = scanPlugin({
          id: "unlisted-base-other-form",
          manifestText: manifestFor("unlisted-base-other-form"),
          source: `${binding}\nclass V extends ${extendee} {}\n`,
        });
        return (
          scanned.verdict === "wont-run" &&
          // Reported under the name the SHIM would have to provide, which for a
          // renamed import is the export's name and not the local one.
          scanned.evidence.some((entry) => entry.id === "NeverHeardOfIt")
        );
      })()
    );
  }
  check(
    "...and a class the shim does export is still fine in those forms",
    (() => {
      const source =
        'const { Plugin, Modal } = require("obsidian");\n' +
        'import { Events as Bus } from "obsidian";\n' +
        "class A extends Modal {}\nclass B extends Bus {}\nclass C extends Plugin {}\n";
      return (
        scanPlugin({ id: "real-bases-destructured", manifestText: manifestFor("real-bases-destructured"), source })
          .verdict === "runs"
      );
    })()
  );
  check(
    "...and a destructuring of some other module is left alone",
    (() => {
      const source =
        'const { Widget } = require("some-charting-library");\n' +
        "class V extends Widget {}\nmodule.exports = V;\n";
      return (
        scanPlugin({ id: "other-module-destructured", manifestText: manifestFor("other-module-destructured"), source })
          .verdict === "runs"
      );
    })()
  );
  /*
    The precision that keeps this from failing plugins that work: a bundled
    third-party library has its own namespaces and its own classes, and only a
    namespace that provably came from `require("obsidian")` is ours to judge.
    The module string survives minification; the identifier does not.
  */
  check(
    "a namespace that did not come from the obsidian module is left alone",
    scanPlugin({
      id: "other-namespace",
      manifestText: manifestFor("other-namespace"),
      source: 'var ui = require("some-ui-kit");\nclass W extends ui.Widget {}\n',
    }).verdict === "runs"
  );
  check(
    "and extending one the shim DOES answer is not a blocker",
    scanPlugin({
      id: "inert",
      manifestText: manifestFor("inert"),
      source: 'const o = require("obsidian");\nclass T extends o.PluginSettingTab {}\nthis.addSettingTab(new T());\n',
    }).verdict === "runs"
  );
  /*
    Curation moves the label the same way it does for a blocker, and for the
    same reason: a plugin whose *format* Context reads strands no data, whatever
    it cannot do here. Mirrored rather than special-cased so the two paths
    cannot drift into disagreeing about one plugin.
  */
  /*
    The heading has to describe both ways in. It read "these need a filesystem,
    a shell, or Obsidian's private internals" — true of every plugin that had
    ever landed there, and false the moment a missing base class could put one
    there: Bible Reference needs none of those three, it needs a dialog we have
    not built. A group blurb that does not cover its own rows is the same
    overclaim as a verdict that does not, one level up.
  */
  check(
    "the won't-run heading covers a plugin held back by us rather than by the sandbox",
    (() => {
      const held = scanPlugin({
        id: "held",
        manifestText: manifestFor("held"),
        source: 'const o = require("obsidian");\nclass M extends o.MarkdownRenderer {}\n',
      });
      const rendered = renderPluginReport({
        available: true,
        reason: null,
        plugins: [held],
        counts: summarize([held]),
        found: 1,
        scanned: 1,
        truncated: false,
        checkedAt: new Date().toISOString(),
      });
      return /Context has not built yet/.test(rendered);
    })()
  );
  check(
    "a curated format-supported plugin reads files-only rather than wont-run",
    scanPlugin({
      id: "remotely-save",
      manifestText: manifestFor("remotely-save"),
      source: 'const o = require("obsidian");\nclass M extends o.MarkdownRenderer {}\n',
    }).verdict === "files-only"
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
    /*
      AN ESCAPE IS A LITERAL WHOSE TEXT IS NOT ITS VALUE.

      `"child_\\x70rocess"` satisfies the closing-paren rule honestly — it IS
      precisely one quoted string — and its runtime value is `child_process`.
      `hasComputedModuleName` tests the source text and `BLOCKED_MODULE_NAMES`
      looks up the source text, and neither decodes the literal, so this landed
      on `runs` with an empty blocked list: the strongest possible reading of
      the strongest possible evasion. It is the documented `"child_" +
      "process"` case one door over, and it must answer the same way.
    */
    ["a hex-escaped require", `${CLEAN_BUNDLE}\nconst mod = require("child_\\x70rocess");`],
    ["a unicode-escaped require", `${CLEAN_BUNDLE}\nconst mod = require("child_\\u0070rocess");`],
    ["an escaped builtin", `${CLEAN_BUNDLE}\nconst mod = require("f\\x73");`],
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

}
