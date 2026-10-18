/** How Settings › Built-in folders and "Use this folder as…" shape the server's answer (`folderJobsView.ts`). */
import { describe, expect, test } from "@jest/globals";
import { groupedJobs, inboxPartsLine, jobChoicesFor, pathCrumbs, type FolderJobsAnswer } from "../features/console/files/folderJobsView";

const row = (job: string, group: string, path: string | null, canChange = true) => ({
  job, label: job[0]!.toUpperCase() + job.slice(1), group, line: `${job} line`, path, canChange, canRemove: false,
});

const answer: FolderJobsAnswer = {
  jobs: [row("inbox", "needed", "Capture"), row("archive", "needed", "Old"), row("tex", "made", "Life/Assistant"), row("website", "made", "website", false), row("clients", "optional", null)],
  inboxParts: [{ name: "email", label: "Email", path: "Capture/email" }, { name: "google-chat", label: "Google Chat", path: null }],
  guesses: [],
  missingNeeded: [],
  folders: [],
};

describe("folderJobsView", () => {
  test("jobs are drawn in three groups, in order", () => {
    expect(groupedJobs(answer).map((group) => [group.label, group.jobs.map((job) => job.job)])).toEqual([
      ["Needed", ["inbox", "archive"]],
      ["Made when used", ["tex", "website"]],
      ["Optional", ["clients"]],
    ]);
  });

  test("a nested path reads as crumbs, and the Inbox names its own folders once", () => {
    expect(pathCrumbs("Life/Personal/Assistant")).toBe("Life › Personal › Assistant");
    expect(inboxPartsLine(answer)).toBe("Email, Google Chat stay in the Inbox and can't be moved. Add your own notes and folders beside them.");
  });

  test("a nested folder is never offered Archive or Website, and says which folder does each job now", () => {
    const choices = jobChoicesFor(answer, "Work/Clients");
    expect(choices.map((choice) => choice.job)).toEqual(["inbox", "tex", "clients"]);
    expect(choices.find((choice) => choice.job === "tex")?.now).toBe("Life/Assistant");
    expect(jobChoicesFor(answer, "Old").find((choice) => choice.job === "archive")).toMatchObject({ current: true, now: null });
  });
});
