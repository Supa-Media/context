/**
 * @jest-environment jsdom
 */

/**
 * A chat's conversations in the app (Dev2, 2026-11-07: the conversations UI
 * "in the Tex Hub and also when you open the Tex folder", then "build it
 * then"): the hub's section, the Conversations page with a conversation opened
 * to its lines, the conversations file in a Tex folder opening as that page,
 * and the reads that keep a malformed answer out.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-07):
 *  1. The hub's section listing finished conversations too → "the hub shows the
 *     open ones and the way to all of them" fails.
 *  2. `gatewaySource.conversation` not sending the thread's id → "the source
 *     asks the ledger route for them" fails.
 *  3. `chatFileKind` always answering `history` → "the conversations file is
 *     placed as the history file is, and named for what it opens as" fails.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context";

jest.mock("../features/tex/history/useSeesTurnTiming", () => ({ useSeesTurnTiming: () => false }));
jest.mock("expo-router", () => ({ Redirect: () => null, Stack: () => null, router: { push: () => {} }, useLocalSearchParams: () => ({}) }));

import { TexPageBody, type Place } from "../features/tex/page/TexPageBody";
import { fixtureNow, fixtureSource } from "../features/tex/page/texPageFixture";
import { gatewaySource, type TexPageSource } from "../features/tex/page/texPageSource";
import { useTexPage } from "../features/tex/page/useTexPage";
import { readConversationDetail, readConversations } from "../features/tex/conversations/conversationsRead";
import { chatFileKind, historyFileChat } from "../features/tex/history/historyFile";
import { isHistoryView } from "../features/console/files/ledgerDownload";
import { displayName } from "../features/console/files/paths";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Harness({ source, start }: { source: TexPageSource; start: Place }) {
  const [place, setPlace] = useState<Place>(start);
  const page = useTexPage(source, place.chat);
  return createElement(TexPageBody, { source, page, place, go: setPlace, computer: null, openComputer: () => {}, now: fixtureNow });
}

const tick = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });

async function render(source: TexPageSource, start: Place = { chat: "me" }) {
  act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(Harness, { source, start }))));
  await tick();
}

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function press(id: string) {
  const el = byTestId(id);
  if (el === null) throw new Error(`no ${id}`);
  act(() => el.click());
  await tick();
}

describe("a chat's conversations", () => {
  test("the hub shows the open ones and the way to all of them", async () => {
    await render(fixtureSource());
    const peek = byTestId("tex-conversations-peek")?.textContent ?? "";
    expect(peek).toContain("Conversations · 2 open");
    expect(peek).toContain("Lisbon trip, hotel and flights");
    expect(peek).toContain("Car registration renewal");
    expect(peek).not.toContain("Dentist");
    expect(peek).toContain("All conversations · 1 finished");
  });

  test("the page lists them open first and opens one to its lines", async () => {
    await render(fixtureSource());
    await press("tex-more-conversations");
    const page = byTestId("tex-conversations-page")?.textContent ?? "";
    expect(page).toContain("Open · 2");
    expect(page).toContain("Finished · 1");
    expect(page.indexOf("Car registration")).toBeLessThan(page.indexOf("Dentist"));
    expect(byTestId("tex-conversation-t1-lines")).toBeNull();
    await press("tex-conversation-t1");
    const lines = byTestId("tex-conversation-t1-lines")?.textContent ?? "";
    expect(lines).toContain("find me a hotel in Lisbon");
    expect(lines).toContain("On it. Seat 14A is free; holding it now.");
    expect(lines.indexOf("find me a hotel")).toBeLessThan(lines.indexOf("Seat 14A"));
    await press("tex-conversation-t1");
    expect(byTestId("tex-conversation-t1-lines")).toBeNull();
  });

  test("the page opens from its address", async () => {
    await render(fixtureSource(), { chat: "me", view: "conversations" });
    expect(byTestId("tex-conversations-page")).not.toBeNull();
  });

  test("the source asks the ledger route for them", async () => {
    const posted: Record<string, unknown>[] = [];
    const source = gatewaySource({
      endpoint: "https://mcp.example.test/mcp",
      handle: "dana",
      token: async () => "tk",
      fetch: (async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        posted.push(body);
        const answer = body.view === "conversations" ? { threads: [{ id: "t1", title: "A", description: "d", status: "open", started: 1, last: 2, texts: 1 }] } : { thread: null, lines: [], more: false };
        return { status: 200, json: async () => answer } as Response;
      }) as unknown as typeof fetch,
    });
    const list = await source.conversations!("me");
    expect(list).toEqual({ kind: "ok", value: [{ id: "t1", title: "A", description: "d", status: "open", started: 1, last: 2, texts: 1 }] });
    await source.conversation!("me", "t1");
    expect(posted).toEqual([
      { handle: "dana", chat: "me", view: "conversations" },
      { handle: "dana", chat: "me", view: "conversation", thread: "t1" },
    ]);
  });

  test("a malformed answer is kept out", () => {
    expect(readConversations({ threads: [{ id: "../x", started: 1, last: 1 }, { id: "t2", title: "", started: 1, last: 3, status: "weird" }] })).toEqual([
      { id: "t2", title: "Untitled", description: "", status: "open", started: 1, last: 3, texts: 0 },
    ]);
    expect(readConversations({ manifest: null, entries: [] })).toEqual([]);
    expect(readConversations("nope")).toBeNull();
    expect(readConversationDetail({ thread: null, lines: [{ id: "a", at: 1, who: "robot", text: "x" }, { id: "b", at: 2, who: "tex", text: "y" }] })).toEqual({
      thread: null,
      lines: [{ id: "b", at: 2, who: "tex", text: "y" }],
      more: false,
    });
  });

  test("the conversations file is placed as the history file is, and named for what it opens as", () => {
    const ws = { id: "w1", slug: "dana" };
    expect(chatFileKind("tex/conversations.ledger.json")).toBe("conversations");
    expect(chatFileKind("tex/history.ledger.json")).toBe("history");
    expect(historyFileChat("tex/conversations.ledger.json", ws, { id: "w1" })).toEqual({ kind: "me" });
    expect(historyFileChat("tex/groups/blue-fox/conversations.ledger.json", ws, { id: "w1" })).toEqual({ kind: "group", folder: "tex/groups/blue-fox" });
    expect(historyFileChat("tex/conversations.ledger.json", ws, { id: "w2" })).toEqual({ kind: "none" });
    expect(isHistoryView("tex/conversations.ledger.json")).toBe(true);
    expect(isHistoryView("projects/conversations.ledger.json")).toBe(false);
    expect(displayName("conversations.ledger.json")).toBe("Conversations");
  });
});
