/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { pluginSandboxDocument } from "@context/obsidian-runtime";
import { BUNDLE, scriptOf, seen, toHost, type Posted } from "./fixtures";

/*
  A fresh nonce per test, and it is isolation rather than realism.

  Every test evals another guest into the same jsdom window and each one keeps
  its `message` listener for the life of the file. A shared nonce means the next
  test's `load` matches every older guest too — they all re-run the bundle, all
  re-register, and a three-message test sees twelve. A distinct nonce is exactly
  what the real host gives each sandbox, and here it is what makes the previous
  ones deaf.
*/
let nonces = 0;
let nonce = "";

let posted: Posted[] = [];

beforeEach(async () => {
  posted = [];
  nonces += 1;
  nonce = `nonce-for-test-${nonces}`;
  delete (globalThis as unknown as { __seen?: unknown }).__seen;
  // The guest prefers `ReactNativeWebView` over `window.parent`, which is the
  // seam that lets a jsdom test see what it posts without an opaque origin.
  (window as unknown as { ReactNativeWebView: { postMessage: (raw: string) => void } })
    .ReactNativeWebView = {
    postMessage: (raw: string) => {
      posted.push(JSON.parse(raw) as Posted);
    },
  };
  // eslint-disable-next-line no-eval
  (0, eval)(scriptOf(pluginSandboxDocument()));
  toHost({ nonce, type: "load", mainJs: BUNDLE, manifestJson: '{"id":"under-test"}' });
  // `onload` is awaited inside the guest, so let its microtasks drain.
  await Promise.resolve();
  await Promise.resolve();
});

afterEach(() => {
  /*
    Every test evals another copy of the guest into the same jsdom window, and
    each one keeps its own `message` listener for the life of the file. Unloading
    is what makes the previous ones inert — without it they go on dispatching
    into whichever `__seen` the newest guest installed, and a three-message test
    sees six.
  */
  toHost({ type: "unload" });
  delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
});

describe("the bundle runs at all", () => {
  test("it says ready, then loaded, and the plugin's onload ran", () => {
    expect(posted.map((one) => one.type)).toEqual([
      "ready",
      "registration",
      "registration",
      "loaded",
    ]);
    expect(seen()).toBeDefined();
  });
});

describe("a plugin can tell which note is open", () => {
  test("nothing is open until the host says otherwise", () => {
    expect(seen()!.active()).toBeNull();
  });

  test("the open note arrives with its path and its version", () => {
    toHost({ type: "active-file", path: "1-projects/plan.md", etag: "etag-7" });
    const active = seen()!.active() as { path: string; etag?: string; basename?: string };
    expect(active.path).toBe("1-projects/plan.md");
    expect(active.etag).toBe("etag-7");
    // A real TFile, not a bare path — plugins read `basename` constantly.
    expect(active.basename).toBe("plan");
  });

  test("file-open fires each time, and closing the note reports null", () => {
    toHost({ type: "active-file", path: "a.md", etag: "e1" });
    toHost({ type: "active-file", path: "b.md", etag: "e2" });
    toHost({ type: "active-file", path: null, etag: null });
    expect(seen()!.opened).toEqual(["a.md", "b.md", "none"]);
    expect(seen()!.active()).toBeNull();
  });

  /*
    The regression that would be invisible: a shim that kept the last note when
    told nothing is open leaves a plugin acting on a file the reader closed.
  */
  test("closing the note clears it rather than keeping the last one", () => {
    toHost({ type: "active-file", path: "a.md", etag: "e1" });
    toHost({ type: "active-file", path: "", etag: null });
    expect(seen()!.active()).toBeNull();
  });
});

describe("a plugin is told what Context changed", () => {
  test("a modify carries the path and the new version", () => {
    toHost({ type: "vault-event", kind: "modify", path: "notes/a.md", etag: "etag-2" });
    expect(seen()!.events).toContain("modify:notes/a.md:etag-2");
  });

  test("a create, a delete and a rename each reach their own handler", () => {
    toHost({ type: "vault-event", kind: "create", path: "new.md", etag: "e" });
    toHost({ type: "vault-event", kind: "delete", path: "gone.md", etag: null });
    toHost({ type: "vault-event", kind: "rename", path: "b.md", from: "a.md", etag: "e" });
    expect(seen()!.events).toContain("create:new.md");
    expect(seen()!.events).toContain("delete:gone.md");
    expect(seen()!.events).toContain("rename:a.md->b.md");
  });

  /*
    Dataview, Tasks and every other index-shaped plugin listens on the metadata
    cache rather than the vault, so a change that fired only `vault` would leave
    exactly the plugins this capability exists for still stale.
  */
  test("a write also invalidates the metadata cache", () => {
    toHost({ type: "vault-event", kind: "modify", path: "notes/a.md", etag: "e" });
    expect(seen()!.events).toContain("meta:notes/a.md");
  });

  test("a delete does not claim the metadata changed, because the file is gone", () => {
    toHost({ type: "vault-event", kind: "delete", path: "gone.md", etag: null });
    expect(seen()!.events).not.toContain("meta:gone.md");
  });

  test("an unknown kind reaches nothing at all", () => {
    toHost({ type: "vault-event", kind: "exploded", path: "a.md", etag: "e" });
    expect(seen()!.events).toEqual([]);
  });

  test("an event with no path reaches nothing", () => {
    toHost({ type: "vault-event", kind: "modify", etag: "e" });
    expect(seen()!.events).toEqual([]);
  });
});

