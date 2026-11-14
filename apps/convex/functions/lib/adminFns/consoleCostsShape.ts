/**
 * THE AI COSTS PAGE'S SHAPE: what `consoleAi.costs` returns, in one place
 * so the action and the console agree. Logic is `consoleCosts.ts`; numbers,
 * labels and our own words only, never a question, an answer or a note.
 * Money is US dollars at what Cloudflare billed.
 */

import { v, type Infer } from "convex/values";

const payerValidator = v.object({
  key: v.string(),
  label: v.string(),
  usd: v.number(),
  capUsd: v.union(v.number(), v.null()),
  usedUsd: v.union(v.number(), v.null()),
  leftUsd: v.union(v.number(), v.null()),
  note: v.union(v.string(), v.null()),
});

export const consoleCostsValidator = v.union(
  v.object({ configured: v.literal(false) }),
  v.object({
    configured: v.literal(true),
    /** Our words when Cloudflare could not answer; the figures are then zero or empty. */
    error: v.union(v.string(), v.null()),
    days: v.number(),
    from: v.number(),
    to: v.number(),
    /** People's spend in the window: every feature and Tex step, gateway and Workers AI, lab runs excluded. */
    totalUsd: v.number(),
    /** The same for the window before. */
    priorUsd: v.number(),
    /** The test suites' spend in the window. */
    labRunsUsd: v.number(),
    /** `totalUsd + labRunsUsd`: what Cloudflare reports for the window. */
    billedUsd: v.number(),
    /** Wholesale (Cloudflare Unified Billing) gateway spend, lab runs included. */
    outOfPocketUsd: v.number(),
    /** The same, lab runs excluded. */
    outOfPocketPeopleUsd: v.number(),
    /** The earliest instant the window's gateway figures cover (after the retention clamp). */
    coverageFrom: v.number(),
    /** The prior window reaches back past what Cloudflare keeps, so its figures are partial. */
    priorPartial: v.boolean(),
    /** Answered texts (one-to-one and group) from our turn log in the window; null when the meter was not read. */
    answered: v.union(v.number(), v.null()),
    /** The turn log held more rows than the meter reads, so the job share is the newest part only. */
    meterTruncated: v.boolean(),
    /** Texts people sent Tex in the window (1:1 and group); null when they could not be counted. */
    texts: v.union(v.number(), v.null()),
    perTextBasis: v.union(v.literal("answered"), v.literal("texts"), v.null()),
    perTextDivisor: v.union(v.number(), v.null()),
    perTextUsd: v.union(v.number(), v.null()),
    priorPerTextUsd: v.union(v.number(), v.null()),
    /** Days the dev credit's remaining balance lasts at this window's pace; null without dev spend in the window. */
    devDaysLeft: v.union(v.number(), v.null()),
    payers: v.array(payerValidator),
    features: v.array(
      v.object({
        key: v.string(),
        label: v.string(),
        /** Model names seen, most costly first. */
        models: v.array(v.string()),
        usd: v.number(),
        share: v.number(),
      }),
    ),
    /** One bucket per UTC day (or per hour when `days` is 1), oldest first. */
    daily: v.array(
      v.object({
        label: v.string(),
        byFeature: v.array(v.object({ key: v.string(), usd: v.number() })),
      }),
    ),
    texUsd: v.number(),
    texSteps: v.array(
      v.object({
        id: v.string(),
        label: v.string(),
        model: v.string(),
        on: v.boolean(),
        calls: v.number(),
        usd: v.number(),
        share: v.number(),
      }),
    ),
  }),
);
export type ConsoleCosts = Infer<typeof consoleCostsValidator>;

