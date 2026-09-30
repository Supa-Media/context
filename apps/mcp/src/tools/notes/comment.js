/**
 * `write_note`'s `comment` argument: add a comment thread, reply, resolve,
 * reopen or delete, without the caller rewriting the note.
 *
 * Delete is an agent taking back its own words: the latest comment signed with
 * this connection's name in that thread, and the whole thread when that
 * comment started it. People's comments are deleted in the app, by their
 * author or a workspace owner; an agent has no owner's reach here.
 *
 * Comments live in the note's own file (`packages/shared/src/comments.cjs` has
 * the format and the reasons). An agent could maintain that block by hand with
 * an ordinary `write_note`, and nothing stops it; this is the path that gets it
 * right every time, because the gateway places the anchor and writes the log
 * line itself.
 *
 * Two things are decided here and not by the caller:
 *
 *  - **Who wrote it.** The author is the connection's client name ("Claude",
 *    "Codex"), exactly as the presence caret names it, and it is never an
 *    argument. An agent cannot post as a person. People commenting in the app
 *    are written as their `@handle`, which is how a reader tells the two apart.
 *  - **Everything else about the write.** The new text goes through
 *    `toolWriteNote` unchanged, so visibility, encryption, collaboration merge,
 *    the activity line and the presence broadcast are the same as any edit.
 *    Commenting therefore needs write access to the note, which is the default
 *    Dev2 chose (2026-09-27).
 */

import comments from "../../../../../packages/shared/src/comments.cjs";
import { isDrawingPath } from "../../../../../packages/drawings/src/excalidraw.js";
import { toolError, toolText } from "../results.js";
import { toolReadNote } from "./read.js";
import { toolWriteNote } from "./write.js";

const { addThread, appendEvent, applyChanges, deleteComment, parseComments, sanitizeAuthor } = comments;

const ACTIONS = new Set(["add", "reply", "resolve", "reopen", "delete"]);

/** The author written into the log for this connection. Never taken from arguments. */
export function commentAuthor(actor) {
  if (actor?.client) return agentName(actor.client);
  if (actor?.name) return agentName(`${actor.name}'s agent`);
  return "An agent";
}

/**
 * An agent's name, which may never read as a person's.
 *
 * The console tells a person from an agent by the `@` alone — `isPerson` in
 * `comments/model.ts` is `author.startsWith("@")`, and it draws a person's
 * circle with no "agent" tag. **The name signed here is the connection's
 * client name, and that is client-asserted**: RFC 7591 registration is
 * unauthenticated by construction (`adminFns/census.ts` says so at length), so
 * a client can call itself `@dev2` and every line it wrote would read as that
 * person's, to the people in the margin and to the next agent that reads the
 * note. So a leading `@` is removed here, where the agent's name is decided.
 *
 * This is the half a gateway can hold. The block is plain Markdown in the
 * note, by design (non-negotiable #3), so anybody who may write the note may
 * also type any line into it by hand — including one that looks like a
 * colleague's. The audit trail, not the note, is where authorship is a claim
 * the product makes.
 */
function agentName(raw) {
  // The emptiness test is on the stripped name rather than on what
  // `sanitizeAuthor` returns for nothing, so this does not depend on that
  // function's choice of word for an anonymous author.
  const bare = String(raw ?? "").replace(/^[@\s]+/, "").trim();
  return bare ? sanitizeAuthor(bare) : "An agent";
}

/**
 * Split `read_note`'s answer into its header fields and the note text.
 *
 * Reading through `toolReadNote` rather than beside it is deliberate: that
 * function is where visibility, forwarding, moves, encryption and the
 * collaboration document are resolved at equal cost for every refusal, and a
 * second reader here would be a second opinion about all of it.
 */
function parseRead(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  const split = text.indexOf("\n\n");
  if (split === -1) return null;
  const fields = {};
  for (const line of text.slice(0, split).split("\n")) {
    const colon = line.indexOf(": ");
    if (colon > 0) fields[line.slice(0, colon)] = line.slice(colon + 2);
  }
  return { fields, body: text.slice(split + 2) };
}

/**
 * The activity line. It names the act and never the quoted words: the feed
 * describes what changed, and the note's own text stays in the note.
 */
