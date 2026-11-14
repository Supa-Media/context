/**
 * SEND THROUGH TEX, the start node for the pings another AI asked Tex to text (`send notify`, `tools/attention.js`).
 * No model: the person's settings decide whether each goes, and it is texted as written. It reads their quiet hours
 * from the check-in settings (`tex/heartbeat.md`): in them only an emergency goes. Then it delivers what is waiting
 * (`attention.js` `deliverAttention`), which marks each ping in its log before the text goes, so a retry never sends
 * one twice.
 *
 * Output `to`: "send" when there is a text (its words in `answer`), else "quiet". `outcome` and `until` are the
 * check-in route's answer as the texting Worker reads it.
 *
 * `dispatch`, `store`, `session` and `deliver` (the delivery, handed in so no node imports another's code) come from
 * `io.ctx.notify`.
 */

import { readWithEtag } from "../../jobLog.js";
import { quietHoursEnd } from "../../quietHours.js";
import { HEARTBEAT_SETTINGS_PATH } from "../../checkIns.js";
import { disarmTexting } from "../../../tools/approvals.js";

/**
 * @param {{ now: number, timeZone: string }} input
 * @param {{ ctx: { notify: { dispatch: Function, store: object, session: object, deliver: Function } } }} io
 */
export async function notify(input, io) {
  const { dispatch, store, session, deliver } = io.ctx.notify;
  const { now, timeZone } = input;
  const until = quietHoursEnd((await readWithEtag(dispatch, HEARTBEAT_SETTINGS_PATH))?.body, now, timeZone); // their quiet hours: when to come back, or null
  const delivered = await deliver(dispatch, store, { now, timeZone, onlyEmergencies: until !== null });
  console.log(
    JSON.stringify({
      event: "attention_delivery",
      workspace: session.workspaceId,
      grant: session.grantId,
      pings: delivered?.count ?? 0,
      ms: Date.now() - now,
    }),
  );
  if (!delivered) return { to: "quiet", outcome: until === null ? "quiet" : "quiet_hours", answer: "", count: 0, ...(until === null ? {} : { until }) };
  // A text from Tex is something a bare "yes" may answer, so an older ask stops listening.
  await disarmTexting(store, { userId: session.actorUserId }).catch(() => {});
  return { to: "send", outcome: "speak", answer: delivered.text, count: delivered.count, ...(until === null ? {} : { until }) };
}
