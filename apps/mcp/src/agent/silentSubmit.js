/**
 * A FORM THAT A HIDDEN CAPTCHA TURNS AWAY WITHOUT A WORD (the owner's
 * conference registration, 2026-10-27, the evening try).
 *
 * Tex filled every box and pressed Register twice. Nothing happened: no new
 * page, no confirmation, no error. The form's captcha was the invisible
 * kind, which shows nothing until a form is sent and then quietly refuses a
 * browser it doesn't trust. `captchaLadder.js` never ran, because nothing on
 * the page looked like a captcha, and the handoff gate (`handoffGate.js`)
 * refused the browser for the same reason, so Tex texted the person how to
 * fill the whole form in themselves.
 *
 * So a press of a form's send button (Register, Submit, Pay, Continue…)
 * that leaves the page exactly as it was, twice running, on a page the
 * screenshot Worker says carries a hidden captcha (`invisibleCaptcha`,
 * `infra/site-shots/src/captcha.ts`), is that captcha saying no. The gateway
 * then does what the ladder does for a visible one: the same page in a fresh
 * browser (a new address and fingerprint), the same boxes filled the same
 * way, and the button pressed again. If that one goes through, nothing is
 * left for the person. If it still stays put, the captcha counts as stuck:
 * the handoff gate lets the browser go, with the form already filled, for
 * that one press, and the reading tells the model to ask them for exactly
 * that and nothing more.
 */

/** Words on a button that sends a form. */
const SEND = /\b(?:register|registration|submit|sign ?up|join|enrol+|rsvp|continue|next|complete|confirm|finish|send|save|pay|place order|checkout|check out|book|reserve|apply|donate|get tickets?|claim)\b/i;

/** The steps a fresh browser does not need replayed: they only look. */
const LOOKS = new Set(["read", "look", "handoff", "download"]);

/** Said when the fresh browser's press went through. */
export const SUBMIT_CLEARED_LINE =
  "\n\nPressing it did nothing twice: a hidden captcha on this page was turning this browser away. A fresh browser with a new address filled the form in the same way and pressed it again, and this is where that got. " +
  "Read it to check it went through, and carry on yourself.";

/** Said when even the fresh browser was turned away. */
export const SUBMIT_STUCK_LINE =
  "\n\nPressing it does nothing because a hidden captcha on this page is turning the browser away: it stayed put twice here, and again in a fresh browser with a new address that filled the form in the same way. " +
  "The form is filled in, so only that one press is the person's now: add a handoff step, and tell them in one line to press the button (and tick a check if one appears) and text you. " +
  "Never ask them to fill the form in or give them the site to do it themselves.";

const bare = (url) => {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return String(url ?? "");
  }
};
const words = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/** Whether this call's last doing step sent the form, by the button's words in the reading it was pressed on. */
export function pressedSend(planned, elements) {
  const last = [...planned].reverse().find((step) => !LOOKS.has(step.do) && step.do !== "scroll");
  if (!last) return false;
  if (last.do === "press") return last.key === "Enter";
  if (last.do === "type") return last.enter === true;
  if (last.do !== "click") return false;
  if (typeof last.text === "string") return SEND.test(last.text);
  if (!Number.isInteger(last.ref)) return false;
  const element = (Array.isArray(elements) ? elements : []).find((e) => e?.ref === last.ref);
  return element ? SEND.test(String(element.label ?? "")) : false;
}

/** One question's watch on send buttons that do nothing. */
export function silentSubmits() {
  // The steps run on the page since it was opened, to fill a fresh browser's copy the same way.
  let since = [];
  let opened = null;
  // Where the last send left the page, when it went nowhere.
  let lastStill = null;
  const laddered = new Set();
  let stuck = false;
  return {
    /**
     * After a call: `done` is its run (`browse.js`), `planned` its steps,
     * `elements` the reading they were pressed on, `run` runs steps. Answers
     * the run the model should read and the line to put under it.
     */
    async settle(done, planned, elements, run) {
      const goto = planned.map((step) => step.do).lastIndexOf("goto");
      if (goto >= 0) {
        opened = planned[goto].url;
        since = planned.slice(goto + 1).filter((step) => !LOOKS.has(step.do));
      } else since.push(...planned.filter((step) => !LOOKS.has(step.do)));
      if (done === null || done.ran.some((r) => !r.ok)) return { done, line: "" };
      // The reading it was pressed on, or, when this call opened the page, the one it left: the page did not move.
      const before = goto >= 0 ? done.reading.elements : elements;
      if (!pressedSend(planned, before)) return { done, line: "" };
      const here = { url: bare(done.reading.url), text: words(done.reading.text) };
      const still = lastStill !== null && lastStill.url === here.url && lastStill.text === here.text;
      lastStill = here;
      if (!still || done.invisible !== true || laddered.has(here.url)) return { done, line: "" };
      laddered.add(here.url);
      // The same boxes filled once, and the button pressed once: not each press that went nowhere.
      const replay = since.filter((step, i) => i === since.length - 1 || JSON.stringify(step) !== JSON.stringify(since.at(-1)));
      const again = await run([{ do: "goto", url: opened ?? done.reading.url }, ...replay], { fresh: true }).catch(() => null);
      if (again !== null && (bare(again.reading.url) !== here.url || words(again.reading.text) !== here.text)) {
        lastStill = null;
        return { done: again, line: SUBMIT_CLEARED_LINE };
      }
      stuck = true;
      return { done: again ?? done, line: SUBMIT_STUCK_LINE };
    },
    /** Whether a hidden captcha outlasted the fresh browser this question. */
    stuck: () => stuck,
  };
}
