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
import {
  ABSENT_MEMBERS,
  INERT_MEMBERS,
  PLANNED_MEMBERS,
  SUPPORTED_MEMBERS,
  pluginSandboxDocument,
} from "@context/obsidian-runtime";

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
      globalThis.__seen.ran = [];
      this.addCommand({
        id: 'say-hello',
        name: 'Say hello',
        callback: () => { globalThis.__seen.ran.push('say-hello'); },
      });
      this.addCommand({
        id: 'throws',
        name: 'Throws',
        callback: () => { throw new Error('the command failed'); },
      });
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
    __seen?: {
      events: string[];
      opened: string[];
      ran: string[];
      active: () => { path: string } | null;
    };
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
    expect(posted.filter((one) => one.type === "command-result")).toEqual([
      { source: "context-plugin-sandbox", version: 1, nonce, type: "command-result", id: "say-hello", ok: true },
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

/*
  THE GUARD THIS WHOLE FILE WAS WORTH WRITING FOR.

  `SUPPORTED_MEMBERS` is the scanner's claim about this shim, and a `runs`
  verdict is printed as "everything these use, Context implements". It had
  drifted twenty names: `resolvedLinks`, `MarkdownRenderer`, `registerView` and
  the rest were not reachable here at all, so a bundle touching only them
  scanned clean, was approved by somebody reading that sentence, loaded, and
  threw on its first call.

  The list now lives in the same package as the shim, and this walks the shim it
  describes. A name added to the declaration without an implementation reddens
  here, which is the only place it can: the scanner cannot run the sandbox, and
  a browser test proves isolation rather than surface.

  It now proves the opposite direction too. "Reachable and does nothing" was
  hand-named and unchecked, on the grounds that a walk cannot tell an inert
  method from a working one — true, and not what the split needs. What it needs
  is only *reachable or not*, which this walk answers exactly: every name in
  `INERT_MEMBERS` must be on the shim, and every name in `ABSENT_MEMBERS` must
  not. That is the difference between a plugin loading with one part missing and
  a plugin that never loads, and `scan.js` reports them as different verdicts.
*/
describe("the scanner's claim about this shim is true", () => {
  const REACH = `
    const api = require('obsidian');
    module.exports = class extends api.Plugin {
      async onload() {
        const names = new Set(Object.keys(api));
        for (const source of [
          Object.getPrototypeOf(this),
          this.app.vault,
          this.app.metadataCache,
          this.app.workspace,
        ]) {
          let walk = source;
          while (walk && walk !== Object.prototype) {
            for (const name of Object.getOwnPropertyNames(walk)) names.add(name);
            walk = Object.getPrototypeOf(walk);
          }
        }
        /*
          Obsidian defines these three as globals as well as methods, and a
          plugin uses the global form to build a detached element — YouVersion's
          read preview opens with createDiv({ cls }). Named explicitly rather
          than by walking globalThis, which in jsdom would mark hundreds of
          browser names "reachable on the shim" and make this guard useless.
          A supported global missing from this list fails closed.
        */
        for (const name of ['createEl', 'createDiv', 'createSpan']) {
          if (typeof globalThis[name] === 'function') names.add(name);
        }
        globalThis.__reach = [...names];
      }
    };
  `;

  function reachable(): string[] {
    delete (globalThis as unknown as { __reach?: unknown }).__reach;
    nonces += 1;
    const own = `nonce-for-reach-${nonces}`;
    (0, eval)(scriptOf(pluginSandboxDocument()));
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "context-plugin-host",
          version: 1,
          nonce: own,
          type: "load",
          mainJs: REACH,
          manifestJson: '{"id":"reach"}',
        },
      }),
    );
    const found = (globalThis as unknown as { __reach?: string[] }).__reach;
    if (!found) throw new Error("the reachability bundle did not load");
    return found;
  }

  test("every member the scanner calls supported is reachable on the shim", () => {
    const found = new Set(reachable());
    const missing = SUPPORTED_MEMBERS.filter((name) => !found.has(name));
    expect(missing).toEqual([]);
  });

  test("nothing is claimed as both answered and still on the way", () => {
    const planned = Object.keys(PLANNED_MEMBERS);
    expect(SUPPORTED_MEMBERS.filter((name) => planned.includes(name))).toEqual([]);
  });

  test("every planned member carries a sentence rather than a flag", () => {
    for (const [name, reason] of Object.entries(PLANNED_MEMBERS)) {
      expect(typeof reason === "string" && reason.length > 10).toBe(true);
      expect(name).not.toBe("");
    }
  });

  test("every member called inert is actually reachable on the shim", () => {
    const found = new Set(reachable());
    const missing = Object.keys(INERT_MEMBERS).filter((name) => !found.has(name));
    expect(missing).toEqual([]);
  });

  /*
    The half that carries the verdict. An absent member used with `extends` is
    `wont-run` in `scan.js`, because the bundle throws before it finishes
    loading — so a name moving onto the shim without moving off this map would
    make the scanner fail a plugin that works.
  */
  test("and every member called absent really is not there", () => {
    const found = new Set(reachable());
    const present = Object.keys(ABSENT_MEMBERS).filter((name) => found.has(name));
    expect(present).toEqual([]);
  });

  test("the union is exactly the two kinds, with nothing claimed twice", () => {
    const inert = Object.keys(INERT_MEMBERS);
    const absent = Object.keys(ABSENT_MEMBERS);
    expect(inert.filter((name) => absent.includes(name))).toEqual([]);
    expect(Object.keys(PLANNED_MEMBERS).sort()).toEqual([...inert, ...absent].sort());
  });
});

