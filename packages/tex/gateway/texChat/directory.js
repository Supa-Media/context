/**
 * A group chat's directory entry in the gateway: where the chat with this key is (`{ line, groupId }`), so a chat routine,
 * a staff move, the Tex page and a cross-chat ask can find the group's inbox from its key alone
 * (`packages/tex/worker/groupRoutines.ts`). It is its own `TexChat` object, `chat:group-key:<key>`, and answers only
 * `/chat-where`: GET reads it, POST keeps it.
 *
 * Every entry lives here only. The texting Worker's entries were read over once each as they were asked for, until part
 * C of the runtime simplification (Dev2 approved https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX) stopped asking it:
 * the ones no group still named were archived whole (`workerArchive.js`) before the Worker's class was deleted.
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

/** One call to a directory entry: an entry this object holds nothing for answers null. */
export async function serveDirectory(request, path, { storage }) {
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
  return Response.json(kept ?? null);
}
