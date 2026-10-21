/**
 * `connect_app` and `slack_api`: an app connected through its own OAuth app,
 * so Tex reads and writes it through its API rather than a browser signed in
 * as somebody (`docs/decisions/connectors.md`).
 *
 * The gateway decides nothing about who may use which connection: the
 * control plane clears this connection's token, picks the workspace's own
 * connection (never someone's own from a group chat) and adds the app's
 * token itself. This file shapes the call and says what came back. A post
 * other people will read waits for the person's yes (`irreversible.js`).
 */

import { oneLine } from "../privacy/egress.js";
import { toolError, toolText } from "./results.js";

/** Kept equal to `apps/convex/functions/lib/providers/slack.ts`, which refuses anything else. */
export const SLACK_HELD_METHODS = Object.freeze(["chat.delete", "chat.meMessage", "chat.postMessage", "chat.scheduleMessage", "chat.update"]);

const APPS = { slack: "Slack" };
/** What a model is shown of one answer; Slack's lists are long, and `limit` asks for fewer. */
export const MAX_ANSWER_CHARS = 60_000;
const METHOD = /^[a-z]+(?:\.[a-zA-Z]+){1,3}$/;

const UNAVAILABLE = "Connected apps are not available on this deployment.";

const REFUSED = {
  not_connected:
    "Slack is not connected to this workspace. Give the person the link from manage connect (app slack) and ask them to tap it and approve in Slack.",
  choose_team: "More than one Slack is connected here. Pass team with one of their names: ",
  reconnect_required:
    "Slack stopped accepting this workspace's connection (it was removed in Slack, or the app was uninstalled). Give the person a new link from manage connect (app slack).",
  method_not_allowed: "That Slack method can't be called through Context. Use one of the methods slack_api lists.",
  too_large: "Slack's answer was too long to read. Ask for fewer with a smaller limit, or a narrower oldest/latest.",
  unavailable: "Slack could not be reached just now. Try again in a moment.",
};

export async function toolConnectApp(store, args) {
  const calls = store?.connectors;
  if (!calls) return toolError(UNAVAILABLE);
  const name = APPS[args?.app];
  if (!name) return toolError("app is slack.");
  const answer = await calls.request(args.app);
  if (answer?.url == null) {
    if (answer?.reason === "unavailable") return toolError(`Connecting ${name} is not set up on this deployment yet. Tell the person it is coming.`);
    return toolError(
      `That link can't be made from here. Connecting ${name} for a shared workspace needs an owner or editor of it, ` +
        "and a group chat can only connect it for its own shared workspace.",
    );
  }
  return toolText(
    `Link to connect ${name}: ${answer.url}\n` +
      // iMessage turns a link alone on its line into a card, "Connect Slack to Tex".
      "Send it on a line of its own, with one short line before it, like \"Tap this and approve in Slack:\". " +
      `They tap it, sign in to Context if asked, press Continue to ${name}, and Allow. It works once, for 30 minutes, for them only. ` +
      "Don't open Slack's sign-in page in a browser instead.",
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
  const body = JSON.stringify(answer.body ?? null);
  if (body.length > MAX_ANSWER_CHARS) return toolError(REFUSED.too_large);
  return toolText(`Slack (${answer.team}) answered ${method}:\n${body}`);
}

/** What a held Slack call would do, in the words the person says yes to. */
export function slackHeldSummary(args) {
  const a = args && typeof args === "object" ? args : {};
  const method = typeof a.method === "string" ? a.method.trim() : "";
  if (!SLACK_HELD_METHODS.includes(method)) return null;
  const given = a.args && typeof a.args === "object" && !Array.isArray(a.args) ? a.args : {};
  const where = typeof given.channel === "string" && given.channel !== "" ? ` in ${given.channel}` : "";
  const words = typeof given.text === "string" ? `: "${given.text}"` : given.blocks !== undefined ? " (a formatted message)" : "";
  const verb =
    method === "chat.delete" ? "delete a Slack message" : method === "chat.update" ? "change a Slack message" : method === "chat.scheduleMessage" ? "schedule a Slack message" : "post in Slack";
  return oneLine(`${verb}${where}${words}`);
}
