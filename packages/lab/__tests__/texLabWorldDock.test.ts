/**
 * @jest-environment jsdom
 */

/**
 * Made-up group chats in the Lab's test chat (Dev, 2026-11-24, approved artboards `group-chat-sim-artboards/`): the
 * picker's Made-up chats tab opens a scenario on a pull request's preview, the Chat view is the group chat's default,
 * the people strip says who is here and what Tex can see (the preview's answer winning over the estimate), the
 * composer texts as anyone here, Add someone and leaving are the gateway's `join` and `leave`, Fill hides the canvas,
 * and Set up opens the setup in the dock. The gateway here is a stand-in that keeps the chat in memory.
 *
 * Every name, handle and message here is invented. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-24):
 *  1. openSandbox not sending `world` for a made-up chat -> "a scenario opens on the preview" fails;
 *  2. joinPerson not sending `as` -> "Add someone joins" fails;
 *  3. the strip reading only the estimate -> "the preview's answer wins" fails.
 */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => (args === "skip" ? undefined : mockAnswers.get(getFunctionName(reference))),
    useMutation: () => async () => ({ status: "ok" }),
    useAction: () => async () => null,
    useConvex: () => ({ query: async () => null, mutation: async () => null, action: async () => null }),
  };
});
jest.mock("expo-router", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return { Redirect: ({ href }: { href: string }) => createElement("div", { "data-testid": "redirect", "data-href": href }) };
});
jest.mock("../../../apps/mobile/features/site/host", () => ({ isTexHost: () => true }));

type Person = { handle: string; name: string; account: string };
type Row = Record<string, unknown> & { id: string; who: string; text: string };
const mockCalls: Array<{ op: string; body: Record<string, unknown> }> = [];
const mock = { rows: [] as Row[], people: [] as Person[], seq: 0, starting: false };
jest.mock("@context/lab/app/views/canvas/sandboxCall", () => {
  const { setSandboxCall } = jest.requireActual<typeof import("@context/lab/app/engine/sandbox")>("@context/lab/app/engine/sandbox");
  setSandboxCall(async (op: string, body: Record<string, unknown>) => {
    mockCalls.push({ op, body });
    const view = () => ({ sandboxId: "sb1", code: "#12", rows: mock.rows, writes: [], running: null });
    if (op === "chats") return { chats: [{ chatId: "me", name: "me" }] };
    if (op === "open") {
      const w = body.world as { people: Array<{ name: string; account: string }> };
      mock.people = w.people.map((p) => ({ handle: p.account === "on" ? p.name.split(" ")[0].toLowerCase() + "-x1" : p.name, name: p.name, account: p.account }));
      mock.rows = [];
      if (mock.starting) return { sandboxId: "sb1", code: "#12", people: [], rows: [], preview: { pr: 12, starting: true } };
      return { sandboxId: "sb1", code: "#12", people: mock.people, rows: [] };
    }
    if (op === "about" && mock.starting) return { source: "world", kind: "group", people: [], code: "#12", preview: { pr: 12, starting: true } };
    if (op === "about") return { source: "world", kind: "group", people: mock.people, rows: mock.rows.length };
    if (op === "send") {
      const id = "t" + ++mock.seq;
      mock.rows.push(
        { id, who: String(body.as), text: String(body.text), at: Date.now(), steps: [{ node: "triage", out: { to: "tex", why: "asked by name" }, ms: 2 }] },
        { id: id + "r", reply: id, who: "Tex", text: "I can only read this chat's notes here.", at: Date.now(), group: { path: "/agent-texts/group", status: "ok", reach: [], blocked: [{ slug: "lumio", who: "gamma-x1", why: "not_member" }], intro: false, guests: [] } },
      );
      return { msgId: id };
    }
    if (op === "join") {
      mock.people.push({ handle: String(body.name), name: String(body.name), account: String(body.account) });
      const by = mock.people.find((p) => p.handle === body.as)?.name ?? "Someone";
      mock.rows.push({ id: "p" + ++mock.seq, who: "Lab", kind: "people", text: `${by} added ${String(body.name)}`, change: "added", name: String(body.name), at: Date.now() });
      return view();
    }
    if (op === "leave") {
      mock.people = mock.people.filter((p) => p.name !== body.name);
      mock.rows.push({ id: "p" + ++mock.seq, who: "Lab", kind: "people", text: `${String(body.name)} left the conversation`, change: "left", name: String(body.name), at: Date.now() });
      return view();
    }
    return view();
  });
  return { useSandboxCall: () => true };
});

