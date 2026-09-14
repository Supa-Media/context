/**
 * @jest-environment jsdom
 */

/**
 * A plugin's markdown post-processor, run for real inside the guest.
 *
 * ## What this drives, and why it is shaped like YouVersion's
 *
 * `registerMarkdownPostProcessor` accepted a registration and dropped it. The
 * slice that changed that has to be proven against the thing it was built for,
 * so the bundle below is v1.8.1's read preview reduced to its mechanism and not
 * a hello-world with a different name:
 *
 *  - it filters anchors on `external-link`, on the text differing from the
 *    href, and on a `https://www.bible.com/bible` prefix — all three, because
 *    all three are in `LinkPreviewReader.ts` and any of them can make a
 *    correct-looking guest produce nothing;
 *  - it starts a `requestUrl` per link and **returns without awaiting it**,
 *    which is the reason the guest waits for its own realm to go quiet instead
 *    of awaiting the processor;
 *  - it builds its popup with the **global** `createDiv`/`createSpan`, which
 *    did not exist here until this slice;
 *  - it attaches the popup with tippy's documented contract, `element._tippy`.
 *
 * The tippy stand-in is four lines rather than the library. What matters is the
 * contract the guest reads — tippy documents the instance as `element._tippy`
 * and its content as `instance.props.content` — and pulling a bundler's worth
 * of third-party code into a unit test would prove the same fact more slowly.
 *
 * ## What never crosses
 *
 * The assertions are all on `preview-results`: an href and a string. No
 * element, no markup, no handler, and nothing the console has to interpret.
 */

import { beforeEach, afterEach, describe, expect, test } from "@jest/globals";
import { PREVIEW_TEXT_MAX, pluginSandboxDocument } from "@context/obsidian-runtime";

type Posted = {
  type?: string;
  seq?: number;
  previews?: { href: string; text: string }[];
  request?: { requestId: string; operation: Record<string, unknown> };
  [key: string]: unknown;
};

let nonces = 0;
let posted: Posted[] = [];
/** Every URL the plugin asked the broker for, in order. */
let fetched: string[] = [];
/** What the broker answers with, by URL; absent means a refusal. */
let bodies = new Map<string, string>();

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

function answer(requestId: string, result: unknown) {
  toHost({ type: "rpc-result", response: { version: 1, requestId, ok: true, result } });
}

function refuse(requestId: string, message: string) {
  toHost({
    type: "rpc-result",
    response: { version: 1, requestId, ok: false, error: { code: "denied", message } },
  });
}

/**
 * The guest waits in 100ms steps, so a preview test has to let real time pass.
 *
 * Deliberately real timers rather than fake ones: the thing under test is a
 * settle loop built from `setTimeout` and a request counter, and replacing the
 * clock would prove that the loop runs rather than that it waits for anything.
 */
const settle = (turns = 5) =>
  new Promise((resolve) => setTimeout(resolve, turns * 100 + 50));

const YOUVERSION_PREVIEW = `
  const { Plugin, requestUrl } = require('obsidian');

  // tippy.js' documented contract, which is all the guest reads: the instance
  // is assigned to the reference element as _tippy, and carries its props.
  function tippy(reference, props) {
    reference._tippy = { props };
    return reference._tippy;
  }

  class LinkPreviewManager {
    static async processLink(link) {
      const content = await this.processUrl(link.href);
      const popup = createDiv({ cls: 'preview-youversion' });
      if (content.err) {
        popup.createSpan({ cls: 'error-youversion' }).setText('Verse preview is unavailable for this link.');
      } else {
        popup.createSpan({ cls: 'content-youversion' }).setText(content.verses);
        popup.createSpan({ cls: 'info-youversion' }).setText(content.info.title + ' ' + content.info.version);
      }
      tippy(link, { content: popup, allowHTML: true });
    }
    static async processUrl(url) {
      try {
        const res = await requestUrl(url);
        const data = JSON.parse(res.text);
        if (!data) throw new Error('Could not parse verse data');
        return { err: false, info: data.info, verses: data.verses };
      } catch (_) {
        return { err: true, info: { title: '', version: '' }, verses: '' };
      }
    }
  }

  function linkPreview(element, _context) {
    const targetLinks = Array.from(element.getElementsByTagName('a')).filter(
      (link) =>
        link.classList.contains('external-link') &&
        link.href !== link.innerHTML &&
        link.href.startsWith('https://www.bible.com/bible'),
    );
    globalThis.__preview = globalThis.__preview || {};
    globalThis.__preview.saw = targetLinks.map((one) => one.href);
    globalThis.__preview.context = _context;
    for (const link of targetLinks) void LinkPreviewManager.processLink(link);
  }

  module.exports = class extends Plugin {
    async onload() { this.registerMarkdownPostProcessor(linkPreview); }
  };
`;

