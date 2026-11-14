/**
 * Jobs: the artifact's `P.jobs` (staff console redesign, 2026-11-14), every AI
 * job but Tex, whose row opens the Lab. Read from and written to `@context-lc
 * ai/` (`./jobs/`): cases are the job's test lists, setups and runs are the
 * bench's notes, Make it live promotes a setup into `ai/production/`.
 */
import { MCP_ENDPOINT } from "../../../console/placeholderData";
import { gatewayOriginFrom } from "../../../meetings/gateway";
import { firstQuestion, readTry, tryBody } from "../../AiTryIt";
import { parseTestList } from "../../testList";
import { S, closeProps, go, render, sel, setF, toast } from "../state";
import type { ConsolePage } from "../types";
import { caseId, type CaseCard } from "./jobs/jobsModel";
import { caseProps, casesFor, draftOf, drafts, jobCrumb, jobView, listView, notReady, tries } from "./jobs/jobsView";
import { messageOf } from "./jobs/useJobsData";
import { useJobsPage, type JobsPageData } from "./jobs/useJobsPage";
import { LAB_JOB } from "./jobs/jobsModel";

const failed = (error: unknown) => toast(messageOf(error));

/** The open case, from the element's `data-id`. */
function caseFrom(el: HTMLElement, d: JobsPageData | undefined): CaseCard | null {
  return d ? (casesFor(d).find((item) => item.id === el.dataset.id) ?? null) : null;
}

/** What is typed in the case panel now, kept as its draft so a redraw does not lose it. */
function capture(c: CaseCard) {
  const draft = draftOf(c);
  const root = document.querySelector(".sc") ?? document;
  const when = root.querySelector<HTMLTextAreaElement>("#cw");
  const rules = draft.rules.map((rule, i) => ({
    kind: root.querySelector<HTMLSelectElement>(`[data-rule-kind="${i}"]`)?.value ?? rule.kind,
    text: root.querySelector<HTMLInputElement>(`[data-rule-text="${i}"]`)?.value ?? rule.text,
  }));
  const next = { name: draft.name, when: when ? when.value : draft.when, rules };
  drafts.set(c.id, next);
  return next;
}

