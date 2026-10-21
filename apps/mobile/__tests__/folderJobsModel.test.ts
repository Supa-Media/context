/**
 * Which loaded folder does which job, and putting folders in order
 * (`jobIcons/folderJobs.ts`, `jobIcons/marker.ts`).
 *
 * SABOTAGE: drop the `jobs.size > 0` guard in `listingJobs` → "a listing's own
 * jobs win over names" fails; sort `withFolderOrder` by name → "the row moves
 * at once" fails.
 */
import { describe, expect, test } from "@jest/globals";
import { compareListingEntries } from "@context/shared/src/folderRoles.cjs";
import {
  builtInLine,
  folderPlace,
  jobFolder,
  jobOfPath,
  listingJobs,
  loadedJobs,
  reorderedSiblings,
  siblingFolders,
  withFolderOrder,
  websiteFolder,
  type JobEntry,
} from "../features/console/files/jobIcons/folderJobs";
import { setJobFoldersNow } from "../features/console/files/jobIcons/jobFoldersNow";
import { isWebsiteFolder } from "../features/console/website/PublishWebsite";
import { jobIconMarker, jobOfIcon } from "../features/console/files/jobIcons/marker";

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
});

describe("the drawn icon's marker", () => {
  test("round-trips every job, and nothing else reads as one", () => {
    expect(jobOfIcon(jobIconMarker("inbox"))).toBe("inbox");
    expect(jobOfIcon(jobIconMarker("meetings"))).toBe("meetings");
    for (const other of [null, undefined, "📥", ":party:", "context:tex", "context:job:", "context:job:taxes"]) {
      expect(jobOfIcon(other)).toBeNull();
    }
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

describe("sibling order", () => {
  const root = {
    entries: [
      folder("Capture", { role: "inbox" }),
      folder("1-projects", { role: "projects" }),
      folder("Recipes"),
      folder("9-archive", { role: "archive" }),
      file("todo.md"),
    ],
  };
  const listings = { "": root };

  test("siblings are the parent listing's folders in its order; place says the ends", () => {
    expect(siblingFolders(listings, "Recipes")).toEqual(["Capture", "1-projects", "Recipes", "9-archive"]);
    expect(siblingFolders(listings, "todo.md")).toBeNull();
    expect(siblingFolders(listings, "Recipes/soups")).toBeNull();
    expect(folderPlace(listings, "Capture")).toEqual({ first: true, last: false });
    expect(folderPlace(listings, "9-archive")).toEqual({ first: false, last: true });
    expect(folderPlace({ "": { entries: [folder("Only")] } }, "Only")).toBeNull();
  });

  test("one place up or down, and null at the ends", () => {
    const siblings = ["a", "b", "c"];
    expect(reorderedSiblings(siblings, "b", "up")).toEqual(["b", "a", "c"]);
    expect(reorderedSiblings(siblings, "b", "down")).toEqual(["a", "c", "b"]);
    expect(reorderedSiblings(siblings, "a", "up")).toBeNull();
    expect(reorderedSiblings(siblings, "c", "down")).toBeNull();
    expect(reorderedSiblings(siblings, "x", "up")).toBeNull();
    expect(siblings).toEqual(["a", "b", "c"]);
  });

  test("the row moves at once, in the server's own order, files still after folders", () => {
    const next = reorderedSiblings(siblingFolders(listings, "Recipes")!, "Recipes", "up")!;
    const drawn = withFolderOrder("", root, next);
    expect(drawn.entries.map((entry) => entry.path)).toEqual(["Capture", "Recipes", "1-projects", "9-archive", "todo.md"]);
    expect(drawn.entries.filter((entry) => entry.kind === "folder").map((entry) => entry.order)).toEqual([0, 10, 20, 30]);
    // What the confirming listing will be sorted by gives the same order.
    const resorted = [...drawn.entries].sort((a, b) => compareListingEntries("", a, b));
    expect(resorted.map((entry) => entry.path)).toEqual(drawn.entries.map((entry) => entry.path));
    // The listing it came from is untouched.
    expect(root.entries[1]!.path).toBe("1-projects");
  });

  test("Archive can be moved above an own folder: order beats the job's rank", () => {
    const next = reorderedSiblings(["Capture", "1-projects", "Recipes", "9-archive"], "9-archive", "up")!;
    expect(withFolderOrder("", root, next).entries.map((entry) => entry.path).slice(0, 4)).toEqual([
      "Capture",
      "1-projects",
      "9-archive",
      "Recipes",
    ]);
  });
});
