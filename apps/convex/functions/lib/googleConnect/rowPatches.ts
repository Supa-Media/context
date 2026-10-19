/**
 * Patches `functions/googleSync.ts` writes onto a `googleConnections` row's
 * product subobjects: the folders older rows never recorded, and each
 * product's own turn record. Pure functions of a row.
 */

import type { Doc } from "../../../_generated/dataModel";
import { defaultGoogleDestinationFolder } from "./validation";

/**
 * The folder each product on this row is filing into, for the products that
 * never recorded one.
 *
 * A connect records its destination (`applyGmailConnectionBinding` always did;
 * Chat's and Calendar's bindings now do too), so this is only ever about rows
 * written before that — and it hands them exactly the folder they are already
 * using, so no key moves.
 *
 * WHY AN UNRECORDED FOLDER IS NOT MERELY UNTIDY. An absent value means
 * `defaultGoogleDestinationFolder` decides, in source, at the moment of each
 * pass. A Chat pass re-renders every day the contribution store still holds —
 * up to a year — so editing that constant rewrites a year of somebody's
 * conversations at new keys, with no action by them. Relocating notes is a
 * privacy operation in this product: `remapPrivacy` and `copyPrivacy` in
 * `lib/fileOps.ts` carry a note's `note_overrides` exception across a move and
 * across a copy, because an override names one exact path. A re-render goes
 * through neither, so a day its owner had marked `private` reappears under
 * whatever its new folder defaults to. Pinning is what keeps the folder a fact
 * about the connection rather than a value a deploy can change underneath it.
 */
export function recordedDestinations(
  row: Doc<"googleConnections">,
): Partial<Pick<Doc<"googleConnections">, "gmail" | "calendar" | "chat">> {
  const patch: Partial<Pick<Doc<"googleConnections">, "gmail" | "calendar" | "chat">> = {};
  if (row.gmail !== undefined && row.gmail.destinationFolder === undefined) {
    patch.gmail = {
      ...row.gmail,
      destinationFolder: defaultGoogleDestinationFolder("gmail", row.gmail.mailboxSlug),
    };
  }
  if (row.calendar !== undefined && row.calendar.destinationFolder === undefined) {
    patch.calendar = {
      ...row.calendar,
      destinationFolder: defaultGoogleDestinationFolder("calendar", undefined),
    };
  }
  if (row.chat !== undefined && row.chat.destinationFolder === undefined) {
    patch.chat = {
      ...row.chat,
      destinationFolder: defaultGoogleDestinationFolder("chat", undefined),
    };
  }
  return patch;
}

/** A product's turn fields, cleared by a pass that synced it. */
export const SUCCEEDED = {
  lastAttemptAt: undefined,
  lastFailureCode: undefined,
  lastFailure: undefined,
  lastFailureReason: undefined,
  retryAt: undefined,
  failures: undefined,
} as const;

/**
 * The patch that records a turn on one product's subobject, or nothing when
 * the pass named no product or the row has no such subobject.
 */
export function productTurnPatch(
  connection: Doc<"googleConnections">,
  product: "gmail" | "calendar" | "chat" | undefined,
  turn: {
    lastAttemptAt: number;
    lastFailureCode?: string;
    lastFailure?: string;
    lastFailureReason?: string;
    retryAt?: number;
    failures?: number;
  },
): Partial<Pick<Doc<"googleConnections">, "gmail" | "calendar" | "chat">> {
  if (product === undefined) return {};
  if (product === "gmail") return connection.gmail ? { gmail: { ...connection.gmail, ...turn } } : {};
  if (product === "calendar") {
    return connection.calendar ? { calendar: { ...connection.calendar, ...turn } } : {};
  }
  return connection.chat ? { chat: { ...connection.chat, ...turn } } : {};
}
