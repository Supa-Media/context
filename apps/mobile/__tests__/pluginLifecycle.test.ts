import { describe, expect, test } from "@jest/globals";

import {
  BUSY_NOTE,
  INSTALL_NOTE,
  RECOVER_CONFIRMATION,
  REGISTRY_NOTE,
  STUCK_NOTE,
  UNINSTALL_NOTE,
  annotateResults,
  installVerb,
  isLifecycleBusy,
  managedControl,
  uninstallBlocker,
  type CommunityPlugin,
} from "../features/console/plugins/lifecycle";
import type { ConsolePlugin } from "../features/console/plugins/plugins";

/**
 * Two kinds of plugin wear the same name in the same list, and every check here
 * exists to keep them apart.
 *
 * A `source: "obsidian"` row is the customer's own vault copy, which Context
 * reads and must never write to. A `source: "context"` row is one Context
 * installed under `.context/plugins/`, at a version it pinned.
 *
 * The failure mode is not a rendering bug. A Remove offered on a vault row is an
 * offer to delete a file out of the one directory this product promises not to
 * touch, and it would look entirely ordinary until somebody pressed it.
 *
 * Mutations these are written to catch:
 *
 *  - `managedControl` or `uninstallBlocker` treating a vault row as managed;
 *  - `installVerb` saying "Install" for something already installed, so an
 *    update and a second copy both read as a first install;
 *  - `annotateResults` losing which of the two a match was.
 */

function plugin(over: Partial<ConsolePlugin> & { id: string }): ConsolePlugin {
  return {
    source: "obsidian",
    bundleFingerprint: `fp-${over.id}`,
    name: over.name ?? over.id,
    verdict: "runs",
    evidence: [],
    limitations: [],
    notes: [],
    ...over,
  };
}

const registryRow: CommunityPlugin = {
  id: "highlightr-plugin",
  name: "Highlightr",
  author: "Chetachi",
  description: "Highlight text in several colours.",
  repository: "chetachiezikeuzor/Highlightr-Plugin",
};

describe("whose plugin is it", () => {
  test("a vault row is never managed", () => {
    expect(managedControl({ source: "obsidian" }).kind).toBe("vault");
  });

  test("a Context install is", () => {
    expect(managedControl({ source: "context" }).kind).toBe("managed");
  });

  /*
    The one that matters. `.obsidian/` is read and never written, so there is
    nothing here to remove — and the sentence says where it can be removed
    instead, rather than leaving the reader with a refusal.
  */
  test("a vault row cannot be uninstalled, and is told where it can", () => {
    const blocker = uninstallBlocker({ source: "obsidian", bundleFingerprint: "fp-1" });
    expect(blocker).not.toBeNull();
    expect(blocker).toContain("never writes there");
    expect(blocker).toContain("Obsidian");
  });

  test("a managed install with a fingerprint can be removed", () => {
    expect(uninstallBlocker({ source: "context", bundleFingerprint: "fp-1" })).toBeNull();
  });

  test("a managed install nobody could identify cannot be removed exactly", () => {
    const blocker = uninstallBlocker({ source: "context", bundleFingerprint: null });
    expect(blocker).toContain("nothing exact to remove");
  });
});

describe("the verb says what will actually happen", () => {
  test("nothing installed reads as a plain install", () => {
    expect(installVerb(null)).toBe("Install");
  });

  test("already managed reads as an update, not a second install", () => {
    expect(installVerb("managed")).toContain("Update");
  });

  /*
    Installing over a vault copy adds a *second*, managed copy that Context
    prefers on an id collision. That is a real consequence, so the verb carries
    it rather than pretending this is the same press as the empty case.
  */
  test("already in the vault says a managed copy is being added", () => {
    expect(installVerb("vault")).toContain("managed copy");
    expect(installVerb("vault")).not.toBe("Install");
  });
});

describe("results say what is already in the bucket", () => {
  test("an untouched registry row is marked as neither", () => {
    expect(annotateResults([registryRow], [])[0]!.already).toBeNull();
  });

  test("a managed install is marked managed", () => {
    const rows = annotateResults([registryRow], [
      plugin({ id: "highlightr-plugin", source: "context" }),
    ]);
    expect(rows[0]!.already).toBe("managed");
  });

  test("a vault copy is marked as the vault, not as managed", () => {
    const rows = annotateResults([registryRow], [
      plugin({ id: "highlightr-plugin", source: "obsidian" }),
    ]);
    expect(rows[0]!.already).toBe("vault");
  });

  test("a different plugin with a similar name is not a match", () => {
    const rows = annotateResults([registryRow], [plugin({ id: "highlightr", source: "context" })]);
    expect(rows[0]!.already).toBeNull();
  });

  test("nothing is dropped — a row already installed is still shown", () => {
    const rows = annotateResults([registryRow], [
      plugin({ id: "highlightr-plugin", source: "context" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Highlightr");
  });
});

describe("the sentences that are promises", () => {
  /*
    "Install" that also started running third-party code would undo the consent
    screen's whole argument with one verb.
  */
  test("installing says plainly that it does not run anything", () => {
    expect(INSTALL_NOTE).toContain("does not run it");
    expect(INSTALL_NOTE).toContain(".context/plugins/");
  });

  /*
    The release bytes stay, because they are what fences a later operation and
    what a rollback needs. "Deleted" would be a promise the storage layer
    deliberately does not keep.
  */
  test("removing does not claim to delete what it keeps", () => {
    expect(UNINSTALL_NOTE).toContain("stays in your");
    expect(UNINSTALL_NOTE).toContain("vault is untouched");
    expect(UNINSTALL_NOTE).not.toMatch(/permanently|deleted for good/i);
  });

  test("the registry is named as Obsidian's own", () => {
    expect(REGISTRY_NOTE).toContain("Obsidian");
  });

  test("busy and stuck are different sentences, because they want opposite things", () => {
    expect(BUSY_NOTE).toContain("try again");
    expect(STUCK_NOTE).toContain("stopped part-way");
    expect(STUCK_NOTE).toContain("never deletes a note");
    expect(BUSY_NOTE).not.toBe(STUCK_NOTE);
  });
});

describe("the codes the backend actually sends", () => {
  test("both lifecycle refusals are recognised", () => {
    expect(isLifecycleBusy("PLUGIN_LIFECYCLE_BUSY")).toBe(true);
    expect(isLifecycleBusy("PLUGIN_LIFECYCLE_CHANGED")).toBe(true);
  });

  test("an unrelated refusal is not read as a lifecycle one", () => {
    expect(isLifecycleBusy("PLUGIN_CHANGED")).toBe(false);
    expect(isLifecycleBusy(undefined)).toBe(false);
  });

  /*
    The literal the action demands. Typing it by hand at the call site is how a
    confirmation gate turns into a silent no-op.
  */
  test("the recovery confirmation is the backend's exact literal", () => {
    expect(RECOVER_CONFIRMATION).toBe("RECOVER_PLUGIN");
  });
});
