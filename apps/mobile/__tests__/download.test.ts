/**
 * GETTING A FOLDER OUT, INCLUDING THE PARTS THAT GO WRONG.
 *
 * The bound is the check that matters and it is the one a hand-test would
 * never reach: `readNotes` defers whatever does not fit its byte budget, so
 * following `deferred` is a loop, and a loop against a server is a console
 * that hangs if the server stops making progress. On the exit path, where the
 * whole promise is that somebody can leave, a hang is the failure.
 */

import { describe, expect, test } from "@jest/globals";
import {
  collectNotes,
  downloadNotice,
  pathsUnder,
  type ReadResult,
} from "../features/console/files/download";

const read = (path: string, text: string): ReadResult => ({
  path,
  outcome: "read",
  note: { text },
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("collecting a folder", () => {
  test("every note it can read is in the archive, in a stable order", async () => {
    const outcome = await collectNotes(["b.md", "a.md"], async (paths) =>
      paths.map((path) => read(path, `body of ${path}`)),
    );
    expect(outcome.entries.map((entry) => entry.path)).toEqual(["a.md", "b.md"]);
    expect(text(outcome.entries[0].bytes)).toBe("body of a.md");
    expect(outcome.missed).toEqual([]);
  });

  test("it asks in batches the server will accept", async () => {
    const asked: number[] = [];
    await collectNotes(
      Array.from({ length: 7 }, (_, index) => `n${index}.md`),
      async (paths) => {
        asked.push(paths.length);
        return paths.map((path) => read(path, "x"));
      },
      { batchSize: 3 },
    );
    expect(asked).toEqual([3, 3, 1]);
  });

  test("a deferred note is asked for again and lands", async () => {
    let round = 0;
    const outcome = await collectNotes(["a.md", "b.md"], async (paths) => {
      round += 1;
      if (round === 1) {
        return [read("a.md", "A"), { path: "b.md", outcome: "deferred" } as ReadResult];
      }
      return paths.map((path) => read(path, "B"));
    });
    expect(outcome.entries.map((entry) => entry.path)).toEqual(["a.md", "b.md"]);
    expect(outcome.missed).toEqual([]);
  });

  test("a server that defers for ever is stopped by the round making no progress", async () => {
    /*
      THE BOUND. Without it the console spins against a server that keeps
      answering `deferred` — a hang on the one path whose whole promise is
      that somebody can leave.

      "Progress" rather than a round count is the rule, because a round count
      alone would cut off a genuinely large folder partway through.
    */
    let calls = 0;
    const outcome = await collectNotes(["a.md", "b.md"], async (paths) => {
      calls += 1;
      return paths.map((path) => ({ path, outcome: "deferred" }) as ReadResult);
    });
    expect(calls).toBe(1);
    expect(outcome.entries).toEqual([]);
    expect(outcome.missed.sort()).toEqual(["a.md", "b.md"]);
  });

  test("a note that cannot be read is left out and counted, not fatal", async () => {
    // A folder of two hundred notes must not be undeliverable because of one.
    const outcome = await collectNotes(["a.md", "locked.md"], async (paths) =>
      paths.map((path) =>
        path === "locked.md"
          ? ({ path, outcome: "error", code: "FILE_NOT_FOUND", message: "gone" } as ReadResult)
          : read(path, "A"),
      ),
    );
    expect(outcome.entries.map((entry) => entry.path)).toEqual(["a.md"]);
    expect(outcome.missed).toEqual(["locked.md"]);
  });

  test("a path the server never mentions is counted rather than retried for ever", async () => {
    const outcome = await collectNotes(["a.md", "silent.md"], async () => [read("a.md", "A")]);
    expect(outcome.missed).toEqual(["silent.md"]);
  });
});

describe("which notes a folder download is about", () => {
  test("everything under the folder, and nothing beside it", () => {
    const all = [
      "1-projects/a.md",
      "1-projects/deep/b.md",
      "1-projects-other/c.md",
      "2-areas/d.md",
    ];
    expect(pathsUnder(all, "1-projects")).toEqual(["1-projects/a.md", "1-projects/deep/b.md"]);
    // The sibling whose name merely starts the same way is the one a prefix
    // match gets wrong, and it would put somebody else's folder in the archive.
    expect(pathsUnder(all, "1-projects")).not.toContain("1-projects-other/c.md");
  });

  test("a trailing slash means the same folder", () => {
    expect(pathsUnder(["a/b.md"], "a/")).toEqual(["a/b.md"]);
  });

  test("the root is the whole context, which is what the exit promise names", () => {
    // Non-negotiable #1: "downloading everything ... is free, identical on
    // both plans, and still works after they cancel". The root breadcrumb is
    // where somebody asks for it, and a prefix match on `""` would have
    // produced an empty archive with nothing saying why.
    const all = ["index.md", "1-projects/a.md", "2-areas/b.md"];
    expect(pathsUnder(all, "")).toEqual(all);
    expect(pathsUnder(all, "/")).toEqual(all);
  });
});

describe("what the person is told", () => {
  test("a complete archive says how much is in it", () => {
    expect(downloadNotice("folder", 12, 0)).toBe("Downloaded 12 notes.");
    expect(downloadNotice("folder", 1, 0)).toBe("Downloaded 1 note.");
  });

  test("a short archive says so, because nobody finds out later", () => {
    // The worst outcome on an exit path is an archive that is quietly
    // incomplete: the person only learns when the bucket is already gone.
    expect(downloadNotice("folder", 10, 2)).toBe(
      "Downloaded 10 notes; 2 could not be read and are not in the archive.",
    );
    expect(downloadNotice("folder", 10, 1)).toBe(
      "Downloaded 10 notes; 1 could not be read and is not in the archive.",
    );
  });
});
