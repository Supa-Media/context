import { describe, expect, test } from "vitest";
import { isLogicalDeleteMarker } from "../../../mcp/src/store/logicalDelete.js";
import { api } from "../../_generated/api";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import {
  asUser,
  captureError,
  errorCode,
} from "../fixtures.helpers";
import { fixture } from "./fixtures";

describe("Obsidian vault import", () => {
  test("requires the destructive acknowledgement before a replacement job exists", async () => {
    const f = await fixture();
    const owner = asUser(f.t, f.owner);
    const args = {
      workspaceId: f.workspaceId,
      strategy: "replace" as const,
      sourceFingerprint: "vault-replace-confirmation",
      totalFiles: 1,
      totalBytes: 3,
      totalBatches: 1,
    };

    for (const confirmation of [undefined, "I understand this", "understand"]) {
      const error = await captureError(() => owner.mutation(
        api.functions.files.startVaultImport,
        { ...args, confirmation },
      ));
      expect(errorCode(error)).toBe("IMPORT_REPLACE_CONFIRMATION_REQUIRED");
    }

    const jobs = await f.t.run((ctx) => ctx.db.query("vaultImportJobs").collect());
    expect(jobs).toEqual([]);

    for (const [index, confirmation] of [
      "I understand",
      "i understand",
      "I UNDERSTAND",
      "I Understand",
      "  I understand  ",
    ].entries()) {
      const accepted = await owner.mutation(api.functions.files.startVaultImport, {
        ...args,
        confirmation,
        sourceFingerprint: `vault-replace-confirmation-${index}`,
      });
      expect(accepted.strategy).toBe("replace");
    }
  });

  test("clears every bucket object in a resumable owner-only phase before replacement uploads", async () => {
    const f = await fixture();
    f.backend.seed(".audit/legacy-events.jsonl", "legacy audit");
    f.backend.seed(".context/audit/events.jsonl", "audit");
    f.backend.seed(".context/recover/privacy.md", "old privacy");
    f.backend.seed("attachment.png", new Uint8Array([1, 2, 3]));
    for (let index = 0; index < 205; index += 1) {
      f.backend.seed(`archive/note-${String(index).padStart(3, "0")}.md`, `${index}`);
    }
    const owner = asUser(f.t, f.owner);
    const job = await owner.mutation(api.functions.files.startVaultImport, {
      workspaceId: f.workspaceId,
      strategy: "replace",
      confirmation: "I understand",
      sourceFingerprint: "vault-replace-resumable",
      totalFiles: 1,
      totalBytes: 3,
      totalBatches: 1,
    });

    expect(job.replacement).toEqual({
      phase: "counting",
      totalObjects: 0,
      deletedObjects: 0,
    });

    const unauthorized = await captureError(() => asUser(f.t, f.stranger).action(
      api.functions.files.clearVaultImportBatch,
      { workspaceId: f.workspaceId, jobId: job.jobId, sourceFingerprint: "vault-replace-resumable" },
    ));
    expect(errorCode(unauthorized)).toBe("WORKSPACE_NOT_FOUND");
    expect(Object.keys(f.backend.snapshot())).toHaveLength(215);

    const counted = await owner.action(api.functions.files.clearVaultImportBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-replace-resumable",
    });
    expect(counted.replacement).toEqual({
      phase: "deleting",
      totalObjects: 215,
      deletedObjects: 0,
    });
    expect(Object.keys(f.backend.snapshot())).toHaveLength(215);

    const firstPage = await owner.action(api.functions.files.clearVaultImportBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-replace-resumable",
    });
    expect(firstPage.replacement).toEqual({
      phase: "deleting",
      totalObjects: 215,
      deletedObjects: 100,
    });
    expect(Object.values(f.backend.snapshot()).filter((body) => !isLogicalDeleteMarker(body))).toHaveLength(115);
    expect(Object.values(f.backend.snapshot()).filter(isLogicalDeleteMarker)).toHaveLength(100);

    await owner.action(api.functions.files.clearVaultImportBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-replace-resumable",
    });
    const cleared = await owner.action(api.functions.files.clearVaultImportBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-replace-resumable",
    });
    expect(cleared.replacement).toEqual({
      phase: "uploading",
      totalObjects: 215,
      deletedObjects: 215,
    });
    expect(Object.values(f.backend.snapshot()).filter((body) => !isLogicalDeleteMarker(body))).toEqual([]);
    expect(Object.values(f.backend.snapshot()).filter(isLogicalDeleteMarker)).toHaveLength(215);

    const complete = await owner.action(api.functions.files.importVaultJobBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-replace-resumable",
      batchIndex: 0,
      files: [{
        path: "new.md",
        bytes: new TextEncoder().encode("new").buffer,
        contentType: "text/markdown; charset=utf-8",
      }],
    });
    expect(complete.status).toBe("complete");
    expect(f.backend.snapshot()["new.md"]).toBe("new");
    expect(f.backend.snapshot()[PRIVACY_KEY]).toContain("default_visibility: private");
  });

  test("refuses replacement file bytes until the bucket-clearing phase finishes", async () => {
    const f = await fixture();
    const owner = asUser(f.t, f.owner);
    const job = await owner.mutation(api.functions.files.startVaultImport, {
      workspaceId: f.workspaceId,
      strategy: "replace",
      confirmation: "I understand",
      sourceFingerprint: "vault-replace-ordering",
      totalFiles: 1,
      totalBytes: 3,
      totalBatches: 1,
    });

    const error = await captureError(() => owner.action(api.functions.files.importVaultJobBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-replace-ordering",
      batchIndex: 0,
      files: [{ path: "new.md", bytes: new TextEncoder().encode("new").buffer, contentType: "text/markdown" }],
    }));

    expect(errorCode(error)).toBe("IMPORT_REPLACE_NOT_READY");
    expect(f.backend.snapshot()["index.md"]).toBe("# Context\n");
    expect(f.backend.snapshot()["new.md"]).toBeUndefined();
  });

  test("persists resumable progress and counts a retried batch only once", async () => {
    const f = await fixture();
    const owner = asUser(f.t, f.owner);
    const job = await owner.mutation(api.functions.files.startVaultImport, {
      workspaceId: f.workspaceId,
      strategy: "merge",
      sourceFingerprint: "vault-fingerprint-1",
      totalFiles: 2,
      totalBytes: 12,
      totalBatches: 2,
    });
    const batch = {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-fingerprint-1",
      batchIndex: 0,
      files: [{
        path: "Imported/one.md",
        bytes: new TextEncoder().encode("# One\n").buffer,
        contentType: "text/markdown; charset=utf-8",
      }],
    };

    const first = await owner.action(api.functions.files.importVaultJobBatch, batch);
    const retry = await owner.action(api.functions.files.importVaultJobBatch, batch);

    expect(first).toMatchObject({
      status: "active",
      completedFiles: 1,
      totalFiles: 2,
      createdFiles: 1,
      skippedFiles: 0,
      completedBatches: [0],
    });
    expect(retry).toEqual(first);
    expect(f.backend.snapshot()["Imported/one.md"]).toBe("# One\n");

    const durable = await owner.query(api.functions.files.latestVaultImportJob, {
      workspaceId: f.workspaceId,
    });
    expect(durable).toMatchObject({
      jobId: job.jobId,
      status: "active",
      completedFiles: 1,
      totalFiles: 2,
    });
  });

  test("resumes the same selected vault and completes after the missing batch", async () => {
    const f = await fixture();
    const owner = asUser(f.t, f.owner);
    const args = {
      workspaceId: f.workspaceId,
      strategy: "folder" as const,
      sourceFingerprint: "vault-fingerprint-2",
      totalFiles: 2,
      totalBytes: 12,
      totalBatches: 2,
    };
    const started = await owner.mutation(api.functions.files.startVaultImport, args);
    await owner.action(api.functions.files.importVaultJobBatch, {
      workspaceId: f.workspaceId,
      jobId: started.jobId,
      sourceFingerprint: args.sourceFingerprint,
      batchIndex: 0,
      files: [{
        path: "Imports/Vault/one.md",
        bytes: new TextEncoder().encode("one").buffer,
        contentType: "text/markdown; charset=utf-8",
      }],
    });

    await owner.mutation(api.functions.files.pauseVaultImport, {
      workspaceId: f.workspaceId,
      jobId: started.jobId,
    });
    const resumed = await owner.mutation(api.functions.files.startVaultImport, args);
    expect(resumed).toMatchObject({
      jobId: started.jobId,
      status: "active",
      completedFiles: 1,
      completedBatches: [0],
    });

    const complete = await owner.action(api.functions.files.importVaultJobBatch, {
      workspaceId: f.workspaceId,
      jobId: started.jobId,
      sourceFingerprint: args.sourceFingerprint,
      batchIndex: 1,
      files: [{
        path: "Imports/Vault/two.md",
        bytes: new TextEncoder().encode("two").buffer,
        contentType: "text/markdown; charset=utf-8",
      }],
    });
    expect(complete).toMatchObject({
      status: "complete",
      completedFiles: 2,
      totalFiles: 2,
      completedBatches: [0, 1],
    });
  });

  test("keeps another user from seeing or advancing a vault import job", async () => {
    const f = await fixture();
    const job = await asUser(f.t, f.owner).mutation(api.functions.files.startVaultImport, {
      workspaceId: f.workspaceId,
      strategy: "merge",
      sourceFingerprint: "vault-fingerprint-private",
      totalFiles: 1,
      totalBytes: 3,
      totalBatches: 1,
    });

    const queryError = await captureError(() =>
      asUser(f.t, f.stranger).query(api.functions.files.latestVaultImportJob, {
        workspaceId: f.workspaceId,
      }),
    );
    const batchError = await captureError(() =>
      asUser(f.t, f.stranger).action(api.functions.files.importVaultJobBatch, {
        workspaceId: f.workspaceId,
        jobId: job.jobId,
        sourceFingerprint: "vault-fingerprint-private",
        batchIndex: 0,
        files: [{
          path: "private.md",
          bytes: new TextEncoder().encode("no").buffer,
          contentType: "text/markdown; charset=utf-8",
        }],
      }),
    );
    expect(errorCode(queryError)).toBe("WORKSPACE_NOT_FOUND");
    expect(errorCode(batchError)).toBe("WORKSPACE_NOT_FOUND");
    expect(f.backend.snapshot()["private.md"]).toBeUndefined();
  });

  test("rejects a mismatched resume plan before any local bytes reach storage", async () => {
    const f = await fixture();
    const owner = asUser(f.t, f.owner);
    const job = await owner.mutation(api.functions.files.startVaultImport, {
      workspaceId: f.workspaceId,
      strategy: "merge",
      sourceFingerprint: "vault-fingerprint-mismatch",
      totalFiles: 1,
      totalBytes: 6,
      totalBatches: 1,
    });

    const error = await captureError(() => owner.action(api.functions.files.importVaultJobBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-fingerprint-mismatch",
      batchIndex: 0,
      files: [
        {
          path: "one.md",
          bytes: new TextEncoder().encode("one").buffer,
          contentType: "text/markdown; charset=utf-8",
        },
        {
          path: "two.md",
          bytes: new TextEncoder().encode("two").buffer,
          contentType: "text/markdown; charset=utf-8",
        },
      ],
    }));

    expect(errorCode(error)).toBe("IMPORT_PLAN_INVALID");
    expect(f.backend.snapshot()["one.md"]).toBeUndefined();
    expect(f.backend.snapshot()["two.md"]).toBeUndefined();
  });

  test("preserves Markdown and attachment paths without retaining their bytes in Convex", async () => {
    const f = await fixture();
    const markdown = new TextEncoder().encode("# Imported\n\n![[diagram.png]]\n");
    const image = new Uint8Array([137, 80, 78, 71]);
    const owner = asUser(f.t, f.owner);
    const job = await owner.mutation(api.functions.files.startVaultImport, {
      workspaceId: f.workspaceId,
      strategy: "merge",
      sourceFingerprint: "vault-fingerprint-no-content",
      totalFiles: 2,
      totalBytes: markdown.byteLength + image.byteLength,
      totalBatches: 1,
    });

    const result = await owner.action(api.functions.files.importVaultJobBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-fingerprint-no-content",
      batchIndex: 0,
      files: [
        {
          path: "Imported/Note.md",
          bytes: markdown.buffer,
          contentType: "text/markdown; charset=utf-8",
        },
        {
          path: "Imported/diagram.png",
          bytes: image.buffer,
          contentType: "image/png",
        },
      ],
    });

    expect(result).toMatchObject({ status: "complete", createdFiles: 2, completedFiles: 2 });
    expect(f.backend.snapshot()["Imported/Note.md"]).toContain("# Imported");
    expect([...f.backend.bytesOf("Imported/diagram.png")!]).toEqual([...image]);

    const database = await f.t.run(async (ctx) => {
      const tables = ["auditEvents", "storageBindings", "vaultImportJobs", "workspaces", "users"] as const;
      return JSON.stringify(await Promise.all(tables.map((table) => ctx.db.query(table).collect())));
    });
    expect(database).not.toContain("# Imported");
    expect(database).not.toContain("137,80,78,71");
  });

  test("is create-only, so retrying cannot overwrite a file that already exists", async () => {
    const f = await fixture();
    const result = await asUser(f.t, f.owner).action(api.functions.files.importVaultBatch, {
      workspaceId: f.workspaceId,
      files: [{
        path: "index.md",
        bytes: new TextEncoder().encode("# Replacement\n").buffer,
        contentType: "text/markdown; charset=utf-8",
      }],
    });

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual(["index.md"]);
    expect(f.backend.snapshot()["index.md"]).toBe("# Context\n");
  });

  // The create-only claim above is tested against a backend that honours the
  // precondition. `initialCapabilities()` starts every binding at
  // `conditionalWrite: false` — "B2 and arbitrary S3-compatible endpoints do
  // not reliably [support it]" — and every other conditional write in
  // `fileOps.ts` reads `store.capabilities` before relying on one. An importer
  // that sends the precondition and trusts the answer, on a binding recorded as
  // not having proven it, is the exact failure the probe exists to prevent:
  // "a lost write with no error, which is the one failure mode a notes product
  // cannot have" — here, during onboarding, over the customer's own vault.
  test("does not lose an existing file on a backend whose conditional writes were never proven", async () => {
    const f = await fixture({ conditionalWrite: false, ignoreIfMatch: true });
    const result = await asUser(f.t, f.owner).action(api.functions.files.importVaultBatch, {
      workspaceId: f.workspaceId,
      files: [{
        path: "index.md",
        bytes: new TextEncoder().encode("# Replacement\n").buffer,
        contentType: "text/markdown; charset=utf-8",
      }],
    });

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual(["index.md"]);
    expect(f.backend.snapshot()["index.md"]).toBe("# Context\n");
  });

  test("is owner-only and refuses Obsidian or Context hidden state", async () => {
    const f = await fixture();
    const file = {
      path: "notes/new.md",
      bytes: new TextEncoder().encode("# no\n").buffer,
      contentType: "text/markdown; charset=utf-8",
    };
    const editorError = await captureError(() =>
      asUser(f.t, f.editor).action(api.functions.files.importVaultBatch, {
        workspaceId: f.workspaceId,
        files: [file],
      }),
    );
    expect(errorCode(editorError)).toBe("INSUFFICIENT_ROLE");

    const hiddenError = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.importVaultBatch, {
        workspaceId: f.workspaceId,
        files: [{ ...file, path: ".obsidian/plugins.json" }],
      }),
    );
    expect(errorCode(hiddenError)).toBe("PATH_INVALID");
    expect(f.backend.snapshot()[".obsidian/plugins.json"]).toBeUndefined();
  });
});

