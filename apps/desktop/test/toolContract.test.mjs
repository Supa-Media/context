/**
 * WHAT THIS APP SENDS, HELD TO WHAT THE GATEWAY ADVERTISES.
 *
 * The gateway validates every `tools/call` against the `inputSchema` it
 * published (`apps/mcp/src/toolArguments.js`), and an argument the schema does
 * not name is refused rather than dropped. That is the right behaviour and it
 * has a failure mode with a very particular shape: a first-party client that
 * sends one extra property gets a **uniform refusal on every call of that
 * kind**, forever, with a status and nothing else on this side to say why.
 *
 * An evening of parked meetings was first attributed to exactly that. It turned
 * out to be something else entirely — a leaked recorder subscription in the
 * console app, and the meeting routes are REST and never go through the
 * validator at all — but the guess was reasonable *because nothing here could
 * answer it in less than an hour of reading*. This file answers it in a
 * millisecond, for both tools this app actually calls.
 *
 * It drives the real `readNote`/`writeNote` rather than restating their
 * arguments, so a property added to a call is caught by this check whether or
 * not anybody remembers this file exists. The schema is the live one, read off
 * `toolDefinitions()` in the worker, so a schema tightened tomorrow reddens
 * here rather than on somebody's Mac.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   `writeNote` sending an extra `sessionId` argument                         2
 *   `writeNote` sending `expectedEtag` instead of `expected_etag`             2
 *   `readNote` sending `{ path, limit: 1 }`                                   1
 */

import { validateArguments } from "../../mcp/src/toolArguments.js";
import { toolDefinitions } from "../../mcp/src/index.js";
import { readNote, writeNote } from "../src/core/imessage/gatewayNotes.ts";

/** The advertised schema for one tool, exactly as a connected client is handed it. */
function schemaFor(name) {
  return toolDefinitions().find((tool) => tool.name === name)?.inputSchema ?? null;
}

/**
 * Run one call and hand back the `arguments` object that left this process.
 *
 * The reply is the shape each helper needs in order to finish without throwing;
 * what is under test is the request, so the answer only has to be plausible.
 */
async function argumentsSentBy(run, replyText) {
  const sent = [];
  const config = {
    mcpUrl: "https://gateway.test/mcp",
    token: async () => "fake-grant-token-not-a-real-one",
    scope: () => "context:read context:write context:private",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      sent.push({ name: body.params.name, args: body.params.arguments });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: replyText }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
  await run(config);
  return sent;
}

export async function runToolContractChecks(check) {
  const read = await argumentsSentBy(
    (config) => readNote(config, "0-inbox/messages/2026-09-07.md"),
    "etag: abc\n\n# a day of messages",
  );
  check("this app calls read_note", read[0]?.name === "read_note");
  check(
    "EVERY ARGUMENT read_note SENDS IS ONE THE GATEWAY ADVERTISES",
    validateArguments(schemaFor("read_note"), read[0]?.args) === null,
  );

  const created = await argumentsSentBy(
    (config) => writeNote(config, "0-inbox/messages/2026-09-07.md", "# a day", null),
    "written: 0-inbox/messages/2026-09-07.md (etag def)",
  );
  check(
    "EVERY ARGUMENT write_note SENDS IS ONE THE GATEWAY ADVERTISES",
    validateArguments(schemaFor("write_note"), created[0]?.args) === null,
  );

  /*
    The update path sends one property the create path does not, and it is the
    one whose spelling a schema would refuse: `expected_etag`, not
    `expectedEtag`. Checked separately for that reason.
  */
  const updated = await argumentsSentBy(
    (config) => writeNote(config, "0-inbox/messages/2026-09-07.md", "# a day", "abc"),
    "written: 0-inbox/messages/2026-09-07.md (etag def)",
  );
  check(
    "...including the conditional write's own argument",
    updated[0]?.args?.expected_etag === "abc" &&
      validateArguments(schemaFor("write_note"), updated[0]?.args) === null,
  );

  /*
    The guard has to be able to fail, and this is the shape it exists to catch:
    one property the schema does not name, which the gateway answers with a
    refusal identical on every call.
  */
  check(
    "and the check would notice an argument that is not advertised",
    (validateArguments(schemaFor("write_note"), { ...updated[0]?.args, sessionId: "mtg_x" }) ?? "")
      .startsWith("unknown argument"),
  );

  /*
    Stated here because it is the thing a reader will assume and it is not true:
    the meeting routes this app posts a transcript to are REST
    (`POST /meetings/sessions/:id/segments`), not `tools/call`, so no advertised
    schema governs them and the validator never sees them. What guards those is
    `assertSegmentsAddressed` at the gateway and `queueWrite` here.
  */
  check(
    "the meeting write kinds are not tools, so no tool schema covers them",
    toolDefinitions().every((tool) => !tool.name.startsWith("meeting")),
  );
}
