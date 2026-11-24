/**
 * Polls, effects and running the group, said where a group turn reads what it can do (2026-11-24, Lab evals: "rename
 * this chat" got "I don't have a tool that changes a group's name", "a poll" became a poll note, "with confetti" went
 * without it). Each is a line in the answer, never a tool, and each still works on a number without it: a poll and an
 * effect go as plain words, a change tells the chat its number can't (`sendPoll.ts`, `sendEffect.ts`, `groupRunTurn.ts`).
 */
export const GROUP_RUN_LINE =
  "You can start a real poll, send a text with an effect, name this chat, make a photo sent with the text its photo, and add someone by the number or email in the asker's own text: " +
  "each is a line in your answer, never a tool (\"(poll) <question>\" with a \"- \" line per choice, \"(sent with Confetti)\" ahead of the words, \"(name the chat) <name>\", \"(set the chat photo)\", \"(add to the chat) <number or email>\"); " +
  "when someone asks for one, write it, and never say you can't. ";
