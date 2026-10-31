/**
 * Words a turn says to us, never to the person (self-reviews fa3f7a and
 * a0365e, 2026-10-31: "SKIP" stood as Tex's reply to three job reports).
 * The gateway says "nothing to text" with a flag (`quiet`,
 * `apps/mcp/src/agent/jobReport.js`); this is the last guard in front of the
 * line: a bubble that is only one of these words is never sent, whatever path
 * it came down. NONE counts in capitals only, as "None." answers a question.
 */

const CONTROL_ONLY = /^[\s\W]*(?:skip(?:ped)?|no[ _-]?op|no[ _-]?reply|stay[ _-]?quiet|quiet|silent|null|undefined|NONE)[\s\W]*$/i;

/** Whether a text is only a control word. */
export function isControlWord(text: string): boolean {
  const said = text.trim();
  return said !== "" && CONTROL_ONLY.test(said) && (!/^\W*none\W*$/i.test(said) || /NONE/.test(said));
}
