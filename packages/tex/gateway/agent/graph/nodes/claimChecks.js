/**
 * Claim checks node "claimChecks" (`texConfig.json`; Dev2, 2026-11-23: "everything should live inside a node"): the
 * code rules that can prove a draft wrong, run on every draft the Answer check is handed, over its `uses` wire
 * (`answerCheck -> claimChecks`). They are the turn's checks (`runTheModel.js` `answerChecksFor`: the stands gate, then
 * `doItChecks.js`, `claimCheck.js` or `untriedWeb.js`, or the setup reviewer's `codeCheck`), until now run inside the
 * Answer check's code with no step of their own.
 *
 * Its row in the chat's record says only whether a rule sent the draft back and whether the reviewer reads it next; the
 * notice itself goes to the Answer check on the turn (`t.claimNotice`), never into the record, since a notice can quote
 * the draft. Its settings (`texNodeSettings.cjs`) are read where the checks are built (`texEntryPoint/prepareTheAnswer.js`).
 */
export async function claimChecksNode(_input, io) {
  const t = io.ctx.turn;
  const waiting = t.drafts?.waiting;
  t.claimNotice = null;
  if (!waiting || typeof t.answerChecks?.code !== "function") return { when: ["pass"], back: false, review: false };
  const { notice, review } = await t.answerChecks.code(waiting.draft, waiting.info);
  t.claimNotice = notice === null || notice === undefined ? null : String(notice);
  return { when: [t.claimNotice === null ? "pass" : "back"], back: t.claimNotice !== null, review: review === true };
}
