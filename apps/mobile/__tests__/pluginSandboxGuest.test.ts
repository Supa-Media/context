/**
 * @jest-environment jsdom
 */

/**
 * The guest shim, actually executed.
 *
 * Everything else about the sandbox is tested from the outside — the host's
 * messages, the protocol's parser, the Chromium and WebKit boundary proofs. The
 * shim itself is a string, and until this file nothing ran it in a unit test:
 * `sandbox.js` could have shipped a `vault.on` that returned a dead handle, or
 * a `getActiveFile` that answered `null` for ever, and every suite would have
 * stayed green. That is precisely the shape of the defect this sprint already
 * found once, where `SUPPORTED_MEMBERS` promised twenty members the shim does
 * not implement.
 *
 * So this loads the real document's script into jsdom, hands it a real bundle,
 * and drives it with the real host messages.
 *
 * Two things it deliberately does not prove, because a jsdom global is not an
 * opaque origin: the frame isolation, and the CSP. Those stay with the browser
 * checks.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { pluginSandboxDocument } from "@context/obsidian-runtime";

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

type Posted = { type?: string; [key: string]: unknown };

let posted: Posted[] = [];

/** The plugin under test: it records what the shim tells it, in load order. */
const BUNDLE = `
  const { Plugin } = require('obsidian');
  module.exports = class extends Plugin {
    async onload() {
      globalThis.__seen = { events: [], opened: [], active: () => this.app.workspace.getActiveFile() };
      this.registerEvent(this.app.vault.on('modify', (file) => {
        globalThis.__seen.events.push('modify:' + file.path + ':' + (file.etag || ''));
      }));
      this.registerEvent(this.app.vault.on('create', (file) => {
        globalThis.__seen.events.push('create:' + file.path);
      }));
      this.registerEvent(this.app.vault.on('rename', (file, from) => {
        globalThis.__seen.events.push('rename:' + from + '->' + file.path);
      }));
      this.registerEvent(this.app.vault.on('delete', (file) => {
        globalThis.__seen.events.push('delete:' + file.path);
      }));
      this.registerEvent(this.app.metadataCache.on('changed', (file) => {
        globalThis.__seen.events.push('meta:' + file.path);
      }));
      this.registerEvent(this.app.workspace.on('file-open', (file) => {
        globalThis.__seen.opened.push(file === null ? 'none' : file.path);
      }));
    }
  };
`;

function scriptOf(documentText: string): string {
  const start = documentText.indexOf("<script>") + "<script>".length;
  const end = documentText.indexOf("</script>");
  if (start < "<script>".length || end < 0) throw new Error("no script in the sandbox document");
  return documentText.slice(start, end);
}

function toHost(message: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "context-plugin-host", version: 1, ...message },
    }),
  );
}

function seen() {
  return (globalThis as unknown as {
    __seen?: { events: string[]; opened: string[]; active: () => { path: string } | null };
  }).__seen;
}

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
    expect(posted.map((one) => one.type)).toEqual(["ready", "loaded"]);
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
