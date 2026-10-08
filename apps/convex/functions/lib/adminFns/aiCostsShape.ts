/**
 * THE AI COSTS TAB'S SHAPES: what `admin.aiCostsReport`, `admin.aiCostsAccount`
 * and `admin.aiCostsCloudflare` return, in one place so the queries and the
 * screen agree. Drawn from the mockup the owner approved on 2026-10-08 ("Let's
 * do cost first").
 *
 * Numbers, ids, slugs and account emails only: the console already shows staff
 * all of those. Never a question, an answer or a note.
 *
 * Money is US dollars as a float here (the meter keeps micro-dollars), at list
 * price: a plan's credit may have paid the real bill, which is what the
 * Cloudflare check is for.
 */

import { v, type Infer } from "convex/values";
import { CLEF_MODEL, GEMMA_MODEL, GLM_MODEL } from "../jev/models";

export { CLEF_MODEL, GEMMA_MODEL, GLM_MODEL };

/** The console's 7 / 30 / 90 day picker. */
export const AI_COSTS_WINDOWS = [7, 30, 90] as const;

/** Accounts listed before "+ N more accounts". */
export const AI_COSTS_TOP_ACCOUNTS = 6;

/** Rows the report may read in one go before it says `truncated`. */
export const AI_COSTS_READ_BUDGET = 16_000;

/** Display names for model ids; an id not listed is shown as itself. */
export const MODEL_LABELS: Readonly<Record<string, string>> = {
  [CLEF_MODEL]: "Clef",
  [GLM_MODEL]: "GLM-4.7 Flash",
  [GEMMA_MODEL]: "Gemma 4",
  "anthropic/claude-haiku-5-5": "Claude Haiku 5.5",
  "@cf/openai/whisper-large-v3-turbo": "Whisper turbo",
  "@cf/baai/bge-m3": "bge-m3",
};

export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model;
}

const price = v.object({ input: v.number(), output: v.number(), cacheRead: v.number(), cacheWrite: v.number() });
const featureCost = v.object({ feature: v.string(), costUsd: v.number() });

export const aiCostsReportValidator = v.object({
  days: v.number(),
  /** First UTC day in the window, `YYYY-MM-DD`. */
  since: v.string(),
  totalUsd: v.number(),
  /** The same length of window just before this one. */
  priorUsd: v.number(),
  /** Accounts owning at least one workspace on a paying plan today. */
  payingAccounts: v.number(),
  /** Spend on paying accounts' workspaces ÷ paying accounts; null with none. */
  perPayingAccountUsd: v.union(v.number(), v.null()),
  /** Texted questions answered on the built-in model in the window. */
  textedQuestions: v.number(),
  /** The texting assistant's cost ÷ its questions; null with none. */
  perQuestionUsd: v.union(v.number(), v.null()),
  /** One per metered feature, most expensive first. */
  features: v.array(
    v.object({
      feature: v.string(),
      label: v.string(),
      /** Model ids seen for it in the window, most expensive first; empty before models were recorded. */
      models: v.array(v.string()),
      /** Answered requests: questions for the assistant, calls for the rest. */
      uses: v.number(),
      /** What one use is, in words: "questions", "requests". */
      unit: v.string(),
      eachUsd: v.union(v.number(), v.null()),
      costUsd: v.number(),
    }),
  ),
  /** One per model, most expensive first, from `aiModelUsage`. */
  models: v.array(
    v.object({
      model: v.string(),
      label: v.string(),
      inputTokens: v.number(),
      outputTokens: v.number(),
      /** US dollars per million tokens; null for a model we do not price. */
      price: v.union(price, v.null()),
      costUsd: v.number(),
    }),
  ),
  /** Spend in `jevUsage` with no `aiModelUsage` behind it: before models were recorded. */
  unrecordedModelUsd: v.number(),
  /** Every day in the window, oldest first, zero-filled. */
  daily: v.array(v.object({ day: v.string(), byFeature: v.array(featureCost) })),
  /** The accounts that spent most; an account pays for the workspaces it owns. */
  accounts: v.array(
    v.object({
      userId: v.string(),
      email: v.union(v.string(), v.null()),
      /** "Premium", "Free" and the like, as the roster says it. */
      plan: v.string(),
      workspaces: v.number(),
      costUsd: v.number(),
      byFeature: v.array(featureCost),
      /** Texted questions today across its workspaces, against the per-workspace cap. */
      questionsToday: v.number(),
      questionsCap: v.number(),
    }),
  ),
  moreAccounts: v.number(),
  /** The window held more rows than were read; totals are a floor. */
  truncated: v.boolean(),
});
export type AiCostsReport = Infer<typeof aiCostsReportValidator>;

export const aiCostsAccountValidator = v.union(
  v.null(),
  v.object({
    userId: v.string(),
    email: v.union(v.string(), v.null()),
    plan: v.string(),
    days: v.number(),
    totalUsd: v.number(),
    /** What the plan charges a month, for "12% of the $5 plan"; null when not paying. */
    planUsd: v.union(v.number(), v.null()),
    questionsTexted: v.number(),
    perQuestionUsd: v.union(v.number(), v.null()),
    busiestDay: v.union(v.object({ day: v.string(), costUsd: v.number() }), v.null()),
    /** Today's use of each capped feature, summed over its workspaces. */
    today: v.array(v.object({ feature: v.string(), label: v.string(), used: v.number(), cap: v.number() })),
    /** By workspace, feature and model, most expensive first. */
    rows: v.array(
      v.object({
        workspace: v.string(),
        feature: v.string(),
        label: v.string(),
        models: v.array(v.string()),
        costUsd: v.number(),
      }),
    ),
  }),
);
export type AiCostsAccount = Infer<typeof aiCostsAccountValidator>;

export const aiCostsCloudflareValidator = v.union(
  /** No analytics token on this deployment. */
  v.object({ configured: v.literal(false) }),
  v.object({
    configured: v.literal(true),
    /** Cloudflare could not be asked; the words are ours, never Cloudflare's body. */
    error: v.union(v.string(), v.null()),
    /** What Cloudflare will bill for the window: Workers AI plus AI Gateway. */
    billedUsd: v.number(),
    /** Workers AI by model, from neurons at the published rate. */
    workersAi: v.array(v.object({ model: v.string(), neurons: v.number(), usd: v.number() })),
    /** AI Gateway by model, at the cost Cloudflare logged (0 when a plan's own key paid). */
    gateway: v.array(v.object({ model: v.string(), provider: v.string(), requests: v.number(), costUsd: v.number() })),
  }),
);
export type AiCostsCloudflare = Infer<typeof aiCostsCloudflareValidator>;
