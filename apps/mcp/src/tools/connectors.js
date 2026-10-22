/**
 * `connect_app` and `slack_api`: an app connected through its own OAuth app,
 * so Tex reads and writes it through its API rather than a browser signed in
 * as somebody (`docs/decisions/connectors.md`). Apps connected through their
 * own MCP server are called through `apps.js`.
 *
 * The gateway decides nothing about who may use which connection: the
 * control plane clears this connection's token, picks the person's own
 * connection (one person only, never from a group chat) and adds the app's
 * token itself. This file shapes the call and says what came back. A post
 * other people will read waits for the person's yes (`irreversible.js`).
 */

import { oneLine } from "../privacy/egress.js";
import { toolError, toolText } from "./results.js";

/** Kept equal to `apps/convex/functions/lib/providers/slack.ts`, which refuses anything else. */
export const SLACK_HELD_METHODS = Object.freeze(["chat.delete", "chat.meMessage", "chat.postMessage", "chat.scheduleMessage", "chat.update"]);

const APP = /^[a-z][a-z-]{1,30}[a-z]$/;
/** What a model is shown of one answer; Slack's lists are long, and `limit` asks for fewer. */
export const MAX_ANSWER_CHARS = 60_000;
const METHOD = /^[a-z]+(?:\.[a-zA-Z]+){1,3}$/;

const UNAVAILABLE = "Connected apps are not available on this deployment.";

const REFUSED = {
  not_connected:
    "Slack is not connected for this person. Give them the link from manage connect (app slack) and ask them to tap it and approve in Slack.",
  choose_team: "More than one Slack is connected here. Pass team with one of their names: ",
  reconnect_required:
    "Slack stopped accepting this connection (it was removed in Slack, or the app was uninstalled). Give the person a new link from manage connect (app slack).",
  method_not_allowed: "That Slack method can't be called through Context. Use one of the methods slack_api lists.",
  too_large: "Slack's answer was too long to read. Ask for fewer with a smaller limit, or a narrower oldest/latest.",
  unavailable: "Slack could not be reached just now. Try again in a moment.",
};

export async function toolConnectApp(store, args) {
  const calls = store?.connectors;
  if (!calls) return toolError(UNAVAILABLE);
  const app = typeof args?.app === "string" ? args.app.trim().toLowerCase() : "";
  if (!APP.test(app)) return toolError("app is an app id from fetch apps:, e.g. slack or linear.");
  const answer = await calls.request(app);
  const name = typeof answer?.name === "string" && answer.name !== "" ? answer.name : app;
  if (answer?.url == null) {
    if (answer?.reason === "unknown_provider") return toolError(`${app} isn't an app Context connects. fetch apps: lists the ones it does; use the browser for anything else.`);
    if (answer?.reason === "unavailable") return toolError(`Connecting ${name} is not set up on this deployment yet. Tell the person it is coming.`);
    return toolError(
      `That link can't be made from here. ${name} connects for one person only, from their own chat with you, ` +
        "never for a shared workspace or a group chat.",
    );
  }
  return toolText(
    `Link to connect ${name}: ${answer.url}\n` +
      // iMessage turns a link alone on its line into a card, "Connect Slack to Tex".
      `Send it on a line of its own, with one short line before it, like "Tap this and approve in ${name}:". ` +
      `They tap it, sign in to Context if asked, press Continue to ${name}, and Allow. It works once, for 30 minutes, for them only. ` +
      `Don't open ${name}'s sign-in page in a browser instead.`,
  );
}

/** `args` as Slack's form encoding will carry them: a plain object of plain values. */
function argsOf(value) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return { ...value };
}

export async function toolSlackApi(store, args) {
  const calls = store?.connectors;
  if (!calls) return toolError(UNAVAILABLE);
  const method = typeof args?.method === "string" ? args.method.trim() : "";
  if (!METHOD.test(method)) return toolError("method is a Slack Web API method, like conversations.history.");
  const given = argsOf(args.args);
  if (given === null) return toolError("args is an object of the method's arguments.");
  if (Number.isInteger(args.limit)) given.limit = args.limit;
  const team = typeof args.team === "string" && args.team.trim() !== "" ? args.team.trim() : undefined;
  let answer;
  try {
    answer = await calls.call({ provider: "slack", method, args: given, ...(team ? { team } : {}) });
  } catch {
    return toolError(REFUSED.unavailable);
  }
  if (answer?.ok !== true) {
    const refused = REFUSED[answer?.refused] ?? REFUSED.unavailable;
    return toolError(answer?.refused === "choose_team" ? `${refused}${(answer.teams ?? []).join(", ")}.` : refused);
  }
  // Slack's own refusal for a permission an older connection was not granted: only reconnecting fixes it.
  if (answer.body?.ok === false && answer.body?.error === "missing_scope") {
    const needed = typeof answer.body.needed === "string" ? ` (it needs ${answer.body.needed})` : "";
    return toolError(
      `Slack hasn't given this connection permission for ${method} yet${needed}. Ask the person to reconnect Slack ` +
        "in Context's Settings, under Apps Tex uses, then try again. Don't tell them it can't be done.",
    );
  }
  const body = JSON.stringify(answer.body ?? null);
  if (body.length > MAX_ANSWER_CHARS) return toolError(REFUSED.too_large);
  return toolText(`Slack (${answer.team}) answered ${method}:\n${body}`);
}

