#!/usr/bin/env node
/**
 * Offline decryptor CLI — the executable half of
 * `docs/decisions/encryption.md`'s promise that "you can still read your
 * notes" is something somebody can run, with no gateway and no control plane
 * anywhere in the path.
 *
 * Usage:
 *   context-decrypt <keys.json> <note.md> [out.md]
 *   context-decrypt <keys.json> <bucket-dir> [out-dir]
 *
 * `keys.json` is what `export_encryption_keys` (or the console's export
 * action) produced. The second argument is either one note or a directory —
 * the customer's whole exported bucket, or a folder within it. Given a
 * directory, every file is walked: an encrypted `.md` note is decrypted into
 * the mirrored output tree, and everything else — plaintext notes,
 * `privacy.md`, attachments, `.audit/` — is copied through unchanged, because
 * an encrypted note is still a file at its own path beside everything that
 * was never encrypted in the first place.
 *
 * Given one note with no output path, the plaintext goes to stdout, so
 * `context-decrypt keys.json note.md | less` works without a second file.
 * Given a directory with no output path, `<dir>-decrypted` is used.
 *
 * Exit codes: 0 on success, 1 for a usage error, 2 if any note failed to
 * decrypt (the run still writes everything it could and reports what did
 * not, rather than stopping at the first failure — a partial recovery is
 * better than none).
 */

import { readFile, writeFile, mkdir, stat, readdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decryptNote, isEncryptedNote, parseKeyExport } from "../src/format.js";

function usageError(message) {
  process.stderr.write(`${message}\n\nUsage: context-decrypt <keys.json> <note.md|bucket-dir> [output]\n`);
  process.exit(1);
}

async function loadKeys(keysPath) {
  let raw;
  try {
    raw = await readFile(keysPath, "utf8");
  } catch (error) {
    usageError(`could not read ${keysPath}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    usageError(`${keysPath} is not valid JSON`);
  }
  try {
    return parseKeyExport(parsed);
  } catch (error) {
    usageError(`${keysPath}: ${error.message}`);
  }
}

/** Every regular file under `dir`, as paths relative to `dir`. */
async function walk(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walk(join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

async function decryptOne(text, keys, label) {
  if (!isEncryptedNote(text)) return { changed: false, text };
  try {
    return { changed: true, text: await decryptNote(text, keys) };
  } catch (error) {
    process.stderr.write(`could not decrypt ${label}: ${error.message}\n`);
    return { changed: false, text: null, failed: true };
  }
}

async function main() {
  const [, , keysPath, inputPath, outputArg] = process.argv;
  if (!keysPath || !inputPath) {
    usageError("both a keys file and a note or bucket directory are required");
    return;
  }
  const { keys } = await loadKeys(keysPath);

  let inputStat;
  try {
    inputStat = await stat(inputPath);
  } catch (error) {
    usageError(`could not read ${inputPath}: ${error.message}`);
    return;
  }

  if (inputStat.isFile()) {
    const text = await readFile(inputPath, "utf8");
    const result = await decryptOne(text, keys, inputPath);
    if (result.failed) {
      /*
        NOTHING IS WRITTEN AND NOTHING IS PRINTED — the same rule the
        directory walk below applies, which is where it was written down
        first: "a note this run could not open must not silently become
        indistinguishable, in the output, from one that was never encrypted at
        all."

        The single-file path used to fall through to `result.text ?? text`,
        which wrote the envelope to the output path under a plaintext-looking
        name and announced it as "copied (already plaintext)" — and, with no
        output path, piped the ciphertext to stdout, so
        `context-decrypt keys.json note.md > note.txt` produced a file of
        base64 that looks like a recovered note until somebody opens it. The
        exit code was right; the bytes were not.
      */
      process.stderr.write(
        `nothing written for ${inputPath}: it is an encrypted note this key file does not open.\n`,
      );
      process.exitCode = 2;
      return;
    }
    const output = result.text ?? text;
    if (outputArg) {
      await mkdir(dirname(outputArg), { recursive: true });
      await writeFile(outputArg, output);
      process.stderr.write(
        `${result.changed ? "decrypted" : "copied (already plaintext)"}: ${inputPath} -> ${outputArg}\n`,
      );
    } else {
      process.stdout.write(output);
    }
    return;
  }

  if (!inputStat.isDirectory()) {
    usageError(`${inputPath} is neither a file nor a directory`);
    return;
  }

  const outDir = outputArg || `${inputPath.replace(/\/+$/, "")}-decrypted`;
  const relPaths = await walk(inputPath);
  let decrypted = 0;
  let copied = 0;
  let failed = 0;
  for (const rel of relPaths) {
    const source = join(inputPath, rel);
    const destination = join(outDir, rel);
    await mkdir(dirname(destination), { recursive: true });
    if (!rel.endsWith(".md")) {
      await copyFile(source, destination);
      copied += 1;
      continue;
    }
    const text = await readFile(source, "utf8");
    const result = await decryptOne(text, keys, rel);
    if (result.failed) {
      failed += 1;
      // Left out of the output tree rather than copied as ciphertext under a
      // plaintext-looking `.md` name: a note this run could not open must not
      // silently become indistinguishable, in the output, from one that was
      // never encrypted at all.
      continue;
    }
    await writeFile(destination, result.text ?? text);
    if (result.changed) decrypted += 1;
    else copied += 1;
  }
  process.stderr.write(
    `${decrypted} note(s) decrypted, ${copied} file(s) copied through unchanged` +
      (failed ? `, ${failed} note(s) FAILED to decrypt (left out of ${outDir})` : "") +
      ` -> ${outDir}\n`,
  );
  if (failed > 0) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
