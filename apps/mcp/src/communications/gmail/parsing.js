/** MIME parsing for a Gmail message resource — pure, no I/O. */


/** Gmail's body encoding: base64url, no padding. */
export function decodeBase64UrlToBytes(data) {
  if (typeof data !== "string" || data.length === 0) return new Uint8Array(0);
  const padded = data.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(data.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Gmail's body encoding, decoded as text. Never used on an attachment: those are arbitrary binary, not UTF-8. */
export function decodeBase64UrlToUtf8(data) {
  return new TextDecoder("utf-8", { fatal: false }).decode(decodeBase64UrlToBytes(data));
}

/** A header value by name, case-insensitively — RFC 5322 header names are case-insensitive. */
export function headerValue(headers, name) {
  const lower = String(name).toLowerCase();
  const found = (Array.isArray(headers) ? headers : []).find(
    (header) => String(header?.name ?? "").toLowerCase() === lower,
  );
  return found ? String(found.value ?? "") : "";
}

/**
 * `"Ada Lovelace" <ada@example.com>, bob@example.com` → two entries.
 *
 * Deliberately simple: it does not handle a comma inside a quoted display
 * name (`"Smith, Ada" <ada@example.com>`), which is rare enough in practice
 * that a full RFC 5322 parser is not worth carrying here. A display name is
 * `defangOutsideFence`d wherever it is rendered regardless, so a parse that
 * gets the split wrong produces an odd-looking name, never an injection.
 */
export function parseAddressList(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(.*?)<([^<>]+)>$/.exec(part);
      if (match) {
        const name = match[1].trim().replace(/^"(.*)"$/, "$1");
        return { name: name || undefined, address: match[2].trim() };
      }
      return { address: part };
    });
}

/** Every leaf part of a (possibly nested) MIME tree, depth first. */
function* walkParts(payload) {
  if (!payload) return;
  const children = Array.isArray(payload.parts) ? payload.parts : [];
  if (children.length === 0) {
    yield payload;
    return;
  }
  for (const child of children) yield* walkParts(child);
}

/** Very small HTML→text fallback: drop tags, decode the handful of entities mail actually uses. */
function stripHtml(html) {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * The normalized body and attachment metadata for one message.
 *
 * Every part with a `filename` contributes its name, type, declared size and
 * `attachmentId` — the id Gmail's `attachments.get` needs to fetch the bytes.
 * The id is metadata about the message, not the bytes themselves: carrying it
 * here costs nothing and is what lets `resolveDayAttachments` decide, per the
 * connection's own `attachmentMode`, whether to spend a fetch on it — see
 * that function for where the metadata-only-vs-store choice is actually
 * made. An inline image is an attachment by this same rule: Gmail gives it a
 * `filename` and a `body.attachmentId` exactly like a "real" attachment, and
 * this module does not special-case it — "inline images count as
 * attachments" per the owner's brief.
 */
export function extractBody(payload) {
  let text = "";
  let html = "";
  const attachments = [];
  for (const part of walkParts(payload)) {
    const filename = String(part?.filename ?? "").trim();
    if (filename) {
      attachments.push({
        filename,
        contentType: String(part?.mimeType ?? "application/octet-stream"),
        size: Number.isFinite(part?.body?.size) ? part.body.size : undefined,
        attachmentId: typeof part?.body?.attachmentId === "string" ? part.body.attachmentId : undefined,
      });
      continue;
    }
    const mimeType = String(part?.mimeType ?? "");
    const data = part?.body?.data;
    if (mimeType === "text/plain" && !text) text = decodeBase64UrlToUtf8(data);
    else if (mimeType === "text/html" && !html) html = decodeBase64UrlToUtf8(data);
  }
  return { text: text || (html ? stripHtml(html) : ""), attachments };
}

/**
 * One Gmail message resource (`format=full`) → one `CommunicationEvent`.
 *
 * `account` carries the **mailbox slug**, not the address — the same
 * convention `packages/communications`' own fixtures use, because it is what
 * both `messageAnchor`/`threadKey` (stability across mailboxes) and
 * `channelDayNotePath` (the folder) key off. The address itself travels
 * separately as `address`, for the frontmatter line a person reads.
 *
 * @param {object} message A Gmail `Message` resource.
 * @param {{mailboxSlug: string}} options
 * @returns {import("../../../../packages/communications/src/protocol.js").CommunicationEvent}
 */
export function gmailMessageToEvent(message, options) {
  const headers = message?.payload?.headers ?? [];
  const { text, attachments } = extractBody(message?.payload);
  const internalDate = Number(message?.internalDate);
  const sentAt = Number.isFinite(internalDate) ? new Date(internalDate).toISOString() : new Date(0).toISOString();
  const from = parseAddressList(headerValue(headers, "From"))[0] ?? {};
  return {
    channel: "email",
    account: options.mailboxSlug,
    messageId: String(message?.id ?? ""),
    threadId: String(message?.threadId ?? ""),
    sentAt,
    subject: headerValue(headers, "Subject"),
    from,
    to: parseAddressList(headerValue(headers, "To")),
    body: text,
    attachments,
  };
}

/** `YYYY-MM-DD` from an event's `sentAt`. */
export function dateKeyOf(event) {
  return String(event?.sentAt ?? "").slice(0, 10);
}

