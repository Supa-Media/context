/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { pluginSandboxDocument } from "@context/obsidian-runtime";

type Posted = {
  type?: string;
  request?: {
    requestId: string;
    operation: Record<string, unknown>;
  };
  [key: string]: unknown;
};

let nonceCount = 0;
let nonce = "";
let posted: Posted[] = [];

function scriptOf(documentText: string): string {
  const start = documentText.indexOf("<script>") + "<script>".length;
  const end = documentText.indexOf("</script>");
  if (start < "<script>".length || end < 0) throw new Error("no sandbox script");
  return documentText.slice(start, end);
}

function toGuest(message: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent("message", {
    data: { source: "context-plugin-host", version: 1, ...message },
  }));
}

async function nextRpc(after: number) {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const found = posted.slice(after).find((one) => one.type === "rpc" && one.request);
    if (found?.request) return found.request;
  }
  throw new Error("guest did not issue the expected RPC");
}

function answer(requestId: string, result: unknown) {
  toGuest({
    type: "rpc-result",
    response: { version: 1, requestId, ok: true, result },
  });
}

/*
  This is deliberately the shape of YouVersion Linker 1.8.1, not a generic
  hello-world bundle: all three external CodeMirror imports are evaluated at
  module load, its editor extension is constructed before onload, and the
  user-visible command starts asynchronous work without returning that promise.
*/
const YOUVERSION_SHAPED_BUNDLE = `
  const { syntaxTree } = require('@codemirror/language');
  const { RangeSetBuilder } = require('@codemirror/state');
  const { Decoration, ViewPlugin, WidgetType } = require('@codemirror/view');
  const { EditorSuggest, Plugin, requestUrl } = require('obsidian');

  class VerseSuggest extends EditorSuggest {}
  class VerseWidget extends WidgetType {}
  const extension = ViewPlugin.fromClass(class {
    constructor(view) {
      const ranges = new RangeSetBuilder();
      syntaxTree(view.state).iterate({ enter() {} });
      ranges.add(0, 0, Decoration.replace({ widget: new VerseWidget() }));
      this.decorations = ranges.finish();
    }
  }, { decorations: value => value.decorations });

  module.exports = class extends Plugin {
    async onload() {
      const settings = await this.loadData();
      if (settings === null || typeof settings !== 'object') throw new Error('missing settings object');
      await this.saveData({ ...settings, version: 1 });
      this.registerEditorSuggest(new VerseSuggest(this.app));
      this.registerEditorExtension([extension]);
      this.addCommand({
        id: 'generate-links',
        name: 'Generate links',
        editorCallback(editor) {
          if ([editor.getLine(0)].first() !== 'John 3:16') throw new Error('Obsidian array helpers missing');
          requestUrl('https://www.bible.com/bible/1/JHN.3.16').then(response => {
            globalThis.__youversionResponse = response;
            editor.replaceRange(response.text, { line: 0, ch: 0 }, { line: 0, ch: 8 });
          });
        },
      });
    }
  };
`;

