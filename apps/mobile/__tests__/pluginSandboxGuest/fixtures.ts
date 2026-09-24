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
 *
 * This module is the shared, stateless half of the harness for every file in
 * this folder — the bundle every test loads, and the pure helpers around it.
 * The mutable per-test state (`posted`, the nonce, and the `beforeEach` /
 * `afterEach` pair that installs and tears down a fresh guest) is not shared
 * from here: each test reassigns `posted` directly (`posted = []`), which an
 * imported binding cannot be reassigned to, so that half is kept — identical —
 * in every file that needs it. This module carries no tests of its own.
 */

/** The plugin under test: it records what the shim tells it, in load order. */
export const BUNDLE = `
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

export type Posted = { type?: string; [key: string]: unknown };

export function scriptOf(documentText: string): string {
  const start = documentText.indexOf("<script>") + "<script>".length;
  const end = documentText.indexOf("</script>");
  if (start < "<script>".length || end < 0) throw new Error("no script in the sandbox document");
  return documentText.slice(start, end);
}

export function toHost(message: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "context-plugin-host", version: 1, ...message },
    }),
  );
}

export function seen() {
  return (globalThis as unknown as {
    __seen?: {
      events: string[];
      opened: string[];
      ran: string[];
      active: () => { path: string } | null;
    };
  }).__seen;
}
