/**
 * A half-written scaffold in a keyed workspace is finished, not refused: its
 * notes are listed at `notes/<id>.md`, which no layout names, and are ours
 * when every id key is a layout note that reads back by name, byte for byte
 * (`hasForeignContent`, `lib/scaffold/detect.ts`). One note more is somebody's,
 * and the resume refuses.
 *
 * Sabotage: drop the `keyed && found === NOTE_ID_PREFIX` branch and the first
 * case fails (the `notes/` prefix reads as foreign).
 */

import { describe, expect, test } from "vitest";
import { hasForeignContent } from "../functions/lib/scaffold/detect";
import type { ScaffoldStore } from "../functions/lib/scaffold/store";

const FILES = [
  { key: "privacy.md", body: "rules" },
  { key: "index.md", body: "# Home\n" },
  { key: "inbox/about.md", body: "# Inbox\n" },
];

/** A keyed store: `byName` is what the tree serves by name, `raw` the bucket's keys. */
function keyedStore(byName: Record<string, string>, raw: string[]): ScaffoldStore {
  const object = (body: string) => ({
    etag: "e",
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  });
  return {
    get: async (key) => (key in byName ? object(byName[key]) : null),
    put: async () => null,
    list: async ({ prefix = "", delimiter } = {}) => {
      const under = raw.filter((key) => key.startsWith(prefix)).sort();
      if (delimiter === undefined) return { objects: under.map((key) => ({ key })) };
      const objects: { key: string }[] = [];
      const prefixes = new Set<string>();
      for (const key of under) {
        const rest = key.slice(prefix.length);
        const cut = rest.indexOf(delimiter);
        if (cut < 0) objects.push({ key });
        else prefixes.add(`${prefix}${rest.slice(0, cut + 1)}`);
      }
      return { objects, delimitedPrefixes: [...prefixes] };
    },
    keyedWorkspace: async () => true,
  };
}

describe("resuming a scaffold in a keyed workspace", () => {
  test("the notes it already wrote, at their id keys, are ours", async () => {
    const store = keyedStore(
      { "privacy.md": "rules", "index.md": "# Home\n" },
      ["privacy.md", "notes/0001.md"],
    );
    expect(await hasForeignContent(store, FILES)).toBe(false);
  });

  test("an id key no layout note accounts for is somebody's", async () => {
    const store = keyedStore(
      { "privacy.md": "rules", "index.md": "# Home\n" },
      ["privacy.md", "notes/0001.md", "notes/0002.md"],
    );
    expect(await hasForeignContent(store, FILES)).toBe(true);
  });

  test("a layout note whose bytes differ is somebody's", async () => {
    const store = keyedStore(
      { "privacy.md": "rules", "index.md": "# My own home\n" },
      ["privacy.md", "notes/0001.md"],
    );
    expect(await hasForeignContent(store, FILES)).toBe(true);
  });

  test("a store that is not keyed still reads notes/ as a folder no layout names", async () => {
    const store = { ...keyedStore({ "privacy.md": "rules" }, ["privacy.md", "notes/0001.md"]), keyedWorkspace: async () => false };
    expect(await hasForeignContent(store, FILES)).toBe(true);
  });
});
