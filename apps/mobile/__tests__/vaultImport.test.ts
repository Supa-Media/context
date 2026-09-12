import { describe, expect, test } from "@jest/globals";
import {
  batchVaultFiles,
  planVaultFiles,
  vaultFingerprint,
  vaultPlanForStrategy,
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

  test("makes the existing-data choice explicit without offering overwrite", () => {
    const plan = planVaultFiles([
      picked("My Vault/Projects/Launch.md", 12),
      picked("My Vault/index.md", 8),
    ]);

    expect(vaultPlanForStrategy(plan, "merge").files.map((file) => file.path)).toEqual([
      "Projects/Launch.md",
      "index.md",
    ]);
    expect(vaultPlanForStrategy(plan, "folder").files.map((file) => file.path)).toEqual([
      "Imports/My Vault/Projects/Launch.md",
      "Imports/My Vault/index.md",
    ]);
  });

  test("uses one stable fingerprint when the same vault is selected again", () => {
    const first = vaultPlanForStrategy(
      planVaultFiles([picked("My Vault/b.md", 3), picked("My Vault/a.md", 2)]),
      "merge",
    );
    const second = vaultPlanForStrategy(
      planVaultFiles([picked("My Vault/a.md", 2), picked("My Vault/b.md", 3)]),
      "merge",
    );

    expect(vaultFingerprint(first, "merge")).toBe(vaultFingerprint(second, "merge"));
    expect(vaultFingerprint(first, "merge")).not.toBe(vaultFingerprint(first, "folder"));
    expect(batchVaultFiles(first.files).map((batch) => batch.map((file) => file.path))).toEqual(
      batchVaultFiles(second.files).map((batch) => batch.map((file) => file.path)),
    );
  });
});
