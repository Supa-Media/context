/** Which modules a step set to `freeze: "summary"` keeps for the day (`frozenModules.js`), apart so `turnPrompt.js` imports no store code. */

/** The modules frozen for the day, by the names the prompt's manifest gives them (`turnPrompt.js`); measured 2–10% of texts changing one (cache audit, 2026-11-20). */
export const FROZEN_MODULES = Object.freeze(["context/thread/group", "context/thread/learned", "context/web", "context/progress", "context/aboutMe", "context/voice", "context/workspaces", "context/groups", "context/devShare", "context/mail"]);

/** What each frozen module is called in the note after the history. */
export const FROZEN_NAMES = Object.freeze({
  "context/thread/group": "This group chat (its people, rules and playbook)",
  "context/thread/learned": "The skills you have learned",
  "context/web": "The web",
  "context/progress": "How much to tell them as you go",
  "context/aboutMe": "About them",
  "context/voice": "How they talk",
  "context/workspaces": "Their workspaces",
  "context/groups": "Their group chats",
  "context/devShare": "Sharing with the developers",
  "context/mail": "Their mailboxes",
});
