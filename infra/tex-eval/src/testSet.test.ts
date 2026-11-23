import { describe, expect, it } from "vitest";
import { sqlStorage } from "../test/sql";
import { CAPS, counts, mayRun, problemWith, unitTests, verdict, type Conversation } from "./rules";
import { TestSet } from "./testSet";
import type { SearchCase } from "./searchRules";

const conv = (id: string, stars: Record<string, number> = { decide: 1 }): Conversation => ({
  id,
  title: `Chat ${id}`,
  set: "test",
  kind: "one",
  members: ["Sam"],
  msgs: Object.entries(stars).flatMap(([node, n]) =>
    Array.from({ length: n }, (_, i) => [
      { id: `${node}-${i}`, who: "Sam", text: "words only people read", labels: { [node]: { star: true }, other: { act: "quiet" } } },
      { id: `${node}-${i}-t`, who: "Tex", tex: true, text: "a reply" },
    ]).flat(),
  ),
});
const set = () => new TestSet({ storage: { sql: sqlStorage() } } as never, {});
const sha = (c: string) => c.repeat(40);

describe("the rules", () => {
  it("counts a starred label on a person's message as one unit test, never a Tex row", () => {
    const c = conv("a", { decide: 2, fd: 1 });
    c.msgs.push({ id: "t2", who: "Tex", tex: true, text: "x", labels: { decide: { star: true } } });
    expect(unitTests(c)).toHaveLength(3);
    expect(counts([c])).toEqual({ chats: 1, stars: 3, byNode: { decide: 2, fd: 1 }, perChat: [{ stars: 3, kind: "one", msgs: 7 }] });
  });

  it("keeps only Test conversations, with an id and messages", () => {
    expect(problemWith(conv("ok"))).toBeNull();
    expect(problemWith({ ...conv("x"), set: "dev" })).toMatch(/set must be "test"/);
    expect(problemWith({ ...conv("x"), id: "Bad Id" })).toMatch(/id/);
    expect(problemWith({ ...conv("x"), msgs: "no" })).toMatch(/no messages/);
    expect(problemWith({ ...conv("x"), msgs: [{ id: "m", who: "Sam", text: "x".repeat(250_000) }] })).toMatch(/bytes/);
  });

  it("caps runs at 1 a commit, 10 changes a pull request, 1000 a day, unless a person allowed one more", () => {
    expect(CAPS).toEqual({ commit: 1, pr: 10, day: 1000 });
    expect(mayRun({ commit: 0, pr: 9, day: 9, allowed: 0 })).toEqual({ ok: true, spendsAllowance: false });
    expect(mayRun({ commit: 1, pr: 1, day: 1, allowed: 0 })).toMatchObject({ ok: false, why: expect.stringMatching(/commit/) });
    expect(mayRun({ commit: 0, pr: 10, day: 1, allowed: 0 })).toMatchObject({ ok: false, why: expect.stringMatching(/pull request/) });
    // Only main moved: the same change re-runs past the pull request cap, never past the commit or day caps.
    expect(mayRun({ commit: 0, pr: 10, sameChange: true, day: 1, allowed: 0 })).toEqual({ ok: true, spendsAllowance: false });
    expect(mayRun({ commit: 0, pr: 10, sameChange: true, day: 1000, allowed: 0 })).toMatchObject({ ok: false, why: expect.stringMatching(/today/) });
    expect(mayRun({ commit: 0, pr: 0, day: 1000, allowed: 0 })).toMatchObject({ ok: false, why: expect.stringMatching(/today/) });
    expect(mayRun({ commit: 1, pr: 10, day: 1000, allowed: 1 })).toEqual({ ok: true, spendsAllowance: true });
  });

  it("passes only when no node gets fewer right than on main, and counts a missing answer as wrong", () => {
    const tests = [
      { chat: "a", msg: "1", node: "decide" },
      { chat: "a", msg: "2", node: "decide" },
      { chat: "b", msg: "1", node: "fd" },
    ];
    const r = (msg: string, node: string, right: boolean, chat = "a") => ({ chat, msg, node, right });
    const same = verdict(tests, [r("1", "decide", true), r("1", "fd", true, "b")], [r("1", "decide", true), r("1", "fd", true, "b")]);
    expect(same).toMatchObject({ pass: true, total: 3, right: 2, main: 2 });
    // fd better, decide worse: one node worse is a fail, whatever the total.
    const worse = verdict(tests, [r("1", "fd", true, "b")], [r("1", "decide", true)]);
    expect(worse.pass).toBe(false);
    expect(worse.byNode.decide).toEqual({ total: 2, right: 0, main: 1 });
    // An answer for a test the run was not handed scores nothing.
    expect(verdict(tests, [r("9", "decide", true)], []).right).toBe(0);
    expect(verdict([], [], [])).toMatchObject({ pass: true, total: 0 });
  });
});

