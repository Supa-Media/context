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
import { caseProps, casesFor, draftOf, drafts, jobCrumb, jobView, listView, notReady, tries, tryKey, type TryResult } from "./jobs/jobsView";
import { messageOf } from "./jobs/useJobsData";
import { useJobsPage, type JobsPageData } from "./jobs/useJobsPage";
import { LAB_JOB } from "./jobs/jobsModel";

const failed = (error: unknown) => toast(messageOf(error));

/** The open case, from the element's `data-id`. */
function caseFrom(el: HTMLElement, d: JobsPageData | undefined): CaseCard | null {
  return d ? (casesFor(d).find((item) => item.id === el.dataset.id) ?? null) : null;
}

/**
 * What is typed in the case panel now, kept as its draft so a redraw (a toast, a try coming back)
 * never loses it. Only when the panel on screen is this case's.
 */
function capture(c: CaseCard) {
  const draft = draftOf(c);
  if (typeof document === "undefined") return draft;
  const root = document.querySelector(".sc") ?? document;
  const when = root.querySelector<HTMLTextAreaElement>("#cw");
  // Only the same rows: after a rule was added or removed, the panel on screen is one step behind.
  if (!when || when.dataset.case !== c.id || root.querySelectorAll("[data-rule-text]").length !== draft.rules.length) return draft;
  const rules = draft.rules.map((rule, i) => ({
    kind: root.querySelector<HTMLSelectElement>(`[data-rule-kind="${i}"]`)?.value ?? rule.kind,
    text: root.querySelector<HTMLInputElement>(`[data-rule-text="${i}"]`)?.value ?? rule.text,
  }));
  const next = { name: draft.name, when: when.value, rules };
  drafts.set(c.id, next);
  return next;
}

/** Try it on live: one read-only turn of the live setup on the case, as yourself, its rules judged. */
async function tryCase(d: JobsPageData, c: CaseCard) {
  const live = d.page?.row.setup;
  const origin = gatewayOriginFrom(MCP_ENDPOINT);
  const text = d.texts.get(c.path);
  capture(c);
  if (!live || !origin || !text) return toast("Live can't be asked from here right now");
  // Try it reads the asker's own notes: never the shared workspace's, so no personal workspace, no try.
  if (d.ownWorkspace === null) return toast("Try it needs your own workspace, and this account has none");
  const testCase = parseTestList(text).cases.find((item) => item.number === c.number) ?? null;
  const question = firstQuestion(testCase) || c.name;
  const key = tryKey(c.id, live.path);
  tries.set(c.id, { key, running: true, question, answer: null, error: null, missed: [], passed: false });
  render();
  let result: TryResult;
  try {
    const grant = await d.mint({ workspaceId: d.ownWorkspace });
    const response = await fetch(`${origin}/agent/try`, {
      method: "POST",
      headers: { Authorization: `Bearer ${grant.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(tryBody(live.path, question, [], testCase, null)),
    });
    const got = readTry(live.name, question, response.status, await response.json().catch(() => null));
    const missed = got.checks.filter((check) => check.pass === false).map((check) => `${check.key} ${check.value}`);
    result = { key, running: false, question, answer: got.answer, error: got.error, missed, passed: got.error === null && missed.length === 0 };
  } catch (error) {
    result = { key, running: false, question, answer: null, error: messageOf(error), missed: [], passed: false };
  }
  // A newer try (or a change of live) since this one started wins.
  if (tries.get(c.id)?.key === key && tries.get(c.id)?.running) tries.set(c.id, result);
  render();
}

export const jobsPage: ConsolePage<JobsPageData> = {
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
    const c = d ? casesFor(d).find((item) => item.id === x) : undefined;
    // Keep what is typed: the panel is drawn again from its draft, never from the note alone.
    if (c) capture(c);
    return caseProps(d, x);
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
        // Every try was answered by the setup that just stopped being live.
        tries.clear();
        toast(`${candidate.name} is live`);
        d.reload();
        go("jobs", [page.job.key, "setups"]);
      } catch (error) {
        failed(error);
      }
    },
    runboth: async (el, d) => {
      if (!d?.page) return;
      const opened = await d.writes.runBoth();
      if (!opened) return toast("The test bench didn't open");
      toast(`Opened the test bench: run live and ${el.dataset.id} on ${d.page.job.key}`);
      go("jobs", [d.page.job.key, "runs"]);
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
        const block = await d.writes.deleteCase(c.path, c.number);
        drafts.delete(c.id);
        d.rereadTests();
        // Undo puts the one case back into the list as it is by then, keeping any edit made since.
        toast("Case deleted", () => {
          void d.writes.restoreCase(c.path, block).then(d.rereadTests, failed);
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
    tryit: (el, d) => {
      const c = caseFrom(el, d);
      if (!c || !d) return;
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
