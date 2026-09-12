import { describe, expect, test } from "@jest/globals";
import {
  batchVaultFiles,
  planVaultFiles,
  type PickedVaultFile,
} from "../features/onboarding/vaultImport";

function picked(path: string, size = 10, type = ""): PickedVaultFile {
  return { path, size, type, read: async () => new ArrayBuffer(size) };
}

describe("an Obsidian vault selection", () => {
  test("strips the selected vault folder and preserves the paths beneath it", () => {
    const plan = planVaultFiles([
      picked("My Vault/Projects/Launch.md", 12, "text/markdown"),
      picked("My Vault/assets/diagram.png", 25, "image/png"),
    ]);

    expect(plan.files.map((file) => file.path)).toEqual([
      "Projects/Launch.md",
      "assets/diagram.png",
    ]);
    expect(plan.totalBytes).toBe(37);
  });

  test("does not upload Obsidian settings, trash, git data, Context plumbing, or privacy.md", () => {
    const plan = planVaultFiles([
      picked("Vault/.obsidian/workspace.json"),
      picked("Vault/.trash/old.md"),
      picked("Vault/.git/config"),
      picked("Vault/.context/jobs/secret"),
      picked("Vault/.audit/events.jsonl"),
      picked("Vault/privacy.md"),
      picked("Vault/.DS_Store"),
      picked("Vault/notes/keep.md"),
    ]);

    expect(plan.files.map((file) => file.path)).toEqual(["notes/keep.md"]);
    expect(plan.skipped).toBe(7);
  });

  test("refuses paths that escape the vault and files too large for one safe request", () => {
    const plan = planVaultFiles([
      picked("Vault/../outside.md"),
      picked("Vault/large.pdf", 4_500_001),
      picked("Vault/ok.md"),
    ]);

    expect(plan.files.map((file) => file.path)).toEqual(["ok.md"]);
    expect(plan.skipped).toBe(2);
  });

  test("batches by both file count and request bytes", () => {
    const files = [picked("Vault/a.md", 2_000_000), picked("Vault/b.md", 2_000_000), picked("Vault/c.md", 2_000_000)];
    const batches = batchVaultFiles(planVaultFiles(files).files, {
      maxFiles: 2,
      maxBytes: 4_500_000,
    });

    expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
  });
});
