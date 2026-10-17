/**
 * THE SUGGESTED ICON, MODEL AGAINST MODEL.
 *
 * The owner asked (2026-10-14) whether Jev answers faster or better than
 * Clef for the icon picker's suggestion. This asks each decision model on
 * Workers AI the same questions directly, outside our Worker, so the time
 * printed is the model's own plus the network, and prints each model's pick
 * and time for every name: once reading only Clef's choice of group, once
 * reading its two likeliest groups. Nothing is asserted about the picks;
 * a person reads the table in the job log.
 *
 * Runs only when the "Icon Suggest (live)" workflow is dispatched with
 * `models` ticked, which sets the account and token below. Only invented
 * names are sent.
 */

import { describe, expect, test } from "vitest";
import { type SuggestRequest, suggestIconFor } from "@context/shared/src/iconSuggest";
import { readAnswers } from "../../../infra/transcribe-worker/src/decide";

const account = process.env.ICON_MODELS_ACCOUNT ?? "";
const token = process.env.ICON_MODELS_TOKEN ?? "";

const MODELS = [
  { id: "@cf/cloudflare/clef", selector: "clef" },
  { id: "@cf/cloudflare/clef-flash", selector: "clef-flash" },
  { id: "@cf/typesafe/jev", selector: "jev" },
  { id: "typesafe/jev", selector: "jev" },
];

const NAMES = [
  "tex/routines/once",
  "tex/routines",
  "tex",
  "0-inbox/calendar",
  "1-projects/Bible study",
  "2-areas/taxes",
  "1-projects/walnut-credenza.md",
  "3-resources/recipes",
  "1-projects/wedding planning",
  "1-projects/Q4 budget.md",
  "3-resources/japan trip",
  "1-projects/podcast",
];

interface Call {
  ms: number;
  error: string | null;
}

function modelDecide(model: (typeof MODELS)[number], calls: Call[]) {
  return async (request: SuggestRequest): Promise<Record<string, unknown> | null> => {
    const started = Date.now();
    let error: string | null = null;
    let answers: Record<string, unknown> | null = null;
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model.id}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: model.selector, state: request.state, questions: request.questions }),
      });
      const body = (await response.json().catch(() => null)) as { result?: unknown; errors?: { message?: string }[] } | null;
      answers = readAnswers(body?.result, request.questions);
      if (answers === null) error = `${response.status} ${JSON.stringify(body?.errors ?? body).slice(0, 160)}`;
    } catch (failure) {
      error = String(failure).slice(0, 160);
    }
    calls.push({ ms: Date.now() - started, error });
    return answers;
  };
}

describe.skipIf(account === "" || token === "")("the suggested icon, model against model", () => {
  test("each model's pick and time for each name", async () => {
    const lines: string[] = [];
    let clefAnswered = 0;
    for (const model of MODELS) {
      for (const groupsAsked of [1, 2]) {
        const calls: Call[] = [];
        const picks: string[] = [];
        // A few at a time, as people opening pickers would.
        for (let at = 0; at < NAMES.length; at += 3) {
          const batch = NAMES.slice(at, at + 3);
          const icons = await Promise.all(batch.map((name) => suggestIconFor(name, modelDecide(model, calls), groupsAsked)));
          batch.forEach((name, i) => picks.push(`${name.split("/").pop()} ${icons[i] ?? "-"}`));
          if (model.selector === "clef" && model.id.endsWith("/clef")) clefAnswered += icons.filter((icon) => icon !== null).length;
        }
        const times = calls.filter((call) => call.error === null).map((call) => call.ms).sort((a, b) => a - b);
        const median = times.length === 0 ? null : times[Math.floor(times.length / 2)];
        const errors = [...new Set(calls.map((call) => call.error).filter((e) => e !== null))];
        lines.push(
          `${model.id} · ${groupsAsked} group(s) · median request ${median ?? "-"}ms · ${times.length}/${calls.length} answered`,
          `  ${picks.join(" · ")}`,
          ...errors.slice(0, 2).map((e) => `  error: ${e}`),
        );
      }
    }
    console.log(lines.join("\n"));
    expect(clefAnswered, "Clef, the model in production, answered nothing").toBeGreaterThan(0);
  }, 600_000);
});
