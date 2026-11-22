/**
 * A group chat's directory entry in the gateway: where the chat with this key is (`{ line, groupId }`), so a chat routine,
 * a staff move, the Tex page and a cross-chat ask can find the group's inbox from its key alone
 * (`packages/tex/worker/groupRoutines.ts`). It is its own `TexChat` object, `chat:group-key:<key>`, and answers only
 * `/chat-where`: GET reads it, POST keeps it.
 *
 * Until the texting Worker's SenderInbox goes (part C of the runtime simplification, Dev2 approved
 * https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX), an entry this object does not hold yet is read once from the
 * Worker's entry of the same name, over its RPC, and kept here: entries are never moved, they come over as they are read.
 */

/** A directory entry's name: its group's key, the sha-256 of `<line>:<groupId>` in hex. */
const DIRECTORY_NAME = /^group-key:[0-9a-f]{64}$/;

/** Whether `name` (bare, or as `inboxByName` places it, `enam:`) names a directory entry. */
export function isDirectoryName(name) {
  const bare = typeof name === "string" && name.startsWith("enam:") ? name.slice("enam:".length) : name;
  return typeof bare === "string" && DIRECTORY_NAME.test(bare);
}

/** The path a directory entry answers. */
export const CHAT_WHERE_PATH = "/chat-where";

/**
 * One call to a directory entry. `rpc` is the Worker's `TEXTING` entrypoint, read only when this object holds nothing
 * yet; absent (self-hosting without the Worker, or once its SenderInbox is gone), an empty entry answers null.
 */
export async function serveDirectory(request, path, { storage, rpc, name }) {
  if (path !== CHAT_WHERE_PATH) return Response.json({ error: "unknown_route" }, { status: 404 });
  const { CHAT_WHERE_KEY, chatWhereOf } = await import("../../worker/gatewayChat.js");
  if (request.method === "POST") {
    const where = chatWhereOf(await request.json().catch(() => null));
    if (where === null) return new Response(null, { status: 400 });
    await storage.put(CHAT_WHERE_KEY, where);
    return Response.json({ ok: true });
  }
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const kept = await storage.get(CHAT_WHERE_KEY);
  if (kept !== undefined) return Response.json(kept);
  const fromWorker = await readWorkerEntry(rpc, name, chatWhereOf);
  if (fromWorker !== null) {
    await storage.put(CHAT_WHERE_KEY, fromWorker);
    console.log(JSON.stringify({ event: "tex_directory", outcome: "copied" }));
  }
  return Response.json(fromWorker);
}

/** The Worker's entry of the same name, checked; null when there is none, it is malformed, or the Worker can't say. */
async function readWorkerEntry(rpc, name, chatWhereOf) {
  if (rpc === undefined || typeof rpc?.inboxFetch !== "function") return null;
  const answer = await rpc.inboxFetch({ name: `enam:${name}` }, new Request(`https://inbox${CHAT_WHERE_PATH}`, { method: "GET" })).catch(() => null);
  if (!answer?.ok) return null;
  return chatWhereOf(await answer.json().catch(() => null));
}
