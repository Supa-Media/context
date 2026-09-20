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

/**
 * The one heading left.
 *
 * There were four — "Your account", "Integrations", "Who can see it", "Your
 * notes" — carrying the structure of a twenty-row list at 10.5pt in the
 * faintest grey on the screen. Six context rows do not need to be sorted into
 * buckets, and a heading over a single row repeats its name. What remains is
 * the account/context split, which is a real difference in what a row acts on
 * rather than a category somebody has to learn.
 */
export type SettingsGroup = "Your account";

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
  /**
   * Deprecated in the console: absent unless the caller says otherwise.
   *
   * Different from `personalOnly`, which is a fact about the context. This is
   * a decision about the product, and it is spelled as a flag on the row
   * rather than as a `filter` in one caller so that the catalogue — the file
   * anybody reads to find out what settings exist — says which rows are on
   * their way out. `plugins/experiment.ts` holds the argument.
   */
  experimental?: boolean;
  /**
   * Absent unless something is actually waiting.
   *
   * The second shape of "absent, not disabled", and the one the first could
   * not express: `personalOnly` asks what a *context* is, and this asks what
   * is true for the person right now. Invitations is the row it exists for —
   * most people have none most of the time, and a permanent row reading
   * "None" is a badge somebody learns to skip past on the way to the rows
   * that do change.
   */
  pendingOnly?: boolean;
}

