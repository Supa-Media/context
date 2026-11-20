/**
 * gatherTheTurn: once decide has named the texts one answer covers, which
 * waiting texts the turn answers and which it leaves, the same for a 1:1 chat
 * and a group (Dev2's one-door plan, 2026-11-05; drawn in
 * `docs/architecture/tex.md`).
 *
 * The chat says only which texts Tex must answer (`mustAnswer`): in a 1:1
 * every text but a bare thanks or a tapback (`inboxTurn.ts` `pureAck`), in a
 * group a text addressed to Tex. The rule is one:
 *  - the texts decide named, or the newest when it named none, are answered;
 *  - an older text it left out that Tex must answer goes first, on its own,
 *    so answers keep the order texts came in;
 *  - what it left out before the answer is left: a 1:1 drops it, a group keeps it as chat.
 */

export type Gathered<Entry> = { answer: Entry[]; left: Entry[] };

export function gatherTheTurn<Entry>(burst: readonly Entry[], covered: (entry: Entry) => boolean, mustAnswer: (entry: Entry) => boolean): Gathered<Entry> {
  const skipped = burst.findIndex((entry) => !covered(entry));
  const lastCovered = burst.length - 1 - [...burst].reverse().findIndex(covered);
  if (skipped !== -1 && lastCovered < burst.length && skipped < lastCovered && mustAnswer(burst[skipped])) {
    const left = burst[skipped];
    return { answer: burst.slice(0, skipped + 1).filter((entry) => entry === left || covered(entry)), left: [] };
  }
  const chosen = burst.filter(covered);
  // Nothing named: the newest is what woke it.
  const answer = chosen.length > 0 ? chosen : [burst.at(-1)!];
  const last = burst.indexOf(answer.at(-1)!);
  return { answer, left: burst.slice(0, last).filter((entry) => !answer.includes(entry)) };
}
