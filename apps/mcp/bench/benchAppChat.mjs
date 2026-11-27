/**
 * A bench turn in the person's app chat (Dev2, 2026-11-27: "1:1 group and in app tests"): an in-app test conversation's
 * text (`texSets.cjs` kind `app`) runs as the Context app's chat sends it, with the chat `app:<user id>`
 * (`packages/tex/gateway/agent/screen.js` `isAppTurn`), and what the test says was on screen (`- on screen:`, `load.mjs`)
 * served as the app chat's object serves its saved copy (`packages/lab/gateway/labSandbox/appTestChat.js`), so the On
 * screen node reads it as production does. `null` is a text sent with nothing open.
 */
import { appScreenChat } from "../../../packages/lab/gateway/labSandbox/appTestChat.js";

/**
 * Sets the turn's `TEX_CHAT` on `env` and returns the body's fields: `{ chat }` for an app turn, `{}` for any other, which
 * puts back what `env` had (`kept`). The app chat shares the person's 1:1 history, so the ledger read is the same.
 */
export function appTurn(env, kept, userId, screen) {
  if (screen === undefined) {
    if (kept === undefined) delete env.TEX_CHAT;
    else env.TEX_CHAT = kept;
    return {};
  }
  const chat = `app:${userId}`;
  env.TEX_CHAT = appScreenChat(chat, screen, Date.now);
  return { chat };
}
