/**
 * Every feature that uses Jev, registered here or it cannot call Jev at all.
 *
 * Adding a feature is adding an entry. The name is what usage is metered
 * under and what a kill switch turns off, so it never changes once shipped.
 */

export interface JevFeature {
  /** Shown in the admin usage report. */
  label: string;
  /**
   * On when no switch row says otherwise. A feature ships `false` until its
   * screens are live, then flips to `true` in the same PR that launches it.
   */
  onByDefault: boolean;
  /**
   * Requests one workspace may make per UTC day. The framework refuses past
   * this, so a bug in a feature cannot turn into a bill.
   */
  dailyCallsPerWorkspace: number;
  /**
   * Who may reach it. "premium": only a paying workspace, the plan pays for
   * inference. "everyone": every plan may, and `dailyCallsFree` (not
   * `dailyCallsPerWorkspace`) caps a workspace that is not paying.
   */
  plan: "premium" | "everyone";
  /**
   * Requests per UTC day for a workspace that is not paying. Only meaningful
   * for plan "everyone"; a free workspace with none is refused past zero.
   */
  dailyCallsFree?: number;
}

export const JEV_FEATURES = {
  /** The "Suggested" row of an owner picker: who the note names. `functions/owners.ts`. */
  ownerSuggest: {
    label: "Owner suggestion",
    // On with Premium, shipped with its picker row (2026-09-26).
    onByDefault: true,
    // One request per picker opened on a note; a busy editor opens a few dozen.
    dailyCallsPerWorkspace: 300,
    plan: "premium",
  },
  /**
   * The texting assistant's built-in model, when the person has connected no
   * model account of their own. One call is one texted question, whatever
   * number of model rounds it takes. `functions/builtinModel.ts`.
   */
  assistant: {
    label: "Texting assistant (built-in model)",
    // Free for every plan (decided by the owner, 2026-10-17, replacing "Premium,
    // capped" of 2026-10-06), 500 texts a day (raised from 100 by the owner, 2026-10-31).
    onByDefault: true,
    // A busy day of texting; a turn is at most eight model rounds.
    dailyCallsPerWorkspace: 500,
    dailyCallsFree: 500,
    plan: "everyone",
  },
  /**
   * Meeting summaries: a model call that writes a note from a meeting's
   * transcript. The gateway makes the call; `functions/meetingSummary.ts` gates
   * and meters it. Summaries for every plan (decided by the owner, 2026-10-09:
   * "Same for all"); only the daily ceiling differs.
   */
  meetingSummary: {
    label: "Meeting summaries",
    onByDefault: true,
    // Paying: a day's meetings, with room for re-runs. Free: a handful.
    dailyCallsPerWorkspace: 50,
    dailyCallsFree: 10,
    plan: "everyone",
  },
  /**
   * The icon picker's suggested emoji: Clef reads a folder's or note's name
   * (never its text) and picks a topic, then an emoji in it, from the list in
   * `@context/shared/src/iconSuggest.ts`. Asked only when somebody opens the
   * picker; nothing is given an icon on its own (decided by the owner,
   * 2026-10-14). `functions/folderIcons.ts`.
   */
  iconSuggest: {
    label: "Icon suggestions",
    onByDefault: true,
    // Two requests a picker opened on a name that says something: which
    // group of emoji, then which emoji in it.
    dailyCallsPerWorkspace: 600,
    dailyCallsFree: 200,
    plan: "everyone",
  },
  /**
   * Tex deciding when to answer in a texted chat: silent, a tapback, or an
   * answer, which messages an answer covers, and what a text sent mid-turn
   * does (`functions/lib/gatewayRoutes/textDecide.ts`). Every plan (Dev2,
   * 2026-10-26, `docs/design/tex-event-log/CONTRACT.md`); one call per
   * inbound text that reaches the decision.
   */
  textDecide: {
    label: "Tex decides when to answer",
    onByDefault: true,
    // A busy group's day of texts; past it the Worker falls back to answering only when addressed.
    dailyCallsPerWorkspace: 2000,
    dailyCallsFree: 2000,
    plan: "everyone",
  },
} as const satisfies Record<string, JevFeature>;

export type JevFeatureName = keyof typeof JEV_FEATURES;

export function isJevFeature(name: string): name is JevFeatureName {
  return Object.prototype.hasOwnProperty.call(JEV_FEATURES, name);
}

/**
 * Features that were removed, by the name their usage rows still carry.
 * `jevUsage` and `aiModelUsage` keep rows under these names until they age out
 * of every report window; the AI costs report still counts them, under these
 * labels, so its totals add up. Nothing may call Jev under them: they are not
 * in `JEV_FEATURES`, so the gate and the switches refuse them.
 *
 * Auto-organize and What changed were removed by the owner, 2026-10-17:
 * "remove auto organize and whats changed, all of those should be deleted and
 * thrown away, no way to access it in the app and not in use".
 */
export const RETIRED_JEV_FEATURE_LABELS: Readonly<Record<string, string>> = {
  organizer: "Auto-organize (removed)",
  whatChanged: "What changed (removed)",
};

/** Every switch name an admin may set: each feature, and "*" for all of them. */
export const ALL_JEV_FEATURES = "*";
