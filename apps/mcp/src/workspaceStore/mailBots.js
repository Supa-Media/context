/**
 * WHICH BOT A CONNECTION IS, in this workspace (Dev, 2026-11-26: "bind the bot's connector login to its bot card, so
 * anything that login writes shows as Grok Bot ... instead of Cursor"). Kept in the workspace's own object beside the
 * bot's card and mail, one row per connection (its grant id): the bot's mail name and its card's name. Never in the
 * control plane, which keeps sign-in and little else (Dev, 2026-11-26).
 *
 * The gateway binds a connection here only for its own session (`tools/notes/botBind.js`, an owner's or editor's,
 * once the card is found) and asks which bot a connection is when it signs or reads mail (`mail/boundBot.js`). A grant
 * id is an id, never a credential: a revoked connection's requests never reach here, so its row says nothing.
 */

const SCHEMA = [`CREATE TABLE IF NOT EXISTS ws_mail_bots (grant_id TEXT PRIMARY KEY, bot TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL)`];

/** The most connections bound in one workspace. */
export const MAX_BOUND = 200;

const isGrant = (value) => typeof value === "string" && /^[A-Za-z0-9_:.-]{1,128}$/.test(value);
const isBot = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);
const isName = (value) => typeof value === "string" && value.trim() !== "" && value.length <= 64;
const rowsOf = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

/** The bindings table over a Durable Object's `sql`. `now` is a clock, for the tests. */
export function mailBots(sql, { now = () => Date.now() } = {}) {
  let ready = false;
  const schema = () => {
    if (ready) return;
    for (const statement of SCHEMA) sql.exec(statement);
    ready = true;
  };
  return {
    /** Binds `grantId` as `bot` here, replacing what it was. `{ok: true}` or `{error}`. */
    bind(grantId, { bot, name }) {
      if (!isGrant(grantId) || !isBot(bot) || !isName(name)) return { error: "Name the bot as its card names it." };
      schema();
      const held = rowsOf(sql.exec("SELECT grant_id FROM ws_mail_bots WHERE grant_id = ?", grantId)).length > 0;
      if (!held && Number(rowsOf(sql.exec("SELECT COUNT(*) AS n FROM ws_mail_bots"))[0]?.n ?? 0) >= MAX_BOUND) {
        return { error: "This workspace already has too many bot logins." };
      }
      sql.exec(
        "INSERT INTO ws_mail_bots (grant_id, bot, name, at) VALUES (?, ?, ?, ?) ON CONFLICT (grant_id) DO UPDATE SET bot = excluded.bot, name = excluded.name, at = excluded.at",
        grantId, bot, name.trim(), now(),
      );
      return { ok: true };
    },

    /** `{bot, name}` for `grantId`, or null. */
    of(grantId) {
      if (!isGrant(grantId)) return null;
      schema();
      const row = rowsOf(sql.exec("SELECT bot, name FROM ws_mail_bots WHERE grant_id = ?", grantId))[0];
      return row === undefined ? null : { bot: row.bot, name: row.name };
    },
  };
}
