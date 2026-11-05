/**
 * The browse tool's answer to a step it doesn't have (`browse.js`).
 */

/**
 * A step that isn't one, answered with the step that does it (owner, 2026-11-05: a check-in job asked for "wait",
 * "key" and "fill_login" steps, was told only that there were none, and asked again).
 */
const NOT_A_STEP = {
  wait: "every step already waits for the page to settle; take a read step to see it now",
  sleep: "every step already waits for the page to settle; take a read step to see it now",
  key: 'a key is a press step: {"do": "press", "key": "Enter"}',
  keypress: 'a key is a press step: {"do": "press", "key": "Enter"}',
  enter: 'a key is a press step: {"do": "press", "key": "Enter"}, or enter: true on a type step',
  fill_login: "fill_login is a tool of its own, not a browse step",
  login: "a saved login goes in with the fill_login tool, not a browse step",
  navigate: "opening an address is a goto step",
  open: "opening an address is a goto step",
  screenshot: "a picture of the page is a look step",
  fill: "putting words in a box is a type step",
};
/** What the model is told when it names a step there isn't. */
export function notAStep(name, steps) {
  const said = String(name).slice(0, 20);
  const hint = Object.hasOwn(NOT_A_STEP, said.toLowerCase()) ? `${NOT_A_STEP[said.toLowerCase()]}. ` : "";
  return `There is no "${said}" step: ${hint}The steps are ${[...steps].join(", ")}.`;
}
