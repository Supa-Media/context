/**
 * The Jobs page's HTML: the artifact's `P.jobs`, `jobPage` and
 * `P.jobs.props`, markup and classes as the artifact writes them, over the
 * real rows from `./jobsModel`. Every value from a note goes through `esc`.
 */

import { confirmBox, esc, ic, kpi, lines, panel, pill, seg, spark } from "../../kit";
import { S } from "../../state";
import { promptDiff } from "../../../aiModel";
import {
  LAB_URL,
  RULE_KINDS,
  activityRows,
  caseGroups,
  compareView,
  filterActivity,
  jobCases,
  jobHead,
  jobList,
  runRows,
  setupRows,
  type CaseCard,
  type WhoFilter,
} from "./jobsModel";
import type { CaseDraft } from "./caseEdits";
import type { JobsPageData } from "./useJobsPage";

/** What the case panel holds while it is being edited, by case id; kept across redraws. */
export const drafts = new Map<string, CaseDraft>();

/** Try it on live, by case id: the reply and the checks, or that it is running. */
export interface TryResult {
  key: string;
  running: boolean;
  question: string;
  answer: string | null;
  error: string | null;
  missed: string[];
  passed: boolean;
}
export const tries = new Map<string, TryResult>();

/** One sentence where the page has nothing to draw yet. */
function quiet(text: string) {
  return `<div class="pn"><div class="pnb"><div class="sub">${esc(text)}</div></div></div>`;
}

