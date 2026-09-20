/**
 * @jest-environment jsdom
 */

/**
 * THE OPEN NOTE, AS SOMETHING A PLUGIN CAN ACTUALLY WRITE INTO.
 *
 * `app.workspace.getActiveViewOfType(MarkdownView)` is the ending of nearly
 * every "insert this here" an Obsidian plugin has. It answered `null` here, and
 * because plugins reach for it through an optional chain —
 *
 *     this.app.workspace.getActiveViewOfType(MarkdownView)?.editor
 *       .replaceRange(verse, editor.getCursor())
 *
 * — that null was not an error anybody saw. It was a row pressed, a dialog
 * closed, and a note that never changed. Reported from the shipped console as
 * "I click on the verse and nothing happens".
 *
 * So this file proves the three things that had to become true for that report
 * to close, against the real sandbox document:
 *
 *  1. there is a view while Context is running the plugin's own work, carrying
 *     a file and an editor with a caret;
 *  2. what the plugin writes into that editor is written back to the note,
 *     through the same audited RPC the editor commands already used;
 *  3. when it cannot be — nothing open, or a grant the owner has not given —
 *     the guest says which, so the console can put a sentence where the silence
 *     was.
 *
 * And the fourth, which is the quieter half of the same rule: a plugin that
 * never asked for the note is never reported as having failed to get it.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { pluginSandboxDocument } from "@context/obsidian-runtime";

type Posted = {
  type?: string;
  request?: { requestId: string; operation: Record<string, unknown> };
  [key: string]: unknown;
};

let nonces = 0;
let nonce = "";
let posted: Posted[] = [];

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

/** Every operation the guest has asked the broker for, in order. */
function operations(): { requestId: string; operation: Record<string, unknown> }[] {
  return posted
    .filter((one) => one.type === "rpc")
    .map((one) => one.request as { requestId: string; operation: Record<string, unknown> });
}

function lastOf(type: string): Posted | undefined {
  return [...posted].reverse().find((one) => one.type === type);
}

/**
 * Answer whatever the guest has asked for since the last time, as a host would.
 *
 * `note` is the bucket, so a write lands in it and the next read sees it —
 * without that, "the note changed" would be asserted against the message the
 * guest sent rather than against anything that happened.
 */
const note = { path: "2-areas/study.md", text: "", etag: "etag-1" };
/** Which operation kinds the plugin is allowed to make, as the broker sees it. */
let allowed = new Set<string>();
let answered = 0;

function drain() {
  const all = operations();
  for (const { requestId, operation } of all.slice(answered)) {
    const kind = String(operation.kind);
    if (!allowed.has(kind)) {
      toHost({
        type: "rpc-result",
        response: {
          version: 1,
          requestId,
          ok: false,
          // The exact code the protocol answers a missing grant with. The guest
          // tells this one apart from a malfunction, and the console says so.
          error: { code: "CAPABILITY_DENIED", message: "Plugin was not granted vault:write" },
        },
      });
      continue;
    }
    if (kind === "vault.read") {
      toHost({
        type: "rpc-result",
        response: { version: 1, requestId, ok: true, result: { text: note.text, etag: note.etag } },
      });
      continue;
    }
    if (kind === "vault.modify") {
      /*
        THIS BROKER REFUSES WHAT THE REAL ONE REFUSES.

        It used to accept every write whatever `expectedEtag` said, which made
        the conditional write a decoration in every test in this file: the one
        below that asserts the etag could see the value, and nothing could see
        what it was FOR. A fake that cannot conflict cannot show a conflict
        being mishandled, and one was — see "a second run must not lend its
        etag to the first".
      */
      if (operation.expectedEtag !== note.etag) {
        toHost({
          type: "rpc-result",
          response: {
            version: 1,
            requestId,
            ok: false,
            error: { code: "ETAG_MISMATCH", message: "That note changed while the plugin was working" },
          },
        });
        continue;
      }
      note.text = String(operation.text);
      note.etag = `${note.etag}+`;
      toHost({
        type: "rpc-result",
        response: { version: 1, requestId, ok: true, result: { etag: note.etag } },
      });
      continue;
    }
    toHost({ type: "rpc-result", response: { version: 1, requestId, ok: true, result: {} } });
  }
  answered = all.length;
}

