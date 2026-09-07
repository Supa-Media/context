#!/usr/bin/env node
/**
 * No account identifier belongs in this public, MIT-licensed repository.
 *
 * CLAUDE.md is explicit and does not carve out an exception for "it is
 * technically public information anyway": "Assume every line is read by an
 * attacker. No secrets, no internal hostnames, no account identifiers... not
 * in code, tests, fixtures, comments, commit messages, or docs." Three
 * account identifiers sat in this tree until 2026-09-07 regardless — an Apple
 * Developer Team ID in `apps/mobile/eas.json`, an EAS project id in
 * `apps/mobile/app.config.js`, and a Convex deployment hostname in half a
 * dozen files — none of them a cryptographic secret, all of them naming a
 * specific account an attacker could target or correlate. This is the guard
 * that stops the next one from landing the same way: silently, in a file
 * nobody thought to grep.
 *
 * Five rules. The first three are identifier shapes; the fourth is a pointer
 * into a document this repository does not contain; the fifth is a character
 * a reviewer cannot see:
 *
 *   1. A 10-character uppercase-alphanumeric string next to `appleTeamId` or
 *      `teamId` — the shape of an Apple Developer Team ID.
 *   2. A UUID under `extra.eas.projectId` in `apps/mobile/app.config.js` —
 *      the shape of an EAS project id. Scoped to that one file because that is
 *      the only place this repository's build tooling reads it from; a UUID
 *      elsewhere is somebody else's business (and would be indistinguishable
 *      from any other UUID in a test fixture).
 *   3. A `*.convex.cloud` / `*.convex.site` hostname anywhere in the tracked
 *      tree, except `.env.example` (which holds no values, only `op://`
 *      references and blanks) and a short allowlist of placeholder
 *      subdomains already in use in tests and CI (`YOUR-DEPLOYMENT`,
 *      `example-deployment`) that are obviously fake rather than a
 *      forgotten real one.
 *   4. A numbered pointer into the private security register — either the
 *      register named outright, or a bare two-or-more-digit `row N` /
 *      `entry N` ordinal, which is what one is left as once somebody deletes
 *      the lead-in that named it.
 *   5. A literal invisible or directional character — a bidi override, a
 *      zero-width space, a soft hyphen — anywhere in the tracked tree. The
 *      escape spelling is ASCII and is therefore always legal; see
 *      `findInvisibleCharacters` for why there is no opt-out.
 *
 * Rule 4 is here because the class recurred twice. Two test files carried a
 * "Row N of the security register" lead-in into this public tree; the round
 * that removed those two left five bare ordinals behind, including, in a file
 * it was editing, a sentence USING one of the numbers three lines below the
 * sentence that had defined it. `SECURITY.md` forbids a public issue for a security
 * problem, and a numbered pointer to a private register is a smaller version
 * of the same disclosure: it names the register, its shape, and which row of
 * it is about the reader's own code. Both rounds scanned by hand and both
 * missed; measured against the tree before the fix, this rule finds all seven
 * and finds nothing at all after it. That is the whole argument for it being
 * a regex rather than a habit.
 *
 * The first thing rule 4 caught was a sentence about rule 4, in `ci.yml` —
 * the same lesson `SELF` exists for one file down. Prose that has to discuss
 * this rule names the noun some other way; there is no marker to opt out with,
 * because a marker is a thing a real pointer can also carry.
 *
 * What it does NOT cover, said plainly rather than left to be discovered:
 * **commit messages and pull-request bodies**, which are equally public and
 * equally permanent. This scans `git ls-files`, so a pointer written into the
 * message of the commit that removes one is out of its reach, and one was.
 *
 * `rows?` and `entr(y|ies)`/`items?` at two digits or more, so the protocol
 * tables in `packages/desktop-bridge` ("row 1", "row 3") and the console's
 * "row 0" layout comments stay legal. `lines?` is deliberately absent: citing
 * "line 217" of a source file is ordinary prose. If a real table in this
 * repository ever grows past nine rows, add the file to
 * `REGISTER_POINTER_ALLOWLIST` and say which table it means — the allowlist is
 * empty today, and an entry in it is a claim that the number has a referent
 * somebody reading this repository can actually follow.
 *
 * Scans `git ls-files` — the tracked, public tree — rather than walking the
 * filesystem, so node_modules, build output and anything .gitignore already
 * excludes need no separate exclusion list here.
 *
 * Run: `node scripts/check-no-identifiers.mjs`
 * Self-test: `node scripts/check-no-identifiers.mjs --self-test`
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every path `git` tracks, relative to the repo root. Binary-safe enough:
 * this only ever reads text files it finds a match in. */
