/**
 * What settings a context has, in the order somebody looks for them.
 *
 * The old pane was one scroll that opened on an access key and ended with a
 * search toggle nobody could reach without passing six integration cards. The
 * order here is how often a thing is actually touched, and the grouping is the
 * question a person is asking rather than the subsystem that answers it:
 *
 *  - **What comes in** — everything that fills a brain without being typed
 *    into it: the mailboxes and calendars we read, this Mac, and the address
 *    mail can be forwarded to. It is one section because it is one question,
 *    and the nesting people used to have to learn — a Google *account*, which
 *    has an Email *sub-card* — is our plumbing rather than their question.

 *  - **Who can see it** — the people in this context. Previously three clicks
 *    away on an app-level pane that was not about this context at all.
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

export type SettingsGroup = "What comes in" | "Who can see it" | "Your notes";

export interface SettingsSectionSpec {
  key: SettingsSectionKey;
  label: string;
  group: SettingsGroup | null;
  /** Absent on a shared workspace, which has no ingestion alias of its own. */
  personalOnly?: boolean;
}

export const SETTINGS_SECTIONS = [
  {
    key: "overview",
    label: "Overview",
    /*
      Ungrouped and first: it answers "which context am I in, what am I in it,
      and is it working" before any of the three questions the groups ask.
    */
    group: null,
    personalOnly: false,
  },
  {
    key: "people",
    label: "People",
    group: "Who can see it",
    personalOnly: false,
  },
  {
    key: "sources",
    label: "Mail, calendar & chats",
    group: "What comes in",
    /*
      Shown on a shared workspace too, and deliberately. The *capture address*
      is personal-only (`CLAUDE.md`: only a personal context has an ingestion
      alias) and the pane gates that card itself — but the card explaining
      **why** a workspace cannot connect Gmail lives in this same block, and
      hiding the section takes the explanation with it. "Absent, not disabled"
      is right for a control that would be refused; it is wrong for the
      sentence that says why.
    */
    personalOnly: false,
  },
  { key: "storage", label: "Storage", group: "Your notes", personalOnly: false },
  { key: "search", label: "Search", group: "Your notes", personalOnly: false },
] as const;

export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number]["key"];

/** The section a URL with no `?settings=` value, or an unknown one, opens. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionKey = "overview";

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
