// What reached Tex around one moment: the texting Worker's and gateway's own
// log events, and Sendblue's record of every message on the line. Prints
// shapes only (which fields, which type, how long), never a phone number or
// the words of a message, because this runs in a public repository's logs.
// Usage: FROM=2026-10-22T20:50:00Z TO=2026-10-22T21:00:00Z node tapback-evidence.mjs

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET, FROM, TO } = process.env;
const from = Date.parse(FROM);
const to = Date.parse(TO);

const SAFE = ["event", "outcome", "reason", "how", "promoted", "length", "message_type", "service", "keys", "first", "armed", "matched", "tool", "released", "status", "with_words", "line"];
const TAPBACK = /^(Liked|Loved|Disliked|Laughed at|Emphasized|Questioned|Removed)\b/u;
const STANDARD = new Set(["accountEmail", "content", "is_outbound", "status", "error_code", "error_message", "error_reason", "error_detail", "message_handle", "date_sent", "date_updated", "from_number", "number", "to_number", "was_downgraded", "plan", "media_url", "message_type", "group_id", "participants", "send_style", "opted_out", "sendblue_number", "service", "group_display_name"]);

function safe(object) {
  const out = {};
  for (const key of SAFE) if (object[key] !== undefined) out[key] = object[key];
  return out;
}

/** A value's shape, or the value itself when it cannot carry a number or words. */
function shapeOf(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return "number";
  if (typeof value === "string") return /^[a-z_ -]{1,30}$/iu.test(value) ? value : `string(${value.length})`;
  if (Array.isArray(value)) return `array(${value.length})`;
  return { keys: Object.keys(value).sort() };
}

async function workerEvents(script) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/observability/telemetry/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      queryId: `tapback-${script}`,
      timeframe: { from, to },
      view: "events",
      limit: 500,
      parameters: { filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: script }] },
    }),
  });
  const body = await response.json();
  if (!body.success) return console.log(script, "query failed", response.status, JSON.stringify(body.errors));
  const events = body.result?.events?.events ?? [];
  console.log(`\n## ${script}: ${events.length} events`);
  const rows = [];
  for (const entry of events) {
    const when = new Date(entry.timestamp ?? entry.$metadata?.startTime ?? 0).toISOString();
    let message = entry.$metadata?.message ?? entry.source?.message;
    let parsed = typeof entry.source === "object" && entry.source !== null && entry.source.event ? entry.source : null;
    if (parsed === null && typeof message === "string") {
      try {
        const candidate = JSON.parse(message);
        if (candidate && typeof candidate === "object" && candidate.event) parsed = candidate;
      } catch {}
    }
    if (parsed !== null) rows.push(`${when} ${JSON.stringify(safe(parsed))}`);
    else rows.push(`${when} trigger=${entry.$workers?.event?.request?.path ?? entry.$metadata?.trigger ?? "?"} outcome=${entry.$workers?.outcome ?? "?"} (not a structured event)`);
  }
  for (const row of rows.sort()) console.log(row);
}

async function sendblueMessages() {
  const query = new URLSearchParams({ created_at_gte: new Date(from).toISOString(), created_at_lte: new Date(to).toISOString(), limit: "100", order_by: "createdAt", order_direction: "asc" });
  const response = await fetch(`https://api.sendblue.com/api/v2/messages?${query}`, {
    headers: { "sb-api-key-id": SENDBLUE_API_KEY_ID, "sb-api-secret-key": SENDBLUE_API_SECRET },
  });
  if (!response.ok) return console.log("sendblue messages failed", response.status, (await response.text()).slice(0, 200));
  const body = await response.json();
  const list = Array.isArray(body) ? body : (body.data ?? body.messages ?? []);
  console.log(`\n## Sendblue messages: ${list.length} (response keys ${JSON.stringify(Object.keys(body))})`);
  const handles = list.map((message) => message.message_handle);
  for (const message of list) {
    const content = typeof message.content === "string" ? message.content : "";
    const extra = {};
    for (const [key, value] of Object.entries(message)) if (!STANDARD.has(key)) extra[key] = shapeOf(value);
    console.log(
      JSON.stringify({
        at: message.date_sent ?? message.createdAt ?? message.created_at,
        outbound: message.is_outbound,
        status: message.status,
        service: message.service,
        type: message.message_type,
        first: TAPBACK.test(content) ? content.split(/\s/u)[0] : null,
        thumbs: content.includes("\u{1F44D}"),
        length: content.length,
        // A tapback's frame, never the words between: code points of the first 10 and last 3 characters, outside letters.
        head: [...content].slice(0, 10).map((c) => (/\p{L}/u.test(c) ? "L" : `U+${c.codePointAt(0).toString(16)}`)).join(" "),
        tail: [...content].slice(-3).map((c) => (/\p{L}/u.test(c) ? "L" : `U+${c.codePointAt(0).toString(16)}`)).join(" "),
        index: handles.indexOf(message.message_handle),
        replies_to: handles.indexOf(message.reply_to?.message_handle),
        originator: handles.indexOf(message.thread_originator?.message_handle),
        part: message.reply_to?.part_index ?? message.thread_originator?.part ?? null,
        extra,
      }),
    );
  }
}

await workerEvents("context-agent");
await workerEvents("context-mcp");
await sendblueMessages();
