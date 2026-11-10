/**
 * A Tex history someone shared with you reads as their chat (Dev2, 2026-11-10: "Open it as Tex's chat"), from the
 * file's text the grant's read answered, the way the gateway's raw history view answers it.
 *
 * Sabotage (run by hand, each fails a test here): drop the kind filter in `matches` → "filters by kind" fails; answer
 * oldest first → "newest first, a page at a time" fails; never set `older` → same test fails.
 */

import { describe, expect, test } from "@jest/globals";
import { FILE_PAGE, fileHistorySource, readHistoryFile } from "../features/tex/history/fileHistorySource";
import { LATEST, type LedgerEntry } from "../features/tex/page/texPageTypes";
import { dayKey } from "../features/tex/history/historyLines";

const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime();
const entry = (id: string, kind: string, time: number, extra: Record<string, unknown> = {}): LedgerEntry => ({ id, kind, at: time, ...extra });
const fileOf = (entries: LedgerEntry[]) => JSON.stringify({ manifest: { schema: "s", version: 1, count: entries.length, created: 1, updated: 2 }, view: { shown: entries.length, older: false }, entries });

describe("a shared history file as a Tex page source", () => {
  test("anything that is not a history file reads as failed, never as an empty chat", async () => {
    expect(readHistoryFile("not json")).toBeNull();
    expect(readHistoryFile('{"tex-history-view":1}')).toBeNull();
    const r = await fileHistorySource("# a note").ledger("me", { before: LATEST });
    expect(r.kind).toBe("failed");
  });

  test("filters by kind and by day", async () => {
    const src = fileHistorySource(fileOf([entry("a", "text", at(8, 9)), entry("b", "thinking", at(8, 10)), entry("c", "text", at(9, 9))]));
    const texts = await src.ledger("me", { kinds: ["text"], before: LATEST });
    expect(texts.kind === "ok" && texts.value.entries.map((e) => e.id)).toEqual(["c", "a"]);
    const day = await src.ledger("me", { day: dayKey(at(8, 12)), before: LATEST });
    expect(day.kind === "ok" && day.value.entries.map((e) => e.id)).toEqual(["b", "a"]);
  });

  test("one job's work, or none of any job's", async () => {
    const src = fileHistorySource(fileOf([entry("a", "text", 1), entry("b", "tool", 2, { jobId: "j1" }), entry("c", "job", 3, { job: "j1" })]));
    const one = await src.ledger("me", { job: "j1", before: LATEST });
    expect(one.kind === "ok" && one.value.entries.map((e) => e.id)).toEqual(["c", "b"]);
    const none = await src.ledger("me", { jobs: false, before: LATEST });
    expect(none.kind === "ok" && none.value.entries.map((e) => e.id)).toEqual(["c", "a"]);
  });

  test("newest first, a page at a time", async () => {
    const all = Array.from({ length: FILE_PAGE + 5 }, (_, i) => entry(`e${i}`, "text", i + 1));
    const src = fileHistorySource(fileOf(all));
    const first = await src.ledger("me", { before: LATEST });
    if (first.kind !== "ok") throw new Error("not read");
    expect(first.value.entries).toHaveLength(FILE_PAGE);
    expect(first.value.entries[0]!.id).toBe(`e${FILE_PAGE + 4}`);
    expect(first.value.older).toBeDefined();
    const next = await src.ledger("me", { before: first.value.older });
    if (next.kind !== "ok") throw new Error("not read");
    expect(next.value.entries.map((e) => e.id)).toEqual(["e4", "e3", "e2", "e1", "e0"]);
    expect(next.value.older).toBeUndefined();
  });

  test("nothing else a Tex page asks for is this reader's, and nothing is live", async () => {
    const src = fileHistorySource(fileOf([]));
    expect((await src.overview("me")).kind).toBe("notYours");
    expect((await src.act("me", { kind: "x" } as never)).ok).toBe(false);
    expect(src.live("me", () => {}, () => {})).toBeNull();
  });
});
