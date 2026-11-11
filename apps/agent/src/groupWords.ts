/**
 * The fixed commands a chat gives Tex by name ("Tex, stop", "Tex, add everyone
 * here to @name"), read with no model and answered by code in `groupInbox.ts`.
 */

import { sharingWords, type Sharing } from "./reviewSharing";
import { styleWords, type Ask } from "./texStyle";
import type { GroupStyle } from "./decide";

export type Command =
  /** "Tex, stop": when Tex speaks up is off. "Tex, be quiet" is a level (`speaks_up`), Dev2, 2026-11-01. */
  | { kind: "stop" }
  | { kind: "start" }
  | { kind: "speaks_up"; level: GroupStyle }
  | { kind: "invite"; slug: string; role?: "editor" | "member" }
  | { kind: "share_mail"; address: string; query?: string }
  | { kind: "unshare_mail"; address?: string }
  | { kind: "status" }
  | { kind: "settings" }
  /** "Tex, share my chats with the devs", or stop, or ask: the sender's own switch (`reviewSharing.ts`). */
  | { kind: "review_sharing"; sharing: Sharing }
  /** Plain words for a quick pick, an undo or a clear ("Tex, no emoji", "Tex, undo the change"; `texStyle.ts`). */
  | { kind: "style"; ask: Ask };

const NAME = "(?:tex|context)";
/** The name, not "Tex-Mex" or "Texas". */
const WORD = `@?${NAME}(?![\\w-])`;
const STARTS_WITH_NAME = new RegExp(`^\\s*(?:(?:hey|hi|yo|ok|okay)\\s+)?${WORD}`, "i");

/**
 * The words without the quotes a person may type around them ("“Tex stop”"), and without the bidi isolates
 * iMessage wraps a mention in ("@\u2068Tex\u2069"), so a mention reads as the name.
 */
export function unquoted(text: string): string {
  return text.replace(/[\u2066-\u2069]/g, "").trim().replace(/^["“”'‘’`]+/, "").replace(/["“”'‘’`]+$/, "").trim();
}

/**
 * A group command, said to Tex by name ("Tex, stop", "Tex settings"): code's to answer, never the judge's. Whether
 * anything else is for Tex is the one judge's (`textDecide.cjs`; Dev2, 2026-11-11): no word rule here decides that.
 * Its name is required, so nobody's bare "stop" mutes a chat.
 */
export function commandTo(text: string): Command | null {
  return STARTS_WITH_NAME.test(unquoted(text)) ? groupCommand(text) : null;
}

/** Tex's name as a word anywhere, or an @-tag of it ("can Tex tell us what 7 times 8 is?"), never "Texas" or "Tex-Mex". */
const NAMED = new RegExp(`(?<![\\w-])${WORD}`, "i");

/**
 * A privacy gate, not a judgment (security review, 2026-11-11): in a chat Tex is not set up in, or from an SMS,
 * nothing is read, not even by the judge, unless it tags or names Tex (iMessage sends a native mention as the bare
 * name) or replies under one of Tex's own texts. Whether such a message is for Tex is still the judge's.
 */
export function callsTex(text: string, repliesToTex: boolean): boolean {
  return repliesToTex || NAMED.test(unquoted(text));
}

/** "Tex, share my mail from me@work.example here", optionally "matching <a Gmail search>" (`chat-mail.md`). */
const MAILBOX = "(?:my )?(?:work )?(?:mail|email|emails|inbox|gmail)";
const HERE = "(?: (?:here|in here|(?:with|to|for|into) (?:this|the) (?:group )?(?:chat|group)|with everyone here|with us))?";
/** "Add my mail me@work.example to this group" means the same (the Crystal Care chat, 2026-10-29): "my" makes it the inbox, never an invitation. */
const SHARED_BY = `(?:share ${MAILBOX} |(?:add|connect) my (?:(?:work )?(?:mail|email|emails|inbox|gmail) )?)`;
const SHARE_MAIL = new RegExp(`^${SHARED_BY}(?:from |at |in )?([^\\s@]{1,64}@[^\\s@]{1,190})(?: (?:mail|email|inbox|gmail|account))?(?: (?:matching|that matches|filtered by|only) (.{1,300}?))?${HERE}$`);
const UNSHARE_MAIL = new RegExp(`^(?:stop sharing|unshare) ${MAILBOX}(?: (?:from |at |in )?([^\\s@]{1,64}@[^\\s@]{1,190}))?${HERE}$`);

/**
 * The words after Tex's name, when they are one of the group commands. Tex's name is optional here: `commandTo` is
 * what requires it of a message in the chat. ("Tex, use @slug" and a bare workspace name are gone:
 * a chat is bound to no workspace, 2026-10-31.)
 */
export function groupCommand(text: string): Command | null {
  const rest = unquoted(text)
    .replace(new RegExp(`^(?:(?:hey|hi|yo|ok|okay)\\s+)?${WORD}[\\s,:!.-]*`, "i"), "")
    .trim()
    .replace(/[.!]+$/, "")
    .toLowerCase();
  if (/^(?:stop|mute|shush|shh+)$/.test(rest)) return { kind: "stop" };
  if (/^be quiet$/.test(rest)) return { kind: "speaks_up", level: "quiet" };
  if (/^(?:start|unmute|come back)$/.test(rest)) return { kind: "start" };
  if (/^what (?:can you see|do you see|can you read)(?: here)?\??$/.test(rest)) return { kind: "status" };
  const invite = /^(?:add|invite) (?:everyone|everybody|all of us|us all|the group|this chat|this group)(?: (?:here|in here|in this chat|in this group))? (?:to|into) @?([a-z0-9][a-z0-9-]{0,63})(?: as (?:an? )?(editors?|members?))?$/.exec(rest);
  if (invite) return { kind: "invite", slug: invite[1], ...(invite[2] ? { role: invite[2].startsWith("member") ? "member" : "editor" } : {}) };
  if (/^settings\??$/.test(rest)) return { kind: "settings" };
  const ask = styleWords(rest);
  if (ask) return { kind: "style", ask };
  const sharing = sharingWords(rest);
  if (sharing) return { kind: "review_sharing", sharing };
  const shared = SHARE_MAIL.exec(rest);
  if (shared) return { kind: "share_mail", address: shared[1]!, ...(shared[2] ? { query: shared[2] } : {}) };
  const unshared = UNSHARE_MAIL.exec(rest);
  if (unshared) return { kind: "unshare_mail", ...(unshared[1] ? { address: unshared[1] } : {}) };
  return null;
}
