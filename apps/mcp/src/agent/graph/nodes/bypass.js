/**
 * Confirmations & refusals node "bypass" (`texConfig.json`): a text the Door settled in code, with no model, on its way
 * to Text them (Dev2, 2026-11-16: "only thing that should use the bypass node is the door answered in code"). The
 * answer is the one the door's part left in `t.response`; this step names which part settled it, so the row says
 * whether a yes, a thumbs-up or a refusal went, and hands it on.
 */
export async function bypassNode(input) {
  return { answeredBy: String(input?.answeredBy ?? ""), ...(typeof input?.status === "number" ? { status: input.status } : {}) };
}
