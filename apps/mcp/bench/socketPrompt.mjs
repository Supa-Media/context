/**
 * The prompt the Claude Code answerer writes for one call (`socketAnswerer.mjs`): the conversation as words
 * (`promptFor`), and as content blocks when it holds a picture or a PDF (`promptBlocks`), each media block in the place
 * it had in the conversation. Pictures reach the model as pictures (Dev2, 2026-11-19: picture rows in the Dev set got
 * "can't read it" in every cc run, because each picture was written out as "[an image]").
 */

/** How a media block reads in the words-only prompt. */
function mediaWords(block) {
  if (block.type === "document") return block.source?.media_type === "application/pdf" ? "[a PDF]" : "[a document]";
  return "[an image]";
}

const imageBlock = (mediaType, data) => ({ type: "image", source: { type: "base64", media_type: mediaType, data } });

/** A content block (or a string) as text. `place(block)` says what a media block reads as, and is handed each one. */
export function blockText(block, place = mediaWords) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (block.type === "text") return String(block.text ?? "");
  if (block.type === "tool_use") return `[called tool ${block.name} with ${JSON.stringify(block.input ?? {})}]`;
  if (block.type === "tool_result") {
    const inner = Array.isArray(block.content) ? block.content.map((part) => blockText(part, place)).join("\n") : String(block.content ?? "");
    return `[result of tool call${block.is_error ? " (error)" : ""}]\n${inner}`;
  }
  if (block.type === "image") return block.source?.type === "base64" ? place(block) : "[an image]";
  if (block.type === "document") {
    if (block.source?.type === "text") return `[document: ${block.title || "untitled"}]\n${String(block.source.data ?? "")}`;
    if (block.source?.type === "base64") return place(block);
    return JSON.stringify(block);
  }
  if (block.type === "thinking" || block.type === "redacted_thinking") return "";
  return JSON.stringify(block);
}

const contentText = (content, place) => (Array.isArray(content) ? content.map((block) => blockText(block, place)).filter(Boolean).join("\n") : blockText(content, place));

const usableBase64 = (item, prefix) => typeof item?.data === "string" && typeof item?.mediaType === "string" && item.mediaType.startsWith(prefix);

/**
 * Tex's own media on a message (`aiGateway.js`): a user message's `pictures` (each placed at its `marker` in the words,
 * else after them), its `attachments` (images and PDFs, after the words, under their name), and a tool message's
 * `images`. Returns the words with the pictures placed, and the media that follows them.
 */
function texMedia(message, place) {
  let words = String(message?.text ?? "");
  const after = [];
  for (const picture of Array.isArray(message?.pictures) ? message.pictures : []) {
    if (!usableBase64(picture, "image/")) continue;
    const block = imageBlock(picture.mediaType, picture.data);
    const at = typeof picture.marker === "string" && picture.marker !== "" ? words.indexOf(picture.marker) : -1;
    if (at < 0) after.push(place(block));
    else {
      const end = at + picture.marker.length;
      words = words.slice(0, end) + place(block) + words.slice(end);
    }
  }
  for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
    const name = String(attachment?.name ?? "attachment");
    if (usableBase64(attachment, "image/")) after.push(`[attachment: ${name}]`, place(imageBlock(attachment.mediaType, attachment.data)));
    else if (attachment?.mediaType === "application/pdf" && typeof attachment.data === "string") {
      const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: attachment.data }, title: name };
      after.push(`[attachment: ${name}]`, place(pdf));
    }
  }
  if (message?.role === "tool") for (const image of Array.isArray(message.images) ? message.images : []) if (usableBase64(image, "image/")) after.push(place(imageBlock(image.mediaType, image.data)));
  return { words, after };
}

/**
 * One message's words. A call comes in the Messages API's shape (`content` blocks) or in Tex's own (`aiGateway.js`):
 * `text`, an assistant's `toolCalls`, and a `tool` message's result with `name` and `isError`. Reading only
 * `content` sent the CLI an empty conversation for every call in Tex's shape (2026-11-18: the job check's brief,
 * finish line and tool results never reached it, and it answered "this check received nothing").
 */
