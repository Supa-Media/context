/**
 * The Decide-why node, `decideWhy` (config wire `decide -> decideWhy`, when "contradiction"; off in main's config
 * until a scored Training and Dev run says keep it: `docs/decisions/testing/tex-quality-architecture-2026-11-17.md`,
 * change 1).
 *
 * Decide's reason is a typed question Clef answers on its own, never told what `act` chose. So a verdict can stay
 * quiet, rightly, for a reason that by its own words says the message is for Tex ("it replies to one of Tex's texts"):
 * a pair that cannot be, logged anyway. When that happens this asks once more for the reason alone, told the act, with
 * only the reasons a quiet message can have (`textDecide.cjs` `decideWhyRequest`).
 *
 * The act never changes: the one question it asks is `why`, and the verdict it gives back is the one it was handed
 * with that field replaced. A second look that fails, or names no such reason, keeps the verdict as it was.
 */
import { decideWhyRequest, readDecideWhy, whyContradictsAct } from "../../../../../../packages/tex/src/textDecide.cjs";
import { TEX_CONFIG } from "../../texConfig.js";

/** Whether the config runs this node: it has the step, and the step is on. A draft from before it has no such step. */
export const decideWhyOn = (config = TEX_CONFIG) => (config?.nodes ?? []).find((node) => node.id === "decideWhy")?.on === true;

/**
 * @param {{ verdict: object, state: string }} input Decide's verdict and the state it judged.
 * @param {{ engine: (state: string, questions: object) => Promise<object|null> }} deps Clef, as Decide asks it.
 * @returns {Promise<{ to: "kept" | "changed", verdict: object, was?: string, ms: number }>}
 */
export async function decideWhyNode({ verdict, state } = {}, { engine } = {}) {
  if (!whyContradictsAct(verdict) || typeof engine !== "function") return { to: "kept", verdict, ms: 0 };
  const asked = decideWhyRequest(state, verdict);
  const started = Date.now();
  let answers = null;
  try {
    answers = await engine(asked.state, asked.questions);
  } catch {
    answers = null;
  }
  const ms = Date.now() - started;
  const why = readDecideWhy(answers);
  return why === null ? { to: "kept", verdict, ms } : { to: "changed", verdict: { ...verdict, why }, was: verdict.why, ms };
}
