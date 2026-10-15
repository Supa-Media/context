import { describe, expect, test } from "vitest";
import {
  classifyForwardSyncError,
  StorageNotConflictSafeError,
} from "../../functions/lib/filesFns/forwardSyncSupport";

describe("a Calendar pass on storage that cannot refuse a stale write", () => {
  test("says what to do rather than promising the next pass will try again", () => {
    const { code, message } = classifyForwardSyncError(new StorageNotConflictSafeError());
    expect(code).toBe("STORAGE_NOT_CONFLICT_SAFE");
    expect(message).toContain("Settings › Storage");
    expect(message).not.toContain("next scheduled pass");
  });

  test("...while an error nobody named is still the generic failure", () => {
    expect(classifyForwardSyncError(new Error("something else")).code).toBe("GOOGLE_SYNC_FAILED");
  });
});
