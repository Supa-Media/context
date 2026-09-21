/**
 * THE ARCHIVE SOMEBODY LEAVES WITH.
 *
 * Non-negotiable #1 says the exit is never gated and never degraded, and until
 * now the console had no download at all — the only way to get a note out was
 * to open the bucket somewhere else, which asks somebody to hold cloud
 * credentials to read their own writing.
 *
 * So these checks are about the format rather than about the button: an
 * archive is the artefact that has to still work on a machine that has never
 * heard of this product, months after somebody cancelled. Every one of them is
 * read back with `zlib`'s own unzipper rather than against the bytes this
 * module happens to write, because a fixture written from the implementation's
 * assumptions is the failure this repository has already recorded twice.
 */

import { describe, expect, test } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZip, crc32, downloadName, zipPath, ZipTooLarge } from "../features/console/files/zip";

const utf8 = (text: string) => new TextEncoder().encode(text);

/**
 * Read the archive back with something that is not this module.
 *
 * `unzip` is on the runner and is the 1989 format's reference reader, which is
 * the point: a test that parsed these bytes with a parser written beside the
 * writer would agree with the writer about a mistake they both make.
 */
function extract(archive: Uint8Array): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  try {
    const file = join(dir, "archive.zip");
    writeFileSync(file, archive);
    try {
      execFileSync("unzip", ["-q", file, "-d", join(dir, "out")], { stdio: "pipe" });
    } catch (error) {
      /*
        `unzip` exits 1 on a **valid** archive with no entries in it, with
        "zipfile is empty" on stderr. That is its warning, not a complaint
        about the bytes — the end-of-central-directory record it read is the
        one this module wrote. Every other non-zero exit is a real failure and
        is rethrown, so this cannot swallow a malformed archive.
      */
      const said = String((error as { stderr?: Buffer }).stderr ?? "");
      if (!said.includes("zipfile is empty")) throw error;
      return {};
    }
    const listed = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.trim() !== "");
    const out: Record<string, string> = {};
    for (const name of listed) {
      out[name] = readFileSync(join(dir, "out", name), "utf8");
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a folder as one file", () => {
  test("every note comes back out, under its own path", () => {
    const archive = buildZip([
      { path: "1-projects/a.md", bytes: utf8("# A\n\nfirst\n") },
      { path: "1-projects/deep/b.md", bytes: utf8("# B\n") },
    ]);
    expect(extract(archive)).toEqual({
      "1-projects/a.md": "# A\n\nfirst\n",
      "1-projects/deep/b.md": "# B\n",
    });
  });

  test("a name with an accent and an emoji survives the round trip", () => {
    /*
      The UTF-8 flag, which is one bit and the difference between a note called
      `café 🌍.md` and one called `cafÃ© ð.md` on the machine somebody opens
      the archive on. It is the kind of thing nobody notices until the archive
      is the only copy.
    */
    const archive = buildZip([{ path: "3-resources/café 🌍.md", bytes: utf8("hello") }]);
    expect(extract(archive)).toEqual({ "3-resources/café 🌍.md": "hello" });
  });

  test("an empty note is an entry, not a gap", () => {
    const archive = buildZip([
      { path: "a.md", bytes: utf8("") },
      { path: "b.md", bytes: utf8("written") },
    ]);
    expect(extract(archive)).toEqual({ "a.md": "", "b.md": "written" });
  });

  test("an empty archive is still a valid archive", () => {
    // A folder holding nothing this caller can see. Refusing to write the file
    // would be a download that silently did nothing.
    expect(extract(buildZip([]))).toEqual({});
  });

  test("the checksums are the ones an extractor computes", () => {
    // Belt for the buckle above: `unzip` verifies CRCs and fails the extract
    // on a bad one, so the round trips already depend on this — but a wrong
    // `crc32` is worth failing by name rather than as "unzip exited 2".
    expect(crc32(utf8(""))).toBe(0);
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
    expect(crc32(utf8("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });
});

describe("what an archive may not carry", () => {
  test("a path cannot climb out of the folder it is extracted into", () => {
    // Every zip-slip advisory opens by quoting somebody who reasoned that
    // their own writer could not produce one.
    expect(zipPath("../../etc/passwd")).toBe("etc/passwd");
    expect(zipPath("/absolute/note.md")).toBe("absolute/note.md");
    expect(zipPath("a/../../b.md")).toBe("a/b.md");
    expect(zipPath("windows\\style\\note.md")).toBe("windows/style/note.md");
  });

  test("...and the archive itself is written with the cleaned path", () => {
    expect(Object.keys(extract(buildZip([{ path: "/1-projects/../a.md", bytes: utf8("x") }])))).toEqual([
      "1-projects/a.md",
    ]);
  });

  test("an entry with no usable name is refused rather than written", () => {
    expect(() => buildZip([{ path: "../..", bytes: utf8("x") }])).toThrow(ZipTooLarge);
  });
});

describe("the name the file is saved under", () => {
  test("a note keeps its own name and loses its extension", () => {
    expect(downloadName("1-projects/plan.md", ".md")).toBe("plan.md");
    expect(downloadName("1-projects/old", ".zip")).toBe("old.zip");
  });

  test("characters an operating system refuses become dashes", () => {
    // An archive that will not save is not an exit.
    expect(downloadName('1-projects/a:b*c?.md', ".md")).toBe("a-b-c-.md");
  });

  test("a path with no leaf still names a file", () => {
    expect(downloadName("", ".zip")).toBe("context.zip");
    expect(downloadName("/", ".zip")).toBe("context.zip");
  });
});
