/**
 * THE CONSOLE'S AI COSTS MAPPING: who paid, what each gateway label and
 * Workers AI model is, and which Tex step each call belongs to. Tables and
 * pure classifiers only; the arithmetic is `consoleCosts.ts`.
 *
 * The Tex step table is `packages/tex/src/texSteps.cjs`, read from
 * `texConfig.json` (the nodes whose model is not "code"), so it cannot drift
 * from the Lab.
 */

import { TEX_STEPS, texStepForModel, type TexStepDef } from "@context/tex/src/texSteps.cjs";
import { CLEF_MODEL, GLM_MODEL } from "../jev/models";
import { AI_KEYS } from "@context/tex/src/aiKeys.cjs";

export { CLEF_MODEL, GLM_MODEL };

/** Gateway labels of the test suites: their cost is shown apart, never in the total. */
export const LAB_FEATURES: ReadonlySet<string> = new Set(["benchmark", "bench"]);

export interface CreditKey {
  key: string;
  /** The `payer` label the gateway request carries. */
  alias: string;
  label: string;
  /** The credit it holds; null when not known. */
  capUsd: number | null;
  /** When this key began paying (ISO); unlabeled calls from here on are its, until a key is spent. */
  since: string;
  /** Used up: the gateway no longer tries it, so its usage is its cap. */
  spent: boolean;
}

/**
 * The credit keys, in the order production tries them: the one list in `packages/tex/src/aiKeys.json`, so a key added
 * there is a row here with its owner.
 */
export const CREDIT_KEYS: readonly CreditKey[] = AI_KEYS.map((k) => ({
  key: k.key,
  alias: k.alias,
  label: `${k.owner}'s credits`,
  capUsd: k.capUsd,
  since: k.since,
  // Used up as the file records it (its use reached its credit). A key retired until a reset or past its expiry is
  // left out of the gateway's order (aiKeys.cjs keyState) but keeps its row here, counted from what it spent.
  spent: Number.isFinite(k.capUsd) && Number.isFinite(k.usedUsd) && (k.usedUsd as number) >= (k.capUsd as number),
}));

/** When the gateway began sending the `payer` label. Before it, every call is unlabeled. */
export const PAYER_LABEL_SINCE = "2026-11-14T20:00:00Z";

export const PLAN_PAYER = { key: "plan", label: "Claude plan credit", note: "Comes back on the 1st" } as const;
export const CLOUDFLARE_PAYER = { key: "cloudflare", label: "Out of pocket", note: "Cloudflare Unified Billing and Workers AI" } as const;

export const FEATURES = [
  { key: "tex", label: "Tex replies" },
  { key: "checkin", label: "Check-in" },
  // The nightly jobs on someone's notes: dream, reflect, day summaries and housekeeping.
  { key: "dream", label: "Dream and housekeeping" },
  // Meeting summaries and the transcription (Whisper) under them.
  { key: "meetings", label: "Meetings" },
  { key: "search", label: "Search by meaning" },
  { key: "other", label: "Other" },
] as const;
export type FeatureKey = (typeof FEATURES)[number]["key"];

export { TEX_STEPS, type TexStepDef };

/** The step a Workers AI call is billed to: the first step that is on and runs that texConfig model. */
function workersAiStep(modelKey: string): Bucket {
  const step = texStepForModel(modelKey);
  return step ? { kind: "tex", step } : { kind: "feature", key: "other" };
}

/** Where one row's cost goes: the test suites, a Tex step, or a feature. */
export type Bucket = { kind: "lab" } | { kind: "tex"; step: string } | { kind: "feature"; key: FeatureKey };

const TEXT_CLIENTS: ReadonlySet<string> = new Set(["texts", "texts-group", "app"]);
const DREAM_CLIENTS: ReadonlySet<string> = new Set(["dreams", "reflect", "memory_nudge"]);
const DREAM_FEATURES: ReadonlySet<string> = new Set(["day-summary", "handback-miner"]);

/**
 * The Tex step a gateway call belongs to, by its feature and client labels; null when it is none. A call from a step
 * retired off the config (2026-11-20: job check, job mail, reviewer, classifier, self-review; their code kept) is
 * billed to the live step it was folded into, so the steps still add up to Tex's whole spend.
 */
export function texStepOf(feature: string, client: string, model: string): string | null {
  const is = (name: string) => feature === name || client === name;
  if (client === "advisor") return "advisor";
  if (is("job-check")) return "jobadv";
  if (is("job-advisor")) return "jobadv";
  if (feature === "assistant" && TEXT_CLIENTS.has(client)) return /opus/.test(model) ? "advisor" : "fd";
  if (is("reviewer")) return "answerCheck";
  if (is("threads") || is("threads_backfill")) return "afterReply";
  if (is("mail-checker")) return "mail";
  if (is("card-check")) return "card";
  if (is("self-review")) return "afterReply";
  if (is("handback-judge")) return "handback";
  return null;
}

/** Where a gateway call's cost goes. */
export function gatewayBucket(feature: string, client: string, model: string): Bucket {
  if (LAB_FEATURES.has(feature)) return { kind: "lab" };
  const step = texStepOf(feature, client, model);
  if (step) return { kind: "tex", step };
  if (/meeting/i.test(feature) || /meeting/i.test(client)) return { kind: "feature", key: "meetings" };
  if (client === "heartbeat") return { kind: "feature", key: "checkin" };
  if (DREAM_CLIENTS.has(client) || DREAM_FEATURES.has(feature)) return { kind: "feature", key: "dream" };
  if (client === "housekeeping") return { kind: "feature", key: "dream" };
  return { kind: "feature", key: "other" };
}

/** Where a Workers AI model's cost goes. */
export function workersAiBucket(model: string): Bucket {
  if (model === CLEF_MODEL) return workersAiStep("clef");
  // GLM was the Front door's fallback; the Fallback step was folded into the Front door and retired (2026-11-20), so
  // a GLM call no step runs any more is billed to the Front door, still Tex's spend.
  if (model === GLM_MODEL) {
    const bucket = workersAiStep("glm-4-7");
    return bucket.kind === "tex" ? bucket : { kind: "tex", step: "fd" };
  }
  if (model.includes("bge")) return { kind: "feature", key: "search" };
  if (model.includes("whisper")) return { kind: "feature", key: "meetings" };
  return { kind: "feature", key: "other" };
}

/**
 * Who paid a successful call. Cloudflare Unified Billing first (wholesale);
 * then the payer label; an unlabeled call is the plan's before the first
 * credit key began, and after it the first credit key not spent.
 */
export function payerKeyOf(payer: string, wholesale: boolean, beforeSince: boolean): string {
  if (wholesale) return CLOUDFLARE_PAYER.key;
  if (payer === PLAN_PAYER.key) return PLAN_PAYER.key;
  const credit = CREDIT_KEYS.find((k) => k.alias === payer);
  if (credit) return credit.key;
  if (payer === "") {
    if (beforeSince) return PLAN_PAYER.key;
    return CREDIT_KEYS.find((k) => !k.spent)?.key ?? "unknown";
  }
  return "unknown";
}
