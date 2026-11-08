/**
 * SAY NOTHING: HOW TEX CHOOSES SILENCE (Dev2, 2026-11-05: "why do we need to
 * send 'SKIP' lol, why not simply do nothing ... SKIP can lead to all sorts of
 * bugs down the line").
 *
 * A turn cannot end on no words: an empty answer is what a broken or cut-off
 * round looks like, so code sends it back (`replyChecks.js`). Tex used to say
 * "nothing to text" by answering the word SKIP, and that word then had to be
 * caught everywhere a reply goes: the reply judges sent one back as if it
 * were a text (Tex Devs, 2026-11-05 18:22), and it once stood as Tex's reply
 * in the history (2026-10-31). Now it calls `say_nothing`, which ends the turn
 * at once, before any judge reads it, and the turn hands on the same quiet
 * answer every reader of a routine, a check-in, a report or a chat already
 * knows (`QUIET_WORD`, `checkInGuards.js`). The model never types it; a stray
 * SKIP in words is still never texted (`isControlWord`, `saysQuiet`).
 */

export const SAY_NOTHING_TOOL = "say_nothing";

/**
 * How a prompt names a call: in words, never written as code. A prompt that
 * showed `send { action: "say_nothing" }` was copied word for word into a
 * group's text (2026-11-06 20:01 UTC, Dev2: "how did this get past??").
 */
export function sendCall(action, args = "") {
  return `call send with action ${action}${args ? ` (args: ${args})` : ""}`;
}

/** What a prompt tells the model to do when nothing should be texted. */
export const SAY_NOTHING = sendCall(SAY_NOTHING_TOOL);

export const SAY_NOTHING_DEFINITION = {
  name: SAY_NOTHING_TOOL,
  description:
    "Text nothing this time and end your turn: no message is sent. Use it only when your instructions say silence fits " +
    "(nothing new to tell them, a message meant for someone else). Never write a word like SKIP instead.",
  inputSchema: {
    type: "object",
    properties: { why: { type: "string", description: "In a few words, why nothing is worth texting. Kept in the history, never sent." } },
  },
};

/** `runTurn`'s local tool: answered here, never by the MCP. */
export const sayNothingLocal = {
  tool: SAY_NOTHING_DEFINITION,
  call: async () => ({ content: [{ type: "text", text: "Nothing will be texted. Your turn ends here." }] }),
};

/**
 * The answer a turn that called it hands on: the quiet word its readers already treat as nothing to send
 * (`QUIET_WORD` in `checkInGuards.js`, written out because that module reaches back to `turn.js`; a test holds them equal).
 */
export const SAID_NOTHING = "SKIP";

/**
 * TYPED CALLS: a reply that is only a call written out as text, never a text to
 * anyone. `send { action: "say_nothing" }`, `{ "action": "background", ... }`,
 * the same in a code fence, or a bare `say_nothing`. Answers the action's name,
 * or null for anything a person could mean as words.
 */
const QUOTE = `["'\u201c\u201d\u2018\u2019]?`;
const TYPED_ACTION = new RegExp(`^\\{[\\s\\S]*?${QUOTE}action${QUOTE}\\s*:\\s*${QUOTE}([a-z][a-z0-9_]{1,40})${QUOTE}[\\s\\S]*\\}$`);
export function typedCallOf(text) {
  let said = String(text ?? "").trim();
  if (said === "" || said.length > 2_000) return null;
  said = said.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  if (/^\W*say_nothing\W*$/.test(said)) return SAY_NOTHING_TOOL;
  said = said.replace(/^(?:send|call)\s*(?:\(\s*)?/i, "").replace(/\s*\)\s*$/, "").trim();
  const match = TYPED_ACTION.exec(said);
  return match ? match[1] : null;
}

/** Said to the model when its reply was a call typed as text: make it, never text it. */
export function typedCallNotice(action) {
  return `(Not sent: your reply was the ${action} call written out as text, and they would have seen it as a text. Make the call itself with the send tool, or write the words you mean to text them.)`;
}

/** `runTurn`'s `endsTurn` with silence added: a `say_nothing` call settles the turn with nothing to text, before any judge reads it. */
export function withSayNothing(endsTurn) {
  return (name, args) => (name === SAY_NOTHING_TOOL ? SAID_NOTHING : typeof endsTurn === "function" ? endsTurn(name, args) : null);
}