/** Let the guest's microtasks run, answering anything it asks for as it goes. */
async function settle(turns = 12) {
  for (let turn = 0; turn < turns; turn += 1) {
    drain();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  drain();
}

/**
 * A plugin shaped like the one this was reported against.
 *
 * The command opens no dialog of its own — the dialog half is exercised below
 * through `SuggestModal` — and every write goes through `getActiveViewOfType`,
 * which is the member under test.
 */
const BUNDLE = `
  const { Plugin, MarkdownView, SuggestModal } = require('obsidian');

  class Verses extends SuggestModal {
    constructor(app) { super(app); this.setPlaceholder('Find a verse'); }
    getSuggestions(query) { return [{ ref: query }]; }
    renderSuggestion(value, el) { el.textContent = value.ref; }
    onChooseSuggestion(value) {
      const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
      if (!editor) return;
      editor.replaceRange('> ' + value.ref, editor.getCursor());
    }
  }

  module.exports = class extends Plugin {
    async onload() {
      globalThis.__seen = { views: [], cursors: [] };
      globalThis.__seen.gate = new Promise(resolve => { globalThis.__seen.openGate = resolve; });
      this.addCommand({
        id: 'insert-at-cursor',
        name: 'Insert at the cursor',
        callback: () => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          globalThis.__seen.views.push(view === null ? 'none' : view.file.path);
          if (view === null) return;
          globalThis.__seen.cursors.push(JSON.stringify(view.editor.getCursor()));
          view.editor.replaceSelection('inserted');
        },
      });
      this.addCommand({
        id: 'twice-at-the-cursor',
        name: 'Twice at the cursor',
        callback: () => {
          const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
          if (!editor) return;
          editor.replaceRange('first ', editor.getCursor());
          editor.replaceRange('second', editor.getCursor());
        },
      });
      this.addCommand({
        id: 'no-note-needed',
        name: 'Wants nothing',
        callback: () => { globalThis.__seen.ranQuietly = true; },
      });
      /*
        A command that waits, which is what a plugin fetching a verse does.
        The test holds the gate open, runs another piece of this plugin's work
        to completion underneath it, and then lets this one finish.
      */
      this.addCommand({
        id: 'slow-at-the-cursor',
        name: 'Slow at the cursor',
        callback: async () => {
          const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
          await globalThis.__seen.gate;
          if (editor) editor.replaceRange('[slow]', editor.getCursor());
        },
      });
      this.addCommand({
        id: 'through-the-editor',
        name: 'Through the editor',
        editorCallback: (editor, view) => {
          globalThis.__seen.editorView = view === null ? 'none' : view.file.path;
          editor.replaceSelection('by editorCallback');
        },
      });
      globalThis.__seen.openDialog = () => new Verses(this.app).open();
    }
  };
`;

function seen() {
  return (globalThis as unknown as {
    __seen?: {
      views: string[];
      cursors: string[];
      ranQuietly?: boolean;
      editorView?: string;
      openDialog: () => void;
      openGate: () => void;
    };
  }).__seen!;
}

beforeEach(async () => {
  posted = [];
  answered = 0;
  note.text = "# Study\nA line I was writing.";
  note.etag = "etag-1";
  allowed = new Set(["vault.read", "vault.modify", "settings.load", "settings.save"]);
  nonces += 1;
  nonce = `nonce-for-view-${nonces}`;
  delete (globalThis as unknown as { __seen?: unknown }).__seen;
  (window as unknown as { ReactNativeWebView: { postMessage: (raw: string) => void } })
    .ReactNativeWebView = {
    postMessage: (raw: string) => {
      posted.push(JSON.parse(raw) as Posted);
    },
  };
  // eslint-disable-next-line no-eval
  (0, eval)(scriptOf(pluginSandboxDocument()));
  toHost({ nonce, type: "load", mainJs: BUNDLE, manifestJson: '{"id":"under-test"}' });
  await settle(2);
});

afterEach(() => {
  // Each test evals another guest into this window and each keeps its listener;
  // unloading is what makes the previous ones deaf. See `pluginSandboxGuest`.
  toHost({ type: "unload" });
  delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
});

describe("a command can write into the note the console has open", () => {
  test("the view carries the open file, and the editor its text", async () => {
    toHost({ type: "active-file", path: note.path, etag: note.etag });
    posted = [];
    answered = 0;
    toHost({ type: "command", id: "insert-at-cursor" });
    await settle();

    expect(seen().views).toEqual([note.path]);
    /*
      The caret starts at the end of the note, which is the honest answer rather
      than a convenient one: the reader pressed this on the plugins pane, so
      there is no caret in the note to carry, and appending is the one place
      that is always visible and overwrites nothing.
    */
    expect(seen().cursors).toEqual([JSON.stringify({ line: 1, ch: "A line I was writing.".length })]);
    expect(note.text).toBe("# Study\nA line I was writing.inserted");
  });

  test("the write goes back through the audited RPC, against the etag it read", async () => {
    toHost({ type: "active-file", path: note.path, etag: note.etag });
    posted = [];
    answered = 0;
    toHost({ type: "command", id: "insert-at-cursor" });
    await settle();

    const kinds = operations().map((one) => String(one.operation.kind));
    expect(kinds).toEqual(["vault.read", "vault.modify"]);
    const write = operations()[1]!.operation;
    expect(write.path).toBe(note.path);
    expect(write.expectedEtag).toBe("etag-1");
  });

  /*
    THE ETAG A RUN WRITES WITH MUST BE THE ONE THAT RUN READ.

    `withActiveEditor` reads the open note, hands the plugin an editor over
    those bytes, and writes the result back under `expectedEtag` — which it
    took off the shared `activeFile`, not off its own read. So a second piece
    of the same plugin's work, finishing while the first was still awaiting,
    re-stamped that file with the etag ITS write produced, and the first run
    then wrote with an etag it had never seen. The conditional write was
    satisfied, and the second run's edit was gone: no conflict, no error,
    nothing to retry. Two overlapping runs is ordinary — a ribbon press while
    a command is fetching, or a pick in a dialog a command opened, which this
    file's own helper saves and restores `viewAsked` across.

    The fix pins the etag beside the text at the moment of the read, so the
    stale run is refused and says so.

    SABOTAGE RECORD for that fix, since the numbers say something:
      write with the shared file again                      -> 1 (this test)
      let this broker accept any expectedEtag               -> 1 (this test)
      pin by reading target.etag back AFTER the await       -> 0
    The last one is honest and worth leaving written down: that version fixes
    the case below too, and nothing here can tell it from the one that shipped.
    The reason it is not what shipped is an argument about a microtask window,
    stated at the fix — not a defect anybody has demonstrated.
  */
  test("a second run must not lend its etag to the first", async () => {
    toHost({ type: "active-file", path: note.path, etag: note.etag });
    posted = [];
    answered = 0;

    toHost({ type: "command", id: "slow-at-the-cursor" });
    await settle(3);
    // Underneath it, a second run of the same plugin reads, writes and lands.
    toHost({ type: "command", id: "insert-at-cursor" });
    await settle(6);
    expect(note.text).toBe("# Study\nA line I was writing.inserted");

    seen().openGate();
    await settle();

    const writes = operations()
      .filter((one) => String(one.operation.kind) === "vault.modify")
      .map((one) => one.operation);
    expect(writes).toHaveLength(2);
    // Each write carries the version its own run read, so the later one is a
    // conflict rather than a silent overwrite.
    expect(writes[0]!.expectedEtag).toBe("etag-1");
    expect(writes[1]!.expectedEtag).toBe("etag-1");
    // And the edit that did land is still there.
    expect(note.text).toBe("# Study\nA line I was writing.inserted");
  });

  test("an editorCallback is handed the same view, not a null", async () => {
    toHost({ type: "active-file", path: note.path, etag: note.etag });
    posted = [];
    answered = 0;
    toHost({ type: "command", id: "through-the-editor" });
    await settle();
    /*
      `null` is what this argument was before, and plugins branch on it: the
      second argument of an editorCallback is the view, and a plugin that reads
      `view.file` off it crashed where Obsidian would have worked.
    */
    expect(seen().editorView).toBe(note.path);
    expect(note.text).toContain("by editorCallback");
  });

  /*
    The caret follows what was inserted, as typing does. A caret left in front
    of the text it just inserted makes a plugin's second insertion land before
    its first, and the note reads backwards.
  */
  test("two inserts at the cursor land in the order the plugin made them", async () => {
    toHost({ type: "active-file", path: note.path, etag: note.etag });
    posted = [];
    answered = 0;
    toHost({ type: "command", id: "twice-at-the-cursor" });
    await settle();
    expect(note.text).toBe("# Study\nA line I was writing.first second");
  });

  test("nothing is written when the plugin changed nothing", async () => {
    toHost({ type: "active-file", path: note.path, etag: note.etag });
    posted = [];
    answered = 0;
    toHost({ type: "command", id: "no-note-needed" });
    await settle();
    expect(seen().ranQuietly).toBe(true);
    expect(operations().map((one) => String(one.operation.kind))).not.toContain("vault.modify");
  });
});

describe("a dialog's pick writes into the note, which is what the report was", () => {
  async function pick() {
    toHost({ type: "active-file", path: note.path, etag: note.etag });
    seen().openDialog();
    toHost({ nonce, type: "suggest-modal-query", seq: 1, query: "2 Kings 4:1" });
    await settle(4);
    posted = [];
    answered = 0;
    toHost({ nonce, type: "suggest-modal-pick", seq: 2, index: 0 });
    await settle();
    return lastOf("suggest-modal-picked");
  }

  test("what the plugin's onChooseSuggestion wrote reaches the note", async () => {
    const picked = await pick();
    expect(note.text).toBe("# Study\nA line I was writing.> 2 Kings 4:1");
    expect(picked).toMatchObject({ seq: 2, reopened: false, reason: null });
  });

  test("a pick that cannot be written says which, rather than nothing", async () => {
    // Exactly the console's default grant set: read, never write.
    allowed = new Set(["vault.read", "settings.load", "settings.save"]);
    const picked = await pick();
    expect(note.text).toBe("# Study\nA line I was writing.");
    /*
      `not-allowed`, not `failed`: the owner has not turned this plugin's write
      on, which is a thing they can fix, and telling them it malfunctioned would
      send them looking for a bug in somebody else's plugin.
    */
    expect(picked).toMatchObject({ reason: "not-allowed" });
  });

  test("a pick with no note open says so, rather than nothing", async () => {
    seen().openDialog();
    toHost({ nonce, type: "suggest-modal-query", seq: 1, query: "2 Kings 4:1" });
    await settle(4);
    posted = [];
    answered = 0;
    toHost({ nonce, type: "suggest-modal-pick", seq: 2, index: 0 });
    await settle();
    expect(lastOf("suggest-modal-picked")).toMatchObject({ reason: "no-note" });
  });
});

describe("a pick whose handler throws still answers the console", () => {
  const THROWS = `
    const { Plugin, SuggestModal } = require('obsidian');
    class Broken extends SuggestModal {
      getSuggestions() { return [{ ref: 'a verse' }]; }
      renderSuggestion(value, el) { el.textContent = value.ref; }
      onChooseSuggestion() { throw new Error('the plugin broke'); }
    }
    module.exports = class extends Plugin {
      async onload() { globalThis.__openBroken = () => new Broken(this.app).open(); }
    };
  `;

  test("the dialog is told, so it closes rather than hanging", async () => {
    posted = [];
    answered = 0;
    nonces += 1;
    nonce = `nonce-for-throws-${nonces}`;
    // eslint-disable-next-line no-eval
    (0, eval)(scriptOf(pluginSandboxDocument()));
    toHost({ nonce, type: "load", mainJs: THROWS, manifestJson: '{"id":"throws"}' });
    await settle(2);
    (globalThis as unknown as { __openBroken: () => void }).__openBroken();
    toHost({ nonce, type: "suggest-modal-query", seq: 1, query: "x" });
    await settle(2);
    toHost({ nonce, type: "suggest-modal-pick", seq: 2, index: 0 });
    await settle(2);

    /*
      The console closes its dialog on this message and on nothing else. A
      handler that threw its way past the send would leave the reader in front
      of a dialog that no longer answers anything.
    */
    expect(lastOf("suggest-modal-picked")).toMatchObject({ seq: 2, reason: "failed" });
  });
});

describe("and a plugin that never wanted the note is never said to have failed", () => {
  const QUIET = `
    const { Plugin, SuggestModal } = require('obsidian');
    class Translations extends SuggestModal {
      getSuggestions() { return [{ key: 'kjv' }]; }
      renderSuggestion(value, el) { el.textContent = value.key; }
      onChooseSuggestion(value) { globalThis.__quiet = value.key; }
    }
    module.exports = class extends Plugin {
      async onload() { globalThis.__openQuiet = () => new Translations(this.app).open(); }
    };
  `;

  test("a dialog that changes a setting reports no reason at all", async () => {
    posted = [];
    answered = 0;
    nonces += 1;
    nonce = `nonce-for-quiet-${nonces}`;
    // eslint-disable-next-line no-eval
    (0, eval)(scriptOf(pluginSandboxDocument()));
    toHost({ nonce, type: "load", mainJs: QUIET, manifestJson: '{"id":"quiet"}' });
    await settle(2);
    (globalThis as unknown as { __openQuiet: () => void }).__openQuiet();
    toHost({ nonce, type: "suggest-modal-query", seq: 1, query: "k" });
    await settle(2);
    toHost({ nonce, type: "suggest-modal-pick", seq: 2, index: 0 });
    await settle(2);

    expect((globalThis as unknown as { __quiet?: string }).__quiet).toBe("kjv");
    /*
      Nothing open, and that is fine: this plugin never reached for the note.
      Reporting `no-note` here would put an error in front of a reader over a
      dialog that did exactly what they asked.
    */
    expect(lastOf("suggest-modal-picked")).toMatchObject({ reason: null });
  });
});
