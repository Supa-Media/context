/**
 * @jest-environment jsdom
 */
/**
 * Walking a turn back to its prompt (Dev2, 2026-11-14: "once we know the version ... what was the prompt for this
 * version, or what were the context modules that were loaded in"): the turn's logged modules, the catalogue AT its
 * commit, and the words shown only when the fingerprint the turn logged is the catalogue's.
 */
import { describe, expect, jest, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { catalogAt, fingerprint, fromRepo, moduleSource, turnPromptOf, wordsOf } from "@context/lab/app/engine/promptAt";
import type { LedgerEntry } from "../features/tex/page/texPageTypes";
import { PromptAt } from "@context/lab/app/views/replay/PromptAt";

const FILE = readFileSync(join(__dirname, "../../../packages/lab/app/promptCatalog.generated.json"), "utf8");
const CAT = JSON.parse(FILE) as { modules: Record<string, { id: string; n: number }>; lines: string[] };
// A stable module this commit builds, and a fixed context one, as a turn would log them.
const [stableH, stable] = Object.entries(CAT.modules).find(([, m]) => m.id === "stable/texting/pictures/edits/production")!;
const [webH, web] = Object.entries(CAT.modules).find(([, m]) => m.id === "context/web")!;
const CODE = "d6af795c863f";

const entries = [
  { id: "x1", at: 1, kind: "text", text: "hi" },
  {
    id: "r1",
    at: 2,
    kind: "reply",
    turn: "t1",
    text: "hey",
    version: { code: CODE, setup: "5ac82586839f" },
    timing: {
      v: 2,
      rounds: [
        { ms: 900, model: "anthropic/claude-haiku-5-5", prompt: { modules: [{ id: stable.id, n: stable.n, h: stableH }, { id: "context/web", n: web.n, h: webH }, { id: "context/aboutMe", n: 400, h: "0badc0de" }, { id: "preamble/now", n: 60, h: "12345678" }], inputs: { at: Date.UTC(2026, 10, 14, 17, 0), timeZone: "America/New_York", model: "anthropic/claude-haiku-5-5", history: 3 } } },
        { ms: 300, prompt: { modules: [{ id: stable.id, n: stable.n, h: stableH }, { id: "context/web", n: web.n, h: webH }, { id: "context/aboutMe", n: 400, h: "0badc0de" }, { id: "preamble/now", n: 60, h: "12345678" }] } },
      ],
    },
  },
] as unknown as LedgerEntry[];

const served = (body: string, ok = true) => jest.fn(async (_url: string) => ({ ok, json: async () => JSON.parse(body) })) as unknown as typeof fetch;

describe("a turn's prompt, walked back from its version", () => {
  test("reads the commit, the setup, each round's modules and what it was built for", () => {
    const p = turnPromptOf(entries, "t1")!;
    expect(p.code).toBe(CODE);
    expect(p.setup).toBe("5ac82586839f");
    expect(p.rounds).toHaveLength(2);
    expect(p.rounds[0].model).toBe("anthropic/claude-haiku-5-5");
    expect(p.rounds[0].modules.map((m) => m.id)).toEqual([stable.id, "context/web", "context/aboutMe", "preamble/now"]);
    expect(p.inputs?.timeZone).toBe("America/New_York");
    expect(turnPromptOf(entries, "nope")).toBeNull();
  });

  test("reads the catalogue at the turn's own commit, and shows words only for a fingerprint it holds", async () => {
    const get = served(FILE);
    const cat = await catalogAt("abcdef123456", get);
    expect((get as unknown as jest.Mock).mock.calls[0][0]).toBe("https://raw.githubusercontent.com/Supa-Media/context/abcdef123456/packages/lab/app/promptCatalog.generated.json");
    const words = wordsOf(cat, { id: stable.id, n: stable.n, h: stableH })!;
    expect(words.length).toBe(stable.n);
    expect(words).toContain("This turn is a text message they sent you from their phone.");
    // A fingerprint the catalogue doesn't hold, or one under another module's name, shows no words.
    expect(wordsOf(cat, { id: "context/aboutMe", n: 400, h: "0badc0de" })).toBeNull();
    expect(wordsOf(cat, { id: "context/web", n: stable.n, h: stableH })).toBeNull();
  });

  test("a commit from before the Lab's package reads its catalogue from the app's old folder (2026-11-20)", async () => {
    const urls: string[] = [];
    const get = jest.fn(async (url: string) => (urls.push(url), url.includes("/packages/lab/app/") ? { ok: false, json: async () => null } : { ok: true, json: async () => JSON.parse(FILE) })) as unknown as typeof fetch;
    const cat = await catalogAt("abcdef654321", get);
    expect(urls).toEqual([
      "https://raw.githubusercontent.com/Supa-Media/context/abcdef654321/packages/lab/app/promptCatalog.generated.json",
      "https://raw.githubusercontent.com/Supa-Media/context/abcdef654321/apps/mobile/features/tex/lab/promptCatalog.generated.json",
    ]);
    expect(wordsOf(cat, { id: stable.id, n: stable.n, h: stableH })).toContain("This turn is a text message they sent you from their phone.");
  });

  test("a turn's kept words are shown only when they hash to the fingerprint it logged (2026-11-17)", () => {
    const note = "@shyoh's newest text doesn't name you.";
    const h = fingerprint(note);
    const logged = [{ ...entries[1], timing: { v: 2, rounds: [{ ms: 9, prompt: { modules: [{ id: "preamble/turnNote", n: note.length, h }], words: { [h]: note, "0badc0de": "about me" } } }] } }] as unknown as LedgerEntry[];
    const p = turnPromptOf(logged, "t1")!;
    expect(wordsOf(null, p.rounds[0].modules[0], p.kept)).toBe(note);
    // Words under a fingerprint they don't hash to are never shown, nor words for a module that logged another size.
    expect(wordsOf(null, { id: "context/aboutMe", n: 8, h: "0badc0de" }, p.kept)).toBeNull();
    expect(wordsOf(null, { id: "preamble/turnNote", n: note.length + 1, h }, p.kept)).toBeNull();
    expect(turnPromptOf(entries, "t1")!.kept).toEqual({});
  });

  test("a commit with no catalogue, or no commit, reads nothing", async () => {
    expect(await catalogAt("0123456789ab", served("{}", false))).toBeNull();
    const get = served(FILE);
    expect(await catalogAt("not a commit", get)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  test("says where a module built from their own words came from", () => {
    expect(fromRepo("stable/texting/production")).toBe(true);
    expect(fromRepo("context/web")).toBe(true);
    expect(fromRepo("context/aboutMe")).toBe(false);
    expect(moduleSource("context/aboutMe")).toContain("tex/about.md");
    expect(moduleSource("preamble/now")).toContain("time");
  });
});

describe("the prompt in Replay's panel", () => {
  test("lists each module in order, opens Tex's rules to their exact words, and names the rest by source", async () => {
    global.fetch = served(FILE);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(PromptAt, { p: turnPromptOf(entries, "t1")! }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const rows = Array.from(host.querySelectorAll<HTMLElement>(".pmod"));
    expect(rows.map((r) => r.dataset.mod)).toEqual([stable.id, "context/web", "context/aboutMe", "preamble/now"]);
    expect(rows[0].querySelector("summary")!.textContent).toContain("exact words");
    expect(rows[0].querySelector("pre")!.textContent!.length).toBe(stable.n);
    expect(rows[2].textContent).toContain("and not kept");
    expect(rows[3].textContent).toContain("The time: Sat, Nov 14");
    expect(host.textContent).toContain("Same modules as the round before.");
    expect(host.querySelector<HTMLAnchorElement>("a.pill")!.href).toBe(`https://github.com/Supa-Media/context/commit/${CODE}`);
    act(() => root.unmount());
  });
});
