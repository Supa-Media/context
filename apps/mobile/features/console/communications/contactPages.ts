/**
 * Contacts as a first-party part of the app: which notes are contact pages,
 * what their header says, and how the contacts folder's A–Z letter folders
 * are drawn as an index. Pure, so all of it is tested without a renderer
 * (`contactPages.test.ts`).
 *
 * ## Two formats, one header
 *
 * - **Sync pages** — `renderContactNote` in `@context/communications`:
 *   frontmatter `type: "contact"`, `# Name`, `## Identifiers` with
 *   `- email: …` / `- phone: …`. Read back with that package's own
 *   `parseContactView`, never a second reading of the same shape.
 * - **Imported iMessage pages** — `role: communication-contact`, `# Name`,
 *   `## Identities` with ``- iMessage: `+1…` ``. The same recognition
 *   `read_contact` in the gateway uses (`apps/mcp/src/tools/communications.js`).
 *
 * The frontmatter decides, never the folder alone: a person's own note filed
 * beside the pages is an ordinary note and gets no header.
 *
 * ## Where a contact page lives
 *
 * `0-inbox/contacts/<letter>/<page>.md`, with letter folders `a`..`z` and
 * `other`; during the move, flat `0-inbox/contacts/<page>.md` and the legacy
 * `0-inbox/contacts/imessage/` folder too. So: the contacts folder, one level
 * deep or flat, and nothing deeper.
 */

import { CONTACTS_FOLDER, asInboxKey, isContactNote, parseContactView } from "@context/communications";
import { baseName, parentPath } from "../files/paths";
import { frontmatterTitle, properties, splitNote } from "../files/frontmatter";
import type { FileEntry } from "../files/types";

/** The letter folders, in the order the index draws them: A to Z, then `other`. */
export const CONTACT_LETTERS: readonly string[] = Object.freeze([
  ..."abcdefghijklmnopqrstuvwxyz",
  "other",
]);

/** The identifier kinds a header draws a chip for — the ones a person recognises on sight. */
export type ContactChipKind = "email" | "phone" | "imessage";

export interface ContactHeaderView {
  name: string;
  identifiers: { kind: ContactChipKind; value: string }[];
}

/** One letter in the A–Z index: where it goes, or `null` when there is no folder for it. */
export interface ContactLetter {
  letter: string;
  label: string;
  path: string | null;
}

const PREFIX = `${CONTACTS_FOLDER}/`;

/** A Markdown note in the contacts folder, flat or one folder down, under either of the Inbox's names (`asInboxKey`). */
export function isContactPagePath(path: string): boolean {
  const key = asInboxKey(path);
  if (!key.startsWith(PREFIX) || !key.endsWith(".md")) return false;
  const segments = key.slice(PREFIX.length).split("/");
  if (segments.length > 2) return false;
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Is this one of the contacts folder's letter folders (`a`..`z`, `other`)? */
function isLetterFolder(path: string): boolean {
  return asInboxKey(parentPath(path)) === CONTACTS_FOLDER && CONTACT_LETTERS.includes(baseName(path));
}

/**
 * The contacts folder's listing split into the A–Z index and the rows that
 * stay rows (legacy folders and flat pages, in the listing's own order).
 * `null` for every other folder.
 */
export function contactsIndex(
  folder: string,
  rows: readonly FileEntry[],
): { letters: ContactLetter[]; rest: FileEntry[] } | null {
  // The contacts folder under the Inbox by either name: `inbox`, or `0-inbox` where the rename was skipped.
  if (asInboxKey(folder) !== CONTACTS_FOLDER) return null;
  const present = new Set(
    rows.filter((row) => row.kind === "folder" && isLetterFolder(row.path)).map((row) => row.path),
  );
  const letters = CONTACT_LETTERS.map((letter) => {
    const path = `${folder}/${letter}`;
    return {
      letter,
      label: letter === "other" ? "Other" : letter.toUpperCase(),
      path: present.has(path) ? path : null,
    };
  });
  return { letters, rest: rows.filter((row) => !present.has(row.path)) };
}

/** ``- iMessage: `+1…` `` — the imported page's one identifier line. Backticks optional. */
const IMESSAGE_LINE = /^-\s+iMessage:\s*`?([^`\n]+?)`?\s*$/gim;

/**
 * The header for a contact page, or `null` when the note is not one.
 *
 * Only email, phone and iMessage become chips: `chat` and `provider-user`
 * identifiers are opaque provider ids, which are in the body for anyone who
 * wants them and mean nothing in a chip.
 */
export function contactHeaderOf(path: string | null, text: string): ContactHeaderView | null {
  if (path === null || !isContactPagePath(path)) return null;
  const { frontmatter } = splitNote(text);
  if (frontmatter === "") return null;

  let name = "";
  const found: { kind: ContactChipKind; value: string }[] = [];
  if (isContactNote(text)) {
    const view = parseContactView(text);
    name = view.name;
    for (const identifier of view.identifiers) {
      if (identifier.kind === "email" || identifier.kind === "phone") {
        found.push({ kind: identifier.kind, value: identifier.value.trim() });
      }
    }
  } else if (properties(frontmatter).some((row) => row.key === "role" && row.value === "communication-contact")) {
    name = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? "";
    for (const match of text.matchAll(IMESSAGE_LINE)) {
      found.push({ kind: "imessage", value: match[1]!.trim() });
    }
  } else {
    return null;
  }

  const seen = new Set<string>();
  const identifiers = found.filter((identifier) => {
    const key = `${identifier.kind}:${identifier.value.toLowerCase()}`;
    if (identifier.value === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    name: name || frontmatterTitle(frontmatter) || baseName(path).slice(0, -".md".length),
    identifiers,
  };
}
