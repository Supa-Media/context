/**
 * What settings a context has, in the order somebody looks for them.
 *
 * The old pane was one scroll that opened on an access key and ended with a
 * search toggle nobody could reach without passing six integration cards. The
 * order here is how often a thing is actually touched, and the grouping is the
 * question a person is asking rather than the subsystem that answers it:
 *
 *  - **Integrations** — everything that fills a workspace without being typed
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
 * and the sentence saying so is worth a section of its own, so "Integrations"
 * is listed for one and every panel under it refuses in its own words.
 */

import type { IconName } from "../../design/components/Icon";

export type SettingsGroup =
  | "Your account"
  | "Integrations"
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
  /**
   * The row's mark.
   *
   * Nineteen rows carrying one word each is a list that has to be read rather
   * than scanned — so the glyph is part of the catalogue, beside the label,
   * and not a lookup table somewhere else that a new section can be added
   * without. Four of them are marks the set already had and that already mean
   * the right thing; the rest were drawn for this list. See `Icon.tsx`.
   */
  icon: IconName;
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
    icon: "grid",
    personalOnly: false,
  },
  {
    key: "profile",
    keywords: "name handle username email address capture mail me identity",
    label: "Profile",
    scope: "account",
    group: "Your account",
    icon: "person",
    personalOnly: false,
  },
  {
    key: "invitations",
    // "brain" is kept in the haystack, like the one on "Sign out & delete"
    // below: the word is retired from the copy, not from what people type.
    keywords: "invite invitation join accept pending asked workspace brain share",
    label: "Invitations",
    scope: "account",
    group: "Your account",
    icon: "mailOpen",
    personalOnly: false,
  },
  {
    key: "devices",
    /*
      "This Mac, and what it's allowed to capture" was drawn inside
      *workspace* settings, under `sources`, where a machine does not belong
      — a device is the person's, not the context's, and every other member
      of that workspace could see it too. Account-scoped, alongside the other
      things that follow the person rather than whichever context is open.
    */
    keywords: "mac computer laptop machine device devices revoke capture desktop",
    label: "Your devices",
    scope: "account",
    group: "Your account",
    icon: "laptop",
    personalOnly: false,
  },
  {
    key: "appearance",
    keywords: "dark mode light theme night appearance display colour color scheme",
    label: "Appearance",
    scope: "account",
    group: "Your account",
    icon: "sun",
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

      "brain" is in the haystack and "workspace" deliberately is not — and
      that survives the word's retirement rather than contradicting it. A
      *personal* workspace is deleted from this screen: it is one per person
      and it goes with the account, the sentence `deletionBlockedReason` gives
      for refusing it anywhere else. Somebody who types "delete my brain" has
      to land here, and they will go on typing it for years after the copy
      stopped saying it — a search haystack matches what people say, not what
      the product calls things. A *shared* workspace is deleted on its own, in
      Advanced, and a haystack that answered for both would send somebody who
      wanted one workspace gone to the screen that closes their account.
    */
    keywords: "sign out log out logout delete close account remove erase permanently brain",
    label: "Sign out & delete",
    scope: "account",
    group: "Your account",
    icon: "signOut",
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
    icon: "info",
    personalOnly: false,
  },
  {
    key: "premium",
    /*
      Nobody types "premium" looking for this. They type the thing they are
      trying to do — stop paying, change a card, find an invoice, work out why
      storage is capped — and none of those words are on the row. "storage
      limit" is here because the 50 GB ceiling is a Premium fact and the
      Storage section cannot answer it.
    */
    keywords:
      "billing bill upgrade paid pay payment plan price cost subscription subscribe cancel card invoice receipt stripe managed storage limit quota gb ceiling free trial money",
    scope: "context",
    label: "Premium",
    /*
      Ungrouped, directly after Overview, and above the three questions. It is
      about this context as a whole rather than about what comes in, who can
      see it, or where it is kept — and what it changes cuts across all three:
      the bucket in "Your notes" can be one we run, and the index under it can
      be the fast one.
    */
    group: null,
    icon: "card",
    personalOnly: false,
  },
  /*
    Four sections where there was one, and the one is worth remembering.

    "Mail, calendar & chats" held everything that fills a workspace without being
    typed into it, and what those things had in common was **our plumbing**: a
    Google *account* carries Gmail, Calendar and Chat together, so a card built
    around an account had to carry all three, and a section built around that
    card had to hold everything else nearby. Nobody opens settings asking "what
    does my Google account do". They ask "why isn't my mail here" — and that
    question had two answers in two places, because a mailbox reaches a workspace
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
      "email gmail mailbox inbox forward forwarding address capture ingestion sender allowed attachment spam mail google integration integrations sync",
    scope: "context",
    label: "Email",
    group: "Integrations",
    icon: "mail",
    personalOnly: false,
  },
  {
    key: "calendar",
    keywords: "calendar calendars ical events event schedule agenda appointments google integration integrations sync",
    scope: "context",
    label: "Calendar",
    group: "Integrations",
    icon: "calendar",
    personalOnly: false,
  },
  {
    key: "chats",
    keywords:
      "chat chats imessage messages texts sms google spaces dm direct conversation threads mac icloud integration integrations sync",
    scope: "context",
    label: "Chats",
    group: "Integrations",
    icon: "chat",
    personalOnly: false,
  },
  {
    key: "meetings",
    keywords:
      "meeting meetings recording record transcript zoom call huddle audio microphone notes mac desktop integration integrations sync",
    scope: "context",
    label: "Meetings",
    group: "Integrations",
    icon: "mic",
    personalOnly: false,
  },
  {
    key: "people",
    keywords: "members invite team who access role owner editor share colleague add remove",
    scope: "context",
    label: "People",
    group: "Who can see it",
    icon: "people",
    personalOnly: false,
  },
  {
    key: "groups",
    /*
      What people type when they have already done the thing a group is for:
      handed the same two people the same folder twice. "team" and "everyone"
      are in here because somebody looking for a way to share with *some* of
      the workspace searches the words for all of it first.
    */
    keywords: "group groups team everyone some people set named leads owners folder share who",
    scope: "context",
    label: "Groups",
    group: "Who can see it",
    icon: "group",
    personalOnly: false,
  },
  {
    key: "shares",
    /*
      "revoke" also lives on `apps`'s keywords, for revoking a connected AI app
      — both are real destinations for the word, and `matchSettingsSections`
      requiring every word to match rather than picking one winner is exactly
      what lets it return both.
    */
    keywords: "link links shared share revoke who has it sent unlisted anyone token url",
    scope: "context",
    label: "Shared links",
    group: "Who can see it",
    icon: "share",
    personalOnly: false,
  },
  {
    key: "privacy",
    /*
      What people type when they are worried, which is rarely the word on the
      row. "public" and "secret" are in this haystack and in no copy anywhere
      in the section, deliberately: somebody asking "is any of this public?"
      is asking a real question, and the answer — that no setting here puts a
      note in front of anybody the owner has not named — is exactly what this
      section exists to give them. A word nobody can search for is an answer
      nobody finds.
    */
    keywords: "private public who can see visible hide hidden secret share permissions access folder default privacy manifest",
    scope: "context",
    label: "Privacy",
    group: "Who can see it",
    icon: "lock",
    personalOnly: false,
  },
  {
    key: "storage",
    keywords: "bucket r2 s3 dropbox key credentials connect disconnect where files kept backup",
    scope: "context",
    label: "Storage",
    group: "Your notes",
    icon: "drive",
    personalOnly: false,
  },
  {
    key: "search",
    keywords: "find index fast lookup rebuild",
    scope: "context",
    label: "Search",
    group: "Your notes",
    icon: "search",
    personalOnly: false,
  },
  {
    /*
      Between Search and Advanced, and inside "Your notes" rather than a group
      of its own.

      A plugin here is not an integration in the sense the other groups mean —
      it is code that reads and writes the Markdown in this context's bucket,
      which is exactly what this group is about. It sits after Search because
      the two answer questions in the same order a person asks them: what is in
      my notes, and then what else is touching them.
    */
    key: "plugins",
    keywords: "obsidian plugin plugins vault dataview templater excalidraw community addon extension compatible",
    scope: "context",
    label: "Plugins",
    group: "Your notes",
    icon: "plugin",
    personalOnly: false,
  },
  {
    key: "advanced",
    /*
      The deletion words are half this haystack, and they are the reason it was
      rewritten. "Delete this workspace" has lived at the bottom of this
      section since it shipped, and none of the words somebody types on the way
      to it — delete, remove, the noun *workspace* itself — were in any
      section's vocabulary. So "delete workspace" matched nothing at all, and
      the bare "delete" matched exactly one row: **Sign out & delete**. Somebody
      who wanted one workspace off their list was handed the control that
      closes their whole account, which is the worst wrong answer this box can
      give. The privacy row above states the rule this broke — a word nobody
      can search for is an answer nobody finds — and a destructive control is
      where it costs the most.
    */
    keywords:
      "audit history log trail export key keys encryption rotate activity delete remove workspace destroy retire unwanted clutter",
    scope: "context",
    label: "Advanced",
    group: "Your notes",
    icon: "sliders",
    personalOnly: false,
  },
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
 * personal workspace has an address mail can be sent to — but Email, Calendar, Chats and
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
  /*
    "this" for the same reason "my" is here, found the same way: "delete this
    workspace" is what the row on the Overview page calls itself, and every
    word having to match meant reading our own label back to us returned
    nothing. A demonstrative cannot name a setting, so it can never be the word
    that distinguishes one row from another.
  */
  "this",
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
