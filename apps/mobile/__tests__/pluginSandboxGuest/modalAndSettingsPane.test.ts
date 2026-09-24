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
  THREE THINGS A SELF-REVIEW FOUND IN THE MODAL, NONE OF WHICH ANYTHING CAUGHT.

  Each is a live MutationObserver left running against a dialog nobody can see.
  One is waste; all three together are a plugin that opens a dialog per command
  accumulating one observer per press, for the life of the session.
*/
describe("a modal that is replaced, closed or unloaded stops watching", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function guest(mainJs: string, own: string) {
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
          manifestJson: '{"id":"modal-lifetime"}',
        },
      }),
    );
    await settle();
    return {
      modals: () => posted.slice(mark).filter((one) => one.type === "text-modal") as {
        open: boolean;
        text: string;
      }[],
    };
  }

  /*
    WRITTEN THE WRONG WAY FIRST, AND THE SABOTAGE SAID SO.

    These asserted only that the retired dialog's words never reached the
    console — and they do not, observer or no observer, because `__contextPush`
    returns early once `openTextModal` has moved on. Deleting both fixes left
    two of the three green. The message was never the thing at risk.

    What is at risk is the observer: still connected, still firing on every
    mutation of an element nobody can see, one more per dialog for the life of
    the session. So the assertion is on the observer, which the test can read
    because it holds the modal the plugin made. The message check stays beside
    it — it is the reader-visible half, and cheap.

    The unload case keeps its message assertion as the primary one: there,
    `openTextModal` itself is what is cleared, so the early return is exactly
    what stops working when the fix is removed.
  */
  test("a second dialog retires the first, and the first stops reporting", async () => {
    nonces += 1;
    const run = await guest(
      `
      const api = require('obsidian');
      class Plain extends api.Modal {}
      module.exports = class extends api.Plugin {
        async onload() {
          const first = new Plain(this.app);
          first.contentEl.setText('first');
          first.open();
          const second = new Plain(this.app);
          second.contentEl.setText('second');
          second.open();
          globalThis.__retired = first;
        }
      };
    `,
      `nonce-for-lifetime-a-${nonces}`,
    );
    await settle();
    const retired = (globalThis as unknown as {
      __retired?: { contentEl: { textContent: string }; __contextObserver: unknown };
    }).__retired;
    expect(retired!.__contextObserver).toBeNull();
    retired!.contentEl.textContent = "the retired one spoke";
    await settle();
    expect(run.modals().some((one) => one.text === "the retired one spoke")).toBe(false);
    // And the one actually on screen is unaffected by any of it.
    expect(run.modals().filter((one) => one.open).pop()?.text).toBe("second");
  });

  test("a dialog closed by the plugin stops reporting", async () => {
    nonces += 1;
    const run = await guest(
      `
      const api = require('obsidian');
      class Plain extends api.Modal {}
      module.exports = class extends api.Plugin {
        async onload() {
          const modal = new Plain(this.app);
          modal.contentEl.setText('shown');
          modal.open();
          modal.close();
          globalThis.__closedModal = modal;
        }
      };
    `,
      `nonce-for-lifetime-b-${nonces}`,
    );
    await settle();
    const closed = (globalThis as unknown as {
      __closedModal?: { contentEl: { textContent: string }; __contextObserver: unknown };
    }).__closedModal;
    expect(closed!.__contextObserver).toBeNull();
    closed!.contentEl.textContent = "spoke after closing";
    await settle();
    expect(run.modals().some((one) => one.text === "spoke after closing")).toBe(false);
  });

  test("an unloaded plugin's dialog stops reporting", async () => {
    nonces += 1;
    const own = `nonce-for-lifetime-c-${nonces}`;
    const run = await guest(
      `
      const api = require('obsidian');
      class Plain extends api.Modal {}
      module.exports = class extends api.Plugin {
        async onload() {
          const modal = new Plain(this.app);
          modal.contentEl.setText('running');
          modal.open();
          globalThis.__unloadedModal = modal;
        }
      };
    `,
      own,
    );
    await settle();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "context-plugin-host", version: 1, type: "unload" },
      }),
    );
    await settle();
    const stopped = (globalThis as unknown as {
      __unloadedModal?: { contentEl: { textContent: string }; __contextObserver: unknown };
    }).__unloadedModal;
    expect(stopped!.__contextObserver).toBeNull();
    stopped!.contentEl.textContent = "spoke after unloading";
    await settle();
    expect(run.modals().some((one) => one.text === "spoke after unloading")).toBe(false);
  });
});


