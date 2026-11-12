/**
 * What a group turn is told about signing in and filling forms for the people in the chat (`groupTurn.js`
 * `groupPrompt`), kept beside each other.
 */

import { PERSONAL_TEX_LINE } from "./askPersonalTex.js";

/*
  A sign-in with an email and a one-time code (the owner, 2026-10-24: Tex
  refused to sign in to a site that has no password, asking for a vault login
  that could not exist, and ignored "I'll give you an otp code"). It needs no
  saved login: Tex starts it, asks the chat for the code, and the chat's own
  browser keeps the sign-in (`turnWeb.js`, `browserJar.js`).
*/
export const GROUP_CODE_SIGN_IN_LINE =
  "A site that signs in with an email and a one-time code needs no saved login: type the email you were given, ask for the code it sends, " +
  "and when someone in the chat texts it, type it into the same browser right away. Never refuse it for want of a vault login. ";

/** Both, in the order the group's words say them. */
export const GROUP_SIGN_IN_LINES = GROUP_CODE_SIGN_IN_LINE + PERSONAL_TEX_LINE;
