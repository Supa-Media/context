/**
 * Which bot this connection is in the workspace a store addresses (`tools/notes/botBind.js`; Dev, 2026-11-26:
 * "anything that login writes shows as Grok Bot ... instead of Cursor"). The control plane keeps the binding by grant
 * (`apps/convex/functions/botLogins.ts`), and a session answered by a person's object never carries it, so the
 * gateway asks, once per actor, only when it signs or reads mail. `{ bot, name }` or null; a failed ask is null.
 */

const asked = new WeakMap();

export function boundBotOf(store) {
  const actor = store?.actor;
  if (actor === null || typeof actor !== "object" || typeof store.botHooks !== "function") return Promise.resolve(null);
  const held = asked.get(actor);
  if (held !== undefined) return held;
  const work = Promise.resolve()
    .then(() => store.botHooks({ action: "bound" }))
    .then((answer) => {
      const bot = typeof answer?.bot === "string" ? answer.bot.trim() : "";
      if (bot === "") return null;
      const name = typeof answer.name === "string" && answer.name.trim() !== "" ? answer.name.trim() : bot;
      return { bot, name };
    })
    .catch(() => null);
  asked.set(actor, work);
  return work;
}

/** After binding, this actor is that bot from now on, with no second ask. */
export function rememberBound(store, bound) {
  if (store?.actor !== null && typeof store?.actor === "object") asked.set(store.actor, Promise.resolve(bound));
}
