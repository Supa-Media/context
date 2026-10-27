/**
 * Which rows are copies Context made of somebody's mail, calendar, chat,
 * contacts and iMessage, and which are the person's own (owner, 2026-10-21;
 * `docs/decisions/communications/live-not-copied.md`).
 *
 * A copy says so in its front matter: every channel day carries the `origin`
 * of the pass that wrote it (`packages/communications/src/note.js`), and a
 * contact page is `type: contact` with an `## Activity` section the renderer
 * regenerates (`contacts.js`). A mail attachment is a file in its mailbox's
 * `attachments/` folder. Anything else is the person's, wherever it sits: a
 * note they filed beside their mail stays where it is, and so does a contact
 * page they wrote anything under `## Notes` on.
 *
 * Pure: the rows' facts decide what they can (`props`, read from the note at
 * `parsed`), and a note the facts cannot vouch for is read (`read`) and
 * decided by its text (`bodyVerdict`).
 */

import { noteProperties } from "../../../../mcp/src/lists/properties.js";
import { parseContactNote } from "../../../../../packages/communications/src/contacts.js";

/** The `origin` each pass that copied a day wrote into it. */
export const COPY_ORIGINS: ReadonlySet<string> = new Set([
  "gmail-sync",
  "calendar-sync",
  "google-chat-sync",
  "desktop-imessage-sync",
  "communications-sync",
]);

/** A file in a mailbox's `attachments/` under an `email` folder, wherever the inbox now is. */
const MAILBOX_ATTACHMENT = /(?:^|\/)email\/[^/]+\/attachments\//;

/** A day note's name: `2026-10-21.md`, or a later part of a busy day. */
const DAY_NAME = /^\d{4}-\d{2}-\d{2}(?:-part-\d+)?\.md$/;

export interface CandidateRow {
  path: string;
  kind: "file" | "folder";
  etag?: string;
  parsed?: string;
  props?: string;
}

/** A day of mail, calendar or chat; a mail attachment; or a note whose text has to be read to tell. */
export type RowVerdict = "day" | "attachment" | "read" | null;

/** What the text of a note says it is: a copied day, a contact page with nothing of the person's, or theirs. */
export type BodyVerdict = "day" | "contact" | null;

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The front matter the facts fill read, when it was read at the note's current version. */
function freshProperties(row: CandidateRow): Record<string, unknown> | null {
  if (row.props === undefined || row.parsed === undefined || row.parsed !== row.etag) return null;
  try {
    const parsed = JSON.parse(row.props) as { properties?: unknown };
    const properties = parsed.properties;
    return properties !== null && typeof properties === "object" ? (properties as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * What a row is, from its facts. `attachmentFolders` are the folders the mail
 * and chat passes wrote into, each holding its `attachments/`.
 */
export function rowVerdict(row: CandidateRow, attachmentFolders: readonly string[]): RowVerdict {
  if (row.kind !== "file") return null;
  if (!row.path.endsWith(".md")) {
    // A mailbox's own folder, or one under a renamed inbox the connection never recorded.
    if (attachmentFolders.some((folder) => row.path.startsWith(`${folder}/attachments/`))) return "attachment";
    return MAILBOX_ATTACHMENT.test(row.path) ? "attachment" : null;
  }
  const properties = freshProperties(row);
  if (properties !== null) {
    if (typeof properties.origin === "string" && COPY_ORIGINS.has(properties.origin)) return "day";
    return properties.type === "contact" ? "read" : null;
  }
  // No facts at this version: a name a pass could have written is read; any other note is the person's.
  if (DAY_NAME.test(nameOf(row.path))) return "read";
  return row.path.split("/").includes("contacts") ? "read" : null;
}

/** What a note's text says it is (`rowVerdict` answered `read`). */
export function bodyVerdict(text: string): BodyVerdict {
  const properties = noteProperties(text) as Record<string, unknown>;
  if (typeof properties.origin === "string" && COPY_ORIGINS.has(properties.origin)) return "day";
  if (properties.type !== "contact") return null;
  // A page the renderer made has its Activity, and its Notes heading with nothing the person wrote under it.
  if (!text.includes("\n## Activity")) return null;
  return parseContactNote(text).notes === "" ? "contact" : null;
}

/** The day a day note is of, from its name, for the "copied from ... to ..." line. */
export function dayOf(path: string): string | null {
  const name = nameOf(path);
  return DAY_NAME.test(name) ? name.slice(0, 10) : null;
}
