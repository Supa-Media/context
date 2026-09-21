/**
 * One control, pressed faster than the server answers.
 *
 * ## The failure this is for
 *
 * The visibility control has three positions and moving between two of them is
 * not one write: closing a note is *revoke the link, then narrow the manifest*,
 * and opening one is the reverse. `stepsTo` settles the order and says why it
 * matters — carrying on past a failed revoke leaves a note the owner believes
 * is private with a live link on it.
 *
 * That argument is about **one** sequence. Nothing was stopping a second press
 * from starting while the first was still running, and rapid clicking between
 * the positions is exactly what somebody does to a control with three of them.
 * Two sequences then interleave: each computed its steps from the position the
 * screen was showing when it was pressed, and the screen was showing a position
 * the other sequence was in the middle of changing. The outcome is whichever
 * step happened to land last, which is not what anybody pressed.
 *
 * ## Serialize, and let the last press win
 *
 * Both halves are needed and they are different halves.
 *
 * **Serializing** is what stops two sequences interleaving. Without it the
 * order `stepsTo` settles is settled within each sequence and meaningless
 * between them.
 *
 * **The last press winning** is what makes serializing usable. A queue alone
 * would faithfully replay every press in a burst — private, team, link, team,
 * private — costing a share mint and a revoke nobody wanted and ending, slowly,
 * where the person started. So a press that has been superseded before it
 * starts never runs, and one superseded *while* it runs stops at its next step:
 * the press that replaced it computes from the live state and finishes the job.
 *
 * ## What is carried between presses in a burst
 *
 * A sequence's own writes have landed by the time the next one starts, but the
 * subscription that tells the screen about them has not necessarily ticked. So
 * a task may hand its successor the position it actually left things in, and
 * `carried` is that. It is deliberately forgotten the moment a burst drains —
 * the newest task finishing with nothing behind it — because past that point
 * the live state is the better answer and somebody else's change to the same
 * note is the more likely difference.
 *
 * ## Why it is a module rather than three refs in the hook
 *
 * `shareViewer.test.ts` records the finding this is written against: across a
 * sabotage sweep of this codebase, every guard expressed as a pure module was
 * held and every guard expressed inside a component was not. Sequencing is
 * exactly the kind of thing that rots inside a `useCallback`, and it cannot be
 * driven from a test at all while it lives there.
 */

/** What a task is told about its own press. */
export interface PressContext<T> {
  /**
   * Is this still the newest press for this key?
   *
   * Checked before the task starts and between its steps. A task that ignores
   * it is not wrong, only slower — it costs the work its successor is about to
   * repeat — but the steps a widening runs are a share mint and a manifest
   * write, and doing those for a position nobody is still asking for is the
   * expense this exists to avoid.
   */
  live: () => boolean;
  /**
   * What the previous press in this burst left behind, if it said.
   *
   * `undefined` when the burst is starting, when the previous task failed, or
   * when it chose not to say — all three meaning "read the live state".
   */
  carried: T | undefined;
}

export interface PressQueue<T> {
  /**
   * Queue one press. Returns when this press has finished or been dropped,
   * which is what a test awaits; callers in the console ignore it.
   */
  run(key: string, task: (context: PressContext<T>) => Promise<T | undefined>): Promise<void>;
}

interface KeyState<T> {
  token: number;
  chain: Promise<void>;
  carried: T | undefined;
}

export function createPressQueue<T>(): PressQueue<T> {
  const keys = new Map<string, KeyState<T>>();

  return {
    run(key, task) {
      const held = keys.get(key);
      const token = (held?.token ?? 0) + 1;
      const previous = held?.chain ?? Promise.resolve();
      const state: KeyState<T> = {
        token,
        chain: previous,
        carried: held?.carried,
      };
      keys.set(key, state);

      const live = () => keys.get(key)?.token === token;

      const chain = previous.then(async () => {
        // Superseded while waiting: the press that replaced this one is behind
        // it in the same chain and will do the whole job from the live state.
        if (!live()) return;
        let result: T | undefined;
        try {
          result = await task({ live, carried: keys.get(key)?.carried });
        } catch {
          // A task that threw left the position unknown, which is exactly what
          // "no carried value" means. The notice is the task's own business.
          result = undefined;
        }
        const now = keys.get(key);
        if (now === undefined) return;
        if (now.token === token) {
          // Nothing else is waiting, so the burst is over and the live state
          // is the better answer from here on.
          keys.delete(key);
          return;
        }
        now.carried = result;
      });

      // Held so the next press for this key waits behind this one. Read off
      // the map rather than off `state`, because a press that arrived while
      // this was being set up owns the entry now and this one must extend
      // *its* chain rather than replace it.
      const current = keys.get(key);
      if (current !== undefined) current.chain = chain;
      return chain;
    },
  };
}
