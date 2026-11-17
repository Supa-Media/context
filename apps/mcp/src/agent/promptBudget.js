/**
 * EVERY HAIKU CALL STAYS UNDER THE PRICE CLIFF.
 *
 * Haiku 5.5 charges five times for input past 100,000 tokens. The history
 * caps (`weekHistory.js`) bound the week's transcript, and nothing else: a
 * 1:1 stretch replays tool results whole (`stretch.js`, up to 64,000
 * characters each, 60 of them). Those sit outside the caps, so a busy thread
 * still left the worker at about 126,000 tokens after the caps shipped
 * (gateway analytics, 2026-11-17, setups 54bad9c2e0f0 and d51546d21963).
 *
 * This trims the body that is about to be sent. Oldest tool results go first
 * (the model can call them again), then the oldest history text. The system
 * prompt, the tool list, and the newest message stay. Images are counted as
 * pictures, not as their base64, so a photo is not mistaken for a novel.
 */

/** Stay under the cliff with room for the estimate running a little low. */
export const HAIKU_INPUT_BUDGET = 96_000;

/** Measured on a front-door prompt, 2026-11-17: about 3.95. 3.5 trims a little early rather than crossing the cliff. */
const TEXT_CHARS_PER_TOKEN = 3.5;

/** A picture or a PDF page, counted once. The base64 is not tokens. */
const IMAGE_TOKENS = 1_600;

export const LEFT_OUT = "(Left out for length. Call it again if you need it.)";

/** An older turn dropped whole, once its tool results were not enough. */
export const EARLIER = "(Earlier turn left out for length.)";

const textTokens = (text) => Math.ceil(String(text ?? "").length / TEXT_CHARS_PER_TOKEN);

function blockTokens(block) {
  if (typeof block === "string") return textTokens(block);
  if (!block || typeof block !== "object") return 0;
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

/** The oldest tool result that still holds more than the stub, or null. `skipLast` leaves the newest message. */
function oldestResult(messages, skipLast) {
  const end = skipLast ? messages.length - 1 : messages.length;
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

/** The oldest history text that is not the newest message, or null. The newest message stays until nothing else will do. */
function oldestHistory(messages) {
  const end = Math.max(0, messages.length - 1);
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
 * Returns false when nothing long is left, so the loop stops.
 */
function clipLargest(body) {
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
    if (typeof message?.content === "string") offer(message.content, (value) => { body.messages[index] = { ...message, content: value }; });
    else if (Array.isArray(message?.content)) {
      message.content.forEach((block, blockIndex) => {
        if (typeof block?.text === "string") offer(block.text, (value) => { message.content[blockIndex] = { ...block, text: value }; });
        if (block?.type === "tool_result" && typeof block.content === "string") offer(block.content, (value) => { message.content[blockIndex] = { ...block, content: value }; });
      });
    }
  });
  if (!best || best.text.length <= EARLIER.length + 1) return false;
  const tail = Math.max(0, Math.floor(best.text.length / 2) - EARLIER.length - 1);
  const clipped = tail === 0 ? EARLIER : `${EARLIER}\n${best.text.slice(-tail)}`;
  if (clipped.length >= best.text.length) return false;
  best.set(clipped);
  return true;
}

/**
 * `body` with enough of the oldest tool results removed that a Haiku call
 * stays under `HAIKU_INPUT_BUDGET`. The newest message is stubbed only when
 * the older ones were not enough. Returns the same object when it already fits.
 */
export function fitHaikuBody(body) {
  const before = estimateBodyTokens(body);
  if (before <= HAIKU_INPUT_BUDGET) return { body, before, after: before, shed: 0 };
  const next = JSON.parse(JSON.stringify(body));
  const messages = Array.isArray(next.messages) ? next.messages : [];
  let shed = 0;
  const stubAt = (where) => {
    const message = messages[where.message];
    message.content[where.block] = stubResult(message.content[where.block]);
    shed += 1;
  };
  while (estimateBodyTokens(next) > HAIKU_INPUT_BUDGET) {
    const older = oldestResult(messages, true);
    if (older) {
      stubAt(older);
      continue;
    }
    const any = oldestResult(messages, false);
    if (any) {
      stubAt(any);
      continue;
    }
    const history = oldestHistory(messages);
    if (history) {
      stubHistory(messages, history);
      shed += 1;
      continue;
    }
    if (!clipLargest(next)) break;
    shed += 1;
  }
  return { body: next, before, after: estimateBodyTokens(next), shed };
}
