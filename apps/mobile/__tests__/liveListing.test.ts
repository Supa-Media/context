/**
 * A folder drawn from the device's copy is not a folder the server has answered
 * for, and the tree must still ask.
 *
 * Reported 2026-10-08: Inbox and Areas drew "Empty" in the sidebar of a
 * workspace where both hold notes. The device's mirror had named the folders
 * (a live root listing records every child folder) without the notes under
 * them, because its whole-workspace walk had stopped short. `treeOf` turned
 * that into an empty listing, and expanding the folder never asked the server,
 * because the only test was "is there a listing" — and there was one.
 */

import { describe, expect, test } from "@jest/globals";
import {
  adoptMirroredTree,
  wantsLiveListing,
} from "../features/console/files/fileBrowser/liveListing";
import type { FolderListing } from "../features/console/files/types";

function listing(path: string, names: string[] = []): FolderListing {
  return {
    path,
    folderDefault: "private",
    entries: names.map((name) => ({
      kind: "file" as const,
      path: path === "" ? name : `${path}/${name}`,
      name,
      visibility: "private" as const,
      inherited: "private" as const,
      exception: false,
      readOnly: false,
    })),
    truncated: false,
    manifestUsable: true,
  };
}

describe("wantsLiveListing", () => {
  test("a folder with no listing is asked for", () => {
    expect(wantsLiveListing("0-inbox", {}, new Map(), false)).toBe(true);
  });

  test("online, a folder only the device's copy has drawn is still asked for, complete walk or not", () => {
    const listings = { "0-inbox": listing("0-inbox") };
    expect(wantsLiveListing("0-inbox", listings, new Map(), false)).toBe(true);
  });

  test("a folder the server already answered for this session is not asked again", () => {
    const listings = { "0-inbox": listing("0-inbox", ["a.md"]) };
    expect(wantsLiveListing("0-inbox", listings, new Map([["0-inbox", 1]]), false)).toBe(false);
  });

  test("offline, the device's copy is all there is", () => {
    const listings = { "0-inbox": listing("0-inbox") };
    expect(wantsLiveListing("0-inbox", listings, new Map(), true)).toBe(false);
    // ...but a folder with nothing drawn still goes through refresh, which reads the device.
    expect(wantsLiveListing("2-areas", listings, new Map(), true)).toBe(true);
  });
});

describe("adoptMirroredTree", () => {
  const live = { "": listing("", ["todo.md"]), "2-areas": listing("2-areas", ["health.md"]) };

  test("an incomplete walk does not replace what the server said, however old", () => {
    const tree = {
      value: new Map([
        ["", listing("", ["todo.md"])],
        ["2-areas", listing("2-areas")],
      ]),
      complete: false,
      listedAt: 100,
    };
    const next = adoptMirroredTree(live, tree, new Map([["", 1], ["2-areas", 1]]), false);
    expect(next["2-areas"]!.entries.map((entry) => entry.name)).toEqual(["health.md"]);
  });

  test("an incomplete walk still fills folders nothing has drawn", () => {
    const tree = { value: new Map([["0-inbox", listing("0-inbox", ["x.md"])]]), complete: false, listedAt: 100 };
    const next = adoptMirroredTree(live, tree, new Map([["", 1]]), false);
    expect(next["0-inbox"]!.entries.map((entry) => entry.name)).toEqual(["x.md"]);
  });

  test("a complete walk newer than the live listing replaces it, and drops folders it no longer names", () => {
    const tree = { value: new Map([["", listing("", ["todo.md", "new.md"])]]), complete: true, listedAt: 100 };
    const next = adoptMirroredTree(live, tree, new Map([["", 1], ["2-areas", 1]]), false);
    expect(next[""]!.entries.map((entry) => entry.name)).toEqual(["todo.md", "new.md"]);
    expect(next["2-areas"]).toBeUndefined();
  });

  test("a complete walk older than the live listing leaves it alone", () => {
    const tree = { value: new Map([["2-areas", listing("2-areas")]]), complete: true, listedAt: 100 };
    const next = adoptMirroredTree(live, tree, new Map([["", 200], ["2-areas", 200]]), false);
    expect(next["2-areas"]!.entries.map((entry) => entry.name)).toEqual(["health.md"]);
    expect(next[""]).toBe(live[""]);
  });

  test("from the device: only where the server has said nothing yet", () => {
    const tree = {
      value: new Map([
        ["2-areas", listing("2-areas")],
        ["3-resources", listing("3-resources", ["r.md"])],
      ]),
      complete: true,
      listedAt: 100,
    };
    const next = adoptMirroredTree(live, tree, new Map([["2-areas", 1]]), true);
    expect(next["2-areas"]).toBe(live["2-areas"]);
    expect(next["3-resources"]!.entries.map((entry) => entry.name)).toEqual(["r.md"]);
  });
});

