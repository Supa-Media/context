/**
 * THE NOTIFY NODE: the check-in's delivery of the person's waiting attention
 * pings (`attention.js` `deliverAttention`). No model. It reads today's and
 * yesterday's logs, marks what it texts, and returns the one text to send, if
 * any. Sending is the runner's job.
 *
 * `dispatch` and `store` come from `io.ctx.notify`.
 */

import { deliverAttention } from "../../attention.js";

/**
 * @param {{ now: number, timeZone: string, onlyEmergencies: boolean }} input
 * @param {{ ctx: { notify: { dispatch: Function, store: object } } }} io
 * @returns {Promise<{ to: "send" | "quiet", answer: string, count: number }>}
 */
export async function notify(input, io) {
  const { dispatch, store } = io.ctx.notify;
  const sent = await deliverAttention(dispatch, store, { now: input.now, timeZone: input.timeZone, onlyEmergencies: input.onlyEmergencies });
  if (sent === null) return { to: "quiet", answer: "", count: 0 };
  return { to: "send", answer: sent.text, count: sent.count };
}