/*
  THE STATUS BAR, WHICH IS THE FIRST PIECE OF PLUGIN *UI* CONTEXT ACTUALLY DRAWS.

  Everything the console showed about a running plugin until now was the
  console's own sentence about it — a pill, a count, a list of names. A status
  bar item is the plugin talking, and the reason it is the piece to do first is
  that it needs no plugin DOM: the guest reports the **text**, and the console
  draws it with its own components in its own theme. The element never crosses,
  which is the same boundary Codex's view conditions draw, arrived at from the
  other side.

  The guest tests below load their own bundles rather than the shared one, so
  the message counts stay readable — a status bar that reported twice per change
  would still pass a "contains" assertion.
*/
describe("a plugin's status bar reaches the console", () => {
  /** Load one more guest into this window and return only what it posted. */
  async function guest(mainJs: string) {
    nonces += 1;
    const own = `nonce-for-status-${nonces}`;
    const mark = posted.length;
    // eslint-disable-next-line no-eval
    (0, eval)(scriptOf(pluginSandboxDocument()));
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "context-plugin-host",
          version: 1,
          nonce: own,
          type: "load",
          mainJs,
          manifestJson: '{"id":"status-under-test"}',
        },
      }),
    );
    await settle();
    return {
      /** Every status bar message this guest has sent, oldest first. */
      bars: () =>
        posted.slice(mark).filter((one) => one.type === "status-bar") as {
          items: { id: string; text: string }[];
        }[],
      last: () => {
        const all = posted.slice(mark).filter((one) => one.type === "status-bar");
        return all.length === 0
          ? null
          : (all[all.length - 1] as { items: { id: string; text: string }[] }).items;
      },
    };
  }

  /*
    The report is driven by a MutationObserver, which jsdom delivers as a
    microtask and a browser delivers no sooner. A timer turn drains both that
    and anything the bundle awaited.
  */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  const item = (body: string) => `
    const { Plugin } = require('obsidian');
    module.exports = class extends Plugin {
      async onload() {
        globalThis.__status = {};
        ${body}
      }
    };
  `;

  test("an item a plugin writes into arrives as text, under its own id", async () => {
    const one = await guest(item(`
      const el = this.addStatusBarItem();
      el.setText('412 words');
    `));
    expect(one.last()).toEqual([{ id: "status-1", text: "412 words" }]);
  });

  /*
    An item with nothing in it is not a blank line on somebody's card.

    The second item is what makes this a test rather than a coincidence: a
    plugin that only ever adds one and writes nothing produces no report at all,
    because nothing has mutated since the guest started watching — so the
    assertion would hold with the empty-text rule deleted. Writing into a
    sibling forces a report while the empty one is still there.
  */
  test("an item the plugin never wrote into is not a blank line", async () => {
    const one = await guest(item(`
      this.addStatusBarItem();
      this.addStatusBarItem().setText('3 tasks due');
    `));
    expect(one.last()).toEqual([{ id: "status-2", text: "3 tasks due" }]);
  });

  test("the whole list arrives each time, so the console cannot drift", async () => {
    const one = await guest(item(`
      const left = this.addStatusBarItem();
      const right = this.addStatusBarItem();
      left.setText('412 words');
      right.setText('3 tasks');
      globalThis.__status.left = left;
    `));
    expect(one.last()).toEqual([
      { id: "status-1", text: "412 words" },
      { id: "status-2", text: "3 tasks" },
    ]);
  });

  test("an item the plugin removes is gone from the next list", async () => {
    const one = await guest(item(`
      const left = this.addStatusBarItem();
      const right = this.addStatusBarItem();
      left.setText('412 words');
      right.setText('3 tasks');
      right.remove();
    `));
    expect(one.last()).toEqual([{ id: "status-1", text: "412 words" }]);
  });

  /*
    A plugin cannot push the Stop button off the card. The guest stops at the
    cap and the host truncates whatever arrives anyway — the cap on this side is
    politeness, the one on the host's is the guard.
  */
  test("a plugin that adds forty items reports eight", async () => {
    const one = await guest(item(`
      for (let index = 0; index < 40; index += 1) {
        this.addStatusBarItem().setText('item ' + index);
      }
    `));
    expect(one.last()).toHaveLength(8);
  });

  test("markup a plugin builds crosses as its text and not as itself", async () => {
    const one = await guest(item(`
      const el = this.addStatusBarItem();
      el.createSpan({ text: 'Synced' });
      el.createSpan({ text: ' · 2m ago' });
    `));
    expect(one.last()).toEqual([{ id: "status-1", text: "Synced · 2m ago" }]);
  });

  /*
    Collapsing is not cosmetic, and this test is here because the escape that
    does it is the trap this file already records once: the shim is one template
    literal, so the regex is written `\\s` to *emit* `\s`, and getting it wrong
    yields a pattern matching a literal backslash — which still compiles, still
    runs, and quietly stops collapsing anything.
  */
  test("a multi-line item becomes one line", async () => {
    const one = await guest(item(`
      this.addStatusBarItem().setText('Synced\\n\\t  2m ago');
    `));
    expect(one.last()).toEqual([{ id: "status-1", text: "Synced 2m ago" }]);
  });

  /*
    A plugin that rewrites its status bar to the same words has changed its DOM
    and said nothing. The observer cannot tell those apart — it fires on the
    mutation, not on the result — so the guest compares before it sends, and a
    plugin re-rendering on a timer does not re-render the console with it.
  */
  test("rewriting an item to the same words says nothing", async () => {
    const one = await guest(item(`
      const el = this.addStatusBarItem();
      el.setText('412 words');
      globalThis.__status.rewrite = () => { el.empty(); el.createSpan({ text: '412 words' }); };
    `));
    expect(one.bars()).toHaveLength(1);
    (globalThis as unknown as { __status: { rewrite: () => void } }).__status.rewrite();
    await settle();
    expect(one.bars()).toHaveLength(1);
  });

  test("an unloaded plugin's status bar goes quiet", async () => {
    const one = await guest(item(`
      const el = this.addStatusBarItem();
      el.setText('412 words');
      globalThis.__status.el = el;
    `));
    expect(one.last()).toEqual([{ id: "status-1", text: "412 words" }]);
    const before = one.bars().length;
    toHost({ type: "unload" });
    await settle();
    (globalThis as unknown as { __status: { el: { setText: (value: string) => void } } })
      .__status.el.setText("still counting");
    await settle();
    expect(one.bars().length).toBe(before);
  });
});

