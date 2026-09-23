/**
 * @jest-environment jsdom
 */

/**
 * A WEB LINK IN A NOTE OPENS WHEN IT IS CLICKED.
 *
 * It did not. `noteLinks.ts` followed links to other notes and nothing else,
 * so `[site](https://example.com)` was drawn underlined in the link colour and
 * a click on it put the caret in it — the owner's words: "clicking on a
 * [regular](link.com) does not work". `[site](example.com)`, with no scheme,
 * was worse: CommonMark reads it as a relative path, so it was drawn as a link
 * to a note called `example.com` that does not exist.
 *
 * Three things are proved here: which targets count as web addresses (and,
 * more to the point, which never do — `javascript:` and `file:` above all),
 * that a click and a tap open one with the same escape hatches a note link
 * has, and that the native host re-checks what the web view asks it to open.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `webUrl` returns any parseable URL, `javascript:` included        3
 *   the host's `open-url` case drops its re-check                     1
 *   `noteLinksIn` claims `[x](example.com/page)` as a note again      1
 *   the `editing` check skipped for web links                         1
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownLanguage } from "../features/console/files/livePreview";
import {
  noteLinks,
  noteLinksIn,
  webLinkAt,
  type NoteLinkContext,
} from "../features/console/files/noteLinks";
import { webUrl } from "../features/console/files/webUrl";
import { createHostBridge } from "../features/console/files/webview/host";
import { PROTOCOL_VERSION } from "../features/console/files/webview/protocol";

describe("which targets are web addresses", () => {
  test("a URL with a web scheme is itself", () => {
    expect(webUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(webUrl("http://example.com")).toBe("http://example.com");
    expect(webUrl("<https://example.com/x>")).toBe("https://example.com/x");
  });

  test("a host name without a scheme is a web page, over https", () => {
    expect(webUrl("link.com")).toBe("https://link.com");
    expect(webUrl("example.com/page")).toBe("https://example.com/page");
    expect(webUrl("www.example.net")).toBe("https://www.example.net");
    expect(webUrl("//example.org/x")).toBe("https://example.org/x");
  });

  test("an address is mail", () => {
    expect(webUrl("mailto:someone@example.com")).toBe("mailto:someone@example.com");
    expect(webUrl("someone@example.com")).toBe("mailto:someone@example.com");
  });

  test("a scheme a browser would run or a shell would open is never one", () => {
    // Allow-listed rather than filtered: whatever comes back is handed to the
    // browser, the desktop shell or the phone's `Linking`.
    for (const target of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,hi",
      "file:///etc/hosts",
      "vbscript:x",
      "obsidian://open?vault=x",
      "mailto:not-an-address",
      // Reads as one site and opens another.
      "https://bank.example@attacker.example/",
      "https://",
      "https://exa mple.com",
    ]) {
      expect(webUrl(target)).toBeNull();
    }
  });

  test("a note, an attachment or a path in this bucket is not one", () => {
    for (const target of [
      "notes.md",
      "../2-areas/plan.md",
      "report.pdf",
      "diagram.png",
      "install.sh",
      "design.ai",
      "#heading",
      "folder/note",
      "",
      "two words.com",
    ]) {
      expect(webUrl(target)).toBeNull();
    }
  });

  test("so the note resolver leaves a scheme-less web page alone", () => {
    const spans = noteLinksIn("[site](example.com/page) and [plan](../plan.md)", {
      path: "1-projects/a/note.md",
    });
    expect(spans.map((span) => span.path)).toEqual(["1-projects/plan.md"]);
  });
});

describe("what the grammar calls a web link", () => {
  const at = (doc: string, pos: number) =>
    webLinkAt(EditorState.create({ doc, extensions: [markdownLanguage()] }), pos)?.url ?? null;

  test("an inline link, an autolink and a bare URL", () => {
    expect(at("[site](https://example.com) x", 2)).toBe("https://example.com");
    expect(at("[site](link.com) x", 2)).toBe("https://link.com");
    expect(at("see <https://example.com/a> x", 8)).toBe("https://example.com/a");
    expect(at("see https://example.com/b x", 8)).toBe("https://example.com/b");
  });

  test("but not a note, not an image and not a script", () => {
    expect(at("[plan](../plan.md) x", 2)).toBeNull();
    expect(at("![pic](https://example.com/p.png) x", 3)).toBeNull();
    expect(at("[x](javascript:alert(1)) y", 1)).toBeNull();
    expect(at("plain words", 3)).toBeNull();
  });
});

const DOC = "[site](https://example.com/) trailing words";

function mount(options: { canOpen?: boolean; caretAt?: number } = {}) {
  const urls: string[] = [];
  const notes: string[] = [];
  const ref: { current: NoteLinkContext } = {
    current: {
      path: "1-projects/a/note.md",
      onOpen: (path) => notes.push(path),
      ...(options.canOpen === false ? {} : { onOpenUrl: (url: string) => urls.push(url) }),
    },
  };
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: DOC, extensions: [markdownLanguage(), noteLinks(ref)] }),
    parent,
  });
  if (options.caretAt !== undefined) {
    view.contentDOM.focus();
    view.dispatch({ selection: { anchor: options.caretAt } });
  }
  return {
    view,
    urls,
    notes,
    destroy: () => {
      view.destroy();
      parent.remove();
    },
  };
}

let mounted: ReturnType<typeof mount> | null = null;
afterEach(() => {
  mounted?.destroy();
  mounted = null;
});

/** Coordinates jsdom resolves to position 0, which is inside the link. */
function mouse(init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    clientX: 1,
    clientY: 1,
    button: 0,
    ...init,
  });
}

