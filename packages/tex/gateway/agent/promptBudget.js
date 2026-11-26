/**
 * EVERY HAIKU CALL STAYS UNDER THE PRICE CLIFF, AND KEEPS ITS CACHE.
 *
 * Haiku 5.5 charges five times for input past 100,000 tokens. The history
 * caps (`weekHistory.js`) bound the week's transcript, and nothing else: a
 * 1:1 stretch replays tool results whole (`stretch.js`, up to 64,000
 * characters each, 60 of them). Those sit outside the caps, so a busy thread
 * still left the worker at about 126,000 tokens after the caps shipped
 * (gateway analytics, 2026-11-17, setups 54bad9c2e0f0 and d51546d21963).
 *
 * This trims the body that is about to be sent. Tool results outside the
 * newest message go first (the model can call them again), then the oldest
 * history text, and only then a tool result in the newest message. The
 * system prompt and the tool list stay until nothing else will do. Images
 * are counted as pictures, not as their base64, so a photo is not mistaken
 * for a novel.
 *
 * It trims in steps, so the cache keeps reading. Recomputing the cut every
 * round from the untrimmed body moved the stub line by one message per text
 * and rewrote everything after it: 368 of 1,047 front-door rounds,
 * 2026-11-19 to 11-24, were trimmed, and each wrote its prefix again. Now a
 * body over the budget is cut to a step below it (`TRIM_STEP`), and the cut is
 * worked out on the shortest run of messages that put the body in its step,
 * so a newer message leaves it exactly as it was until the body has grown by
 * about a step more. See docs/decisions/texting-assistant/week-history.md.
 */

/**
 * The billed-token ceiling. A call estimated here bills at or under it on 9 rounds in 10, and under
 * the 100k cliff (also the `clear_tool_uses` trigger in `aiGateway.js`) on 361 of the 368 logged
 * rounds whose ratio is known (see `TEXT_CHARS_PER_TOKEN`).
 */
export const HAIKU_INPUT_BUDGET = 96_000;

/**
 * Measured against billed tokens (input + cache read + cache write), production front-door rounds
 * 2026-11-19 6 PM to 11-24 6 PM ET: at 3.5 the billed count was 1.26 times the estimate at the
 * median and 1.30 at p90 (368 trimmed rounds, whose estimate is logged; the 135 untrimmed rounds
 * billed over 96,000 agree, bounded at 1.08 to 1.35). 3.5 / 1.302 = 2.69, rounded down, so an
 * estimate at the budget bills at or under it at p90.
 */
const TEXT_CHARS_PER_TOKEN = 2.68;

/**
 * How far under the budget a trimmed body is cut, in estimated tokens. A front-door round grew by
 * 724 billed tokens at the median and 6,770 at p90 over the same rounds, so a step outlasts
 * about twenty ordinary rounds and two of the largest before the cut moves again.
 */
export const TRIM_STEP = 16_000;

/** A picture or a PDF page, counted once. The base64 is not tokens. */
const IMAGE_TOKENS = 1_600;

export const LEFT_OUT = "(Left out for length. Call it again if you need it.)";

/** An older turn dropped whole, once its tool results were not enough. */
export const EARLIER = "(Earlier turn left out for length.)";

const textTokens = (text) => Math.ceil(String(text ?? "").length / TEXT_CHARS_PER_TOKEN);

function blockTokens(block) {
  if (typeof block === "string") return textTokens(block);
  if (!block || typeof block !== "object") return 0;
  // A text document is billed as its words; a picture or a PDF as a picture.
  if (block.type === "document" && block.source?.type === "text") return textTokens(block.source.data);
  if (block.type === "image" || block.type === "document") return IMAGE_TOKENS;
  if (block.type === "tool_result") {
    if (typeof block.content === "string") return textTokens(block.content);
    if (Array.isArray(block.content)) return block.content.reduce((sum, part) => sum + blockTokens(part), 0);
  }
  if (typeof block.text === "string") return textTokens(block.text);
  return textTokens(JSON.stringify(block));
}

function messageTokens(message) {
  if (!message) return 0;
  if (typeof message.content === "string") return textTokens(message.content);
  if (Array.isArray(message.content)) return message.content.reduce((sum, block) => sum + blockTokens(block), 0);
  return 0;
}

/** Tokens in one gateway body: system, tools, and messages. */
export function estimateBodyTokens(body) {
  const system = Array.isArray(body?.system) ? body.system.reduce((sum, block) => sum + blockTokens(block), 0) : textTokens(body?.system);
  const tools = textTokens(JSON.stringify(body?.tools ?? []));
  const messages = (body?.messages ?? []).reduce((sum, message) => sum + messageTokens(message), 0);
  return system + tools + messages;
}

function resultText(block) {
  if (typeof block?.content === "string") return block.content;
  if (Array.isArray(block?.content)) return block.content.filter((part) => part?.type === "text").map((part) => part.text).join("");
  return "";
}

