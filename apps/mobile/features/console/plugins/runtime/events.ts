/**
 * A plugin's own writes, turned into the vault events other plugins are
 * told about; the suggestion and link-preview queries routed to one frame;
 * and the content/path visibility grants a running plugin needs to be shown
 * either. Split out of `../runtime.ts` — see that facade for the file this
 * used to be.
 */

import type { PluginGrant } from "../grants";
import type { LinkPreview, VaultEventMessage } from "../sandboxTypes";

/* -------------------------------------------------------------------------- */
/*                    a plugin's own write, as an event                       */
/* -------------------------------------------------------------------------- */

/**
 * Turn one successful plugin RPC into the change the other plugins are told
 * about, or `null` when it was not a change.
 *
 * Pure, and here rather than in `useRuntime`, because the decision is the part
 * worth pinning: which operations count, what path each reports, and what it
 * does with anything it does not recognise.
 *
 * **The writer's own guest is told too.** Obsidian dispatches vault events to
 * every handler including the one whose write caused them, and a shim that
 * filtered the author out would be a difference nobody could debug from inside
 * a plugin.
 *
 * Silence on anything unrecognised is the load-bearing half. An unknown write
 * reported as a `modify` with no version is worse than one not reported at all,
 * because a plugin acts on it — and a future operation kind would arrive here
 * as exactly that.
 */
export function vaultEventForOperation(
  operation: { kind?: unknown; path?: unknown; from?: unknown; to?: unknown } | undefined,
  response: unknown,
): Omit<VaultEventMessage, "seq"> | null {
  if (!operation || typeof operation.kind !== "string") return null;
  if ((response as { ok?: unknown } | null)?.ok !== true) return null;
  const etag = (response as { result?: { etag?: unknown } }).result?.etag;
  const version = typeof etag === "string" ? etag : null;
  const path = typeof operation.path === "string" ? operation.path : null;
  switch (operation.kind) {
    case "vault.create":
      return path === null ? null : { kind: "create", path, etag: version };
    case "vault.modify":
      return path === null ? null : { kind: "modify", path, etag: version };
    case "vault.delete":
      // No version: there is nothing left to hold one, and a path with a stale
      // etag beside it is an invitation to write over what replaced it.
      return path === null ? null : { kind: "delete", path, etag: null };
    case "vault.rename": {
      // Obsidian hands a rename handler the file at its *new* path and the old
      // path beside it, so `to` is the event's path and `from` is the extra.
      const to = typeof operation.to === "string" ? operation.to : null;
      if (to === null) return null;
      const from = typeof operation.from === "string" ? operation.from : undefined;
      return { kind: "rename", path: to, from, etag: version };
    }
    default:
      return null;
  }
}

export interface AppliedPluginNoteWrite {
  path: string;
  text: string;
  expectedEtag: string;
  etag: string;
}

/**
 * The exact successful note replacement the trusted host just performed.
 *
 * This is deliberately narrower than a vault event: only `vault.modify` has
 * both the complete new body and an old version that lets the open editor
 * prove it is still looking at the version the plugin replaced.  The values
 * come from the request the host sent to Convex and the response Convex
 * returned; nothing new is accepted from a guest after authorization.
 */
export function appliedPluginNoteWrite(
  operation: {
    kind?: unknown;
    path?: unknown;
    text?: unknown;
    expectedEtag?: unknown;
  } | undefined,
  response: unknown,
): AppliedPluginNoteWrite | null {
  if (operation?.kind !== "vault.modify") return null;
  if (typeof operation.path !== "string" || typeof operation.text !== "string") return null;
  if (typeof operation.expectedEtag !== "string") return null;
  if ((response as { ok?: unknown } | null)?.ok !== true) return null;
  const etag = (response as { result?: { etag?: unknown } }).result?.etag;
  if (typeof etag !== "string") return null;
  return {
    path: operation.path,
    text: operation.text,
    expectedEtag: operation.expectedEtag,
    etag,
  };
}

/**
 * One suggestion query, before it is routed to a frame.
 *
 * Carries the plugin and the frame for the same reason `InvokeRequest` does: by
 * the time it reaches a sandbox the plugin is implied, and a field the guest
 * could read that nothing checks is worse than no field.
 */
export interface SuggestRequest {
  seq: number;
  pluginId: string;
  /** The frame this was aimed at. A replacement frame has a different one. */
  nonce: string;
  /** The line the cursor is on, up to and including it. Note content. */
  line: string;
  /** Where the cursor sits in that line. */
  ch: number;
}

/**
 * The query to hand this frame, or nothing.
 *
 * The rule #533 established for commands, applied to the other instruction in
 * this protocol. A restart mounts a new frame, and a query aimed at the frame
 * before it is not owed to its successor — a suggester answering it would be
 * completing against a line the person has since left.
 */
export function suggestFor(
  sandbox: { bundle: { pluginId: string }; nonce: string },
  request: SuggestRequest | undefined,
): { seq: number; line: string; ch: number } | undefined {
  if (request === undefined) return undefined;
  if (request.pluginId !== sandbox.bundle.pluginId) return undefined;
  if (request.nonce !== sandbox.nonce) return undefined;
  return { seq: request.seq, line: request.line, ch: request.ch };
}

/**
 * The suggestions to show, or null when the answer is stale.
 *
 * **Typing outruns a round trip.** A menu built from an answer to a line the
 * cursor has already left is worse than no menu: it offers completions for text
 * that is no longer there, and somebody accepts one into the text that is. The
 * sequence the host asked with is the only thing that can tell those apart, so
 * it is required on the wire and compared here.
 */
export function freshSuggestions(
  answer: { seq: number; items: { text: string }[] },
  asked: number | null,
): { text: string }[] | null {
  if (asked === null) return null;
  return answer.seq === asked ? answer.items : null;
}

