/**
 * Which bot a call's activity shows as, in the sidebar's "agents active" (Dev, 2026-11-27: "all grokbots still show
 * up as cursor even though they are registered bots"; then "it wont just be Seyi's Grok Bot doe, can it be something
 * like ... simply Pablo").
 *
 * A login bound as bots here (`tools/notes/botBind.js`, `mail/boundBot.js`) shows as one of them, by its short name
 * (`Pablo · Social Strategist` → `Pablo`). Some apps give all of a person's bots one connector, so one connection may
 * be several bots. In order: the bot its mailbox joined as, the bot whose folder the note is in, its only bot, then
 * the one bot whose card's `works_in` holds the note (the deepest area wins). Null when none of those says, and the
 * row keeps the app's name rather than guessing between bots.
 */
import areaRoutines from "../../../../packages/shared/src/areaRoutines.cjs";
import { botFor, boundBotsOf } from "../mail/boundBot.js";
import { factJobs, factProps } from "../tree/facts.js";

const { botCardPaths, botShortName, parseWorksIn } = areaRoutines;

/** The joined name of `mailboxId`, when it is one of this connection's; null otherwise. */
async function mailboxName(store, mailboxId) {
  if (typeof mailboxId !== "string" || mailboxId === "" || typeof store?.mail?.get !== "function") return null;
  const mailbox = await store.mail.get(mailboxId).catch(() => null);
  return typeof mailbox?.name === "string" && mailbox.name !== "" ? mailbox.name : null;
}

/** The one bot of `bots` whose card's `works_in` holds `path` most closely, or null. */
async function botWorkingIn(store, bots, path) {
  if (typeof path !== "string" || path === "") return null;
  const jobs = await factJobs(store);
  const root = jobs?.jobs?.areas ?? "areas";
  const paths = bots.map((each) => botCardPaths(root, each.bot));
  const facts = await factProps(store, paths.flat());
  if (facts === null) return null;
  const lower = path.toLowerCase();
  let best = null;
  let depth = -1;
  let tied = false;
  bots.forEach((each, at) => {
    const card = paths[at].map((one) => facts.get(one)?.props?.properties).find(Boolean);
    for (const { area } of parseWorksIn(card?.works_in) ?? []) {
      const key = area.toLowerCase();
      if (!lower.startsWith(`${key}/`)) continue;
      const deep = key.split("/").length;
      if (deep > depth) [best, depth, tied] = [each, deep, false];
      else if (deep === depth && best !== each) tied = true;
    }
  });
  return tied ? null : best;
}

/** `{ bot, name }` this call shows as, `name` its short name; null where it shows as its app. */
export async function activityBot(store, { path = null, mailbox = null } = {}) {
  const bots = await boundBotsOf(store).catch(() => []);
  if (bots.length === 0) return null;
  const named = await mailboxName(store, mailbox).catch(() => null);
  let chosen = named !== null && bots.some((each) => each.bot === named) ? botFor(bots, { named }).bot : botFor(bots, { path }).bot;
  if (chosen === undefined) chosen = await botWorkingIn(store, bots, path).catch(() => null);
  if (chosen === null || chosen === undefined) return null;
  return { bot: chosen.bot, name: botShortName(chosen.name) ?? chosen.name };
}