/** The oldest tool result before message `end` that still holds more than the stub, or null. */
function oldestResult(messages, end) {
  for (let i = 0; i < end; i += 1) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    for (let j = 0; j < content.length; j += 1) {
      const block = content[j];
      if (block?.type === "tool_result" && resultText(block) !== LEFT_OUT) return { message: i, block: j };
    }
  }
  return null;
}

function stubResult(block) {
  return { ...block, content: LEFT_OUT };
}

/** The oldest history text before message `end`, or null. The turn's own messages, from `end` on, stay until nothing else will do. */
function oldestHistory(messages, end) {
  for (let i = 0; i < end; i += 1) {
    const message = messages[i];
    if (typeof message?.content === "string" && message.content !== EARLIER && message.content.length > EARLIER.length) return { message: i, kind: "string" };
    if (!Array.isArray(message?.content)) continue;
    for (let j = 0; j < message.content.length; j += 1) {
      const block = message.content[j];
      if (block?.type === "text" && typeof block.text === "string" && block.text !== EARLIER && block.text.length > EARLIER.length) return { message: i, block: j, kind: "text" };
    }
  }
  return null;
}

function stubHistory(messages, where) {
  const message = messages[where.message];
  if (where.kind === "string") message.content = EARLIER;
  else message.content[where.block] = { ...message.content[where.block], text: EARLIER };
}

/**
 * Halve the longest remaining text, keeping its end. Used only when stubbing
 * tool results and older turns still leaves the call over the cliff, which
 * is a system prompt or a newest message bigger than the budget on its own.
 * Messages from `end` on are left whole. Returns false when nothing long is
 * left, so the loop stops.
 */
function clipLargest(body, end = Infinity) {
  const best = largestText(body, end);
  if (!best || best.text.length <= EARLIER.length + 1) return false;
  const tail = Math.max(0, Math.floor(best.text.length / 2) - EARLIER.length - 1);
  const clipped = tail === 0 ? EARLIER : `${EARLIER}\n${best.text.slice(-tail)}`;
  if (clipped.length >= best.text.length) return false;
  best.set(clipped);
  return true;
}

/** The longest text `clipLargest` may clip, as { text, set }, or null. */
function largestText(body, end = Infinity) {
  let best = null;
  const offer = (text, set) => {
    if (typeof text === "string" && text.length > (best?.text.length ?? EARLIER.length + 1)) best = { text, set };
  };
  if (typeof body.system === "string") offer(body.system, (value) => { body.system = value; });
  else if (Array.isArray(body.system)) {
    body.system.forEach((block, index) => {
      if (typeof block?.text === "string") offer(block.text, (value) => { body.system[index] = { ...block, text: value }; });
    });
  }
  (body.tools ?? []).forEach((tool, index) => {
    if (typeof tool?.description === "string") offer(tool.description, (value) => { body.tools[index] = { ...tool, description: value }; });
  });
  (body.messages ?? []).forEach((message, index) => {
    if (index >= end) return; // the turn's own messages, when the cut keeps them
    if (typeof message?.content === "string") offer(message.content, (value) => { body.messages[index] = { ...message, content: value }; });
    else if (Array.isArray(message?.content)) {
      message.content.forEach((block, blockIndex) => {
        if (typeof block?.text === "string") offer(block.text, (value) => { message.content[blockIndex] = { ...block, text: value }; });
        if (block?.type === "tool_result" && typeof block.content === "string") offer(block.content, (value) => { message.content[blockIndex] = { ...block, content: value }; });
      });
    }
  });
  return best;
}

/** The longest tool result that still holds more than the stub, as { message, block, length }, or null. */
function largestResult(messages) {
  let best = null;
  messages.forEach((message, i) => {
    if (!Array.isArray(message?.content)) return;
    message.content.forEach((block, j) => {
      const text = block?.type === "tool_result" ? resultText(block) : null;
      if (text !== null && text !== LEFT_OUT && text.length > (best?.length ?? 0)) best = { message: i, block: j, length: text.length };
    });
  });
  return best;
}

const messageList = (body) => (Array.isArray(body?.messages) ? body.messages : []);

/**
 * Stubs `body` in the fixed order until its estimate is at or under `target`. `older`: tool results
 * before message `keepFrom`, then history text before it. `newest`: a tool result anywhere, oldest
 * first. `clip`: the longest text, last of all, outside messages from `clipFrom` on. `keepFrom`
 * defaults to the body's last message. Returns how many cuts it made.
 */
