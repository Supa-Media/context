/**
 * Saving a card (`saveVaultLogin` in `../vault.ts`): the card as the person
 * typed it, checked by the gateway's own rules (`apps/mcp/src/vault/card.js`)
 * and kept as fixed fields, with the summary meta carries. A card carries
 * nothing else: no login, no fields of its own, no AI pin.
 */

import { ConvexError, v, type Infer } from "convex/values";
import { normalizeCard } from "../../../mcp/src/vault/card.js";
import type { CardSummary, FieldValues } from "./vaultShapes";

export const cardInputValidator = v.object({
  number: v.string(),
  expMonth: v.string(),
  expYear: v.string(),
  cvc: v.string(),
  name: v.optional(v.string()),
  postalCode: v.optional(v.string()),
});

const invalid = (message: string) => new ConvexError({ code: "INVALID_ARGUMENT", message });

/** A card's fields and summary, or null for any other kind. Throws on a card that doesn't check out. */
export function checkedCard(
  type: string,
  args: { card?: Infer<typeof cardInputValidator>; fields?: unknown[]; username?: string; password?: string; proxy?: unknown },
): { fields: FieldValues[]; summary: CardSummary } | null {
  if ((type === "card") !== (args.card !== undefined)) throw invalid("Enter the card's details.");
  if (type !== "card" || args.card === undefined) return null;
  if ((args.fields?.length ?? 0) > 0 || (args.username ?? "") !== "" || (args.password ?? "") !== "" || args.proxy !== undefined) {
    throw invalid("A card has only its own details.");
  }
  const card = normalizeCard(args.card);
  if (card.error !== null) throw invalid(`Check the card: ${card.error}.`);
  return { fields: card.fields as FieldValues[], summary: card.summary as CardSummary };
}
