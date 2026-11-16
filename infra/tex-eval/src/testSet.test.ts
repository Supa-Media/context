import { describe, expect, it } from "vitest";
import { sqlStorage } from "../test/sql";
import { CAPS, counts, mayRun, problemWith, unitTests, verdict, type Conversation } from "./rules";
import { TestSet } from "./testSet";

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

  it("caps runs at 1 a commit, 3 a pull request, 20 a day, unless a person allowed one more", () => {
    expect(CAPS).toEqual({ commit: 1, pr: 3, day: 20 });
    expect(mayRun({ commit: 0, pr: 2, day: 9, allowed: 0 })).toEqual({ ok: true, spendsAllowance: false });
    expect(mayRun({ commit: 1, pr: 1, day: 1, allowed: 0 })).toMatchObject({ ok: false, why: expect.stringMatching(/commit/) });
    expect(mayRun({ commit: 0, pr: 3, day: 1, allowed: 0 })).toMatchObject({ ok: false, why: expect.stringMatching(/pull request/) });
    expect(mayRun({ commit: 0, pr: 0, day: 20, allowed: 0 })).toMatchObject({ ok: false, why: expect.stringMatching(/today/) });
    expect(mayRun({ commit: 1, pr: 3, day: 20, allowed: 1 })).toEqual({ ok: true, spendsAllowance: true });
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

  it("hands a run every conversation once per commit, three per pull request and twenty a day", () => {
    const s = set();
    s.put(conv("lease"), "user_1");
    const now = Date.UTC(2026, 10, 15, 12);
    const first = s.startRun({ pr: 7, sha: sha("a"), base: sha("f"), ghRun: "1" }, now);
    expect(first).toMatchObject({ ok: true, conversations: [{ id: "lease" }] });
    // The same GitHub run asking again (a retried step) gets its own run back, and spends nothing.
    expect(s.startRun({ pr: 7, sha: sha("a"), base: sha("f"), ghRun: "1" }, now)).toMatchObject({ ok: true, run: first.ok ? first.run : "" });
    expect(s.startRun({ pr: 7, sha: sha("a"), base: sha("f"), ghRun: "2" }, now)).toMatchObject({ ok: false, why: expect.stringMatching(/commit/) });
    expect(s.startRun({ pr: 7, sha: sha("b"), base: sha("f"), ghRun: "3" }, now).ok).toBe(true);
    expect(s.startRun({ pr: 7, sha: sha("c"), base: sha("f"), ghRun: "4" }, now).ok).toBe(true);
    expect(s.startRun({ pr: 7, sha: sha("d"), base: sha("f"), ghRun: "5" }, now)).toMatchObject({ ok: false, why: expect.stringMatching(/pull request/) });
    // A person allows one more: it is spent by the next run, and only that one.
    expect(s.allow(7, "user_1")).toEqual({ ok: true, pr: 7, left: 1 });
    expect(s.startRun({ pr: 7, sha: sha("d"), base: sha("f"), ghRun: "5" }, now).ok).toBe(true);
    expect(s.startRun({ pr: 7, sha: sha("e"), base: sha("f"), ghRun: "6" }, now).ok).toBe(false);
    // PR 7 spent 4 of the day's runs; the rest of the day's cap goes to other pull requests.
    for (let pr = 8; pr < 4 + CAPS.day; pr += 1) expect(s.startRun({ pr, sha: (pr.toString(16) + "0".repeat(40)).slice(0, 40), base: sha("f"), ghRun: `p${pr}` }, now).ok).toBe(true);
    expect(s.startRun({ pr: 99, sha: sha("9"), base: sha("f"), ghRun: "x" }, now)).toMatchObject({ ok: false, why: expect.stringMatching(/today/) });
    expect(s.startRun({ pr: 99, sha: sha("9"), base: sha("f"), ghRun: "y" }, now + 86_400_000).ok).toBe(true);
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
