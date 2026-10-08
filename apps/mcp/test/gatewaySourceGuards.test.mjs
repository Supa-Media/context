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

/*
  The redactor is only a guard if the call site hands it the value to redact.

  `safeMoveStorageDetail(error, store)` reads `store.accessKeyId` to replace the
  id a provider auth error echoes — the one credential shape its regexes cannot
  see. Its own unit test calls the function directly, so dropping the second
  argument at the call site redacts nothing and reddens nothing: measured, and
  the suite stayed green. That is the same shape as this file's other guards —
  a check that follows the code rather than the wiring goes quiet when the
  wiring changes.
*/
test("every call to safeMoveStorageDetail passes the store it must redact against", () => {
  const calls = FILES.flatMap((file) =>
    [...file.text.matchAll(/(?<!function\s)\bsafeMoveStorageDetail\(([^)]*)\)/g)].map((match) => ({
      path: file.path,
      args: match[1],
    })),
  );
  assert.ok(calls.length >= 1, "no call to safeMoveStorageDetail found");
  const short = calls.filter(
    (call) => call.args.split(",").filter((part) => part.trim() !== "").length !== 2,
  );
  assert.deepEqual(short, []);
});

/*
  A LINK MAY NOT BE POINTED SOMEWHERE ITS OWN NOTE'S READERS CANNOT GO, AND
  THAT RULE IS ONE ARGUMENT AT ONE CALL SITE.

  `rewriteLinks` edits notes OTHER than the one that moved, and each keeps its
  own visibility. Without `allowTarget` it follows a move into a private folder
  and writes that path into every team-visible note that referenced it: the
  privacy engine answers `not found` for the note while a note the same reader
  may open spells out where it went. That was proved end to end against the
  real tools before `allowTarget` existed.

  `canSee` higher up in `rewriteReferences` does not catch it, which is why a
  reader of the call site cannot see the danger: it asks which notes THIS
  CALLER may scan, and the caller is the owner, who may scan everything. It
  says nothing about who reads those notes afterwards.

  Nothing else in the gateway calls `rewriteLinks` today. This guard is for the
  second caller, and for the day somebody simplifies the argument list.
*/
test("every call to rewriteLinks passes the predicate that stops it publishing a path", () => {
  const calls = FILES.flatMap((file) =>
    [...file.text.matchAll(/(?<!function\s)\brewriteLinks\(([\s\S]*?)\)\s*;/g)].map((match) => ({
      path: file.path,
      args: match[1],
    })),
  );
  assert.ok(calls.length >= 1, "no call to rewriteLinks found");
  const unguarded = calls.filter((call) => !/\ballowTarget\b/.test(call.args)).map((call) => call.path);
  assert.deepEqual(unguarded, []);
});

