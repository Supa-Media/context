/**
 * `remember` — an agent saving one durable fact about the person into their
 * Context (docs/design/remember).
 *
 * Built on the two tools an agent would otherwise use by hand, so every rule
 * they enforce holds here unchanged: `read_note` decides what this connection
 * may see (privacy, moved notes, live editing rooms, encryption), and
 * `write_note` decides what it may write (workspace, permissions, visibility,
 * conflicts, indexing). What this adds is the one-line edit, done exactly,
 * and a change recorded as `remember_fact` with the fact, whether it was
 * stated or inferred, and the line it replaced. The note itself only ever
 * gains the plain line.
 */

import { isPlumbing } from "../../privacy/engine.js";
import { normalizePath } from "../../notes/paths.js";
import { toolError, toolText } from "../results.js";
import { toolReadNote } from "./read.js";
import { toolWriteNote } from "./write.js";

const MAX_FACT_LENGTH = 500;
const KINDS = new Set(["stated", "inferred"]);
/** Context's own files at the root: never an agent's to edit line by line. */
const RESERVED = new Set(["index.md", "privacy.md", "activity.md"]);
/**
 * Where a fact with no note goes: its own folder in the inbox, so memories do
 * not mix with everything else waiting there (the owner, 2026-10-07). The name
 * is ours, so the control plane lists it among the paths a share preview must
 * not confirm (`PRODUCT_MANDATED_PATHS`).
 */
export const MEMORY_FOLDER = "0-inbox/memories";
/** New inbox notes for one day's facts are numbered past this many collisions, then refused. */
const MAX_INBOX_ATTEMPTS = 20;

export async function toolRemember(store, scope, rules, overrides, args) {
  const fact = typeof args?.fact === "string" ? args.fact.trim() : "";
  if (!fact || /[\r\n]/.test(fact) || fact.length > MAX_FACT_LENGTH) {
    return toolError(`invalid: fact must be one line of 1 to ${MAX_FACT_LENGTH} characters`);
  }
  if (!KINDS.has(args.kind)) return toolError('invalid: kind must be "stated" or "inferred"');
  if (args.replaces !== undefined && (typeof args.replaces !== "string" || !bare(args.replaces))) {
    return toolError("invalid: replaces must be the text of an existing line");
  }

  if (args.note === undefined) return rememberInInbox(store, scope, rules, overrides, fact, args.kind);

  const path = normalizePath(args.note);
  if (!path || !path.endsWith(".md")) return toolError("invalid: note must be a path ending in .md");
  if (RESERVED.has(path) || isPlumbing(path)) {
    return toolError(`reserved: ${path} is Context's own file; remember the fact in a note instead`);
  }

  // One retry: a note edited between the read and the write is read again and
  // the line lands on top of the newer text. A second miss is refused rather
  // than chased, and nothing is overwritten either time.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const opened = await openNote(store, scope, rules, overrides, path);
    if (opened.error) return opened.error;
    const edit = editLines(opened.body, fact, args.replaces);
    if (edit.error) return toolError(edit.error);
    const written = await toolWriteNote(
      store,
      scope,
      rules,
      overrides,
      { path: opened.path, content: edit.body, expected_etag: opened.etag },
      {
        record: {
          action: "remember_fact",
          details: {
            fact,
            kind: args.kind,
            count: 1,
            created: false,
            ...(edit.replaced === undefined ? {} : { replaced: edit.replaced }),
          },
        },
      },
    );
    if (written.isError && textOf(written).startsWith("conflict") && attempt === 0) continue;
    if (written.isError) {
      return textOf(written).startsWith("conflict")
        ? toolError("conflict: the note changed twice while remembering; nothing was written. Re-read it and try again.")
        : written;
    }
    return toolText(
      `remembered in ${opened.path} (${edit.replaced === undefined ? "added a line" : "replaced a line"})`,
    );
  }
  return toolError("conflict: the note kept changing; nothing was written");
}

/**
 * The note as `read_note` serves it to this connection, split into its header
 * and its text. A note this connection cannot see is "not found", exactly as
 * `read_note` says it, so this is no second way to learn what exists.
 */
