/**
 * A real text played as it ran in production (Lab live sandbox, Dev2 2026-11-16: Lab and Replay are one view, and a real
 * row's play button "replays what ran in prod", on the graph Tex had then). What Replay read of a moment is now a
 * `PlayRun` (`engine/prodRun.ts`). Made-up texts throughout.
 *
 * Sabotage checks: drop `onlyWhatRan` from `momentSteps` and "only the steps the log shows ran" fails on a step it never logged;
 * make `graphAt` skip its cache and "one fetch per commit" fails; give a Tex text the turn of the moment's last turn
 * when its own entry names none and "a Tex text with no turn of its own has no cause run" fails.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { TEX_CONFIG } from "@context/tex/src/texConfig.cjs";
import { forgetGraphs, graphAt, graphNoteFor, graphOfConfig, OLD_CONFIG_PATH } from "@context/lab/app/engine/graphAt";
import { prodPlay, prodPlayAtVersion } from "@context/lab/app/engine/prodRun";
import { linesOf } from "@context/lab/app/engine/replayRead";
import { G } from "@context/lab/app/engine/state";
import { chatKeyOf, forgetProd, playProdRow } from "@context/lab/app/views/mine/playProd";
import type { LedgerEntry } from "../features/tex/page/texPageTypes";

const mockLedger = jest.fn<(chat: string, q: { kinds?: string[] }) => Promise<unknown>>();
jest.mock("@context/lab/app/views/mine/useMine", () => ({ ledgerSource: () => ({ ledger: (chat: string, q: { kinds?: string[] }) => mockLedger(chat, q) }) }));

const e = (x: Partial<LedgerEntry> & { id: string; kind: string }): LedgerEntry => ({ at: 1_000, ...x }) as LedgerEntry;
const T0 = Date.UTC(2026, 10, 14, 14);
const CODE = "abc1234def5678";
const version = { code: CODE, setup: "a1b2c3d4e5f6" };

/**
 * One text, answered by one turn with a tool call and an answer check, and the Worker's judging before it. The graph
 * runner logs each node it runs as a "node" step naming it (`apps/mcp/src/agent/ledger.js` `nodeEntry`): the Door
 * (`doorStep`) and the Answer check (`answerCheck`) among them.
 */
const entries = (): LedgerEntry[] => [
  e({ id: "ev1", eid: "E1", seq: 1, at: T0, kind: "text", from: { kind: "person" }, text: "whats on the cal tomorrow" }),
  e({ id: "s1", seq: 2, at: T0 + 300, kind: "step", step: { name: "decide", of: "waiting", ok: true, ms: 250, input: { candidates: ["E1"] }, output: { act: "answer" } } } as never),
  e({ id: "d1", seq: 3, at: T0 + 1_700, kind: "step", turn: "t1", step: "node", name: "doorStep", ok: true, ms: 40, input: { chat: "one", kind: "text" }, output: { when: ["next"], log: { parts: [{ part: "readTheText", ok: true, ms: 1, chat: "one", covers: ["E1"] }] } } }),
  e({ id: "th", seq: 4, at: T0 + 3_000, kind: "thinking", turn: "t1", ms: 900, text: "Look at the calendar first." }),
  e({ id: "tl", seq: 5, at: T0 + 3_500, kind: "tool", turn: "t1", name: "read_calendar", ms: 700, args: { day: "tomorrow" }, result: "3 events" }),
  e({ id: "rv", seq: 6, at: T0 + 6_000, kind: "step", turn: "t1", step: "node", name: "answerCheck", ok: true, ms: 2_000, input: { pending: true }, output: null }),
  e({
    id: "r1",
    seq: 7,
    at: T0 + 8_000,
    kind: "reply",
    turn: "t1",
    text: "Three things.",
    version,
    covers: ["E1"],
    timing: { v: 2, waitMs: 300, replyMs: 6_500, rounds: [{ at: 1_000, ms: 3_300, model: "anthropic/claude-haiku-5-5", input: 100, output: 50 }], tools: [{ at: 2_000, ms: 700 }] },
  }),
  e({ id: "ev2", eid: "E2", seq: 8, at: T0 + 8_100, kind: "text", from: { kind: "tex" }, text: "Three things.", turn: "t1", covers: ["E1"] }),
];
const linesFor = (es: LedgerEntry[]) => linesOf(es, false).lines;
const config = () => JSON.parse(JSON.stringify(TEX_CONFIG)) as { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string }> };