export const SETTINGS_SECTIONS = [
  {
    key: "profile",
    /*
      The machine words are here because the machines are: "Your devices" was
      a row of its own and is now a card at the foot of this section, so
      somebody typing "mac" or "laptop" — on the way to revoking one they have
      lost — has to land on the screen that now holds it. A haystack that
      keeps a word for a row that no longer exists is worse than no word at
      all: it returns a section that cannot answer.
    */
    keywords:
      "name handle username email address capture mail me identity mac computer laptop machine device devices desktop revoke dark mode light theme night appearance display colour color scheme sign out log out logout delete close account remove erase permanently brain",
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
    /*
      Only while somebody is actually waiting for an answer. The row's own
      preview already refused to say "None" on every load — `previews.ts`:
      "the resting state of this row … is a badge people learn to ignore" —
      and this is that argument carried one step further: if the row has
      nothing to say in its resting state, the resting state should not have
      a row.
    */
    pendingOnly: true,
  },
  {
    key: "workspace",
    /*
      Overview's words and Advanced's, in one haystack.

      The deletion words are half of it and they are the reason the Advanced
      row was rewritten before it was merged: "delete this workspace" has been
      at the bottom of that screen since it shipped, and none of the words
      somebody types on the way to it were in any section's vocabulary. They
      stay here, and `workspace` stays deliberately out of Profile's haystack,
      so that deleting one shared workspace and closing an account remain two
      searches with two answers.
    */
    keywords:
      "about which role kind name health status workspace context audit history log trail export key keys encryption rotate activity delete remove destroy retire unwanted clutter",
    scope: "context",
    label: "Workspace",
    /*
      First among the context rows: it answers which context this is before
      any of the rows below it are worth reading.
    */
    group: null,
    icon: "info",
    personalOnly: false,
  },
  {
    key: "storage",
    /*
      The index's words are here because the index is: Search was the row
      below this one, asking the same question one level down — where are my
      notes kept, and where is the thing that finds them. An index is a
      disposable derivative of the files (`CLAUDE.md` #3), so it is a block on
      this screen rather than a row beside it, and "rebuild index" has to land
      here or it lands nowhere.
    */
    keywords:
      "bucket r2 s3 dropbox key credentials connect disconnect where files kept backup search find index fast lookup rebuild",
    scope: "context",
    label: "Storage",
    group: null,
    icon: "drive",
    personalOnly: false,
  },
  {
    key: "integrations",
    /*
      Five haystacks in one. "AI apps", Email, Calendar and Chats were four
      rows and a group heading, and the words people type for them are the
      words for one question: what is plugged into this context.

      The provider names matter more than our nouns here — nobody types
      "integrations" looking for Gmail — so every brand somebody might arrive
      with is in the list, and so are the two mechanisms that have no brand at
      all: the forwarding address, and this Mac.
    */
    keywords:
      /*
        The brand names matter more than our nouns — nobody types
        "integrations" looking for Gmail — and the words for controls this page
        no longer has are deliberately still here: somebody who remembers
        choosing a folder or a sync schedule types "folder" or "every 15
        minutes", and landing them on the page that used to ask, which now
        states the answer, is the only way they find out it is settled.
      */
      "integrations integration connect connected sync app apps client claude cursor chatgpt copilot mcp assistant endpoint address revoke disconnect email gmail mailbox inbox forward forwarding capture ingestion sender allowed attachment spam mail google calendar calendars ical events event schedule agenda appointments chat chats imessage messages texts sms spaces dm direct conversation threads mac icloud folder destination lands interval minutes often frequency",
    scope: "context",
    label: "Integrations",
    /*
      Ungrouped with the other whole-context rows. The "Integrations" *group*
      is gone: a heading and a single row beneath it reading "Integrations"
      is the same word twice.
    */
    group: null,
    icon: "grid",
    personalOnly: false,
  },
  {
    key: "model",
    /*
      Nobody types "model" looking for this either. They type the brand they
      have an account with, or the thing they are trying to do — "ai", "agent",
      "ask", "chat" — and the API-key words for the person who arrived here
      from the connect screen with a key already on their clipboard.
    */
    keywords:
      "model models ai agent assistant ask chat claude anthropic openai gpt chatgpt api key apikey token credential provider byok bring your own key llm ollama local",
    scope: "context",
    label: "Model",
    /*
      Its own row rather than a card under Integrations, and the difference is
      what the row acts on: everything in Integrations is something reading
      *into* this context, and this is the one thing that spends money on the
      person's own account. A credential that bills somebody is not an
      integration card.
    */
    group: null,
    icon: "sparkle",
    personalOnly: false,
  },
  {
    key: "meetings",
    keywords:
      "meeting meetings recording record transcript zoom call huddle audio microphone notes mac desktop integration integrations sync",
    scope: "context",
    label: "Meetings",
    /*
      Its own row, beside Integrations rather than inside it. It is the one
      capture surface people open on purpose rather than configure once, and
      the owner asked for it by name (2026-09-18, with Sayo).
    */
    group: null,
    icon: "mic",
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
    key: "sharing",
    /*
      Four haystacks in one, and the union is the point rather than a tidy-up.

      People, Groups, Shared links and Privacy were four rows under a heading
      that asked one question — "who can see it" — and a person with that
      question had to guess which of the four answered it. The words they type
      are the same words whichever half of the answer they are after: "who can
      see", "revoke", "share", "permissions", "public".

      "public" and "secret" are in here and in no copy anywhere on the screen,
      deliberately: somebody asking "is any of this public?" is asking a real
      question, and the answer — that no setting here puts a note in front of
      anybody the owner has not named — is exactly what this section exists to
      give them. A word nobody can search for is an answer nobody finds.
    */
    keywords:
      /*
        "who can see it" is spelled out because it used to be the *group
        heading* above these four rows, and `matchSettingsSections` searches
        label, group and keywords together — so deleting the heading silently
        took the most natural phrasing of the question with it. It is the one
        string here that is a whole sentence, and that is why.
      */
      "who can see it members people invite team access role owner editor share colleague add remove group groups everyone some set named leads folder link links shared revoke has sent unlisted anyone token url private public visible hide hidden secret permissions default privacy manifest",
    scope: "context",
    label: "Sharing & Access",
    /*
      Ungrouped, with Overview and Premium. A heading reading "Who can see it"
      over a single row called "Sharing & Access" is the same sentence twice,
      and the group existed to hold the four rows this replaces.
    */
    group: null,
    icon: "people",
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

      `experimental` since 2026-09-18, which is why that paragraph is still
      here rather than deleted with the row: the section is off the list for
      anybody not already using plugins, and the machinery under it is
      untouched. `plugins/experiment.ts` says who still sees it and why.
    */
    key: "plugins",
    keywords: "obsidian plugin plugins vault dataview templater excalidraw community addon extension compatible",
    scope: "context",
    label: "Plugins",
    group: null,
    icon: "plugin",
    personalOnly: false,
    experimental: true,
  },
] as const;

