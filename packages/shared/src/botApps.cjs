/**
 * The apps a bot runs in, and how each is best set up to reach Context (Dev, 2026-11-27: "there should be a preference
 * per bot, like grokbot we know has webhooks so thats the most reliable, but for things like muse, instinct etc it
 * might be a little tough, so we should store skills or guides in the connect_bot action?").
 *
 * Each app names the way it reaches Context by default (a card's `reach:` wins where it says one) and a short guide
 * `setup_bot` hands the bot for that way (`botRelay.cjs` `setupAnswer`). A webhook app's guide is the relay routine
 * (`botRelay.cjs` `relayStep`); a check-in app's is `checkInSteps` below. An app not listed here is set up either
 * way, by its card.
 */

/** Every app a card's `bot:` may name, in the order they are offered. */
const BOT_APPS = Object.freeze({
  grok: Object.freeze({ label: "Grok bot", reach: "webhook", why: "Grok runs a webhook routine reliably, so Context wakes it the moment mail or a routine comes in." }),
  muse: Object.freeze({ label: "Muse", reach: "mail", why: "Muse checks in every 5 minutes: a webhook is hard to keep running there." }),
  instinct: Object.freeze({ label: "Instinct", reach: "mail", why: "Instinct checks in every 5 minutes: a webhook is hard to keep running there." }),
});

/** The app a card's `bot:` word names, or null for one not listed. */
function appOf(kind) {
  const word = typeof kind === "string" ? kind.trim().toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(BOT_APPS, word) ? BOT_APPS[word] : null;
}

/** How a bot reaches Context: its card's `reach:` when it says one, else its app's way, else checking in. */
function reachOf(reach, kind) {
  const said = typeof reach === "string" ? reach.trim().toLowerCase() : "";
  if (said === "webhook" || said === "mail") return said;
  return appOf(kind)?.reach ?? "mail";
}

const quoted = (value) => JSON.stringify(String(value));

/**
 * The check-in guide, as steps for `setup_bot`'s answer: a job every 5 minutes that only asks whether anything is
 * new (`orient { for, check: true }`), and opens only what that lists.
 */
function checkInSteps({ holder, kind, workspace }) {
  const app = appOf(kind)?.label ?? "your app";
  const ctx = typeof workspace === "string" && workspace.trim() !== "" ? `context: ${quoted(workspace.trim())}, ` : "";
  const check = `orient { ${ctx}for: ${quoted(holder)}, check: true }`;
  return [
    `Make a job in ${app} that runs every 5 minutes on a schedule that keeps going after this chat ends, and whose only call is ${check}. Most runs answer "Nothing new", so the job costs almost nothing; your first check of a session answers with the full orient.`,
    "When a check lists something, open only what it lists: fetch the note it names, or orient { area } for its whole area, then answer in the same note.",
    `If ${app} can't run a job on a schedule, tell your person: they can switch you to a webhook on your bot page.`,
  ];
}

module.exports = { BOT_APPS, appOf, reachOf, checkInSteps };
