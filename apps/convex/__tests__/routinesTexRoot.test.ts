import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { FileOperation, OperationResult } from "../functions/lib/filesFns/operationTypes";
import { routinePathsTouched } from "../functions/lib/routines/changes";
import { MAX_ROUTINES_PER_WORKSPACE } from "../functions/lib/routines/model";
import { routinePathsOf } from "../functions/lib/routines/sync";
import { asUser, copyTree } from "./fixtures.helpers";
import { DAILY, DAILY_TEXT, due, makeDue, routineFixture, rowAt, rows, signal } from "./routines.helpers";

/**
 * ROUTINES IN TEX'S OWN FOLDER: `tex/routines/<how-often>/<name>.md`.
 *
 * The owner decided on 2026-10-14 that new routines go in `tex/routines/`
 * and that every `routines/` note keeps running exactly as before, with
 * nothing moved for anyone (`docs/decisions/routines.md`). So a scan lists
 * both roots every time, counts both toward one cap, and a move from one to
 * the other is picked up like any move. The old root's tests
 * (`routinesSync`, `routinesRuns`, `routinesHistory`, `routinesOnce`) are
 * unchanged.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted (2026-10-14).
 *
 *   `ROUTINE_SCAN_ROOTS` without `tex/routines` (the scan lists only the old root)
 *     → "a tex/routines/ note is scheduled, beside a routines/ one" and
 *       "a move from routines/ to tex/routines/ is picked up like any move" fail
 *   `ROUTINE_SCAN_ROOTS` listing the new root first
 *     → "both roots count toward one cap, the old root's routines first" fails
 *     (a per-root cap in the scan alone fails nothing: the commit caps the
 *     rows at `MAX_ROUTINES_PER_WORKSPACE` too, in scan order)
 *   `routineRunsKey` giving the new root the old prefix
 *     → "a tex/routines/ note's runs are its own, never its routines/ twin's" fails
 *   `isRoutinePath` without the ancestor case (`tex` alone not a routine path)
 *     → "moving or trashing the tex folder re-reads the roots" fails
 */

vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllGlobals();
});

const TEX_DAILY = "tex/routines/daily/standup.md";
const TEX_TEXT = "---\nat: 6:15 am\n---\nSay what Tex's own routine says.\n";

describe("a scan reads both roots", () => {
  test("a tex/routines/ note is scheduled, beside a routines/ one", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    f.backend.seed(TEX_DAILY, TEX_TEXT);
    f.backend.seed("tex/about-me.md", "# About me\n");
    f.backend.seed("tex/routines/loose.md", "Not in a schedule folder.\n");
    // A signal naming only the new root still re-reads both.
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: [TEX_DAILY] });

    const found = await rows(f.t, f.workspaceId);
    expect(found.map((row) => row.path).sort()).toEqual([DAILY, TEX_DAILY]);
    expect(await rowAt(f.t, f.workspaceId, TEX_DAILY)).toMatchObject({
      writerUserId: f.editor,
      writerSource: "signal",
      cadence: { unit: "day", every: 1 },
      at: { hour: 6, minute: 15 },
    });
    // The old one is untouched by the new root: found with no signal, it runs as the owner, as before.
    expect(await rowAt(f.t, f.workspaceId, DAILY)).toMatchObject({ writerUserId: f.owner, at: { hour: 7, minute: 30 } });
    // Metadata only, in the new root as in the old.
    expect(JSON.stringify(found)).not.toContain("Tex's own routine says");

    await makeDue(f.t, f.workspaceId, TEX_DAILY);
    await makeDue(f.t, f.workspaceId, DAILY);
    const runs = await due(f.t);
    expect(runs.map((run) => run.path).sort()).toEqual([DAILY, TEX_DAILY]);
  });

  test("a move from routines/ to tex/routines/ is picked up like any move", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.owner, paths: [DAILY] });
    expect((await rows(f.t, f.workspaceId)).map((row) => row.path)).toEqual([DAILY]);

    f.backend.objects.delete(DAILY);
    f.backend.seed("tex/routines/weekly/standup.md", DAILY_TEXT);
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: [DAILY, "tex/routines/weekly/standup.md"] });
    const after = await rows(f.t, f.workspaceId);
    expect(after.map((row) => row.path)).toEqual(["tex/routines/weekly/standup.md"]);
    expect(after[0]).toMatchObject({ writerUserId: f.editor, cadence: { unit: "week", every: 1 } });

    // And back again.
    f.backend.objects.delete("tex/routines/weekly/standup.md");
    f.backend.seed(DAILY, DAILY_TEXT);
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: ["tex/routines/weekly/standup.md", DAILY] });
    expect((await rows(f.t, f.workspaceId)).map((row) => row.path)).toEqual([DAILY]);
  });

  test("moving or trashing the tex folder re-reads the roots", async () => {
    const f = await routineFixture();
    f.backend.seed(TEX_DAILY, TEX_TEXT);
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: [TEX_DAILY] });
    expect(await rows(f.t, f.workspaceId)).toHaveLength(1);

    f.backend.objects.delete(TEX_DAILY);
    f.backend.seed("4-archive/tex/routines/daily/standup.md", TEX_TEXT);
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: ["tex", "4-archive/tex"] });
    expect(await rows(f.t, f.workspaceId)).toEqual([]);
  });

  test("both roots count toward one cap, the old root's routines first", async () => {
    const f = await routineFixture();
    const old = MAX_ROUTINES_PER_WORKSPACE - 5;
    for (let i = 0; i < old; i += 1) f.backend.seed(`routines/daily/r${String(i).padStart(3, "0")}.md`, "Say hi.\n");
    for (let i = 0; i < 10; i += 1) f.backend.seed(`tex/routines/daily/t${i}.md`, "Say hi.\n");
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.owner, paths: ["routines/daily/r000.md"] });

    const found = await rows(f.t, f.workspaceId);
    expect(found).toHaveLength(MAX_ROUTINES_PER_WORKSPACE);
    expect(found.filter((row) => row.path.startsWith("routines/"))).toHaveLength(old);
    expect(found.filter((row) => row.path.startsWith("tex/routines/"))).toHaveLength(5);
  });
});

