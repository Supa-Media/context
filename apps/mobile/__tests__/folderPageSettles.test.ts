/**
 * What still moved on a phone's pages after #1770 (owner's second recording,
 * 2026-10-17): the about's "More" line appearing once the block had measured itself,
 * and a note opened from this device's copy saying "Saved on this device;
 * syncing soon" when nothing had been typed.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. The `pending === 0` arm dropped from `noteFoot`.  → "a note opened from the device's copy is a read"
 */

import { describe, expect, test } from "@jest/globals";
import { noteFoot } from "../features/console/files/noteEditor/statusLine";
import type { EditorState } from "../features/console/files/editor";
import type { Presence } from "../features/console/presence/usePresence";

describe("a note's foot while its shared copy settles", () => {
  const state = { path: "a.md", draft: "a", status: "clean" } as EditorState;
  const foot = (status: string, pending: number) =>
    noteFoot({
      state,
      presence: { collaboration: { status, pending } } as unknown as Presence,
      editable: true,
      compact: true,
      button: { label: "Save", disabled: true },
    }).durability;

  test("a note opened from the device's copy is a read, not a save waiting to sync", () => {
    expect(foot("local", 0)).toBe("Read from this device");
  });

  test("an edit kept on this device still says it will sync", () => {
    expect(foot("local", 2)).toBe("Saved on this device; syncing soon.");
    expect(foot("saved", 0)).toBe("Saved in your bucket");
  });
});
