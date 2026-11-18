/**
 * The person's Google Chat, as the bench world's control plane answers for it (`world.mjs`). A conversation whose
 * setting says Tex has Google Chat (`setsFd.mjs` hasChat, `chat: connected`) is connected the way a calendar is: the
 * stub has an account to read from, and a read of a conversation's recent messages is answered by the simulated
 * world (`simWorld.mjs` chatRecent), or by nothing when the run has no simulated world.
 */

/** The account a Chat read answers from when the world has no person's address: the bench's own. */
function benchAccount(person) {
  return `${String(person).toLowerCase().replace(/[^a-z0-9]/g, "") || "person"}@chat.bench.invalid`;
}

/** Connects a control plane's Google Chat stub (`googleChat.mjs`) for one person, and answers its reads from `sim`. */
export function connectChat(route, { person, sim = null }) {
  const flags = route.flags;
  flags.from = sim?.address ?? benchAccount(person);
  flags.recent = sim ? (body) => sim.chatRecent(body) : [];
}