const SLACK_PERSON = /^[UW][A-Z0-9]{2,20}$/;
const SLACK_CONVERSATION = /^[CGD][A-Z0-9]{2,20}$/;
const MAX_PLACE = 60;

/** A name Slack gave, made safe to show in one line, or "". */
function shown(value) {
  return typeof value === "string" ? oneLine(value).slice(0, MAX_PLACE).trim() : "";
}

/** A Slack person's name as Slack has it: their real name, else their display name. */
async function personName(calls, user, team) {
  const answer = await calls.call({ provider: "slack", method: "users.info", args: { user }, ...(team ? { team } : {}) });
  const found = answer?.ok === true && answer.body?.ok === true ? answer.body.user : null;
  return { name: shown(found?.real_name) || shown(found?.profile?.real_name) || shown(found?.profile?.display_name), team: shown(answer?.team) };
}

/**
 * Where a held Slack post goes, by name: `{ person }` for a direct message,
 * `{ channel }` for a channel, with the Slack's own name as `team`; null when
 * Slack can't say. The person is asked about a name, never an id like
 * U0FAKE0001 (Dev2, 2026-10-22). The names come from Slack, never from the
 * model, so a model can't put a friendlier name on somebody else's channel.
 */
export async function slackPlace(store, args) {
  const calls = store?.connectors;
  const given = args?.args && typeof args.args === "object" && !Array.isArray(args.args) ? args.args : {};
  const channel = typeof given.channel === "string" ? given.channel.trim() : "";
  if (!calls || slackHeldSummary(args) === null) return null;
  const team = typeof args.team === "string" && args.team.trim() !== "" ? args.team.trim() : undefined;
  try {
    if (SLACK_PERSON.test(channel)) {
      const found = await personName(calls, channel, team);
      return found.name ? { person: found.name, team: found.team } : null;
    }
    if (!SLACK_CONVERSATION.test(channel)) return null;
    const answer = await calls.call({ provider: "slack", method: "conversations.info", args: { channel }, ...(team ? { team } : {}) });
    const found = answer?.ok === true && answer.body?.ok === true ? answer.body.channel : null;
    if (found?.is_im === true && typeof found.user === "string" && SLACK_PERSON.test(found.user)) {
      const person = await personName(calls, found.user, team);
      return person.name ? { person: person.name, team: person.team || shown(answer.team) } : null;
    }
    const name = shown(found?.name);
    return name ? { channel: `#${name.replace(/^#/, "")}`, team: shown(answer.team) } : null;
  } catch {
    return null;
  }
}

/** What a held Slack call would do, in the words the person says yes to; `place` names where (`slackPlace`). */
export function slackHeldSummary(args, place = null) {
  const a = args && typeof args === "object" ? args : {};
  const method = typeof a.method === "string" ? a.method.trim() : "";
  if (!SLACK_HELD_METHODS.includes(method)) return null;
  const given = a.args && typeof a.args === "object" && !Array.isArray(a.args) ? a.args : {};
  const channel = typeof given.channel === "string" && given.channel !== "" ? given.channel : "";
  const team = place?.team ? ` (${place.team})` : "";
  const where = place?.person ? ` to ${place.person}${team}` : place?.channel ? ` in ${place.channel}${team}` : channel ? ` in ${channel}` : "";
  const words = typeof given.text === "string" ? `: "${given.text}"` : given.blocks !== undefined ? " (a formatted message)" : "";
  const reply = typeof given.thread_ts === "string" && given.thread_ts !== "";
  const verb =
    method === "chat.delete"
      ? "delete a Slack message"
      : method === "chat.update"
        ? "change a Slack message"
        : method === "chat.scheduleMessage"
          ? "schedule a Slack message"
          : reply
            ? "reply in a Slack thread"
            : place?.person
              ? "send a Slack message"
              : "post in Slack";
  return oneLine(`${verb}${where}${words}`);
}