jest.setTimeout(20_000);
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
Element.prototype.scrollIntoView = function () {};

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TexLab } from "@context/lab/app/TexLab.web";
import { clone, MAIN, set } from "@context/lab/app/engine/state";
import { resetSandboxState, setSandboxCode } from "@context/lab/app/engine/sandbox";
import { resetPlay } from "@context/lab/app/engine/sandboxPlay";
import { resetWorld } from "@context/lab/app/views/canvas/world/worldStore";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockCalls.length = 0;
  mock.starting = false;
  resetSandboxState();
  resetPlay();
  resetWorld();
  localStorage.clear();
});
beforeEach(() => {
  mockAnswers.set("functions/admin:amIAdmin", true);
  mockAnswers.set("functions/texLab:list", { me: "u1", versions: [], caseEdits: [] });
  act(() => set({ cur: clone(MAIN), versions: [MAIN], sel: null, view: "canvas", viewer: null, mode: "lab" }));
});

const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(TexLab)));
  await tick();
  await tick();
}
const q = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s);
const qa = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const click = async (s: string) => {
  const el = q(s);
  if (!el) throw new Error("nothing to click: " + s);
  act(() => el.click());
  await tick();
  await tick();
};
async function fill(sel: string, value: string) {
  const el = q<HTMLInputElement | HTMLSelectElement>(sel)!;
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  await tick();
}
const chips = () => qa("#sbPeople .wsr").map((c) => c.textContent);

async function openEveryone() {
  setSandboxCode("#12");
  await mount();
  await click("#sbChat");
  await click('#sbPickTabs [data-tab="test"]');
  await click('#sbChatList [data-world="everyone"]');
  await tick();
}