/**
 * Whether the walk that is asking is still the one the editor is waiting on.
 *
 * `askSuggestions` walks the running frames one at a time, and a second
 * keystroke starts a second walk before the first has finished. Found reviewing
 * the diff: both walks were writing the same "what did I last ask?" slot, so an
 * **older** walk could overwrite it with its own newer sequence — and then the
 * newer keystroke's answer looked stale and was dropped while the older one's
 * was accepted and shown. The sequence number exists to stop exactly that, and
 * this is the door it left open.
 *
 * A generation per call closes it: an answer is used only while its own walk is
 * still the current one, and a superseded walk yields nothing whatever comes
 * back to it.
 */
export function currentWalk(mine: number, latest: number): boolean {
  return mine === latest;
}

/**
 * A request to preview the open note's links, aimed at one frame.
 *
 * The links are the note's own — the addresses somebody wrote down and the
 * words they wrote around them — so this carries note content and is gated
 * exactly as a suggestion query is.
 */
export interface PreviewRequest {
  seq: number;
  pluginId: string;
  /** The frame this was aimed at. A replacement frame has a different one. */
  nonce: string;
  links: LinkPreview[];
}

/**
 * The preview query to hand this frame, or nothing.
 *
 * The rule #533 set for commands, applied to the third instruction in this
 * protocol: a restart mounts a new frame, and a query aimed at the frame before
 * it is not owed to its successor. The successor has its own settings, its own
 * cache and possibly its own version of the plugin.
 */
export function previewFor(
  sandbox: { bundle: { pluginId: string }; nonce: string },
  request: PreviewRequest | undefined,
): { seq: number; links: LinkPreview[] } | undefined {
  if (request === undefined) return undefined;
  if (request.pluginId !== sandbox.bundle.pluginId) return undefined;
  if (request.nonce !== sandbox.nonce) return undefined;
  return { seq: request.seq, links: request.links };
}

/**
 * The previews to keep, or null when the answer is stale.
 *
 * A verse takes a round trip through the broker and a third-party site, which
 * is long enough for somebody to close the note or rewrite the paragraph. An
 * answer to a question about links that are no longer there would draw a
 * tooltip over whatever is at that href now.
 */
export function freshPreviews(
  answer: { seq: number; previews: LinkPreview[] },
  asked: number | null,
): LinkPreview[] | null {
  if (asked === null) return null;
  return answer.seq === asked ? answer.previews : null;
}

/**
 * How long the editor waits for a plugin to preview a note's links.
 *
 * Far longer than `SUGGEST_TIMEOUT_MS`, and the difference is the whole point:
 * a suggestion is entered on a keystroke and a person is waiting on it, while a
 * preview is asked once when a note opens and read only if somebody hovers a
 * link. A verse crosses the brokered egress path — a Worker, a container and a
 * third-party site — and giving up at 1.2 seconds would report "no preview" for
 * a plugin that works.
 */
export const PREVIEW_TIMEOUT_MS = 8000;

/**
 * Which loaded plugins may be shown a line of somebody's note.
 *
 * ## Why this is not `maySeePaths`
 *
 * A suggestion query carries **content** — the line somebody is in the middle
 * of typing. Every other piece of state this host pushes to a guest carries a
 * *path*, and `maySeePaths` opens on `vault:read` **or** `metadata:read`
 * because a path is metadata-shaped.
 *
 * A line of prose is not metadata. A plugin granted `metadata:read` was
 * approved to see frontmatter, headings, tags and the links between notes; it
 * was not approved to read the sentence being written. So this is `vault:read`
 * alone, and it is a separate function rather than a parameter on the other one
 * — two gates that answer different questions drift into each other the moment
 * they share a name.
 *
 * The guest cannot enforce this: it is handed the line before it runs any
 * plugin code. The decision has to be made here, before the message is sent.
 */
export function maySeeContent(
  sandbox: { pluginId: string; bundleFingerprint: string },
  grants: readonly PluginGrant[] | undefined,
): boolean {
  if (grants === undefined) return false;
  const grant = grants.find(
    (one) =>
      one.pluginId === sandbox.pluginId &&
      one.bundleFingerprint === sandbox.bundleFingerprint &&
      one.status === "active",
  );
  if (grant === undefined) return false;
  return grant.capabilities.includes("vault:read");
}

/**
 * Which loaded plugins may be told the path of a note.
 *
 * **Found reviewing the diff that introduced the active file.** The host was
 * handing `active-file` and every `vault-event` to every loaded guest alike —
 * including one approved for nothing but its own settings. A plugin with no
 * vault grant cannot read a single note, and was nonetheless being told, live,
 * the path of whatever its owner had open and the path of everything they
 * edited. That is a read the consent screen never offered and the RPC would
 * refuse.
 *
 * A path is note data. So this is the same rule the RPC enforces, applied to the
 * state the host pushes rather than the state a plugin asks for: `vault:read` or
 * `metadata:read`, or nothing crosses.
 *
 * Keyed on the fingerprint as well as the id, like `runtimeFor`: a grant for a
 * bundle that is no longer the one running is not this plugin's grant.
 */
export function maySeePaths(
  sandbox: { pluginId: string; bundleFingerprint: string },
  grants: readonly PluginGrant[] | undefined,
): boolean {
  if (grants === undefined) return false;
  const grant = grants.find(
    (one) =>
      one.pluginId === sandbox.pluginId &&
      one.bundleFingerprint === sandbox.bundleFingerprint &&
      one.status === "active",
  );
  if (grant === undefined) return false;
  return grant.capabilities.includes("vault:read") || grant.capabilities.includes("metadata:read");
}
