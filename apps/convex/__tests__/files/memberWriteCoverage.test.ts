/**
 * The member's edit grant is one door, `writeNote`. This file is the table of
 * everything else: every console write a `member` could reach is refused even
 * when they hold edit on the note and its folder, and no handler but
 * `writeNote` asks for the member path.
 *
 * A new write action that takes the member path has to be added here on
 * purpose; the static check fails until it is.
 *
 * Sabotage (run by hand): pass `memberWrite` from `moveEntry` in
 * `lib/filesFns/entries.ts`: the "static" case and the "moveEntry" row fail.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { DELETE_CONFIRMATION } from "../../functions/lib/fileOps";
import { setAccessRow } from "../../functions/lib/nodes/setAccess";
import { asUser, captureError, errorCode } from "../fixtures.helpers";
import { fixture, share, type Fixture } from "./fixtures.helpers";
import { rowsAuthority } from "./memberEditRows.helpers";

vi.setConfig({ testTimeout: 60_000 });

const NOTE = "1-projects/shared.md";
const FOLDER = "1-projects";
const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = join(HERE, "../../functions");

async function giveReaderEdit(f: Fixture): Promise<void> {
  await rowsAuthority(f.t, f.workspaceId);
  for (const [path, kind] of [[FOLDER, "folder"], [NOTE, "file"]] as const) {
    const answer = await f.t.run((ctx) =>
      setAccessRow(ctx as MutationCtx, {
        workspaceId: f.workspaceId,
        path,
        base: "private",
        grantees: [{ kind: "user", userId: f.reader, role: "edit" }],
        kind,
        actor: { userId: f.owner, role: "owner" },
      }),
    );
    expect(answer).toEqual(expect.objectContaining({ ok: true }));
  }
}

/** Every console write action a member could call, with arguments that name a note and folder they hold edit on. */
const WRITE_ACTIONS: Array<{ name: keyof typeof api.functions.files; args: (f: Fixture) => Record<string, unknown> }> = [
  { name: "createDirectory", args: (f) => ({ workspaceId: f.workspaceId, path: `${FOLDER}/new-folder` }) },
  { name: "moveEntry", args: (f) => ({ workspaceId: f.workspaceId, from: NOTE, to: "2-areas/moved.md" }) },
  { name: "copyEntry", args: (f) => ({ workspaceId: f.workspaceId, from: NOTE, to: "2-areas/copy.md" }) },
  { name: "duplicateEntry", args: (f) => ({ workspaceId: f.workspaceId, path: NOTE }) },
  { name: "archiveEntry", args: (f) => ({ workspaceId: f.workspaceId, path: NOTE }) },
  { name: "trashEntry", args: (f) => ({ workspaceId: f.workspaceId, path: NOTE }) },
  { name: "deleteEntry", args: (f) => ({ workspaceId: f.workspaceId, path: NOTE, confirmation: DELETE_CONFIRMATION }) },
  { name: "removeNoteEncryption", args: (f) => ({ workspaceId: f.workspaceId, path: NOTE, text: "# plain\n" }) },
  { name: "setNoteGroup", args: (f) => ({ workspaceId: f.workspaceId, path: NOTE, group: "anyone" }) },
  { name: "setFolderGroup", args: (f) => ({ workspaceId: f.workspaceId, path: FOLDER, group: "anyone" }) },
  { name: "setNoteVisibility", args: (f) => ({ workspaceId: f.workspaceId, path: NOTE, visibility: "team" }) },
  { name: "setDirectoryVisibility", args: (f) => ({ workspaceId: f.workspaceId, path: FOLDER, visibility: "team" }) },
];

describe("a member's edit grant opens writeNote and nothing else", () => {
  test("the member holds edit on the note and its folder, and still gets INSUFFICIENT_ROLE from every other write", async () => {
    const f = await fixture();
    await share(f);
    await giveReaderEdit(f);

    const reader = asUser(f.t, f.reader) as unknown as { action: (ref: unknown, args: unknown) => Promise<unknown> };
    for (const action of WRITE_ACTIONS) {
      const refused = await captureError(async () => reader.action(api.functions.files[action.name], action.args(f)));
      expect(errorCode(refused), `${String(action.name)} must stay editor-only`).toBe("INSUFFICIENT_ROLE");
    }
  }, 120_000);

  test("writeNote is the one console handler that asks for the member path", () => {
    const callers: string[] = [];
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) visit(full);
        else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) {
          if (/\bmemberWrite\s*:/.test(readFileSync(full, "utf8"))) callers.push(relative(FUNCTIONS_DIR, full));
        }
      }
    };
    visit(FUNCTIONS_DIR);
    // files.ts declares the argument on the query; noteWrites.ts is the one handler that passes it.
    expect(callers.sort()).toEqual(["files.ts", "lib/filesFns/noteWrites.ts"]);
  });
});
