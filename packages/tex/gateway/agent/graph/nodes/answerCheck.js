/**
 * Answer check node "answerCheck" (`texConfig.json`; Dev2, 2026-11-16: Answer checks and the Reply reviewer, merged;
 * 2026-11-23: each a step of its own again, over `uses` wires): every draft the Front door would send is checked here
 * before it goes. The Claim checks first (`claimChecks.js`: `doItChecks.js`, `claimCheck.js`, `replyJudge.js`
 * `codeCheck`) catch what code can prove wrong; a draft they let through that is a job's report or a routine's text (the
 * turn's kind, `runTheModel.js` `reviewedAs`, set only when the setup turns the reviewer on) is then read once by the
 * Reply reviewer (`reviewer.js`, `replyJudge.js` `review`). Either sends it back with its notice through the `loop` wire to
 * the Front door (`io.back.fd`), which comes back with the rewrite; `null` lets it go, and the Front door goes on.
 *
 * The wire's rounds are the send-back budget. Letting a draft go is a release and spends none. Once the budget is
 * spent, a draft that would be sent back goes on as it is, and the output says `spent` (Dev2, 2026-11-17: a job whose
 * part got a third notice crashed and lost its finished answer ten times running). When the config wires
 * `answerCheck -> handoff`, such a draft hands the job to a background worker instead (`handoff.js`), and the output
 * logs `handedOff`.
 *
 * When the config wires `answerCheck -> askGate`, a draft the code checks let through is read by the lookup ladder's
 * Before-asking step first (`askGate.js`): a draft that asks them a fact Tex could find goes back with what the quick
 * rungs found, or to a background job for the slow ones (`askGate -> handoff`). Unwired, nothing changes.
 *
 * When the config wires `answerCheck -> friendCheck`, a group draft the code checks let through, on a turn that read a
 * member card, is read by the Friend check first (`friendCheck.js`): one that says or hints at a card goes back once.
 */
export async function answerCheckNode(input, io) {
  const t = io.ctx.turn;
  const back = io.back.fd;
  let stop = input;
  let sentBack = 0;
  let reviews = 0;
  let spent = false;
  let handedOff = false;
  let ladders = 0;
  let held = 0;
  const release = () => back({ notice: null }, { release: true });
  // Before any draft goes: the Room check, when the config wires `answerCheck -> roomCheck`. A group draft carrying what
  // someone here can't open goes back with the facts while a round is left (`roomCheck.js`); with none, Finish holds it.
  const letGo = async () => {
    if ((await roomBefore(io, t)) === "hold" && back.left() > 0 && typeof t.roomNotice === "string") {
      sentBack += 1;
      held += 1;
      return back({ notice: t.roomNotice });
    }
    return release();
  };
  // The budget is spent and the draft would be sent back: when the config wires the Hand-off node, the job goes to a
  // background worker instead of the draft going as it is (`../../handoff.js`); the Front door ends on its start line.
  const spentOn = async (waiting, notice) => {
    spent = true;
    const ack = typeof t.handoff === "function" ? await t.handoff(waiting.draft, waiting.info, notice) : null;
    if (typeof ack !== "string" || ack === "") return letGo();
    handedOff = true;
    t.handedOff = ack; // the Front door's model loop ends on it (`turn.js`), and the wire carries no notice
    return release(); // the job's start line goes, never the draft
  };
  while (stop.pending) {
    const waiting = t.drafts.waiting;
    const { notice, review } = await claimChecksOf(io, t, waiting);
    if (notice !== null && notice !== undefined) {
      if (back.left() === 0) {
        stop = await spentOn(waiting, String(notice));
        continue;
      }
      sentBack += 1;
      stop = await back({ notice: String(notice) });
      continue;
    }
    // A group draft that read a member card, once per draft, when the config wires `answerCheck -> friendCheck`.
    if ((await friendBefore(io, t, waiting)) === "back" && back.left() > 0 && typeof t.friendNotice === "string") {
      sentBack += 1;
      stop = await back({ notice: t.friendNotice });
      continue;
    }
    const ladder = await askBefore(io, t, waiting);
    if (ladder !== null && (ladder.to === "back" || ladder.to === "job")) {
      ladders += 1;
      // The send-back is this check's own one loop to the Front door (`answerCheck -> fd`), as every send-back is.
      if (ladder.to === "back" && back.left() > 0) {
        sentBack += 1;
        stop = await back({ notice: String(ladder.notice) });
        continue;
      }
      // The quick rungs are spent, or found nothing: the slow ones go to a job when the config wires `askGate -> handoff`.
      const ack = typeof t.ladderHandOff === "function" ? await t.ladderHandOff(waiting.draft, waiting.info, String(ladder.why ?? "nothing quick found it")) : null;
      if (typeof ack === "string" && ack !== "") {
        handedOff = true;
        t.handedOff = ack;
        stop = await release();
        continue;
      }
    }
    if (review && t.reviewedAs) {
      reviews += 1;
      const said = await reviewOf(io, t, waiting);
      if (said !== null && said !== undefined && back.left() > 0) {
        sentBack += 1;
        stop = await back({ notice: String(said) });
      } else {
        stop = said !== null && said !== undefined ? await spentOn(waiting, String(said)) : await letGo();
      }
      continue;
    }
    stop = await letGo(); // let go: the front door may still write it again with a text that came in
  }
  return { ...stop, when: [stop.ended ? "ended" : "done"], sentBack, reviews, ...(spent ? { spent: true } : {}), ...(handedOff || ladders > 0 || held > 0 ? { log: { ...(handedOff ? { handedOff: true } : {}), ...(ladders > 0 ? { ladders } : {}), ...(held > 0 ? { held } : {}) } } : {}) };
}