describe("a tex/routines/ note's runs", () => {
  test("a tex/routines/ note's runs are its own, never its routines/ twin's", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    f.backend.seed(TEX_DAILY, TEX_TEXT);
    const history = (text: string) => JSON.stringify({ version: 1, runs: [{ at: 1_700_000_000_000, outcome: "answered", text }] });
    f.backend.seed(".context/agent/routines/daily/standup.json", history("from the old one"));
    f.backend.seed(".context/agent/tex/routines/daily/standup.json", history("from the new one"));
    // Whether a routine exists is the tree's to say, so the bucket is copied into it first.
    await copyTree(f.t, f.workspaceId);
    const runsFor = (path: string) =>
      asUser(f.t, f.owner).action(api.functions.routines.routineRuns, { workspaceId: f.workspaceId, path });
    expect((await runsFor(TEX_DAILY)).map((run) => run.text)).toEqual(["from the new one"]);
    expect((await runsFor(DAILY)).map((run) => run.text)).toEqual(["from the old one"]);
  });
});

describe("which paths are routine paths", () => {
  const written = { kind: "written" } as unknown as OperationResult;
  test("either root, either side of a move, and the tex folder, never a note beside it", () => {
    const move = { kind: "move", from: DAILY, to: TEX_DAILY } as FileOperation;
    const moved = { kind: "moved", from: DAILY, to: TEX_DAILY } as unknown as OperationResult;
    expect(routinePathsTouched(move, moved)).toEqual([DAILY, TEX_DAILY]);
    expect(routinePathsTouched({ kind: "write", path: TEX_DAILY, text: "" } as FileOperation, written)).toEqual([TEX_DAILY]);
    expect(routinePathsTouched({ kind: "write", path: "tex/about-me.md", text: "" } as FileOperation, written)).toEqual([]);
    expect(routinePathsTouched({ kind: "trash", path: "tex" } as FileOperation, written)).toEqual(["tex"]);
    expect(routinePathsTouched({ kind: "write", path: "1-projects/tex/routines/daily/x.md", text: "" } as FileOperation, written)).toEqual([]);
    expect(routinePathsOf(["tex/about-me.md", "tex/routines/once/x.md", "texas/routines/daily/x.md"])).toEqual(["tex/routines/once/x.md"]);
  });
});