/*
  A PLUGIN'S OWN SETTINGS PANE, DESCRIBED RATHER THAN FORWARDED.

  `display()` is the most hostile thing a plugin runs on Context's behalf: the
  real pane this was built against opens with a sponsor iframe and a tracking
  image, both set through innerHTML, before it reaches a single control. So the
  property that matters is not that controls arrive, it is that nothing else
  does.

  `e2e/webkit/pluginSettings.spec.ts` runs the real release through this. These
  are the cases a fixture can make deliberately awkward.
*/
describe("a plugin's settings pane", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function guest(mainJs: string) {
    nonces += 1;
    const own = `nonce-for-settings-${nonces}`;
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
          manifestJson: '{"id":"settings-under-test"}',
        },
      }),
    );
    await settle();
    const send = (message: Record<string, unknown>) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "context-plugin-host", version: 1, ...message },
        }),
      );
    return {
      send,
      tabs: () => posted.slice(mark).filter((one) => one.type === "settings-tab"),
      panes: () =>
        posted.slice(mark).filter((one) => one.type === "settings-pane") as {
          open: boolean;
          error: string | null;
          rows: Record<string, unknown>[];
        }[],
      last: () => {
        const all = posted.slice(mark).filter((one) => one.type === "settings-pane");
        return all[all.length - 1] as
          | { open: boolean; error: string | null; rows: Record<string, unknown>[] }
          | undefined;
      },
    };
  }

  const PANE = `
    const api = require('obsidian');
    class Tab extends api.PluginSettingTab {
      display() {
        this.containerEl.empty();
        // Markup on purpose: this is what a real pane opens with.
        const ad = this.containerEl.createDiv();
        ad.innerHTML = '<iframe src="https://example.invalid/sponsor"></iframe>';
        const blurb = this.containerEl.createEl('i');
        blurb.innerHTML = 'Support us at <a href="https://example.invalid">example</a>';
        this.containerEl.createEl('h2', { text: 'Rendering' });
        new api.Setting(this.containerEl)
          .setName('Show translation')
          .setDesc('Whether to print it')
          .addToggle((t) => t.setValue(true).onChange((v) => { globalThis.__settingChanged = v; }));
        new api.Setting(this.containerEl)
          .setName('Version')
          .addDropdown((d) => {
            d.addOption('kjv', 'King James');
            d.addOption('niv', 'New International');
            d.setValue('kjv').onChange((v) => { globalThis.__versionChosen = v; });
          });
        const hidden = new api.Setting(this.containerEl).setName('Not applicable');
        hidden.settingEl.hide();
      }
    }
    module.exports = class extends api.Plugin {
      async onload() { this.addSettingTab(new Tab(this.app, this)); }
    };
  `;

  test("registering a pane is announced, and drawing it waits to be asked", async () => {
    const run = await guest(PANE);
    expect(run.tabs()).toHaveLength(1);
    /*
      Nothing drawn on load. `display()` may fetch — the real one does — so
      running it because a plugin started would be a network request nobody
      asked for, on a screen nobody opened.
    */
    expect(run.panes()).toHaveLength(0);
  });

  test("the rows are the plugin's controls, in the plugin's order", async () => {
    const run = await guest(PANE);
    run.send({ type: "settings-pane-open" });
    await settle();
    const rows = run.last()?.rows ?? [];
    expect(rows.map((row) => row.kind)).toEqual(["note", "heading", "toggle", "dropdown"]);
    expect(rows[2]).toMatchObject({ index: 0, name: "Show translation", value: true });
    expect(rows[3]).toMatchObject({ index: 1, name: "Version", value: "kjv" });
    expect((rows[3] as { options: unknown[] }).options).toHaveLength(2);
  });

  test("and nothing the plugin built out of markup", async () => {
    const run = await guest(PANE);
    run.send({ type: "settings-pane-open" });
    await settle();
    const wire = JSON.stringify(run.last());
    for (const forbidden of ["<iframe", "<a ", "href", "src=", "example.invalid"]) {
      expect(wire).not.toContain(forbidden);
    }
    // The words survive; the anchor does not.
    expect(wire).toContain("Support us at");
  });

  test("a control the plugin hid is not offered", async () => {
    const run = await guest(PANE);
    run.send({ type: "settings-pane-open" });
    await settle();
    /*
      A hidden row is one the plugin has decided does not apply. Drawing it
      would offer a setting its own author refuses to show — and this is the
      case that broke the real pane: `settingEl.hide()` did not exist, so
      `display()` threw and seventeen of twenty-one rows vanished silently.
    */
    expect(JSON.stringify(run.last())).not.toContain("Not applicable");
    expect(run.last()?.error ?? null).toBeNull();
  });

  test("a change runs the plugin's own handler, and only for a row on screen", async () => {
    const run = await guest(PANE);
    run.send({ type: "settings-pane-open" });
    await settle();
    run.send({ type: "settings-pane-change", index: 1, value: "niv" });
    await settle();
    expect((globalThis as unknown as { __versionChosen?: string }).__versionChosen).toBe("niv");

    // Past the end of the pane as last described: a change aimed at a pane that
    // is no longer on screen does nothing rather than landing on a neighbour.
    (globalThis as unknown as { __settingChanged?: boolean }).__settingChanged = undefined;
    run.send({ type: "settings-pane-change", index: 9, value: true });
    await settle();
    expect((globalThis as unknown as { __settingChanged?: boolean }).__settingChanged).toBeUndefined();
  });

  test("a display that throws part-way says so rather than looking short", async () => {
    const run = await guest(`
      const api = require('obsidian');
      class Tab extends api.PluginSettingTab {
        display() {
          new api.Setting(this.containerEl).setName('Got this far').addToggle((t) => t.setValue(false));
          throw new Error('the rest of the pane failed');
        }
      }
      module.exports = class extends api.Plugin {
        async onload() { this.addSettingTab(new Tab(this.app, this)); }
      };
    `);
    run.send({ type: "settings-pane-open" });
    await settle();
    const pane = run.last();
    expect(pane?.error).toBe("the rest of the pane failed");
    // And what it managed to draw is still offered, rather than thrown away.
    expect(JSON.stringify(pane?.rows)).toContain("Got this far");
  });

  test("closing the pane stops it reporting", async () => {
    const run = await guest(PANE);
    run.send({ type: "settings-pane-open" });
    await settle();
    const before = run.panes().length;
    run.send({ type: "settings-pane-close" });
    await settle();
    run.send({ type: "settings-pane-change", index: 0, value: false });
    await settle();
    expect(run.panes()).toHaveLength(before);
    expect((globalThis as unknown as { __settingChanged?: boolean }).__settingChanged).not.toBe(false);
  });
});