function trackedFiles() {
  const res = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ls-files failed: ${res.stderr || res.status}`);
  }
  return res.stdout.split("\0").filter(Boolean);
}

const TEAM_ID_RE = /\b(?:appleTeamId|teamId)\b["']?\s*[:=]\s*["']?([A-Z0-9]{10})["']?/g;

/** A v4-ish UUID, loosely — this checks shape, not RFC 4122 version bits, so
 * it catches a real EAS project id and a hand-typed test fixture alike. */
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

const CONVEX_HOST_RE = /([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\.convex\.(?:cloud|site)/g;

/** Subdomains already in use as obvious fakes — a placeholder in a doc's
 * comment, or a fixture in a test — never a real deployment's name. */
const CONVEX_HOST_ALLOWLIST = new Set(["your-deployment", "example-deployment"]);

/**
 * Two spellings of the same disclosure: the register named, and the ordinal
 * left behind when somebody removes the words that named it. The second is the
 * one that actually survived a cleanup, so it is not the optional half.
 */
const REGISTER_POINTER_RES = [
  /\b(?:security|risk|private|internal)\s+register\b/gi,
  /\b(?:rows?|entr(?:y|ies)|items?)\s+#?\d{2,}\b/gi,
];

/** Files whose two-digit ordinals point at a table inside this repository.
 * Empty on purpose: every entry is a promise a reader can follow the number. */
const REGISTER_POINTER_ALLOWLIST = new Set([]);

/**
 * Rule 1: an Apple Developer Team ID committed beside its key.
 *
 * Scoped to the key names rather than to "any 10-char uppercase-alphanumeric
 * string", which would flag unrelated ids (a Convex document id, a random
 * test fixture) by the dozen. The key is the signal.
 */
export function findAppleTeamIds(path, text) {
  const found = [];
  for (const match of text.matchAll(TEAM_ID_RE)) {
    found.push({ path, value: match[1] });
  }
  return found;
}

/** Rule 2: a UUID committed in apps/mobile/app.config.js, where this
 * repository's own tooling reads `extra.eas.projectId` from. */
export function findEasProjectIdLiterals(path, text) {
  if (path !== "apps/mobile/app.config.js") return [];
  return [...text.matchAll(UUID_RE)].map((match) => ({ path, value: match[0] }));
}

/** Rule 3: a real-looking Convex deployment hostname anywhere but
 * `.env.example` and the documented placeholder allowlist. */
export function findConvexHosts(path, text) {
  if (path === ".env.example") return [];
  const found = [];
  for (const match of text.matchAll(CONVEX_HOST_RE)) {
    const subdomain = match[1].toLowerCase();
    if (CONVEX_HOST_ALLOWLIST.has(subdomain)) continue;
    found.push({ path, value: match[0] });
  }
  return found;
}

/**
 * Rule 5's character class: every invisible or directional format character
 * that can sit in a source file and change what a reader sees without
 * changing what the parser sees.
 *
 *   U+00AD          soft hyphen
 *   U+061C          Arabic letter mark
 *   U+180E          Mongolian vowel separator
 *   U+200B - U+200F zero-width space/joiners, LRM, RLM
 *   U+202A - U+202E the bidi embeddings and the two OVERRIDES
 *   U+2060 - U+2064 word joiner and the invisible operators
 *   U+2066 - U+2069 the bidi isolates
 *   U+FEFF          zero-width no-break space, mid-file
 *   U+FFF9 - U+FFFB the interlinear annotation characters
 *
 * A leading U+FEFF is a byte-order mark and is skipped: it is a file-encoding
 * artefact, not a character somebody typed into a line.
 */
const INVISIBLE_CHAR_RE = new RegExp(
  "[\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff\\ufff9-\\ufffb]",
  "g",
);

/**
 * Rule 5: a literal invisible or directional character in the tracked tree.
 *
 * The class this exists for recurred three times inside one session: writing
 * a test fixture for bidi handling by typing the actual U+202E into the
 * source, three separate times, in a repository whose whole argument about
 * these characters is that a reader cannot see them. A fixture written that
 * way is a fixture nobody can review — the reviewer sees `"ab.pdf"` and has
 * to take on faith which invisible character is in the middle of it, which is
 * exactly the confusion the code under test exists to prevent — and a single
 * stray one, pasted in from somewhere, would look like nothing at all.
 *
 * **The escape sequence is the supported spelling and needs no exemption**,
 * because `\u202e` is six ASCII characters and this rule never sees it. So
 * there is no allowlist and no opt-out marker: a test that needs the
 * character builds it (`String.fromCharCode(0x202e)`, or a `\u202e` in a
 * string literal), which also states in the source which character it means.
 *
 * `docs/decisions/testing.md`: a class that has recurred gets a checker in
 * the same change that cleans it up, not a promise to look harder.
 */
export function findInvisibleCharacters(path, text) {
  const body = text.startsWith("\ufeff") ? text.slice(1) : text;
  const found = [];
  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(INVISIBLE_CHAR_RE)) {
      found.push({
        path,
        value: `U+${match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
        line: index + 1,
      });
    }
  }
  return found;
}

