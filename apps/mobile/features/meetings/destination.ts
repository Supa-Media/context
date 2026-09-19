import { ownPersonalContext } from "../console/identity";
import { DEFAULT_TARGET_FOLDER } from "../console/ingestion/settings";
import { safeNotePath } from "../console/nav";

/**
 * Where a meeting is going to land, decided **before** the microphone opens.
 *
 * ## Why this is a question at all
 *
 * A meeting is a capture, and until now the answer was implicit: the gateway
 * derived `0-inbox/meetings/…` from the session and nothing on the
 * device ever said a word about it (`packages/meetings/src/paths.js`). That is
 * a fine default and a bad *only* answer, because the person recording is
 * usually looking at something — a project folder, a note — and the meeting
 * belongs beside it. The moment a second answer exists it has to be asked for,
 * and the asking is what this module is the model for.
 *
 * ## The default is the person's own workspace, whatever context they are in
 *
 * This is the whole point of the module and it is a privacy rule rather than a
 * convenience. Somebody reading a note in a shared workspace who presses record
 * is, on any "current context" default, dropping a transcript of a conversation
 * they have not read yet into a folder their colleagues are watching. So the
 * first offer is always `@their-handle / 0-inbox/meetings`, it is always the
 * fallback, and the current page is the *second* offer with the audience named
 * on it.
 *
 * "Their own" is `ownPersonalContext` — `kind === "personal"` **and**
 * `role === "owner"` — and the second half is load-bearing rather than
 * belt-and-braces. `createWorkspace` accepts `kind: "shared"` and makes its
 * caller `owner`, so "a context you own" alone can be a shared one, and an
 * offer built from that rule would read *Only you* over a bucket several people
 * watch. That is verbatim the failure this module exists to prevent, arriving
 * through its own front door.
 *
 * ## `contextSlug` is an address, not a label
 *
 * It routes. Every gateway call about a meeting is addressed to the
 * destination's context (`gateway.ts`), so the row's audience line and the
 * bucket the note lands in are answers to the same question. For a while they
 * were not: the slug was rendered, persisted and re-validated, and the write
 * went wherever the credential pointed — a row that said `@acme / finance`
 * over a note headed somewhere nobody had named.
 *
 * ## What it offers, the gateway has to be able to take
 *
 * **An offer with no `refusal` on it is a promise, and the only thing that can
 * keep it is `normalizeMeetingFolder` in `packages/meetings`.** Every folder
 * that function refuses is refused here too, with the sentence beside it, or
 * the sheet is a control that appears to work and does nothing — which is the
 * defect this whole seam exists to close, arriving one layer up.
 *
 * The case that mattered is the **root of a context**, because it is the state
 * a phone *arrives* in: nothing is selected, so the console passes `path: ""`.
 * `CONTEXT_ROOT_REFUSAL` argues it. The rest are `fileableFolder`, and they are
 * not covered by `safeNotePath` — that gate refuses a leading slash, a
 * backslash, a `.` or `..` *segment* and a control character, and lets through
 * `a..b`, `.git`, `overview.md` and a path longer than the gateway's bound.
 *
 * **This is a second statement of a rule this app does not own, and it is
 * allowed to be one only because a test holds the two together.**
 * `meetingsDestination.test.ts` imports the real `normalizeMeetingFolder` and
 * asserts, over every shape either side cares about, that a folder this module
 * offers without a refusal is a folder that function accepts. The phone cannot
 * *bundle* that package — Metro is configured with `@context/shared` as its
 * only shared package (`metro.config.js`) — but the suite can import it, so
 * the drift `paths.js` warns about ("two implementations of 'does this string
 * escape its bucket' is how one of them ends up weaker") is caught in CI rather
 * than left to a comment. Being *stricter* here is safe and is not asserted
 * against: it costs a row, where being laxer costs the destination.
 *
 * ## It is a pure module, and that is `console/capabilities.ts`'s reason
 *
 * Every guard in the console that was expressed inside a hook or a component
 * survived a full sabotage sweep untouched; every guard expressed as a pure
 * module was held. A rule about where somebody's meeting lands is exactly the
 * kind that must be reachable from a test without a renderer, so nothing here
 * imports React and the sheet holds no rule of its own.
 *
 * ## Nothing here touches storage
 *
 * Asking the question creates no folder. `0-inbox` that does not exist yet is
 * made by the write that puts the note in it — a folder created by a question
 * somebody cancelled is litter in a bucket the customer owns, and this product
 * does not leave any. There is nothing to undo because there was never anything
 * to do: a destination is two strings until a note is written.
 */