/*
  The queue consumer has two channels out to the control plane and both must
  stay path-free.

  The progress channel is kept honest by `moveProgressFromText`'s integer
  regex. The failure channel forwarded the tool's whole text, which a dozen of
  `materialize.js`'s throws interpolate a source or destination path into, so a
  customer's note path left the bucket and was stored where the control plane
  only truncates it. `moveErrorForControlPlane` takes the paths out.

  Asserted over the source because the unit test for that function calls it
  directly: dropping it at the call site redacts nothing and reddens nothing.
  That has now been the shape of four separate guards in this file.
*/
test("the queue consumer sanitises a move failure before the control plane sees it", () => {
  const consumer = FILES.find((file) => file.path === "moves/queueConsumer.js");
  assert.ok(consumer, "moves/queueConsumer.js not found");
  assert.match(consumer.text, /\berror = moveErrorForControlPlane\(/);
  // Only assignments that carry the TOOL'S TEXT are the hazard. A fixed string
  // of our own (`error = "unsupported gateway job"`) names no path, and a first
  // draft of this guard flagged it — caught because the clean tree went red,
  // which is the reason to sabotage a new guard in both directions.
  const unsanitised = [...consumer.text.matchAll(/^\s*error = ([^;]+);/gm)]
    .map((match) => match[1].trim())
    .filter((rhs) => /\btext\b/.test(rhs) && !/\bmoveErrorForControlPlane\(/.test(rhs));
  assert.deepEqual(unsanitised, []);
});

/*
  V1'S WHOLE-INDEX QUERY DOES NOT NARROW THE CORPUS, SO WIRING IT WITHOUT THE
  NARROWING IS THE LEAK, NOT A STYLE SLIP.

  `searchIndex(index, query)` in `search/query.js` takes no visibility
  predicate. It reads `N`, every term's `df`, `avglen` and each doc's `rank`
  over whatever index it is handed, and `visibleIndex`'s doc comment enumerates
  the three things a team caller then learns about notes it cannot read — which
  term expands, and the result order twice over. The narrowing is a SEPARATE
  function the caller is trusted to apply first.

  Today nothing under `src/` calls either one: the live paths narrow elsewhere
  (`shardQuery.js`'s `collectShardCandidates` gathers over visible docs only
  and omits PageRank; `d1/query.js` queries one tier's table), and v1's query
  half is reached from tests alone. So the hazard is a second caller, and it
  arrives looking harmless — `searchIndex(index, query)` is the obvious call to
  make and reads as complete.

  The rule is therefore the pairing rather than the absence: a module that
  queries the v1 index must also narrow it. A module that does neither is not
  the subject. Wiring v1 back in correctly keeps this green; wiring it in bare
  reddens it.

  Two bounds, stated because an overclaimed guard is worse than a narrow one:
  the pairing is per FILE, so a module that narrows one index and queries
  another bare would pass, and a call made through an alias (`const q =
  searchIndex`) is invisible to a text scan. Both are the shape guard 1 in this
  file already accepts. What this does catch is the direct call, which is the
  one somebody writes.

  Comment lines are dropped before scanning, in both directions and for
  opposite reasons. This very comment names `searchIndex(` with its parenthesis
  — scanning prose would redden `query.js` for describing itself — and, the way
  that actually matters, a file could otherwise satisfy the NARROWING half with
  a doc comment that merely mentions `visibleIndex(...)` while its code calls
  the query bare. The second is the hole; the first is how it was noticed.
*/
test("a gateway module that queries the v1 index also narrows it first", () => {
  // Non-vacuity anchor. The pairing below is an empty-set assertion over a
  // scan that matches nothing today, so a rename or deletion of either
  // function would make it true for the wrong reason, permanently and
  // silently. These two lines are what notice.
  const queryModule = FILES.find((file) => file.path === "search/query.js");
  assert.ok(queryModule, "search/query.js not found");
  assert.match(queryModule.text, /^export function searchIndex\(/m);
  assert.match(queryModule.text, /^export function visibleIndex\(/m);

  // Code only: a line whose first non-space character opens or continues a
  // comment is not a call site. Dropping whole lines rather than stripping
  // `/* */` spans keeps a real call on a line that merely contains a `//`
  // inside a string from being thrown away with it.
  const code = (text) =>
    text
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
      .join("\n");

  // `store.searchIndex` is a different thing entirely — the control plane's
  // descriptor for the per-context search database — and appears across the
  // gateway. Only a CALL counts, so the property access is excluded by the
  // lookbehind, as is the definition itself.
  const CALLS_QUERY = /(?<![.\w])(?<!function\s)searchIndex\(/;
  const CALLS_NARROWING = /(?<![.\w])(?<!function\s)visibleIndex\(/;
  const unnarrowed = FILES.map((file) => ({ path: file.path, text: code(file.text) }))
    .filter((file) => CALLS_QUERY.test(file.text) && !CALLS_NARROWING.test(file.text))
    .map((file) => file.path);
  assert.deepEqual(unnarrowed, []);
});
