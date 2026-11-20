/**
 * WHEN A SITE BLOCKS BROWSERBASE, AND ONLY THEN, TEX MAY TRY BROWSER USE.
 *
 * The gateway decides. The screenshot Worker never starts that browser on
 * its own. The flag is `browsers.browserUseFallback` in texConfig, off unless
 * it says on. Staging sets `BROWSER_USE_FALLBACK=on` on the gateway only, so
 * production stays off while the Lab measures the block rate.
 *
 * A 403 from Browserbase itself (the Verified tier this plan does not have,
 * billing 402, capacity 503) is not a site block. Neither is a generic error.
 */

import { TEX_CONFIG } from "./texConfig.js";

export const BROWSER_USE_CAPS = Object.freeze({
  jobMinutes: 15,
  dayUsd: 1,
  monthUsd: 5,
  minBalanceUsd: 0.5,
});

/** `"on"` or `"off"`. A staging var turns it on without changing the committed config production reads. */
export function browserUseFlag(config = TEX_CONFIG, env = {}) {
  if (env?.BROWSER_USE_FALLBACK === "on") return "on";
  return config?.browsers?.browserUseFallback === "on" ? "on" : "off";
}

/** Caps the gateway sends. The Worker clamps them again and will not go above these. */
export function browserUseCaps(config = TEX_CONFIG) {
  const browsers = config?.browsers ?? {};
  const minutes = browsers.jobMinutes;
  const day = browsers.dayUsd;
  const month = browsers.monthUsd;
  const floor = browsers.minBalanceUsd;
  return {
    jobMinutes: Number.isInteger(minutes) && minutes >= 1 && minutes <= BROWSER_USE_CAPS.jobMinutes ? minutes : BROWSER_USE_CAPS.jobMinutes,
    dayUsd: typeof day === "number" && day > 0 && day <= BROWSER_USE_CAPS.dayUsd ? day : BROWSER_USE_CAPS.dayUsd,
    monthUsd: typeof month === "number" && month > 0 && month <= BROWSER_USE_CAPS.monthUsd ? month : BROWSER_USE_CAPS.monthUsd,
    minBalanceUsd: typeof floor === "number" && floor >= BROWSER_USE_CAPS.minBalanceUsd ? floor : BROWSER_USE_CAPS.minBalanceUsd,
  };
}

/**
 * The site-block reason after the captcha ladder and the silent-submit
 * retry, or null when this result must stay on Browserbase.
 *
 * `vendorStatus` / `tierRefused` are Browserbase's own refusal (a Verified
 * 403, billing, capacity). They never fall back. `blocked` is a document-host
 * 403 the screenshot Worker saw in the session log. `captchaStuck` is a
 * captcha or wall that outlasted the ladder. `submitStuck` is a send that
 * never moved.
 */
export function siteBlockAfterLadder(result) {
  if (!result || typeof result !== "object") return null;
  if (result.tierRefused === true || result.vendorStatus === 402 || result.vendorStatus === 403 || result.vendorStatus === 503) return null;
  if (result.error === true && result.blocked?.reason !== "403" && !result.captchaStuck && !result.submitStuck) return null;
  if (result.blocked?.reason === "403") return "403";
  if (result.captchaStuck === true && result.captchaKind === "wall") return "interstitial";
  if (result.captchaStuck === true) return "captcha";
  if (result.submitStuck === true) return "stuck_submit";
  return null;
}

/** One fallback per question, and only when the flag is on and there is a site block. */
export function fallbackWanted({ flag, reason, already }) {
  return flag === "on" && typeof reason === "string" && already !== true;
}

/** A step name safe to keep in the block log: never the words that were typed. */
const STEP = /^[a-z_]{1,20}$/;

/** The first step that did not run, or a stand-in when the run reported none. Null when every step ran. */
function failedStep(ran) {
  if (!Array.isArray(ran) || ran.length === 0) return { do: "" };
  return ran.find((step) => !step || step.ok !== true) ?? null;
}

/**
 * One retry on Browser Use after the ladder, or the same result when the
 * flag is off or nothing was a site block. The other browser starts blank,
 * so the retry is the silent-submit plan: open the page, then the steps
 * already done (`submits.plan`). It is cleared only when that plan has no
 * captcha or block and every step ran. Anything else leaves the question
 * on the original browser.
 */
export async function retryOnBrowserUse({ done, captchaLine, handoff, captchas, submits, computer, tried, run, planned }) {
  let trigger = null;
  let fallbackNote = "";
  let fallbackCleared = false;
  let fallback = { ran: false };
  let next = done;
  let line = captchaLine;
  let hand = handoff;
  if (next?.reading) {
    trigger = siteBlockAfterLadder({
      blocked: next.blocked,
      captchaStuck: captchas.stuck(),
      captchaKind: next.captchaKind,
      submitStuck: submits.stuck(),
    });
    if (fallbackWanted({ flag: computer.browserUseFallback?.() ?? "off", reason: trigger, already: tried })) {
      tried = true;
      // Open the page, then the steps already done, then this call: the same plan a silent submit replays.
      const plan = typeof submits?.plan === "function" ? submits.plan(next.reading?.url) : planned;
      const again = await run(plan, { provider: "browser-use", trial: true }).catch(() => ({ refused: "browser-use could not be started" }));
      if (!again?.reading) {
        fallback = { ran: false, outcome: "refused" };
        fallbackNote = `\n\nThe site blocked this browser (${trigger}). The other browser was not used: ${again?.refused ?? "browser-use could not be started"}.`;
      } else {
        const failed = failedStep(again.ran);
        const still = siteBlockAfterLadder({
          blocked: again.blocked,
          captchaStuck: again.captcha === "unsolved",
          captchaKind: again.captchaKind,
          submitStuck: false,
        });
        const cost = again.costUsd != null ? { costUsd: again.costUsd } : {};
        // Cleared only when nothing is blocking and every replayed step ran.
        if (!still && !failed) {
          again.adopt?.();
          computer.adoptBrowserUse?.();
          next = again;
          fallback = { ran: true, outcome: "ok", ...cost };
          line = "";
          fallbackCleared = true;
          hand = false;
        } else {
          // The question, the hand-off and the live view stay on the original browser.
          await computer.releaseBrowserUse?.();
          const name = failed && typeof failed.do === "string" && STEP.test(failed.do) ? failed.do : undefined;
          fallback = failed ? { ran: true, outcome: "steps_failed", ...(name ? { step: name } : {}), ...cost } : { ran: true, outcome: still, ...cost };
          fallbackNote = failed
            ? `\n\nTried the other browser after a site block (${trigger}); a step did not run (${name ?? "unknown"}).`
            : `\n\nTried the other browser after a site block (${trigger}); it was blocked too (${still}).`;
        }
      }
    }
  }
  return { done: next, captchaLine: line, handoff: hand, trigger, fallbackNote, fallbackCleared, fallback, tried };
}

/** A host, and only a host, for the block log. */
export function browseHost(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return /^[a-z0-9.-]{1,253}$/.test(host) ? host : "";
  } catch {
    return "";
  }
}