describe("unloading really unsubscribes", () => {
  test("no handler fires after unload, and nothing is still open", async () => {
    toHost({ type: "active-file", path: "a.md", etag: "e1" });
    const before = seen()!;
    expect(before.active()).not.toBeNull();

    toHost({ type: "unload" });
    await Promise.resolve();
    await Promise.resolve();

    const count = before.events.length;
    toHost({ type: "vault-event", kind: "modify", path: "a.md", etag: "e2" });
    toHost({ type: "active-file", path: "b.md", etag: "e3" });
    expect(before.events).toHaveLength(count);
    expect(before.active()).toBeNull();
  });
});


/**
 * The guest half of running a command, which already existed and which a
 * reviewer — me — asserted did not.
 *
 * The claim was that `sandbox.js` "has no way to be told to run a command", and
 * it went into a PR body, a code comment and a shared note before anybody
 * checked the file rather than a grep of it. It is wrong: the guest has handled
 * an inbound `command` since before this sprint. What is missing is the *host*
 * half — nothing posts the message and `sandboxTypes.ts` does not know the
 * reply — which is a screen to build, not a protocol to negotiate.
 *
 * These tests exist so the next person reads a passing assertion instead of a
 * confident sentence. A grep can miss a branch; an executed shim cannot.
 */
describe("the guest can already be told to run a command", () => {
  /*
    `needsEditor` says whether the command took an `editorCallback`. Only the
    guest can see which callback a plugin supplied, and the console needs the
    fact to decide whether the control can be pressed at all — an editor
    command acts on the open note and Obsidian keeps those out of its palette
    when nothing is focused. Both of these take a plain `callback`, so both
    report false.
  */
  test("registering one announces it to the host, and whether it needs an editor", () => {
    expect(posted.filter((one) => one.type === "registration")).toEqual([
      { source: "context-plugin-sandbox", version: 1, nonce, type: "registration", kind: "command", id: "say-hello", name: "Say hello", needsEditor: false },
      { source: "context-plugin-sandbox", version: 1, nonce, type: "registration", kind: "command", id: "throws", name: "Throws", needsEditor: false },
    ]);
  });

  test("a command that takes an editor says so", () => {
    const own = `nonce-for-editor-${(nonces += 1)}`;
    const mark = posted.length;
    // eslint-disable-next-line no-eval
    (0, eval)(scriptOf(pluginSandboxDocument()));
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        source: "context-plugin-host",
        version: 1,
        nonce: own,
        type: "load",
        manifestJson: '{"id":"editor-command"}',
        mainJs: `
          const { Plugin } = require('obsidian');
          module.exports = class extends Plugin {
            async onload() {
              this.addCommand({
                id: 'generate-links',
                name: 'Generate links',
                editorCallback: () => {},
              });
            }
          };
        `,
      },
    }));
    const registration = posted.slice(mark).find((one) => one.type === "registration");
    expect(registration).toMatchObject({ id: "generate-links", needsEditor: true });
  });

  test("an inbound command runs the callback and reports success", async () => {
    toHost({ type: "command", id: "say-hello" });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen()!.ran).toEqual(["say-hello"]);
    /*
      `reason: null` is part of the answer now, not noise: a command runs with
      the open note in front of it, and this field is how the console tells "it
      ran" from "it asked for the note and could not have it". Nothing to
      report is the ordinary case and says so explicitly.
    */
    expect(posted.filter((one) => one.type === "command-result")).toEqual([
      {
        source: "context-plugin-sandbox",
        version: 1,
        nonce,
        type: "command-result",
        id: "say-hello",
        ok: true,
        reason: null,
      },
    ]);
  });

  /*
    A command that throws is the plugin's failure, not the sandbox's, and the
    guest has to answer either way — a host that never hears back cannot tell a
    broken command from a hung one.
  */
  test("a command that throws is reported, not swallowed", async () => {
    toHost({ type: "command", id: "throws" });
    await Promise.resolve();
    await Promise.resolve();
    const results = posted.filter((one) => one.type === "command-result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "throws", ok: false });
    expect(String(results[0]!.error)).toContain("the command failed");
  });

  test("an id nobody registered is ignored rather than answered", async () => {
    toHost({ type: "command", id: "not-a-command" });
    await Promise.resolve();
    expect(posted.filter((one) => one.type === "command-result")).toHaveLength(0);
    expect(seen()!.ran).toEqual([]);
  });
});