/**
 * The Claim checks' verdict on the draft (`claimChecks.js`, over the `answerCheck -> claimChecks` wire, so the checks
 * are a step of their own in the chat's record); a draft that does not wire it runs the turn's checks here, as before.
 */
async function claimChecksOf(io, t, waiting) {
  if (!("claimChecks" in (io.use ?? {}))) return t.answerChecks.code(waiting.draft, waiting.info);
  const out = await io.use.claimChecks({ draftChars: String(waiting.draft ?? "").length });
  return { notice: out?.back === true ? t.claimNotice : null, review: out?.review === true };
}

/** The Reply reviewer's notice (`reviewer.js`, over `answerCheck -> reviewer`), or the turn's review run here when unwired. */
async function reviewOf(io, t, waiting) {
  if (!("reviewer" in (io.use ?? {}))) return t.answerChecks.review(waiting.draft, waiting.info);
  const out = await io.use.reviewer({ draftChars: String(waiting.draft ?? "").length });
  return out?.back === true ? t.reviewNotice : null;
}

/**
 * The Friend check's verdict on a group draft that read a member card (`friendCheck.js`, over `answerCheck ->
 * friendCheck`), once per draft: "back" or "pass", or null when it is not wired, there was no card, or it failed.
 */
async function friendBefore(io, t, waiting) {
  if (!("friendCheck" in (io.use ?? {})) || !(t.memberCards?.cards?.length > 0) || waiting?.draft === undefined || waiting.draft === t.friendLast) return null;
  t.friendLast = waiting.draft;
  try {
    return (await io.use.friendCheck({ draftChars: String(waiting.draft ?? "").length }))?.to ?? null;
  } catch {
    return null;
  }
}

/**
 * The Room check's verdict on a group draft (`roomCheck.js`, over `answerCheck -> roomCheck`), once per draft: "hold" or
 * "pass", or null when it is not wired, the turn read nothing the room can't open, or it failed.
 */
async function roomBefore(io, t) {
  if (!("roomCheck" in (io.use ?? {})) || !t.roomReads || t.drafts?.waiting?.draft === undefined || t.drafts.waiting.draft === t.roomLast) return null;
  t.roomLast = t.drafts.waiting.draft;
  try {
    return (await io.use.roomCheck({ at: "draft", draftChars: String(t.drafts.waiting.draft ?? "").length }))?.to ?? null;
  } catch {
    return null;
  }
}

/**
 * The lookup ladder (`../../lookupLadder.js`), when the config wires `answerCheck -> askGate` and the turn is a texted
 * one (`runTheModel.js` sets `t.ladderOn`): the Before-asking step's read of a draft the code checks let through, once
 * per draft. Null when it is not wired or it failed: the draft goes on as it would.
 */
async function askBefore(io, t, waiting) {
  if (t.ladderOn !== true || waiting?.draft === undefined || waiting.draft === t.ladderLast) return null;
  t.ladderLast = waiting.draft;
  try {
    if (!("askGate" in io.use)) return null;
    // Lengths only: the gate reads the words from the turn, so its row in the chat's record carries none of them.
    return await io.use.askGate({ askChars: String(t.question ?? "").length, draftChars: String(waiting.draft ?? "").length });
  } catch {
    return null;
  }
}
