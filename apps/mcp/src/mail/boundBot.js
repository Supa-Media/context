/**
 * Which bots this connection is in the workspace a store addresses (`tools/notes/botBind.js`; Dev, 2026-11-26:
 * "anything that login writes shows as Grok Bot ... instead of Cursor"). The workspace's own object keeps the bindings
 * by grant (`workspaceStore/mailBots.js`), never the control plane, so the gateway asks it once per actor, only when
 * it signs or reads mail. `[{ bot, name }]`, empty where none; a workspace whose notes are not in an object has none.
 *
 * One connection may be several bots, because some apps give all their bots one connector (2026-11-26, Grok Bot:
 * "whichever bot binds last takes over the name for all of them"), so each line names which bot speaks (`botFor`).
 */
import { objectReader } from "../store/objectLookup.js";

const asked = new WeakMap();

/** The store's object client, where its notes live in an object, or null. */
function mailClientOf(store) {
  try {
    const reader = objectReader(store?.objectReading ?? {});
    if (reader === null || typeof reader.client?.mail?.bound !== "function") return null;
    // The reader's scope and audience go with each call, as every other object call carries them.
    const mail = reader.client.mail;
    const judged = reader.judged ?? {};
    return {
      bound: (fields) => mail.bound({ ...judged, ...fields }),
      bind: typeof mail.bind === "function" ? (fields) => mail.bind({ ...judged, ...fields }) : undefined,
    };
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

export function boundBotsOf(store) {
  const actor = store?.actor;
  if (actor === null || typeof actor !== "object") return Promise.resolve([]);
  const held = asked.get(actor);
  if (held !== undefined) return held;
  const client = mailClientOf(store);
  const grantId = grantOf(store);
  const work =
    client === null || grantId === null
      ? Promise.resolve([])
      : Promise.resolve()
          .then(() => client.bound({ grantId }))
          .then(async (answer) => {
            if (answer?.served !== true) return [];
            const bots = (Array.isArray(answer.bots) ? answer.bots : []).flatMap((each) =>
              typeof each?.bot === "string" && each.bot !== "" ? [{ bot: each.bot, name: typeof each.name === "string" && each.name !== "" ? each.name : each.bot }] : [],
            );
            if (bots.length > 0) return bots;
            const copied = await carried(store, client, grantId);
            return copied === null ? [] : [copied];
          })
          .catch(() => []);
  asked.set(actor, work);
  return work;
}

/** The bots folder a path is in, `bots/<bot>/...`, as that bot's mail name; null elsewhere. */
function folderBot(path) {
  const match = typeof path === "string" ? /(?:^|\/)bots\/([a-z0-9][a-z0-9-]{0,39})\//.exec(path) : null;
  return match === null ? null : match[1];
}

/**
 * Which of a connection's bound `bots` speaks on `path`: `{bot}` (`{ bot, name }`), `{none: true}` where it is bound
 * as none, or `{error}`. In order: the bot it names (`as`, or the name its mailbox joined as), the bot whose folder the
 * note is in, its one bot. A connection bound as several that names none, outside their folders, is asked which.
 */
export function botFor(bots, { path = null, named = null } = {}) {
  if (!Array.isArray(bots) || bots.length === 0) return { none: true };
  const list = bots.map((each) => each.bot).join(", ");
  if (typeof named === "string" && named !== "") {
    const found = bots.find((each) => each.bot === named);
    return found === undefined ? { error: `this connection is bound here as ${list}, not "${named}". Pass as: one of those` } : { bot: found };
  }
  const inFolder = folderBot(path);
  const own = inFolder === null ? undefined : bots.find((each) => each.bot === inFolder);
  if (own !== undefined) return { bot: own };
  if (bots.length === 1) return { bot: bots[0] };
  return { error: `this connection is bound here as several bots (${list}), so say which one this is: pass as: "<bot>" with the mail` };
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
  // Asked again next time, so the answer holds every bot this connection is, the new one with them.
  asked.delete(store.actor);
  return { ok: true };
}