export function notReady(d: JobsPageData | undefined): string | null {
  if (!d) return quiet("Reading the AI notes…");
  switch (d.state.kind) {
    case "loading":
      return quiet("Reading the AI notes…");
    case "notEditor":
      return quiet("Jobs is for the people who can edit @context-lc.");
    case "unavailable":
      return quiet("The AI notes can't be read right now.");
    case "failed":
      return quiet(`The AI notes didn't load: ${d.state.message}`);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The list and Activity

export function listView(d: JobsPageData): string {
  const catalog = d.catalog!;
  const jobs = jobList(catalog, d.reads, d.now);
  const activity = activityRows(catalog, d.reads, d.now);
  const j = S.subs[0];
  const tabs = seg("View", [["list", "Jobs", jobs.length], ["activity", "Activity", activity.length]], j === "activity" ? "activity" : "list", "jobsv");
  if (j === "activity") {
    const who = (S.f.who || "all") as WhoFilter;
    const rows = filterActivity(activity, who);
    return (
      `<div class="tools">${tabs}${seg("Who", [["all", "Everyone"], ["agents", "Agents"], ["people", "People"], ["bench", "Test bench"]], who, "who")}</div>` +
      `<div class="pn"><div class="tbl"><table><tr><th>When</th><th>Who</th><th class="hp">Job</th><th>What happened</th></tr>${
        rows.map((a) => `<tr><td>${esc(a.when)}</td><td>${esc(a.who)}</td><td class="hp">${esc(a.job)}</td><td class="wrap">${esc(a.what)}</td></tr>`).join("") ||
        '<tr><td colspan="4" class="empty">Nothing from them yet</td></tr>'
      }</table></div></div>`
    );
  }
  return (
    `<div class="tools">${tabs}</div>` +
    `<div class="pn"><div class="tbl"><table><tr><th>Job</th><th class="hp">Live setup</th><th class="r">Score</th><th class="hp">Trend</th><th class="hp">Last run</th><th>Next</th></tr>${jobs
      .map((x) =>
        x.lab
          ? `<tr><td><b>${esc(x.name)}</b></td><td colspan="4" class="hp"><span class="sub">Its models, prompt and cases live in the Lab</span></td><td><a class="link" href="${LAB_URL}" target="_blank" rel="noopener">Open the Lab ↗</a></td></tr>`
          : `<tr class="click" tabindex="0" data-act="go" data-p="jobs" data-subs="${esc(x.key)}"><td><b>${esc(x.name)}</b></td><td class="mono hp">${esc(x.live ?? "—")}</td><td class="r">${x.score === null ? "—" : `${x.score}%`}</td><td class="hp">${x.trend.length > 1 ? spark(x.trend, "c2") : ""}</td><td class="hp">${esc(x.last ?? "—")}</td><td>${x.cand ? pill("a setup beats live", "acc") : x.next ? `<span class="sub">${esc(x.next)}</span>` : ""}</td></tr>`,
      )
      .join("")}</table></div></div>`
  );
}

// ---------------------------------------------------------------------------
// A job

export const casesFor = (d: JobsPageData): CaseCard[] => (d.page ? jobCases(d.page.row.tests, d.texts) : []);

export function jobView(d: JobsPageData): string {
  const page = d.page;
  if (!page) return quiet(`No job called ${S.subs[0]}.`);
  const tab = S.subs[1] || "cases";
  const head = jobHead(page);
  const cases = casesFor(d);
  const setups = setupRows(page);
  const runs = runRows(page);
  const trend = head.trend;
  const top =
    `<div class="kpis">${kpi("Live setup", `<span class="mono" style="font-size:16px">${esc(head.live)}</span>`, esc(head.since))}${kpi("Score", esc(head.score), esc(head.checks))}${kpi("Cost · speed", esc(head.costSpeed), "per run")}</div>` +
    panel(
      "j-score",
      "Score over time",
      "",
      trend.length > 1
        ? lines([{ v: trend, c: "c2", area: true }], { fmt: (v) => `${v}%`, lo: Math.max(0, Math.floor((Math.min(...trend) - 5) / 10) * 10), xl: ["first run", "latest"] })
        : '<div class="sub">Two runs draw a line; this job has fewer.</div>',
    );
  const tabs = seg("Part", [["cases", "Cases", cases.length], ["setups", "Setups", setups.length], ["runs", "Runs", runs.length]], tab === "compare" ? "setups" : tab, "jtab");
  let body = "";
  if (tab === "cases") {
    const unread = page.row.tests.some((test) => !d.texts.has(test.path));
    body = caseGroups(cases)
      .map(({ group, cases: list }) =>
        panel(
          `jc-${group.replace(/[^A-Za-z0-9-]/g, "-")}`,
          esc(group),
          String(list.length),
          `<div class="list">${list.map((c) => `<button class="card" data-act="sel" data-id="${esc(c.id)}" aria-selected="${S.x === c.id}"><span class="t">${esc(c.name)}</span><span class="sub">${esc(c.when) || "not written yet"}</span></button>`).join("")}</div>`,
        ),
      )
      .join("");
    if (body === "") body = quiet(unread ? "Reading its cases…" : page.row.tests.length === 0 ? "This job has no test list yet." : "No cases yet.");
  }
  if (tab === "setups") {
    body = `<div class="pn"><div class="tbl"><table><tr><th>Setup</th><th class="hp">What changed</th><th class="r">Passed</th><th>Against live</th><th></th></tr>${setups
      .map(
        (s) =>
          `<tr><td class="mono">${esc(s.name)}</td><td class="wrap hp">${s.live ? '<span class="sub">live</span>' : esc(s.change ?? "")}</td><td class="r">${esc(s.passed)}</td><td>${pill(s.vs, s.tone)}</td><td class="r">${s.canCompare ? `<button class="ghost" data-act="go" data-p="jobs" data-subs="${esc(page.job.key)},compare,${esc(s.name)}">Compare</button>` : ""}</td></tr>`,
      )
      .join("") || '<tr><td colspan="5" class="empty">No setups yet</td></tr>'}</table></div></div>`;
  }
  if (tab === "runs") {
    body = `<div class="pn"><div class="tbl"><table><tr><th>Run</th><th class="hp">Day</th><th>Live</th><th>Best other</th><th>Every bar</th></tr>${runs
      .map(
        (r) =>
          `<tr><td>${esc(r.name)}</td><td class="hp">${esc(r.day)}</td><td>${esc(r.live)}</td><td>${esc(r.best)}</td><td>${r.bars === "passed" ? pill("passed", "ok") : r.bars === "failed" ? pill("failed", "bad") : pill("running", "acc")}</td></tr>`,
      )
      .join("") || '<tr><td colspan="5" class="empty">No runs yet</td></tr>'}</table></div></div>`;
  }
  if (tab === "compare") body = compareBody(d);
  return (
    top +
    `<div class="tools">${tabs}<span class="spacer"></span>${tab === "cases" ? '<button class="ghost" data-act="newcase">New case</button>' : ""}${tab === "setups" ? '<button class="ghost" data-act="newsetup">New experiment</button>' : ""}</div>` +
    body
  );
}

function compareBody(d: JobsPageData): string {
  const page = d.page!;
  const s = d.candidate;
  if (!s) return quiet("No setup to compare with live yet.");
  const v = compareView(page, s, d.replies);
  const diff = d.liveText !== null && d.candidateText !== null ? promptDiff(d.liveText, d.candidateText, 1) : null;
  const added = diff ? diff.filter((line) => line.kind === "added").length : 0;
  const gone = diff ? diff.filter((line) => line.kind === "gone").length : 0;
  const changed = diff
    ? diff
        .filter((line) => line.kind === "added" || line.kind === "gone")
        .map((line) => (line.kind === "added" ? `<span style="color:var(--ok)">+ ${esc(line.text)}</span>` : line.kind === "gone" ? `<span style="color:var(--bad)">- ${esc(line.text)}</span>` : ""))
        .join("\n") || '<span class="sub">The prompt is the same as live\'s.</span>'
    : '<span class="sub">Reading both prompts…</span>';
  const card = (c: (typeof v.differ)[number]) => {
    const miss = pill(`misses: ${c.rule ?? "a rule"}`, "bad");
    return `<div class="ppb"><b>${esc(c.title)}</b><div class="row sub">Live ${c.missedBy === "live" ? miss : ""}</div><div class="bub">${esc(c.liveReply ?? "(reply not saved)")}</div><div class="sub">${esc(v.name)} ${c.missedBy === "setup" ? miss : ""}</div><div class="bub tex">${esc(c.setupReply ?? "(reply not saved)")}</div></div>`;
  };
  const live = page.row.setup;
  return (
    `<div class="kpis">${kpi(`Live · ${esc(v.liveName)}`, esc(v.livePassed))}${kpi(esc(v.name), esc(v.passed), pill(v.vs, v.tone))}${kpi("How sure", esc(v.sure), esc(v.sureDetail))}</div>` +
    panel("cmp-diff", "Cases that differ", String(v.differ.length), v.differ.length ? `<div class="grid2">${v.differ.map(card).join("")}</div>` : '<div class="sub">No case came out differently in its latest round.</div>') +
    panel("cmp-what", "What changed", diff ? `+${added} −${gone} lines` : "", `<pre class="mono" style="white-space:pre-wrap;margin:0;line-height:1.6">${changed}</pre>`) +
    `<div class="row">${
      S.confirm === "live"
        ? confirmBox(`Replace live ${esc(v.liveName)} with ${esc(v.name)}?`, "Make it live", "makelive", v.name)
        : `<button class="primary" data-act="asklive" ${v.canGoLive && live ? "" : `disabled title="${esc(v.blocked ?? "Only a setup that beats live can go live")}"`}>Make it live</button><button class="ghost" data-act="runboth" data-id="${esc(v.name)}">Run both again</button>`
    }</div>`
  );
}

export function jobCrumb(d: JobsPageData | undefined): string {
  if (S.subs[0] === undefined || S.subs[0] === "activity") return "";
  const name = d?.page?.job.label ?? S.subs[0];
  let parts = `<span class="sep">/</span><button data-act="go" data-p="jobs" data-subs="${esc(S.subs[0])}">${esc(name)}</button>`;
  if (S.subs[1] === "compare") parts += `<span class="sep">/</span><span>${esc(S.subs[2] || d?.candidate?.name || "")}</span>`;
  return parts;
}

// ---------------------------------------------------------------------------
// The case panel

export function draftOf(c: CaseCard): CaseDraft {
  return drafts.get(c.id) ?? { name: c.name, when: c.when, rules: c.rules.map((rule) => ({ kind: rule.kind, text: rule.text })) };
}

export function caseProps(d: JobsPageData | undefined, id: string): string | null {
  if (!d?.page) return null;
  const c = casesFor(d).find((item) => item.id === id);
  if (!c) return null;
  const draft = draftOf(c);
  const kinds = (kind: string) => [...new Set([...RULE_KINDS, kind])];
  const tried = tries.get(c.id);
  const tryBody = !d.page.row.setup
    ? '<div class="sub">Nothing is live on this job to try.</div>'
    : !tried || tried.running
      ? `<div class="thr"><div class="bub">${esc(draft.when || draft.name || "…")}</div><div class="bub tex">…</div></div><span class="sub">Asking live…</span>`
      : tried.error
        ? `<div class="sub">${esc(tried.error)}</div><button class="link" data-act="tryagain" data-id="${esc(c.id)}">Try again</button>`
        : `<div class="thr"><div class="bub">${esc(tried.question)}</div><div class="bub tex">${esc(tried.answer?.trim() ? tried.answer : "(stays quiet)")}</div></div>${tried.passed ? pill("passes every rule", "ok") : pill(`misses: ${tried.missed[0] ?? "a rule"}`, "bad")}`;
  return `<div class="pph"><h3 tabindex="-1">${esc(draft.name)}</h3><button class="ib sm" data-act="close" aria-label="Close">${ic("x")}</button></div>
 <label class="field">When this happens<textarea id="cw">${esc(draft.when)}</textarea></label>
 <div class="ppb"><div class="h">Rules</div>${draft.rules
   .map(
     (rule, i) =>
       `<div class="row"><select class="search" style="max-width:110px;flex:none" aria-label="Kind of rule" data-rule-kind="${i}">${kinds(rule.kind).map((o) => `<option ${o === rule.kind ? "selected" : ""}>${esc(o)}</option>`).join("")}</select><input class="search" value="${esc(rule.text)}" style="max-width:none" aria-label="Rule" data-rule-text="${i}"><button class="ib sm" data-act="rmrule" data-id="${esc(c.id)}" data-i="${i}" aria-label="Remove rule">${ic("x")}</button></div>`,
   )
   .join("")}<button class="link" data-act="addrule" data-id="${esc(c.id)}">+ Add a rule</button></div>
 <div class="ppb"><div class="h">Try it on live</div>${tryBody}</div>
 <div class="row"><button class="primary" data-act="saved" data-id="${esc(c.id)}">Save</button><button class="ghost" data-act="dupcase" data-id="${esc(c.id)}">Duplicate</button><button class="ghost danger" data-act="delcase" data-id="${esc(c.id)}">Delete</button></div>`;
}
