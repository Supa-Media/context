/**
 * @jest-environment jsdom
 */

/**
 * Runs from the Lab (Dev2, 2026-11-16, mockup https://claude.ai/artifact/P2vQtigdvALrSWyb5CqQ3E): ▶ Run Dev set at
 * the Lab's top and on the Testing tab, ▶ Run this chat, ▶ Run node, the models picked, the Runs panel with each run's
 * score, misses and the same run as a tex_dev call; a refusal says why; Training and Test chats never run here.
 *
 * Every name and message here is invented. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-16):
 *  1. `useStartRun` dropping `runsUi.models` -> "the models picked go with the run" fails;
 *  2. ▶ Run this chat enabled on a Training chat -> "a Training chat can't be run" fails;
 *  3. the Runs panel listing passes as misses -> "a done run shows its score, its misses and its tex_dev lines" fails;
 *  4. Keep not adding Tex's reply -> "Try a text runs one turn in the test chat and Keep adds both rows" fails.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
const mockCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let mockRefuse: string | null = null;

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  const { ConvexError } = jest.requireActual<typeof import("convex/values")>("convex/values");
  return {
    useQuery: (reference: never, args: unknown) => (args === "skip" ? undefined : mockAnswers.get(getFunctionName(reference))),
    useMutation: (reference: never) => async (args: Record<string, unknown>) => {
      const fn = getFunctionName(reference);
      mockCalls.push({ fn, args });
      if (fn === "functions/texLabRuns:start") {
        if (mockRefuse) throw new ConvexError(mockRefuse);
        return { runId: "run9" };
      }
      return { status: "ok", rev: 1 };
    },
  };
});
jest.mock("expo-router", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return { Redirect: ({ href }: { href: string }) => createElement("div", { "data-testid": "redirect", "data-href": href }) };
});
jest.mock("../features/site/host", () => ({ isTexHost: () => true }));
jest.mock("../features/tex/lab/views/canvas/sandboxCall", () => ({ useSandboxCall: () => false }));
jest.mock("../features/agent/useConsoleGrant", () => ({ useConsoleGrant: () => async () => ({ accessToken: "fake-token" }) }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
Element.prototype.scrollIntoView = function () {};
(globalThis as { fetch?: unknown }).fetch = async () => ({ status: 200, json: async () => ({ stars: 0, perChat: [], chats: [] }) });

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TexLab } from "../features/tex/lab/TexLab.web";
import { clone, MAIN, set } from "../features/tex/lab/engine/state";
import { type Conversation } from "../features/tex/lab/engine/sets";
import { sets } from "../features/tex/lab/engine/setsStore";
import { setRunsUi, type LabRun } from "../features/tex/lab/engine/labRuns";
import { resetSandboxState, setSandboxCall } from "../features/tex/lab/engine/sandbox";

const CHAT: Conversation = {
  id: "picnic",
  title: "Picnic planning",
  set: "dev",
  kind: "group",
  members: ["Ana", "Bo"],
  msgs: [
    { id: "m1", who: "Ana", text: "Tex what's the weather on Sunday?", labels: { decide: { act: "respond", star: true } } },
    { id: "m2", who: "Tex", tex: true, text: "Sunny and mild." },
  ],
};
const TRAIN: Conversation = { id: "errands", title: "Errands", set: "training", kind: "one", members: ["Cy"], msgs: [{ id: "m1", who: "Cy", text: "find a pharmacy open late", labels: { decide: { act: "respond", star: true } } }] };
const draft = (c: Conversation) => ({ id: c.id, set: c.set, conv: JSON.stringify(c), rev: 3, by: "u1", at: 1 });
const DONE: LabRun = {
  id: "run1",
  versionId: "main",
  kind: "dev",
  models: "gw",
  stage: "done",
  by: "Dev",
  ghRunUrl: "https://github.com/example/repo/actions/runs/1",
  startedAt: Date.now() - 120_000,
  finishedAt: Date.now() - 60_000,
  results: {
    pass: 1,
    total: 2,
    costUsd: 0.0123,
    ms: 4000,
    perNode: [{ node: "decide", pass: 1, total: 2 }],
    rows: [
      { convId: "picnic", msgIndex: 0, node: "decide", ok: true, got: "respond", want: "respond" },
      { convId: "picnic", msgIndex: 0, node: "triage", ok: false, got: "quiet", want: "judge" },
    ],
  },
};
const GATE: LabRun = { id: "run2", versionId: "v1", kind: "gate", models: "gw", stage: "running", pr: "https://github.com/example/repo/pull/7", startedAt: Date.now() - 5000, results: null };

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
  mockCalls.length = 0;
  mockRefuse = null;
  Object.assign(sets, { convs: [], hiddenTest: [], testStars: 0, showTest: false, chat: null, msg: null, col: null, editing: false, colMenu: false, fresh: null, cols: null, loaded: false, problem: null });
  act(() => setRunsUi({ open: false, run: null, models: "gw", ver: "main" }));
  resetSandboxState();
  setSandboxCall(null);
  localStorage.clear();
});
beforeEach(() => {
  mockAnswers.set("functions/admin:amIAdmin", true);
  mockAnswers.set("functions/texLab:list", { me: "u1", versions: [], caseEdits: [] });
  mockAnswers.set("functions/texSets:list", { drafts: [draft(CHAT), draft(TRAIN)] });
  mockAnswers.set("functions/workspaces:listMyWorkspaces", [{ workspaceId: "w1", slug: "context-lc", kind: "shared", role: "editor" }]);
  mockAnswers.set("functions/texLabRuns:list", []);
  act(() => set({ cur: clone(MAIN), versions: [MAIN], sel: null, view: "canvas", viewer: null, mode: "lab", setChat: null }));
});

const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
async function mount(testing = true) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(TexLab)));
  await tick();
  if (!testing) return;
  click("#modeTesting");
  await tick();
  click('.chat[data-chat="picnic"]');
}
const q = (s: string) => document.querySelector<HTMLElement>(s);
const qa = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
function click(s: string | HTMLElement) {
  const el = typeof s === "string" ? q(s) : s;
  expect(el).not.toBeNull();
  act(() => el!.click());
}
async function pick(sel: string, value: string) {
  const el = q(sel) as HTMLSelectElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await tick();
}
const starts = () => mockCalls.filter((c) => c.fn === "functions/texLabRuns:start").map((c) => c.args);

describe("running from the Lab", () => {
  test("▶ Run Dev set at the Lab's top runs the version open and shows its last score", async () => {
    mockAnswers.set("functions/texLabRuns:list", [DONE]);
    await mount(false);
    expect(q("#labRun")?.textContent).toContain("1/2 right");
    click("#labRunDev");
    await tick();
    expect(starts()).toEqual([{ versionId: "main", kind: "dev", models: "gw" }]);
  });

  test("the models picked go with the run, and the Runs panel opens on it", async () => {
    await mount();
    await pick("#runModels", "cc");
    click("#runDev");
    await tick();
    expect(starts()).toEqual([{ versionId: "main", kind: "dev", models: "cc" }]);
    expect(q("#runsPanel")).not.toBeNull();
  });

  test("▶ Run this chat and ▶ Run node send the chat and the node", async () => {
    await mount();
    click("#runChat");
    await tick();
    click('tr.mr[data-id="m1"] td[data-c="decide"]');
    click("#closeRuns");
    click('tr.mr[data-id="m1"] td[data-c="decide"]');
    click("#runNode");
    await tick();
    expect(starts()).toEqual([
      { versionId: "main", kind: "chat", models: "gw", convId: "picnic" },
      { versionId: "main", kind: "node", models: "gw", nodeId: "decide" },
    ]);
  });

  test("a Training chat can't be run: runs score the Dev set only", async () => {
    await mount();
    click('.chat[data-chat="errands"]');
    expect((q("#runChat") as HTMLButtonElement).disabled).toBe(true);
    expect(q("#runChat")?.title).toMatch(/Dev set/);
  });

  test("a refusal says why", async () => {
    mockRefuse = "3 runs are already waiting: one finishes first";
    await mount();
    click("#runDev");
    await tick();
    expect(document.body.textContent).toContain("3 runs are already waiting");
    expect(q("#runsPanel")).toBeNull();
  });

  test("a done run shows its score, its misses and its tex_dev lines; a gate run counts only", async () => {
    mockAnswers.set("functions/texLabRuns:list", [GATE, DONE]);
    mockAnswers.set("functions/texLabRuns:get", DONE);
    await mount();
    expect(q("#runBar")?.textContent).toContain("1/2 right");
    click("#runsBtn");
    expect(qa("#runsPanel .runrow").map((r) => r.dataset.run)).toEqual(["run2", "run1"]);
    act(() => setRunsUi({ run: "run1" }));
    const panel = q("#runsPanel")!.textContent!;
    expect(panel).toContain("$0.012 (AI gateway)");
    expect(qa("#runsPanel .miss")).toHaveLength(1);
    expect(q("#runsPanel .miss")?.textContent).toContain("got quiet; wanted judge");
    expect(q("#runsPanel .mcp")?.textContent).toBe('tex_dev { action: "run", draft: "main", kind: "dev", models: "gw" }\ntex_dev { action: "runs", id: "run1" }');
    // Open cell goes to the miss's cell and closes the panel.
    click(q("#runsPanel .miss button")!);
    expect(q("#runsPanel")).toBeNull();
    expect(sets.col).toBe("triage");
    // The gate run: the pull request's own check, no score here.
    mockAnswers.set("functions/texLabRuns:get", GATE);
    act(() => setRunsUi({ open: true, run: "run2" }));
    expect(q("#runsPanel")?.textContent).toContain("Its pull request");
    expect(q("#runsPanel")?.textContent).not.toContain("right ·");
    // A gate for a change that reaches no Test set area: done at 0 of 0, said as such, never as a pass rate.
    const NONE: LabRun = { ...GATE, id: "run3", stage: "done", results: { pass: 0, total: 0, costUsd: 0, ms: 0 } };
    mockAnswers.set("functions/texLabRuns:list", [NONE, DONE]);
    mockAnswers.set("functions/texLabRuns:get", NONE);
    act(() => setRunsUi({ open: true, run: "run3" }));
    expect(q("#gateResult")?.textContent).toContain("No Test set needed");
    expect(q("#runsPanel")?.textContent).not.toContain("0/0");
  });

  test("Try a text runs one turn in the test chat on the chat's history, and Keep adds both rows", async () => {
    const calls: Array<{ op: string; body: Record<string, unknown> }> = [];
    let rows: unknown[] = [];
    setSandboxCall(async (op, body) => {
      calls.push({ op, body });
      if (op === "chats") return { chats: [{ chatId: "me", name: "You and Tex" }, { chatId: "f".repeat(64), name: "Band" }] };
      if (op === "open") {
        rows = [{ id: "m1", who: "Ana", text: "Tex what's the weather on Sunday?", prod: true }];
        return { sandboxId: "sb1", people: [{ handle: "ana", name: "Ana" }, { handle: "bo", name: "Bo" }], rows };
      }
      if (op === "send") {
        rows = [
          ...rows,
          { id: "t1", who: String(body.as), text: String(body.text) },
          { id: "t1r", reply: "t1", who: "Tex", text: "Bring sunscreen.", steps: [{ node: "triage", out: "to: judge", ms: 2 }, { node: "decide", out: "act: respond", ms: 400 }] },
        ];
        return { msgId: "t1" };
      }
      if (op === "reset") return { ok: true };
      return { rows, writes: [], running: null };
    });
    await mount();
    await pick("#tryWho", "Bo");
    const box = q("#tryTxt") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, "should we bring a tent");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click("#trySend");
    await tick();
    await tick();
    // A group conversation runs in one of your group chats; Bo is sent by handle.
    expect(calls.slice(0, 4)).toEqual([
      { op: "chats", body: {} },
      { op: "open", body: { source: "set", convId: "picnic", chatId: "f".repeat(64), versionId: "main" } },
      { op: "send", body: { sandboxId: "sb1", as: "bo", text: "should we bring a tent" } },
      { op: "get", body: { sandboxId: "sb1" } },
    ]);
    expect(qa("tr.try").map((r) => r.querySelector(".txt")?.textContent)).toEqual(["should we bring a tent", "Bring sunscreen."]);
    expect(q("#tryPanel")?.textContent).toContain("Bring sunscreen.");
    expect(q("#tryPanel")?.textContent).toContain("act: respond");
    click("#tryKeep");
    await tick();
    const ops = (mockCalls.filter((c) => c.fn === "functions/texSets:edit").pop()?.args.ops ?? []) as Array<{ op: string; msg: { who: string; text: string } }>;
    expect(ops.map((o) => [o.op, o.msg.who, o.msg.text])).toEqual([
      ["addMsg", "Bo", "should we bring a tent"],
      ["addMsg", "Tex", "Bring sunscreen."],
    ]);
    expect(calls.at(-1)?.op).toBe("reset");
    expect(qa("tr.try")).toHaveLength(0);
  });
});
