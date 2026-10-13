/**
 * Words for the roster's Tex access switches (`./TexAccess`).
 *
 * Linq's free shared line forwards a text only from a number on its contact
 * list, twenty at most, so the switches have to say how many slots are used
 * and why a twenty-first was refused.
 */

export type TexChange =
  | { status: "added"; phone: string }
  | { status: "removed"; phone: string }
  | { status: "invalid" }
  | { status: "already"; phone: string }
  | { status: "absent"; phone: string }
  | { status: "full"; cap: number }
  | { status: "error"; error: string };

/** "12 of 20 used · 8 free", or that the list is full. */
export function slotsLine(used: number, cap: number): string {
  const free = Math.max(0, cap - used);
  if (free === 0) return `All ${cap} used. Remove someone to make room.`;
  return `${used} of ${cap} used · ${free} free`;
}

/** What happened, or why nothing did. `null` when the list itself shows it. */
export function changeSentence(result: TexChange): { text: string; error: boolean } {
  switch (result.status) {
    case "added":
      return { text: `${result.phone} can text Tex now. They have to text Tex first.`, error: false };
    case "removed":
      return { text: `${result.phone} was removed. Its slot is free.`, error: false };
    case "invalid":
      return { text: "That isn't a phone number. Include the country code, like +1 555 555 0100.", error: true };
    case "already":
      return { text: `${result.phone} is already on the list.`, error: true };
    case "absent":
      return { text: `${result.phone} wasn't on the list.`, error: true };
    case "full":
      return { text: `All ${result.cap} slots are used. Remove someone first.`, error: true };
    case "error":
      return { text: result.error, error: true };
  }
}