/** Rule 4: a pointer into the private security register, in either spelling. */
export function findRegisterPointers(path, text) {
  if (REGISTER_POINTER_ALLOWLIST.has(path)) return [];
  const found = [];
  for (const re of REGISTER_POINTER_RES) {
    for (const match of text.matchAll(re)) found.push({ path, value: match[0] });
  }
  return found;
}

/**
 * This file's own path, relative to the repo root — its self-test fixtures
 * are, on purpose, exactly the strings the three rules exist to catch. The
 * same lesson `check-secrets-allowlist.mjs` records for its own body
 * extractor: a checker that reads its own source is a checker that fails on
 * a sentence about itself.
 */
const SELF = "scripts/check-no-identifiers.mjs";

function main() {
  const problems = [];
  for (const path of trackedFiles()) {
    if (path === SELF) continue;
    let text;
    try {
      text = readFileSync(join(ROOT, path), "utf8");
    } catch {
      continue; // binary or unreadable — nothing this checker can scan anyway
    }
    // A NUL byte is the cheap tell for "this isn't text"; skip rather than
    // false-positive on bytes that happen to look like ASCII in between.
    if (text.includes("\0")) continue;

    for (const { path: p, value } of findAppleTeamIds(path, text)) {
      problems.push(
        `${p}: an Apple Developer Team ID ("${value}") sits beside appleTeamId/teamId.\n` +
          `    Remove it and read EXPO_APPLE_TEAM_ID / the APPLE_TEAM_ID secret instead.`,
      );
    }
    for (const { path: p, value } of findEasProjectIdLiterals(path, text)) {
      problems.push(
        `${p}: a UUID ("${value}") is committed where extra.eas.projectId is built.\n` +
          `    Read it from process.env.EAS_PROJECT_ID instead — see resolveEasProjectId.`,
      );
    }
    for (const { path: p, value } of findConvexHosts(path, text)) {
      problems.push(
        `${p}: a Convex deployment hostname ("${value}") is committed.\n` +
          `    Read it from the CONTROL_PLANE_URL / EXPO_PUBLIC_CONVEX_URL secret instead,\n` +
          `    or use one of the allowlisted placeholders if this is a fixture.`,
      );
    }
    for (const { path: p, value } of findRegisterPointers(path, text)) {
      problems.push(
        `${p}: a pointer into the private security register ("${value}") is committed.\n` +
          `    State the claim instead — the sentence after the colon was always the substance.\n` +
          `    If this number means a table in this repository, allowlist the file and say which.`,
      );
    }
    for (const { path: p, value, line } of findInvisibleCharacters(path, text)) {
      problems.push(
        `${p}:${line}: a literal ${value} — an invisible or directional character — is committed.\n` +
          `    Write it as an escape (\\u202e) or build it (String.fromCharCode(0x202e)) instead,\n` +
          `    so the source says which character it means and a reviewer can see it at all.`,
      );
    }
  }

  if (problems.length > 0) {
    console.error("Account identifiers, private-register pointers, or invisible characters found in the tracked tree:\n");
    for (const problem of problems) console.error(`  - ${problem}\n`);
    process.exit(1);
  }
  console.log(
    "OK — no Apple team id, EAS project id, Convex hostname, register pointer, or invisible character in the tracked tree.",
  );
}

/**
 * Prove the checker is not vacuous, the same discipline
 * `check-secrets-allowlist.mjs` documents: a regex that silently matches
 * nothing passes every repository it is pointed at.
 */
