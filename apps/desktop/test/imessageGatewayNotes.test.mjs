/**
 * `read_note` / `write_note` over the machine's own MCP grant.
 *
 * The transport is exercised through `fakeFetch` — the same fake the meetings
 * gateway suite uses — so what is asserted here is exactly what a real MCP
 * gateway would answer: the modern envelope's `content`/`isError` shape, not a
 * bespoke REST response.
 *
 * ## Sabotage record
 *
 * Measured by actually editing `src/core/imessage/gatewayNotes.ts` and
 * reverting:
 *
 *   the tier check (`grantCoversMeetings`) skipped before the request is sent  3 FAIL
 *   the gateway's own refusal text forwarded as `message` instead of one of
 *     `NOTES_REFUSAL`'s fixed sentences                                       4 FAIL
 */

import { readNote, writeNote, NOTES_REFUSAL, NOTES_TIER_REFUSAL } from "../src/core/imessage/gatewayNotes.ts";
import { fakeFetch } from "./fakes.mjs";

const GRANT = "context:write context:private";
const TOKEN = "fake-grant-token-not-a-real-one";

function config(fetchImpl, { token = TOKEN, scope = GRANT } = {}) {
  return {
    mcpUrl: "https://gateway.example.test/mcp",
    token: async () => token,
    scope: () => scope,
    fetch: fetchImpl,
  };
}

function toolResult(content, isError = false) {
  return { jsonrpc: "2.0", id: "x", result: { resultType: "complete", content, isError } };
}

function textResult(text, isError = false) {
  return toolResult([{ type: "text", text }], isError);
}

