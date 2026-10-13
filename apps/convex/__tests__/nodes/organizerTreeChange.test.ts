/**
 * The organizer decides its paths inside itself, so the barrier reads what it
 * changed off the store as it writes (`recordTreeChange`). Before, its tree
 * change was `null` and an open folder kept drawing a note the organizer had
 * filed away until the next walk.
 *
 * Sabotage: drop the delete recording and the moved-note case loses `gone`;
 * drop the plumbing filter and the activity file is announced as a tree path.
 */

import { describe, expect, test } from "vitest";
import { movePath, type FileStore } from "../../functions/lib/fileOps";
import { clearanceOf } from "../../functions/lib/clearance";
import { recordTreeChange } from "../../functions/lib/treeAnnounce";
import { bucket, NOW } from "../fileOps/fixtures.helpers";

describe("what the organizer changed", () => {
  test("a note it moved names both places, and its old place as gone", async () => {
    const store = bucket({ conditional: true }) as FileStore;
    const change = recordTreeChange(store);
    await movePath(store, { from: "1-projects/pay.md", to: "9-archive/pay.md", clearance: clearanceOf("private"), now: NOW });
    await store.put(".context/activity.json", "{}");
    const answer = change();
    expect(answer?.paths).toEqual(expect.arrayContaining(["1-projects/pay.md", "9-archive/pay.md"]));
    expect(answer?.gone).toEqual(["1-projects/pay.md"]);
    expect(answer?.narrows).toBe(true);
    expect(answer?.paths.some((path) => path.startsWith(".") || path === "privacy.md")).toBe(false);
  });

  test("an organizer pass that wrote nothing tells nobody", () => {
    const store = bucket({ conditional: true }) as FileStore;
    expect(recordTreeChange(store)()).toBeNull();
  });
});