beforeEach(() => {
  posted = [];
  fetched = [];
  bodies = new Map();
  delete (globalThis as unknown as { __preview?: unknown }).__preview;
  (window as unknown as { ReactNativeWebView: { postMessage: (raw: string) => void } })
    .ReactNativeWebView = {
    postMessage: (raw: string) => {
      const message = JSON.parse(raw) as Posted;
      posted.push(message);
      const operation = message.request?.operation;
      if (message.type !== "rpc" || !message.request || !operation) return;
      const id = message.request.requestId;
      if (operation.kind !== "network.request") return;
      const url = String(operation.url);
      fetched.push(url);
      const body = bodies.get(url);
      setTimeout(() => {
        if (body === undefined) {
          refuse(id, "host not granted");
          return;
        }
        answer(id, {
          status: 200,
          headers: [],
          bodyBase64: Buffer.from(body, "utf8").toString("base64"),
        });
      }, 0);
    },
  };
});

afterEach(() => {
  toHost({ type: "unload" });
  delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
});

/** Load one guest with `mainJs` and give back a way to ask it for previews. */
async function guest(mainJs = YOUVERSION_PREVIEW) {
  nonces += 1;
  const own = `nonce-for-preview-${nonces}`;
  const mark = posted.length;
  // eslint-disable-next-line no-eval
  (0, eval)(scriptOf(pluginSandboxDocument()));
  toHost({ nonce: own, type: "load", mainJs, manifestJson: '{"id":"preview-under-test"}' });
  await Promise.resolve();
  await Promise.resolve();
  return {
    async ask(links: { href: string; text: string }[], seq = 1) {
      toHost({ type: "preview-query", seq, links });
      await settle();
      return posted.slice(mark).filter((one) => one.type === "preview-results").pop();
    },
    async unload() {
      toHost({ type: "unload" });
      await settle(1);
    },
    results: () => posted.slice(mark).filter((one) => one.type === "preview-results"),
  };
}

const VERSE = JSON.stringify({
  info: { title: "John 3:16", version: "NIV" },
  verses: "For God so loved the world",
});
const JOHN = "https://www.bible.com/bible/1/JHN.3.16";

describe("the plugin's own preview, end to end through the sandbox", () => {
  /*
    THE ONE THIS SLICE EXISTS FOR.

    A link in somebody's note goes in; the plugin's processor runs; its own
    requestUrl goes out to www.bible.com; and the verse comes back as text
    keyed to the href it belongs to.
  */
  test("a bible link is fetched by the plugin and comes back as its verse", async () => {
    bodies.set(JOHN, VERSE);
    const one = await guest();
    const results = await one.ask([{ href: JOHN, text: "John 3:16" }]);
    expect(fetched).toEqual([JOHN]);
    expect(results?.previews).toEqual([
      { href: JOHN, text: "For God so loved the world\nJohn 3:16 NIV" },
    ]);
  });

  /*
    The request is the plugin's own and goes through the broker, which is what
    makes it attributable in the audit trail. Nothing here fetches on a
    plugin's behalf, and nothing here fetches if the plugin does not.
  */
  test("no request at all for a note whose links the plugin ignores", async () => {
    const one = await guest();
    const results = await one.ask([{ href: "https://example.test/notes", text: "notes" }]);
    expect(fetched).toEqual([]);
    expect(results?.previews).toEqual([]);
  });

  /*
    All three of the plugin's own filters, asserted through what it saw rather
    than through what it produced: a guest that built anchors without the
    class, or with the href as the text, would hand the processor a document it
    correctly finds nothing in — a plugin that "does not work" with no error
    anywhere.
  */
  test("the document the processor sees carries Obsidian's own external-link shape", async () => {
    bodies.set(JOHN, VERSE);
    const one = await guest();
    await one.ask([
      { href: JOHN, text: "John 3:16" },
      { href: "https://example.test/x", text: "x" },
    ]);
    const saw = (globalThis as unknown as { __preview?: { saw: string[] } }).__preview?.saw;
    expect(saw).toEqual([JOHN]);
  });

  test("a link whose text is its own href is skipped, as it is in Obsidian", async () => {
    bodies.set(JOHN, VERSE);
    const one = await guest();
    const results = await one.ask([{ href: JOHN, text: JOHN }]);
    expect(fetched).toEqual([]);
    expect(results?.previews).toEqual([]);
  });

  /*
    The processor is handed a context, and a plugin reading `sourcePath` on it
    must not get a TypeError. `addChild` and `getSectionInfo` are there for the
    same reason — a throw inside a callback whose rejection nobody sees is the
    failure mode this whole file is written against.
  */
  test("the context carries the open note and answers the methods a processor calls", async () => {
    bodies.set(JOHN, VERSE);
    const one = await guest();
    toHost({ type: "active-file", path: "1-projects/sermons/john-3.md", etag: "e1" });
    await one.ask([{ href: JOHN, text: "John 3:16" }]);
    const context = (globalThis as unknown as {
      __preview?: { context: { sourcePath: string; getSectionInfo: () => unknown } };
    }).__preview?.context;
    expect(context?.sourcePath).toBe("1-projects/sermons/john-3.md");
    expect(context?.getSectionInfo()).toBeNull();
  });

  /*
    A plugin that cannot reach the host says so in its own words, and those
    words are its preview. Reporting nothing here would be Context deciding
    that the plugin's error message is not worth showing, which is exactly the
    silence the limitation lists exist to prevent.
  */
  test("a refused request becomes the plugin's own failure text, not silence", async () => {
    const one = await guest();
    const results = await one.ask([{ href: JOHN, text: "John 3:16" }]);
    expect(fetched).toEqual([JOHN]);
    expect(results?.previews).toEqual([
      { href: JOHN, text: "Verse preview is unavailable for this link." },
    ]);
  });
});

