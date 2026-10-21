/**
 * The buttons the staff console's Usage tab counts, by a name fixed here.
 *
 * A press is reported as `button_tapped` with `{ button: <id> }` and nothing
 * else: never the button's words, which can be a note's title, and never the
 * thing it acted on. PostHog's autocapture stays off for that reason
 * (`docs/observability.md`), so a button is counted only once it is named in
 * this list. The app sends only these ids (its `trackButton` takes this type),
 * and the control plane drops any other name a client might send before the
 * tab draws it, so the two read one list and cannot drift apart.
 *
 * The label is what the Usage tab prints beside the id.
 */
export const USAGE_BUTTONS = {
  search_open: "Open search",
  new_note: "New note",
  new_folder: "New folder",
  new_drawing: "New drawing",
  new_meeting: "New meeting",
  share_note: "Share",
  copy_link: "Copy link",
  rename: "Rename",
  move: "Move",
  duplicate: "Duplicate",
  download: "Download",
  pin: "Pin to Home",
  archive: "Archive",
  restore: "Restore",
  delete: "Delete",
  change_visibility: "Change who can see",
  download_everything: "Download everything",
  upgrade: "Upgrade",
  sign_out: "Sign out",
} as const;

export type UsageButton = keyof typeof USAGE_BUTTONS;

export function isUsageButton(value: unknown): value is UsageButton {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(USAGE_BUTTONS, value);
}

/** The event a press is reported as. */
export const BUTTON_EVENT = "button_tapped";

/**
 * The event the app sends every thirty seconds while somebody is using it:
 * the tab is in front and they touched, typed or scrolled in the last minute.
 * Time in app is counted from these, so a tab left open overnight is not.
 */
export const ACTIVE_EVENT = "app_active";
export const ACTIVE_INTERVAL_SECONDS = 30;
