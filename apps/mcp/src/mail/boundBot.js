/**
 * Which bot this connection is in the workspace a store addresses (`tools/notes/botBind.js`; Dev, 2026-11-26:
 * "anything that login writes shows as Grok Bot ... instead of Cursor"). The workspace's own object keeps the binding
 * by grant (`workspaceStore/mailBots.js`), never the control plane, so the gateway asks it once per actor, only when
 * it signs or reads mail. `{ bot, name }` or null; a workspace whose notes are not in an object has no bots bound.
 */
import { objectReader } from "../store/objectLookup.js";

const asked = new WeakMap();

/** The store's object client, where its notes live in an object, or null. */
function mailClientOf(store) {
  try {
    const reader = objectReader(store?.objectReading ?? {});
    return reader !== null && typeof reader.client?.mail?.bound === "function" ? reader.client.mail : null;
  } catch {
    return null;
  }
}

const grantOf = (store) => (typeof store?.actor?.grantId === "string" && store.actor.grantId !== "" ? store.actor.grantId : null);

/**
 * A login bound before bindings moved here (kept for a day in the control plane, `botLoginsCarry.ts`), copied into
 * this workspace's object once, so no bot binds twice. Null when there is none.
 */
async function carried(store, client, grantId) {
  if (typeof store.botHooks !== "function") return null;
  const answer = await store.botHooks({ action: "carried" }).catch(() => null);
  const bot = typeof answer?.bot === "string" ? answer.bot : "";
  if (bot === "") return null;
  const name = typeof answer.name === "string" && answer.name !== "" ? answer.name : bot;
  const copied = await client.bind({ grantId, bot, name }).catch(() => null);
  return copied?.ok === true ? { bot, name } : null;
}

export function boundBotOf(store) {
  const actor = store?.actor;
  if (actor === null || typeof actor !== "object") return Promise.resolve(null);
  const held = asked.get(actor);
  if (held !== undefined) return held;
  const client = mailClientOf(store);
  const grantId = grantOf(store);
  const work =
    client === null || grantId === null
      ? Promise.resolve(null)
      : Promise.resolve()
          .then(() => client.bound({ grantId }))
          .then(async (answer) => {
            const bound = answer?.served === true ? answer.bound : null;
            const bot = typeof bound?.bot === "string" ? bound.bot : "";
            if (bot !== "") return { bot, name: typeof bound.name === "string" && bound.name !== "" ? bound.name : bot };
            return answer?.served === true ? await carried(store, client, grantId) : null;
          })
          .catch(() => null);
  asked.set(actor, work);
  return work;
}

/** Binds this store's own connection as `bot` here. `{ok: true}` or `{error}`, in words a person can act on. */
export async function bindBot(store, { bot, name }) {
  const client = mailClientOf(store);
  const grantId = grantOf(store);
  if (client === null || grantId === null || typeof client.bind !== "function") {
    return { error: "this workspace can't hold bot logins yet" };
  }
  const answer = await client.bind({ grantId, bot, name }).catch(() => null);
  if (answer === null || answer.served !== true) return { error: "the workspace could not be reached. Wait a moment" };
  if (answer.ok !== true) return { error: typeof answer.error === "string" ? answer.error : "no answer" };
  asked.set(store.actor, Promise.resolve({ bot, name }));
  return { ok: true };
}
