/**
 * The Lab's Tools view helpers (`features/tex/lab/views/toolStats.ts`): the artifact's `readToolLog` and `med`, and
 * the live feed turned into the same numbers the table reads. Fake data only.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted:
 *  1. `readToolLog` not counting errors (`err++` removed) → three tests fail, among them "JSONL: each tool and each tool.action counts its calls, times and errors".
 *  2. `fromFeed` dropping the median → "a feed row keeps its median as one sample, and its reasons by text" fails.
 */
import { expect, test } from "@jest/globals";
import { fromFeed, med, readToolLog, type Feed } from "../features/tex/lab/views/toolStats";

const jsonl = [
  '{"kind":"tool","name":"write","args":{"action":"save"},"ok":true,"ms":412}',
  '{"kind":"tool","name":"write","args":{"action":"save"},"ok":false,"ms":900,"reason":"etag"}',
  '{"kind":"tool","name":"search","ok":true,"ms":200}',
].join("\n");

test("JSONL: each tool and each tool.action counts its calls, times and errors", () => {
  const { stats, n } = readToolLog(jsonl);
  expect(n).toBe(3);
  expect(stats.write).toEqual({ calls: 2, ms: [412, 900], err: 1, why: { etag: 1 } });
  expect(stats["write.save"]).toEqual({ calls: 2, ms: [412, 900], err: 1, why: { etag: 1 } });
  expect(stats.search).toEqual({ calls: 1, ms: [200], err: 0, why: {} });
  expect(stats["search.undefined"]).toBeUndefined();
});

test("ignores lines that are not tool entries and lines that do not parse", () => {
  const text = [
    '{"kind":"reply","ms":5000}',
    "not json at all",
    '{"kind":"tool","ok":true,"ms":10}',
    '{"kind":"tool","name":"fetch","ok":true}',
  ].join("\n");
  const { stats, n } = readToolLog(text);
  expect(n).toBe(1);
  expect(Object.keys(stats)).toEqual(["fetch"]);
  expect(stats.fetch).toEqual({ calls: 1, ms: [], err: 0, why: {} });
});

test("a {entries} record and a {ledger} record read the same as a JSON array", () => {
  const rows = [{ kind: "tool", name: "orient", ok: true, ms: 100 }, { kind: "tool", tool: "send", args: { action: "email" }, ok: false, ms: 300 }];
  const a = readToolLog(JSON.stringify(rows));
  expect(readToolLog(JSON.stringify({ entries: rows }))).toEqual(a);
  expect(readToolLog(JSON.stringify({ ledger: rows }))).toEqual(a);
  expect(a.n).toBe(2);
  expect(a.stats["send.email"]).toEqual({ calls: 1, ms: [300], err: 1, why: { failed: 1 } });
});

test("a single JSONL line (one JSON object) is read as one entry", () => {
  const { n, stats } = readToolLog('{"kind":"tool","name":"search","ok":true,"ms":7}');
  expect(n).toBe(1);
  expect(stats.search.ms).toEqual([7]);
});

test("reasons come from reason, then error, then 'failed', and are cut to 60 characters", () => {
  const long = "x".repeat(80);
  const text = [
    '{"kind":"tool","name":"a","ok":false,"ms":1,"error":"boom"}',
    '{"kind":"tool","name":"a","ok":false,"ms":1}',
    `{"kind":"tool","name":"a","ok":false,"ms":1,"reason":"${long}"}`,
  ].join("\n");
  const { stats } = readToolLog(text);
  expect(stats.a.why).toEqual({ boom: 1, failed: 1, ["x".repeat(60)]: 1 });
  expect(stats.a.err).toBe(3);
});

test("an empty or unusable paste reads no entries", () => {
  expect(readToolLog("").n).toBe(0);
  expect(readToolLog("   \n  ").n).toBe(0);
  expect(readToolLog('{"kind":"reply"}').n).toBe(0);
});

test("the median is the upper middle of the sorted samples", () => {
  expect(med([])).toBeNull();
  expect(med([5, 1, 3])).toBe(3);
  expect(med([4, 1, 3, 2])).toBe(3);
});

const feed: Feed = {
  days: 7,
  truncated: false,
  turns: 12,
  calls: 3,
  failuresTotal: 2,
  rows: [
    { key: "write", tool: "write", action: null, calls: 3, errors: 2, medianMs: 450, why: [{ why: "etag", cause: "conflict", count: 1 }, { why: "etag", cause: "stale", count: 1 }, { why: "timeout", cause: "x", count: 1 }] },
    { key: "write.save", tool: "write", action: "save", calls: 3, errors: 2, medianMs: 450, why: [] },
    { key: "search", tool: "search", action: null, calls: 4, errors: 0, medianMs: null, why: [] },
  ],
};

test("a feed row keeps its median as one sample, and its reasons by text", () => {
  const out = fromFeed(feed);
  expect(out.write).toEqual({ calls: 3, ms: [450], err: 2, why: { etag: 2, timeout: 1 } });
  expect(out["write.save"]).toEqual({ calls: 3, ms: [450], err: 2, why: {} });
  expect(out.search).toEqual({ calls: 4, ms: [], err: 0, why: {} });
  expect(med(out.write.ms)).toBe(450);
});
