/**
 * A CAPTCHA IS BROWSERBASE'S TO SOLVE BEFORE IT IS EVER THE PERSON'S (the
 * owner, 2026-10-22: "make sure agents try using those bypasses and other
 * browserbase hacks before handing back").
 *
 * Every Browserbase browser solves captchas itself (`solveCaptchas` is on by
 * default) and starts with residential proxies and advanced stealth where the
 * plan has them (./browserbase.ts). A solve takes seconds, so a reading taken
 * the moment a page loads can show a captcha the solver is about to clear,
 * and a model that sees one asks the person to tick a box nobody needed to.
 *
 * So after a Browserbase run this looks at the page: a captcha widget whose
 * answer box is still empty, or a whole-page "verify you are human" wall. While
 * one is there it waits, up to `SOLVE_WAIT_MS`, for it to clear, and the
 * answer says which: `solved` (the reading is taken again after) or
 * `unsolved`. The gateway then tries a reload and a fresh browser before it
 * lets a captcha be handed over (`apps/mcp/src/agent/captchaLadder.js`).
 *
 * The probe reads frame addresses, the answer boxes' lengths and the page's
 * first words, in the page, and returns only booleans: nothing of the page
 * leaves it. It never enables the Runtime domain (a known bot-check tell);
 * `Runtime.evaluate` is what every reading already uses.
 */

/** How long a captcha on the page is given to clear on its own. */
export const SOLVE_WAIT_MS = 30_000;
const POLL_MS = 1_000;

/** What the probe sees, every part a boolean. */
export interface CaptchaSigns {
  /** A visible captcha widget (reCAPTCHA, hCaptcha, Turnstile, Arkose, DataDome, GeeTest, PerimeterX). */
  widget: boolean;
  /** Every widget answer box on the page holds a token. */
  answered: boolean;
  /** A whole-page bot wall ("Just a moment…", "verify you are human", "press and hold"). */
  wall: boolean;
  /**
   * A captcha that shows nothing until a form is sent (invisible reCAPTCHA,
   * reCAPTCHA v3 or Enterprise, an invisible hCaptcha or Turnstile). It can
   * reject a Register press without a word on the page (the owner's
   * registration form, 2026-10-27), so the gateway is told it is there.
   */
  invisible?: boolean;
}

/** Whether these signs mean a captcha still stands between Tex and the page. */
export function captchaPending(signs: CaptchaSigns | null): boolean {
  if (signs === null) return false;
  return signs.wall || (signs.widget && !signs.answered);
}

/** Reads the signs; run in the page. Its result is three booleans and nothing else. */
export const CAPTCHA_PROBE = `(() => {
  const hosts = /recaptcha|hcaptcha\\.com|challenges\\.cloudflare\\.com|arkoselabs|funcaptcha|captcha-delivery\\.com|geetest|px-cdn|px-captcha|perimeterx|awswaf|friendlycaptcha|mtcaptcha/i;
  const widget = [...document.querySelectorAll("iframe")].some((f) => {
    const src = f.src || "";
    if (!hosts.test(src) || /size=invisible/.test(src)) return false;
    const r = f.getBoundingClientRect();
    return r.width * r.height >= 2000;
  }) || !!document.querySelector("#px-captcha, .cf-turnstile iframe, [data-sitekey] iframe");
  const boxes = [...document.querySelectorAll('textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"]')];
  const answered = boxes.length > 0 && boxes.every((b) => (b.value || "").length > 0);
  const words = ((document.title || "") + " " + (document.body ? document.body.innerText : "")).slice(0, 3000);
  const wall = /just a moment\\.\\.\\.|(verify|confirm|prove) (that )?you('re| are) (a )?human|are you a robot|press (&|and) hold|unusual traffic from your|checking (if the site connection is secure|your browser)|select all (the )?(images|squares|pictures)|(complete|solve) (the|this) (puzzle|challenge)/i.test(words);
  const invisible = [...document.querySelectorAll("iframe")].some((f) => hosts.test(f.src || "") && /size=invisible/.test(f.src || "")) ||
    !!document.querySelector('.grecaptcha-badge, [data-size="invisible"], script[src*="recaptcha/api.js?render="], script[src*="recaptcha/enterprise.js"], script[src*="hcaptcha.com/1/api.js"], script[src*="challenges.cloudflare.com/turnstile"]');
  return { widget, answered, wall, invisible };
})()`;

function asSigns(value: unknown): CaptchaSigns | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return { widget: v.widget === true, answered: v.answered === true, wall: v.wall === true, invisible: v.invisible === true };
}

/** Whether the page carries a captcha that shows nothing until a form is sent. A probe that fails says no. */
export async function invisibleCaptcha(evaluate: (source: string) => Promise<unknown>): Promise<boolean> {
  return asSigns(await evaluate(CAPTCHA_PROBE).catch(() => null))?.invisible === true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * After a run: null when no captcha is on the page, else whether it cleared
 * within `waitMs`. A probe that fails counts as no captcha, so a page that
 * will not answer never holds the reading up.
 */
export async function settleCaptcha(
  evaluate: (source: string) => Promise<unknown>,
  { waitMs = SOLVE_WAIT_MS, pollMs = POLL_MS, now = Date.now, wait = sleep }: { waitMs?: number; pollMs?: number; now?: () => number; wait?: (ms: number) => Promise<unknown> } = {},
): Promise<"solved" | "unsolved" | null> {
  const probe = async () => captchaPending(asSigns(await evaluate(CAPTCHA_PROBE).catch(() => null)));
  if (!(await probe())) return null;
  const until = now() + waitMs;
  while (now() < until) {
    await wait(pollMs);
    if (!(await probe())) return "solved";
  }
  return "unsolved";
}
