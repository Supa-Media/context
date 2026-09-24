/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { pluginSandboxDocument } from "@context/obsidian-runtime";
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

  /*
    AND THE ROW SAYS WHAT THE PLUGIN WROTE, LETTER FOR LETTER.

    The whitespace this collapses is written `\\s` because the whole guest is a
    template literal — and for a while one of the four places that do it was
    written `\s`, which reaches the sandbox as a plain `s`. The rows of the
    dialog were run through `/s+/`, so every letter s in a verse became a space:
    "the sons of the prophets" was shown to the reader as "the  on  of the
    prophet ". A test whose fixture happens to contain no `s` cannot see that,
    which is why this one is made of them.
  */
  test("whitespace is collapsed and nothing else is", async () => {
    await loadModalBundle();
    modalState()?.open();
    posted = [];
    toHost({ nonce, type: "suggest-modal-query", seq: 8, query: "the sons  of\n the prophets" });
    await Promise.resolve();
    await Promise.resolve();
    const results = posted.find((message) => message.type === "suggest-modal-results") as
      | { items: { text: string }[] }
      | undefined;
    expect(results?.items[0]?.text).toBe("the sons of the prophets a");
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


/*
  TWO BASE CLASSES THAT WERE ON NO LIST AT ALL.

  `SuggestModal` was found because somebody had written it down as absent.
  `Events` and `Modal` were nowhere — not supported, not planned, not absent —
  so the real Bible Reference release scanned as "runs here: everything these
  use, Context implements" and then died on `extends undefined` before `onload`,
  twice in a row, one class behind the other.

  These prove the halves jsdom can prove: that the classes work rather than
  merely exist. `e2e/webkit/pluginBundles.spec.ts` proves the half that found
  them — the real release loading in a real browser.
*/
describe("the base classes a plugin extends at module scope", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function guest(mainJs: string) {
    nonces += 1;
    const own = `nonce-for-base-${nonces}`;
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
          manifestJson: '{"id":"base-under-test"}',
        },
      }),
    );
    await settle();
    return {
      nonce: own,
      since: () => posted.slice(mark),
      modals: () => posted.slice(mark).filter((one) => one.type === "text-modal") as {
        open: boolean;
        title: string;
        text: string;
      }[],
    };
  }

  test("Events is an emitter a plugin can build its own bus out of", async () => {
    const run = await guest(`
      const api = require('obsidian');
      class Bus extends api.Events {
        constructor() { super(); this.refs = []; }
        on(name, fn, ctx) { const ref = super.on(name, fn, ctx); this.refs.push(ref); return ref; }
        offAll() { this.refs.forEach((ref) => this.offref(ref)); }
      }
      module.exports = class extends api.Plugin {
        async onload() {
          const bus = new Bus();
          const heard = [];
          bus.on('verse', (value) => heard.push('a:' + value));
          const second = bus.on('verse', (value) => heard.push('b:' + value));
          bus.on('verse', () => { throw new Error('a listener may throw'); });
          bus.trigger('verse', 'one');
          bus.offref(second);
          bus.trigger('verse', 'two');
          bus.offAll();
          bus.trigger('verse', 'three');
          this.addStatusBarItem().setText(heard.join('|'));
        }
      };
    `);
    const bars = run.since().filter((one) => one.type === "status-bar") as {
      items: { text: string }[];
    }[];
    // Both heard the first; only the first heard the second; a thrown listener
    // stopped neither; and after offAll nothing heard the third.
    expect(bars[bars.length - 1]?.items[0]?.text).toBe("a:one|b:one|a:two");
  });

  test("Modal shows what the plugin wrote into contentEl, and only its text", async () => {
    const run = await guest(`
      const api = require('obsidian');
      class Verse extends api.Modal {
        async onOpen() {
          super.onOpen();
          this.titleEl.setText('Genesis 1:1');
          // Markup on purpose: a plugin may build an element tree, and none of
          // it may reach the trusted realm. Only the text it carries crosses.
          const line = this.contentEl.createEl('strong');
          line.setText('In the beginning');
        }
      }
      module.exports = class extends api.Plugin {
        async onload() { new Verse(this.app).open(); }
      };
    `);
    await settle();
    const opened = run.modals().filter((one) => one.open);
    const last = opened[opened.length - 1];
    expect(last?.title).toBe("Genesis 1:1");
    expect(last?.text).toBe("In the beginning");
    // The element the plugin built does not travel — not its tag, not its
    // markup. The same boundary the suggestion dialog keeps.
    expect(JSON.stringify(run.modals())).not.toContain("strong");
  });

  /*
    RENAMED AFTER A SABOTAGE IT SURVIVED.

    It read "content that arrives after an await still reaches the console" and
    awaited inside `onOpen` — which `open()` already covers, because it pushes
    again when the promise `onOpen` returned settles. Deleting the
    MutationObserver left it green, so it was testing the wrong half.

    The observer's own case is content that lands after `onOpen` has already
    finished: a plugin that starts a fetch and does not await it, which is a
    perfectly ordinary way to write one. Nothing else notices that, and without
    it the dialog stays empty forever with no error anywhere.
  */
  test("content written after onOpen has already returned still reaches the console", async () => {
    const run = await guest(`
      const api = require('obsidian');
      class Later extends api.Modal {
        onOpen() {
          this.contentEl.setText('');
          // Deliberately not awaited, and onOpen returns before this runs.
          setTimeout(() => { this.contentEl.setText('the verse, fetched'); }, 0);
        }
      }
      module.exports = class extends api.Plugin {
        async onload() { new Later(this.app).open(); }
      };
    `);
    await settle();
    await settle();
    expect(run.modals().some((one) => one.open && one.text === "the verse, fetched")).toBe(true);
  });

  test("and content awaited inside onOpen reaches it too", async () => {
    const run = await guest(`
      const api = require('obsidian');
      class Awaited extends api.Modal {
        async onOpen() {
          this.contentEl.setText('');
          await Promise.resolve();
          this.contentEl.setText('awaited, then written');
        }
      }
      module.exports = class extends api.Plugin {
        async onload() { new Awaited(this.app).open(); }
      };
    `);
    await settle();
    await settle();
    expect(run.modals().some((one) => one.open && one.text === "awaited, then written")).toBe(true);
  });

  test("a dismissal from the console runs the plugin's onClose", async () => {
    const run = await guest(`
      const api = require('obsidian');
      class Closing extends api.Modal {
        onOpen() { this.contentEl.setText('open'); }
        onClose() { this.app.__closed = true; }
      }
      module.exports = class extends api.Plugin {
        async onload() {
          const modal = new Closing(this.app);
          globalThis.__closingApp = modal.app;
          modal.open();
        }
      };
    `);
    await settle();
    const app = (globalThis as unknown as { __closingApp?: { __closed?: boolean } }).__closingApp;
    expect(app?.__closed).toBeUndefined();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "context-plugin-host", version: 1, type: "text-modal-dismiss", seq: 1 },
      }),
    );
    await settle();
    expect(app?.__closed).toBe(true);
    /*
      And nothing is sent back about it. The console shut the dialog before it
      told the guest, so a `text-modal` closing message here would be the guest
      answering a question nobody asked — and would close whatever dialog had
      opened in the meantime.
    */
    const after = run.modals();
    expect(after[after.length - 1]?.open).toBe(true);
  });
});