describe("a real text as it ran", () => {
  test("only the steps the log shows ran are in the run, each with its own times, in, out and thinking", () => {
    const p = prodPlay(entries(), linesFor(entries()), { id: "E1" }, { g: G() })!;
    expect(p).not.toBeNull();
    const nodes = new Set(p.run.steps.map((s) => s.node));
    for (const ran of ["text", "decide", "lanes", "doorStep", "fd", "tools", "answerCheck", "send"]) expect(nodes).toContain(ran);
    // Nothing is estimated: the steps that left no record are not drawn, however the Lab would guess them.
    for (const never of ["bypass", "react", "learn", "afterReply", "jobadv", "advisor", "job"]) expect(nodes).not.toContain(never);
    const fd = p.run.steps.find((s) => s.node === "fd")!;
    expect(fd).toMatchObject({ id: "t1:fd", ok: true, model: "anthropic/claude-haiku-5-5", tokIn: 100, tokOut: 50 });
    expect(fd.think).toContain("Look at the calendar first.");
    expect(fd.out).toBeDefined();
    // The wait in the queue, then the turn, on the moment's clock; each step starts no earlier than the one it follows.
    const at = (n: string) => p.run.steps.find((s) => s.node === n)!.at;
    expect(at("lanes")).toBeLessThanOrEqual(at("doorStep"));
    expect(at("doorStep")).toBeLessThanOrEqual(at("fd"));
    expect(p.run.steps.every((s) => s.at >= 0 && (s.ms ?? 0) >= 0)).toBe(true);
    expect(p.run.running).toBe(false);
    expect(p.run.total).toBeGreaterThanOrEqual(Math.max(...p.run.steps.map((s) => s.at + (s.ms ?? 0))));
    expect(p.run.prod).toEqual({ at: T0, code: CODE });
    // A step's parent is the step that started it; a helper's is its caller.
    expect(p.run.steps.find((s) => s.node === "tools")!.parent).toBe("t1:fd");
  });

  test("tool calls are kind prod: they ran in production, with the time they took", () => {
    const p = prodPlay(entries(), linesFor(entries()), { id: "E1" }, { g: G() })!;
    const tools = p.run.steps.find((s) => s.node === "tools")!;
    expect(tools.calls).toEqual([{ tool: "read_calendar", kind: "prod", ms: 700, d: '{\n "day": "tomorrow"\n}' }]);
  });

  test("a step that failed in its log is drawn failed", () => {
    const es = entries();
    es.find((x) => x.id === "rv")!.ok = false;
    const p = prodPlay(es, linesFor(es), { id: "E1" }, { g: G() })!;
    expect(p.run.steps.find((s) => s.node === "answerCheck")?.ok).toBe(false);
  });

  test("each of Tex's texts plays only the steps of the turn that sent it, when its own entry names the turn", () => {
    const p = prodPlay(entries(), linesFor(entries()), { id: "E1" }, { g: G() })!;
    expect(p.run.texts).toEqual([{ at: 8_100, rowId: "E2" }]);
    const reply = p.replies.E2;
    expect(reply.of).toBe("ev1");
    expect(reply.id).toBe("ev1#E2");
    expect(p.cause.E2).toEqual(reply.steps.map((s) => s.id));
    // The turn's steps, and the text it covered; never the judging, which no entry ties to this turn.
    expect(reply.steps.map((s) => s.node)).toEqual(expect.arrayContaining(["text", "doorStep", "fd", "tools", "answerCheck", "send"]));
    expect(reply.steps.map((s) => s.node)).not.toContain("decide");
    expect(reply.texts).toEqual([{ at: 8_100, rowId: "E2" }]);
  });

  test("a Tex text with no turn of its own has no cause run: nothing is inferred", () => {
    const es = entries();
    delete (es.find((x) => x.id === "ev2") as Record<string, unknown>).turn;
    const p = prodPlay(es, linesFor(es), { id: "E1" }, { g: G() })!;
    expect(p.replies).toEqual({});
    expect(p.cause).toEqual({});
    expect(p.run.texts).toEqual([{ at: 8_100, rowId: "E2" }]);
  });

  test("a text from before full logging, or one the log has no turn for, is not played", () => {
    const old = entries().map((x) => ({ ...x, at: x.at - 5 * 86_400_000 }));
    expect(prodPlay(old, linesFor(old), { id: "E1" }, { g: G() })).toBeNull();
    expect(prodPlay(entries(), linesFor(entries()), { id: "nope" }, { g: G() })).toBeNull();
    const bare = entries().filter((x) => x.turn === undefined);
    expect(prodPlay(bare, linesFor(bare), { id: "E1" }, { g: G() })).toBeNull();
  });

  test("a check-in plays from its own start step, and one that stayed quiet has no reply", () => {
    const es: LedgerEntry[] = [
      e({ id: "n1", eid: "N1", seq: 1, at: T0 + 5_000, kind: "note", turn: "ck1", text: "Your 3pm moved.", about: "(Not a text from them. This was your own check-in, which you do three times a day.)", version }),
      e({ id: "k1", seq: 0, at: T0 + 1_000, kind: "thinking", turn: "ck1", ms: 800, text: "Looking at the calendar." }),
      e({ id: "k2", seq: 0, at: T0 + 3_000, kind: "tool", turn: "ck1", name: "read_calendar", ms: 500, args: {}, result: "x" }),
    ];
    const p = prodPlay(es, linesFor(es), { id: "n1" }, { g: G() })!;
    expect(p).not.toBeNull();
    expect(p.moment.from).toBe("checkin");
    expect(p.run.steps.some((s) => s.node === "checkin")).toBe(true);
    expect(p.run.steps.some((s) => s.node === "text")).toBe(false);
  });

  test("a background job a turn reported is named, for the panel to open", () => {
    const es = entries();
    es.push(e({ id: "jb", seq: 9, at: T0 + 7_000, kind: "job", turn: "t1", job: "job-0001", title: "Find a table", state: "done" }));
    const p = prodPlay(es, linesFor(es), { id: "E1" }, { g: G() })!;
    expect(p.jobs).toEqual(["job-0001"]);
  });
});

