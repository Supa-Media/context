/**
 * What every texted turn is told about Tex's check-ins (`heartbeat.js`), so
 * "do you read my workspace?" has a true answer and "stop checking in" has
 * somewhere to go, and about the pings their other agents ask it to text
 * (`attention.js`), so "stop texting me about CI" changes what reaches them.
 * Kept apart from `heartbeat.js`, which imports the turn.
 */

export const HEARTBEAT_FOLDER = "tex/heartbeat";
/** The person's own say over their check-ins: `paused: true`, and instructions in the body. */
export const HEARTBEAT_SETTINGS_PATH = "tex/heartbeat.md";

export const CHECK_IN_PROMPT =
  "\n\nA few times a day you check their workspace on your own and text them only if something is worth it; " +
  `each look is logged in ${HEARTBEAT_FOLDER}/. To change or stop that, write it in ${HEARTBEAT_SETTINGS_PATH} ` +
  "(`paused: true` in its front matter stops it); a word muted in tex/attention.md (below) silences check-ins too.";

/** Pings their agents asked Tex to text (`attention.js`): each logged here, a day to a note. */
export const ATTENTION_FOLDER = "tex/attention";
/** The person's say over them: `tolerance`, `mute` and `paused` in its front matter. Tex keeps it from their answers. */
export const ATTENTION_SETTINGS_PATH = "tex/attention.md";

export const ATTENTION_PROMPT =
  "\n\nTheir other agents (Claude Code, Codex and the like) can ask you to text them when something needs them; " +
  `each ping is logged in ${ATTENTION_FOLDER}/ and the ones you texted are in this conversation. How much they want to hear is ` +
  `${ATTENTION_SETTINGS_PATH}, in its front matter: \`tolerance: emergencies\` (only those), \`strict\` (the default: emergencies and ` +
  "what they asked to be told) or `relaxed` (anything useful), `mute: [words]` that never interrupt them, `paused: true`. " +
  "When they say a ping wasn't worth it, want fewer or more, or never want pings about something, change that note to match, " +
  "keep a line in its body saying why, and tell them what you changed. A text about what you text them (\"no more deploy texts\", " +
  "\"let me know about new signups too\") means these pings even with no ping in sight: wanting a kind of update too is `relaxed`, " +
  "and muting one changes only `mute`. Make the change without asking first, and say what changed in a few words " +
  "(\"Muted deploys.\", \"You'll get the FYIs too.\"), never just \"Will do.\"";
