/**
 * Request validation for the bridge's ops. Each parser turns an untrusted JSON
 * body into the arguments the runtime needs, or throws RequestError(400, code)
 * before any Photon call. The code names the field, never its value.
 */
import { RequestError } from "./errors.mjs";

const E164 = /^\+[1-9][0-9]{6,14}$/;
const EMAIL = /^[^\s@/]{1,64}@[^\s@/]{1,253}\.[^\s@/]{1,63}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const GUID = /^[A-Za-z0-9._:;+-]{1,200}$/;
const MAX_TEXT = 10000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PARTS = 20;

export const EFFECT_NAMES = Object.freeze([
  "slam", "loud", "gentle", "invisible", "confetti", "fireworks", "balloons",
  "heart", "lasers", "celebration", "sparkles", "spotlight", "echo",
]);
export const REACTION_KINDS = Object.freeze(["love", "like", "dislike", "laugh", "emphasize", "question", "emoji"]);

function fail(code) {
  throw new RequestError(400, code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(body) {
  if (!isObject(body)) fail("invalid_body");
  return body;
}

function str(body, key, { min = 1, max = 200, optional = false } = {}) {
  const value = body[key];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    fail(`missing_${key}`);
  }
  if (typeof value !== "string" || value.length < min || value.length > max) fail(`invalid_${key}`);
  return value;
}

function bool(body, key, { optional = false } = {}) {
  const value = body[key];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    fail(`missing_${key}`);
  }
  if (typeof value !== "boolean") fail(`invalid_${key}`);
  return value;
}

function int(body, key, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  const value = body[key];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    fail(`missing_${key}`);
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`invalid_${key}`);
  return value;
}

export function parseLine(value) {
  if (typeof value !== "string" || !E164.test(value)) fail("invalid_line");
  return value;
}

export function parseChat(value) {
  if (typeof value !== "string" || value.length < 3 || value.length > 300 || !value.includes(";")) {
    fail("invalid_chat");
  }
  return value;
}

export function parseGuid(value, field = "guid") {
  if (typeof value !== "string" || !GUID.test(value)) fail(`invalid_${field}`);
  return value;
}

function parseLineAndChat(body) {
  requireObject(body);
  return { line: parseLine(body.line), chat: parseChat(body.chat) };
}

function parseReplyTo(body) {
  const value = str(body, "replyTo", { max: 200, optional: true });
  return value === undefined ? undefined : parseGuid(value, "replyTo");
}

function parseEffect(body) {
  const value = str(body, "effect", { max: 40, optional: true });
  if (value !== undefined && !EFFECT_NAMES.includes(value)) fail("invalid_effect");
  return value;
}

/** Base64 bytes with a decoded size ceiling. */
function parseBase64(value, field, maxBytes) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !BASE64.test(value)) {
    fail(`invalid_${field}`);
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decoded = (value.length / 4) * 3 - padding;
  if (decoded > maxBytes) fail(`too_large_${field}`);
  return value;
}

function parseHttpsUrl(value, field) {
  if (typeof value !== "string" || value.length > 2048) fail(`invalid_${field}`);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`invalid_${field}`);
  }
  if (url.protocol !== "https:" || url.username || url.password) fail(`invalid_${field}`);
  return url.toString();
}

function parseFileName(body, key = "name") {
  const value = str(body, key, { max: 255 });
  if (/[/\\\0]/.test(value)) fail(`invalid_${key}`);
  return value;
}

/** A file to send: base64 bytes, or an https URL the runtime fetches. */
function parseFile(body, field = "attachment") {
  requireObject(body);
  const name = parseFileName(body);
  const mimeType = str(body, "mimeType", { min: 3, max: 127 });
  const hasData = body.data !== undefined && body.data !== null;
  const hasUrl = body.url !== undefined && body.url !== null;
  if (hasData === hasUrl) fail(`${field}_needs_data_or_url`);
  if (hasData) return { name, mimeType, data: parseBase64(body.data, "data", MAX_ATTACHMENT_BYTES) };
  return { name, mimeType, url: parseHttpsUrl(body.url, "url") };
}

function parseAddress(value) {
  if (typeof value !== "string") fail("invalid_address");
  if (E164.test(value)) return value;
  if (value.length <= 254 && EMAIL.test(value)) return value;
  fail("invalid_address");
}

