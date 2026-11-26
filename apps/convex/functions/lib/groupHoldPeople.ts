/**
 * Who a held answer was held in front of, and which held workspaces a chat may treat as open now
 * (`functions/groupHolds.ts`). Kept apart so the group turn (`textGroupHomeOnly.ts`) reads it without importing the
 * functions that write holds.
 */

import type { Doc } from "../../_generated/dataModel";
import { guestPhoneHash } from "./guestPhones";

const E164 = /^\+[1-9]\d{6,14}$/;

type Hold = NonNullable<Doc<"textGroups">["holds"]>[number];

/** The people in a chat as these rows keep them: keyed hashes of their numbers, or null without a key to derive them. */
export async function peopleHashes(phones: readonly string[]): Promise<string[] | null> {
  const out = new Set<string>();
  for (const phone of phones) {
    if (!E164.test(phone)) continue;
    const hash = await guestPhoneHash(phone);
    if (hash === null) return null;
    out.add(hash);
  }
  return [...out].sort();
}

/**
 * The slugs a chat's turn may treat as open for the people in it now: those of a shared hold every one of whom was
 * present when it was held. A chat with anyone new gets none of that hold's.
 */
export function unlockedSlugs(holds: readonly Hold[] | undefined, present: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (present.length === 0) return out;
  for (const hold of holds ?? []) {
    if (hold.sharedAt === undefined) continue;
    const then = new Set(hold.people);
    if (present.every((person) => then.has(person))) for (const slug of hold.slugs) out.add(slug);
  }
  return out;
}

