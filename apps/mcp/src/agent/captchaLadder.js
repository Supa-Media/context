/**
 * A CAPTCHA IS THE PERSON'S ONLY AFTER EVERY WAY PAST IT HAS BEEN TRIED (the
 * owner, 2026-10-22: "make sure agents try using those bypasses and other
 * browserbase hacks before handing back").
 *
 * The screenshot Worker already gives Browserbase's own solver time after
 * every run and answers `captcha: "unsolved"` only when one outlasts it
 * (`infra/site-shots/src/captcha.ts`). Then this tries twice more, itself,
 * before the model ever reads the page:
 *
 *   1. the same page again: a new challenge, and the solver another go;
 *   2. a fresh browser (`fresh: true`): a new residential address and
 *      fingerprint, with the person's sign-ins put back from their jar.
 *
 * A captcha that outlasts all three is a fair hand-back (K3 in
 * docs/decisions/texting-assistant/handing-back.md), and only then does the
 * reading tell the model it may hand the browser over. The gateway runs the
 * tries rather than asking the model to, so no prompt has to be obeyed for
 * them to happen.
 */

/** Pages one question may run the tries on: each can take a minute. */
export const MAX_LADDERS_PER_TURN = 2;

/** Said under a reading once a captcha was got past. */
export const clearedLine = (how) =>
  `\n\nA captcha was on this page and ${how} got past it. Carry on yourself; never ask the person to solve a captcha.`;

/** Said under a reading when a captcha outlasted every try. */
export const STUCK_LINE =
  "\n\nA captcha is still on this page after Browserbase's solver, a reload and a fresh browser with a new address each had a go. " +
  "Only now is it the person's: do everything else on the page first, then add a handoff step so they can solve it, and carry on when they text.";

/**
 * One question's tries. `settle(done, run)` takes a run's result (`browse.js`)
 * and the function that runs steps, and answers the result the model should
 * read with the line to put under it.
 */
export function captchaLadder() {
  let ladders = 0;
  let stuck = false;
  // Pages whose captcha already outlasted every try this question: the
  // handoff the model then asks for reads the page again, and that reading
  // must not pay for the tries a second time.
  const outlasted = new Set();
  return {
    async settle(done, run) {
      if (done?.captcha !== "unsolved") return { done, line: "", cleared: false };
      const url = done.reading?.url;
      if (ladders >= MAX_LADDERS_PER_TURN || typeof url !== "string" || outlasted.has(url)) {
        stuck = true;
        return { done, line: STUCK_LINE, cleared: false };
      }
      ladders += 1;
      const tries = [
        [{}, "Browserbase's solver, after a reload,"],
        [{ fresh: true }, "a fresh browser with a new address"],
      ];
      let last = done;
      for (const [options, how] of tries) {
        const again = await run([{ do: "goto", url }], options).catch(() => null);
        if (again === null) continue;
        last = again;
        if (again.captcha !== "unsolved") return { done: again, line: clearedLine(how), cleared: true };
      }
      stuck = true;
      outlasted.add(url);
      if (typeof last.reading?.url === "string") outlasted.add(last.reading.url);
      return { done: last, line: STUCK_LINE, cleared: false };
    },
    /** Whether a captcha this question met outlasted every try. */
    stuck: () => stuck,
  };
}
