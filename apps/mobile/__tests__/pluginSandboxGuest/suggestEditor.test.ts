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
