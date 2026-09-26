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
  /** Who may reach it. Only "premium" today: the plan pays for inference. */
  plan: "premium";
}

export const JEV_FEATURES = {
  /** Auto-organize: mark done, archive, file the inbox. `functions/organizer.ts`. */
  organizer: {
    label: "Auto-organize",
    // Off until the auto-organize screens ship; nobody could see its work yet.
    onByDefault: false,
    // One sweep a day asks at most MAX_SWEEP_PROJECTS + MAX_SWEEP_INBOX (100).
    dailyCallsPerWorkspace: 250,
    plan: "premium",
  },
} as const satisfies Record<string, JevFeature>;

export type JevFeatureName = keyof typeof JEV_FEATURES;

export function isJevFeature(name: string): name is JevFeatureName {
  return Object.prototype.hasOwnProperty.call(JEV_FEATURES, name);
}

/** Every switch name an admin may set: each feature, and "*" for all of them. */
export const ALL_JEV_FEATURES = "*";
