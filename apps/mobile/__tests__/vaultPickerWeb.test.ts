/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { pickObsidianVault } from "../features/onboarding/vaultPicker.web";

describe("the browser vault picker", () => {
  afterEach(() => {
    jest.useRealTimers();
    document
      .querySelectorAll('input[type="file"]')
      .forEach((input) => input.remove());
  });

  test("does not mistake window focus for cancellation before Chrome delivers the files", async () => {
    jest.useFakeTimers();
    const click = jest
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {});
    let settled: Awaited<ReturnType<typeof pickObsidianVault>> | undefined;

    const resultPromise = pickObsidianVault().then((result) => {
      settled = result;
      return result;
    });
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["hello"], "hello.md", { type: "text/markdown" });
    Object.defineProperty(file, "webkitRelativePath", {
      value: "My vault/hello.md",
    });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });

    window.dispatchEvent(new Event("focus"));
    await jest.advanceTimersByTimeAsync(500);
    expect(settled).toBeUndefined();

    input.dispatchEvent(new Event("change"));
    const result = await resultPromise;
    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.files.map((candidate) => candidate.path)).toEqual([
        "My vault/hello.md",
      ]);
    }
    expect(document.body.contains(input)).toBe(false);
    click.mockRestore();
  });

  test("uses the file input's cancel event and cleans up the temporary control", async () => {
    const click = jest
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {});
    const resultPromise = pickObsidianVault();
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    input.dispatchEvent(new Event("cancel"));

    await expect(resultPromise).resolves.toEqual({ kind: "cancelled" });
    expect(document.body.contains(input)).toBe(false);
    click.mockRestore();
  });
});
