/**
 * The words a group message is read by, with no model: whether it is meant
 * for Tex, and whether it is one of the fixed commands a chat gives it
 * ("Tex use @name", "Tex, stop"). Answered in `groupInbox.ts`.
 */

import { styleWords, type TexStyle } from "./texStyle";

export type Command =
  | { kind: "stop" }
  | { kind: "start" }
  | { kind: "use"; slug: string }
  | { kind: "invite"; slug: string; role?: "editor" | "member" }
  | { kind: "share_mail"; address: string; query?: string }
  | { kind: "unshare_mail"; address?: string }
  | { kind: "status" }
  | { kind: "settings" }
  /** Plain words for one of Tex's settings ("Tex, less emoji", "Tex, humor 60%"; `texStyle.ts`). */
  | { kind: "style"; patch: TexStyle };

const NAME = "(?:tex|context)";
/** The name, not "Tex-Mex" or "Texas". */
const WORD = `@?${NAME}(?![\\w-])`;
/** Words a message to Tex starts with after its name, unpunctuated ("Tex what's on"), where "Tex got that wrong" is about it. */
const ASKING =
  "(?:what|what's|whats|who|who's|when|when's|where|where's|why|how|which|can|could|would|will|is|are|do|does|did|should|please|pls|" +
  "find|check|make|add|save|remember|note|tell|show|look|search|use|stop|start|write|help|list|summarize|summarise|remind|give|get|pull|read|share|unshare)\\b";
/** "Tex ^ do this", "Tex ↑": the message above is the ask. */
const POINTS_UP = "(?:\\^+|↑|⬆️?|☝️?|👆)";
/*
  Any other word after the name is an ask too ("Tex turn this guy into a cat",
  2026-10-23, went unanswered because "turn" was not on the list above),
  unless it reads as talking about Tex: a past or third-person verb, or a word
  people use about it ("Tex got that wrong lol", "Tex was down", "Tex sucks").
*/
const ABOUT = "(?:was|were|got|gets|has|had|have|said|says|just|keeps|kept|always|never|really|seems|thinks|lol|lmao|haha|too|again|isn't|wasn't|can't|won't|didn't|doesn't|[a-z]+ed|[a-z]+s)\\b";
const OPENS = new RegExp(
  `^\\s*(?:(?:(?:hey|hi|yo|ok|okay)\\s+${WORD})|(?:${WORD}(?:\\s*[,:;!?.-]|\\s*$|\\s*${POINTS_UP}|\\s+${ASKING}|\\s+(?!${ABOUT})[a-z])))`,
  "i",
);
const CLOSES = new RegExp(`(?:^|[\\s,])${WORD}[\\s?!.]*$`, "i");
const NAMED = new RegExp(`(?:^|[^\\w-])${WORD}`, "i");
/** A reply to Tex that needs no answer. */
const NOTHING_TO_SAY = /^(?:thanks|thank you|thx|ty|ok|okay|cool|nice|lol|haha|got it|great|perfect)[\s.!]*$/i;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;
/** A workspace slug on its own, with or without its `@`. */
const BARE_NAME = /^@?([a-z0-9][a-z0-9-]{0,63})$/;

/**
 * Whether a group message is meant for Tex. Read from the words alone, with
 * no model: its name opening or closing it, its name in a question, or an
 * inline reply to Tex that says more than thanks.
 */
export function addressesTex(text: string, repliesToTex: boolean): boolean {
  const words = unquoted(text);
  if (words === "") return false;
  if (OPENS.test(words) || CLOSES.test(words)) return true;
  if (NAMED.test(words) && /\?\s*$/.test(words)) return true;
  return repliesToTex && !NOTHING_TO_SAY.test(words) && !EMOJI_ONLY.test(words);
}