test("a scenario opens on the preview, in the Chat view, with the people strip and its estimate", async () => {
  await openEveryone();
  const open = mockCalls.filter((c) => c.op === "open").at(-1)!.body;
  expect(open).toMatchObject({ code: "#12", source: "world", versionId: "main" });
  expect(open.world).toMatchObject({ name: "Lumio launch", sponsor: "Alpha Morgan", speaksUp: "attentive", introduced: false, people: [{ name: "Alpha Morgan", account: "on" }, { name: "Beta Chen" }, { name: "Gamma Ellis" }] });
  expect(q("#sbChatName")?.textContent).toBe("Lumio launch");
  expect(q('#sbView [data-v="chat"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(q("#sbChatView")).not.toBeNull();
  expect(qa("#sbPeople .pchip").map((p) => p.textContent)).toEqual(["AAlphabrought Tex in", "BBeta", "GGamma"]);
  expect(chips()).toEqual(["Lumio· read-only: Gamma is a member", "Maison Solenne· kept out by Gamma", "Common Ground· kept out by Alpha", "This chat's notes"]);
  expect(q("#sbPeople .bill")?.textContent).toBe("Billed to Alpha");
  // Texting as: everyone here but Tex, by name; read back from the preview.
  expect(qa("#sbCompose .asc").map((b) => b.getAttribute("data-as"))).toEqual(["Alpha Morgan", "Beta Chen", "Gamma Ellis"]);
});

test("while the preview starts, everyone it opened with can already be picked under Texting as", async () => {
  mock.starting = true;
  await openEveryone();
  expect(qa("#sbCompose .asc").map((b) => b.getAttribute("data-as"))).toEqual(["Alpha Morgan", "Beta Chen", "Gamma Ellis"]);
  await click('#sbCompose [data-as="Gamma Ellis"]');
  expect(q('#sbCompose [data-as="Gamma Ellis"]')?.getAttribute("aria-pressed")).toBe("true");
});

test("texting as someone sends their handle; Tex's answer and the why line show, and the preview's answer wins", async () => {
  await openEveryone();
  await click('#sbCompose [data-as="Beta Chen"]');
  await fill("#sbTxt", "@Tex what's left before Thursday?");
  await click("#sbSend");
  expect(mockCalls.find((c) => c.op === "send")?.body).toMatchObject({ as: "beta-x1", text: "@Tex what's left before Thursday?" });
  const view = q("#sbChatView")!;
  expect(view.querySelector(".r.out .mn.tx")?.textContent).toBe("@Tex");
  expect(view.querySelector(".r.in .b")?.textContent).toBe("I can only read this chat's notes here.");
  expect(view.querySelector(".wy")?.textContent).toMatch(/^Tex answers· asked by name/);
  await click(".wy");
  expect(q(".whyx")?.textContent).toMatch(/Why Tex answered.*Triage.*to Tex/);
  expect(chips()[0]).toBe("This chat's notes");
  expect(chips()).toContain("Lumio· kept out by Gamma");
});

test("Add someone joins, a leave leaves, each an event line with what it changes", async () => {
  await openEveryone();
  await click("#sbAddP");
  await fill("#sbAddName", "Sam");
  await fill("#sbAddAcct", "off");
  await fill("#sbAddBy", "Alpha Morgan");
  expect(q("#sbAddMenu .prev")?.textContent).toMatch(/Tex can't see Lumio/);
  await click("#sbAddGo");
  expect(mockCalls.find((c) => c.op === "join")?.body).toMatchObject({ sandboxId: "sb1", name: "Sam", account: "off", as: "alpha-x1" });
  expect(q("#sbChatView .ev")?.textContent).toMatch(/^Alpha added Sam to the conversation\./);
  expect(q("#sbChatView .evchg")?.textContent).toMatch(/Sam isn't on Context and isn't in Lumio or invited to it, so Tex can't see Lumio from the next text on\./);
  expect(q("#sbPeople .pchip.new")?.textContent).toBe("SSamjoined · not on Context");
  expect(chips()).toContain("Lumio· kept out by Samwas read-only");
  await click("#sbP-GammaEllis");
  await click('[data-leave="Gamma Ellis"]');
  expect(mockCalls.find((c) => c.op === "leave")?.body).toMatchObject({ name: "Gamma Ellis" });
  expect(qa("#sbChatView .ev").map((e) => e.textContent?.replace("⤺ Undo", ""))).toEqual(["Alpha added Sam to the conversation.", "Gamma left the conversation."]);
  expect(qa("#sbPeople .pchip > span:nth-of-type(2)").map((p) => p.textContent)).toEqual(["Alpha", "Beta", "Sam"]);
  expect(qa("#sbPeople .pchip").length).toBe(3);
});

test("Fill hides the canvas; Set up opens the setup in the dock, and opening it opens a new chat", async () => {
  await openEveryone();
  await click("#sbFill");
  expect(q("#sandbox")?.classList.contains("fill")).toBe(true);
  await click("#sbSetup");
  expect(q("#sbSettingUp")?.textContent).toBe("Setting up · nothing runs until you open it");
  expect(q("#sbChatName")?.textContent).toBe("Lumio launch");
  expect(qa("#sbPeopleTab tbody tr").length).toBe(3);
  // Gamma made an editor of Lumio: Tex can edit it now.
  const gammaLumio = qa("#sbPeopleTab tbody tr")[2].querySelectorAll("select")[1] as HTMLSelectElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(gammaLumio, "editor");
    gammaLumio.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await tick();
  expect(qa("#sbSeeLine .wsr")[0].textContent).toBe("Lumio· can edit");
  expect(q(".gfoot .from")?.textContent).toMatch(/Filled in from Everyone on Context/);
  await click("#sbWorldOpen");
  const opens = mockCalls.filter((c) => c.op === "open");
  // Maya's at mount, the scenario's, and the setup's.
  expect(opens.map((o) => o.body.source)).toEqual(["maya", "world", "world"]);
  expect((opens[2].body.world as { people: Array<{ roles?: Record<string, string> }> }).people[2].roles).toEqual({ lumio: "editor", "common-ground": "member" });
  expect(q("#sbSetupView")).toBeNull();
  expect(q("#sbChatView")).not.toBeNull();
});
