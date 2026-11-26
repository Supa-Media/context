/**
 * @jest-environment jsdom
 */

/**
 * The Lab live sandbox's round-3 pieces against the approved mockup (https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5):
 * the "N test writes" menu and the viewer each write opens in (a page read back with op `page`, an email's
 * to/subject/body, a note's body), the composer's line number, "1 step" said once, and a run's finished steps drawn
 * as done (the blue outline) while the step still running keeps its ring and the test cases' colours stay as they were.
 *
 * Every name, address and message here is invented. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-16):
 *  1. `readSandboxPage` sending op "get" -> "a page opens through op page" fails;
 *  2. `writeOf` keeping an http:// address -> "the gateway's contract fields are kept" fails;
 *  3. render's `done` true for anything lit, a test case's set included -> "a run's finished step is drawn done" fails.
 */
import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { pageIdOf, readSandboxPage, resetSandboxState, sandbox, setSandboxCall, writeOf } from "@context/lab/app/engine/sandbox";
import { stepsWord } from "@context/lab/app/engine/playRun";
import { G } from "@context/lab/app/engine/state";
import { simulate } from "@context/lab/app/engine/sim";
import { renderGraphHtml } from "@context/lab/app/views/canvas/render";
import { phoneWords } from "@context/lab/app/views/canvas/SandboxChat.web";
import { opens, SandboxWrites } from "@context/lab/app/views/canvas/SandboxWrites.web";

const calls: Array<{ op: string; body: Record<string, unknown> }> = [];
const PAGE_ID = "0123456789abcdef0123456789abcdef";
const WRITES = [
  { kind: "page", id: "w1", title: "Trip plan", summary: "a page", url: `https://example.test/tex-lab/sandbox/page/sb1/${PAGE_ID}`, expires: 1 },
  { kind: "email", id: "w2", title: "Dinner", summary: "an email", to: "jo@example.test", subject: "Dinner friday?", body: "Are you free at 7?" },
  { kind: "note", id: "w3", title: "Preferences", summary: "a note", body: "Likes window seats." },
  { kind: "calendar", id: "w4", summary: "new event, held in the sandbox" },
];

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  calls.length = 0;
  setSandboxCall(null);
  resetSandboxState();
});
const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
function mount() {
  setSandboxCall(async (op, body) => {
    calls.push({ op, body });
    if (op === "page") return { kind: "page", title: "Trip plan", type: "md", text: "# Trip plan\n\n<b>not html</b>" };
    return {};
  });
  Object.assign(sandbox, { id: "sb1", writes: WRITES.map(writeOf) });
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(() => {
    act(() => root.unmount());
    el.remove();
  });
  act(() => root.render(createElement(SandboxWrites)));
}
const q = (s: string) => document.querySelector<HTMLElement>(s);
const qa = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const click = async (s: string) => {
  const el = q(s);
  if (!el) throw new Error("nothing to click: " + s);
  act(() => el.click());
  await tick();
};