/**
 * `0-inbox/meetings` — the inbox, and the drawer in it that holds meetings.
 *
 * ## It used to be the inbox itself, and that was the defect
 *
 * `DEFAULT_TARGET_FOLDER` is where forwarded mail lands, and this was derived
 * from it on the reasoning that a meeting is the same kind of thing: captured,
 * unfiled, moved later by a person. True about the *inbox*, wrong about the
 * folder, because of a rule one layer down that this file already documents:
 * **a chosen folder replaces the whole default.** So offering `0-inbox` did not
 * mean "the default, unchanged" — it meant "not `0-inbox/meetings`", and a
 * meeting recorded on the default row landed loose in the inbox beside the
 * mail. Nobody chose that and the sheet never said it.
 *
 * The fix is to name the folder rather than derive a wrong one: `0-inbox` is
 * where unfiled things arrive, and what arrives there is sorted by *what it
 * is* — `0-inbox/meetings`, `0-inbox/sessions`, mail next. One decision, one
 * spelling, and it is `MEETINGS_FOLDER`'s spelling: the constant is restated
 * here rather than imported for the reason the whole module gives about
 * `normalizeMeetingFolder`, and `meetingsDestination.test.ts` — which does
 * import the real package — is what holds the two together.
 */
export const INBOX_FOLDER = `${DEFAULT_TARGET_FOLDER.replace(/\/+$/, "")}/meetings`;

/**
 * Who can read a meeting written where this one is going.
 *
 * One value now, where there were two: a meeting lands in the person's own
 * inbox and nowhere else (`automaticDestination`), so "visible to the team" is
 * a sentence about a destination this product no longer has. It went with the
 * sheet that offered one.
 */
export const ONLY_YOU = "Only you";

/**
 * Said under the folder field in settings, about a folder the gateway will not
 * file a meeting into.
 *
 * It was one of four refusals drawn on the destination sheet's rows. The sheet
 * is gone and so are the other three — a row nobody is offered cannot be
 * refused — and this one survives because the *setting* is still a place
 * somebody can type a folder the gateway would reject.
 *
 * It does not quote the folder, for the reason the ack does not: naming which
 * rule it broke would be quoting the customer's own folder name back at them
 * for no gain.
 */
export const UNFILEABLE_FOLDER =
  "Your context will not file a meeting into this folder. Choose another one, or use your inbox.";

export type MeetingDestination =
  | { kind: "personalInbox"; contextSlug: string; folder: string }
  | { kind: "currentPage"; contextSlug: string; folder: string; label: string };

/**
 * One context the viewer can reach, as this module needs it.
 *
 * Structurally typed rather than importing `ConsoleContext`, for the reason
 * `identity.ts` types its own `IdentityContext` that way: the caller is a
 * console screen today and a bottom-row key tomorrow, and neither should have
 * to build a console row to ask this question.
 */
export interface DestinationContext {
  slug: string;
  /** `personal` | `shared`. A value this build does not know is not personal. */
  kind: string;
  /** `owner` | `editor` | `member`. Anything else may not write. */
  role: string;
  /**
   * Where meetings land in this context, when its owner has chosen.
   *
   * Rides on the context rather than arriving as a separate argument, because
   * it belongs to exactly one of them: the first offer is always the person's
   * own workspace, so the folder that offer names is that workspace's own
   * setting.
   * `ownPersonalContext` already finds the row, and a parallel parameter would
   * be a second thing the caller has to keep pointed at the same context.
   *
   * Absent is `INBOX_FOLDER`, which is what every context had before the
   * setting existed. A value this module would not file into is treated as
   * absent rather than honoured — see `resolveDestinations`.
   */
  meetingsFolder?: string;
}

/**
 * Is this typing a folder a meeting could be filed into, and if not, why?
 *
 * The settings panel's half of `inboxFolderOf`. Same gate, so a folder the
 * panel accepts is one the sheet will then offer and the gateway will then
 * honour — and the console refuses before the round trip rather than after it,
 * in a sentence rather than a `null`.
 *
 * **The control plane still decides.** `setMeetingsFolder` runs the real
 * `normalizeMeetingFolder`; this exists so the field can say something while
 * somebody is typing, and a client with the check removed is still refused.
 *
 * Returns `null` when there is nothing to say — which includes an empty field,
 * because somebody who has selected the whole value to retype it should not be
 * told off mid-word. Saving an empty value is refused by `canSaveMeetingFolder`
 * instead.
 */
export function meetingFolderProblem(value: string): string | null {
  const filed = collapseFolder(value);
  if (filed === "") return null;
  if (filed.length > MAX_FOLDER_LENGTH) return "That folder path is too long.";
  if (!fileableFolder(filed)) return UNFILEABLE_FOLDER;
  return null;
}

