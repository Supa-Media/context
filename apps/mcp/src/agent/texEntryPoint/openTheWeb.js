/** Picks the write tools for this chat and opens the browser, vouched for by the person's own words. One step of Tex's turn (`../texEntryPoint.js`). */

import { markUntrusted } from "../../privacy/egress.js";
import { readUpdates } from "../customInstructions.js";
import { chatLines, groupWriteTools } from "../groupTurn.js";
import { appOriginOf } from "../noteLinks.js";
import { progressChannel } from "../progress.js";
import { textingWriteTools } from "../textingWrites.js";
import { CONSOLE_CLIENT_ID, TEXTS_CLIENT_ID } from "./clients.js";
import { openTurnWeb, theirEarlierWords } from "../turnWeb.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function openTheWeb(t) {
  const { body, dispatch, env, group, history, job, ledger, offered, progress, question, report, routine, runner, session, stages, store, supervision, tex } = t;
  /*
    The computer is the texting assistant's for now (the owner's decision is
    about texting), behind the address guard in `computer.js`. Widening it to
    the app's agent panel is one condition here.
  */
  // Decided by the grant, never by the request body: only the texting client's
  // answers go out as iMessages, and only they are written for one. A
  // routine's answer is a text too, when it says anything.
  const texting = session.actorClientId === TEXTS_CLIENT_ID || runner;
  // A texted write answers with the note's link, so Tex can text it (`noteLinks.js`).
  // A group's too (2026-10-21): everyone in it is a member of the one workspace it reads, so the app link opens for each of them.
  const noteLinking = { origin: session.actorClientId === TEXTS_CLIENT_ID || group !== null ? appOriginOf(env) : null, contexts: store.contexts };
  // A text has the MCP's own write tools (`textingWrites.js`, the owner,
  // 2026-10-08), and so does the app's own assistant since proposals were
  // removed (the owner, 2026-11-03, "Edit directly, like texting"); a
  // routine's own run never may, and a group chat has its own narrower set.
  const textingWriting = textingWriteTools(offered, { texting: !runner && group === null && (session.actorClientId === TEXTS_CLIENT_ID || session.actorClientId === CONSOLE_CLIENT_ID) });
  // A group chat edits as its tagger could in the app, never moving or deleting a note (`groupTurn.js`).
  const groupWriting = group !== null ? groupWriteTools(offered, group) : [];
  /*
    A long task texts its progress (`progress.js`): a person's own texted
    turn or a group's, asked for as a stream by the texting Worker. A routine
    (or a group's, whose Worker drops its lines: `groupModelTurn.ts`) and a
    job's report run unattended and text once, so they never get one; nor
    does a chat that asked for one bubble (Dev2, 2026-11-01). Streamed, each
    is still the long turn.
  */
  const streamed = typeof progress === "function" && (session.actorClientId === TEXTS_CLIENT_ID || group !== null);
  const channel = streamed && report === null ? progressChannel(progress, { level: readUpdates(body.updates), job: job != null }) : null; // off: no tool, yet a sign-in link still goes (`say`); plan only: one line (`progress.js`)
  // Clef is metered with the turn (`meter` below).
  /*
    AN ADDRESS IS VOUCHED FOR BY THE PERSON, NEVER BY A PREVIOUS ANSWER.

    A texted turn's `question` is the person's own message, so it is both the
    prompt and the allow-list's source. A routine's is not: `routineQuestion`
    frames the note with the schedule and **the last run's answer**, which the
    model wrote. Seeding the guard from it would let a page read on one run
    plant an address in the answer and the next run fetch it — unattended,
    every run — which is the exfiltration `computer.js`'s guard exists to
    prevent, laundered through the bucket. So a routine vouches for the
    addresses in its own body and nothing else. The routine's *path* is not in
    the body either, which keeps `watch.md` from reading as a hostname. A group's chat lines are people's own words.
  */
  const vouched = runner ? routine?.body ?? "" : [theirEarlierWords(history), chatLines(group), question].filter(Boolean).join("\n\n"); // their earlier texts too (`turnWeb.js`)
  // Another agent's mail is someone else's words, like a page (`supervise.js`).
  if (supervision !== null) markUntrusted(ledger);
  const { opened, web } = await tex.step("web_setup", () => openTurnWeb(env, { session, texting, group, question, vouched, history: runner ? [] : history, channel, store, dispatch, ledger })); stages?.mark("web");
  Object.assign(t, { channel, groupWriting, noteLinking, opened, streamed, texting, textingWriting, web });
}
// TEX ENTRY POINT: end
