/**
 * ASK YOUR PERSONAL TEX: A GROUP CHAT'S TEX ASKS THE TAGGER'S OWN TEX FOR WHO THEY ARE.
 *
 * Decided by the owner (Dev2), 2026-11-12. Asked in a group chat to fill a venue's booking form, Tex asked him for his
 * own name, email and phone, which his own Tex has known since 2026-10-23 (`identity.js`): a group turn is told nobody's
 * account facts, because several people read its answers. "It's annoying that it doesn't know basic things about me";
 * asked how, he chose for the group's Tex to ask his personal Tex, and set the rule:
 *
 *  - **Their own ask needs no yes.** When the person who tagged Tex is the one it asks about, Tex texts the chat a line
 *    that it is asking their personal Tex, and asks. The control plane answers only on the token minted for that
 *    person's own tag (`/gateway/agent/identity` with `asker`, `apps/convex/functions/lib/texIdentity/identity.ts`
 *    `askerIdentityHandler`): never a job's run token, never an invited person's tag (which acts through someone else),
 *    and never anyone but the tagger.
 *  - **Anyone else's waits for their 👍.** `as` naming someone else here offers the ask to them (`offerFor.js`): the
 *    chat is shown what Tex would ask their personal Tex for, and only their 👍 or yes, a tag of their own, lets the
 *    same call run, as theirs.
 *
 * What comes back is their account's facts (name, phone, emails), for the form or sign-in they asked for. The model is
 * told to type them where they're needed and not to repeat a phone number or email into the chat. About me notes and
 * anything else in their personal workspace stay out of a group turn.
 */

import { readIdentity } from "./identity.js";
import { offerTarget } from "../tools/offerFor.js";

export const ASK_PERSONAL_TEX = "ask_personal_tex";

/** The `send` action it is shown as (`sixTools.js`). */
export const PERSONAL_TEX_SEND_ACTIONS = {
  ask_personal_tex: {
    tool: ASK_PERSONAL_TEX,
    summary: "In a group chat, get the name, phone and email of whoever tagged you from their personal Tex, for a form or sign-in; for anyone else here, pass as and they OK it first.",
  },
};

const MAX_WHAT = 200;

function text(words, isError = false) {
  return { content: [{ type: "text", text: words }], ...(isError ? { isError: true } : {}) };
}

/** What they want from it, one short line. */
function whatOf(args) {
  const what = typeof args?.what === "string" ? args.what.replace(/\s+/g, " ").trim().slice(0, MAX_WHAT) : "";
  return what || "their name, phone number and email";
}

/** Their account's facts as the tool answers them: one line each, the phone they text from first. */
function factsLines(identity) {
  return [
    ...(identity.name ? [`Name: ${identity.name}`] : []),
    ...(identity.phones.length > 0 ? [`Phone: ${identity.phones.join(", ")} (the first is the one they text from)`] : []),
    ...(identity.emails.length > 0 ? [`Email: ${identity.emails.join(", ")}`] : []),
    ...(identity.handle ? [`Context handle: @${identity.handle}`] : []),
  ];
}

/**
 * The tool for one group turn, or null when the turn isn't a group chat's or can't ask: `group` is the turn's
 * (`groupTurn.js`), `ledger` its egress ledger (an offer is kept there for the reply), `say` texts the chat a line of
 * the gateway's own now (`progress.js` `say`), and `asker()` asks the control plane for the tagger's facts.
 */
export function personalTexTool({ group, ledger, say = null, asker }) {
  if (group === null || group === undefined || group.guestChat === true || typeof asker !== "function") return null;
  return {
    tool: {
      name: ASK_PERSONAL_TEX,
      description:
        "Ask a person's own personal Tex for their name, phone number and email, when a form, booking or sign-in they asked for needs them: " +
        "never ask them in the chat for these. With no as, it asks the personal Tex of whoever tagged you, at once. " +
        "For somebody else here, pass as with their handle: they are asked first in the chat, and only their 👍 or yes lets you ask. " +
        "what: what you need, in a few words (\"name, email and phone for the Puttery form\").",
      inputSchema: {
        type: "object",
        properties: {
          what: { type: "string", description: "What you need from their personal Tex, in a few words." },
          as: { type: "string", description: "The handle of someone else in this chat, whose personal Tex you'd ask once they OK it." },
        },
      },
    },
    call: async (args) => {
      const what = whatOf(args);
      const target = offerTarget({ egress: { group } }, args ?? {}, "ask");
      if (target?.error) return text(target.error, true);
      if (target !== null) return offer(ledger, target.who, what);
      if (group.guestTagger === true || !group.from) {
        return text("Not asked: whoever tagged you isn't on Context, so there is no personal Tex to ask. Ask them in the chat for what the form needs.", true);
      }
      const told = typeof say === "function" ? await Promise.resolve(say(`Asking your personal Tex for ${what}.`)).catch(() => false) : false;
      let identity = null;
      try {
        identity = readIdentity(await asker());
      } catch {
        identity = null;
      }
      if (identity === null) {
        return text(
          "Their personal Tex didn't answer, so nothing came back. Ask them in one short line for only what the form still needs; never say you looked in their notes.",
          true,
        );
      }
      const lines = factsLines(identity);
      return text(
        [
          `From @${group.from}'s personal Tex, their own account (as sure as anything they told you):`,
          ...lines,
          "Type these into the form or sign-in they asked for; never ask them for these again. " +
            "Don't write their phone number or email into the chat unless they asked to see it there.",
          told ? "The chat was already told you were asking their personal Tex." : "Say in your answer, in a few words, that you got these from their personal Tex.",
        ].join("\n"),
      );
    },
  };
}

/** Somebody else's personal Tex: offered to them, never asked until their own 👍 or yes (`offerFor.js`). */
function offer(ledger, who, what) {
  if (ledger === null || ledger === undefined) return text("Not asked: someone else's personal Tex is asked only in a group chat, on their yes.", true);
  if (ledger.offered) return text(`Not offered: this answer already offers one thing to @${ledger.offered.who}. Offer this after they answer.`, true);
  if (Array.isArray(ledger.asked) && ledger.asked.length > 0) return text("Not offered: this answer already asks for a yes. Offer this after it is answered.", true);
  ledger.offered = { who, tool: ASK_PERSONAL_TEX, detail: what };
  return text(
    `Not asked yet, and nothing failed: right after your answer @${who} is asked here whether you may ask their personal Tex for ${what}, ` +
      `and only their 👍 or yes lets you. Don't repeat that question; say in a line what you need it for. When @${who} says yes or 👍s it, ` +
      "make this same call without as.",
  );
}
