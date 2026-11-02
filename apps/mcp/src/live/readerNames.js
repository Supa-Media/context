/**
 * Whether a session reads by somebody else's rules, not a member's: a pin reader judged as a guest
 * (`READS_AS_GUEST`), or a Tex guest chat (`READS_AS_CHAT`, or its chat names). The app's live sockets
 * (`treeRoute.js`, `accessRoute.js`) refuse such a reader rather than judge it by the members' rules.
 *
 * A row's token (`@#<noteId>`, `@#<noteId>!edit`) alone is not one: it is a member's own name for a note shared to
 * them by name, or a Tex chat home they are in (2026-11-02). Checking for any `@#` name refused every such member.
 */

import { READS_AS_CHAT, READS_AS_GUEST } from "../privacy/engine.js";

export function readsByOtherRules(session) {
  const groups = session?.grantedGroups;
  const held = groups instanceof Set ? groups : new Set(Array.isArray(groups) ? groups : []);
  const has = (name) => held.has(name);
  if (has(READS_AS_GUEST) || has(READS_AS_CHAT)) return true;
  return Array.isArray(session?.chatNames) && session.chatNames.length > 0;
}
