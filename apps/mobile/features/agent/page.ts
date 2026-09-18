import type { EditorState } from "../console/files/editor";
import type { DestinationContext } from "../meetings/destination";
import type { Visibility } from "../console/files/types";

/**
 * Where the person is, described for the agent — by reference, never by value.
 *
 * ## Why this module exists at all
 *
 * An agent that has to ask "which note are you looking at?" is worse than no
 * agent. The console knows: the context, the open note, whether it can be
 * written to, what its entry says about who reads it. `VoicePage` already
 * carries that subset for the microphone (`features/voice/VoiceButton.tsx`),
 * and this is the same object widened with the route, the live meeting and the
 * search query.
 *
 * ## Why it is a *reference*, and why that is a security property
 *
 * The device keeps an offline mirror of every note, and the editor on screen
 * holds the open one's full text in `draft`. So the app is one line away from
 * putting a note's body into a prompt, and that line will look like a
 * performance win to whoever writes it: why spend a tool call reading a note
 * that is already in memory?
 *
 * Because the tool call is where the security is. The gateway re-reads every
 * note through the agent's own grant, which is what runs it past `canSee` and
 * what records it in the audit trail under the agent's name. A body pasted in
 * from the console passes neither. It would be a second path to content —
 * invisible to every test at the gateway, because from there it is
 * indistinguishable from something the person typed.
 *
 * So: a path, the etag it was seen at, what the entry claims about its
 * audience, and three booleans. No body, no fragment of one, no summary. The
 * check that holds this is in `__tests__/agentPage.test.ts` and it works by
 * searching the serialized payload for a sentinel planted in the note text —
 * which catches a body added anywhere in the object, at any depth, under any
 * field name.
 *
 * ## What `visibility` is for, and what it is not
 *
 * It is **disclosure**, not authority. It rides along so the agent can warn
 * somebody that the draft it is about to propose lands in a note their whole
 * team reads — the same job the sentence in `VoiceSheet` does before the
 * microphone opens. It is never what decides whether the agent may read the
 * note; the privacy engine decides that, in the gateway, from the live
 * `privacy.md`, and a client-supplied value could not be trusted for it anyway.
 */

/** What the `kind` discriminator has to be for a context to be the person's own. */
const PERSONAL = "personal";

export interface AgentContext {
  /** The name the context is addressed by, without its `@`. */
  slug: string;
  /**
   * Whether this is the person's own workspace.
   *
   * Derived here rather than passed through as `kind`, so that a build meeting
   * a `kind` it has never heard of describes it as somebody else's — the same
   * direction `audience.ts` fails in, and for the same reason: "only you" is
   * the sentence that must never be said wrongly.
   */
  personal: boolean;
  /** `owner` | `editor` | `member`, verbatim. The gateway re-derives authority. */
  role: string;
}

export interface NoteReference {
  /** The bucket path. What the gateway will read, if its grant permits. */
  path: string;
  /** The version the console last saw, or `null` for a note not yet written. */
  etag: string | null;
  /** What the entry claims about who can read this. Disclosure only. */
  visibility: Visibility;
  /**
   * Whether there is a body at this path that anybody could read.
   *
   * `false` for a note that has never been written, and for one stored
   * encrypted — the console has no key for the latter and neither has the
   * gateway, so a read would return an envelope rather than a note. Saying so
   * costs a boolean and saves the agent a tool call whose result it would
   * misreport as the note's contents.
   */
  readable: boolean;
  /**
   * The screen is ahead of the file.
   *
   * The agent reads what was saved; this is how it knows to say so. It is
   * deliberately a flag and not a diff: telling it *that* they differ is
   * honest, telling it *how* would mean sending the draft, which is the one
   * thing this module refuses.
   */
  unsaved: boolean;
}

export interface AgentPage {
  context: AgentContext | null;
  note: NoteReference | null;
  /** The route, for "you are on the search screen" rather than a note. */
  route: string;
  /** A meeting is recording. The agent should not offer the microphone. */
  meetingLive: boolean;
  /** What the person typed into search, or `null`. Their words, not the note's. */
  query: string | null;
}

export function agentPage(input: {
  context: DestinationContext | null;
  editor: EditorState;
  route: string;
  meetingLive: boolean;
  query: string | null;
}): AgentPage {
  const { context, editor, route, meetingLive, query } = input;

  return {
    context:
      context === null
        ? null
        : {
            slug: context.slug,
            personal: context.kind === PERSONAL,
            role: context.role,
          },
    note: noteReference(editor),
    route,
    meetingLive,
    query,
  };
}

/**
 * The open note, as a reference — or `null` when a folder is on screen.
 *
 * Takes the whole `EditorState` and reads five fields off it. That is
 * deliberate: a version taking `(path, etag, visibility, …)` would let a caller
 * assemble a reference from somewhere other than the editor, and the editor is
 * the one place that knows whether the draft has diverged.
 */
function noteReference(editor: EditorState): NoteReference | null {
  if (editor.path === null) return null;

  const written = editor.etag !== null;
  return {
    path: editor.path,
    etag: editor.etag,
    visibility: editor.visibility,
    readable: written && !editor.encrypted,
    unsaved: editor.draft !== editor.baseline,
  };
}

/**
 * The console route for a context, without asking the router.
 *
 * `usePathname` would be the obvious source and is the wrong one here: the
 * surfaces that mount the note pane include two fixtures and the landing
 * page's demo console, none of which sits under a router, and a hook that
 * throws on three surfaces to populate one field is a bad trade. The route
 * this field wants to carry is `/console/@slug`, and the slug is already in
 * hand.
 */
export function consoleRoute(context: DestinationContext | null): string {
  return context === null ? "/console" : `/console/@${context.slug}`;
}

/**
 * One sentence naming the room, for the head of the agent's first turn.
 *
 * Kept here beside the shape rather than in a prompt template, because it is
 * covered by the same leakage test as the object is: a future edit that reaches
 * for `editor.draft` to make this more useful fails
 * `carries no note text either` rather than shipping.
 *
 * Deliberately terse. It is a few dozen tokens at the head of every
 * conversation, it is re-sent on every turn, and everything it might elaborate
 * on the agent can fetch for itself — which has the side effect of putting that
 * fetch in the audit trail, where it belongs.
 */
export function describePlace(page: AgentPage): string {
  const parts: string[] = [];

  if (page.context === null) {
    parts.push("No context is open.");
  } else {
    const whose = page.context.personal ? "their own workspace" : "a shared workspace";
    parts.push(`The person is in @${page.context.slug}, ${whose}, as ${page.context.role}.`);
  }

  if (page.note !== null) {
    const note = page.note;
    parts.push(`The open note is ${note.path}, visible to ${note.visibility}.`);
    if (!note.readable) {
      parts.push("Its body cannot be read — it is encrypted or has never been written.");
    }
    if (note.unsaved) {
      parts.push("It has unsaved changes, so the saved copy is behind what is on screen.");
    }
  } else if (page.context !== null) {
    parts.push("No note is open.");
  }

  if (page.query !== null && page.query.length > 0) {
    parts.push(`They are searching for "${page.query}".`);
  }

  if (page.meetingLive) {
    parts.push("A meeting is recording, so the microphone is not available.");
  }

  return parts.join(" ");
}
