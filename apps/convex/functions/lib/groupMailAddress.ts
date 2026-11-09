/**
 * A group chat's email address: `group-<words>@context.lc`, where `<words>` are the three words its home is named by
 * (`textGroups.homeWords`, `lib/textGroupHome.ts`). Decided by the owner, 2026-11-08 ("give groups emails too ...
 * group-three-words-id@context.lc so people could potentially forward things to that email"):
 * `docs/decisions/identity-and-access/ingestion.md`, "A group chat's address".
 *
 * Pure, so the email Worker (`infra/email-worker/src/ingest.ts`) and the control plane
 * (`functions/lib/groupMailIngest.ts`) read an address by one rule. Every name of that shape is reserved in the names
 * namespace (`names.ts`), so no handle or workspace can ever be named like a group's address and take its mail.
 */

import { THREE_WORD_LIST } from "./threeWords";

/** The prefix every group address starts with. */
export const GROUP_MAIL_PREFIX = "group-";

/** Where a group's mail is filed inside its home: `tex/groups/<words>/email/<hash>.md`. */
export const GROUP_MAIL_FOLDER = "email";

const WORDS = new Set(THREE_WORD_LIST);
const SHAPE = /^group-([a-z]+)-([a-z]+)-([a-z]+)$/;

/**
 * The three words a local part names, or null when it is not a group address: `group-` and three different words
 * from the list homes are named from, lowercase, nothing else. Anything else is not a group's, whatever it looks
 * like, so it can never name a home a chat's words could not be.
 */
export function groupMailWords(localPart: string): string | null {
  const match = SHAPE.exec(localPart);
  if (match === null) return null;
  const words = [match[1]!, match[2]!, match[3]!];
  if (new Set(words).size !== 3 || !words.every((word) => WORDS.has(word))) return null;
  return words.join("-");
}

/** The local part of a group's address. */
export function groupMailLocalPart(words: string): string {
  return `${GROUP_MAIL_PREFIX}${words}`;
}