describe("the sandbox writes", () => {
  test("the gateway's contract fields are kept; only an https page address is kept", () => {
    expect(writeOf({ kind: "email", to: "a@example.test", subject: "Hi", body: "Yo", title: "Hi", junk: 1 })).toEqual({ kind: "email", summary: "Hi", title: "Hi", to: "a@example.test", subject: "Hi", body: "Yo" });
    expect(writeOf({ kind: "page", id: "p1", url: "http://example.test/x" }).url).toBeUndefined();
    expect(pageIdOf(writeOf({ kind: "page", id: "p1", url: `https://example.test/a/${PAGE_ID}?x=1` }))).toBe(PAGE_ID);
    expect(pageIdOf(writeOf({ kind: "page", id: "p1" }))).toBe("p1");
    expect(WRITES.map((w) => opens(writeOf(w)))).toEqual([true, true, true, false]);
  });

  test("the menu lists each write; one with nothing to open keeps its line", async () => {
    mount();
    expect(q("#sbChanges")?.textContent).toBe("4 test writes ▾");
    await click("#sbChanges");
    expect(qa(".sbwrites .wr.open").map((b) => b.querySelector(".wt")!.textContent)).toEqual(["Trip planWorking page, gone on Reset", "DinnerSimulated, never sent", "PreferencesIn the test copy of your notes"]);
    expect(q(".sbwrites .wr:not(.open)")?.textContent).toBe("calendarnew event, held in the sandbox");
  });

  test("a page opens through op page, as text, and closes with ×", async () => {
    mount();
    await click("#sbChanges");
    await click('.sbwrites [data-write="0"]');
    await tick();
    expect(calls).toEqual([{ op: "page", body: { sandboxId: "sb1", id: PAGE_ID } }]);
    expect(q("#sbWrite .url")?.textContent).toBe(WRITES[0].url);
    expect(q("#sbwPage")?.textContent).toBe("# Trip plan\n\n<b>not html</b>");
    expect(q("#sbwPage b")).toBeNull();
    await click("#sbwX");
    expect(q("#sbWrite")).toBeNull();
  });

  test("an email shows to, subject and body, never sent; a note shows its body; Escape closes", async () => {
    mount();
    await click("#sbChanges");
    await click('.sbwrites [data-write="1"]');
    expect(q("#sbWrite .mh")?.textContent).toContain("Never sent");
    expect(qa("#sbWrite .kv span").map((s) => s.textContent)).toEqual(["To", "jo@example.test", "From", "You, via Tex", "Subject", "Dinner friday?"]);
    expect(q("#sbWrite .mailb")?.textContent).toBe("Are you free at 7?");
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(q("#sbWrite")).toBeNull();
    await click("#sbChanges");
    await click('.sbwrites [data-write="2"]');
    expect(q("#sbWrite .notev")?.textContent).toBe("Likes window seats.");
    expect(calls).toEqual([]);
  });

  test("a page that can't be read says so", async () => {
    mount();
    setSandboxCall(async () => {
      throw new Error("not_found");
    });
    await click("#sbChanges");
    await click('.sbwrites [data-write="0"]');
    await tick();
    expect(q("#sbWrite .c-bad")?.textContent).toBe("not_found");
  });

  test("readSandboxPage needs an open test chat", async () => {
    await expect(readSandboxPage("x")).rejects.toThrow("Sign in to the console");
  });
});

test("the composer's number reads as a phone shows it", () => {
  expect(phoneWords("+14155550142")).toBe("+1 (415) 555-0142");
  expect(phoneWords("+447700900123")).toBe("+447700900123");
});

test("one step is said once", () => {
  expect([0, 1, 2].map(stepsWord)).toEqual(["0 steps", "1 step", "2 steps"]);
});

test("a run's finished step is drawn done; the step running keeps its ring; without a run nothing is", () => {
  const s = simulate(G(), "own", null, { reply: 13000, ms: { doorStep: 700, fd: 9800, tools: 3200 }, calls: { fd: 3 } });
  const cls = (html: string, id: string) => /<g class="nd([^"]*)" data-id="/.exec(html.slice(html.lastIndexOf('<g class="nd', html.indexOf(`data-id="${id}"`))))![1];
  const html = renderGraphHtml(G(), s, [], null, new Map([["triage", 1], ["fd", 0.4]]));
  // Triage sits in the folded Intake box: its box is drawn done for it.
  expect(cls(html, "intake")).toMatch(/ lit done$/);
  // The Front door sits in its own box now (11-26 cleanup): its box keeps the ring.
  expect(cls(html, "frontDoor")).toMatch(/ lit run$/);
  // Lit by a test case (a set, not a run's progress): as before, never done.
  const plain = renderGraphHtml(G(), s, [], null, new Set(["triage"]));
  expect(cls(plain, "intake")).toMatch(/ lit$/);
});
