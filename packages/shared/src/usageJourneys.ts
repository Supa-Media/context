/** Fixed metrics shared by the admin query and presentation. Never user-authored labels. */
export const USAGE_FUNNELS = [
  { id: "context_waitlist", product: "context", title: "Context waitlist", windowSeconds: 86400, steps: ["landing", "signup_started", "signup_submitted", "waitlist_joined"] },
  { id: "tex_waitlist", product: "tex", title: "Tex waitlist", windowSeconds: 86400, steps: ["landing", "signup_started", "signup_submitted", "waitlist_joined"] },
  { id: "context_signin", product: "context", title: "Context sign-in", windowSeconds: 1800, steps: ["code_sent", "code_submitted", "signed_in"] },
  { id: "tex_signin", product: "tex", title: "Tex sign-in", windowSeconds: 1800, steps: ["code_sent", "code_submitted", "signed_in"] },
  { id: "context_setup", product: "context", title: "New workspace setup", windowSeconds: 86400, steps: ["setup_started", "workspace_created", "setup_completed", "note_opened"] },
  { id: "tex_handoff", product: "tex", title: "Tex Messages handoff", windowSeconds: 86400, steps: ["signed_in", "text_page", "messages_opened"] },
] as const;

export const USAGE_STEP_LABELS = {
  landing: "Visited homepage", signup_started: "Started signup", signup_submitted: "Submitted signup",
  waitlist_joined: "Joined waitlist", code_sent: "Code requested", code_submitted: "Code submitted",
  signed_in: "Signed in", setup_started: "Started setup", workspace_created: "Workspace created",
  setup_completed: "Finished setup", note_opened: "Opened a note", text_page: "Reached Text Tex",
  messages_opened: "Opened Messages",
} as const;

export const USAGE_ACTIONS = {
  landing_cta_clicked: "Landing navigation",
  tex_messages_opened: "Open Messages",
  tex_contact_downloaded: "Save Tex's contact",
  tex_console_opened: "Open Tex console",
} as const;

export const USAGE_OUTCOMES = {
  signup_result: ["sent", "joined", "already", "unavailable", "invalid_phone", "too_many", "paused", "failed", "limited"],
  signin_code_result: ["success", "failed"],
  note_save_result: ["success", "failed", "timeout", "queued"],
} as const;

export type UsageFunnelId = typeof USAGE_FUNNELS[number]["id"];
export type UsageStepId = keyof typeof USAGE_STEP_LABELS;
export type UsageAction = keyof typeof USAGE_ACTIONS;
export type UsageOutcomeEvent = keyof typeof USAGE_OUTCOMES;

export function isUsageAction(value: unknown): value is UsageAction {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(USAGE_ACTIONS, value);
}
export function isUsageOutcome(event: unknown, result: unknown): event is UsageOutcomeEvent {
  return typeof event === "string" && typeof result === "string" && Object.prototype.hasOwnProperty.call(USAGE_OUTCOMES, event)
    && (USAGE_OUTCOMES[event as UsageOutcomeEvent] as readonly string[]).includes(result);
}