beforeEach(async () => {
  posted = [];
  nonceCount += 1;
  nonce = `youversion-compatibility-${nonceCount}`;
  delete (globalThis as unknown as { __youversionResponse?: unknown }).__youversionResponse;
  (window as unknown as { ReactNativeWebView: { postMessage: (raw: string) => void } })
    .ReactNativeWebView = {
    postMessage: (raw: string) => {
      const message = JSON.parse(raw) as Posted;
      posted.push(message);
      const operation = message.request?.operation;
      if (message.type !== "rpc" || !message.request || !operation) return;
      if (operation.kind === "settings.load") {
        setTimeout(() => answer(message.request!.requestId, { json: null, etag: null }), 0);
      }
      if (operation.kind === "settings.save") {
        setTimeout(() => answer(message.request!.requestId, { etag: "settings-etag" }), 0);
      }
    },
  };
  // eslint-disable-next-line no-eval
  (0, eval)(scriptOf(pluginSandboxDocument()));
  toGuest({
    nonce,
    type: "load",
    mainJs: YOUVERSION_SHAPED_BUNDLE,
    manifestJson: '{"id":"youversion-linker","version":"1.8.1"}',
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
});

afterEach(() => {
  toGuest({ type: "unload" });
  delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
});

describe("YouVersion Linker compatibility", () => {
  test("its CodeMirror imports load without granting an editor surface", () => {
    expect(posted).toContainEqual(expect.objectContaining({ type: "loaded" }));
    expect(posted).toContainEqual(expect.objectContaining({
      type: "registration",
      id: "generate-links",
      name: "Generate links",
    }));
  });

  test("its editor command receives Obsidian's requestUrl shape and saves once", async () => {
    toGuest({ type: "active-file", path: "proof.md", etag: "etag-1" });
    const mark = posted.length;
    toGuest({ type: "command", id: "generate-links" });

    const read = await nextRpc(mark);
    expect(read.operation).toEqual({ kind: "vault.read", path: "proof.md" });
    answer(read.requestId, { path: "proof.md", text: "John 3:16", etag: "etag-1" });

    const network = await nextRpc(posted.findIndex((one) => one.request?.requestId === read.requestId) + 1);
    expect(network.operation).toMatchObject({
      kind: "network.request",
      url: "https://www.bible.com/bible/1/JHN.3.16",
      method: "GET",
    });
    // The owner can change notes while a slow request is in flight. The
    // command is addressed to the note that was active when it began; writing
    // its result into the newly opened note would be cross-note corruption.
    toGuest({ type: "active-file", path: "other.md", etag: "other-etag" });
    answer(network.requestId, {
      status: 200,
      headers: [{ name: "content-type", value: "application/json" }],
      bodyBase64: btoa('{"verse":"For God so loved"}'),
    });

    const modify = await nextRpc(posted.findIndex((one) => one.request?.requestId === network.requestId) + 1);
    expect(modify.operation).toEqual({
      kind: "vault.modify",
      path: "proof.md",
      text: '{"verse":"For God so loved"}6',
      expectedEtag: "etag-1",
    });
    answer(modify.requestId, { path: "proof.md", etag: "etag-2" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = (globalThis as unknown as {
      __youversionResponse: {
        status: number;
        text: string;
        json: unknown;
        headers: Record<string, string>;
        arrayBuffer: ArrayBuffer;
      };
    }).__youversionResponse;
    expect(response.status).toBe(200);
    expect(response.text).toBe('{"verse":"For God so loved"}');
    expect(response.json).toEqual({ verse: "For God so loved" });
    expect(response.headers["content-type"]).toBe("application/json");
    expect(new Uint8Array(response.arrayBuffer)).toHaveLength(response.text.length);
    expect(posted.filter((one) => one.type === "command-result")).toEqual([
      expect.objectContaining({ id: "generate-links", ok: true }),
    ]);
    expect(posted.filter((one) => one.request?.operation.kind === "vault.modify")).toHaveLength(1);
  });

  /*
   * The guest accepts a host message on `message.source === "context-plugin-host"`
   * — a string in the payload, which anyone who can post into this frame can
   * write. The sandbox comment argues that is safe because "once loaded,
   * host-to-guest messages omit the nonce. They can only ask the plugin to act
   * inside its own realm, so accepting a forged one grants no authority."
   *
   * That premise stopped being true when the command path grew a read and a
   * write of its own: a `command` message now makes the guest issue
   * `vault.read` on the open note and `vault.modify` back onto it, around
   * whatever the plugin does in between. A forged one is therefore an
   * unauthorized write to a customer's note, timed by whoever forged it.
   *
   * Nonce-ing this direction is not the fix and the comment says why — the
   * plugin shares the realm and would read the value out of the event. What a
   * plugin cannot forge is `event.source`, which the UA sets.
   */
  test("a command from a window that is not the host neither reads nor writes", async () => {
    toGuest({ type: "active-file", path: "proof.md", etag: "etag-1" });
    const outsider = document.createElement("iframe");
    document.body.appendChild(outsider);
    const mark = posted.length;

    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "context-plugin-host", version: 1, type: "command", id: "generate-links" },
      source: outsider.contentWindow,
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(posted.slice(mark).filter((one) => one.type === "rpc")).toHaveLength(0);
    expect(posted.slice(mark).filter((one) => one.type === "command-result")).toHaveLength(0);
    outsider.remove();
  });

  test("...while the host's own command, which carries no source, still runs", async () => {
    toGuest({ type: "active-file", path: "proof.md", etag: "etag-1" });
    const mark = posted.length;
    toGuest({ type: "command", id: "generate-links" });

    const read = await nextRpc(mark);
    expect(read.operation).toEqual({ kind: "vault.read", path: "proof.md" });
  });

  test("an editor command without an active note fails without reading or writing", async () => {
    const mark = posted.length;
    toGuest({ type: "command", id: "generate-links" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posted.slice(mark).filter((one) => one.type === "rpc")).toHaveLength(0);
    expect(posted.slice(mark)).toContainEqual(expect.objectContaining({
      type: "command-result",
      id: "generate-links",
      ok: false,
      error: "Open a note before running this command",
    }));
  });
});