/** Whether Save should do anything: a real folder, and not the one stored. */
export function canSaveMeetingFolder(value: string, stored: string): boolean {
  const filed = collapseFolder(value);
  if (filed === "" || filed.length > MAX_FOLDER_LENGTH || !fileableFolder(filed)) return false;
  return filed !== collapseFolder(stored);
}

/**
 * The gateway's collapse: trim, drop empty segments, rejoin.
 *
 * One implementation, used by the offer and by the panel, so a value the panel
 * calls unchanged is the value the offer would have carried.
 */
function collapseFolder(value: string): string {
  return value
    .trim()
    .split("/")
    .filter((segment) => segment !== "")
    .join("/");
}

/**
 * The folder the first offer names, which is a setting now rather than a
 * constant.
 *
 * **A stored value this module would not file into falls back to the default.**
 * An offer with no `refusal` on it is a promise, and the only thing that can
 * keep it is the gateway — so a folder that would be rejected at the write is
 * not one this sheet may offer, whether it arrived on a request or out of
 * somebody's settings. A row written by a newer control plane, or one that
 * predates a rule this bundle ships, lands on `INBOX_FOLDER` rather than on a
 * destination that cannot be honoured.
 *
 * `fileableFolder` rather than `normalizeMeetingFolder`, for the reason the
 * rest of this module restates that package instead of importing it: the phone
 * does not bundle it. The empty check is the one rule `fileableFolder` leaves
 * to its callers — `CONTEXT_ROOT_REFUSAL` argues it for a page, and it is the
 * same refusal here, because a meeting filed at the root lands beside
 * `index.md` and `privacy.md`.
 */
function inboxFolderOf(own: DestinationContext): string {
  if (own.meetingsFolder === undefined) return INBOX_FOLDER;
  /*
    Collapsed the way the gateway collapses it, so a setting stored with a
    trailing slash names the same folder as one without. The offer has to
    carry the spelling the write will use, or `sameDestination` stops matching
    a remembered choice against the row it came from.
  */
  const filed = collapseFolder(own.meetingsFolder);
  if (filed === "" || !fileableFolder(filed)) return INBOX_FOLDER;
  return filed;
}

/**
 * What a press of New meeting records into, with nobody asked anything.
 *
 * ## The sheet is gone, and this is what replaced it
 *
 * `resolveDestinations` is the model for a *question*: two rows, an audience
 * line on each, and a person choosing. The question was asked on every meeting
 * anybody has ever recorded, and the owner's reading of it is that it confused
 * people rather than protecting them — *"no need to ask people it will just
 * confuse them"*. So the destination is a rule now: **the person's own inbox**,
 * which is `0-inbox/meetings` unless they have named another folder for their
 * own context (`inboxFolderOf`). Filing afterwards is what an inbox is for, and
 * a meeting nobody has filed yet is exactly what lands in one.
 *
 * ## It is the *own* inbox, and that half is not a convenience
 *
 * This module's header argues it and `resolveDestinations` implements it for
 * the sheet: somebody reading a note in a shared workspace who presses record
 * is, on any "current context" default, dropping a transcript of a conversation
 * into a folder their colleagues watch, before they have read a word of it.
 * That was a privacy rule when there was a sheet in front of it with the
 * audience named on the row. With no sheet there is nothing in front of it at
 * all, so the rule matters *more* here, not less: the answer is the person's
 * own workspace, wherever they are standing, exactly as `meetingWorkspaceId`
 * answers for a meeting nobody addressed.
 *
 * A context somebody wants their meetings in is a setting on their own context
 * (`meetingsFolder`), which is a decision taken once in a quiet moment rather
 * than a question asked over a conversation that is already happening.
 *
 * ## Owning no workspace is the one thing it cannot answer
 *
 * `claimName`, rather than inventing a context: every fallback available here
 * is somebody else's bucket. The press then raises the claim offer instead of
 * opening a microphone — see `useMeetingFlow`.
 */
export type AutomaticDestination =
  | { kind: "destination"; destination: MeetingDestination; audience: string }
  | { kind: "claimName" };

export function automaticDestination(input: {
  contexts: readonly DestinationContext[];
}): AutomaticDestination {
  const own = ownPersonalContext(input.contexts);
  if (own === null) return { kind: "claimName" };
  return {
    kind: "destination",
    destination: {
      kind: "personalInbox",
      contextSlug: own.slug,
      folder: inboxFolderOf(own),
    },
    /*
      `ONLY_YOU` is the truth about a personal workspace's own inbox, with the
      same caveat `resolveDestinations` writes down beside its first offer: it
      is a statement about membership, not about `privacy.md`, and a grant this
      list cannot see is not visible from here.
    */
    audience: ONLY_YOU,
  };
}