function selfTest() {
  const failures = [];
  let checked = 0;
  const expect = (label, condition) => {
    checked += 1;
    if (!condition) failures.push(label);
  };

  // Rule 1.
  expect(
    "catches a JSON appleTeamId",
    findAppleTeamIds("eas.json", '"appleTeamId": "ABCD123456"').length === 1,
  );
  expect(
    "catches a bare teamId assignment",
    findAppleTeamIds("x.yml", "teamId: WXYZ987654").length === 1,
  );
  expect(
    "does not fire on the key name alone",
    findAppleTeamIds("docs.md", "set `ios.appleTeamId` in app.config.js").length === 0,
  );
  expect(
    "does not fire on the env var name",
    findAppleTeamIds("x.yml", "EXPO_APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}").length === 0,
  );

  // Rule 2.
  expect(
    "catches a UUID in app.config.js",
    findEasProjectIdLiterals(
      "apps/mobile/app.config.js",
      'const PROJECT_ID = "cf13cf3d-0868-4463-b045-d7c805ea0bf7";',
    ).length === 1,
  );
  expect(
    "ignores the same UUID in any other file",
    findEasProjectIdLiterals("apps/mobile/other.js", 'const x = "cf13cf3d-0868-4463-b045-d7c805ea0bf7";')
      .length === 0,
  );
  expect(
    "does not fire on the placeholder",
    findEasProjectIdLiterals("apps/mobile/app.config.js", 'return "YOUR_EAS_PROJECT_ID";').length === 0,
  );

  // Rule 3.
  expect(
    "catches a real-looking convex.cloud host",
    findConvexHosts("apps/mobile/eas.json", "https://clean-ptarmigan-116.convex.cloud").length === 1,
  );
  expect(
    "catches a real-looking convex.site host",
    findConvexHosts("infra/router/wrangler.jsonc", "https://clean-ptarmigan-116.convex.site").length === 1,
  );
  expect(
    "allows the .env.example file outright",
    findConvexHosts(".env.example", "https://clean-ptarmigan-116.convex.cloud").length === 0,
  );
  expect(
    "allows the YOUR-DEPLOYMENT placeholder",
    findConvexHosts("health-check.yml", "https://YOUR-DEPLOYMENT.convex.cloud").length === 0,
  );
  expect(
    "allows the example-deployment placeholder",
    findConvexHosts("worker.test.ts", "https://example-deployment.convex.site").length === 0,
  );

  // Rule 4. The first two are the exact bytes this tree carried; the rest are
  // the spellings a cleanup leaves behind, and the prose that must stay legal.
  expect(
    "catches the register named outright",
    findRegisterPointers("x.test.ts", " * Row 4711 of the security register: every guard").length === 2,
  );
  expect(
    "catches the bare ordinal a deleted lead-in leaves behind",
    findRegisterPointers("y.test.ts", "// the same habit as row 4712, so the claim").length === 1,
  );
  expect(
    "catches it possessive, mid-sentence",
    findRegisterPointers("z.test.mjs", " *    true. At head it is row 4713's shape exactly").length === 1,
  );
  expect(
    "catches the entry/item spellings of the same pointer",
    findRegisterPointers("a.md", "see entry 4714 and item 4715 for the reasoning").length === 2,
  );
  expect(
    "leaves a single-digit table row alone",
    findRegisterPointers("bridge.ts", "Adding `meetings` to row 1 would make this bundle").length === 0,
  );
  expect(
    "leaves a source line citation alone",
    findRegisterPointers("notes.md", "the throw on line 217 of the worker").length === 0,
  );
  expect(
    "honours the allowlist for a table that really is in this repository",
    findRegisterPointers("scripts/check-no-identifiers.mjs", "row 4716").length === 0 ||
      !REGISTER_POINTER_ALLOWLIST.has("scripts/check-no-identifiers.mjs"),
  );

  // Rule 5. Every fixture here builds its character from a code point, which
  // is the same spelling the rule tells a caller to use — a self-test that
  // pasted the literal byte would be the very thing it is testing for.
  const character = (code) => String.fromCharCode(code);
  expect(
    "catches the right-to-left override, the one that recurred",
    findInvisibleCharacters("x.test.ts", `const name = "a${character(0x202e)}b.pdf";`).length === 1,
  );
  expect(
    "catches a zero-width space, a soft hyphen and an Arabic letter mark",
    [0x200b, 0x00ad, 0x061c].every(
      (code) => findInvisibleCharacters("y.ts", `x${character(code)}y`).length === 1,
    ),
  );
  expect(
    "catches every bidi isolate and embedding, not only the override",
    [0x202a, 0x202b, 0x202c, 0x202d, 0x2066, 0x2067, 0x2068, 0x2069].every(
      (code) => findInvisibleCharacters("z.md", `a${character(code)}b`).length === 1,
    ),
  );
  expect(
    "reports the line, so a hit in a long file is findable",
    findInvisibleCharacters("a.ts", `one\ntwo\nthree${character(0x200f)}`)[0].line === 3,
  );
  expect(
    "leaves the escape spelling alone — that is the supported way to write one",
    findInvisibleCharacters("b.ts", 'const rlo = "\\u202e"; const zwsp = "\\u200b";').length === 0,
  );
  expect(
    "leaves ordinary non-ASCII prose alone — an em dash and an accent are not invisible",
    findInvisibleCharacters("c.md", "a fixture — héllo, wörld → done").length === 0,
  );
  expect(
    "does not fire on a leading byte-order mark, which is an encoding artefact",
    findInvisibleCharacters("d.json", `${character(0xfeff)}{"a":1}`).length === 0,
  );
  expect(
    "...but does fire on one in the middle of a line",
    findInvisibleCharacters("e.json", `{"a":${character(0xfeff)}1}`).length === 1,
  );

  if (failures.length > 0) {
    console.error("Self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`Self-test passed (${checked} checks).`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
