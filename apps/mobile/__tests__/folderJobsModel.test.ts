/**
 * Which loaded folder does which job, and putting folders in order
 * (`jobIcons/folderJobs.ts`, `jobIcons/marker.ts`).
 *
 * SABOTAGE: drop the `jobs.size > 0` guard in `listingJobs` → "a listing's own
 * jobs win over names" fails. Putting rows in order is `levelOrder.test.ts`.
 */
import { describe, expect, test } from "@jest/globals";
import {
  builtInLine,
  jobFolder,
  jobOfPath,
  listingJobs,
  loadedJobs,
  websiteFolder,
  type JobEntry,
} from "../features/console/files/jobIcons/folderJobs";
import { setJobFoldersNow } from "../features/console/files/jobIcons/jobFoldersNow";
import { isWebsiteFolder } from "../features/console/website/PublishWebsite";
import { isNestedJobIcon, jobIconMarker, jobOfIcon } from "../features/console/files/jobIcons/marker";

const folder = (path: string, over: Partial<JobEntry> = {}): JobEntry => ({
  kind: "folder",
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  ...over,
});
const file = (path: string): JobEntry => ({ kind: "file", path, name: path.slice(path.lastIndexOf("/") + 1) });

describe("jobs from listings", () => {
  test("a listing's own jobs win over names: a renamed Inbox is the Inbox, an own `inbox` is not", () => {
    const root = { entries: [folder("Capture", { role: "inbox" }), folder("inbox"), folder("1-projects", { role: "projects" })] };
    const jobs = listingJobs("", root);
    expect(jobs.get("Capture")).toBe("inbox");
    expect(jobs.has("inbox")).toBe(false);
    expect(jobs.get("1-projects")).toBe("projects");
  });

  test("a root listing with no job anywhere (offline mirror, demo) falls back to names", () => {
    const jobs = listingJobs("", { entries: [folder("0-inbox"), folder("Recipes"), folder("website"), folder("4-archive"), file("todo.md")] });
    expect(Object.fromEntries(jobs)).toEqual({ "0-inbox": "inbox", website: "website", "4-archive": "archive" });
  });

  test("below the root a name is only a name, and a job on an entry is a job", () => {
    expect(listingJobs("1-projects", { entries: [folder("1-projects/inbox")] }).size).toBe(0);
    const moved = listingJobs("1-projects", { entries: [folder("1-projects/Capture", { role: "inbox" })] });
    expect(moved.get("1-projects/Capture")).toBe("inbox");
  });

  test("jobOfPath: a job, none, or unknown before the listing has loaded", () => {
    const listings = { "": { entries: [folder("Capture", { role: "inbox" }), folder("Recipes")] } };
    expect(jobOfPath(listings, "Capture")).toBe("inbox");
    expect(jobOfPath(listings, "Recipes")).toBeNull();
    expect(jobOfPath(listings, "Recipes/soups")).toBeUndefined();
  });

  test("jobFolder finds the Inbox by job, wherever it went, and falls back to the old name", () => {
    expect(jobFolder({}, "inbox", "0-inbox")).toBe("0-inbox");
    const renamed = { "": { entries: [folder("Capture", { role: "inbox" }), folder("9-archive", { role: "archive" })] } };
    expect(jobFolder(renamed, "inbox", "0-inbox")).toBe("Capture");
    expect(jobFolder(renamed, "archive", "9-archive")).toBe("9-archive");
    const nested = {
      "": { entries: [folder("1-projects", { role: "projects" })] },
      "1-projects": { entries: [folder("1-projects/Capture", { role: "inbox" })] },
    };
    expect(jobFolder(nested, "inbox", "0-inbox")).toBe("1-projects/Capture");
    expect(loadedJobs(nested).get("1-projects/Capture")).toBe("inbox");
  });

  test("Publish goes on the website's folder wherever it is nested, and on `website` until one has loaded", () => {
    expect(websiteFolder({})).toBe("website");
    const nested = {
      "": { entries: [folder("Work", { role: null }), folder("1-projects", { role: "projects" })] },
      Work: { entries: [folder("Work/site", { role: "website" })] },
    };
    expect(websiteFolder(nested)).toBe("Work/site");
    setJobFoldersNow({ inbox: "0-inbox", archive: "9-archive", website: websiteFolder(nested) });
    expect(isWebsiteFolder("Work/site")).toBe(true);
    expect(isWebsiteFolder("website")).toBe(false);
    setJobFoldersNow({ inbox: "0-inbox", archive: "9-archive", website: "website" });
    expect(isWebsiteFolder("website")).toBe(true);
  });

  test("a nested Website opened before its parent has listed knows its job from its own listing", () => {
    const opened = {
      "": { entries: [folder("areas", { role: "areas" })] },
      "areas/website": { entries: [file("areas/website/index.md")], role: "website" },
    };
    expect(jobOfPath(opened, "areas/website")).toBe("website");
    expect(loadedJobs(opened).get("areas/website")).toBe("website");
    expect(websiteFolder(opened)).toBe("areas/website");
    setJobFoldersNow({ inbox: "0-inbox", archive: "9-archive", website: websiteFolder(opened) });
    expect(isWebsiteFolder("areas/website")).toBe(true);
    setJobFoldersNow({ inbox: "0-inbox", archive: "9-archive", website: "website" });
    // Once the parent has listed, the parent's entry is the word, even if the stale own listing says otherwise.
    const listedNow = { ...opened, areas: { entries: [folder("areas/website", { role: null })] } };
    expect(jobOfPath(listedNow, "areas/website")).toBeNull();
    expect(websiteFolder(listedNow)).toBe("website");
  });
});

describe("the drawn icon's marker", () => {
  test("round-trips every job, and nothing else reads as one", () => {
    expect(jobOfIcon(jobIconMarker("inbox"))).toBe("inbox");
    expect(jobOfIcon(jobIconMarker("meetings"))).toBe("meetings");
    for (const other of [null, undefined, "📥", ":party:", "context:tex", "context:job:", "context:job:taxes"]) {
      expect(jobOfIcon(other)).toBeNull();
    }
  });

  test("a folder inside another is marked nested, drawn in the text colour; only the top is blue (owner, 2026-10-26)", () => {
    expect(jobOfIcon(jobIconMarker("website", true))).toBe("website");
    expect(isNestedJobIcon(jobIconMarker("website", true))).toBe(true);
    expect(isNestedJobIcon(jobIconMarker("website"))).toBe(false);
    expect(isNestedJobIcon("context:job-nested:taxes")).toBe(false);
    expect(isNestedJobIcon(null)).toBe(false);
    // Tex's folder draws Tex himself, nested or not.
    expect(jobIconMarker("tex", true)).toBe(jobIconMarker("tex"));
  });
});

describe("the built-in line under a folder's title", () => {
  test("says the job and what lands there when the name does not", () => {
    expect(builtInLine("inbox", "Capture")).toMatch(/^Built-in Inbox\. Unfiled captures\./);
    expect(builtInLine("website", "Site")).toBe("Built-in Website.");
  });

  test("says nothing when the name already does", () => {
    expect(builtInLine("inbox", "Inbox")).toBeNull();
    expect(builtInLine("inbox", "0-inbox")).toBeNull();
    expect(builtInLine("resources", "Resources and reading")).toBeNull();
  });
});