/* -------------------------------------------------------------------------- */

describe("what a preview may be, and what it may not", () => {
  const LOUD = `
    const { Plugin } = require('obsidian');
    module.exports = class extends Plugin {
      async onload() {
        this.registerMarkdownPostProcessor((element) => {
          for (const link of Array.from(element.getElementsByTagName('a'))) {
            link.setAttribute('aria-label', 'x'.repeat(2000));
          }
        });
      }
    };
  `;

  /*
    Bounded in the guest as well as in the parser. A plugin controls this string
    entirely and it is drawn in a tooltip over somebody's own note.
  */
  test("a preview is cut to the cap before it leaves the sandbox", async () => {
    const one = await guest(LOUD);
    const results = await one.ask([{ href: "https://example.test/a", text: "a" }]);
    expect(results?.previews?.[0]?.text.length).toBe(PREVIEW_TEXT_MAX);
  });

  /*
    The two accessible attributes are the standard way to put a tooltip on a
    link, and a plugin using one rather than a library must work. `title` is
    read after `aria-label`, so a plugin setting both gets the label it chose
    for a screen reader rather than the one the browser would also draw.
  */
  test("aria-label is a preview, and beats title", async () => {
    const BOTH = `
      const { Plugin } = require('obsidian');
      module.exports = class extends Plugin {
        async onload() {
          this.registerMarkdownPostProcessor((element) => {
            for (const link of Array.from(element.getElementsByTagName('a'))) {
              link.setAttribute('title', 'from title');
              link.setAttribute('aria-label', 'from aria-label');
            }
          });
        }
      };
    `;
    const one = await guest(BOTH);
    const results = await one.ask([{ href: "https://example.test/a", text: "a" }]);
    expect(results?.previews).toEqual([{ href: "https://example.test/a", text: "from aria-label" }]);
  });

  /*
    A link the processor left alone is absent rather than empty, which is why
    the wire carries the href with each preview instead of a positional list:
    a plugin that previews the second link and not the first would otherwise
    have its verse drawn under the wrong one.
  */
  test("links the processor ignored are absent, and the rest keep their own href", async () => {
    const SECOND = `
      const { Plugin } = require('obsidian');
      module.exports = class extends Plugin {
        async onload() {
          this.registerMarkdownPostProcessor((element) => {
            const links = Array.from(element.getElementsByTagName('a'));
            links[1].setAttribute('aria-label', 'only the second');
          });
        }
      };
    `;
    const one = await guest(SECOND);
    const results = await one.ask([
      { href: "https://example.test/first", text: "first" },
      { href: "https://example.test/second", text: "second" },
    ]);
    expect(results?.previews).toEqual([
      { href: "https://example.test/second", text: "only the second" },
    ]);
  });

  test("a plugin with no processor at all answers, rather than hanging", async () => {
    const NONE = `
      const { Plugin } = require('obsidian');
      module.exports = class extends Plugin { async onload() {} };
    `;
    const one = await guest(NONE);
    const results = await one.ask([{ href: "https://example.test/a", text: "a" }]);
    expect(results?.previews).toEqual([]);
  });

  /*
    The same rule as every other instruction in this protocol: an unloaded guest
    answers nothing at all rather than an empty list, so the host can tell "no
    plugin" from "nothing matched". A frame that answered after unload would be
    a stopped plugin still writing on the screen.
  */
  test("an unloaded guest is silent, not empty", async () => {
    const one = await guest();
    await one.unload();
    await one.ask([{ href: JOHN, text: "John 3:16" }]);
    expect(one.results()).toEqual([]);
  });

  /*
    Unload has to forget the processors as well as stop answering. Without it a
    restarted plugin would run its predecessor's callback as well as its own —
    #533's lesson, one registration list over.
  */
  test("a reloaded plugin does not run the previous load's processor", async () => {
    const one = await guest(`
      const { Plugin } = require('obsidian');
      module.exports = class extends Plugin {
        async onload() {
          this.registerMarkdownPostProcessor((element) => {
            globalThis.__runs = (globalThis.__runs || 0) + 1;
            for (const link of Array.from(element.getElementsByTagName('a'))) {
              link.setAttribute('aria-label', 'run ' + globalThis.__runs);
            }
          });
        }
      };
    `);
    (globalThis as unknown as { __runs?: number }).__runs = 0;
    await one.ask([{ href: "https://example.test/a", text: "a" }]);
    const results = await one.ask([{ href: "https://example.test/a", text: "a" }], 2);
    expect(results?.previews).toEqual([{ href: "https://example.test/a", text: "run 2" }]);
  });
});
