/**
 * THE ASKER'S YES TO AN ANSWER HELD FROM A GROUP (privacy rulebook rule 4, Dev2, 2026-11-26).
 *
 * A group answer that carried what Tex read in a workspace someone there can't open is held, and its draft goes to the
 * asker alone (`roomCheck.js`, `privateAside.js` `holdForAsker`); the control plane records the hold with who was in the
 * chat (`apps/convex/functions/groupHolds.ts`). Here, in the asker's own chat with Tex, `share_held` is their yes: on
 * their own words only (the judge every widening uses), it marks the hold shared, and from then on those workspaces may
 * be said in that chat while everyone in it was there when it was held. Anyone new, and it is closed again.
 *
 * Sharing posts nothing by itself: the facts it answers say it is now open there, and the draft reaches the group the
 * way any 1:1 gets something done in one of its groups (`send ask_chat`, do true). Its own chat only, so nobody in the
 * group can open it for the asker. The answer is facts as data, never words for Tex to say.
 */

import { namesOrAnswers } from "./consentContext.js";
import { chatNamed, SHARE_HELD } from "./crossChat.js";

export { SHARE_HELD };

/** The words a yes needs in the turn's own message before the judge is asked. */
const SHARE_WORDS = /\b(yes|yeah|yep|yup|sure|ok(?:ay)?|go ahead|share|send|post|tell|fine|do it|that'?s fine|go for it)\b|👍/i;

function text(words, isError = false) {
  return { content: [{ type: "text", text: words }], ...(isError ? { isError: true } : {}) };
}

const facts = (value, isError = false) => text(JSON.stringify(value), isError);

/**
 * `send share_held` for the person's own chat with Tex, or null on any other turn. `groups` are their group chats
 * (`{ key, name }`); `judge({ words, action })` is the turn's consent judge.
 */
export function heldShareTool({ session, controlPlane, group, groups = null, words = "", offered = "", judge = null }) {
  if (group !== null || typeof controlPlane?.groupShare !== "function" || typeof session?.accessToken !== "string") return null;
  const asked = async (chat) => {
    const said = typeof words === "string" ? words : "";
    if (!namesOrAnswers(SHARE_WORDS, said, offered, typeof judge === "function")) return false;
    if (typeof judge !== "function") return true;
    try {
      return (await judge({ words: said, action: `share ${chat}'s held answer` }))?.allow === true;
    } catch {
      return false;
    }
  };
  return {
    tool: {
      name: SHARE_HELD,
      description:
        "Share with a group chat an answer you held from it (held_from_group), once the person who asked says yes in their own words. " +
        "chat: the group, by its key from held_from_group or its name. It opens what was held there for the people in it then; it posts nothing itself.",
      inputSchema: { type: "object", properties: { chat: { type: "string", description: "The group chat: its key or its name." } }, required: ["chat"] },
    },
    call: async (args) => {
      const named = typeof args?.chat === "string" ? args.chat.trim() : "";
      const to = chatNamed(Array.isArray(groups) ? groups : [], named) ?? (/^[A-Za-z0-9_-]{6,128}$/.test(named) ? { key: named, name: "" } : null);
      if (to === null) return facts({ shared: false, status: "no_such_chat" }, true);
      if (!(await asked(to.name || "the group"))) return facts({ shared: false, status: "not_their_words" }, true);
      const answer = await controlPlane.groupShare(session.accessToken, { groupKey: to.key }).catch(() => null);
      const status = answer?.status ?? "unavailable";
      if (status !== "shared") return facts({ shared: false, status }, true);
      return facts({ shared: true, chat: to.key, ...(to.name ? { name: to.name } : {}), open_there: (answer.slugs ?? []).map((slug) => `@${slug}`), posted: false });
    },
  };
}
