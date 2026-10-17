/**
 * THE SUGGESTED ICON, AGAINST THE REAL MODEL.
 *
 * `iconSuggest.test.ts` proves the questions with a stand-in model. This asks
 * the deployed inference Worker, so Clef itself, about real folder and note
 * names, and prints what it would suggest for each, so a person can read the
 * list in the job log and judge it. It fails only when a name gets no
 * suggestion at all.
 *
 * Skipped unless ICON_LIVE_URL and ICON_LIVE_SECRET are set, as the
 * "Icon Suggest (live)" workflow sets them. Only invented names are sent;
 * a run is two requests a name.
 */

import { describe, expect, test } from "vitest";
import { suggestIconFor } from "@context/shared/src/iconSuggest";

const url = process.env.ICON_LIVE_URL ?? "";
const secret = process.env.ICON_LIVE_SECRET ?? "";
/** Any 64 hex characters: the Worker counts callers by it and never sees a workspace id. */
const CALLER = "c4".repeat(32);

type DecideRequest = { state: string; questions: Record<string, unknown> };

/** The deployed Worker's `/decide`, over the network, exactly as the control plane calls it. */
function deployedWorker(baseUrl: string, key: string) {
  return async (request: DecideRequest): Promise<{ answers: Record<string, unknown> | null; status: string }> => {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/decide`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-caller-hash": CALLER },
      body: JSON.stringify(request),
    });
    // The Worker's own refusal ("502 the decision engine failed") never quotes a name.
    if (!response.ok) return { answers: null, status: `${response.status} ${(await response.text()).slice(0, 200)}` };
    const body = (await response.json()) as { answers?: Record<string, unknown> };
    return { answers: body.answers ?? null, status: String(response.status) };
  };
}

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
  "2-areas/kids school",
  "1-projects/Q4 budget.md",
  "3-resources/japan trip",
  "2-areas/gym",
  "1-projects/podcast",
];

describe.skipIf(url === "" || secret === "")("the suggested icon, live", () => {
  test("every real name gets an emoji from the whole set", async () => {
    const worker = deployedWorker(url, secret);
    const refusals: string[] = [];
    // A few at a time, as people opening pickers would, not every name at once.
    const results: { name: string; icon: string | null; ms: number }[] = [];
    for (let at = 0; at < NAMES.length; at += 3) {
      results.push(
        ...(await Promise.all(
          NAMES.slice(at, at + 3).map(async (name) => {
            const started = Date.now();
            const icon = await suggestIconFor(name, async (request) => {
              const { answers, status } = await worker(request);
              if (answers === null) refusals.push(`${name}: ${status}`);
              return answers;
            });
            return { name, icon, ms: Date.now() - started };
          }),
        )),
      );
    }
    for (const { name, icon, ms } of results) console.log(`${icon ?? "(none)"}  ${name}  ${ms}ms`);
    // One failure is retried; print them, and fail only on a name left without an answer.
    if (refusals.length > 0) console.log(`refused, then retried: ${refusals.join("; ")}`);
    expect(results.filter((one) => one.icon === null).map((one) => one.name)).toEqual([]);
  }, 180_000);
});
