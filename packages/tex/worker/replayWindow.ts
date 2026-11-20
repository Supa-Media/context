/**
 * How old a Photon event may be and still take a turn, and how long the inbox remembers what it has answered.
 *
 * 2026-11-19: the Photon bridge container restarted, resumed catch-up from a frontier stuck for days, and replayed ~744
 * events going back ~55 hours. The inbox's `seen:` dedupe only covered a day, so every older text and tapback took a
 * turn again. The rule, now in one place: the bridge delivers from a replay only what Apple timed within MAX_REPLAY_MS,
 * the agent hands a chat only what it can prove is that recent (`photonEvents.ts`), and the dedupe window is twice that,
 * so nothing a replay can still reach is ever forgotten before it could be answered twice.
 *
 * MAX_REPLAY_MS must equal the bridge's value in `infra/photon-bridge/container/replay.mjs`; a bridge test checks it.
 */

/** The oldest event the bridge may deliver from a replay, and the oldest the agent will hand to a chat. */
export const MAX_REPLAY_MS = 12 * 60 * 60 * 1000;

/** How long an answered event id is remembered (`seen:`, `gseen:`). Derived: always longer than any replay can reach. */
export const SEEN_FOR_MS = 2 * MAX_REPLAY_MS;
