import { describe, expect, it, jest } from "@jest/globals";
import { mirrorActionsFor } from "../features/console/liveConsole/mirrorActions";

/*
  The wrapper once rebuilt the manifest arguments by hand and left `source`
  out, so the server never heard `source: "tree"` and every sidebar walked the
  bucket instead of reading the tree table. Every argument the mirror sends
  must arrive.
*/
describe("mirrorActionsFor", () => {
  function bind() {
    const syncManifestAction = jest.fn(async () => ({
      entries: [],
      folders: [],
      cursor: null,
    }));
    const readNotesAction = jest.fn(async () => ({ results: [] }));
    const actions = mirrorActionsFor({
      syncManifestAction: syncManifestAction as never,
      readNotesAction: readNotesAction as never,
    });
    return { actions, syncManifestAction, readNotesAction };
  }

  it("passes source and cursor through to the manifest", async () => {
    const { actions, syncManifestAction } = bind();
    await actions.syncManifest({
      workspaceId: "ws1",
      cursor: "c1",
      source: "tree",
    });
    expect(syncManifestAction).toHaveBeenCalledWith({
      workspaceId: "ws1",
      cursor: "c1",
      source: "tree",
    });
  });

  it("sends no undefined fields for a first bucket page", async () => {
    const { actions, syncManifestAction } = bind();
    await actions.syncManifest({ workspaceId: "ws1" });
    expect(syncManifestAction).toHaveBeenCalledWith({ workspaceId: "ws1" });
  });

  it("passes paths through to readNotes", async () => {
    const { actions, readNotesAction } = bind();
    await actions.readNotes({ workspaceId: "ws1", paths: ["a.md"] });
    expect(readNotesAction).toHaveBeenCalledWith({
      workspaceId: "ws1",
      paths: ["a.md"],
    });
  });
});
