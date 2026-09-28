/**
 * @jest-environment jsdom
 *
 * THE SAVE MARK: QUIET WHEN NOTHING IS OWED, A WORD WHEN SOMETHING IS.
 *
 * The top bar used to say "Saved" in a green pill — the loudest object in the
 * corner for the most ordinary state the console has. It is now a cloud with
 * no text of its own, which is exactly the change that can quietly lose
 * meaning: a bare icon with no accessible name, a visitor told their edits are
 * "saved to your bucket" when there is no bucket, or a failed save drawn as
 * calmly as a good one. These are the guards for each.
 *
 * SABOTAGE: make `isQuiet` answer true for every tone and "a failed save still
 * says so in words" fails; drop the `local` arm from `saveMarkLabel` and "a
 * homepage visitor is never told about a bucket" fails.
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { emptyEditor, type EditorState, type EditorStatus } from "../features/console/files/editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SaveMark, saveMarkIcon, saveMarkLabel } =
  require("../features/console/SaveMark") as typeof import("../features/console/SaveMark");

function editorWith(status: EditorStatus, extra: Partial<EditorState> = {}): EditorState {
  return {
    ...emptyEditor,
    status,
    path: status === "empty" ? null : "1-projects/plan.md",
    baseline: "hello",
    draft: "hello",
    etag: "etag-1",
    ...extra,
  };
}

function mount(editor: EditorState, local = false) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(SaveMark, { editor, local })));
  const mark = host.querySelector('[data-testid="save-mark"]') as HTMLElement | null;
  const icon = mark?.querySelector("[data-icon]")?.getAttribute("data-icon") ?? null;
  const result = {
    mark,
    icon,
    text: mark?.textContent ?? "",
    label: mark?.getAttribute("aria-label") ?? "",
  };
  act(() => root.unmount());
  host.remove();
  return result;
}

describe("the resting states draw a cloud and no word", () => {
  test("saved: a cloud with a check, and the sentence in its name", () => {
    const saved = mount(editorWith("saved"));
    expect(saved.icon).toBe("cloudCheck");
    expect(saved.text).toBe("");
    expect(saved.label).toContain("Saved to your bucket");
  });

  test("typing and saving: the cloud with an arrow, still silent", () => {
    for (const status of ["dirty", "saving"] as const) {
      const mark = mount(editorWith(status));
      expect(mark.icon).toBe("cloudUp");
      expect(mark.text).toBe("");
      expect(mark.label).not.toBe("");
    }
  });

  test("nothing open draws nothing, rather than a claim about no file", () => {
    expect(mount(emptyEditor).mark).toBeNull();
  });
});

describe("the states worth noticing keep their words", () => {
  test("a queued draft and a cached body say so, in warn", () => {
    const queued = mount(editorWith("queued"));
    expect(queued.text).toBe("Queued");
    expect(queued.icon).toBe("cloudUp");

    const cached = mount(editorWith("clean", { fromCache: true }));
    expect(cached.text).toBe("Cached copy");
    expect(cached.icon).toBe("cloudOff");
  });

  test("a failed save still says so in words", () => {
    const failed = mount(editorWith("error"));
    expect(failed.text).toBe("Not saved");
    expect(failed.icon).toBe("info");
    expect(mount(editorWith("conflict")).text).toBe("Conflict");
  });
});

describe("a homepage visitor is never told about a bucket", () => {
  test("their resting mark is the device, and says where the edit is", () => {
    const visitor = mount(editorWith("saved"), true);
    expect(visitor.icon).toBe("laptop");
    expect(visitor.label).toBe("Only on this device");
    expect(visitor.label).not.toContain("bucket");
  });

  test("the label rule on its own", () => {
    expect(saveMarkLabel("Saved", "Saved.", { local: false, quiet: true })).toBe("Saved to your bucket");
    expect(saveMarkLabel("Saved 2 minutes ago", undefined, { local: false, quiet: true })).toBe(
      "Saved to your bucket 2 minutes ago",
    );
    expect(saveMarkLabel("Saved", "Saved.", { local: true, quiet: true })).toBe("Only on this device");
    expect(saveMarkLabel("Queued", "Waiting for a connection.", { local: false, quiet: false })).toBe(
      "Queued. Waiting for a connection.",
    );
    expect(saveMarkIcon(editorWith("saved"), true)).toBe("laptop");
  });
});
