/** What the ask card's page (`TexAskScreen.tsx`) says, apart from the screen so it is tested on its own. */

/** An ask's key, as the card carries it (`packages/tex/worker/cardChats.ts` `askKey`). */
export const ASK_KEY = /^[a-z0-9]{1,8}$/;

export type AskState = { kind: "asking" } | { kind: "sending"; yes: boolean } | { kind: "done"; yes: boolean } | { kind: "failed"; error: string };

/** The line under the heading: where the answer went, or why it did not. */
export function askAnswerLine(state: AskState, noOwnWorkspace: boolean): string {
  if (noOwnWorkspace) return "Sign in with the account you text Tex from, or reply to Tex in Messages.";
  switch (state.kind) {
    case "asking":
      return "Your answer goes to your chat with Tex, the same as replying yes or no.";
    case "sending":
      return "Sending…";
    case "done":
      return state.yes ? "Tex has it and will carry on in Messages." : "Tex won't go ahead. It will say so in Messages.";
    case "failed":
      if (state.error === "stale") return "Tex has asked something newer since this card. Answer that one in Messages.";
      if (state.error === "no_ask") return "Nothing is waiting on this any more. Reply to Tex in Messages if you still need it.";
      return "That didn't go through. Reply yes or no to Tex in Messages instead.";
  }
}
