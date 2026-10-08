/**
 * Counting tokens in what crosses the MCP boundary.
 *
 * `o200k_base` (OpenAI's current encoding, through `js-tiktoken`) for every
 * agent: exact for OpenAI models, and a consistent approximation for the rest,
 * because neither Anthropic nor Google publishes a tokenizer for current models
 * that runs locally, and their counting APIs would mean sending customer
 * content to them to count it (`docs/decisions/observability/token-usage.md`).
 *
 * The encoder is ~2 MB of ranks and takes a few hundred milliseconds to build,
 * so it is built on first use and only ever called behind the response.
 *
 * lean: text over EXACT_LIMIT_BYTES is estimated at 4 bytes per token, bounding
 * the CPU one call can cost (measured ~300 ms worst case, adversarial input,
 * on a laptop); raise the limit if exact large answers matter.
 */

const EXACT_LIMIT_BYTES = 64 * 1024;
const encoder = new TextEncoder();

let tokenizer = null;

async function loadTokenizer() {
  if (tokenizer === null) {
    tokenizer = (async () => {
      const [{ Tiktoken }, { default: ranks }] = await Promise.all([
        import("js-tiktoken/lite"),
        import("js-tiktoken/ranks/o200k_base"),
      ]);
      return new Tiktoken(ranks);
    })().catch(() => null);
  }
  return await tokenizer;
}

/**
 * The text in pieces the encoder can take in linear time.
 *
 * BPE merging is quadratic in the length of one pre-tokenized word, and a run
 * with no whitespace is one word: 64 KB of a repeated letter took minutes. So
 * pieces break before whitespace, where o200k_base would break anyway (a word
 * carries its leading space), and a run longer than MAX_RUN is cut, which can
 * shift a count by a token per cut and only in text no model reads as words.
 */
const MAX_RUN = 32;
const CHUNK = 2048;
const PIECE = new RegExp(`\\s*\\S{1,${MAX_RUN}}|\\s+$`, "g");

export function* chunksOf(text) {
  let chunk = "";
  for (const [piece] of text.matchAll(PIECE)) {
    // A piece with no leading whitespace continues a cut run: joining it back
    // would rebuild the long word the cut exists to break up.
    const cut = !/^\s/.test(piece);
    if (chunk.length > 0 && (cut || chunk.length + piece.length > CHUNK)) {
      yield chunk;
      chunk = "";
    }
    chunk += piece;
  }
  if (chunk.length > 0) yield chunk;
}

export function estimateTokens(bytes) {
  return Math.ceil(bytes / 4);
}

/**
 * Tokens in `text`, and how they were counted.
 *
 * @returns {Promise<{count: number, method: "exact" | "estimated"}>}
 */
export async function countTokens(text) {
  if (typeof text !== "string" || text.length === 0) return { count: 0, method: "exact" };
  const bytes = encoder.encode(text).length;
  if (bytes <= EXACT_LIMIT_BYTES) {
    const enc = await loadTokenizer();
    if (enc !== null) {
      try {
        let count = 0;
        for (const chunk of chunksOf(text)) count += enc.encode(chunk).length;
        return { count, method: "exact" };
      } catch {
        // A tokenizer that throws on some input still leaves an estimate.
      }
    }
  }
  return { count: estimateTokens(bytes), method: "estimated" };
}

/** What an agent wrote to make the call: the tool's name and its arguments. */
export function requestText(params) {
  try {
    return JSON.stringify({ name: params?.name ?? "", arguments: params?.arguments ?? {} });
  } catch {
    return "";
  }
}

/**
 * What the agent reads back: the text of each content block and any structured
 * content, without the JSON-RPC envelope. Images are counted, not tokenized:
 * models charge for them by size, and base64 through a text tokenizer is noise.
 */
export function responseParts(result) {
  const texts = [];
  let images = 0;
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block?.type === "image") images += 1;
    else if (block?.type === "resource" && typeof block.resource?.text === "string") {
      texts.push(block.resource.text);
    }
  }
  if (result?.structuredContent !== undefined) {
    try {
      texts.push(JSON.stringify(result.structuredContent));
    } catch {
      // Unserializable structured content never reached the client either.
    }
  }
  return { text: texts.join("\n"), images };
}
