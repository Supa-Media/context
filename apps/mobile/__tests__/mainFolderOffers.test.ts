/**
 * The two folder offers' rules, without a renderer, and their two registry
 * entries.
 *
 * Both are answered once on the account and never by the device
 * (`deviceKey: null` at the call sites): the registry is what the server
 * checks an answer against, so these names and their stores are the contract.
 */

import { describe, expect, test } from "@jest/globals";
import { IN_APP_MESSAGES, STORED_MESSAGE_IDS } from "@context/shared";
import {
  addFoldersLabel,
  businessQuestionEligible,
  isBusinessChoice,
  mainFolderLines,
  missingFoldersEligible,
  rootFolderNames,
} from "../features/console/files/mainFolderOffers";
import type { FolderListing, FileEntry } from "../features/console/files/types";

const ALL_MAIN = ["0-inbox", "1-projects", "2-areas", "3-resources", "9-archive"];

function root(names: string[]): FolderListing {
  const entry = (name: string, kind: "file" | "folder"): FileEntry => ({
    kind,
    path: name,
    name,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  });
  return {
    path: "",
    folderDefault: "private",
    entries: [...names.map((name) => entry(name, "folder")), entry("todo.md", "file")],
    truncated: false,
    manifestUsable: true,
  };
}

describe("the registry", () => {
  test("both messages are tips in a workspace, answered once on the shared table", () => {
    for (const id of ["missing-folders", "business-workspace"] as const) {
      expect(IN_APP_MESSAGES[id]).toMatchObject({ kind: "tip", scope: "workspace", store: "messageReads" });
      expect(IN_APP_MESSAGES[id]).not.toHaveProperty("askAgainAfterMs");
      expect(STORED_MESSAGE_IDS).toContain(id);
    }
  });

  test("low priority: the folders band is a tip, and the business question sits below it", () => {
    expect(IN_APP_MESSAGES["missing-folders"].priority).toBe(15);
    expect(IN_APP_MESSAGES["business-workspace"].priority).toBeLessThan(IN_APP_MESSAGES["missing-folders"].priority);
  });
});

describe("the main-folders band", () => {
  test("eligible for an editor whose root lacks a main folder", () => {
    expect(missingFoldersEligible({ canEdit: true, root: root(ALL_MAIN.slice(1)) })).toBe(true);
  });

  test("not for somebody who cannot edit", () => {
    expect(missingFoldersEligible({ canEdit: false, root: root([]) })).toBe(false);
  });

  test("not while the root has not loaded: missing is only an answer once it has", () => {
    expect(missingFoldersEligible({ canEdit: true, root: undefined })).toBe(false);
  });

  test("not when every main folder is there, under any of the names an older workspace used", () => {
    expect(missingFoldersEligible({ canEdit: true, root: root(["Inbox", "1-Projects", "2-areas", "3-resources", "old-archive", "4-archive"]) })).toBe(false);
  });

  test("the lines name the folder found, and say what is about to be added", () => {
    const lines = mainFolderLines(["1-projects", "9-archive", "0-inbox", "2-areas"]);
    expect(lines.map((line) => line.label)).toEqual(["Inbox", "Projects", "Areas", "Resources", "Archive"]);
    expect(lines.find((line) => line.role === "projects")?.found).toBe("1-projects");
    expect(lines.find((line) => line.role === "resources")?.found).toBeNull();
  });

  test("the button says how many folders it will add, singular and plural", () => {
    expect(addFoldersLabel(1)).toBe("Add 1 folder");
    expect(addFoldersLabel(2)).toBe("Add 2 folders");
    expect(addFoldersLabel(5)).toBe("Add 5 folders");
  });

  test("the root's folder names come from the listing, not its files", () => {
    expect(rootFolderNames(root(["1-projects"]))).toEqual(["1-projects"]);
    expect(rootFolderNames(undefined)).toEqual([]);
  });
});

describe("the business question", () => {
  test("only Clients and Teams are asked about; Products and the main folders never are", () => {
    expect(isBusinessChoice("clients")).toBe(true);
    expect(isBusinessChoice("teams")).toBe(true);
    expect(isBusinessChoice("products")).toBe(false);
    expect(isBusinessChoice("resources")).toBe(false);
  });

  test("eligible in a personal workspace with an id, while its sheet is open", () => {
    expect(businessQuestionEligible({ personal: true, contextId: "ws-1", sheetOpen: true })).toBe(true);
  });

  test("never in a shared workspace, with no id, or once the sheet is shut", () => {
    expect(businessQuestionEligible({ personal: false, contextId: "ws-1", sheetOpen: true })).toBe(false);
    expect(businessQuestionEligible({ personal: true, contextId: null, sheetOpen: true })).toBe(false);
    expect(businessQuestionEligible({ personal: true, contextId: "ws-1", sheetOpen: false })).toBe(false);
  });
});
