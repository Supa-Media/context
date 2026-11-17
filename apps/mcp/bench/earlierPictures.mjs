/**
 * Pictures in a bench chat, sent as a person sends them: with the text a test runs (`- person sends picture:`) and with
 * an earlier line of the chat (`- earlier person sends picture:`).
 *
 * An earlier picture is kept as production keeps it on the turn that answered it (`texEntryPoint/sendTheReply.js`):
 * written into the person's `tex/pictures/` note through their own gateway (`textedPictures.js`), and named on that
 * turn's reply entry in the chat's ledger (a group's in its home, `chatHome.js`) (`attachments.js` `attachmentsLine`), so the Front door's week of history
 * shows it inline where it was sent (`weekHistory.js` `picturesOf`), as it shows a real one. No model runs for it.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";
import { attachmentsLine } from "../src/agent/attachments.js";
import { ledgerFor, ONE_TO_ONE_CHAT, wordsEntry } from "../src/agent/ledger.js";
import { keepTextedPictures } from "../src/agent/textedPictures.js";
import { createWorkerCtx } from "../test/workerCtx.mjs";

/** A picture from the repository's `ai/pictures/`, as the texting Worker sends one: `{ name, mediaType, data }`. */
export async function benchPicture(name) {
  const data = await readFile(fileURLToPath(new URL(`./ai/pictures/${name}`, import.meta.url)));
  return { name, mediaType: /\.png$/i.test(name) ? "image/png" : "image/jpeg", data: data.toString("base64") };
}

/** One tool call as the person's own client makes it, through the gateway's MCP endpoint: the call's result. */
export function clientDispatch({ env, token }) {
  return async (name, args) => {
    const { ctx, settle } = createWorkerCtx();
    const response = await worker.fetch(
      new Request("https://mcp.bench.invalid/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
      env,
      ctx,
    );
    const body = await response.json().catch(() => null);
    await settle();
    return body?.result ?? { isError: true, content: [{ type: "text", text: body?.error?.message ?? `status ${response.status}` }] };
  };
}

/**
 * Keep the pictures a person sent with an earlier text, as the turn that answered it did: `names` under
 * `ai/pictures/`, sent at `at`, answered by Tex's line of `turn`. A one-to-one chat's go into the person's
 * `tex/pictures/`; a group's into its home's `pictures/` (`group`: `{ key, home, homeToken }`, `groupChat.mjs`).
 * Answers the reply entry written, or null when none could be kept.
 */
export async function keepEarlierPictures({ env, token, workspaceId, group = null, timeZone = "UTC", at, turn, names }) {
  const attachments = await Promise.all(names.map(benchPicture));
  const dispatch = clientDispatch({ env, token: group ? group.homeToken : token });
  const kept = await keepTextedPictures(dispatch, { now: at, timeZone, attachments, ...(group ? { folder: `${group.home}/pictures`, group: true } : {}) });
  if (kept.length === 0) return null;
  const ledger = ledgerFor(env, group ? { chat: group.key } : { person: workspaceId });
  if (ledger === null) return null;
  const entry = wordsEntry("reply", "", { turn, at: at + 1, attached: attachmentsLine(attachments, kept), clean: true });
  await ledger.append(group ? group.key : ONE_TO_ONE_CHAT, [entry]);
  return entry;
}
