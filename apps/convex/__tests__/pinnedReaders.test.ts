/**
 * TEAM IN `@context-lc` MEANS ITS REAL MEMBERS (decided by the owner, 2026-10-19;
 * `docs/decisions/privacy-and-sharing/all-context-users.md`). Somebody who reaches the pinned workspace through the
 * pin alone reads it as a guest: the notes opened to All Context users (the `accounts` grantee) and nothing else.
 *
 * The claims, each tested through the read path a real caller takes rather than through the helper underneath:
 *
 *  - **A pin reader sees the All Context users notes and nothing else**: not a team note, not a private one, not a
 *    bug report, through the bucket read, the listing, the tree feed, search, the gateway's tree routes, or the
 *    rules the gateway is handed with the binding.
 *  - **A real member keeps team**, and also reads every All Context users note, the bug reports included; their
 *    MCP connection, which holds no granted names, reads a note under a folder that was in the old Members position.
 *  - **A pin reader can still answer the pinned forms.**
 *  - **Nothing goes dark before the migration**: until it has run, a pin reader reads exactly as before.
 *
 * Every value here is fake. This repository is public.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `pinReaderNames` answering `[]` after the migration (`lib/pinnedReaders.ts`). → "sees the All Context users
 *     notes and nothing else" fails: the pin reader reads every team note.
 *  2. `canSee` letting `team` through for `READS_AS_GUEST` (`lib/privacy.ts`). → caught in `nodes/accountsGrantee.test.ts`
 *     ("the guest mark shuts team even under a member's rules"), since every path here renders a guest's rules.
 *  3. `readerAudience` answering `member` for every pass (`fileOperationBarrier.ts`). → "reads a guide's body"
 *     fails: the guide is hidden, since a member's rules render it `team` and the mark shuts that.
 *  4. `listFolderFromNodes` reading a member's view for everybody (`lib/nodes/listing.ts`). → "the listing" fails.
 *  5. `openStorageBinding` dropping `audience` (`controlPlane.ts`). → "the binding hands the gateway a guest's
 *     rules" fails.
 *  6. `liveGrants` giving the pinned row no names for a non-console client. → "an MCP session carries the guest
 *     mark" fails.
 *  7. `pinReadersAreGuests` ignoring `pinnedAccountsAt` (`lib/pinnedReaders.ts`). → "before the migration" fails.
 *  8. `gatewayReadClearance` dropping the names (`lib/nodes/gatewayManifest.ts`). → "the gateway's tree manifest"
 *     fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { asUser, captureError, errorCode, gatewayPost } from "./fixtures.helpers";
import { indexBucket } from "./blendedSearch.helpers";
import { READS_AS_GUEST_NAME } from "../functions/lib/pinnedReaders";
import {
  BENCH,
  FORM,
  GUIDE,
  MEL_TOKEN,
  OLD_BUG,
  PLAN,
  RESPONSES,
  SAYO_TOKEN,
  SECRET,
  WORD,
  clearanceOf,
  migrate,
  pinnedWorld,
  sessionEntry,
  setRow,
  visibleTo,
  visibleToPerson,
} from "./pinnedReaders.helpers";

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const OPEN_TO_ACCOUNTS = [FORM, GUIDE, RESPONSES].sort();

describe("before the migration", () => {
  test("a pin reader reads as they always did: at team, with no names", async () => {
    const w = await pinnedWorld();
    expect(await clearanceOf(w, w.sayo)).toMatchObject({ scope: "team", grantedNames: [] });
    // The Members position keeps the plan and the Areas folder from them, exactly as on the day #1912 shipped.
    expect(await visibleToPerson(w, w.sayo)).toEqual([...OPEN_TO_ACCOUNTS, OLD_BUG].sort());
    expect((await sessionEntry(w, SAYO_TOKEN))?.grantedNames).toBeUndefined();
  });

  test("a real member's MCP connection, holding no names, cannot read under the Members folder yet", async () => {
    const w = await pinnedWorld();
    const entry = await sessionEntry(w, MEL_TOKEN);
    expect(entry).toMatchObject({ role: "member" });
    expect(await visibleTo(w, "team", entry?.grantedNames)).not.toContain(BENCH);
  });
});

describe("after the migration, a pin reader", () => {
  test("sees the All Context users notes and nothing else", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const clearance = await clearanceOf(w, w.sayo);
    expect(clearance.scope).toBe("team");
    expect(clearance.grantedNames).toContain(READS_AS_GUEST_NAME);
    expect(await visibleToPerson(w, w.sayo)).toEqual(OPEN_TO_ACCOUNTS);
  });

  test("reads a guide's body, and is told every other note does not exist", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const { scope, grantedNames } = await clearanceOf(w, w.sayo);
    const read = (path: string) =>
      w.t.action(internal.functions.files.runFileOperation, { workspaceId: w.pinned, scope, grantedNames, operation: { kind: "read", path } });
    expect(JSON.stringify(await read(GUIDE))).toContain(WORD);
    for (const path of [PLAN, SECRET, BENCH, OLD_BUG]) {
      expect(errorCode(await captureError(() => read(path))), path).toBe("FILE_NOT_FOUND");
    }
  });

  test("the listing shows them the guides and no other folder's notes", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const sayo = asUser(w.t, w.sayo);
    const root = await sayo.query(api.functions.nodesListing.listFolder, { workspaceId: w.pinned, path: "" });
    const names = (root?.entries ?? []).map((entry) => entry.name).sort();
    expect(names).toContain("guides");
    expect(names).not.toContain("1-projects");
    expect(names).not.toContain("areas");
    const areas = await sayo.query(api.functions.nodesListing.listFolder, { workspaceId: w.pinned, path: "areas" });
    expect((areas?.entries ?? []).map((entry) => entry.name)).toEqual([]);
    const projects = await sayo.query(api.functions.nodesListing.listFolder, { workspaceId: w.pinned, path: "1-projects" });
    expect((projects?.entries ?? []).map((entry) => entry.name)).toEqual([]);
  });

  test("search finds the guides and nothing under a team or private row", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    await indexBucket(w.t, w.pinned);
    const { scope, grantedNames } = await clearanceOf(w, w.sayo);
    const found = await w.t.action(internal.functions.files.runFileOperation, {
      workspaceId: w.pinned,
      scope,
      grantedNames,
      operation: { kind: "search", query: WORD, refreshOnMiss: true },
    });
    const paths = found.kind === "searchResults" ? found.hits.map((hit) => hit.path).sort() : [];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(OPEN_TO_ACCOUNTS).toContain(path);
    // And the same index answers a member with the rest, so the empty answer above is the clearance, not the index.
    const member = await clearanceOf(w, w.mel);
    const theirs = await w.t.action(internal.functions.files.runFileOperation, {
      workspaceId: w.pinned,
      scope: member.scope,
      grantedNames: member.grantedNames,
      operation: { kind: "search", query: WORD, refreshOnMiss: true },
    });
    expect(theirs.kind === "searchResults" ? theirs.hits.map((hit) => hit.path) : []).toContain(BENCH);
  });

  test("an MCP session carries the guest mark for the pinned workspace, for an ordinary AI client too", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const entry = await sessionEntry(w, SAYO_TOKEN);
    expect(entry).toMatchObject({ role: "member" });
    expect(entry?.grantedNames).toContain(READS_AS_GUEST_NAME);
    expect(await visibleTo(w, "team", entry?.grantedNames)).toEqual(OPEN_TO_ACCOUNTS);
  });

  test("the binding hands the gateway a guest's rules, where no row is team", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const opened = (await (
      await gatewayPost(w.t, "/gateway/binding", { accessToken: SAYO_TOKEN, expectedWorkspaceId: w.pinned })
    ).json()) as { privacy?: { folders: Array<{ visibility: string }>; notes: Array<{ visibility: string }> } };
    expect(opened.privacy).toBeDefined();
    const visibilities = [...opened.privacy!.folders, ...opened.privacy!.notes].map((rule) => rule.visibility);
    expect(visibilities).not.toContain("team");
    const member = (await (
      await gatewayPost(w.t, "/gateway/binding", { accessToken: MEL_TOKEN, expectedWorkspaceId: w.pinned })
    ).json()) as { privacy?: { folders: Array<{ visibility: string }> } };
    expect(member.privacy?.folders.map((rule) => rule.visibility)).toContain("team");
  });

  test("the gateway's tree manifest lists the guides and nothing else", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const answer = (await (
      await gatewayPost(w.t, "/gateway/tree/manifest", { accessToken: SAYO_TOKEN, expectedWorkspaceId: w.pinned })
    ).json()) as { served?: boolean; entries?: Array<{ path: string }> };
    expect(answer.served).toBe(true);
    const paths = (answer.entries ?? []).map((entry) => entry.path).sort();
    // The response file sits in `guides/` beside the form, and is an ordinary note with its own rule (forms.md, "The
    // block declares the path, never the visibility"). It inherits `guides/`' All Context users grant, so `canSee`
    // answers it open to the pin reader, as the read-path test above does (`OPEN_TO_ACCOUNTS`). The manifest used to
    // leave it out at 15bbebb (the file was in the bucket then too; why the old listing skipped it is not established).
    // The expectation follows the rules, not that listing.
    expect(paths).toEqual(OPEN_TO_ACCOUNTS);
  });

  test("can still answer the bug-report form", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const answered = await asUser(w.t, w.sayo).action(api.functions.forms.submitForm, {
      workspaceId: w.pinned,
      path: FORM,
      values: [{ field: "summary", value: "the guide link is broken" }],
    });
    expect(answered).toMatchObject({ formId: "bugs", responsesPath: RESPONSES });
  });

  test("a note written at team after the migration stays with the members", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    await setRow(w, SECRET, "team");
    expect(await visibleToPerson(w, w.sayo)).not.toContain(SECRET);
    expect(await visibleToPerson(w, w.mel)).toContain(SECRET);
  });
});

describe("after the migration, a real member", () => {
  test("keeps team, and reads every note but the private one", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const clearance = await clearanceOf(w, w.mel);
    expect(clearance.grantedNames).not.toContain(READS_AS_GUEST_NAME);
    expect(await visibleToPerson(w, w.mel)).toEqual([...OPEN_TO_ACCOUNTS, BENCH, OLD_BUG, PLAN].sort());
  });

  test("an ordinary MCP session, holding no names, reads a note under the folder that was in the Members position", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const entry = await sessionEntry(w, MEL_TOKEN);
    expect(entry?.grantedNames ?? []).toEqual([]);
    const seen = await visibleTo(w, "team", entry?.grantedNames);
    expect(seen).toContain(BENCH);
    expect(seen).toContain(PLAN);
    expect(seen).not.toContain(SECRET);
  });
});