function touch(type: string, points: { clientX: number; clientY: number }[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const key of ["touches", "targetTouches", "changedTouches"]) {
    Object.defineProperty(event, key, { value: points });
  }
  return event;
}

describe("a click opens it", () => {
  test("a plain click opens the address, and is claimed", () => {
    mounted = mount();
    const event = mouse();
    mounted.view.contentDOM.dispatchEvent(event);
    expect(mounted.urls).toEqual(["https://example.com/"]);
    expect(mounted.notes).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  test("a tap opens it too", () => {
    mounted = mount();
    mounted.view.contentDOM.dispatchEvent(touch("touchstart", [{ clientX: 1, clientY: 1 }]));
    mounted.view.contentDOM.dispatchEvent(touch("touchend", []));
    expect(mounted.urls).toEqual(["https://example.com/"]);
  });

  test("⌥-click is the caret's, as it is on a note link", () => {
    mounted = mount();
    mounted.view.contentDOM.dispatchEvent(mouse({ altKey: true }));
    expect(mounted.urls).toEqual([]);
  });

  test("a link already showing its source takes the caret", () => {
    mounted = mount({ caretAt: 3 });
    mounted.view.contentDOM.dispatchEvent(mouse());
    expect(mounted.urls).toEqual([]);
  });

  test("a surface that cannot open one leaves it as text", () => {
    mounted = mount({ canOpen: false });
    mounted.view.contentDOM.dispatchEvent(mouse());
    expect(mounted.urls).toEqual([]);
    expect(mounted.notes).toEqual([]);
  });
});

describe("the native host re-checks what the web view asks it to open", () => {
  function host() {
    const opened: string[] = [];
    const bridge = createHostBridge(() => {}, {
      onChange: () => {},
      onSave: () => {},
      onOpenUrl: (url) => opened.push(url),
    });
    const ask = (url: unknown) =>
      bridge.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "open-url", url }));
    return { opened, ask };
  }

  /*
    The host re-runs `webUrl` in React Native, whose `URL` is not a browser's
    and appends a `/` to `mailto:`. Comparing strings is only sound because
    `webUrl` never parses; the mail case is the one that would catch it.
  */
  test("a web address reaches the sink", () => {
    const { opened, ask } = host();
    ask("https://example.com/");
    ask("mailto:someone@example.com");
    expect(opened).toEqual(["https://example.com/", "mailto:someone@example.com"]);
  });

  test("anything else is refused on this side, whatever the guest decided", () => {
    // The guest is the side that would be compromised, so its answer is not
    // trusted: a string `webUrl` does not return unchanged never reaches
    // `Linking`.
    const { opened, ask } = host();
    ask("javascript:alert(1)");
    ask("file:///etc/hosts");
    ask("example.com");
    ask(42);
    expect(opened).toEqual([]);
  });
});
