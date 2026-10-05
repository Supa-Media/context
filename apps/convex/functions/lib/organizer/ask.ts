/**
 * The sweep's asking loop: every work item to the model, a few at a time, and
 * if nothing comes back, why.
 *
 * Shared by the sweep (`functions/organizer.ts`) and the organization score
 * (`__tests__/organizerEval`), so the score measures the loop that runs.
 */

import type { JevRefusal } from "../jev/meter";
import type { JevAnswers, JevRequest } from "../jev/client";

/** Why a sweep with something to ask got no answers. Stored on the sweep; never a path. */
export type SweepWhy = JevRefusal | "unconfigured" | "no_answers" | "error";

/**
 * Failures in a row, with nothing answered yet, after which the service is
 * taken to be down. Failed calls count toward the day's cap, so asking all
 * hundred questions of a dead service would also spend the next sweep.
 */
export const DEAD_AFTER = 8;

interface Asker {
  readonly remaining: number;
  decide(request: JevRequest): Promise<JevAnswers | null>;
}

export async function askEach<T extends { request: JevRequest }>(
  jev: Asker | null,
  refusal: SweepWhy | null,
  items: readonly T[],
  options: { concurrency: number; onAnswer: (item: T, answers: JevAnswers) => void; onRead?: (read: number) => Promise<void> },
): Promise<{ read: number; answered: number; why: SweepWhy | null }> {
  if (items.length === 0) return { read: 0, answered: 0, why: null };
  if (!jev) return { read: 0, answered: 0, why: refusal ?? "unconfigured" };
  let read = 0;
  let answered = 0;
  let next = 0;
  let stop: SweepWhy | null = null;
  const lane = async () => {
    while (next < items.length && stop === null) {
      if (jev.remaining <= 0) {
        stop = "daily_cap";
        break;
      }
      const item = items[next++] as T;
      const answers = await jev.decide(item.request);
      read += 1;
      if (answers) {
        answered += 1;
        options.onAnswer(item, answers);
      } else if (answered === 0 && read >= DEAD_AFTER) {
        stop = "no_answers";
      }
      if (options.onRead && read % 10 === 0) await options.onRead(read);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, items.length) }, lane));
  if (answered > 0) return { read, answered, why: null };
  return { read, answered, why: stop ?? "no_answers" };
}
