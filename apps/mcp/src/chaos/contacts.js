/**
 * Contacts are the app's to keep, so the chaos rubric scores them on hygiene
 * rather than on how many there are (decided by the owner, 2026-10-12;
 * `docs/decisions/chaos-score.md`).
 *
 * The app files every contact page under a letter of the person's name
 * (`0-inbox/contacts/a/ada-obi.md`) and a page with no name under `other/`.
 * A hundred people under A is not a mess, so a page costs only for what a
 * person or an agent can fix:
 *
 * - **Unsorted** (100): lying loose in contacts, or in a folder that is not a
 *   letter, such as the legacy `imessage/` import.
 * - **No name** (50): under `other/`; naming the person files them.
 * - **Waiting on review** (100): frontmatter `review:` holds a question, such
 *   as a possible duplicate the merge swarm left for the owner.
 *
 * Pure: `rubric.js` asks it about each page.
 */

import { CONTACTS_FOLDER, asInboxKey } from "../../../../packages/communications/src/protocol.js";

/** The folder an A to Z contacts index keeps for pages with no name. */
export const UNNAMED_FOLDER = "other";

/** Chaos of a contact page that is not filed under a letter. */
const UNSORTED = 100;

/** Chaos of a contact page filed with no name. */
const UNNAMED = 50;

/** Chaos of a contact page waiting on the owner's review. */
const IN_REVIEW = 100;

/** Whether a folder is contacts or inside it: scored by the pages' hygiene, never by count. */
export function isContactsFolder(path) {
  // Under the Inbox by either of its names, `inbox` or the numbered `0-inbox` (`asInboxKey`).
  const key = asInboxKey(String(path));
  return key === CONTACTS_FOLDER || key.startsWith(`${CONTACTS_FOLDER}/`);
}

/**
 * The chaos one contact page carries, from the folder it sits in and whether
 * it waits on review.
 *
 * @param {string} folder the page's folder, contacts or one inside it
 * @param {{ review?: boolean }} note
 */
export function contactChaos(folder, note) {
  if (note.review) return IN_REVIEW;
  const filedUnder = asInboxKey(folder).slice(CONTACTS_FOLDER.length + 1);
  if (/^[a-z]$/i.test(filedUnder)) return 0;
  if (filedUnder === UNNAMED_FOLDER) return UNNAMED;
  return UNSORTED;
}
