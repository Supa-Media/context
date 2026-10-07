/**
 * Source guards over the whole gateway, not only its entry file.
 *
 * `store.test.mjs` and `encryptionPassphrase.test.mjs` read `src/index.js` as
 * text and assert things no fixture can enumerate: no legacy `BRAIN` binding,
 * no static env token, nothing that could open a passphrase-locked note, and
 * every `sealNoteContent` call naming the stored object it decides about.
 * Those properties were about "the gateway", and were written when the
 * gateway was one file. Now that `index.js` is being split into modules, code
 * that leaves it would leave those guards' sight without a single check
 * noticing — so the same properties are asserted here over every module under
 * `src/`, and the entry-file checks stay where they are.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function sources(dir = SRC) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (entry.endsWith(".js")) {
      out.push({ path: relative(SRC, full), text: readFileSync(full, "utf8") });
    }
  }
  return out;
}

const FILES = sources();

test("the scan sees the entry file and the modules split out of it", () => {
  const paths = new Set(FILES.map((file) => file.path));
  assert.ok(paths.has("index.js"));
  assert.ok(paths.has("notes/sealing.js"));
  assert.ok(FILES.length >= 40, `only ${FILES.length} files found under src/`);
});

test("no gateway module reads the legacy single-tenant BRAIN binding", () => {
  const offenders = FILES.filter((file) => /env\.BRAIN/.test(file.text)).map((file) => file.path);
  assert.deepEqual(offenders, []);
});

test("no gateway module reads a static env token", () => {
  const offenders = FILES.filter((file) => /env\.(PRIVATE|TEAM|PUBLIC|INBOX)_TOKEN/.test(file.text)).map(
    (file) => file.path,
  );
  assert.deepEqual(offenders, []);
});

// The envelope module is `encryption.js` and the files it re-exports from under
// `encryption/`; `encryptionPassphrase.test.mjs` confines those files to
// importing only one another. Everything else is checked here, including an
// import that reaches past the entry file into `encryption/` directly.
const ENVELOPE_MODULE = (path) => path === "encryption.js" || path.startsWith("encryption/");

test("nothing outside the envelope module imports or calls what could open a passphrase note", () => {
  const offenders = [];
  for (const file of FILES) {
    if (ENVELOPE_MODULE(file.path)) continue;
    for (const imported of file.text.matchAll(
      /import\s*{([^}]*)}\s*from\s*"[^"]*\/encryption(?:\.js|\/[^"]*)"/g,
    )) {
      if (imported[1].split(",").some((name) => /passphrase/i.test(name))) offenders.push(`${file.path} imports`);
    }
    if (
      /(decryptNoteWithPassphrase|encryptNoteForPassphrase|wrapNoteKeyForPassphrase|unwrapNoteKey|deriveBits|deriveKey)\s*\(/.test(
        file.text,
      )
    ) {
      offenders.push(`${file.path} calls`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("every call to sealNoteContent, in any module, names the stored object it decides about", () => {
  const calls = FILES.flatMap((file) =>
    [...file.text.matchAll(/(?<!function\s)\bsealNoteContent\(([^)]*)\)/g)].map((match) => ({
      path: file.path,
      args: match[1],
    })),
  );
  assert.ok(calls.length >= 4, `only ${calls.length} calls found`);
  const short = calls.filter((call) => call.args.split(",").filter((part) => part.trim() !== "").length !== 3);
  assert.deepEqual(short, []);
});

/*
  A move limit's VALUE is written down in exactly one place.

  `moves/limits.js` holds the numbers; every other module interpolates the
  constant (`folder has more than ${LOGICAL_FOLDER_MOVE_THRESHOLD} visible
  objects`) so its message cannot disagree with the code. A comment that
  restates the number instead goes stale silently the next time the limit
  moves, and then a reader checks the stated reason, finds a different number,
  and does not know which of the two to trust.

  That is not hypothetical: #1301 took `FOLDER_MOVE_CAP` from 500 to 100 and
  left `encryptionKeys/rotation.js` justifying its own batch size as "small
  next to `FOLDER_MOVE_CAP`'s 500 on purpose" — the register's 275/276 family,
  where a deliberate decision keeps a reason that is no longer true.

  The names come from `limits.js` itself rather than a list here, so a limit
  added later is covered without anyone remembering to add it. Single digits
  are left alone: `MOVE_JOB_VERSION = 1` is a schema version, and prose names
  small numbers for their own reasons.

  ALIASES ARE FOLLOWED ONE HOP, and that is not a refinement — without it this
  guard misses the only name that matters. The number lives on the private
  `FOLDER_MOVE_CAP`; what every other module imports and what the stale comment
  will name next time is `LOGICAL_FOLDER_MOVE_THRESHOLD`, declared as
  `= FOLDER_MOVE_CAP` and therefore invisible to a scan for `= <digits>`.
  Written without the hop, sabotage-checked, and found to pass a planted
  "LOGICAL_FOLDER_MOVE_THRESHOLD is 100 today" — green on exactly the defect it
  exists to catch.

  The floor below is a vacuity check, not a count of today's limits: a broken
  extraction yields an almost-empty alternation that matches nothing and passes
  silently, so it must fail loudly instead. Removing a limit legitimately
  should not redden this.
*/
test("no gateway module restates a move limit's value beside its name", () => {
  const limits = FILES.find((file) => file.path === "moves/limits.js");
  assert.ok(limits, "moves/limits.js not found");
  const numeric = [...limits.text.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*) = \d+;/gm)].map((match) => match[1]);
  const aliases = [...limits.text.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*) = ([A-Z][A-Z0-9_]*);/gm)]
    .filter((match) => numeric.includes(match[2]))
    .map((match) => match[1]);
  const names = [...numeric, ...aliases];
  assert.ok(names.length >= 2, `only ${names.length} move limits found: ${names.join(", ")}`);
  const beside = new RegExp(
    `(?:${names.join("|")})[^\\n]{0,40}?\\b\\d{2,}\\b|\\b\\d{2,}\\b[^\\n]{0,40}?(?:${names.join("|")})`,
  );
  const offenders = FILES.filter((file) => file.path !== "moves/limits.js" && beside.test(file.text)).map(
    (file) => file.path,
  );
  assert.deepEqual(offenders, []);
});
