/**
 * A texted change to how Tex talks or when it answers (`commandTools.js`)
 * reaches the chat's open Tex pages (`texStore/pageLive.js`), as a change made
 * on the page does. Behind the answer: the command's own answer is returned as
 * the control plane gave it, and a page that cannot be told is no failure.
 */

import { pokeTexPage } from "../texStore/pageLive.js";

const CHANGES_SETTINGS = new Set(["instructions", "updates", "engagement", "mute"]);

export async function settingsChanged(env, answer, command, owner) {
  const result = await answer;
  if (result?.status === "done" && CHANGES_SETTINGS.has(command?.kind) && typeof Object.values(owner ?? {})[0] === "string") {
    await pokeTexPage(env, owner, ["settings"]);
  }
  return result;
}
