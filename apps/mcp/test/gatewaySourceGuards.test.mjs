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

test("nothing outside encryption.js imports or calls what could open a passphrase note", () => {
  const offenders = [];
  for (const file of FILES) {
    if (file.path === "encryption.js") continue;
    for (const imported of file.text.matchAll(/import\s*{([^}]*)}\s*from\s*"[^"]*\/encryption\.js"/g)) {
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