/**
 * `MAX_FOLDER_LENGTH` in `packages/meetings/src/paths.js`, restated.
 *
 * The bound is the gateway's and the reason for it is the gateway's — the whole
 * key has to stay inside its 512-character path limit once the date folders and
 * the filename are on the end. Restated rather than imported because the phone
 * does not bundle that package; the test that holds the two together is named
 * at the head of this file.
 */
const MAX_FOLDER_LENGTH = 128;

/**
 * Whether `normalizeMeetingFolder` would file a meeting into this folder.
 *
 * Not a re-implementation of it — this is the same question asked as a
 * predicate, on a string that has already been through `safeNotePath`, so the
 * traversal and control-character arms are not repeated here. What is left is
 * SIX shapes that gate lets through and the gateway does not.
 *
 * **This list said "exactly the four shapes" while the gateway had six of
 * them**, and stayed four through two gateway rules being added beside it. The
 * count is a checklist against `normalizeMeetingFolder`, not a description —
 * the test named at the head of this file is what actually holds the two
 * together, and it only holds the shapes somebody put in its table.
 *
 *  - **`..` anywhere in a segment**, not only a segment that *is* `..`. The
 *    gateway's `normalizePath` refuses `..` anywhere in a key, and a folder
 *    named `a..b` cost a real meeting: the claim wrote `a..b/….md` into
 *    the session record and the note write then answered 400 `meeting_invalid`
 *    — the code no client retries — for the life of that meeting.
 *  - **A segment that percent-DECODES to `.` or `..`.** A different rule
 *    answering to a different layer: the storage adapter decodes before it
 *    compares, so `%2e%2e` is a `".."` segment there and at neither of the
 *    checks above. Equality rather than "anywhere", because the adapter
 *    compares whole segments and `a%2e%2eb` is a key it accepts — the
 *    asymmetry with the raw rule is deliberate on the gateway and copied here
 *    deliberately too.
 *  - **A dot-prefixed segment.** `isPlumbing` hides those from every tool at
 *    every tier, the owner's included, so the meeting would be invisible to the
 *    person paying for the storage. The console's own tree never lists one, so
 *    this arm is belt and braces about a listing rather than about a person.
 *  - **A segment that is a note, or the legacy manifest.** A key inside a file
 *    is a shape a filesystem-backed store cannot represent.
 *  - **The length bound.** A folder nested deeply enough is a legal path to the
 *    console and not one to the gateway.
 *  - **Whitespace at either end of what the gateway would JOIN.** Not a rule
 *    about folders but about the gateway's own function: `normalizeRoot` trims
 *    the whole string, so a folder whose normalized form the next pass would
 *    trim again is one it refuses. Only the two ends are unstable, which is why
 *    this is on the joined result and not on each segment — `2-areas/ team` is
 *    a folder somebody may legitimately have and both sides accept it.
 *    `safeNotePath` refuses a LEADING slash and says nothing about a trailing
 *    one, so `"ok/a /"` really does arrive here.
 */
function fileableFolder(folder: string): boolean {
  if (folder.length > MAX_FOLDER_LENGTH) return false;
  /*
    The gateway's shape, restated: trim the whole string, drop empty segments
    (repeated separators collapse), then judge the join. Restated rather than
    imported for the reason `MAX_FOLDER_LENGTH` is — the phone does not bundle
    that package — and the agreement test is what keeps the restatement true.
  */
  const segments = folder.trim().split("/").filter((segment) => segment !== "");
  const filed = segments.join("/");
  if (filed !== filed.trim()) return false;
  return segments.every((segment) => {
    if (segment.includes("..")) return false;
    const decoded = decodeSegment(segment);
    if (decoded === "." || decoded === "..") return false;
    if (segment.startsWith(".")) return false;
    if (segment.toLowerCase().endsWith(".md")) return false;
    return segment.toLowerCase() !== "scopes.yml";
  });
}

/**
 * `decodeSegment` in `packages/meetings/src/paths.js`, restated.
 *
 * A malformed escape is left alone rather than thrown on: `%zz` is a perfectly
 * legal folder name and the gateway treats it as one, so a `catch` that
 * returned `false` here would refuse a folder the gateway files into — the
 * mirror wrong in the other direction, which this module has already been
 * once.
 */