export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number]["key"];

/**
 * Is this row deprecated in the console?
 *
 * A function rather than a bare `section.experimental`, because the catalogue
 * is `as const` and only the row that carries the flag has the property —
 * narrowing it at each reader is how the one place that asks and the one place
 * that tests it drift apart. Spelling `experimental: false` on every other row,
 * the way `personalOnly` is spelled, was the alternative: it would read
 * uniformly and it would put a line about a deprecation on every setting this
 * product has, which is the wrong thing for the file anybody opens to find out
 * what settings exist.
 */
export function isExperimentalSection(
  section: (typeof SETTINGS_SECTIONS)[number] | SettingsSectionSpec,
): boolean {
  return "experimental" in section && section.experimental === true;
}

/** The section a URL with no `?settings=` value, or an unknown one, opens. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionKey = "workspace";

/**
 * Where settings opens when there is no context on screen — Map, Connections,
 * Search. `overview` there would head the panel with a context the route did
 * not name, and AI apps is the account section somebody on those routes is
 * most likely after: all three are already about reach rather than about one
 * bucket.
 */
export const DEFAULT_ACCOUNT_SETTINGS_SECTION: SettingsSectionKey = "profile";

/**
 * The sections this context actually has, for this person, right now.
 *
 * `kind` decides nothing today and is kept because it will. Only a personal
 * workspace has an address mail can be sent to — but Email, Calendar, Chats and
 * Meetings are all *listed* for a workspace, because each carries the sentence
 * saying why it cannot do that here, and a section removed takes its
 * explanation with it. `personalOnly` is the switch for a section that would
 * be nothing but a refused control; nothing sets it yet.
 *
 * `shown` is the other axis, and it belongs to the caller rather than to this
 * file on purpose: whether Plugins is on the list depends on what that context
 * has installed and on how the app was built, and whether Invitations is on it
 * depends on whether anybody has invited this person — none of which a pure
 * catalogue can see. A key left out of `shown` stays hidden, so both an
 * `experimental` row and a `pendingOnly` one are absent until somebody wires
 * them on: the fail-closed direction, and the one a half-finished deprecation
 * should land on.
 *
 * For Invitations the caller hands over `(data.invitations?.length ?? 0) > 0`,
 * and the `??` is load-bearing rather than defensive: `undefined` is the list
 * still in flight and is **not** zero (`ConsoleData.invitations`, and
 * `previews.ts` on the same field). Both hide the row, for different reasons —
 * nothing is waiting, or nothing is known yet — and only one of them would be
 * wrong to state out loud, so neither is stated: the row simply arrives when
 * there is something in it.
 */
export function settingsSectionsFor(
  kind: "personal" | "shared" | null | undefined,
  shown: Partial<Record<SettingsSectionKey, boolean>> = {},
): readonly SettingsSectionSpec[] {
  return SETTINGS_SECTIONS.filter((entry) => {
    /*
      Widened deliberately: the catalogue is `as const`, so each entry's type
      knows only the keys that entry happens to spell out and `pendingOnly` is
      absent from every row but one. Reading it through the interface is what
      makes an optional field optional here rather than a compile error.
    */
    const section: SettingsSectionSpec = entry;
    // Deprecated in the console, and absent before anything else is asked: a
    // section nobody may see is not made visible by the kind of context it is
    // in. See `plugins/experiment.ts`.
    if (isExperimentalSection(section) && shown[section.key] !== true) return false;
    // And the row that has nothing in it until somebody is waiting for an
    // answer. Same shape, different question: one asks what the product
    // offers, this asks what is true for this person right now.
    if (section.pendingOnly === true && shown[section.key] !== true) return false;
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
