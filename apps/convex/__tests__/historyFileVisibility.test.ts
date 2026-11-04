/**
 * The person's own Tex history file (`tex/history.ledger.json`) can be shared on its own (owner, 2026-11-04: "i
 * don't want to give you private access to everything, just this file"). It is the one non-Markdown file that
 * takes a visibility of its own; any other file, and a group chat's history file, is still refused.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { scanAccessRows } from "../functions/lib/nodes/accessRows";
import { renderAccess } from "../functions/lib/nodes/rowAccess";
import { canSee } from "../functions/lib/privacy";
import { asUser, readIntoTree } from "./fixtures.helpers";
import { fixture } from "./website.helpers";
import { takesOwnVisibility } from "../functions/lib/filesFns/visibility";

vi.setConfig({ testTimeout: 30_000 });

afterEach(() => vi.unstubAllGlobals());

const MARKER = '{"tex-history-view":1}';

describe("the person's own history file takes its own visibility", () => {
  test("only Markdown and the person's own history file", () => {
    expect(takesOwnVisibility("notes/plan.md")).toBe(true);
    expect(takesOwnVisibility("tex/history.ledger.json")).toBe(true);
    expect(takesOwnVisibility("tex/groups/orbit-lamp-river/history.ledger.json")).toBe(false);
    expect(takesOwnVisibility("projects/history.ledger.json")).toBe(false);
    expect(takesOwnVisibility("tex/data.json")).toBe(false);
  });

  test("the owner opens it to the team, and a team reader's rules then show it", async () => {
    const f = await fixture();
    f.backend.seed("tex/history.ledger.json", MARKER);
    f.backend.seed("tex/about.md", "# About\n");
    await readIntoTree(f.t, f.workspaceId);

    const result = await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "tex/history.ledger.json",
      visibility: "team",
    });
    expect(result.visibility).toBe("team");

    const rows = await f.t.run(async (ctx) => await scanAccessRows(ctx, f.workspaceId));
    const { rules, overrides } = renderAccess(rows, "member");
    const seen = (path: string) => canSee(path, "team", rules, overrides, new Set<string>());
    expect(seen("tex/history.ledger.json")).toBe(true);
    // Nothing else in the Tex folder moved with it.
    expect(seen("tex/about.md")).toBe(seen("tex/other.md"));
  });

  test("any other non-Markdown file is still refused", async () => {
    const f = await fixture();
    f.backend.seed("tex/data.json", "{}");
    await readIntoTree(f.t, f.workspaceId);
    await expect(
      asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
        workspaceId: f.workspaceId,
        path: "tex/data.json",
        visibility: "team",
      }),
    ).rejects.toThrow(/Only markdown notes/);
  });
});