describe("the graph of the time", () => {
  beforeEach(() => forgetGraphs());

  test("the commit's texConfig.json, folded the way the Lab draws main, one fetch per commit", async () => {
    const get = jest.fn(async (_url: string) => ({ ok: true, json: async () => TEX_CONFIG }) as never);
    const a = (await graphAt(CODE, get as never))!;
    const b = (await graphAt(CODE, get as never))!;
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe(`https://raw.githubusercontent.com/Supa-Media/context/${CODE}/packages/tex/src/texConfig.json`);
    expect(a.nodes.map((n) => n.id)).toEqual(G().nodes.map((n) => n.id));
    // Each caller's graph is its own: drawing or editing one never reaches the cache.
    a.nodes[0].label = "changed";
    expect(b.nodes[0].label).not.toBe("changed");
    await graphAt("deadbee1234", get as never);
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("a commit from before Tex had its own package is read at the old path", async () => {
    const get = jest.fn(async (url: string) =>
      (url.endsWith(`/${OLD_CONFIG_PATH}`) ? { ok: true, json: async () => TEX_CONFIG } : { ok: false, json: async () => null }) as never,
    );
    const g = await graphAt(CODE, get as never);
    expect(g?.nodes.map((n) => n.id)).toEqual(G().nodes.map((n) => n.id));
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      `https://raw.githubusercontent.com/Supa-Media/context/${CODE}/packages/tex/src/texConfig.json`,
      `https://raw.githubusercontent.com/Supa-Media/context/${CODE}/packages/shared/src/texConfig.json`,
    ]);
  });

  test("a run is read against the graph that ran it and carries it for the canvas", async () => {
    const old = config();
    // The graph of that day had no answer-check step.
    old.nodes = old.nodes.filter((n) => n.id !== "answerCheck");
    old.edges = old.edges.filter((x) => x.from !== "answerCheck" && x.to !== "answerCheck");
    const get = jest.fn(async () => ({ ok: true, json: async () => old }) as never);
    const p = (await prodPlayAtVersion(entries(), linesFor(entries()), { id: "E1" }, G(), get as never))!;
    expect(p.run.graph?.nodes.some((n) => n.id === "answerCheck")).toBe(false);
    expect(p.run.steps.some((s) => s.node === "answerCheck")).toBe(false);
    expect(p.run.steps.some((s) => s.node === "fd")).toBe(true);
    expect(p.run.graphNote).toBeUndefined();
    // Played again: the same commit is not fetched twice.
    await prodPlayAtVersion(entries(), linesFor(entries()), { id: "E1" }, G(), get as never);
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("when the graph of the time can't load, today's is used and the run says so; the next look tries again", async () => {
    const get = jest.fn(async () => ({ ok: false, json: async () => null }) as never);
    const p = (await prodPlayAtVersion(entries(), linesFor(entries()), { id: "E1" }, G(), get as never))!;
    expect(p.run.graph).toBeUndefined();
    expect(p.run.graphNote).toBe(graphNoteFor(T0, CODE));
    expect(p.run.graphNote).toBe("graph of 2026-11-14 (abc1234) unavailable, showing today's");
    expect(p.run.steps.some((s) => s.node === "answerCheck")).toBe(true);
    await prodPlayAtVersion(entries(), linesFor(entries()), { id: "E1" }, G(), get as never);
    // Each look asks the package path, then the path before the move.
    expect(get).toHaveBeenCalledTimes(4);
    // A network error is the same; so is a reply that is not a Tex config.
    const down = jest.fn(async () => Promise.reject(new Error("offline")));
    expect(await graphAt("1234567", down as never)).toBeNull();
    expect(graphOfConfig({ nodes: [], edges: [] })).toBeNull();
    expect(graphOfConfig("<html>")).toBeNull();
    expect(graphOfConfig({ ...config(), texConfig: 1 })?.nodes.length).toBeGreaterThan(0);
  });

  test("a reply that logged no commit falls back the same way", async () => {
    const es = entries();
    delete (es.find((x) => x.id === "r1") as Record<string, unknown>).version;
    const get = jest.fn();
    const p = (await prodPlayAtVersion(es, linesFor(es), { id: "E1" }, G(), get as never))!;
    expect(get).not.toHaveBeenCalled();
    expect(p.run.graph).toBeUndefined();
    expect(p.run.graphNote).toMatch(/^graph of 2026-11-14 unavailable, showing today's$/);
  });
});

describe("playProdRow, the dock's play button on a real row", () => {
  const page = (es: LedgerEntry[], older?: number) => ({ kind: "ok", value: { manifest: null, entries: es, ...(older !== undefined ? { older } : {}) } });
  const ok = (es: LedgerEntry[]) => async (_chat: string, q: { kinds?: string[] }) =>
    page(q.kinds?.includes("text") ? es.filter((x) => ["text", "reply", "note"].includes(x.kind)) : es.filter((x) => !["text", "reply", "note"].includes(x.kind) || x.kind === "reply"));
  const get = jest.fn(async () => ({ ok: true, json: async () => TEX_CONFIG }) as never);

  beforeEach(() => {
    forgetGraphs();
    mockLedger.mockReset();
    forgetProd();
  });

  test("a person's text plays the whole moment; one of Tex's plays only the turn that sent it", async () => {
    mockLedger.mockImplementation(ok(entries()));
    const mine = (await playProdRow({ id: "E1", at: T0, prod: true }, "me", get as never))!;
    expect(mine.id).toBe("ev1");
    expect(mine.steps.length).toBeGreaterThan(4);
    const tex = (await playProdRow({ id: "E2", at: T0 + 8_100, prod: true }, "me", get as never))!;
    expect(tex.id).toBe("ev1#E2");
    expect(tex.steps.length).toBeLessThan(mine.steps.length);
    // The ledger is read for the chat asked, only through its own history route.
    expect(mockLedger.mock.calls.every(([chat]) => chat === "me")).toBe(true);
  });

  test("a row that isn't a real chat's, or a Tex text the log can't place, plays nothing", async () => {
    mockLedger.mockImplementation(ok(entries()));
    expect(await playProdRow({ id: "E1", at: T0, prod: false }, "me", get as never)).toBeNull();
    expect(await playProdRow({ id: "E1", prod: true }, "me", get as never)).toBeNull();
    expect(await playProdRow({ id: "E1", at: T0, prod: true }, null, get as never)).toBeNull();
    // Maya and a Training conversation are not the person's own chats.
    expect(chatKeyOf({ kind: "maya" }, [])).toBeNull();
    expect(chatKeyOf({ kind: "set", convId: "c1", name: "x" }, [])).toBeNull();
    expect(chatKeyOf({ kind: "chat", chatId: "me", name: "You" }, [{ chatId: "me", name: "You", kind: "dm" }])).toBe("me");
    expect(chatKeyOf({ kind: "chat", chatId: "g1", name: "Band" }, [{ chatId: "g1", name: "Band", kind: "group" }])).toBe("g1");
    const noTurn = entries();
    delete (noTurn.find((x) => x.id === "ev2") as Record<string, unknown>).turn;
    mockLedger.mockImplementation(ok(noTurn));
    forgetProd();
    expect(await playProdRow({ id: "E2", at: T0 + 8_100, prod: true }, "me", get as never)).toBeNull();
  });
});
