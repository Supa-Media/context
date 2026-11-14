/** Starts the side read of Tex's notes and sets up the answer checks and pictures. One step of Tex's turn (`../texEntryPoint.js`). */

import { standingForwardTools } from "../../tools/forwardRule.js";
import { aiGatewayConfig } from "../aiGateway.js";
import { carriesPictures } from "../attachments.js";
import { claimCheck, correctsTheAsk } from "../claimCheck.js";
import { asksDetailed, readInstructions } from "../customInstructions.js";
import { gatewayGraph } from "../graph/gatewayGraph.js";
import { handbackOnGraph } from "../graph/bridges.js";
import { readTexNotes } from "../jobs.js";
import { keptIdsOf, keptInHistory } from "../keptFiles.js";
import { turnPictures } from "../pictureMaker.js";
import { routineCalendarTools } from "../routine.js";
import { deskTexts } from "../texDesk.js";
import { TEXTS_CLIENT_ID } from "./clients.js";
import { untriedWebCheck } from "../untriedWeb.js";
import { stepLog } from "../ledger.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function prepareTheAnswer(t) {
  const { attachments, body, chatLog = null, controlPlane, conversation, dispatch, env, front, group, history, hot, job, meter, noteLinking, offered, question, routine, runner, session, ledgerTurn = null, setAside, stages, steer, store, tex, texting, web } = t;
  const texted = session.actorClientId === TEXTS_CLIENT_ID; // Pictures sent back, drawn or made: a text or a group's (`pictureMaker.js`).
  const knowsRead = texting ? tex.ahead("tex_notes", () => deskTexts(store).then((desk) => readTexNotes(dispatch, { controlPlane, session }, desk, hot.identity))) : null; // About me and the jobs list from the person's object, with the history (`texDesk.js`)
  // A texted answer that says a change was made is checked against the calls that ran (`claimCheck.js`).
  const forwarding = runner ? [...(await tex.step("forward_tools", () => standingForwardTools(store, routine.path, offered))), ...routineCalendarTools(offered)] : []; // and their own calendar (`routine.js`)
  // A small model also reads it for work handed back to them (`handbackJudge.js`).
  const claims = !runner && (!front || job !== null) && (texted || group !== null) ? claimCheck({ question, job, waiting: setAside.length > 0, corrects: correctsTheAsk(question, setAside), pictures: carriesPictures(attachments), kept: keptIdsOf(attachments, keptInHistory(history, { texts: Infinity })), keptShown: attachments.some((file) => file.kept), history, detailed: asksDetailed(readInstructions(body.instructions)), origin: noteLinking.origin, visuals: () => maker?.has("draw_visual") === true, judge: env.HANDBACK_JUDGE !== "on" ? null : handbackOnGraph(gatewayGraph({ writer: chatLog, turn: ledgerTurn }), { question, config: aiGatewayConfig(env), metadata: { feature: "handback-judge", workspace: String(session.workspaceId) } }) }) : null;
  const tries = claims === null && !runner && (texted || group !== null) ? untriedWebCheck() : null; // on the front door, "I can't open it" with nothing tried still goes back once (`untriedWeb.js`)
  // A page's cover it draws is kept for the page's link card (`/gateway/page-cover`).
  const keepCover = async (path, png) => controlPlane.recordPageCover(session.accessToken, session.workspaceId, path, png);
  const { outgoing, maker } = await tex.step("pictures_setup", () => turnPictures(env, { texted: texted || group !== null, question, attachments, store, keep: conversation === "texts", meter, workspaceId: session.workspaceId, keepCover, steps: chatLog ? stepLog(chatLog, { turn: ledgerTurn }) : null })); stages?.mark("pictures");
  const seenWeb = outgoing.wrapWeb(web); // pages read like any tool result, so cards get their photos; a card hunts more through it (`visuals/hunt.js`)
  maker?.useWeb?.(seenWeb === null ? null : (name, args) => seenWeb.call(name, args));
  const begun = steer === null ? Promise.resolve() : tex.ahead("steer_begin", () => steer.begin()); // `/agent/cancel` may stop it from now (`steer.js`); on a chat's text, beside the model
  Object.assign(t, { begun, claims, forwarding, knowsRead, maker, outgoing, seenWeb, texted, tries });
}
// TEX ENTRY POINT: end