function cut(body, target, { older = true, newest = true, clip = true, keepFrom, clipFrom = Infinity } = {}) {
  const messages = messageList(body);
  const end = Math.max(0, Math.min(keepFrom ?? messages.length - 1, messages.length));
  let shed = 0;
  while (estimateBodyTokens(body) > target) {
    const result = older ? oldestResult(messages, end) : null;
    const history = older && !result ? oldestHistory(messages, end) : null;
    const any = newest && !result && !history ? oldestResult(messages, messages.length) : null;
    const where = result ?? any;
    if (where) messages[where.message].content[where.block] = stubResult(messages[where.message].content[where.block]);
    else if (history) stubHistory(messages, history);
    else if (!clip || !clipLargest(body, clipFrom)) break;
    shed += 1;
  }
  return shed;
}

/** Which step of `TRIM_STEP` over the budget an estimate is in; 0 under it. */
const stepOf = (tokens) => Math.max(0, Math.ceil((tokens - HAIKU_INPUT_BUDGET) / TRIM_STEP));

/**
 * `body` trimmed until a Haiku call stays under `HAIKU_INPUT_BUDGET`.
 * Tool results outside the newest message go first, then older history
 * text, and only then a tool result in the newest message. The turn, from
 * message `turnFrom` (the person's ask) on, is never older history, however
 * many tool rounds followed it; with no `turnFrom` it is the newest message.
 * Returns the same object when it already fits.
 *
 * A body `step` steps over the budget sheds `step` whole steps, so it lands a
 * step under, and grows back to the budget before the next cut. The cut is
 * made on the shortest leading run of messages already in that step (the
 * "frame"), the newest of them standing in for the newest message; the
 * messages after it go as they came. A newer text or tool round in the same
 * step finds the same frame and makes the same cut, byte for byte. Only when
 * stubbing whole older units cannot reach the step does the frame's newest
 * tool result go, and then a clip, and only on the frame.
 */
export function fitHaikuBody(body, { turnFrom } = {}) {
  const before = estimateBodyTokens(body);
  if (before <= HAIKU_INPUT_BUDGET) return { body, before, after: before, shed: 0 };
  const next = JSON.parse(JSON.stringify(body));
  const messages = messageList(next);
  const step = stepOf(before);
  const frame = { ...next, messages: [] };
  let framed = estimateBodyTokens(frame);
  for (const message of messages) {
    if (stepOf(framed) >= step) break;
    frame.messages.push(message);
    framed += messageTokens(message);
  }
  const rest = messages.slice(frame.messages.length);
  const restTokens = before - framed;
  const hasNewest = rest.length === 0; // the frame's last message is the call's newest
  // The turn: from the person's ask (`turnFrom`, the wire index just past the cached history,
  // `aiGateway.js`) to the end, or the newest message alone when the caller has no history. It is
  // never older history: a tool round that pushed the body into a new step once stubbed the ask
  // itself, and the model answered "I only see placeholders" (Lab test chats, 2026-11-26).
  const start = Number.isInteger(turnFrom) && turnFrom >= 0 && turnFrom < messages.length ? turnFrom : messages.length - 1;
  const lastOfFrame = frame.messages.length - 1;
  const keepFrom = Math.min(start, lastOfFrame);
  const low = framed - step * TRIM_STEP;
  // Whole older units, down to a step under: the cut that holds while the body grows. The frame's
  // last message is kept as if it were the newest, whatever follows it, so a newer message cannot
  // change this cut.
  let shed = cut(frame, low, { newest: false, clip: false, keepFrom });
  const over = () => estimateBodyTokens(frame) + restTokens > HAIKU_INPUT_BUDGET;
  // Still over, and newer messages follow the frame with its last message before the ask: that
  // message is older history to them, down to the step.
  const lastIsOlder = !hasNewest && start > lastOfFrame;
  if (over() && lastIsOlder) shed += cut(frame, low, { newest: false, clip: false, keepFrom: frame.messages.length });
  // Then, of a clip of the system prompt, the tool list or older history, and a tool result of this
  // turn, whichever is longer, down to the step so the same clip holds next round; a tool result goes
  // only while the call is over the budget. The turn's words are never clipped here: a lookup of a
  // few thousand characters is no reason to drop it while the system prompt is the overflow.
  if (over()) {
    while (estimateBodyTokens(frame) > low) {
      const clip = largestText(frame, start);
      const result = over() ? largestResult(frame.messages) : null;
      if (result && (!clip || result.length >= clip.text.length)) {
        frame.messages[result.message].content[result.block] = stubResult(frame.messages[result.message].content[result.block]);
      } else if (!clip || !clipLargest(frame, start)) break;
      shed += 1;
    }
  }
  // Last of all, a clip of anything.
  if (over()) shed += cut(frame, HAIKU_INPUT_BUDGET, { older: false, newest: false });
  const fitted = { ...frame, messages: [...frame.messages, ...rest] };
  // A frame too small to give a step (nothing left to stub or clip in it): the whole body, as before,
  // the turn's own messages last.
  if (estimateBodyTokens(fitted) > HAIKU_INPUT_BUDGET) shed += cut(fitted, HAIKU_INPUT_BUDGET, { keepFrom: start });
  return { body: fitted, before, after: estimateBodyTokens(fitted), shed };
}