function parseCard(body) {
  requireObject(body);
  const layout = body.layout === undefined ? {} : requireObject(body.layout);
  const parsedLayout = {};
  for (const key of ["caption", "subcaption", "imageTitle", "imageSubtitle", "summary", "trailingCaption", "trailingSubcaption"]) {
    const value = str(layout, key, { max: 300, optional: true });
    if (value !== undefined) parsedLayout[key] = value;
  }
  if (layout.image !== undefined && layout.image !== null) {
    parsedLayout.image = parseBase64(layout.image, "layout_image", MAX_IMAGE_BYTES);
  }
  return {
    appName: str(body, "appName", { max: 100 }),
    appStoreId: int(body, "appStoreId", { min: 1, max: 2 ** 40, optional: true }),
    extensionBundleId: str(body, "extensionBundleId", { max: 200 }),
    teamId: str(body, "teamId", { max: 40 }),
    url: parseHttpsUrl(body.url, "url"),
    live: body.live === undefined ? undefined : bool(body, "live"),
    layout: parsedLayout,
  };
}

function parseParts(body) {
  const parts = body.parts;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) fail("invalid_parts");
  return parts.map((part, index) => {
    requireObject(part);
    if (part.attachment !== undefined) {
      return { attachment: parseFile(part.attachment, `part_${index}`) };
    }
    // A native tag: its words, and the number or email it tags (the SDK's `mentionedAddress`).
    if (part.mention !== undefined) return { text: str(part, "text", { max: MAX_TEXT }), mention: parseAddress(part.mention) };
    return { text: str(part, "text", { max: MAX_TEXT }) };
  });
}

/** Each op: the method, and the parser for its JSON body (or path). */
export const OPS = Object.freeze({
  "send/text": {
    method: "POST",
    parse(body) {
      requireObject(body);
      return {
        ...parseLineAndChat(body),
        text: str(body, "text", { max: MAX_TEXT }),
        replyTo: parseReplyTo(body),
        linkPreview: bool(body, "linkPreview", { optional: true }),
        effect: parseEffect(body),
      };
    },
  },
  "send/attachment": {
    method: "POST",
    parse(body) {
      requireObject(body);
      return { ...parseLineAndChat(body), file: parseFile(body), replyTo: parseReplyTo(body) };
    },
  },
  "send/multipart": {
    method: "POST",
    parse(body) {
      requireObject(body);
      return { ...parseLineAndChat(body), parts: parseParts(body), replyTo: parseReplyTo(body) };
    },
  },
  "send/app": {
    method: "POST",
    parse(body) {
      requireObject(body);
      return { ...parseLineAndChat(body), card: parseCard(body.card) };
    },
  },
  edit: {
    method: "POST",
    parse(body) {
      requireObject(body);
      return {
        ...parseLineAndChat(body),
        guid: parseGuid(body.guid),
        text: str(body, "text", { max: MAX_TEXT }),
      };
    },
  },
  unsend: {
    method: "POST",
    parse(body) {
      requireObject(body);
      return { ...parseLineAndChat(body), guid: parseGuid(body.guid) };
    },
  },
  react: {
    method: "POST",
    parse(body) {
      requireObject(body);
      const kind = str(body, "kind", { max: 16 });
      if (!REACTION_KINDS.includes(kind)) fail("invalid_kind");
      const emoji = str(body, "emoji", { max: 16, optional: true });
      if (kind === "emoji" && emoji === undefined) fail("missing_emoji");
      return {
        ...parseLineAndChat(body),
        guid: parseGuid(body.guid),
        kind,
        emoji,
        on: bool(body, "on"),
      };
    },
  },
  typing: {
    method: "POST",
    parse(body) {
      requireObject(body);
      return { ...parseLineAndChat(body), on: bool(body, "on") };
    },
  },
  read: {
    method: "POST",
    parse(body) {
      return parseLineAndChat(body);
    },
  },
  contact: {
    method: "POST",
    parse(body) {
      return parseLineAndChat(body);
    },
  },
  "chat/resolve": {
    method: "POST",
    parse(body) {
      requireObject(body);
      return { line: parseLine(body.line), address: parseAddress(body.address) };
    },
  },
  "group/members": {
    method: "POST",
    parse(body) {
      return parseLineAndChat(body);
    },
  },
  // Take one address out of a group chat: Tex's old Sendblue number, once Tex's new line is in it (staff moving a chat).
  "group/remove": {
    method: "POST",
    parse(body) {
      return { ...parseLineAndChat(body), address: parseAddress(body.address) };
    },
  },
});

/** Ops the runtime can serve; the router uses this to refuse unknown paths. */
export function opFor(name) {
  return Object.prototype.hasOwnProperty.call(OPS, name) ? OPS[name] : undefined;
}

export function parseAttachmentQuery(line) {
  return line === undefined ? undefined : parseLine(line);
}
