import { describe, expect, test } from "@jest/globals";
import { messageAnswered } from "@context/shared";
import { dropboxEndingEligible } from "../features/console/panes/browsePane/useBrowseNotices";
import type { ConsoleData, ConsoleStorage, StorageActions } from "../features/console/types";

/**
 * "Dropbox support is ending": who is asked, and when they are asked again.
 *
 * Owners only, because only an owner can move storage; never while a move is
 * already copying; and an answer lasts two weeks, because the ending does not
 * go away by being dismissed.
 *
 * ## Sabotage record
 *
 * Dropping the owner check, the provider check or the copying check each
 * failed the matching case below; removing `askAgainAfterMs` from the message
 * failed the last test.
 */

const DAY = 24 * 60 * 60 * 1000;
const OWNER = {} as StorageActions;

function storage(overrides: Partial<ConsoleStorage> = {}): ConsoleStorage {
  return { connected: true, status: "connected", provider: "dropbox", conditionalWrite: true, updatedAt: 0, ...overrides };
}

function data(
  storageValue: ConsoleStorage | null,
  { owner = true }: { owner?: boolean } = {},
): Pick<ConsoleData, "storage" | "storageActions"> {
  return { storage: storageValue, storageActions: owner ? OWNER : undefined };
}

describe("the Dropbox ending notice", () => {
  test("asks an owner of a Dropbox workspace", () => {
    expect(dropboxEndingEligible(data(storage()))).toBe(true);
  });

  test("never asks someone who cannot move storage", () => {
    expect(dropboxEndingEligible(data(storage(), { owner: false }))).toBe(false);
  });

  test("never asks about storage that is not Dropbox", () => {
    expect(dropboxEndingEligible(data(storage({ provider: "s3" })))).toBe(false);
    expect(dropboxEndingEligible(data(null))).toBe(false);
  });

  test("waits while a move is already copying the workspace off Dropbox", () => {
    expect(dropboxEndingEligible(data(storage({ handoffStatus: "copying" })))).toBe(false);
    expect(dropboxEndingEligible(data(storage({ handoffStatus: "failed" })))).toBe(true);
  });

  test("an answer holds for two weeks, then it is asked again", () => {
    const seenAt = Date.UTC(2026, 9, 1);
    expect(messageAnswered("dropbox-ending", seenAt, seenAt + 13 * DAY)).toBe(true);
    expect(messageAnswered("dropbox-ending", seenAt, seenAt + 14 * DAY)).toBe(false);
  });
});