export async function runImessageGatewayNotesChecks(check) {
  // -- the request itself ------------------------------------------------
  const fetch1 = fakeFetch([{ body: textResult("etag: e1\npath: 0-inbox/imessage/2026-09-07.md\nvisibility: private\n\nhello") }]);
  await readNote(config(fetch1), "0-inbox/imessage/2026-09-07.md");
  const [call] = fetch1.calls;
  check("the request posts to the mcp url", call.url === "https://gateway.example.test/mcp");
  check("the token goes in the Authorization header, never the URL", call.init.headers["Authorization"] === `Bearer ${TOKEN}`);
  check("the modern protocol version header is set", call.init.headers["MCP-Protocol-Version"] === "2026-07-28");
  check("Mcp-Method mirrors the body's method (tools/call)", call.init.headers["Mcp-Method"] === "tools/call");
  check("Mcp-Name mirrors the tool being called", call.init.headers["Mcp-Name"] === "read_note");
  const body = JSON.parse(call.init.body);
  check("the body's declared protocol version matches the header", body.params._meta["io.modelcontextprotocol/protocolVersion"] === "2026-07-28");
  check("the body calls read_note with the path", body.params.name === "read_note" && body.params.arguments.path === "0-inbox/imessage/2026-09-07.md");
  check("the token never appears anywhere in the request body", !call.init.body.includes(TOKEN));

  // -- read_note: found, not found, malformed -----------------------------
  const found = await readNote(config(fakeFetch([{ body: textResult("etag: e2\npath: p\nvisibility: private\n\nthe body text") }])), "p");
  check("a found note reports its etag", found.ok && found.found && found.etag === "e2");
  check("a found note reports its body, not the header block", found.ok && found.found && found.content === "the body text");

  const notFound = await readNote(config(fakeFetch([{ body: textResult("not found", true) }])), "p");
  check("read_note's own 'not found' refusal is a first-class answer, not a transport failure", notFound.ok && notFound.found === false);

  const otherRefusal = await readNote(config(fakeFetch([{ body: textResult("that path is reserved", true) }])), ".audit/x.md");
  check("any other read_note refusal is a transport-level failure a caller must not retry as 'not found'", !otherRefusal.ok);

  const malformed = await readNote(config(fakeFetch([{ body: textResult("no etag line here") }])), "p");
  check("a success reply with no etag line is treated as a failure rather than a note with an undefined etag", !malformed.ok);

  // -- write_note: created, updated, conflict -----------------------------
  const written = await writeNote(config(fakeFetch([{ body: textResult("written: p (etag e3)\nvisibility: private") }])), "p", "content", null);
  check("a successful write reports the new etag", written.ok && written.etag === "e3");

  const conflict = await writeNote(
    config(fakeFetch([{ body: textResult("conflict: note changed since you read it (current etag e9). Re-read, merge, and write again.\n\nsomeone else's content", true) }])),
    "p",
    "content",
    "stale-etag",
  );
  check("a conflict is reported as a conflict specifically, not a generic failure", !conflict.ok && conflict.conflict === true);

  const permissionRefused = await writeNote(config(fakeFetch([{ body: textResult("permission denied: write destination", true) }])), "p", "content", null);
  check("a permission refusal is reported as a failure but NOT flagged as a conflict", !permissionRefused.ok && permissionRefused.conflict === false);

  const writesPrivate = fakeFetch([{ body: textResult("written: p (etag e4)\nvisibility: private") }]);
  await writeNote(config(writesPrivate), "p", "content", null);
  const writeBody = JSON.parse(writesPrivate.calls[0].init.body);
  check("every write asks for private visibility explicitly — never left to a folder default", writeBody.params.arguments.visibility === "private");
  check("expected_etag is omitted on a create (no prior etag)", !("expected_etag" in writeBody.params.arguments));

  const writesWithEtag = fakeFetch([{ body: textResult("written: p (etag e5)\nvisibility: private") }]);
  await writeNote(config(writesWithEtag), "p", "content", "e4");
  const updateBody = JSON.parse(writesWithEtag.calls[0].init.body);
  check("expected_etag is sent on an update, so a conflicting concurrent write is caught rather than clobbered", updateBody.params.arguments.expected_etag === "e4");

  // -- the tier check: held, not sent -----------------------------------
  const teamOnly = fakeFetch([{ body: textResult("written: p (etag e6)\nvisibility: team") }]);
  const held = await writeNote(config(teamOnly, { scope: "context:write" }), "p", "content", null);
  check("a grant with no private tier never reaches the network at all", teamOnly.calls.length === 0);
  check("...and is reported with the tier refusal sentence", !held.ok && held.message === NOTES_TIER_REFUSAL);

  const noGrant = fakeFetch([]);
  const heldNoGrant = await writeNote(config(noGrant, { scope: null }), "p", "content", null);
  check("no scope at all is refused the same way as an insufficient one — never read as 'as requested'", !heldNoGrant.ok && noGrant.calls.length === 0);

  // -- not connected --------------------------------------------------
  const notConnected = fakeFetch([]);
  const outcome = await writeNote(config(notConnected, { token: null }), "p", "content", null);
  check("no token yet is retryable, not a hard refusal — the machine may simply not be connected", !outcome.ok && outcome.retryable === true);
  check("a missing token never reaches the network", notConnected.calls.length === 0);

  // -- transport failures --------------------------------------------------
  const unreachable = await writeNote(config(async () => { throw new TypeError("fetch failed"); }), "p", "content", null);
  check("a network failure is retryable and never echoes the raw fetch error", !unreachable.ok && unreachable.retryable === true && !unreachable.message.includes("TypeError"));

  const forbidden = await writeNote(config(fakeFetch([{ status: 401, body: {} }])), "p", "content", null);
  check("HTTP 401 is a non-retryable refusal (the grant is dead)", !forbidden.ok && forbidden.retryable === false);

  const serverError = await writeNote(config(fakeFetch([{ status: 503, body: {} }])), "p", "content", null);
  check("a 5xx is retryable", !serverError.ok && serverError.retryable === true);

  const notJson = await writeNote(
    config(async () => new Response("<html>captive portal</html>", { status: 200, headers: { "content-type": "text/html" } })),
    "p",
    "content",
    null,
  );
  check("a 200 that is not JSON (a captive portal) is retryable, never treated as a successful write", !notJson.ok && notJson.retryable === true);

  // -- a refusal's `message` is this app's sentence, never the gateway's ----
  //
  // `message` travels: `sync.ts` -> `DayOutcome` -> `ImessageStatus.lastError`
  // -> the bridge -> the console page and the tray. It is a string a person
  // reads, on the one path in this app carrying a day of somebody's messages.
  // A gateway that quoted the note it refused would put a fragment of that day
  // on a screen through an error nobody was watching, so the tool's own text
  // is read to *classify* and then dropped.
  const NOTE = [
    "---",
    'type: "channel-day"',
    "---",
    "<!-- context:untrusted-communication begin abc123 -->",
    "the secret body of a private message",
    "<!-- context:untrusted-communication end abc123 -->",
  ].join("\n");

  const quotingWrite = await writeNote(
    config(fakeFetch([{ body: textResult(`refused: cannot write this note: ${NOTE}`, true) }])),
    "0-inbox/imessage/2026-09-07.md",
    NOTE,
    null,
  );
  check(
    "A WRITE REFUSAL THAT QUOTES THE NOTE BACK DOES NOT FORWARD A BYTE OF IT",
    !quotingWrite.ok && quotingWrite.message === NOTES_REFUSAL.write,
  );
  check(
    "...so no message body, fence marker or frontmatter is anywhere in what a person is shown",
    !quotingWrite.message.includes("secret body") &&
      !quotingWrite.message.includes("context:untrusted-communication") &&
      !quotingWrite.message.includes("channel-day"),
  );

  const quotingRead = await readNote(
    config(fakeFetch([{ body: textResult(`refused: cannot read this note: ${NOTE}`, true) }])),
    "0-inbox/imessage/2026-09-07.md",
  );
  check(
    "a read refusal is the same — classified, then answered in this app's own words",
    !quotingRead.ok && quotingRead.message === NOTES_REFUSAL.read && !quotingRead.message.includes("secret body"),
  );

  const conflicting = await writeNote(
    config(fakeFetch([{ body: textResult(`conflict: note changed since you read it (current etag e9). ${NOTE}`, true) }])),
    "0-inbox/imessage/2026-09-07.md",
    NOTE,
    "e1",
  );
  check(
    "a conflict is still RECOGNISED as one — the tool's prefix is read, which is what drives the one retry",
    !conflicting.ok && conflicting.conflict === true,
  );
  check(
    "...and still answered with a fixed sentence rather than the conflict's own text",
    conflicting.message === NOTES_REFUSAL.conflict && !conflicting.message.includes("secret body"),
  );

  const jsonRpcError = await writeNote(
    config(fakeFetch([{ body: { jsonrpc: "2.0", id: "x", error: { code: -32000, message: `bad request: ${NOTE}` } } }])),
    "0-inbox/imessage/2026-09-07.md",
    NOTE,
    null,
  );
  check(
    "a JSON-RPC error object's own message is not forwarded either — that string is written by the other end too",
    !jsonRpcError.ok && jsonRpcError.message === NOTES_REFUSAL.request && !jsonRpcError.message.includes("secret body"),
  );

  const stillFound = await readNote(config(fakeFetch([{ body: textResult("not found", true) }])), "0-inbox/imessage/2026-09-07.md");
  check("...while `not found` is still classified as 'no note yet' rather than an error", stillFound.ok === true && stillFound.found === false);
}