function summaryFor(action) {
  if (action === "add") return "commented on this note";
  if (action === "reply") return "replied to a comment";
  if (action === "resolve") return "resolved a comment";
  if (action === "delete") return "deleted a comment";
  return "reopened a comment";
}

export async function toolCommentNote(store, scope, rules, overrides, args) {
  const request = args.comment;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return toolError("comment must be an object: { action, quote | thread, text }");
  }
  if (args.content !== undefined) {
    return toolError("pass content or comment, not both: a comment is written into the note for you");
  }
  // Refused rather than ignored: an agent that asked for a link or a
  // visibility change beside its comment should be told none happened.
  const extra = ["images", "share", "share_short", "visibility", "confirm_team_publish"].find((key) => args[key] !== undefined);
  if (extra) return toolError(`${extra} cannot be combined with comment; comment first, then write_note again for that`);
  if (!ACTIONS.has(request.action)) return toolError("comment.action must be add, reply, resolve, reopen or delete");
  if (typeof request.text === "string" && request.text.length > 5000) {
    return toolError("comment.text is too long; keep a comment under 5000 characters");
  }
  if (typeof args.path === "string" && isDrawingPath(args.path)) {
    return toolError("a drawing cannot carry comments; comment on a note that embeds it");
  }

  const author = commentAuthor(store.actor);
  // One retry: a comment is an insertion, so a note that changed under it is
  // simply read again and the same insertion made against the new text.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const read = await toolReadNote(store, scope, rules, overrides, args.path);
    if (read?.isError) return read;
    const parsed = parseRead(read);
    if (!parsed || !parsed.fields.etag || parsed.fields.kind === "drawing") {
      return toolError("this note cannot carry comments");
    }
    const path = parsed.fields.path;
    const text = parsed.body;

    let outcome;
    let quote;
    let removedThread = false;
    if (request.action === "delete") {
      if (typeof request.thread !== "string") return toolError("comment.thread is required; read_note lists each thread's id");
      const thread = parseComments(text).threads.find((t) => t.id === request.thread);
      if (!thread) return toolError(`there is no comment thread "${request.thread}" on this note`);
      const said = thread.events.filter((event) => event.kind === "comment");
      const index = said.map((event) => event.author).lastIndexOf(author);
      if (index === -1) return toolError(`thread ${request.thread} has no comment by ${author}; only your own comments can be deleted`);
      removedThread = index === 0;
      outcome = deleteComment(text, { thread: request.thread, index, expect: { at: said[index].at, author } });
    } else if (request.action === "add") {
      if (typeof request.text !== "string") return toolError("comment.text is required to add a comment");
      outcome = addThread(text, {
        quote: request.quote,
        occurrence: request.occurrence,
        author,
        body: request.text,
      });
      quote = typeof request.quote === "string" ? request.quote : "";
    } else {
      if (typeof request.thread !== "string") return toolError("comment.thread is required; read_note lists each thread's id");
      const thread = parseComments(text).threads.find((t) => t.id === request.thread);
      quote = thread?.quote ?? "";
      outcome = appendEvent(text, {
        thread: request.thread,
        kind: request.action === "reply" ? "comment" : request.action === "resolve" ? "resolved" : "reopened",
        author,
        body: request.text,
      });
    }
    if (outcome.error) return toolError(outcome.error);

    const written = await toolWriteNote(store, scope, rules, overrides, {
      path,
      content: applyChanges(text, outcome.changes),
      expected_etag: parsed.fields.etag,
      summary: typeof args.summary === "string" && args.summary.trim() ? args.summary : summaryFor(request.action),
    });
    const conflicted = written?.isError && /^conflict:/.test(written?.content?.[0]?.text ?? "");
    if (conflicted && attempt === 0) continue;
    if (written?.isError) return written;
    const done =
      request.action === "add"
        ? `comment: started thread ${outcome.id} on ${JSON.stringify(quote)} as ${author}`
        : request.action === "delete"
          ? `comment: deleted ${removedThread ? "thread" : "your latest comment in thread"} ${request.thread}`
          : `comment: ${request.action === "reply" ? "replied to" : request.action === "resolve" ? "resolved" : "reopened"} thread ${request.thread} as ${author}`;
    return toolText(`${written.content[0].text}\n${done}`);
  }
  return toolError("conflict: note kept changing while the comment was being added; try again");
}