function decodeSegment(segment: string): string {
  if (!segment.includes("%")) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * `@testagent1 / 0-inbox`, and just `@field-notes` for a context's root.
 *
 * The root has no folder to print, and `"@field-notes / "` reads as a value
 * somebody failed to fill in rather than as the top of a context.
 */
export function describeDestination(destination: MeetingDestination): string {
  const at = destination.contextSlug.startsWith("@")
    ? destination.contextSlug
    : `@${destination.contextSlug}`;
  return destination.folder === "" ? at : `${at} / ${destination.folder}`;
}

/* -------------------------------- routing -------------------------------- */

/** A context as the writer needs it: what the sheet needs, plus the id. */
export interface RoutableContext extends DestinationContext {
  workspaceId: string;
}

/**
 * The workspace a meeting's destination names, or `null` for "not this
 * account's to write".
 *
 * The only translation between a `MeetingDestination`'s `@slug` and the
 * `workspaceId` `files.writeNote` takes, and it lives here rather than inside
 * `useMeetingsSetup` for the reason at the top of this file: **a rule about
 * where somebody's meeting lands must be reachable from a test without a
 * renderer.** It was not, and the case below is what that cost.
 *
 * ## `null` in means the recorder's own workspace, and it has to
 *
 * A meeting with no destination is the one-tap Record on `/meetings`, which
 * asks nobody anything. That is not "wherever this device happens to point":
 * this resolver used to answer `defaultContext`, which filters on
 * `role === "owner"` **and nothing else**, over a list sorted oldest-first. So
 * somebody who owns a shared workspace older than their own had a transcript
 * written into a bucket their colleagues watch, at whatever visibility that
 * folder carries, with no sheet ever shown to name the audience — and somebody
 * who owns no context at all but is an `editor` somewhere fell through to
 * `contexts[0]`, which is a write into another person's context.
 *
 * The rule is `ownPersonalContext` — `kind === "personal"` **and**
 * `role === "owner"` — because that is the rule this module already argues for
 * the sheet's first offer, and it is the same question: *where does a capture
 * nobody filed go?* The answer is the person's own workspace, always, whatever
 * context they are standing in. `defaultContext` stays exactly what `nav.ts`
 * says it is — which screen somebody lands on — and decides nothing about a
 * bucket.
 *
 * Owning no workspace answers `null` rather than falling back to anything. The
 * writer reads that as `unavailable`, so the meeting is kept on the device and
 * retried; claiming an @name is what makes the next drain land it. There is no
 * third option: every fallback available here is somebody else's context.
 *
 * ## A named context that is not on the list is `null` too
 *
 * Not their own workspace. A meeting addressed to `@acme` that quietly landed in the
 * recorder's own bucket would be the destination control appearing to work and
 * doing something else, which is the defect this whole module exists to close.
 */
export function meetingWorkspaceId(
  contexts: readonly RoutableContext[],
  contextSlug: string | null,
): string | null {
  if (contextSlug === null) return ownPersonalContext(contexts)?.workspaceId ?? null;
  const wanted = contextSlug.startsWith("@") ? contextSlug.slice(1) : contextSlug;
  return contexts.find((context) => context.slug === wanted)?.workspaceId ?? null;
}

/* ----------------------------- on this device ---------------------------- */

/**
 * A destination read back off a device, or `null` for anything that is not one.
 *
 * **Every destination that has been to storage comes back through here** — the
 * remembered choice below, and the one on a restored `MeetingRecord`. That is
 * `recallPlace`'s rule verbatim, and for its reason: this process wrote it, but
 * it is a file on a *device* — a restored backup, a rooted browser, another app
 * sharing the store — and both fields end up in a request against the
 * customer's own bucket.
 *
 * The slug shape is the narrow one `recallPlace` accepts, and the folder goes
 * through `safeNotePath`, the gate every externally-supplied path in this app
 * already passes. Being narrower than the control plane's naming rule costs at
 * most one preselection, which is the cheapest thing in this feature to lose —
 * and on a record it costs a meeting its folder, never the meeting.
 */
export function parseDestination(value: unknown): MeetingDestination | null {
  if (typeof value !== "object" || value === null) return null;

  const { kind, contextSlug, folder, label } = value as Record<string, unknown>;
  if (kind !== "personalInbox" && kind !== "currentPage") return null;
  if (typeof contextSlug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(contextSlug)) return null;
  if (typeof folder !== "string") return null;
  if (folder !== "" && safeNotePath(folder) !== folder) return null;

  if (kind === "personalInbox") return { kind, contextSlug, folder };
  if (typeof label !== "string") return null;
  return { kind, contextSlug, folder, label };
}
