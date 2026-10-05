/**
 * THE WHAT CHANGED SCORE, AGAINST THE REAL MODELS.
 *
 * `organizerChanges.test.ts` proves the pipeline with a stand-in reader. This
 * sends the same invented workspace's arrivals to the deployed Worker's
 * `/extract`, once per writing model it offers, presses Apply on every card,
 * and scores the result. The default model (Gemma) must reach the bar; the
 * other is scored and logged beside it, with what each run cost, so the
 * choice of model stays a measured one.
 *
 * Skipped unless ORGANIZER_LIVE_URL and ORGANIZER_LIVE_SECRET are set. The
 * workspace is invented, so no customer's note is ever sent.
 */

import { describe, expect, test } from "vitest";
import { changeMisses, changeScore, changingWorkspace, deployedExtract, runChangeSweep } from "./organizerEval/changes.helpers";
import { WRITING_USD_PER_MTOK } from "../functions/lib/jev/meter";

const url = process.env.ORGANIZER_LIVE_URL ?? "";
const secret = process.env.ORGANIZER_LIVE_SECRET ?? "";
const PASS = Number(process.env.ORGANIZER_LIVE_PASS ?? "0.9");

/** Per million tokens, in then out: Cloudflare's price list, 2026-10-05. */
const PRICES = { gemma: WRITING_USD_PER_MTOK, glm: { input: 0.06, output: 0.4 } } as const;

async function scoreWith(model: "gemma" | "glm") {
  const store = changingWorkspace();
  const report = await runChangeSweep(store, deployedExtract(url, secret, model));
  const { score, items } = changeScore(store.snapshot());
  const usd = (report.tokens.input * PRICES[model].input + report.tokens.output * PRICES[model].output) / 1e6;
  console.log(
    JSON.stringify({ model, score, read: report.read, answered: report.answered, cards: report.cards.map((card) => card.title), tokens: report.tokens, usd: Number(usd.toFixed(5)), refusals: report.refusals }),
  );
  console.log(changeMisses(items) || `${model}: no misses`);
  return { score, items, report };
}

describe.skipIf(url === "" || secret === "")("the What changed score, live", () => {
  test(`Gemma catches the workspace up to ${Math.round(PASS * 100)}% or better`, async () => {
    const { score, items, report } = await scoreWith("gemma");
    expect(report.refusals, "the Worker refused or failed these requests").toEqual([]);
    expect(score, changeMisses(items)).toBeGreaterThanOrEqual(PASS);
  }, 300_000);

  test("GLM is scored beside it, for the record", async () => {
    const { report } = await scoreWith("glm");
    expect(report.answered).toBeGreaterThan(0);
  }, 300_000);
});
