/**
 * The People tab's words. Pure, so the sentences are checked without
 * mounting anything (`__tests__/adminPeople.test.ts`).
 */

export type PersonRole = "owner" | "editor" | "member";

/** The roles in the words the app's sharing uses everywhere else. */
export function roleLabel(role: PersonRole): string {
  if (role === "owner") return "Owner";
  return role === "editor" ? "Can edit" : "Can read";
}

export type PhoneResult =
  | { status: "saved"; phone?: string }
  | { status: "removed" }
  | { status: "invalid" }
  | { status: "taken"; phone?: string; heldBy?: string }
  | { status: "not_found" };

/** The line shown after Save or Remove; `ok` is false when nothing changed. */
export function phoneSentence(result: PhoneResult): { ok: boolean; text: string } {
  switch (result.status) {
    case "saved":
      return { ok: true, text: `Saved ${result.phone ?? "the phone"}.` };
    case "removed":
      return { ok: true, text: "Phone removed." };
    case "invalid":
      return { ok: false, text: "Type the whole number with its country code, like +1 415 555 0100." };
    case "taken":
      return {
        ok: false,
        text: result.heldBy
          ? `${result.phone ?? "That number"} already belongs to ${result.heldBy}.`
          : `${result.phone ?? "That number"} already belongs to another account.`,
      };
    case "not_found":
      return { ok: false, text: "That account no longer exists." };
  }
}

/** "Joined 9 Oct 2026". */
export function joinedLabel(at: number): string {
  return `Joined ${new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
}
