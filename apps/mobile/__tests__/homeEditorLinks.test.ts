/**
 * @jest-environment jsdom
 */

/**
 * A link in the homepage's note is followed, as it is in the console.
 *
 * The editor takes two openers: `onOpenLink` for a link in the note's text,
 * and `onOpenNote` for a row in the activity list. The homepage passed only the
 * second, so its links were inert text, and a click put the caret in them and
 * unfolded them to `[create workspace](/workspace)` (the owner's report,
 * 2026-09-26). Sabotage: dropping `onOpenLink` from `HomeEditor` fails this.
 */

import { expect, jest, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const seen: Record<string, unknown>[] = [];
jest.mock("../features/console/files/NoteEditor", () => ({
  NoteEditor: (props: Record<string, unknown>) => {
    seen.push(props);
    return null;
  },
}));

import type { FileBrowser } from "../features/console/files/browser";
import { HomeEditor } from "../features/home/HomePage";

test("the homepage hands the editor the same link opener the console does", () => {
  const onOpenNote = jest.fn();
  const root = createRoot(document.createElement("div"));
  act(() => {
    root.render(createElement(HomeEditor, { files: {} as FileBrowser, compact: false, onOpenNote }));
  });
  const props = seen[seen.length - 1]!;
  expect(typeof props.onOpenLink).toBe("function");
  (props.onOpenLink as (path: string, mode: string) => void)("workspace/new.md", "foreground");
  expect(onOpenNote).toHaveBeenCalledWith("workspace/new.md", "foreground");
  act(() => root.unmount());
});
