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

/** What a prompt tells the model to do when nothing should be texted. */
export const SAY_NOTHING = `send { action: "${SAY_NOTHING_TOOL}" }`;

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