async function openNote(store, scope, rules, overrides, path) {
  const result = await toolReadNote(store, scope, rules, overrides, path);
  const text = textOf(result);
  if (result.isError) {
    // A password-locked note cannot be opened by anything Context runs, so
    // `read_note` refuses it, and it is never edited by an agent.
    if (text.startsWith("that note is encrypted")) {
      return { error: toolError("encrypted: this note is locked with a password and is never edited by an agent") };
    }
    return { error: toolError(`${text}: search for the note, or leave note out to use the inbox`) };
  }
  const split = text.indexOf("\n\n");
  const header = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? "" : text.slice(split + 2);
  const fields = Object.fromEntries(
    header.split("\n").map((line) => {
      const colon = line.indexOf(":");
      return colon === -1 ? [line, ""] : [line.slice(0, colon), line.slice(colon + 1).trim()];
    }),
  );
  if (fields.kind === "drawing") return { error: toolError("invalid: a drawing has no lines to remember into") };
  return { path: fields.path || path, etag: fields.etag, body };
}

/** A line's text without its indentation or list marker. */
function bare(line) {
  return line.trim().replace(/^[-*+]\s+/, "").trim();
}

/**
 * Where the note's prose starts: past the frontmatter block, if it has one.
 *
 * A `---` first line up to the next `---`, read exactly as `parseWebsitePage`
 * reads it, and 0 when the block is unclosed — which that parser also treats
 * as no frontmatter at all. Lines in there are not prose about the person;
 * they are metadata other parts of the product read as a control.
 */
function bodyStart(lines) {
  if (lines[0] !== "---") return 0;
  const closing = lines.indexOf("---", 1);
  return closing === -1 ? 0 : closing + 1;
}

/**
 * The one-line edit: swap the single line `replaces` names, or append.
 * Everything else in the note is left byte for byte as it was.
 *
 * `replaces` can only ever name a line of the note's prose. Frontmatter is
 * excluded because a line in there is a control rather than a sentence, and
 * the controls widen when they go missing: `audience: members` is what holds a
 * website page to the workspace's members, and a page with no `audience` line
 * is `public`. Swapping that one line for a bullet would publish the page to
 * the internet — through the one save that deliberately does not wait for the
 * person to approve it. An append already lands below the block.
 */
function editLines(body, fact, replaces) {
  if (replaces === undefined) {
    const separator = body === "" || body.endsWith("\n") ? "" : "\n";
    return { body: `${body}${separator}- ${fact}\n` };
  }
  const lines = body.split("\n");
  const start = bodyStart(lines);
  const wanted = bare(replaces);
  const found = (from, to) =>
    lines.slice(from, to).map((line, index) => (bare(line) === wanted ? index + from : -1)).filter((index) => index !== -1);
  const matches = found(start, lines.length);
  if (matches.length === 0) {
    return {
      error: found(0, start).length
        ? "replaces_frontmatter: that line is the note's frontmatter, not one of its facts; nothing was written"
        : "replaces_not_found: no line in the note matches replaces; nothing was written",
    };
  }
  if (matches.length > 1) {
    return { error: "replaces_ambiguous: more than one line matches replaces; nothing was written" };
  }
  const index = matches[0];
  const original = lines[index];
  lines[index] = `${original.match(/^\s*/)[0]}- ${fact}`;
  return { body: lines.join("\n"), replaced: original.trim() };
}

/** A new note in the inbox holding just the fact, created only where nothing is. */
async function rememberInInbox(store, scope, rules, overrides, fact, kind) {
  const day = new Date().toISOString().slice(0, 10);
  const slug =
    fact
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "fact";
  for (let attempt = 1; attempt <= MAX_INBOX_ATTEMPTS; attempt += 1) {
    const path = `${MEMORY_FOLDER}/${day}-${slug}${attempt === 1 ? "" : `-${attempt}`}.md`;
    const written = await toolWriteNote(
      store,
      scope,
      rules,
      overrides,
      { path, content: `- ${fact}\n` },
      {
        mustCreate: true,
        record: { action: "remember_fact", details: { fact, kind, count: 1, created: true } },
      },
    );
    if (!written.isError) return toolText(`remembered in ${path} (new note in ${MEMORY_FOLDER})`);
    const text = textOf(written);
    if (!text.startsWith("that note already exists") && !text.startsWith("conflict")) return written;
  }
  return toolError("conflict: too many inbox notes for this fact today; pass note to add it to one of them");
}

function textOf(result) {
  return result?.content?.[0]?.text || "";
}
