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

describe("the reusable notes importer", () => {
  test("an established workspace imports without rewriting its privacy map", async () => {
    const imported = jest.fn(async () => ({
      created: ["hello.md"],
      skipped: [],
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(VaultImportBody, {
          workspaceId: "w1" as never,
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
    await click("settings-vault-choose");
    await click("settings-vault-upload");

    expect(imported).toHaveBeenCalledTimes(1);
    expect(container.textContent ?? "").toContain("Import complete");

    act(() => root.unmount());
    container.remove();
  });

  test("fresh onboarding storage initializes the all-private access map", async () => {
    const imported = jest.fn(async () => ({
      created: ["hello.md"],
      skipped: [],
    }));
    const resetPrivacy = jest.fn(async () => ({}));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(VaultImportBody, {
          workspaceId: "w1" as never,
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
});