/** Try it on live: one read-only turn of the live setup on the case, as yourself, its rules judged. */
async function tryCase(d: JobsPageData, c: CaseCard) {
  const live = d.page?.row.setup;
  const origin = gatewayOriginFrom(MCP_ENDPOINT);
  const text = d.texts.get(c.path);
  if (!live || !origin || !text) {
    tries.set(c.id, { key: c.id, running: false, question: c.name, answer: null, error: "Live can't be asked from here right now.", missed: [], passed: false });
    return render();
  }
  const testCase = parseTestList(text).cases.find((item) => item.number === c.number) ?? null;
  const question = firstQuestion(testCase) || c.name;
  const key = `${c.id}|${live.path}`;
  tries.set(c.id, { key, running: true, question, answer: null, error: null, missed: [], passed: false });
  render();
  try {
    const workspaceId = d.ownWorkspace ?? d.workspaceId!;
    const grant = await d.mint({ workspaceId });
    const response = await fetch(`${origin}/agent/try`, {
      method: "POST",
      headers: { Authorization: `Bearer ${grant.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(tryBody(live.path, question, [], testCase, null)),
    });
    const got = readTry(live.name, question, response.status, await response.json().catch(() => null));
    const missed = got.checks.filter((check) => check.pass === false).map((check) => `${check.key} ${check.value}`);
    tries.set(c.id, { key, running: false, question, answer: got.answer, error: got.error, missed, passed: got.error === null && missed.length === 0 });
  } catch (error) {
    tries.set(c.id, { key, running: false, question, answer: null, error: messageOf(error), missed: [], passed: false });
  }
  render();
}

const page: ConsolePage<JobsPageData> = {
  key: "jobs",
  filters: { who: "all" },
  windowed: false,
  useData: useJobsPage,
  render: (d) => {
    const wait = notReady(d);
    if (wait) return wait;
    const j = S.subs[0];
    return j && j !== "activity" && j !== LAB_JOB ? jobView(d!) : listView(d!);
  },
  props: (d, x) => {
    const html = caseProps(d, x);
    const c = d ? casesFor(d).find((item) => item.id === x) : undefined;
    // The panel opens with live's answer to the case, as the artifact draws it.
    if (html && d && c && d.page?.row.setup && !tries.has(c.id)) {
      // The shell asks for the panel more than once a draw: hold the place now so it is asked once.
      tries.set(c.id, { key: c.id, running: true, question: c.name, answer: null, error: null, missed: [], passed: false });
      queueMicrotask(() => void tryCase(d, c));
    }
    return html;
  },
  crumb: jobCrumb,
  acts: {
    jobsv: (el) => go("jobs", el.dataset.v === "activity" ? ["activity"] : []),
    who: (el) => setF("who", el.dataset.v!),
    jtab: (el) => go("jobs", [S.subs[0]!, el.dataset.v === "cases" ? "" : el.dataset.v!]),
    asklive: () => {
      S.confirm = "live";
      render();
    },
    makelive: async (el, d) => {
      const page = d?.page;
      const candidate = d?.candidate;
      if (!page || !candidate || candidate.name !== el.dataset.id) return;
      S.confirm = null;
      try {
        await d.writes.makeLive(page, candidate);
        toast(`${candidate.name} is live`);
        d.reload();
        go("jobs", [page.job.key, "setups"]);
      } catch (error) {
        failed(error);
      }
    },
    runboth: (el, d) => {
      d?.writes.runBoth();
      toast(`Opened the test bench: run live and ${el.dataset.id} on ${d?.page?.job.key ?? "this job"}`);
    },
    newcase: async (_el, d) => {
      const test = d?.page?.row.tests[0];
      if (!d || !test) return toast("This job has no test list to add a case to");
      try {
        const number = await d.writes.newCase(test.path);
        d.rereadTests();
        sel(caseId(test.name, number));
      } catch (error) {
        failed(error);
      }
    },
    dupcase: async (el, d) => {
      const c = caseFrom(el, d);
      if (!c || !d) return;
      try {
        const number = await d.writes.copyCase(c.path, c.number);
        d.rereadTests();
        toast("Duplicated");
        sel(caseId(c.test, number));
      } catch (error) {
        failed(error);
      }
    },
    delcase: async (el, d) => {
      const c = caseFrom(el, d);
      if (!c || !d) return;
      try {
        const before = await d.writes.deleteCase(c.path, c.number);
        drafts.delete(c.id);
        d.rereadTests();
        toast("Case deleted", () => {
          void d.writes.restoreList(c.path, before).then(d.rereadTests, failed);
        });
        closeProps(null);
      } catch (error) {
        failed(error);
      }
    },
    addrule: (el, d) => {
      const c = caseFrom(el, d);
      if (!c) return;
      const draft = capture(c);
      drafts.set(c.id, { ...draft, rules: [...draft.rules, { kind: "must", text: "" }] });
      render();
    },
    rmrule: (el, d) => {
      const c = caseFrom(el, d);
      if (!c) return;
      const draft = capture(c);
      drafts.set(c.id, { ...draft, rules: draft.rules.filter((_, i) => i !== Number(el.dataset.i)) });
      render();
    },
    saved: async (el, d) => {
      const c = caseFrom(el, d);
      if (!c || !d) return;
      const draft = capture(c);
      try {
        await d.writes.saveCase(c.path, c.number, draft);
        drafts.delete(c.id);
        tries.delete(c.id);
        d.rereadTests();
        toast("Saved");
      } catch (error) {
        failed(error);
      }
    },
    tryagain: (el, d) => {
      const c = caseFrom(el, d);
      if (!c || !d) return;
      tries.delete(c.id);
      void tryCase(d, c);
    },
    newsetup: async (_el, d) => {
      if (!d?.page) return;
      try {
        const name = await d.writes.newExperiment(d.page);
        toast(`Copied live into ${name}`);
        d.reload();
      } catch (error) {
        failed(error);
      }
    },
  },
};

/** The registry holds pages of every data shape; this one's acts and props take its own. */
export const jobsPage = page as unknown as ConsolePage;