/*
  EDITOR SUGGESTIONS — THE INTERACTION YOUVERSION LINKER IS ACTUALLY FOR.

  Its `Generate links` command is the secondary path. The way anyone uses the
  plugin is to type `@ John 1:1` and pick from a list, which is
  `registerEditorSuggest` — accepted and dropped on the floor since the shim was
  written, and named in `PLANNED_MEMBERS` as "in-editor suggestions are not
  wired yet".

  ## The shape, and why it is this shape

  A suggestion is a **round trip over one line of text**, and nothing else
  crosses:

  - host → guest `suggest-query`, carrying the current line and the cursor
    column. That is note content, so the host only sends it to a plugin granted
    `vault:read` — enforced on the trusted side, where `maySeeContent` lives.
  - guest → host `suggest-results`, carrying **bounded text per suggestion**.
    The plugin renders each suggestion into an element *inside the sandbox* and
    the guest reports what that element says, exactly as the status bar does.
    No element, no handler, no `EditorView` crosses.
  - host → guest `suggest-apply`, carrying the chosen index, routed to one frame
    by nonce like a command (#533).
  - guest → host `suggest-applied`, carrying the **rewritten line**. The trusted
    editor makes the edit through its own editing path, so a suggestion needs no
    write grant at all — it is the person typing, not the plugin writing.
*/
describe("a plugin can suggest into the editor", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  const SUGGESTER = `
    const { Plugin, EditorSuggest } = require('obsidian');
    class Verses extends EditorSuggest {
      onTrigger(cursor, editor) {
        const line = editor.getLine(cursor.line);
        const at = line.lastIndexOf('@ ');
        if (at < 0) return null;
        return { start: { line: cursor.line, ch: at }, end: cursor, query: line.slice(at + 2) };
      }
      getSuggestions(context) {
        globalThis.__suggest = globalThis.__suggest || {};
        globalThis.__suggest.query = context.query;
        return [
          { ref: context.query.trim(), version: 'NIV' },
          { ref: context.query.trim(), version: 'ESV' },
        ];
      }
      renderSuggestion(value, el) { el.setText(value.ref + ' (' + value.version + ')'); }
      selectSuggestion(value) {
        const url = 'https://www.bible.com/bible/1/' + value.ref.replace(/[ :]/g, '.');
        this.context.editor.replaceRange(
          '[' + value.ref + '](' + url + ')',
          this.context.start,
          this.context.end,
        );
      }
    }
    module.exports = class extends Plugin {
      async onload() { this.registerEditorSuggest(new Verses(this.app)); }
    };
  `;

  async function suggester() {
    nonces += 1;
    const own = `nonce-for-suggest-\${nonces}`;
    const mark = posted.length;
    // eslint-disable-next-line no-eval
    (0, eval)(scriptOf(pluginSandboxDocument()));
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        source: "context-plugin-host", version: 1, nonce: own, type: "load",
        mainJs: SUGGESTER, manifestJson: '{"id":"suggester"}',
      },
    }));
    await settle();
    return {
      ask: async (line: string, ch: number, seq = 1) => {
        toHost({ type: "suggest-query", seq, line, ch });
        await settle();
        return posted.slice(mark).filter((one) => one.type === "suggest-results").pop() as
          | { seq: number; items: { text: string }[] }
          | undefined;
      },
      apply: async (index: number, seq = 1) => {
        toHost({ type: "suggest-apply", seq, index });
        await settle();
        return posted.slice(mark).filter((one) => one.type === "suggest-applied").pop() as
          | { seq: number; line: string }
          | undefined;
      },
    };
  }

  test("typing the trigger returns what the plugin rendered, as text", async () => {
    const guest = await suggester();
    const results = await guest.ask("see @ John 3:16", 15);
    expect(results?.items.map((one) => one.text)).toEqual([
      "John 3:16 (NIV)",
      "John 3:16 (ESV)",
    ]);
  });

  /*
    THE LETTER S.

    `sandbox.js` is one template literal, and inside one `\s` is not an escape
    — it is the letter `s`. So the whitespace flattener shipped as
    `replace(/s+/g, ' ')` and quietly deleted every `s` from every suggestion it
    reported: `Psalms 23:1` arrived as `P alm 23:1`.

    Nothing caught it because the fixture above renders `John 3:16 (NIV)`,
    which has no lowercase `s` in it. The status bar's copy of the same line
    two hundred lines up was written `\\s` and is correct, which is what made
    this readable rather than only findable by running it.
  */
  test("a suggestion keeps its own letters, and only its whitespace is flattened", async () => {
    const guest = await suggester();
    const results = await guest.ask("see @ Psalms  23:1", 18);
    expect(results?.items.map((one) => one.text)).toEqual([
      "Psalms 23:1 (NIV)",
      "Psalms 23:1 (ESV)",
    ]);
  });

  test("a line with no trigger returns nothing rather than everything", async () => {
    const guest = await suggester();
    const results = await guest.ask("ordinary prose", 14);
    expect(results?.items).toEqual([]);
  });

  /*
    The plugin's own `selectSuggestion` runs, against an editor that is one line
    long, and the guest reports the line it produced. The trusted editor applies
    it — so no write grant, no vault.modify, and the person can undo it like
    anything else they typed.
  */
  test("picking one returns the rewritten line and nothing else", async () => {
    const guest = await suggester();
    await guest.ask("see @ John 3:16", 15);
    const applied = await guest.apply(0);
    expect(applied?.line).toBe("see [John 3:16](https://www.bible.com/bible/1/John.3.16)");
  });

  test("the plugin is given the query it asked to be triggered on", async () => {
    const guest = await suggester();
    await guest.ask("see @ John 3:16", 15);
    expect((globalThis as unknown as { __suggest: { query: string } }).__suggest.query)
      .toBe("John 3:16");
  });

  /*
    Bounded like every other guest string. A suggester returning two hundred
    rows is a plugin being greedy, not a forged message, so the list truncates.
  */
  test("a flood of suggestions is cut down before it is sent", async () => {
    nonces += 1;
    const own = `nonce-for-flood-\${nonces}`;
    const mark = posted.length;
    // eslint-disable-next-line no-eval
    (0, eval)(scriptOf(pluginSandboxDocument()));
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        source: "context-plugin-host", version: 1, nonce: own, type: "load",
        manifestJson: '{"id":"flood"}',
        mainJs: `
          const { Plugin, EditorSuggest } = require('obsidian');
          class Many extends EditorSuggest {
            onTrigger(cursor) { return { start: { line: 0, ch: 0 }, end: cursor, query: 'x' }; }
            getSuggestions() { return Array.from({ length: 200 }, (_, i) => i); }
            renderSuggestion(value, el) { el.setText('row ' + value + ' ' + 'y'.repeat(400)); }
            selectSuggestion() {}
          }
          module.exports = class extends Plugin {
            async onload() { this.registerEditorSuggest(new Many(this.app)); }
          };
        `,
      },
    }));
    await settle();
    toHost({ type: "suggest-query", seq: 1, line: "anything", ch: 8 });
    await settle();
    const results = posted.slice(mark).filter((one) => one.type === "suggest-results").pop() as
      { items: { text: string }[] };
    expect(results.items).toHaveLength(8);
    expect(results.items[0]!.text.length).toBeLessThanOrEqual(200);
  });

  test("an unloaded plugin suggests nothing", async () => {
    const guest = await suggester();
    toHost({ type: "unload" });
    await settle();
    const results = await guest.ask("see @ John 3:16", 15, 2);
    expect(results?.seq).not.toBe(2);
  });

  /*
    Applying an index nobody offered must not run the plugin's selection at all.

    The first version of this test used the suggester above, whose
    `selectSuggestion` reads `value.ref` and therefore throws on `undefined` —
    so the line came back unchanged whether the guard existed or not, and the
    test passed under sabotage. This one uses a suggester that writes
    unconditionally, so removing the guard visibly rewrites the line.
  */
  test("applying an index that was never offered does not run the plugin", async () => {
    nonces += 1;
    const own = `nonce-for-unoffered-${nonces}`;
    const mark = posted.length;
    // eslint-disable-next-line no-eval
    (0, eval)(scriptOf(pluginSandboxDocument()));
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        source: "context-plugin-host", version: 1, nonce: own, type: "load",
        manifestJson: '{"id":"unoffered"}',
        mainJs: `
          const { Plugin, EditorSuggest } = require('obsidian');
          class Always extends EditorSuggest {
            onTrigger(cursor) { return { start: { line: 0, ch: 0 }, end: cursor, query: '' }; }
            getSuggestions() { return ['only']; }
            renderSuggestion(value, el) { el.setText(String(value)); }
            selectSuggestion() {
              this.context.editor.replaceRange('RAN', this.context.start, this.context.end);
            }
          }
          module.exports = class extends Plugin {
            async onload() { this.registerEditorSuggest(new Always(this.app)); }
          };
        `,
      },
    }));
    await settle();
    toHost({ type: "suggest-query", seq: 1, line: "untouched", ch: 9 });
    await settle();
    toHost({ type: "suggest-apply", seq: 1, index: 99 });
    await settle();
    const applied = posted.slice(mark).filter((one) => one.type === "suggest-applied").pop() as
      { line: string };
    expect(applied.line).toBe("untouched");
  });
});

