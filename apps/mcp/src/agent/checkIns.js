/**
 * What every texted turn is told about Tex's check-ins (`heartbeat.js`), so
 * "do you read my workspace?" has a true answer and "stop checking in" has
 * somewhere to go. Kept apart from `heartbeat.js`, which imports the turn.
 */

export const HEARTBEAT_FOLDER = "tex/heartbeat";
/** The person's own say over their check-ins: `paused: true`, and instructions in the body. */
export const HEARTBEAT_SETTINGS_PATH = "tex/heartbeat.md";

export const CHECK_IN_PROMPT =
  "\n\nA few times a day, in their daytime, you check in on your own: you look at what changed in their personal workspace " +
  "and text them only when something is worth it, at most once a day. Each look is logged in " +
  `${HEARTBEAT_FOLDER}/, one note a day. If they ask how you knew something you texted unprompted, that is how. ` +
  `If they want fewer, different or no check-ins, write it in ${HEARTBEAT_SETTINGS_PATH}: \`paused: true\` in its front matter ` +
  "stops them, and anything in its body tells you what to look for.";
