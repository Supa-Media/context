/**
 * @jest-environment jsdom
 */

/**
 * The Tex page's history after a failed read (2026-11-06): one busy minute on
 * the person's workspace left "The history can't be read right now" on the
 * page until a filter changed, because the first read was never read again.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. No retry after a failed first read → "a failed first read is read again until it answers".
 *  2. Retrying "not yours" too → "a chat that is not theirs is not asked again".
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RETRY_MS, useHistoryRead, type HistoryRead } from "../features/tex/history/useHistoryRead";
import type { Read, TexPageSource } from "../features/tex/page/texPageSource";
import type { LedgerPage } from "../features/tex/page/texPageTypes";

const PAGE = { manifest: null, entries: [], older: undefined } as unknown as LedgerPage;

function sourceAnswering(answers: Read<LedgerPage>[]) {
  const asked: number[] = [];
  const source = {
    ledger: async () => {
      asked.push(Date.now());
      return answers.length > 1 ? answers.shift()! : answers[0]!;
    },
    live: () => null,
  } as unknown as TexPageSource;
  return { source, asked };
}

let root: Root | null = null;
let seen: HistoryRead | null = null;

function Probe({ source }: { source: TexPageSource }) {
  seen = useHistoryRead({ source, chat: "me", group: false });
  return null;
}

async function mount(source: TexPageSource) {
  const host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root!.render(createElement(Probe, { source })));
}

const flush = async (ms: number) => act(async () => void (await jest.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  /*
    Noon, pinned: "today" is part of the read's query, so a run that started
    a few minutes before midnight crossed into the next day inside the
    flushed minutes and asked once more for the new day (2026-11-08, 23:58).
  */
  jest.useFakeTimers({ now: new Date("2026-11-08T12:00:00") });
  seen = null;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  jest.useRealTimers();
});

describe("the Tex page's history after a failed read", () => {
  test("a failed first read is read again until it answers", async () => {
    const { source, asked } = sourceAnswering([{ kind: "failed" }, { kind: "failed" }, { kind: "ok", value: PAGE }]);
    await mount(source);
    await flush(0);
    expect(seen?.read?.kind).toBe("failed");
    await flush(RETRY_MS[0]!);
    expect(asked).toHaveLength(2);
    expect(seen?.read?.kind).toBe("failed");
    await flush(RETRY_MS[1]!);
    expect(asked).toHaveLength(3);
    expect(seen?.read?.kind).toBe("ok");
    // Answered: nothing more is asked.
    await flush(RETRY_MS.reduce((a, b) => a + b, 0));
    expect(asked).toHaveLength(3);
  });

  test("it stops after its last try", async () => {
    const { source, asked } = sourceAnswering([{ kind: "failed" }]);
    await mount(source);
    await flush(RETRY_MS.reduce((a, b) => a + b, 0) + 60_000);
    expect(asked).toHaveLength(RETRY_MS.length + 1);
    expect(seen?.read?.kind).toBe("failed");
  });

  test("a chat that is not theirs is not asked again", async () => {
    const { source, asked } = sourceAnswering([{ kind: "notYours" }]);
    await mount(source);
    await flush(RETRY_MS.reduce((a, b) => a + b, 0));
    expect(asked).toHaveLength(1);
  });
});
