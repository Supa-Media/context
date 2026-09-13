/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

jest.mock("../features/onboarding/vaultPicker", () => ({
  pickObsidianVault: async () => ({
    kind: "selected",
    files: [
      {
        path: "My notes/hello.md",
        size: 5,
        type: "text/markdown",
        read: async () => new TextEncoder().encode("hello").buffer,
      },
    ],
  }),
}));

import { VaultImportBody } from "../features/console/storage/VaultImport";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function jobStatus(overrides: Partial<{
  completedBatches: number[];
  completedFiles: number;
  createdFiles: number;
  skippedFiles: number;
  totalFiles: number;
  status: "active" | "paused" | "complete";
}> = {}) {
  return {
    jobId: "j1" as never,
    strategy: "merge" as const,
    completedBatches: [],
    completedFiles: 0,
    createdFiles: 0,
    skippedFiles: 0,
    totalFiles: 1,
    status: "active" as const,
    ...overrides,
  };
}

describe("the reusable notes importer", () => {
  test("an established workspace asks how imports should join existing data", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(VaultImportBody, {
          workspaceId: "w1" as never,
          existingData: true,
          startJob: jest.fn(async () => jobStatus()),
          importBatch: jest.fn(async () => jobStatus()),
          testIDPrefix: "settings-vault",
        }),
      );
    });

    expect(container.textContent ?? "").toContain("Import Markdown");
    expect(container.textContent ?? "").toContain("How should these notes be added?");
    expect(container.textContent ?? "").toContain("Merge without replacing");
    expect(container.textContent ?? "").toContain("Keep it in its own folder");
    expect(container.textContent ?? "").toContain("Replace everything");
    expect(container.textContent ?? "").not.toContain("Keep this tab open while files upload");
    expect(container.textContent ?? "").not.toMatch(/overwrite existing/i);

    act(() => root.unmount());
    container.remove();
  });

  test("requires the typed acknowledgement before a replacement vault can be chosen", async () => {
    const startJob = jest.fn(async () => ({
      ...jobStatus(),
      strategy: "replace" as const,
      replacement: { phase: "counting" as const, totalObjects: 0, deletedObjects: 0 },
    }));
    const clearReplacementBatch = jest.fn(async () => ({
      ...jobStatus(),
      strategy: "replace" as const,
      replacement: { phase: "uploading" as const, totalObjects: 6, deletedObjects: 6 },
    }));
    const importBatch = jest.fn(async () => ({
      ...jobStatus({ completedBatches: [0], completedFiles: 1, createdFiles: 1, status: "complete" }),
      strategy: "replace" as const,
      replacement: { phase: "uploading" as const, totalObjects: 6, deletedObjects: 6 },
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(VaultImportBody, {
        workspaceId: "w1" as never,
        existingData: true,
        startJob,
        importBatch,
        clearReplacementBatch,
        testIDPrefix: "settings-vault",
      }));
    });

    const replace = container.querySelector('[data-testid="settings-vault-replace"]') as HTMLElement;
    await act(async () => replace.click());
    expect(container.textContent ?? "").toContain("permanently deletes every existing file in this bucket");
    expect(container.textContent ?? "").toContain("Context cannot undo this");
    expect(container.textContent ?? "").toContain("Type “I understand” to continue");
    expect(container.querySelector('[data-testid="settings-vault-choose"]')).toBeNull();

    const input = container.querySelector('[data-testid="settings-vault-replace-confirmation"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "i understand");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="settings-vault-choose"]')).not.toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "I UNDERSTAND");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="settings-vault-choose"]')).not.toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "  I Understand  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="settings-vault-choose"]')).not.toBeNull();

    const choose = container.querySelector('[data-testid="settings-vault-choose"]') as HTMLElement;
    await act(async () => {
      choose.click();
      await Promise.resolve();
    });
    const upload = container.querySelector('[data-testid="settings-vault-upload"]') as HTMLElement;
    await act(async () => {
      upload.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      strategy: "replace",
      confirmation: "I understand",
    }));
    expect(clearReplacementBatch).toHaveBeenCalledTimes(1);
    expect(importBatch).toHaveBeenCalledTimes(1);
    expect(container.textContent ?? "").toContain("Import complete");

    act(() => root.unmount());
    container.remove();
  });

  test("an established workspace imports without rewriting its privacy map", async () => {
    const startJob = jest.fn(async () => jobStatus());
    const imported = jest.fn(async () => jobStatus({
      completedBatches: [0],
      completedFiles: 1,
      createdFiles: 1,
      status: "complete",
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(VaultImportBody, {
          workspaceId: "w1" as never,
          existingData: true,
          startJob,
          importBatch: imported,
          resetPrivacy: undefined,
          testIDPrefix: "settings-vault",
        }),
      );
    });

    const click = async (testID: string) => {
      const node = container.querySelector(`[data-testid="${testID}"]`) as HTMLElement;
      await act(async () => {
        node.click();
        await Promise.resolve();
      });
    };

    expect(container.textContent ?? "").toContain("Have an Obsidian vault or existing Markdown notes?");
    await click("settings-vault-merge");
    await click("settings-vault-choose");
    expect(container.textContent ?? "").toContain("Ready to upload");
    expect(container.textContent ?? "").toContain("Keep this tab open");
    expect(container.textContent ?? "").toContain("Upload 1 file");
    await click("settings-vault-upload");

    expect(imported).toHaveBeenCalledTimes(1);
    expect(startJob).toHaveBeenCalledTimes(1);
    expect(container.textContent ?? "").toContain("Import complete");

    act(() => root.unmount());
    container.remove();
  });

  test("fresh onboarding storage initializes the all-private access map", async () => {
    const startJob = jest.fn(async () => jobStatus());
    const imported = jest.fn(async () => jobStatus({
      completedBatches: [0],
      completedFiles: 1,
      createdFiles: 1,
      status: "complete",
    }));
    const resetPrivacy = jest.fn(async () => ({}));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(VaultImportBody, {
          workspaceId: "w1" as never,
          existingData: false,
          startJob,
          importBatch: imported,
          resetPrivacy,
          testIDPrefix: "welcome-vault",
        }),
      );
    });
    const click = async (testID: string) => {
      const node = container.querySelector(`[data-testid="${testID}"]`) as HTMLElement;
      await act(async () => {
        node.click();
        await Promise.resolve();
      });
    };

    await click("welcome-vault-choose");
    await click("welcome-vault-upload");

    expect(resetPrivacy).toHaveBeenCalledWith({ workspaceId: "w1" });

    act(() => root.unmount());
    container.remove();
  });

  test("shows durable progress from an interrupted import before the folder is selected again", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(VaultImportBody, {
          workspaceId: "w1" as never,
          existingData: true,
          existingJob: {
            strategy: "merge",
            completedFiles: 620,
            createdFiles: 600,
            skippedFiles: 20,
            totalFiles: 1800,
            status: "paused",
          },
          startJob: jest.fn(async () => jobStatus()),
          importBatch: jest.fn(async () => jobStatus()),
          testIDPrefix: "settings-vault",
        }),
      );
    });

    expect(container.textContent ?? "").toContain("620 of 1800 files finished");
    expect(container.textContent ?? "").toContain("34%");
    expect(container.textContent ?? "").toContain("Choose the same vault to resume");
    expect(container.textContent ?? "").toContain("Choose a vault or notes folder");
    expect(container.textContent ?? "").not.toContain("How should these notes be added?");

    act(() => root.unmount());
    container.remove();
  });

  test("shows replacement deletion progress instead of pretending files already uploaded", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(VaultImportBody, {
        workspaceId: "w1" as never,
        existingData: true,
        existingJob: {
          strategy: "replace",
          replacement: {
            phase: "deleting",
            totalObjects: 1800,
            deletedObjects: 620,
          },
          completedFiles: 0,
          createdFiles: 0,
          skippedFiles: 0,
          totalFiles: 1200,
          status: "paused",
        },
        startJob: jest.fn(async () => jobStatus()),
        importBatch: jest.fn(async () => jobStatus()),
        testIDPrefix: "settings-vault",
      }));
    });

    expect(container.textContent ?? "").toContain("620 of 1800 existing files removed");
    expect(container.textContent ?? "").toContain("34%");
    expect(container.textContent ?? "").not.toContain("0 of 1200 files finished");

    act(() => root.unmount());
    container.remove();
  });
});
