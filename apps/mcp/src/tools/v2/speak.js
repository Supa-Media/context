/**
 * Text written for the older tools, in the six tools' words. The gate's
 * refusals and the write-surface section were written when `write_note`,
 * `propose_note` and `scope_info` were what every app held, and they stay that
 * way for the texting assistant, which still is (`tools/advertised.js`). An app
 * offered the six is told the same thing in calls it can make: a translated
 * call's answer passes through `inV2Names`, and so does orient's access text.
 * The reverse, for the assistant, is `orient/howToWork.js`'s `inToolNames`.
 */
const V2_NAMES = [
  [
    "Call scope_info for the authorized write surface or use propose_note for the correct destination.",
    'Call orient with about: "access" for the authorized write surface, or write with action propose for the correct destination.',
  ],
  ["use propose_note", "use write with action propose"],
  ["## Forms and links, on write_note", "## Forms and links, on write"],
  [
    "write_note's own description carries the block's grammar",
    'orient about: "save" carries the block\'s grammar',
  ],
  ["on the same write_note call", "on the same write call"],
  ["write_note's share argument", "write's share argument"],
];

/** `text` with the older tools' names put as the six tools' calls. */
export function inV2Names(text) {
  return V2_NAMES.reduce((out, [from, to]) => out.split(from).join(to), text);
}

/**
 * A refusal in the six tools' words. Only a refusal: any other answer can
 * carry a note's own text, which is the person's and is passed on as written.
 */
export function resultInV2Names(result) {
  if (result?.isError !== true || !Array.isArray(result.content)) return result;
  const content = result.content.map((part) =>
    part?.type === "text" && typeof part.text === "string"
      ? { ...part, text: inV2Names(part.text) }
      : part,
  );
  return { ...result, content };
}
