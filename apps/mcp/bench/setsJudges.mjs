/**
 * Two of Tex's judges, run alone on the Training and Dev sets' labels (`setsRun.mjs` `adaptersFor`), so a step that
 * had no unit test can be scored by the Lab's runs (Dev2, 2026-11-26: "running evals on everything"):
 *
 * - `askGate`, Before asking (`graph/nodes/askGate.js`): reads the person's text and the reply Tex is about to send and
 *   says what that reply asks of them. Its label's `to` is "pass" (asks nothing), "bypass" (something only they can
 *   answer, or an approval) or "back" / "job" (a fact Tex could find: the ladder climbs). Run alone there are no rungs
 *   to climb, so "back" and "job" are one answer here: it climbs.
 * - `egress`, the egress judge (`privacy/judge.js` `judgeWords`): whether the person's own words ask for a step that
 *   lets more people see something. Its label's `allow` is "yes" or "no"; the step it judges is the message's recorded
 *   input, `rec.egress` ({ action, workspace?, subject?, where?, offered? }), since a chat line alone does not say it.
 *
 * The reply askGate reads is the Tex rows right after the message (what Tex said there), as a label's conversation
 * records it; the words egress reads are the asker's own texts up to the message, newest last.
 */

/** The Tex rows straight after message `i`, up to the next person's message: the reply that turn sent. */
export function replyAfter(c, i) {
  const out = [];
  for (const m of c.msgs.slice(i + 1)) {
    if (!m.tex) break;
    if (!m.kind && typeof m.text === "string") out.push(m.text);
  }
  return out.join("\n");
}

/** The askGate case on message `i`: their text, and the draft (the message's recorded front door draft, else what Tex said next). */
export function askGateCase(c, i) {
  const m = c.msgs[i];
  const recorded = m.rec?.fd?.draft;
  return { ask: String(m.text ?? ""), draft: typeof recorded === "string" && recorded !== "" ? recorded : replyAfter(c, i) };
}

/** The gate's kind as the label's `to`: none passes, a fact Tex could find climbs, anything else goes to them as asked. */
export function askGateTo(kind, sure, climbAt = 0) {
  if (kind === "none") return "pass";
  if (kind === "fact" && sure >= climbAt) return "climb";
  return "bypass";
}

/** Whether the gate's answer matches the label: "back" and "job" both mean it climbs. */
export function askGateRight(label, got) {
  const want = label.to === "back" || label.to === "job" ? "climb" : label.to;
  if (want === undefined || want === "any") return { right: true, why: "" };
  const right = got === want;
  return { right, why: right ? "" : got ? `said ${got}, wanted ${label.to}` : `no answer, wanted ${label.to}` };
}

/** The egress case on message `i`: the asker's texts so far (their own words, the last few) and the step it judges. */
export function egressCase(c, i, { last = 4 } = {}) {
  const m = c.msgs[i];
  const own = c.msgs.slice(0, i + 1).filter((x) => !x.tex && !x.kind && x.who === m.who && typeof x.text === "string").map((x) => x.text);
  const step = m.rec?.egress ?? null;
  return { words: own.slice(-last).join("\n"), step };
}

export function egressRight(label, verdict) {
  if (!verdict) return { right: false, why: "no verdict" };
  const want = label.allow;
  if (want === undefined || want === "any") return { right: true, why: "" };
  const allowed = verdict.allow === true;
  const right = want === "yes" ? allowed : !allowed;
  return { right, why: right ? "" : allowed ? "allowed it, wanted it refused" : `refused it (${verdict.reason ?? ""}), wanted it allowed` };
}

/** Rough per-call price of the egress judge on Haiku at low effort, for the run's cost. */
const EGRESS_USD = 0.002;

/**
 * The two adapters over a tree: `mod(rel)` imports one of its files, `routeTraining` gives the Training module a
 * message may read (`setsRun.mjs`), `engineOf()` the Clef engine Decide is asked on.
 */
export function judgeAdapters({ mod, fake, env, training, engineOf }) {
  // The tree's config (a draft's, when the run wrote it in): each step's model, effort, context and limits.
  const configOf = async () => mod("packages/tex/gateway/agent/texConfig.js");
  return {
    askGate: async () => {
      const { askRequest, readAsk, selectorOf } = await mod("packages/tex/gateway/agent/lookupLadder.js");
      const { routerContextText } = await mod("packages/tex/gateway/agent/routerContext.js");
      const { texStep, texModel } = await configOf();
      const node = texStep("askGate");
      const ctx = Array.isArray(node.ctx) ? node.ctx : [];
      const climbAt = Number.isInteger(node.limits?.climbAt) ? node.limits.climbAt / 100 : 0;
      const model = texModel("askGate");
      if (!fake && !(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_AI_TOKEN)) {
        return () => ({ right: false, ran: false, usd: 0, why: "no Clef engine: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN are not set" });
      }
      const ai = fake ? null : await engineOf();
      return async (c, i, label) => {
        const item = askGateCase(c, i);
        if (!item.draft) return { right: false, ran: false, usd: 0, why: "no reply: add the Tex row that answered this message, or record the front door's draft" };
        if (!/\?/.test(item.draft)) {
          const got = "pass";
          return { ...askGateRight(label, got), got, want: String(label.to ?? "any"), ran: true, usd: 0 };
        }
        if (fake) return { ...askGateRight(label, label.to === "back" || label.to === "job" ? "climb" : label.to), got: label.to, want: label.to, ran: true, usd: 0 };
        const context = ctx.length > 0 ? routerContextText(ctx, { training: training(c, i), today: typeof c.msgs[i].at === "string" ? c.msgs[i].at : "" }) : "";
        const asked = askRequest({ ask: item.ask, draft: item.draft, context });
        const raw = await ai.run(model, { model: selectorOf(model), state: asked.state, questions: asked.questions }).catch(() => null);
        const read = readAsk(raw?.answers);
        const got = read ? askGateTo(read.kind, read.sure, climbAt) : null;
        return { ...askGateRight(label, got), got: got ?? "no answer", want: String(label.to ?? "any"), kind: read?.kind ?? null, sure: read?.sure ?? null, ran: true, usd: 0 };
      };
    },
    egress: async () => {
      const { judgeWords } = await mod("apps/mcp/src/privacy/judge.js");
      const { aiGatewayConfig } = await mod("packages/tex/gateway/agent/aiGateway.js");
      const config = fake ? null : aiGatewayConfig(env);
      const { texModel, texEffort } = await configOf();
      const model = texModel("egress");
      const { effort } = texEffort("egress");
      return async (c, i, label) => {
        const item = egressCase(c, i);
        if (!item.step?.action) return { right: false, ran: false, usd: 0, why: "no step to judge: record it on this message as rec.egress { action, subject? }" };
        if (fake) return { ...egressRight(label, { allow: label.allow === "yes" }), ran: true, usd: 0 };
        if (config === null) return { right: false, ran: false, usd: 0, why: "no AI gateway (AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID, AI_GATEWAY_TOKEN)" };
        const verdict = await judgeWords({ words: item.words, ...item.step }, config, { model, effort }).catch(() => null);
        return { ...egressRight(label, verdict), got: verdict ? (verdict.allow ? "yes" : "no") : "no verdict", want: String(label.allow ?? "any"), ran: true, usd: EGRESS_USD };
      };
    },
  };
}