describe("the Test Set object", () => {
  it("keeps what people write, lists it with counts, and forgets what they remove", () => {
    const s = set();
    expect(s.put(conv("lease", { fd: 2 }), "user_1")).toMatchObject({ ok: true, kept: "lease", counts: { chats: 1, stars: 2 } });
    expect(s.put({ ...conv("x"), set: "dev" }, "user_1")).toMatchObject({ ok: false });
    const listed = s.list();
    expect(listed.chats[0]).toMatchObject({ id: "lease", title: "Chat lease", msgs: 4, stars: 2, labels: 4, by: "user_1" });
    expect(s.get("lease")?.msgs[0].text).toBe("words only people read");
    expect(s.remove("lease", "user_1")).toMatchObject({ removed: "lease", counts: { chats: 0 } });
    expect(s.get("lease")).toBeNull();
  });

  it("counts and runs say nothing of the words", () => {
    const s = set();
    s.put(conv("lease"), "user_1");
    const now = Date.UTC(2026, 10, 15, 12);
    const started = s.startRun({ pr: 7, sha: sha("a"), base: sha("b"), ghRun: "11" }, now);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    s.finishRun(started.run, "11", [{ chat: "lease", msg: "decide-0", node: "decide", right: true }], []);
    const text = JSON.stringify({ counts: s.counts(), runs: s.runs() });
    expect(text).not.toContain("words only people read");
    expect(text).not.toContain("Chat lease");
  });

  it("hands a run every conversation once per commit, ten changes per pull request and a thousand a day", () => {
    const s = set();
    s.put(conv("lease"), "user_1");
    const now = Date.UTC(2026, 10, 15, 12);
    const first = s.startRun({ pr: 7, sha: sha("a"), base: sha("f"), ghRun: "1" }, now);
    expect(first).toMatchObject({ ok: true, conversations: [{ id: "lease" }] });
    // The same GitHub run asking again (a retried step) gets its own run back, and spends nothing.
    expect(s.startRun({ pr: 7, sha: sha("a"), base: sha("f"), ghRun: "1" }, now)).toMatchObject({ ok: true, run: first.ok ? first.run : "" });
    expect(s.startRun({ pr: 7, sha: sha("a"), base: sha("f"), ghRun: "2" }, now)).toMatchObject({ ok: false, why: expect.stringMatching(/commit/) });
    expect(s.startRun({ pr: 7, sha: sha("b"), base: sha("f"), ghRun: "3" }, now).ok).toBe(true);
    for (let i = 3; i <= CAPS.pr; i += 1) expect(s.startRun({ pr: 7, sha: (0xc00 + i).toString(16).padStart(40, "c"), base: sha("f"), ghRun: `c${i}` }, now).ok).toBe(true);
    expect(s.startRun({ pr: 7, sha: sha("d"), base: sha("f"), ghRun: "5" }, now)).toMatchObject({ ok: false, why: expect.stringMatching(/pull request/) });
    // A person allows one more: it is spent by the next run, and only that one.
    expect(s.allow(7, "user_1")).toEqual({ ok: true, pr: 7, left: 1 });
    expect(s.startRun({ pr: 7, sha: sha("d"), base: sha("f"), ghRun: "5" }, now).ok).toBe(true);
    expect(s.startRun({ pr: 7, sha: sha("e"), base: sha("f"), ghRun: "6" }, now).ok).toBe(false);
    // PR 7 spent CAPS.pr + 1 of the day's runs; the rest of the day's cap goes to other pull requests.
    for (let pr = 8; pr < 8 + CAPS.day - CAPS.pr - 1; pr += 1) expect(s.startRun({ pr, sha: pr.toString(16).padStart(40, "0"), base: sha("f"), ghRun: `p${pr}` }, now).ok).toBe(true);
    expect(s.startRun({ pr: 99, sha: sha("9"), base: sha("f"), ghRun: "x" }, now)).toMatchObject({ ok: false, why: expect.stringMatching(/today/) });
    expect(s.startRun({ pr: 99, sha: sha("9"), base: sha("f"), ghRun: "y" }, now + 86_400_000).ok).toBe(true);
  });

  it("re-runs a change whose commit only merged main without spending a pull request run", () => {
    const s = set();
    s.put(conv("lease"), "user_1");
    const now = Date.UTC(2026, 10, 17, 5);
    const change = (c: string) => c.repeat(40);
    // Ten changes: the cap.
    for (let i = 0; i < CAPS.pr; i += 1) expect(s.startRun({ pr: 7, sha: (0xa00 + i).toString(16).padStart(40, "a"), base: sha("f"), ghRun: `r${i}`, change: (0xb00 + i).toString(16).padStart(40, "b") }, now).ok).toBe(true);
    expect(s.startRun({ pr: 7, sha: sha("1"), base: sha("e"), ghRun: "new", change: change("c") }, now)).toMatchObject({ ok: false, why: expect.stringMatching(/pull request/) });
    // Main moved and the branch merged it: a new commit, the last change's diff, so it runs.
    const last = (0xb00 + CAPS.pr - 1).toString(16).padStart(40, "b");
    expect(s.startRun({ pr: 7, sha: sha("2"), base: sha("e"), ghRun: "merge1", change: last }, now).ok).toBe(true);
    expect(s.startRun({ pr: 7, sha: sha("3"), base: sha("d"), ghRun: "merge2", change: last }, now).ok).toBe(true);
    // The commit cap still holds for a merge-only commit, and a change on another pull request is that one's own.
    expect(s.startRun({ pr: 7, sha: sha("3"), base: sha("d"), ghRun: "merge3", change: last }, now)).toMatchObject({ ok: false, why: expect.stringMatching(/commit/) });
    expect(s.startRun({ pr: 8, sha: sha("4"), base: sha("d"), ghRun: "other", change: last }, now).ok).toBe(true);
    // A run that names no change, or a malformed one, counts as a change of its own.
    expect(s.startRun({ pr: 9, sha: sha("5"), base: sha("d"), ghRun: "n1", change: "not-a-patch-id" }, now).ok).toBe(true);
  });

  it("adds the change column to a Test Set kept before it, keeping its runs", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, pr INTEGER NOT NULL, sha TEXT NOT NULL, base TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, gh_run TEXT NOT NULL, tests TEXT NOT NULL, verdict TEXT, allowance INTEGER NOT NULL DEFAULT 0)`);
    db.exec(`INSERT INTO runs VALUES ('old1', 7, '${sha("a")}', '${sha("f")}', '2026-11-17', 1, 'g1', '[]', NULL, 0), ('old2', 7, '${sha("b")}', '${sha("f")}', '2026-11-17', 2, 'g2', '[]', NULL, 0)`);
    const s = new TestSet({ storage: { sql: sqlStorage(db) } } as never, {});
    // The two old runs count as two changes; the column exists for new ones.
    for (let i = 2; i < CAPS.pr; i += 1) expect(s.startRun({ pr: 7, sha: (0xc00 + i).toString(16).padStart(40, "c"), base: sha("f"), ghRun: `n${i}`, change: (0xd00 + i).toString(16).padStart(40, "d") }, Date.UTC(2026, 10, 17, 6)).ok).toBe(true);
    expect(s.startRun({ pr: 7, sha: sha("e"), base: sha("f"), ghRun: "over", change: sha("e") }, Date.UTC(2026, 10, 17, 6)).ok).toBe(false);
    expect(s.runs(100).map((r) => r.id)).toEqual(expect.arrayContaining(["old1", "old2"]));
  });

  it("scores a run once, only for the GitHub run that started it, against the tests it was handed", () => {
    const s = set();
    s.put(conv("lease", { decide: 2 }), "user_1");
    const started = s.startRun({ pr: 7, sha: sha("a"), base: sha("f"), ghRun: "1" });
    if (!started.ok) throw new Error("no run");
    // A conversation added after the start is not part of this run.
    s.put(conv("later"), "user_1");
    expect(s.finishRun(started.run, "2", [], [])).toMatchObject({ ok: false });
    const done = s.finishRun(started.run, "1", [{ chat: "lease", msg: "decide-0", node: "decide", right: true }], [{ chat: "lease", msg: "decide-0", node: "decide", right: true }, { chat: "lease", msg: "decide-1", node: "decide", right: true }]);
    expect(done).toMatchObject({ ok: true, verdict: { pass: false, total: 2, right: 1, main: 2 } });
    // A second answer changes nothing.
    expect(s.finishRun(started.run, "1", [], [])).toMatchObject({ verdict: { right: 1 } });
    expect(s.runs()[0]).toMatchObject({ pr: 7, verdict: { pass: false } });
  });

  it("seeds the held-out cases without overwriting one a person wrote", () => {
    const s = set();
    s.put(conv("lease"), "user_1");
    const seeded = s.seed([conv("lease", { fd: 3 }), conv("ferry"), { ...conv("bad"), set: "training" }], "99");
    expect(seeded).toMatchObject({ kept: 1, counts: { chats: 2, stars: 2 } });
    expect(seeded.skipped).toHaveLength(2);
    expect(s.get("lease")?.msgs).toHaveLength(2);
  });
});

describe("the Search Test object", () => {
  const sc = (id: string, extra: Partial<SearchCase> = {}): SearchCase => ({
    id,
    set: "test",
    query: "when does my lease end",
    as: "sam",
    expect: ["@seyi/home/lease.md"],
    kind: "lease",
    notes: { "@seyi/home/lease.md": "The lease ends in June. Words only people read." },
    ...extra,
  });

  it("keeps search cases people write, lists them with no query or note words, and forgets what they remove", () => {
    const s = set();
    expect(s.searchPut(sc("lease"), "user_1")).toMatchObject({ ok: true, kept: "lease", counts: { cases: 1, byKind: { lease: 1 } } });
    expect(s.searchPut({ ...sc("x"), set: "dev" } as unknown as SearchCase, "user_1")).toMatchObject({ ok: false, problems: [expect.stringMatching(/set must be "test"/)] });
    // The Tex Test Set is untouched by search cases.
    expect(s.counts()).toMatchObject({ chats: 0 });
    const listed = s.searchList();
    expect(listed.cases[0]).toEqual({ id: "lease", kind: "lease", queryLength: sc("x").query.length, expect: 1, by: "user_1", at: expect.any(Number) });
    const text = JSON.stringify(listed);
    expect(text).not.toMatch(/when does|Words only|lease end/);
    expect(s.searchGet("lease")?.query).toBe("when does my lease end");
    expect(s.searchRemove("lease", "user_1")).toMatchObject({ removed: "lease", counts: { cases: 0 } });
    expect(s.searchGet("lease")).toBeNull();
  });

  it("caps search runs on search runs only: a Tex run on the same commit does not spend one", () => {
    const s = set();
    s.searchPut(sc("lease"), "user_1");
    s.put({ id: "tex-chat", set: "test", msgs: [] }, "user_1");
    const now = Date.UTC(2026, 10, 18, 12);
    expect(s.startRun({ pr: 7, sha: sha("a"), base: sha("f"), ghRun: "tex-1" }, now).ok).toBe(true);
    const first = s.startSearchRun({ pr: 7, sha: sha("a"), base: sha("f"), ghRun: "s-1" }, now);
    expect(first).toMatchObject({ ok: true, cases: [{ id: "lease" }] });
    // The same GitHub run asking again gets its own run back.
    expect(s.startSearchRun({ pr: 7, sha: sha("a"), base: sha("f"), ghRun: "s-1" }, now)).toMatchObject({ ok: true, run: first.ok ? first.run : "" });
    expect(s.startSearchRun({ pr: 7, sha: sha("a"), base: sha("f"), ghRun: "s-2" }, now)).toMatchObject({ ok: false, why: expect.stringMatching(/commit/) });
    expect(s.startSearchRun({ pr: 7, sha: "not-a-commit", base: sha("f"), ghRun: "s-3" }, now)).toMatchObject({ ok: false });
    expect(s.searchRuns()).toHaveLength(1);
    // A run that ended with no verdict (its job timed out or an outage stopped it) frees the commit for one more.
    const later = now + 91 * 60 * 1000;
    const again = s.startSearchRun({ pr: 7, sha: sha("a"), base: sha("f"), ghRun: "s-4" }, later);
    expect(again).toMatchObject({ ok: true });
    if (again.ok) s.finishSearchRun(again.run, "s-4", [], []);
    expect(s.startSearchRun({ pr: 7, sha: sha("a"), base: sha("f"), ghRun: "s-5" }, later + 91 * 60 * 1000)).toMatchObject({ ok: false, why: expect.stringMatching(/commit/) });
  });

  it("caps a pull request at ten changes, and a day at a thousand runs, as the Test Set does", () => {
    const s = set();
    s.searchPut(sc("lease"), "user_1");
    const now = Date.UTC(2026, 10, 18, 12);
    for (let i = 0; i < CAPS.pr; i += 1) expect(s.startSearchRun({ pr: 7, sha: (0xa00 + i).toString(16).padStart(40, "a"), base: sha("f"), ghRun: `c${i}`, change: (0xb00 + i).toString(16).padStart(40, "b") }, now).ok).toBe(true);
    expect(s.startSearchRun({ pr: 7, sha: sha("1"), base: sha("f"), ghRun: "eleventh", change: sha("c") }, now)).toMatchObject({ ok: false, why: expect.stringMatching(/pull request/) });
    for (let pr = 100; pr < 100 + CAPS.day - CAPS.pr; pr += 1) expect(s.startSearchRun({ pr, sha: pr.toString(16).padStart(40, "0"), base: sha("f"), ghRun: `d${pr}` }, now).ok).toBe(true);
    expect(s.startSearchRun({ pr: 999, sha: sha("9"), base: sha("f"), ghRun: "over" }, now)).toMatchObject({ ok: false, why: expect.stringMatching(/today/) });
    expect(s.startSearchRun({ pr: 999, sha: sha("9"), base: sha("f"), ghRun: "tomorrow" }, now + 86_400_000).ok).toBe(true);
  });

  it("scores a search run once, only for the GitHub run that started it, against the cases it was handed", () => {
    const s = set();
    s.searchPut(sc("lease"), "user_1");
    const started = s.startSearchRun({ pr: 7, sha: sha("a"), base: sha("f"), ghRun: "1" });
    if (!started.ok) throw new Error("no run");
    s.searchPut(sc("later"), "user_1");
    expect(s.finishSearchRun(started.run, "2", [], [])).toMatchObject({ ok: false });
    const done = s.finishSearchRun(started.run, "1", [{ id: "lease", rank: 2 }], [{ id: "lease", rank: 1 }]);
    expect(done).toMatchObject({ ok: true, verdict: { pass: false, total: 1, first: 0, mainFirst: 1 } });
    // A second answer changes nothing.
    expect(s.finishSearchRun(started.run, "1", [{ id: "lease", rank: 1 }], [])).toMatchObject({ verdict: { first: 0 } });
    expect(s.searchRuns()[0]).toMatchObject({ pr: 7, verdict: { pass: false, total: 1 } });
  });

  it("keeps search runs and counts with no words", () => {
    const s = set();
    s.searchPut(sc("case-one"), "user_1");
    const started = s.startSearchRun({ pr: 7, sha: sha("a"), base: sha("f"), ghRun: "11" });
    if (!started.ok) throw new Error("no run");
    s.finishSearchRun(started.run, "11", [{ id: "case-one", rank: 1 }], [{ id: "case-one", rank: 1 }]);
    const text = JSON.stringify({ counts: s.searchCounts(), runs: s.searchRuns() });
    expect(text).not.toMatch(/when does|lease end|Words only/);
    expect(text).not.toContain("case-one");
  });

  it("seeds the held-out search cases without overwriting one a person wrote, and skips a bad one by id", () => {
    const s = set();
    s.searchPut(sc("lease", { query: "original words" }), "user_1");
    const seeded = s.seedSearch([sc("lease", { query: "moved words" }), sc("ferry"), { ...sc("bad"), set: "training" }], "99");
    expect(seeded).toMatchObject({ kept: 1, counts: { cases: 2 } });
    expect(seeded.skipped).toEqual([expect.stringContaining("lease: already here"), expect.stringContaining("bad: ")]);
    expect(s.searchGet("lease")?.query).toBe("original words");
    expect(s.searchGet("ferry")).not.toBeNull();
  });
});
