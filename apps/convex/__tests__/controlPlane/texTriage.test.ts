/**
 * tex.lc/admin's triage desk (`functions/texDashboard.ts`,
 * `lib/adminFns/texTriage.ts`): the bug reports, reviews and named problems
 * listed from the pinned context's rows, and a report read, commented on,
 * sent to be fixed or retired, only by staff who are on that context.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `deskOf` skipping the membership check. → "staff who are not on the
 *     pinned context see nothing and open nothing" fails.
 *  2. `onTheDesk` accepting any path. → "the desk opens bug reports and
 *     reviews, and nothing else" fails.
 *  3. `act` asking `authorizeFileAccess` for `member` instead of `editor`. →
 *     "a member who only views may read a report but not act on it" fails.
 *  4. `withStatus` appending a second `status:` line. → "sending a report to
 *     triage…" fails: the old status is still there.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";

vi.setConfig({ testTimeout: 30_000 });

import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { listOf, onTheDesk, stampOf, themeRowOf, triageFolders, withStatus } from "../../functions/lib/adminFns/texTriage";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { LEGACY_PARA_FOLDERS } from "../../functions/lib/scaffold";
import { memoryS3, type MemoryS3 } from "../storeStub.helpers";
import { addMember, asUser, createUser, createWorkspace, readIntoTree, seedStorageBinding, setupTest, type TestConvex } from "../fixtures.helpers";
import { renderPrivacyManifestForFolders } from "../seededRules.helpers";

const PINNED_BUCKET = "pinned-context";
const BUG = "areas/tex-bugs/team/2026-10-24 1200 calendar made two events abc123.md";
const USER_BUG = "areas/tex-bugs/user/2026-10-23 0900 blank reply def456.md";
const REVIEW = "areas/tex-reviews/2026-10-24 1830 calm 2 0a1b2c.md";
const THEME = "areas/tex-reviews/themes/note-saves-time-out.md";
const SCORES = "areas/tex-reviews/scores/2026-10-24.md";

let backend: MemoryS3;

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid other-staff@example.invalid alice@example.invalid");
  backend = memoryS3(PINNED_BUCKET);
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => await backend.fetchImpl(input, init));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function world() {
  const t: TestConvex = setupTest();
  const staff = await createUser(t, "staff@example.invalid");
  const otherStaff = await createUser(t, "other-staff@example.invalid");
  const alice = await createUser(t, "alice@example.invalid");
  const pinned = await createWorkspace(t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
  backend.seed(PRIVACY_KEY, renderPrivacyManifestForFolders(LEGACY_PARA_FOLDERS));
  backend.seed("index.md", "# Context\n");
  backend.seed("areas/README.md", "# Areas\n");
  backend.seed(BUG, "---\nstatus: open\nsource: texts\nfiled: 2026-10-24T12:00:00.000Z\nreporter: team\ntexts: shared\n---\n\n# Calendar made two events\n\n```text\nit booked lunch twice\n```\n");
  backend.seed(USER_BUG, "---\nstatus: open\nreporter: user\ntexts: not shared\n---\n\n# Blank reply\n");
  backend.seed(REVIEW, "---\nstatus: new\ntask: notes\nsignals: [\"try_again\",\"gave_up\"]\naverage: 3.4\ntheme: note-saves-time-out\n---\n\n# Saving a long note failed\n");
  backend.seed(THEME, "---\nstatus: shipped\nsignals: [try_again]\ntasks: notes\nprs: [\"#2154\"]\nmerged: 2026-10-24\nfix_thread: Fix Tex note saves timing out\n---\n\n# Note saves time out\n");
  backend.seed("areas/tex-reviews/themes/README.md", "# Named problems\n");
  backend.seed("areas/tex-bugs/README.md", "# Bugs\n");
  backend.seed(SCORES, "---\nday: 2026-10-24\n---\n\n# Scores\n");
  backend.seed("areas/secret.md", "# Not on the desk\n");
  await seedStorageBinding(t, { workspaceId: pinned, boundBy: staff, bucket: PINNED_BUCKET });
  await readIntoTree(t, pinned);
  return { t, staff, otherStaff, alice, pinned };
}

async function noteText(t: TestConvex, workspaceId: Id<"workspaces">, path: string): Promise<string> {
  const result = await t.action(internal.functions.files.runFileOperation, { workspaceId, scope: "private", operation: { kind: "read", path } });
  return result.kind === "file" ? result.text : "";
}

describe("what the desk lists", () => {
  test("bug reports, reviews and named problems, from the rows", async () => {
    const { t, staff } = await world();
    const desk = await asUser(t, staff).query(api.functions.texDashboard.triage, {});
    if (!desk.available) throw new Error(`desk unavailable: ${desk.reason}`);
    expect(desk.bugs.map((bug) => bug.path).sort()).toEqual([BUG, USER_BUG]);
    const bug = desk.bugs.find((row) => row.path === BUG)!;
    expect(bug).toMatchObject({ status: "open", reporter: "team", textsShared: true, title: "Calendar made two events", filed: Date.UTC(2026, 9, 24, 12) });
    expect(desk.reviews.map((review) => review.path)).toEqual([REVIEW]);
    expect(desk.reviews[0]).toMatchObject({ task: "notes", signals: ["try_again", "gave_up"], theme: "note-saves-time-out", average: 3.4 });
    // The folders' own READMEs are about the folder, not a report or a problem.
    expect(desk.themes).toHaveLength(1);
    expect(desk.themes[0]).toMatchObject({ slug: "note-saves-time-out", name: "Note saves time out", status: "shipped", prs: [2154], signals: ["try_again"], tasks: ["notes"] });
    expect(desk.themes[0]!.merged).toBe(Date.UTC(2026, 9, 24));
  });

  test("staff who are not on the pinned context see nothing and open nothing", async () => {
    const { t, otherStaff } = await world();
    expect(await asUser(t, otherStaff).query(api.functions.texDashboard.triage, {})).toEqual({ available: false, reason: "not_a_member" });
    await expect(asUser(t, otherStaff).action(api.functions.texDashboard.readNote, { path: BUG })).rejects.toThrow();
  });

  test("a member who is not staff is refused", async () => {
    const { t, staff, pinned } = await world();
    const bob = await createUser(t, "bob@example.invalid");
    await addMember(t, pinned, bob, "editor", staff);
    await expect(asUser(t, bob).query(api.functions.texDashboard.triage, {})).rejects.toThrow();
    await expect(asUser(t, bob).action(api.functions.texDashboard.act, { path: BUG, action: "retire" })).rejects.toThrow();
  });
});

describe("reading and acting on a report", () => {
  test("the desk opens bug reports and reviews, and nothing else", async () => {
    const { t, staff } = await world();
    const read = await asUser(t, staff).action(api.functions.texDashboard.readNote, { path: BUG });
    expect(read.text).toContain("it booked lunch twice");
    for (const path of ["areas/secret.md", "areas/tex-bugs/../secret.md", "areas/tex-bugsy/x.md", "index.md"]) {
      await expect(asUser(t, staff).action(api.functions.texDashboard.readNote, { path })).rejects.toThrow();
      await expect(asUser(t, staff).action(api.functions.texDashboard.act, { path, action: "comment", comment: "hi" })).rejects.toThrow();
    }
  });

  test("sending a report to triage sets its status and mails the triage agent", async () => {
    const { t, staff, pinned } = await world();
    expect(await asUser(t, staff).action(api.functions.texDashboard.act, { path: BUG, action: "triage", comment: "Check the calendar retry." })).toEqual({ status: "triage" });
    const text = await noteText(t, pinned, BUG);
    expect(text).toMatch(/^---\nstatus: triage\n/);
    expect(text.match(/^status:/gm)).toHaveLength(1);
    expect(text).toMatch(/to triage: Please triage this and start a fix\. Check the calendar retry\./);
    const read = await asUser(t, staff).action(api.functions.texDashboard.readNote, { path: BUG });
    expect(read.text).not.toContain("```mail");
    expect(read.mail).toHaveLength(1);
    expect(read.mail[0]).toMatchObject({ to: "triage" });
  });

  test("a comment adds mail and leaves the status; retiring needs no comment", async () => {
    const { t, staff, pinned } = await world();
    await asUser(t, staff).action(api.functions.texDashboard.act, { path: REVIEW, action: "comment", comment: "Same as the long-note fix?" });
    expect(await noteText(t, pinned, REVIEW)).toContain("status: new");
    await expect(asUser(t, staff).action(api.functions.texDashboard.act, { path: REVIEW, action: "comment", comment: "  " })).rejects.toThrow();
    expect(await asUser(t, staff).action(api.functions.texDashboard.act, { path: USER_BUG, action: "retire" })).toEqual({ status: "retired" });
    const text = await noteText(t, pinned, USER_BUG);
    expect(text).toContain("status: retired");
    expect(text).toContain("to triage: Retired: no fix needed.");
  });

  test("a member who only views may read a report but not act on it", async () => {
    const { t, staff, alice, pinned } = await world();
    await addMember(t, pinned, alice, "member", staff);
    // As `bugNotes.shareWithTeam` leaves every report: readable by the context's members.
    await asUser(t, staff).action(api.functions.files.setNoteVisibility, { workspaceId: pinned, path: BUG, visibility: "team" });
    expect((await asUser(t, alice).action(api.functions.texDashboard.readNote, { path: BUG })).text).toContain("Calendar made two events");
    await expect(asUser(t, alice).action(api.functions.texDashboard.act, { path: BUG, action: "retire" })).rejects.toThrow();
    expect(await noteText(t, pinned, BUG)).toContain("status: open");
  });
});

describe("the pure parts", () => {
  test("withStatus replaces, adds, or makes front matter", () => {
    expect(withStatus("---\nstatus: open\nx: 1\n---\n\nBody", "retired")).toBe("---\nstatus: retired\nx: 1\n---\n\nBody");
    expect(withStatus("---\nx: 1\n---\nBody", "triage")).toBe("---\nstatus: triage\nx: 1\n---\nBody");
    expect(withStatus("# Plain", "open")).toBe("---\nstatus: open\n---\n\n# Plain");
  });

  test("lists, stamps, themes and the desk's folders", () => {
    expect(listOf(["a", "a", "b"])).toEqual(["a", "b"]);
    expect(listOf('["x","y"]')).toEqual(["x", "y"]);
    expect(listOf("notes, email")).toEqual(["notes", "email"]);
    expect(stampOf("a/2026-10-24 0905 x.md")).toBe(Date.UTC(2026, 9, 24, 9, 5));
    expect(stampOf("a/x.md")).toBeNull();
    expect(themeRowOf("f/themes/x.md", undefined)).toMatchObject({ slug: "x", name: "x", status: "open", prs: [] });
    const folders = triageFolders("2-areas");
    expect(folders).toEqual({ bugs: "2-areas/tex-bugs", reviews: "2-areas/tex-reviews", themes: "2-areas/tex-reviews/themes" });
    expect(onTheDesk(folders, "2-areas/tex-bugs/team/a.md")).toBe(true);
    expect(onTheDesk(folders, "2-areas/tex-bugs/team/a.txt")).toBe(false);
    expect(onTheDesk(folders, "2-areas/tex-bugs//a.md")).toBe(false);
  });
});
