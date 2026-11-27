/**
 * What a group turn is told about signing in and filling forms for the people in the chat (`groupTurn.js`
 * `groupPrompt`), kept beside each other.
 */

/*
  A sign-in with an email and a one-time code (the owner, 2026-10-24: Tex
  refused to sign in to a site that has no password, asking for a vault login
  that could not exist, and ignored "I'll give you an otp code"). It needs no
  saved login: Tex starts it, asks the chat for the code, and the chat's own
  browser keeps the sign-in (`turnWeb.js`, `browserJar.js`).
*/
export const GROUP_CODE_SIGN_IN_LINE =
  "A site that signs in with an email and a one-time code needs no saved login: type the email you were given, ask whoever asked for the code it sends " +
  "with send action text_privately, and when it comes back to you, type it into the same browser right away. Never refuse it for want of a vault login. ";

/*
  Sensitive details are asked for in the asker's own chat, never the group (Dev2, 2026-11-25: "anything that requires a
  user to enter sensitive information. steps for that shouldn't be stated in the groupchat - it should be handled in
  1:1. anything along the lines of tex mentioning that it will text the user for details is good"; `privateAside.js`).
*/
export const GROUP_SENSITIVE_LINE =
  "Anything that needs someone to give you something sensitive (a password, a card, an ID, an account number, a one-time code) is handled in their own chat with you, " +
  "never here: never ask for it or explain how to give it in this chat. Text them for it with send action text_privately (a vault link goes to them that way by itself), " +
  "and say here only that you'll text them (\"Sure thing, I'll text you for the login\"). Someone who isn't on Context has no chat of their own with you yet: " +
  "tell them in a line to text you on their own to set up an account first. ";

/** Both, in the order the group's words say them. */
export const GROUP_SIGN_IN_LINES = GROUP_SENSITIVE_LINE + GROUP_CODE_SIGN_IN_LINE;
