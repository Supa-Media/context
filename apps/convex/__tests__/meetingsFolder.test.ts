/**
 * Where meetings land, as a setting rather than a constant.
 *
 * The gap this closes: a Google account carries an editable destination per
 * service and forwarded mail carries a target folder, while a meeting carried
 * `MEETINGS_FOLDER` — a constant, interpolated into a sentence on the settings
 * panel, with no control beside it and no setter anywhere in the codebase.
 *
 * What it deliberately does NOT change is whether the destination is asked
 * for. `features/meetings/destination.ts` asks before every recording and
 * still does; this names the folder the first offer points at. Those are two
 * decisions, and conflating them is why the setting did not exist.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   accept any string instead of normalizeMeetingFolder        1
 *   store the default's spelling rather than clearing          1
 *   drop the personal-only gate                                1
 *
 * The first row is one test rather than six because the six refusals live in a
 * single test that asserts them together — which is the right grouping (they
 * are one rule, `normalizeMeetingFolder`, asked six ways) and worth noting so
 * the number is not read as thin coverage.
 */

import { describe, expect, test } from "vitest";

import { api } from "../_generated/api";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

const DEFAULT_FOLDER = "0-inbox/meetings";

async function workspace() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  return { t, owner, workspaceId };
}

async function folderOf(t: Awaited<ReturnType<typeof workspace>>["t"], slug: string) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .collect(),
  );
  return rows[0]?.meetingsFolder;
}

describe("choosing where meetings land", () => {
  test("a context that has never chosen carries nothing, so the default can move", async () => {
    const { t } = await workspace();
    // Absent, not "0-inbox/meetings": a stored spelling of the default would
    // stop following it, pinning somebody who never expressed a preference.
    expect(await folderOf(t, "atlas")).toBeUndefined();
  });

  test("an owner can choose one", async () => {
    const { t, owner, workspaceId } = await workspace();
    const result = await asUser(t, owner).mutation(api.functions.workspaces.setMeetingsFolder, {
      workspaceId,
      folder: "2-areas/meetings",
    });
    expect(result).toEqual({ folder: "2-areas/meetings" });
    expect(await folderOf(t, "atlas")).toBe("2-areas/meetings");
  });

  test("...and clear it again, which stores nothing rather than the default", async () => {
    const { t, owner, workspaceId } = await workspace();
    await asUser(t, owner).mutation(api.functions.workspaces.setMeetingsFolder, {
      workspaceId,
      folder: "2-areas/meetings",
    });
    const result = await asUser(t, owner).mutation(api.functions.workspaces.setMeetingsFolder, {
      workspaceId,
      folder: null,
    });
    expect(result).toEqual({ folder: DEFAULT_FOLDER });
    expect(await folderOf(t, "atlas")).toBeUndefined();
  });

  test("the folder the gateway would refuse is refused here", async () => {
    const { t, owner, workspaceId } = await workspace();
    const refuse = async (folder: string) =>
      errorCode(
        await captureError(() =>
          asUser(t, owner).mutation(api.functions.workspaces.setMeetingsFolder, {
            workspaceId,
            folder,
          }),
        ),
      );

    /*
      Every one of these is a folder `normalizeMeetingFolder` answers `null`
      for, which means the meeting write would reject it. A setting that saves
      a folder the gateway will not honour is a control that appears to work
      and files somewhere else — the exact defect that module exists to close.
    */
    expect(await refuse("")).toBe("MEETINGS_FOLDER_INVALID");
    expect(await refuse("/")).toBe("MEETINGS_FOLDER_INVALID");
    expect(await refuse(".plumbing/meetings")).toBe("MEETINGS_FOLDER_INVALID");
    expect(await refuse("2-areas/../../etc")).toBe("MEETINGS_FOLDER_INVALID");
    expect(await refuse("2-areas/a..b")).toBe("MEETINGS_FOLDER_INVALID");
    expect(await refuse("1-projects/board.md")).toBe("MEETINGS_FOLDER_INVALID");

    // And none of it was written.
    expect(await folderOf(t, "atlas")).toBeUndefined();
  });

  test("a shared workspace has no such setting, because nothing would read it", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas-team", { kind: "shared" });
    // Meetings are offered your own workspace first; a shared one is the *second*
    // offer and takes its folder from the page you are standing on.
    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.workspaces.setMeetingsFolder, {
        workspaceId,
        folder: "2-areas/meetings",
      }),
    );
    expect(errorCode(error)).toBe("MEETINGS_FOLDER_NOT_PERSONAL");
  });

  test("a member cannot choose where an owner's meetings land", async () => {
    const { t, owner, workspaceId } = await workspace();
    const stranger = await createUser(t, "stranger@example.invalid");
    const error = await captureError(() =>
      asUser(t, stranger).mutation(api.functions.workspaces.setMeetingsFolder, {
        workspaceId,
        folder: "2-areas/meetings",
      }),
    );
    expect(errorCode(error)).toBeDefined();
    expect(await folderOf(t, "atlas")).toBeUndefined();
  });

  test("the choice reaches the console on the workspace list", async () => {
    const { t, owner, workspaceId } = await workspace();
    await asUser(t, owner).mutation(api.functions.workspaces.setMeetingsFolder, {
      workspaceId,
      folder: "2-areas/meetings",
    });
    const [summary] = await asUser(t, owner).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    expect(summary?.meetingsFolder).toBe("2-areas/meetings");
  });
});
