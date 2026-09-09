/**
 * What settings a context has, in the order somebody looks for them.
 *
 * The old pane was one scroll that opened on an access key and ended with a
 * search toggle nobody could reach without passing six integration cards. The
 * order here is how often a thing is actually touched, and the grouping is the
 * question a person is asking rather than the subsystem that answers it:
 *
 *  - **What comes in** — everything that fills a brain without being typed
 *    into it: the mailboxes and calendars we read, the chats, this Mac, and
 *    the address mail can be forwarded to. It was one section, on the argument
 *    that it is one question. It is four now, because it is four: a person
 *    asks "why isn't my mail here", not "what does my Google account do", and
 *    the nesting they had to learn — a Google *account*, which has an Email
 *    *sub-card*, beside a separate Email capture block — was our plumbing
 *    rather than their question. Each of the four answers one question on one
 *    page, however many mechanisms that takes.

 *  - **Who can see it** — the people in this context. Previously three clicks
 *    away on an app-level pane that was not about this context at all.
 *  - **Your notes** — where they live and how they are found. Storage is here,
 *    near the bottom, because it is touched at setup and at a key rotation and
 *    then never again; a broken bucket still announces itself on the storage
 *    chip in the top bar, so demoting the section hides nothing.
 *
 * `group: null` sits above the first heading, ungrouped. Sections are absent
 * rather than disabled where they do not apply — a greyed row inviting
 * somebody to press it is a worse answer than no row. The line that rule stops
 * at is the *explanation*: a shared workspace has no capture address at all,
 * and the sentence saying so is worth a section of its own, so "What comes in"
 * is listed for one and every panel under it refuses in its own words.
 */

export type SettingsGroup =
  | "Your account"
  | "What comes in"
  | "Who can see it"
  | "Your notes";

/**
 * Which of the two things a section belongs to.
 *
 * A storage binding hangs off a `workspaceId`, never a `userId`, so storage,
 * people and capture are per-context — while the AI apps holding a grant, the
 * person's own name and the account itself span every context they can reach.
 * Settings had only the first kind, so the second had no home at all: deleting
 * an account lived on a per-*context* pane, and signing out was a power glyph
 * in the rail.
 *
 * One flat key space rather than a prefix in the URL. Keys are unique across
 * both scopes, so `?settings=apps` needs no `account/` in front of it and
 * `settingsFromQuery` stays the same shape it was.
 */
export type SettingsScope = "account" | "context";

export interface SettingsSectionSpec {
  key: SettingsSectionKey;
  label: string;
  scope: SettingsScope;
  group: SettingsGroup | null;
  /**
   * The words somebody would type looking for this, which are not always the
   * words on the row. A person hunting for Gmail does not type "sources", and
   * one who wants to cancel does not type "account" — the box is what stops
   * our naming being the only way in.
   */
  keywords: string;
  /** Absent on a shared workspace, which has no ingestion alias of its own. */
  personalOnly?: boolean;
}

export const SETTINGS_SECTIONS = [
  {
    key: "apps",
    keywords: "claude cursor chatgpt copilot app client connect endpoint address revoke disconnect mcp assistant",
    label: "AI apps",
    scope: "account",
    group: "Your account",
    personalOnly: false,
  },
  {
    key: "profile",
    keywords: "name handle username email address capture mail me identity",
    label: "Profile",
    scope: "account",
    group: "Your account",
    personalOnly: false,
  },
  {
    key: "invitations",
    keywords: "invite invitation join accept pending asked workspace brain share",
    label: "Invitations",
    scope: "account",
    group: "Your account",
    personalOnly: false,
  },
  {
    key: "account",
    /*
      "sign out" is back in this haystack, and it was right to take it out
      before. Every word has to match and `sign` appears in exactly one
      section, so while this screen's only control deleted an account, typing
      "sign out" landed somebody who wanted to end a session on the one screen
      that could end their account instead. The screen now carries the sign-out
      button itself, so the words name what is actually there.

      Still no "leave" or "quit": leaving a *workspace* is a different,
      non-destructive action, and it is People's, not this one's.
    */
    keywords: "sign out log out logout delete close account remove erase permanently",
    label: "Sign out & delete",
    scope: "account",
    group: "Your account",
    personalOnly: false,
  },
  {
    key: "overview",
    keywords: "about which role kind name health status",
    scope: "context",
    label: "Overview",
    /*
      Ungrouped and first: it answers "which context am I in, what am I in it,
      and is it working" before any of the three questions the groups ask.
    */
    group: null,
    personalOnly: false,
  },
  /*
    Four sections where there was one, and the one is worth remembering.

    "Mail, calendar & chats" held everything that fills a brain without being
    typed into it, and what those things had in common was **our plumbing**: a
    Google *account* carries Gmail, Calendar and Chat together, so a card built
    around an account had to carry all three, and a section built around that
    card had to hold everything else nearby. Nobody opens settings asking "what
    does my Google account do". They ask "why isn't my mail here" — and that
    question had two answers in two places, because a mailbox reaches a brain
    either through a Google account or through the forwarding address, and
    those are two different mechanisms. The nesting was ours; the question is
    theirs.

    So: one section per question a person actually has, each answered on one
    page whatever number of mechanisms it takes. Email is the one that was
    genuinely split in two before. Chats is two unrelated mechanisms — Google
    Chat and this Mac's iMessages — under the one word somebody recognises.

    All four are shown on a shared workspace, and deliberately. The controls
    are personal-only (`CLAUDE.md`: only a personal context has an ingestion
    alias, and nobody's mailbox belongs to a shared bucket) and each panel
    gates its own — but the sentence explaining **why** a workspace cannot
    connect Gmail lives in these same blocks, and hiding them takes the
    explanation with it. "Absent, not disabled" is right for a control that
    would be refused; it is wrong for the sentence that says why.
  */
  {
    key: "email",
    keywords:
      "email gmail mailbox inbox forward forwarding address capture ingestion sender allowed attachment spam mail google",
    scope: "context",
    label: "Email",
    group: "What comes in",
    personalOnly: false,
  },
  {
    key: "calendar",
    keywords: "calendar calendars ical events event schedule agenda appointments google",
    scope: "context",
    label: "Calendar",
    group: "What comes in",
    personalOnly: false,
  },
  {
    key: "chats",
    keywords:
      "chat chats imessage messages texts sms google spaces dm direct conversation threads mac",
    scope: "context",
    label: "Chats",
    group: "What comes in",
    personalOnly: false,
  },
  {
    key: "meetings",
    keywords:
      "meeting meetings recording record transcript zoom call huddle audio microphone notes mac desktop",
    scope: "context",
    label: "Meetings",
    group: "What comes in",
    personalOnly: false,
  },
  {
    key: "people",
    keywords: "members invite team who access role owner editor share colleague add remove",
    scope: "context",
    label: "People",
    group: "Who can see it",
    personalOnly: false,
  },
  { key: "storage", keywords: "bucket r2 s3 dropbox key credentials connect disconnect where files kept backup", scope: "context", label: "Storage", group: "Your notes", personalOnly: false },
  { key: "search", keywords: "find index fast lookup rebuild", scope: "context", label: "Search", group: "Your notes", personalOnly: false },
] as const;

