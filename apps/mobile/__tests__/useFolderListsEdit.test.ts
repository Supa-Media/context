/**
 * @jest-environment jsdom
 */
/**
 * Who a folder list lets change a note: `useFolderLists` offers `setProperty`
 * to an owner or an editor and to nobody else, and what it writes goes through
 * `files.writeNote` against the version `files.readNote` returned. The server
 * refuses a member's write too (`minimum: "editor"`); this is the console not
 * offering a button that would only ever fail.
 */

import { describe, expect, jest, test } from "@jest/globals";

const mockCalls: Array<[string, Record<string, unknown>]> = [];
jest.mock("convex/react", () => ({
  useAction: (reference: unknown) => {
    const name = String((reference as { name?: string })?.name ?? reference);
    return async (args: Record<string, unknown>) => {
      mockCalls.push([name, args]);
      if (name.includes("readNote")) return { path: args.path, text: "---\nstatus: planned\n---\n", etag: "e1" };
      return { path: args.path };
    };
  },
}));
jest.mock("@context/convex/_generated/api", () => ({
  api: { functions: { files: { readNote: { name: "readNote" }, writeNote: { name: "writeNote" } } } },
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useFolderLists } from "../features/offline/useFolderLists";
import type { FolderListSource } from "../features/console/files/listBlock/model";

function sourceFor(role: string | undefined): FolderListSource | undefined {
  let latest: FolderListSource | undefined;
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() {
    latest = useFolderLists("ws_one", role);
    return null;
  }
  act(() => root.render(createElement(Probe)));
  act(() => root.unmount());
  return latest;
}

describe("changing a note from a folder list", () => {
  test("is offered to an owner and an editor", () => {
    expect(sourceFor("owner")?.setProperty).toBeInstanceOf(Function);
    expect(sourceFor("editor")?.setProperty).toBeInstanceOf(Function);
  });

  test("is not offered to a member, or to a role the console does not know", () => {
    expect(sourceFor("member")?.setProperty).toBeUndefined();
    expect(sourceFor("viewer")?.setProperty).toBeUndefined();
  });

  test("reads the note, then writes the one changed line against the version read", async () => {
    mockCalls.length = 0;
    const problem = await sourceFor("editor")!.setProperty!("p/web.md", "status", "active");
    expect(problem).toBeNull();
    expect(mockCalls).toEqual([
      ["readNote", { workspaceId: "ws_one", path: "p/web.md" }],
      ["writeNote", { workspaceId: "ws_one", path: "p/web.md", text: "---\nstatus: active\n---\n", expectedEtag: "e1" }],
    ]);
  });
});
