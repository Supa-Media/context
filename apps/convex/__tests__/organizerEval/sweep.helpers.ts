/**
 * One auto-organize sweep, end to end, with the model swapped for whatever the
 * suite hands in.
 *
 * Everything between the bucket and the model is production code: the sweep's
 * gather (`gatherOrganizerWork`), the inference Worker's `/decide` route
 * (request checks, the model call, the answer checks), the suggestion rules
 * (`suggestionFor`), the suggestions file and the "without asking" pass. Only
 * the Workers AI binding is a stand-in, which is why a request shape the
 * Worker refuses, or an answer shape it cannot read, fails here the way it
 * fails in production.
 */

import { handleRequest } from "../../../../infra/transcribe-worker/src/index";
import {
  type OrganizerSuggestion,
  gatherOrganizerWork,
  recordOrganizerSweep,
  runOrganizerOperation,
  suggestionFor,
} from "../../functions/lib/organizer/sweepOps";
import { sweepFinish } from "../../functions/lib/organizer/settings";
import { type SweepWhy, askEach } from "../../functions/lib/organizer/ask";
import type { FileStore } from "../../functions/lib/fileOps";
import { NOW, OWNER } from "./workspace.helpers";

const SECRET = "test-only-organizer-eval-secret";
const CALLER = "c4".repeat(32);

/** What the Worker's `env.AI.run` is: a model id and an input, an output back. */
export type AiBinding = { run(model: string, input: unknown): Promise<unknown> };

type DecideRequest = { state: string; questions: Record<string, unknown> };
/** One `/decide` round trip: the answers, or null and the HTTP status. */
export type Decide = (request: DecideRequest) => Promise<{ answers: Record<string, unknown> | null; status: string }>;

/** The answers, or the Worker's own refusal ("502 the decision engine failed"), which never quotes a note. */
async function answersOf(response: Response) {
  if (!response.ok) return { answers: null, status: `${response.status} ${(await response.text()).slice(0, 200)}` };
  const body = (await response.json()) as { answers?: Record<string, unknown> };
  return { answers: body.answers ?? null, status: String(response.status) };
}

function decideRequest(url: string, secret: string, request: DecideRequest): Request {
  return new Request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "x-caller-hash": CALLER },
    body: JSON.stringify(request),
  });
}

/** The Worker's real `/decide` route, run here, with `ai` as its Workers AI binding. */
export function localWorker(ai: AiBinding): Decide {
  return async (request) =>
    answersOf(
      await handleRequest(decideRequest("https://worker.invalid/decide", SECRET, request), {
        AI: ai,
        TRANSCRIBE_WORKER_SECRET: SECRET,
      } as never),
    );
}

/** The deployed Worker, over the network, exactly as the control plane calls it. */
export function deployedWorker(baseUrl: string, secret: string): Decide {
  return async (request) => answersOf(await fetch(decideRequest(`${baseUrl.replace(/\/+$/, "")}/decide`, secret, request)));
}

export interface SweepReport {
  asked: number;
  answered: number;
  /** The Worker's answer to each request it did not answer, for a failing assertion. */
  refusals: string[];
  suggestions: OrganizerSuggestion[];
  finish: "done" | "failed";
  why: SweepWhy | null;
}

/** Gather, ask, suggest, record, and carry out every kind "without asking". */
export async function runSweep(store: FileStore, decide: Decide, concurrency = 4): Promise<SweepReport> {
  const work = await gatherOrganizerWork(store, OWNER, NOW);
  const found: OrganizerSuggestion[] = [...work.ready];
  const refusals: string[] = [];
  // The sweep's own loop, so an early stop or a lost answer shows up here too.
  const asked = await askEach(
    {
      remaining: Number.POSITIVE_INFINITY,
      async decide(request) {
        const { answers, status } = await decide(request);
        if (!answers) refusals.push(status);
        return answers;
      },
    },
    null,
    work.items,
    {
      concurrency,
      onAnswer: (item, answers) => {
        const suggestion = suggestionFor(item, work.destinations, answers);
        if (suggestion) found.push(suggestion);
      },
    },
  );
  await recordOrganizerSweep(store, found, NOW);
  await runOrganizerOperation(
    store,
    OWNER,
    { action: "autopilot", input: JSON.stringify({ kinds: ["done", "archive", "file"] }), autopilot: true },
    NOW,
    null,
  );
  return {
    asked: work.items.length,
    answered: asked.answered,
    refusals,
    suggestions: found,
    finish: sweepFinish(work.items.length, asked.answered),
    why: asked.why,
  };
}
