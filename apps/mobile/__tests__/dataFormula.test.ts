/**
 * The metrics formula engine is the gateway's own module (`apps/mcp/src/data/formula`), imported
 * here as the sheet grid imports `sheets/csv.js`, so the app's preview and the gateway's answer are
 * one computation. This proves it loads and runs under the app's toolchain; the engine's own cases
 * live in `apps/mcp/test/dataFormula.test.mjs`.
 */

import { expect, test } from "@jest/globals";
import { evaluate, formatValue, parseFormula, plainReading, toText } from "../../mcp/src/data/formula/index.js";
import { parseSheet } from "../../mcp/src/sheets/csv.js";

test("the app reads, writes back and works out a formula with the gateway's engine", () => {
  const parsed = parseFormula("sum(stripe/revenue.usd) / sum(cloudflare/ai-spend.usd)");
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(toText(parsed.ast)).toBe("sum(stripe/revenue.usd) ÷ sum(cloudflare/ai-spend.usd)");
  expect(plainReading(parsed.ast, "month")).toBe("Sum of usd in stripe/revenue ÷ sum of usd in cloudflare/ai-spend, each month");
  const sheets = new Map([
    ["stripe/revenue", parseSheet("date:date,usd:usd\n2026-11-02,940\n")],
    ["cloudflare/ai-spend", parseSheet("date:date,usd:usd\n2026-11-03,100\n")],
  ]);
  const result = evaluate(parsed.ast, { rowsOf: (s: string, d: string) => sheets.get(`${s}/${d}`) ?? null, every: "month", now: "2026-11-25T00:00:00Z" });
  expect(result).toEqual({ value: 9.4, status: "ok" });
  expect(formatValue(result.value, "$0.00")).toBe("$9.40");
});
