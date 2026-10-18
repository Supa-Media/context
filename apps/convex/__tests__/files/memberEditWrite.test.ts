/**
 * A workspace `member` writes a note through an edit grant on the row that
 * governs it (`lib/nodes/governingRow.ts`), and through nothing else.
 *
 * Every refusal here is the same `INSUFFICIENT_ROLE` a member with no grant
 * gets, so a member cannot tell "no grant" from "a note that does not exist".
 *
 * Sabotage (run by hand; the named tests must fail):
 *  - make `memberMayWrite` return true for any member: "view is refused",
 *    "a note's own list", "private subfolder", "no oracle" fail.
 *  - drop the form-block refusal: "a form block is refused" fails.
 *  - read the grant from the workspace-wide names without the governing row: "a note's own list" fails.
 */

import { describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { setAccessRow } from "../../functions/lib/nodes/setAccess";
import { addMember, asUser, captureError, createWorkspace, errorCode } from "../fixtures.helpers";
import { fixture, share, type Fixture } from "./fixtures.helpers";
import { rowsAuthority } from "./memberEditRows.helpers";

// A fixture copies its bucket into the tree and every test writes through the real actions.
vi.setConfig({ testTimeout: 60_000 });

const NOTE = "1-projects/shared.md";
const FOLDER = "1-projects";

/** Rows mode is the source the grants are read from; the fixture starts in the file source. */
async function rowsMode(f: Fixture): Promise<void> {
  await rowsAuthority(f.t, f.workspaceId);
}

function actor(f: Fixture) {
  return { userId: f.owner, role: "owner" as const };
}

type Grant = "edit" | "view" | null;

/** Set a row's own base and the reader's grant on it, as the owner would in the console. */
async function setRow(
  f: Fixture,
  path: string,
  options: { kind?: "file" | "folder"; base?: "private" | "team" | "inherit"; grant?: Grant; grantee?: Id<"users"> } = {},
): Promise<void> {
  const { kind = "file", base = "private", grant = null, grantee = f.reader } = options;
  const grantees = grant === null ? "inherit" as const : [{ kind: "user" as const, userId: grantee, role: grant }];
  const answer = await f.t.run((ctx) =>
    setAccessRow(ctx as MutationCtx, {
      workspaceId: f.workspaceId,
      path,
      base: grant === null && base === "inherit" ? "inherit" : base,
      grantees,
      kind,
      actor: actor(f),
    }),
  );
  expect(answer).toEqual(expect.objectContaining({ ok: true }));
}

async function etagOf(f: Fixture, path: string): Promise<string> {
  const read = await asUser(f.t, f.owner).action(api.functions.files.readNote, { workspaceId: f.workspaceId, path });
  return read.etag;
}

async function readAsOwner(f: Fixture, path: string): Promise<string> {
  const read = await asUser(f.t, f.owner).action(api.functions.files.readNote, { workspaceId: f.workspaceId, path });
  return read.text;
}

function writeAsReader(f: Fixture, path: string, text: string, expectedEtag?: string) {
  return asUser(f.t, f.reader).action(api.functions.files.writeNote, {
    workspaceId: f.workspaceId,
    path,
    text,
    ...(expectedEtag === undefined ? {} : { expectedEtag }),
  });
}

describe("a member writes through an edit grant on the governing row", () => {
  test("a member with an edit grant on a note writes that note", async () => {
    const f = await fixture();
    await rowsMode(f);
    await setRow(f, NOTE, { grant: "edit" });

    const written = await writeAsReader(f, NOTE, "# Shared\n\nedited by the reader\n", await etagOf(f, NOTE));
    expect(written.kind).toBe("written");
    expect(await readAsOwner(f, NOTE)).toContain("edited by the reader");
  });

  test("a member with only a view grant is refused, and the note is unchanged", async () => {
    const f = await fixture();
    await rowsMode(f);
    await setRow(f, NOTE, { grant: "view" });
    const before = await readAsOwner(f, NOTE);

    const refused = await captureError(async () => writeAsReader(f, NOTE, "# Overwritten\n", await etagOf(f, NOTE)));
    expect(errorCode(refused)).toBe("INSUFFICIENT_ROLE");
    expect(await readAsOwner(f, NOTE)).toBe(before);
  });

  test("a member with an edit grant on a folder writes a note inside it that has no row", async () => {
    const f = await fixture();
    await rowsMode(f);
    await setRow(f, FOLDER, { kind: "folder", grant: "edit" });

    const written = await writeAsReader(f, NOTE, "# Shared\n\nvia the folder\n", await etagOf(f, NOTE));
    expect(written.kind).toBe("written");
  });

  test("a folder edit grant does not let a member create a note in it", async () => {
    const f = await fixture();
    await rowsMode(f);
    await setRow(f, FOLDER, { kind: "folder", grant: "edit" });

    const error = await captureError(async () => writeAsReader(f, `${FOLDER}/brand-new.md`, "# New\n"));
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });

  test("a note's own list replaces its folder's: the folder edit grant does not reach it", async () => {
    const f = await fixture();
    await rowsMode(f);
    await setRow(f, FOLDER, { kind: "folder", grant: "edit" });
    // The note has its own list, naming the reader only to view it.
    await setRow(f, NOTE, { grant: "view" });

    const refused = await captureError(async () => writeAsReader(f, NOTE, "# Nope\n", await etagOf(f, NOTE)));
    expect(errorCode(refused)).toBe("INSUFFICIENT_ROLE");
  });

  test("a private subfolder inside an edit folder refuses the member", async () => {
    const f = await fixture();
    await rowsMode(f);
    await setRow(f, FOLDER, { kind: "folder", grant: "edit" });
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/deep/x.md",
      text: "# Deep\n",
    });
    await setRow(f, "1-projects/deep", { kind: "folder", base: "private" });

    const refused = await captureError(async () =>
      writeAsReader(f, "1-projects/deep/x.md", "# Nope\n", await etagOf(f, "1-projects/deep/x.md")),
    );
    expect(errorCode(refused)).toBe("INSUFFICIENT_ROLE");
  });

  test("a member refused on a note they cannot write gets the answer a path that does not exist gets", async () => {
    const f = await fixture();
    await rowsMode(f);
    const onNote = await captureError(async () => writeAsReader(f, NOTE, "# x\n"));
    const onMissing = await captureError(async () => writeAsReader(f, "1-projects/never-made.md", "# x\n"));
    expect(errorCode(onNote)).toBe(errorCode(onMissing));
    expect(errorCode(onNote)).toBe("INSUFFICIENT_ROLE");
  });

  test("removing the grant ends the write at once", async () => {
    const f = await fixture();
    await rowsMode(f);
    await setRow(f, NOTE, { grant: "edit" });
    const first = await writeAsReader(f, NOTE, "# one\n", await etagOf(f, NOTE));
    expect(first.kind).toBe("written");

    await setRow(f, NOTE, { base: "inherit", grant: null });
    const refused = await captureError(async () => writeAsReader(f, NOTE, "# two\n", await etagOf(f, NOTE)));
    expect(errorCode(refused)).toBe("INSUFFICIENT_ROLE");
  });

  test("a path that walks out of the granted folder is refused, however it is spelled", async () => {
    const f = await fixture();
    await rowsMode(f);
    await setRow(f, FOLDER, { kind: "folder", grant: "edit" });
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "2-areas/elsewhere.md",
      text: "# Elsewhere\n",
    });
    for (const sneaky of ["1-projects/../2-areas/elsewhere.md", "1-projects//../2-areas/elsewhere.md", "1-projects/./../2-areas/elsewhere.md"]) {
      const refused = await captureError(async () =>
        writeAsReader(f, sneaky, "# Overwritten\n", await etagOf(f, "2-areas/elsewhere.md")),
      );
      expect(errorCode(refused), sneaky).toBe("INSUFFICIENT_ROLE");
    }
    expect(await readAsOwner(f, "2-areas/elsewhere.md")).toContain("Elsewhere");
  });

  test("a form block is refused to a member even with an edit grant", async () => {
    const f = await fixture();
    await rowsMode(f);
    await setRow(f, NOTE, { grant: "edit" });
    const withForm = "# Shared\n\n```form\nname: Intake\nresponses: 1-projects/shared-responses.md\n```\n";

    const refused = await captureError(async () => writeAsReader(f, NOTE, withForm, await etagOf(f, NOTE)));
    expect(errorCode(refused)).toBe("INSUFFICIENT_ROLE");
  });

  test("an editor writes a note they hold no grant on, as before", async () => {
    const f = await fixture();
    // The folder is shared with the team, so the editor can see the note; nothing else is granted.
    await share(f);
    const written = await asUser(f.t, f.editor).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: NOTE,
      text: "# From the editor\n",
      expectedEtag: await etagOf(f, NOTE),
    });
    expect(written.kind).toBe("written");
  });
});

describe("isolation: another workspace's edit grant never applies here", () => {
  test("the reader's edit grant in another workspace does not open this workspace's note", async () => {
    const f = await fixture();
    await rowsMode(f);
    // In this workspace the reader may only view the note.
    await setRow(f, NOTE, { grant: "view" });

    // Another workspace, where the reader holds edit on a row at the same path.
    const elsewhere = await createWorkspace(f.t, f.stranger, "elsewhere-two");
    await addMember(f.t, elsewhere, f.reader, "member", f.stranger);
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodes", { workspaceId: elsewhere, path: NOTE, name: "shared.md", kind: "file", observedAt: 1 });
    });
    await f.t.run((ctx) =>
      setAccessRow(ctx as MutationCtx, {
        workspaceId: elsewhere as Id<"workspaces">,
        path: NOTE,
        base: "private",
        grantees: [{ kind: "user", userId: f.reader, role: "edit" }],
        actor: { userId: f.stranger, role: "owner" },
      }),
    );

    const refused = await captureError(async () => writeAsReader(f, NOTE, "# Cross\n", await etagOf(f, NOTE)));
    expect(errorCode(refused)).toBe("INSUFFICIENT_ROLE");
  });
});
