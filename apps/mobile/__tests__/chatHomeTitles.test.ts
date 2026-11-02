/**
 * @jest-environment jsdom
 *
 * A group chat's home is drawn by its chat's name, or its people, instead of its three words (the owner,
 * 2026-11-02, "Group chat names" artboard); the words stay its path. `features/console/files/chatHomeTitles.tsx`.
 *
 * Sabotage: `withChatHomeTitles` returning `rows` unchanged fails "relabels only the home"; FolderRow reading
 * `displayName(row.name)` alone fails "the folder page draws the chat's name".
 */
import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ChatHomeTitlesContext, titlesByPath, withChatHomeTitles } from "../features/console/files/chatHomeTitles";
import { crumbsFor } from "../features/console/files/crumbs";
import { FolderView } from "../features/console/files/FolderView";
import type { FileEntry, FolderListing } from "../features/console/files/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOMES = "tex/groups";
const HOME = `${HOMES}/chair-blast-tiger`;
const OTHER = `${HOMES}/lamp-river-stone`;
const TITLES = titlesByPath([{ path: HOME, title: "Weekend Crew", named: true, words: "chair-blast-tiger" }]);

describe("a chat home's title", () => {
  test("relabels only the home, keeping every path", () => {
    const rows = [
      { path: HOME, label: "chair-blast-tiger" },
      { path: OTHER, label: "lamp-river-stone" },
      { path: `${HOME}/skills`, label: "skills" },
    ];
    const titled = withChatHomeTitles(rows, TITLES);
    expect(titled.map((row) => row.path)).toEqual(rows.map((row) => row.path));
    expect(titled[0]!.label).toContain("Weekend Crew");
    expect(titled.slice(1)).toEqual(rows.slice(1));
    // Nothing answered: the very same rows.
    expect(withChatHomeTitles(rows, titlesByPath(undefined))).toBe(rows);
  });

  test("names the home in a note's breadcrumb", () => {
    const crumbs = withChatHomeTitles(crumbsFor(`${HOME}/skills/packing.md`), TITLES);
    expect(crumbs.map((crumb) => crumb.label.replace(/[⁦-⁩]/g, ""))).toEqual(["tex", "groups", "Weekend Crew", "skills", "packing"]);
    expect(crumbs[2]!.path).toBe(HOME);
  });
});

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const at = (kind: "file" | "folder", path: string): FileEntry => ({
  kind,
  path,
  name: path.split("/").pop()!,
  visibility: "private",
  inherited: "private",
  exception: false,
  readOnly: false,
});

test("the folder page draws the chat's name, and the words for a home it has no title for", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const listing: FolderListing = { path: HOMES, folderDefault: "private", entries: [at("folder", HOME), at("folder", OTHER)], truncated: false, manifestUsable: true };
  act(() =>
    root.render(
      createElement(
        ChatHomeTitlesContext.Provider,
        { value: TITLES },
        createElement(FolderView, { entry: at("folder", HOMES), listing, canSetVisibility: false, contextLabel: "@context-lc", onSelect: () => {} }),
      ),
    ),
  );
  expect(container.textContent).toContain("Weekend Crew");
  expect(container.textContent).not.toContain("chair-blast-tiger");
  expect(container.textContent).toContain("lamp-river-stone");
});
