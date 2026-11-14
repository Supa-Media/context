/**
 * THE CONSOLE'S AI COSTS MAPPING: who paid, what each gateway label and
 * Workers AI model is, and which Tex step each call belongs to. Tables and
 * pure classifiers only; the arithmetic is `consoleCosts.ts`.
 *
 * The Tex step table mirrors `packages/shared/src/texConfig.json` (the nodes
 * whose model is not "code"). That file cannot be imported here: this
 * package's tsconfig has no `resolveJsonModule`. `__tests__/consoleCosts.test.ts`
 * reads the JSON with fs and fails when this table drifts, `on` included.
 */

import { CLEF_MODEL, GLM_MODEL } from "../jev/models";

export { CLEF_MODEL, GLM_MODEL };

/** Gateway labels of the test suites: their cost is shown apart, never in the total. */
export const LAB_FEATURES: ReadonlySet<string> = new Set(["benchmark", "bench"]);

export interface CreditKey {
  key: string;
  /** The `payer` label the gateway request carries. */
  alias: string;
  label: string;
  capUsd: number;
  /** When this key began paying (ISO); unlabeled calls from here on are its, until a key is spent. */
  since: string;
  /** Used up: the gateway no longer tries it, so its usage is its cap. */
  spent: boolean;
}

/** The credit keys, in the order the gateway tries them. */
export const CREDIT_KEYS: readonly CreditKey[] = [
  { key: "dev", alias: "dev-claude-credits", label: "dev credits", capUsd: 100, since: "2026-11-13T16:57:00Z", spent: false },
  { key: "dev2", alias: "dev2-claude-credits", label: "dev2 credits", capUsd: 200, since: "2026-11-13T16:57:00Z", spent: true },
];

/** When the gateway began sending the `payer` label. Before it, every call is unlabeled. */
export const PAYER_LABEL_SINCE = "2026-11-14T20:00:00Z";

export const PLAN_PAYER = { key: "plan", label: "Claude plan credit", note: "Comes back on the 1st" } as const;
export const CLOUDFLARE_PAYER = { key: "cloudflare", label: "Out of pocket", note: "Cloudflare Unified Billing" } as const;

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

export interface TexStepDef {
  /** The texConfig node id. */
  id: string;
  label: string;
  /** The texConfig model key (`models` in the json). */
  model: string;
  on: boolean;
}

/** Every texConfig node whose model is not "code", in the json's order. */
export const TEX_STEPS: readonly TexStepDef[] = [
  { id: "decide", label: "Decide", model: "clef", on: true },
  { id: "router", label: "Router", model: "clef", on: false },
  { id: "fd", label: "Front door", model: "haiku-5-5", on: true },
  { id: "fallback", label: "Fallback", model: "glm-4-7", on: true },
  { id: "planner", label: "Big-ask planner", model: "opus-5-5", on: false },
  { id: "advisor", label: "Advisor", model: "opus-5-5", on: true },
  { id: "mail", label: "Mail checker", model: "haiku-5-5", on: true },
  { id: "card", label: "Card check", model: "haiku-5-5", on: true },
  { id: "reviewer", label: "Reply reviewer", model: "haiku-5-5", on: true },
  { id: "classifier", label: "Classifier", model: "haiku-5-5", on: true },
  { id: "selfreview", label: "Self-review", model: "haiku-5-5", on: true },
  { id: "job", label: "Background job", model: "haiku-5-5", on: true },
  { id: "jobcheck", label: "Job check", model: "opus-5-5", on: true },
  { id: "mailadv", label: "Advisor on job mail", model: "opus-5-5", on: true },
  { id: "handback", label: "Hand-back judge", model: "haiku-5-5", on: true },
];

/** Where one row's cost goes: the test suites, a Tex step, or a feature. */
export type Bucket = { kind: "lab" } | { kind: "tex"; step: string } | { kind: "feature"; key: FeatureKey };

const TEXT_CLIENTS: ReadonlySet<string> = new Set(["texts", "texts-group", "app"]);
const DREAM_CLIENTS: ReadonlySet<string> = new Set(["dreams", "reflect", "memory_nudge"]);
const DREAM_FEATURES: ReadonlySet<string> = new Set(["day-summary", "handback-miner"]);

/** The Tex step a gateway call belongs to, by its feature and client labels; null when it is none. */
export function texStepOf(feature: string, client: string, model: string): string | null {
  const is = (name: string) => feature === name || client === name;
  if (client === "advisor") return "advisor";
  if (is("job-check")) return "jobcheck";
  if (is("job-advisor")) return "mailadv";
  if (feature === "assistant" && TEXT_CLIENTS.has(client)) return /opus/.test(model) ? "advisor" : "fd";
  if (is("reviewer")) return "reviewer";
  if (is("threads") || is("threads_backfill")) return "classifier";
  if (is("mail-checker")) return "mail";
  if (is("card-check")) return "card";
  if (is("self-review")) return "selfreview";
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
  if (model === CLEF_MODEL) return { kind: "tex", step: "decide" };
  if (model === GLM_MODEL) return { kind: "tex", step: "fallback" };
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
