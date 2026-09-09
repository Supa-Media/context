/**
 * What settings a context has, in the order somebody looks for them.
 *
 * The old pane was one scroll that opened on an access key and ended with a
 * search toggle nobody could reach without passing six integration cards. The
 * order here is how often a thing is actually touched, and the grouping is the
 * question a person is asking rather than the subsystem that answers it:
 *
 *  - **What comes in** — Email today, and whatever else fills a brain later.
 *    Named after the thing, not the connector. Somebody fixing their mail does
 *    not know that Gmail is an "integration", that an integration belongs to a
 *    Google account, and that the account has an Email sub-card.

 *  - **Your notes** — where they live and how they are found. Storage is here,
 *    near the bottom, because it is touched at setup and at a key rotation and
 *    then never again; a broken bucket still announces itself on the storage
 *    chip in the top bar, so demoting the section hides nothing.
 *
 * `group: null` sits above the first heading, ungrouped. Sections are absent
 * rather than disabled where they do not apply: a shared workspace has no
 * capture address at all, so "What comes in" does not appear for one — an
 * empty section with an explanation is a better answer than a greyed row, and
 * no answer at all is better still where the concept does not exist.
 */

export type SettingsGroup = "What comes in" | "Your notes";

export interface SettingsSectionSpec {
  key: SettingsSectionKey;
  label: string;
  group: SettingsGroup | null;
  /** Absent on a shared workspace, which has no ingestion alias of its own. */
  personalOnly?: boolean;
}

export const SETTINGS_SECTIONS = [
  { key: "email", label: "Email", group: "What comes in", personalOnly: true },
  { key: "storage", label: "Storage", group: "Your notes", personalOnly: false },
  { key: "search", label: "Search", group: "Your notes", personalOnly: false },
] as const;

export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number]["key"];

/** The section a URL with no `?settings=` value, or an unknown one, opens. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionKey = "storage";

/**
 * The sections this context actually has.
 *
 * `kind` decides one thing today and will decide more: only a personal brain
 * has an address mail can be sent to, so only a personal brain has an Email
 * section. Everything else is common to both.
 */
export function settingsSectionsFor(
  kind: "personal" | "shared" | null | undefined,
): readonly SettingsSectionSpec[] {
  return SETTINGS_SECTIONS.filter(
    (section) => !section.personalOnly || kind === "personal",
  );
}

/**
 * Is this a section name we have? Anything else is treated as no section at
 * all rather than as an error, the same fail-closed shape `safeNotePath` uses:
 * a URL somebody hand-edited should land somewhere sensible, not on a blank
 * panel or a crash.
 */
export function isSettingsSection(value: string): value is SettingsSectionKey {
  return SETTINGS_SECTIONS.some((section) => section.key === value);
}
