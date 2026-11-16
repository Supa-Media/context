/**
 * Live mode's sync engine (`features/tex/lab/engine/live.ts`): what batch a Lab edit sends, what a conflict does,
 * when a newer draft from the server is taken, and which steps light up. The server is a fake `applyEdits`.
 *
 * Sabotage record (temporary local edits, reverted):
 *   flush diffing the page against the folded graph             "sends only the edits since the confirmed draft" fails
 *   reconcile taking the remote while a request is out          "waits for the request" fails
 *   reconcile skipping the rebase of unsent edits               "keeps unsent edits on top" fails
 *   flush without flushSetup (2026-11-15, the dropped-picks bug) "the Run tab's picks and areas ... are sent" fails
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { mainGraph } from "../features/tex/lab/data/graph";
import { ago, aiClient, bind, flush, hlClass, isLive, live, onRemote, pendingOps, resetLive, setFeed, setSender, setSetupSender, setupPending, stepsOf, tick, whoLabel, type Answer } from "../features/tex/lab/engine/live";
import { clone, lab, MAIN } from "../features/tex/lab/engine/state";
import { versionPrint } from "../features/tex/lab/engine/sandboxPlay";
import { unfoldGroups } from "../features/tex/lab/engine/groups";
import type { LabGraph } from "../features/tex/lab/types";

const base = (): LabGraph => unfoldGroups(clone(mainGraph()));
const firstId = (g: LabGraph) => g.nodes.find((n) => n.model === "sonnet" || n.effort)?.id ?? g.nodes[1].id;

let sent: Array<{ baseRev: number; ops: Array<{ op: string; node?: string; field?: string; value?: unknown }> }>;
let answer: Answer | (() => Promise<Answer>);

beforeEach(() => {
  jest.useFakeTimers();
  resetLive();
  sent = [];
  answer = { status: "ok", rev: 6, said: [], others: [] };
  setSender(async (_id, baseRev, ops) => {
    sent.push({ baseRev, ops: JSON.parse(ops) });
    return typeof answer === "function" ? answer() : answer;
  });
  lab.versions = [MAIN, { id: "v1", name: "Mine", graph: clone(base()), picks: null, results: [], authorId: "u1", rev: 5 }];
  lab.cur = clone(lab.versions[1]);
  lab.cfocus = null;
  lab.dirty = false;
  lab.sel = null;
  tick();
});

describe("live mode", () => {
  test("a saved version is live, main is not", () => {
    expect(isLive()).toBe(true);
    expect(live.rev).toBe(5);
    lab.cur = clone(MAIN);
    tick();
    expect(isLive()).toBe(false);
  });

  test("sends only the edits since the confirmed draft, after the debounce", async () => {
    const id = firstId(lab.cur.graph);
    lab.cur.graph.nodes.find((n) => n.id === id)!.x += 40;
    lab.dirty = true;
    tick();
    expect(sent).toHaveLength(0);
    jest.advanceTimersByTime(400);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0].baseRev).toBe(5);
    expect(sent[0].ops.map((o) => o.op)).toEqual(["move"]);
    expect(sent[0].ops[0].node).toBe(id);
  });

  test("ok: the draft moves to the answered revision and nothing is pending", async () => {
    lab.cur.graph.nodes[1].y += 25;
    lab.dirty = true;
    await flush();
    expect(live.rev).toBe(6);
    expect(lab.dirty).toBe(false);
    expect(pendingOps(live.synced!, lab.cur.graph)).toEqual([]);
  });

  test("one request at a time; edits made meanwhile go in the next batch", async () => {
    let release!: (a: Answer) => void;
    answer = () => new Promise<Answer>((r) => (release = r));
    lab.cur.graph.nodes[1].y += 25;
    lab.dirty = true;
    const first = flush();
    const second = flush();
    expect(sent).toHaveLength(1);
    lab.cur.graph.nodes[2].y += 10;
    release({ status: "ok", rev: 6, said: [], others: [] });
    await first;
    await second;
    expect(lab.dirty).toBe(true);
    answer = { status: "ok", rev: 7, said: [], others: [] };
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1].baseRev).toBe(6);
    expect(sent[1].ops).toHaveLength(1);
    expect(live.rev).toBe(7);
  });

  test("conflict: tells who changed it first and takes the server's graph, lighting what changed", async () => {
    const n = lab.cur.graph.nodes[1];
    const theirs = clone(base());
    theirs.nodes[1].x += 90;
    setFeed({ rev: 6, live: { client: "Claude Code", who: "dev", at: Date.now() }, changes: [{ rev: 6, who: "dev", via: "Claude Code", said: ["moved"], at: Date.now() }] });
    n.x += 5;
    lab.dirty = true;
    answer = { status: "conflict", rev: 6, keys: [`n:${n.id}:x`], now: {}, others: [] };
    await flush();
    expect(lab.toastText).toBe(`Claude Code changed ${n.id} x first; showing theirs`);
    expect(live.stale).toBe(true);
    expect(sent).toHaveLength(1);
    onRemote("v1", 6, theirs);
    expect(live.stale).toBe(false);
    expect(lab.cur.graph.nodes.find((x) => x.id === n.id)!.x).toBe(theirs.nodes[1].x);
    expect(lab.dirty).toBe(false);
    expect(hlClass(n.id)).toContain("hl-ai");
  });

  test("bad request: toasts the error and goes back to the draft", async () => {
    lab.cur.graph.nodes[1].y += 25;
    lab.dirty = true;
    answer = { status: "bad_request", error: "that step does not exist" };
    await flush();
    expect(lab.toastText).toBe("that step does not exist");
    expect(lab.dirty).toBe(false);
    expect(pendingOps(live.synced!, lab.cur.graph)).toEqual([]);
  });

  test("a newer revision is taken at once when nothing is unsent, and lights the steps it changed", () => {
    const theirs = clone(base());
    theirs.nodes[2].on = !theirs.nodes[2].on;
    onRemote("v1", 6, theirs);
    expect(live.rev).toBe(6);
    expect(lab.cur.graph.nodes[2].on).toBe(theirs.nodes[2].on);
    expect(hlClass(theirs.nodes[2].id)).toContain(" hl hl-lab");
    expect(hlClass(theirs.nodes[3].id)).toBe("");
  });

  test("an older or same revision changes nothing", () => {
    const theirs = clone(base());
    theirs.nodes[2].on = !theirs.nodes[2].on;
    onRemote("v1", 5, theirs);
    expect(live.rev).toBe(5);
    expect(lab.cur.graph.nodes[2].on).not.toBe(theirs.nodes[2].on);
  });

  test("keeps unsent edits on top of a newer revision", () => {
    lab.cur.graph.nodes[1].y += 25;
    lab.dirty = true;
    const theirs = clone(base());
    theirs.nodes[2].x += 70;
    onRemote("v1", 6, theirs);
    expect(lab.cur.graph.nodes[2].x).toBe(theirs.nodes[2].x);
    expect(lab.cur.graph.nodes[1].y).toBe(base().nodes[1].y + 25);
    expect(lab.dirty).toBe(true);
    expect(pendingOps(live.synced!, lab.cur.graph).map((o) => o.op)).toEqual(["move"]);
  });

  test("waits for the request, then takes what the server merged", async () => {
    let release!: (a: Answer) => void;
    answer = () => new Promise<Answer>((r) => (release = r));
    lab.cur.graph.nodes[1].y += 25;
    lab.dirty = true;
    const p = flush();
    const theirs = clone(base());
    theirs.nodes[1].y += 25;
    theirs.nodes[2].x += 70;
    onRemote("v1", 7, theirs);
    expect(live.rev).toBe(5);
    expect(lab.cur.graph.nodes[2].x).toBe(base().nodes[2].x);
    release({ status: "ok", rev: 7, said: [], others: [{}] });
    await p;
    expect(live.rev).toBe(7);
    expect(lab.cur.graph.nodes[2].x).toBe(theirs.nodes[2].x);
    expect(lab.dirty).toBe(false);
    expect(live.stale).toBe(false);
  });

  test("steps inside a folded group light the folded box", () => {
    lab.cfocus = null;
    const member = base().nodes.find((n) => n.group);
    if (!member) return;
    const theirs = clone(base());
    theirs.nodes.find((n) => n.id === member.id)!.x += 30;
    lab.cur.graph = unfoldGroups(clone(lab.cur.graph));
    onRemote("v1", 6, theirs);
    expect(stepsOf([{ op: "move", node: member.id, x: 0, y: 0 }])).toEqual([member.id]);
  });
});

describe("what the bar and list say", () => {
  test("the AI chip shows inside ten minutes only", () => {
    setFeed({ rev: 5, live: { client: "Claude Code", who: "dev", at: 1000 }, changes: [] });
    expect(aiClient(1000 + 9 * 60_000)).toBe("Claude Code");
    expect(aiClient(1000 + 11 * 60_000)).toBeNull();
    setFeed({ rev: 5, live: null, changes: [] });
    expect(aiClient()).toBeNull();
  });

  test("You for your own Lab edits, the client's name for an AI's, else the handle", () => {
    expect(whoLabel({ who: "dev", via: "lab" }, "dev")).toBe("You");
    expect(whoLabel({ who: "dev", via: "Claude Code" }, "dev")).toBe("Claude Code");
    expect(whoLabel({ who: "sam", via: "lab" }, "dev")).toBe("sam");
  });

  test("relative time", () => {
    expect(ago(1000, 10_000)).toBe("just now");
    expect(ago(0, 5 * 60_000)).toBe("5 min ago");
    expect(ago(0, 3 * 3600_000)).toBe("3 h ago");
  });

  test("bind starts and stops a draft", () => {
    bind("v1", base(), 9);
    expect(live.since).toBe(0);
    bind("main", base(), 40);
    expect(live.synced).toBeNull();
    expect(live.since).toBe(10);
  });

  test("the Run tab's picks and areas on a live draft are sent, not dropped", async () => {
    const setups: Array<{ picks: string; areas: string | null }> = [];
    setSetupSender(async (_id, picks, areas) => {
      setups.push({ picks, areas });
      return { status: "ok", rev: 6 };
    });
    // A pick and an area, as the Tests tab's checkbox and the Run tab's area buttons make them: no graph edit.
    lab.cur.picks = { core: ["q1"] };
    lab.cur.areas = ["core"];
    lab.dirty = true;
    expect(setupPending()).toBe(true);
    await flush();
    expect(sent).toHaveLength(0);
    expect(setups).toEqual([{ picks: JSON.stringify({ core: ["q1"] }), areas: JSON.stringify(["core"]) }]);
    expect(lab.dirty).toBe(false);
    expect(setupPending()).toBe(false);
    // Nothing left to send: the next flush sends nothing.
    await flush();
    expect(setups).toHaveLength(1);
    // A refused setup goes back to the saved one.
    setSetupSender(async () => ({ status: "bad_request", error: "no" }));
    lab.cur.areas = null;
    lab.dirty = true;
    await flush();
    expect(lab.cur.areas).toEqual(["core"]);
    setSetupSender(null);
  });

  test("a graph edit and a pick together: the edit goes first, then the pick", async () => {
    const setups: string[] = [];
    setSetupSender(async (_id, picks) => {
      setups.push(picks);
      return { status: "ok", rev: 7 };
    });
    lab.cur.graph.nodes[1].y += 25;
    lab.cur.picks = { mail: [] };
    lab.dirty = true;
    await flush();
    expect(sent).toHaveLength(1);
    expect(lab.dirty).toBe(true);
    await flush();
    expect(setups).toEqual([JSON.stringify({ mail: [] })]);
    expect(lab.dirty).toBe(false);
    setSetupSender(null);
  });
});

describe("the test chat's version print (sandboxPlay.ts)", () => {
  // A test turn runs the draft as the server saved it: ▶ must go stale on the page's own saved edit (2026-11-16 review:
  // it only moved on someone else's), and not on a step moved or an edit not saved yet.
  test("moves on a saved edit to what runs, not on a move or an unsaved edit", async () => {
    const id = firstId(lab.cur.graph);
    const before = versionPrint();
    lab.cur.graph.nodes.find((n) => n.id === id)!.x += 40;
    lab.dirty = true;
    await flush();
    expect(live.rev).toBe(6);
    expect(versionPrint()).toBe(before);
    lab.cur.graph.nodes.find((n) => n.id === id)!.ms += 1000;
    lab.dirty = true;
    expect(versionPrint()).toBe(before);
    answer = { status: "ok", rev: 7, said: [], others: [] };
    await flush();
    expect(lab.cur.rev).toBe(7);
    expect(versionPrint()).not.toBe(before);
  });
});
