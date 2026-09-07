/**
 * Writing a channel-day note through the machine's own MCP grant.
 *
 * The meetings protocol (`ROUTES` in `@context/meetings/protocol`) is a
 * bespoke REST surface built for one shape of write — a session, its
 * segments, its notes, its finalize — and iMessage import is not that shape:
 * it is an ordinary note at an ordinary path, exactly the thing `write_note`
 * already exists for. So rather than bending the meetings routes to carry a
 * second protocol, this app calls `write_note` (and `read_note`, for the
 * etag) the way any other MCP client would: `POST /mcp`, the modern
 * `2026-07-28` envelope, `Authorization: Bearer <this machine's token>`.
 *
 * **The credential and the tier check are the same ones the meetings path
 * uses** — `GatewayConnection.token()` and `grantCoversMeetings(scope)` from
 * `sync/connection.ts` — because the requirement is the same requirement:
 * a write that is not backed by `context:write context:private` must be held
 * rather than filed team-visible, whatever the destination path is.
 * `grantCoversMeetings` is reused rather than renamed, because what it checks
 * — write plus the private tier — has nothing meeting-specific in it; the
 * name is the one thing about it that is.
 *
 * This module is the transport only. `sync.ts` decides *when* to read and
 * write; this decides how one `tools/call` reaches the gateway and how its
 * answer is turned into something `sync.ts` can act on without knowing the
 * MCP wire format exists.
 *
 * ## Every `message` here is this app's own sentence, never the gateway's
 *
 * A failure's `message` travels: `sync.ts` puts it in a `DayOutcome`,
 * `main/imessage.ts` puts that in `ImessageStatus.lastError`, and the bridge
 * pushes it to the console page and the tray. So it is a string a person
 * *reads*, on a path carrying a day of somebody's messages — and a tool
 * refusal from the other end is text this app did not write and cannot bound.
 * A gateway that quoted the note it refused (a validation error naming the
 * offending line, a proxy echoing the request body) would put a fragment of
 * somebody's iMessage history on a screen through an error path nobody was
 * looking at.
 *
 * So the gateway's own words are used for **classification only** — `not
 * found`, the `conflict:` prefix — and never forwarded. `sqlite.ts` states the
 * same rule for the same reason one layer down, and `exec.ts`'s `run` states
 * it for the process it spawns; this is the third place the rule has to hold,
 * and the only one where the text comes off the network.
 */

import { grantCoversMeetings } from "../sync/connection.ts";

/** The modern MCP revision this gateway speaks. See `apps/mcp/src/protocol.js`'s `MODERN_PROTOCOLS`. */
const MCP_PROTOCOL_VERSION = "2026-07-28";

export interface NotesGatewayConfig {
  /** `${gatewayBaseUrl}/mcp` — the same origin the meetings routes hang off. */
  mcpUrl: string;
  /** Read at call time, so a re-connect takes effect without a restart. */
  token: () => Promise<string | null>;
  /** What the grant this machine holds actually carries. Required; see the header. */
  scope: () => string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** What a `read_note` came back with. */
export type ReadNoteResult =
  | { ok: true; found: true; etag: string; content: string }
  | { ok: true; found: false }
  | { ok: false; retryable: boolean; message: string };

/** What a `write_note` came back with. */
export type WriteNoteResult =
  | { ok: true; etag: string }
  | { ok: false; conflict: boolean; retryable: boolean; message: string };

/**
 * What a person is told when the gateway refused a read or a write.
 *
 * Fixed sentences, chosen by *which* call was refused — never the refusal's
 * own text. See the header: this string reaches a screen.
 */
export const NOTES_REFUSAL = Object.freeze({
  read: "this machine's context refused to read that day's iMessage note",
  write: "this machine's context refused to write that day's iMessage note",
  conflict: "that day's iMessage note changed while it was being written",
  request: "the gateway refused this request",
});

/** The sentence held rather than sent when this machine's grant cannot file privately. Mirrors `MEETING_TIER_REFUSAL`. */
export const NOTES_TIER_REFUSAL =
  "This machine was approved for team-visible notes only, so importing iMessage is holding its notes rather than " +
  "publishing them to everyone you share with. Disconnect and connect it again, choosing to include private notes.";

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `imessage-${Date.now().toString(36)}-${requestCounter}`;
}

function toolCallBody(id: string, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION } },
  });
}

function headersFor(token: string, toolName: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    "Mcp-Method": "tools/call",
    "Mcp-Name": toolName,
  };
}

/** The plain-text content of a successful tool result, or `null` for a malformed one. */
function textOf(result: unknown): string | null {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === "text" && typeof first.text === "string" ? first.text : null;
}

