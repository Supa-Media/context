/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import {
  ABSENT_MEMBERS,
  INERT_MEMBERS,
  PLANNED_MEMBERS,
  pluginSandboxDocument,
  SANDBOX_MODULE_EXPORTS,
  SUPPORTED_MEMBERS,
} from "@context/obsidian-runtime";
import { BUNDLE, scriptOf, toHost, type Posted } from "./fixtures";

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
        // The module's own keys, kept apart from the walk: this is what a
        // bundle can extend, and the walk above mixes in every method of every
        // object it touched. Two different questions, and conflating them is
        // how Events and Modal were missing from every list at once.
        // (No backticks in here — REACH is a template literal.)
        globalThis.__moduleKeys = Object.keys(api);
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

  /** What `require('obsidian')` actually hands back, from the real document. */
  function moduleKeys(): string[] {
    reachable();
    const keys = (globalThis as unknown as { __moduleKeys?: string[] }).__moduleKeys;
    if (!keys) throw new Error("the reachability bundle did not report module keys");
    return keys;
  }

  test("every member the scanner calls supported is reachable on the shim", () => {
    const found = new Set(reachable());
    const missing = SUPPORTED_MEMBERS.filter((name) => !found.has(name));
    expect(missing).toEqual([]);
  });

  /*
    THE GUARD THAT WOULD HAVE FOUND `Events` AND `Modal`.

    `scan.js` decides whether a base class exists by asking
    `SANDBOX_MODULE_EXPORTS`, and neither direction of a mismatch is harmless: a
    class the shim exports and this list omits fails a plugin that works, and a
    class on the list the shim does not export passes one that cannot load at
    all. The second is what shipped — twice — and each time the card read "runs
    here" while the bundle died on `extends undefined` before `onload`.

    Both sets, compared exactly, against the real document.
  */
  test("the declared module exports are exactly what the shim exports", () => {
    const actual = [...moduleKeys()].sort();
    const declared = [...SANDBOX_MODULE_EXPORTS].sort();
    expect(actual).toEqual(declared);
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