export function messageText(message, place = mediaWords) {
  if (message?.content !== undefined) return contentText(message.content, place);
  const calls = (message?.toolCalls ?? []).map((call) => `[called tool ${call.name} with ${JSON.stringify(call.args ?? call.input ?? {})}]`);
  const { words, after } = texMedia(message, place);
  if (message?.role === "tool") return [`[result of tool call ${message.name ?? ""}${message.isError ? " (error)" : ""}]\n${words}`, ...after].join("\n");
  return [words, ...calls, ...after].filter(Boolean).join("\n");
}

/** The call's system prompt as one string (a Messages API system may be blocks). */
export function systemText(system) {
  return Array.isArray(system) ? system.map((block) => blockText(block)).join("\n\n") : String(system ?? "");
}

/** The tools a call offers, as the model is told about them: name, description and input schema where the call has them. */
export function toolsText(tools = []) {
  return tools
    .map((tool) => (typeof tool === "string" ? `- ${tool}` : `- ${tool.name}: ${tool.description ?? ""}\n  input schema: ${JSON.stringify(tool.input_schema ?? tool.inputSchema ?? {})}`))
    .join("\n");
}

/** The whole prompt as text, with each media block rendered by `place`. */
function renderPrompt(request, place) {
  const turns = (request?.messages ?? []).map((message) => `<${message.role}>\n${messageText(message, place)}\n</${message.role}>`).join("\n\n");
  const tools = request?.tools?.length ? toolsText(request.tools) : "";
  return [
    "Below is a conversation so far. Write the next assistant turn, exactly as you would send it, following the system prompt.",
    "",
    "<conversation>",
    turns,
    "</conversation>",
    ...(tools
      ? [
          "",
          "The tools listed here are available to you in this conversation. You call one by putting it in toolCalls of your JSON answer { text, toolCalls }; that is the only way to call a tool here, and its result comes back to you as the next turn. Call tools whenever you would have used them: text is any words before the calls (or the whole reply, with toolCalls empty), and each call is { name, input } with input matching the tool's schema.",
          "<tools>",
          tools,
          "</tools>",
          'Answer with only that JSON object, { "text": string, "toolCalls": [ { "name": string, "input": object } ] }, and nothing before or after it.',
        ]
      : []),
  ].join("\n");
}

/** The one message the CLI is sent for a call, as words: the conversation so far, the tools on offer, and what to write. Media is named, not sent (see `promptBlocks`). */
export function promptFor(request) {
  return renderPrompt(request, mediaWords);
}

/** True when the call holds a picture or a PDF anywhere: in the Messages API's blocks, or in Tex's own message shape. */
export function hasMedia(request) {
  let found = false;
  renderPrompt(request, (block) => {
    found = true;
    return mediaWords(block);
  });
  return found;
}

/**
 * The same prompt as `promptFor`, as content blocks for the CLI's stream-json input: text blocks, with each picture or
 * PDF as its own block where it sat in the conversation. Empty and blank text blocks are dropped.
 */
export function promptBlocks(request) {
  const media = [];
  // A per-call nonce keeps a placeholder from matching any text the conversation itself holds.
  const nonce = `${process.hrtime.bigint()}${Math.random().toString(36).slice(2)}`;
  const text = renderPrompt(request, (block) => {
    media.push(block);
    return `\u0001${nonce}:${media.length - 1}\u0001`;
  });
  const blocks = [];
  let last = 0;
  const words = (end) => {
    const piece = text.slice(last, end);
    if (piece.trim() !== "") blocks.push({ type: "text", text: piece });
  };
  const mark = new RegExp(`\u0001${nonce}:(\\d+)\u0001`, "g");
  for (const found of text.matchAll(mark)) {
    words(found.index);
    blocks.push(media[Number(found[1])]);
    last = found.index + found[0].length;
  }
  words(text.length);
  return blocks;
}