/** `key: value` lines up to the first blank line, and the body after it — the shape `toolReadNote` writes. */
function splitInfoBlock(text: string): { headers: Map<string, string>; body: string } {
  const separator = text.indexOf("\n\n");
  const headerBlock = separator === -1 ? text : text.slice(0, separator);
  const body = separator === -1 ? "" : text.slice(separator + 2);
  const headers = new Map<string, string>();
  for (const line of headerBlock.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return { headers, body };
}

/**
 * One `tools/call`, with the transport failures every caller here would
 * otherwise duplicate: no grant, wrong tier, a timeout, an unparsable reply.
 *
 * Returns the tool's own result object on a transport success — the caller
 * still has to read `isError` — or a `TransportFailure` for everything that
 * never reached a tool at all.
 */
interface TransportFailure {
  ok: false;
  retryable: boolean;
  message: string;
}

async function callTool(
  config: NotesGatewayConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; isError: boolean; text: string | null } | TransportFailure> {
  const scope = config.scope();
  if (!grantCoversMeetings(scope)) {
    return { ok: false, retryable: false, message: NOTES_TIER_REFUSAL };
  }
  const token = await config.token();
  if (token === null) {
    return { ok: false, retryable: true, message: "this machine is not connected to a context yet" };
  }

  const doFetch = config.fetch ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 20_000);
  let response: Response;
  try {
    response = await doFetch(config.mcpUrl, {
      method: "POST",
      headers: headersFor(token, name),
      body: toolCallBody(nextRequestId(), name, args),
      signal: controller.signal,
    });
  } catch {
    // Never the raw error: a thrown `fetch` failure can carry the request URL,
    // and a future URL might carry a token in it (`sync/client.ts` states the
    // same rule for the meetings path).
    return { ok: false, retryable: true, message: "the gateway could not be reached" };
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, retryable: false, message: "this machine's grant was refused" };
  }
  if (!response.ok) {
    return { ok: false, retryable: true, message: `the gateway answered with status ${response.status}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // A captive portal answering 200 with HTML is the single most common
    // "the network is up but not really" on a laptop — `sync/client.ts`'s
    // rule, restated: an unparsable success is retryable, never an ingest.
    return { ok: false, retryable: true, message: "the gateway's reply could not be read" };
  }

  const envelope = payload as { result?: unknown; error?: { message?: unknown } };
  if (envelope.error) {
    // Not `envelope.error.message`: see the header. A JSON-RPC error object is
    // written by the other end, and this string is read by a person.
    return { ok: false, retryable: false, message: NOTES_REFUSAL.request };
  }

  const result = envelope.result as { isError?: unknown } | undefined;
  return { ok: true, isError: result?.isError === true, text: textOf(result) };
}

/** `not found` is the exact refusal `toolReadNote` sends for a path that does not exist yet. */
const NOT_FOUND_TEXT = "not found";

export async function readNote(config: NotesGatewayConfig, path: string): Promise<ReadNoteResult> {
  const outcome = await callTool(config, "read_note", { path });
  if (!outcome.ok) return outcome;
  if (outcome.isError) {
    // The tool's own text is read to *classify* — `not found` is how
    // `toolReadNote` says a path does not exist yet — and then dropped.
    if (outcome.text === NOT_FOUND_TEXT) return { ok: true, found: false };
    return { ok: false, retryable: false, message: NOTES_REFUSAL.read };
  }
  const text = outcome.text ?? "";
  const { headers, body } = splitInfoBlock(text);
  const etag = headers.get("etag");
  if (!etag) return { ok: false, retryable: true, message: "read_note answered with no etag" };
  return { ok: true, found: true, etag, content: body };
}

const WRITTEN_PATTERN = /^written: .+ \(etag ([^)]+)\)/;

export async function writeNote(
  config: NotesGatewayConfig,
  path: string,
  content: string,
  expectedEtag: string | null,
): Promise<WriteNoteResult> {
  const args: Record<string, unknown> = { path, content, visibility: "private" };
  if (expectedEtag !== null) args["expected_etag"] = expectedEtag;
  const outcome = await callTool(config, "write_note", args);
  if (!outcome.ok) return { ok: false, conflict: false, retryable: outcome.retryable, message: outcome.message };
  if (outcome.isError) {
    // Classified on the tool's own `conflict:` prefix — which is what drives
    // `sync.ts`'s one re-read-and-retry — and then answered with this app's
    // own sentence rather than the tool's.
    const conflict = (outcome.text ?? "").startsWith("conflict:");
    return {
      ok: false,
      conflict,
      retryable: false,
      message: conflict ? NOTES_REFUSAL.conflict : NOTES_REFUSAL.write,
    };
  }
  const match = WRITTEN_PATTERN.exec(outcome.text ?? "");
  if (!match?.[1]) return { ok: false, conflict: false, retryable: true, message: "write_note answered with no etag" };
  return { ok: true, etag: match[1] };
}