/** The words without the quotes a person may type around them ("“Tex use @supa”"). */
export function unquoted(text: string): string {
  return text.trim().replace(/^["“”'‘’`]+/, "").replace(/["“”'‘’`]+$/, "").trim();
}

/** "Tex, share my mail from me@work.example here", optionally "matching <a Gmail search>" (`chat-mail.md`). */
const MAILBOX = "(?:my )?(?:work )?(?:mail|email|emails|inbox|gmail)";
const HERE = "(?: (?:here|in here|(?:with|to|for|into) (?:this|the) (?:group )?(?:chat|group)|with everyone here|with us))?";
/** "Add my mail me@work.example to this group" means the same (the Crystal Care chat, 2026-10-29): "my" makes it the inbox, never an invitation. */
const SHARED_BY = `(?:share ${MAILBOX} |(?:add|connect) my (?:(?:work )?(?:mail|email|emails|inbox|gmail) )?)`;
const SHARE_MAIL = new RegExp(`^${SHARED_BY}(?:from |at |in )?([^\\s@]{1,64}@[^\\s@]{1,190})(?: (?:mail|email|inbox|gmail|account))?(?: (?:matching|that matches|filtered by|only) (.{1,300}?))?${HERE}$`);
const UNSHARE_MAIL = new RegExp(`^(?:stop sharing|unshare) ${MAILBOX}(?: (?:from |at |in )?([^\\s@]{1,64}@[^\\s@]{1,190}))?${HERE}$`);

/**
 * The words after Tex's name, when they are one of the group commands. While
 * the chat is picking a workspace (`choices`), one of the names it was offered
 * on its own ("supa", "@supa", "Tex supa") picks it.
 *
 * Tex's name is optional here because the caller has already decided the
 * message is for Tex (`acceptGroup`). An unaddressed message reaches this
 * only through `offeredName` below, which is narrower on purpose.
 */
export function groupCommand(text: string, choices: readonly string[] = []): Command | null {
  const rest = unquoted(text)
    .replace(new RegExp(`^(?:(?:hey|hi|yo|ok|okay)\\s+)?${WORD}[\\s,:!.-]*`, "i"), "")
    .trim()
    .replace(/[.!]+$/, "")
    .toLowerCase();
  if (/^(?:stop|be quiet|mute|shush|shh+)$/.test(rest)) return { kind: "stop" };
  if (/^(?:start|unmute|come back)$/.test(rest)) return { kind: "start" };
  if (/^what (?:can you see|do you see|can you read)(?: here)?\??$/.test(rest)) return { kind: "status" };
  const invite = /^(?:add|invite) (?:everyone|everybody|all of us|us all|the group|this chat|this group)(?: (?:here|in here|in this chat|in this group))? (?:to|into) @?([a-z0-9][a-z0-9-]{0,63})(?: as (?:an? )?(editors?|members?))?$/.exec(rest);
  if (invite) return { kind: "invite", slug: invite[1], ...(invite[2] ? { role: invite[2].startsWith("member") ? "member" : "editor" } : {}) };
  if (/^settings\??$/.test(rest)) return { kind: "settings" };
  const patch = styleWords(rest);
  if (patch) return { kind: "style", patch };
  const shared = SHARE_MAIL.exec(rest);
  if (shared) return { kind: "share_mail", address: shared[1]!, ...(shared[2] ? { query: shared[2] } : {}) };
  const unshared = UNSHARE_MAIL.exec(rest);
  if (unshared) return { kind: "unshare_mail", ...(unshared[1] ? { address: unshared[1] } : {}) };
  const use = /^use @?([a-z0-9][a-z0-9-]{0,63})$/.exec(rest);
  if (use) return { kind: "use", slug: use[1] };
  const named = BARE_NAME.exec(rest);
  return named && choices.includes(named[1]) ? { kind: "use", slug: named[1] } : null;
}

/**
 * One of the names Tex just offered, said on its own — the only words it
 * answers without being addressed, and only while that question is open.
 *
 * `groupCommand` takes Tex's name as optional, which is right once a message
 * is known to be for Tex and wrong as the way in: it would make a bare "stop"
 * or "start" from a conversation between two other people mute or unmute Tex.
 * Those words are chat, and chat is what `keepChatLine` is for.
 */
export function offeredName(text: string, choices: readonly string[]): string | null {
  if (choices.length === 0) return null;
  const named = BARE_NAME.exec(unquoted(text).replace(/[.!]+$/, "").trim().toLowerCase());
  return named !== null && choices.includes(named[1]) ? named[1] : null;
}