export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number]["key"];

/** The section a URL with no `?settings=` value, or an unknown one, opens. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionKey = "overview";

/**
 * Where settings opens when there is no context on screen — Map, Connections,
 * Search. `overview` there would head the panel with a context the route did
 * not name, and AI apps is the account section somebody on those routes is
 * most likely after: all three are already about reach rather than about one
 * bucket.
 */
export const DEFAULT_ACCOUNT_SETTINGS_SECTION: SettingsSectionKey = "apps";

/**
 * The sections this context actually has.
 *
 * `kind` decides nothing today and is kept because it will. Only a personal
 * brain has an address mail can be sent to — but Email, Calendar, Chats and
 * Meetings are all *listed* for a workspace, because each carries the sentence
 * saying why it cannot do that here, and a section removed takes its
 * explanation with it. `personalOnly` is the switch for a section that would
 * be nothing but a refused control; nothing sets it yet.
 */
export function settingsSectionsFor(
  kind: "personal" | "shared" | null | undefined,
): readonly SettingsSectionSpec[] {
  return SETTINGS_SECTIONS.filter((section) => {
    // Account sections belong to the person, not to whichever context they
    // happen to have open, so a context's kind never removes one.
    if (section.scope === "account") return true;
    return !section.personalOnly || kind === "personal";
  });
}

/**
 * The row's own words, for the panel that opens when it is pressed.
 *
 * The heading and the row were separate strings, and they drifted: the row
 * said "Mail, calendar & chats" — chosen because a person looking for Gmail
 * does not think "integrations" — and the panel it opened was headed
 * **Integrations**. Somebody who searched their way past our vocabulary was
 * handed it back one press later.
 */
export function settingsSectionLabel(key: SettingsSectionKey): string {
  return SETTINGS_SECTIONS.find((section) => section.key === key)?.label ?? "Settings";
}

/** Whether a section is about the person rather than about one context. */
export function isAccountSection(key: SettingsSectionKey): boolean {
  return SETTINGS_SECTIONS.some(
    (section) => section.key === key && section.scope === "account",
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

/**
 * Words carried past the matcher.
 *
 * Every word has to match something, which is what makes two words narrow
 * rather than widen — and it is also what made "delete my account" return
 * nothing at all, because `my` is in no section's vocabulary and never will
 * be. People type sentences at a search box. The list is deliberately tiny and
 * only holds words that cannot distinguish one setting from another: a word
 * that could name a thing here is not on it.
 */
const FILLER = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "the",
  "to",
]);

/**
 * The sections a typed query names.
 *
 * Every meaningful word must match something — label, group or keywords — so
 * "gmail chat" narrows rather than widening, and an empty query is not a
 * search at all and hands back everything.
 */
export function matchSettingsSections(
  sections: readonly SettingsSectionSpec[],
  query: string,
): readonly SettingsSectionSpec[] {
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "" && !FILLER.has(word));
  if (words.length === 0) return sections;
  return sections.filter((section) => {
    const hay = `${section.label} ${section.group ?? ""} ${section.keywords}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}