/*
  THE SUGGESTION DIALOG, END TO END IN THE REAL SANDBOX.

  Bible Reference is the plugin that forced this. It is a `SuggestModal`
  subclass at module scope, so before the class existed the bundle threw
  `extends undefined` before `onload` and nothing of it arrived — not the
  dialog, not the commands, and not the inline verse suggester that needed
  nothing new at all.

  What is proved here is the inversion rather than the widget: the plugin's own
  `getSuggestions`, `renderSuggestion` and `onChooseSuggestion` run **in the
  sandbox**, and what crosses to the console is text and an index. A test that
  asserted the console drew a list would not catch a shim that handed a plugin's
  element to the trusted realm, which is the thing that must not happen.
*/
describe("a plugin's suggestion dialog", () => {
  const MODAL_BUNDLE = `
    const { Plugin, SuggestModal } = require('obsidian');
    class Verses extends SuggestModal {
      constructor(app) {
        super(app);
        this.setPlaceholder('Find a verse');
        this.setInstructions([{ command: '↵', purpose: 'insert' }]);
      }
      getSuggestions(query) {
        globalThis.__modal.queries.push(query);
        return [{ ref: query + ' a' }, { ref: query + ' b' }];
      }
      renderSuggestion(value, el) {
        /*
          Unconditionally builds a child element, which is the point: a real
          renderSuggestion writes DOM, and the assertion below is that the DOM
          stays in here and only its text crosses. Written with a branch first
          — element or plain text depending on the shim — and that made the
          test blind: both arms produced the same textContent, so a shim
          sending innerHTML instead passed it.
        */
        const strong = document.createElement('strong');
        strong.textContent = value.ref;
        el.appendChild(strong);
      }
      onChooseSuggestion(value) { globalThis.__modal.chose.push(value.ref); }
      onClose() { globalThis.__modal.closed += 1; }
    }
    module.exports = class extends Plugin {
      async onload() {
        globalThis.__modal = { queries: [], chose: [], closed: 0 };
        globalThis.__modal.open = () => new Verses(this.app).open();
      }
    };
  `;

  function modalState() {
    return (globalThis as unknown as {
      __modal?: { queries: string[]; chose: string[]; closed: number; open: () => void };
    }).__modal;
  }

  async function loadModalBundle() {
    posted = [];
    nonces += 1;
    nonce = `nonce-for-modal-${nonces}`;
    // eslint-disable-next-line no-eval
    (0, eval)(scriptOf(pluginSandboxDocument()));
    toHost({ nonce, type: "load", mainJs: MODAL_BUNDLE, manifestJson: '{"id":"verses"}' });
    await Promise.resolve();
    await Promise.resolve();
  }

  test("the bundle loads at all, which is the whole reason the class exists", async () => {
    await loadModalBundle();
    expect(posted.some((message) => message.type === "loaded")).toBe(true);
    expect(posted.some((message) => message.type === "crashed")).toBe(false);
  });

  test("opening one asks the console for a dialog, with the plugin's own words", async () => {
    await loadModalBundle();
    modalState()?.open();
    const opened = posted.find((message) => message.type === "suggest-modal") as
      | { open: boolean; placeholder: string; instructions: { command: string }[] }
      | undefined;
    expect(opened?.open).toBe(true);
    expect(opened?.placeholder).toBe("Find a verse");
    expect(opened?.instructions).toEqual([{ command: "↵", purpose: "insert" }]);
  });

  test("a query runs the plugin's getSuggestions and only text comes back", async () => {
    await loadModalBundle();
    modalState()?.open();
    posted = [];
    toHost({ nonce, type: "suggest-modal-query", seq: 7, query: "Gen 1:1" });
    await Promise.resolve();
    await Promise.resolve();
    const results = posted.find((message) => message.type === "suggest-modal-results") as
      | { seq: number; items: { text: string }[] }
      | undefined;
    expect(modalState()?.queries).toEqual(["Gen 1:1"]);
    expect(results?.seq).toBe(7);
    // `renderSuggestion` built a <strong> in the sandbox; its text is what left.
    expect(results?.items).toEqual([{ text: "Gen 1:1 a" }, { text: "Gen 1:1 b" }]);
    expect(JSON.stringify(results)).not.toContain("strong");
  });

  test("a pick runs the plugin's own handler, and the dialog closes", async () => {
    await loadModalBundle();
    modalState()?.open();
    toHost({ nonce, type: "suggest-modal-query", seq: 1, query: "Ps 23" });
    await Promise.resolve();
    await Promise.resolve();
    posted = [];
    toHost({ nonce, type: "suggest-modal-pick", seq: 2, index: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(modalState()?.chose).toEqual(["Ps 23 b"]);
    expect(modalState()?.closed).toBe(1);
    const picked = posted.find((message) => message.type === "suggest-modal-picked") as
      | { seq: number; reopened: boolean }
      | undefined;
    expect(picked).toMatchObject({ seq: 2, reopened: false });
  });

  /*
    The guard against the shape that looks like a bug and is not: a pick can
    only land on the list currently on screen. Without it, a plugin whose
    second query returned fewer rows would have an old value chosen by an index
    the reader never saw.
  */
  test("a pick past the end of the current list chooses nothing", async () => {
    await loadModalBundle();
    modalState()?.open();
    toHost({ nonce, type: "suggest-modal-query", seq: 1, query: "x" });
    await Promise.resolve();
    await Promise.resolve();
    toHost({ nonce, type: "suggest-modal-pick", seq: 2, index: 9 });
    await Promise.resolve();
    await Promise.resolve();
    expect(modalState()?.chose).toEqual([]);
  });

  test("a query with no dialog open is answered with silence, not an empty list", async () => {
    // "closed" and "no matches" are different facts, and the console draws them
    // differently — the same distinction the editor's own suggester keeps.
    await loadModalBundle();
    posted = [];
    toHost({ nonce, type: "suggest-modal-query", seq: 3, query: "anything" });
    await Promise.resolve();
    await Promise.resolve();
    expect(posted.some((message) => message.type === "suggest-modal-results")).toBe(false);
  });

  test("a dismiss runs the plugin's onClose without telling it to close again", async () => {
    await loadModalBundle();
    modalState()?.open();
    posted = [];
    toHost({ nonce, type: "suggest-modal-dismiss", seq: 4 });
    await Promise.resolve();
    await Promise.resolve();
    expect(modalState()?.closed).toBe(1);
    // No `suggest-modal` back: the console shut it, and telling it to shut the
    // dialog it just shut is how a reopen from onClose would be lost.
    expect(posted.some((message) => message.type === "suggest-modal")).toBe(false);
  });
});
