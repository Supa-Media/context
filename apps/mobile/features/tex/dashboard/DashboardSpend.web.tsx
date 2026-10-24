/**
 * Spend on tex.lc/admin, as Cloudflare's AI gateway priced it
 * (`api.functions.texSpend.report`): by day, by what the money went on, and by
 * model with how much of the input came from cache, which costs a fraction of
 * fresh input. Our own estimate from token counts sits beside it as a check,
 * and is what the card shows when Cloudflare is not connected.
 */

import { texDashboardColors as C } from "../../design/tokens/texDashboardColors";
import { AreaChart, Axis, Bar, Card } from "./DashboardPanels.web";
import { formatMicroUsd, formatTokens, modelLabel, type TexReport } from "./model";
import { costOf } from "./insights";
import { spendByDay, windowDayList, type TexSpend } from "./trends";

/** What each gateway label paid for, as staff say it. */
export const JOB_LABELS: Record<string, string> = {
  texts: "Texts",
  "texts-group": "Group texts",
  heartbeat: "Check-ins",
  housekeeping: "Housekeeping",
  dreams: "Dreams",
  reflect: "Reflecting",
  memory_nudge: "Memory nudges",
  image: "Pictures",
  "self-review": "Self-review",
  "handback-judge": "Hand-back judge",
  "handback-miner": "Hand-back miner",
  "egress-judge": "Approval judge",
  "mail-checker": "Mail checker",
};

const usd = (value: number) => formatMicroUsd(value * 1_000_000);

export function SpendPanel({ report, spend }: { report: TexReport; spend: TexSpend | undefined }) {
  const days = windowDayList(report);
  const money = spendByDay(report, spend, days);
  const live = spend !== undefined && spend.configured && spend.error === null ? spend : null;
  const estimate = formatMicroUsd(report.turns.costMicroUsd);
  return (
    <Card
      title="Spend"
      meta={live ? "Cloudflare's AI Gateway count · cache priced at its own rates · staging included" : "our estimate at list price"}
      testID="tex-dashboard-spend"
    >
      <AreaChart values={money.values.map((value) => value ?? 0)} color={C.ink} fill={C.tray} label="Spend per day" />
      <Axis days={days} />
      {live ? (
        <p className="td-spend-note" data-testid="tex-dashboard-spend-compare">
          <b className="num">{usd(live.totalUsd)}</b> billed for Tex in this window. Our own estimate from token counts says {estimate}, and only covers turns since Oct 24.
          {live.testsUsd > 0 ? ` Test runs cost another ${usd(live.testsUsd)}, not counted here.` : ""}
          {days[0] < live.keptFrom ? " Cloudflare keeps about two months, so the oldest days are blank." : ""}
        </p>
      ) : (
        <p className="td-spend-note" data-testid="tex-dashboard-spend-compare">
          {spend === undefined
            ? "Asking Cloudflare for the billed figures…"
            : spend.configured
              ? `Cloudflare could not be asked (${spend.error}), so this is our estimate: list price times each turn's token counts, which misses side calls.`
              : "Cloudflare's usage count isn't connected on this deployment, so this is our estimate: list price times each turn's token counts, which misses side calls."}
        </p>
      )}
      {live && live.jobs.length > 0 ? (
        <div className="td-sep">
          <span className="td-small-h">What it went on</span>
          <div className="td-bars">
            {live.jobs.slice(0, 8).map((job) => (
              <Bar key={job.job} label={JOB_LABELS[job.job] ?? job.job} share={job.usd / live.jobs[0].usd} value={`${usd(job.usd)} · ${job.requests.toLocaleString("en-US")} calls`} />
            ))}
          </div>
        </div>
      ) : null}
      {live && live.models.length > 0 ? (
        <div className="td-sep">
          <span className="td-small-h">By model · share of input read from cache</span>
          <div className="td-bars">
            {live.models.slice(0, 6).map((m) => {
              const input = m.freshInputTokens + m.cacheReadTokens + m.cacheWriteTokens;
              const cached = input === 0 ? null : m.cacheReadTokens / input;
              return (
                <Bar
                  key={m.model}
                  label={modelLabel(m.model)}
                  share={m.usd / live.models[0].usd}
                  value={`${usd(m.usd)} · ${formatTokens(input)} in, ${cached === null ? "no cache" : `${Math.round(cached * 100)}% cached`} · ${formatTokens(m.outputTokens)} out`}
                />
              );
            })}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * What a text costs, near the top of the page: billed spend on answering
 * people over the texts Tex answered, and where the rest went (`costOf`).
 */
export function CostPanel({ report, spend, days }: { report: TexReport; spend: TexSpend | undefined; days: number }) {
  const cost = costOf(report, spend, days);
  const total = cost.textsUsd + cost.otherUsd + cost.testsUsd;
  const part = (value: number) => `${total === 0 ? 0 : (value / total) * 100}%`;
  return (
    <Card title="What a text costs" meta={cost.billed ? "billed by Cloudflare, cache included" : spend === undefined ? "asking Cloudflare…" : "our estimate at list price"} testID="tex-dashboard-cost">
      <div className="td-cost">
        <div>
          <span className="td-trend-value num">{cost.perText === null ? "—" : usd(cost.perText)}</span>
          <p className="td-meta">
            per text Tex answered · {cost.texts.toLocaleString("en-US")} texts, {usd(cost.textsUsd)}
          </p>
        </div>
        {cost.billed ? (
          <div className="td-cost-split">
            <div className="td-split" role="img" aria-label={`Texts ${usd(cost.textsUsd)}, everything else ${usd(cost.otherUsd)}, tests ${usd(cost.testsUsd)}`}>
              <div style={{ width: part(cost.textsUsd), background: C.blue }} />
              <div style={{ width: part(cost.otherUsd), background: C.ochre }} />
              <div style={{ width: part(cost.testsUsd), background: C.hair }} />
            </div>
            <div className="td-legend">
              <span><span className="td-dot" style={{ background: C.blue }} />Answering texts {usd(cost.textsUsd)}</span>
              <span><span className="td-dot" style={{ background: C.ochre }} />Check-ins, dreams and judges {usd(cost.otherUsd)}</span>
              <span><span className="td-dot" style={{ background: C.hair }} />Tests {usd(cost.testsUsd)}</span>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
