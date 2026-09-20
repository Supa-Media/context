/**
 * @jest-environment jsdom
 */

/**
 * Which frame is told what, decided where it is actually decided.
 *
 * ## Why this file exists
 *
 * `runtime.ts` has `maySeePaths`, `maySeeContent`, `invokeFor`, `suggestFor`
 * and `previewFor`, each with its own tests, each correct. **Nothing tested
 * that the farm wires the right one to the right prop** — and a farm that
 * passed `maySeePaths` where it meant `maySeeContent` would hand a plugin
 * approved for tags and links the sentences somebody is writing, with every
 * unit test in the section still green.
 *
 * Found by sabotage: swapping the two gates in `PluginSandboxFarm.tsx` reddened
 * nothing at all. So this mounts the farm with a stub in place of the sandbox
 * and reads what each frame was handed.
 *
 * The stub is the point rather than a shortcut: the real `PluginSandbox` mounts
 * an iframe or a WebView, and what is under test here is the routing decision
 * in front of it.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

interface SlotProps {
  bundle: { pluginId: string };
  nonce: string;
  activeFile?: { path: string } | null;
  vaultEvent?: { seq: number };
  invoke?: { seq: number; id: string };
  suggest?: { seq: number; line: string; ch: number };
  preview?: { seq: number; links: { href: string; text: string }[] };
}

const handed: SlotProps[] = [];

jest.mock("../features/console/plugins/PluginSandbox", () => ({
  PluginSandbox: (props: SlotProps) => {
    handed.push(props);
    return null;
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PluginSandboxFarm } from "../features/console/plugins/PluginSandboxFarm";
import type { PluginGrant } from "../features/console/plugins/grants";
import type { ActiveSandbox } from "../features/console/plugins/runtime";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  handed.length = 0;
  document.body.innerHTML = "";
});

function bundle(pluginId: string) {
  return {
    pluginId,
    version: "1.0.0",
    bundleFingerprint: `fp-${pluginId}`,
    manifestJson: "{}",
    mainJs: "",
    stylesCss: null,
    runtimeToken: "token",
    expiresAt: 0,
  };
}

function frame(pluginId: string, nonce: string): ActiveSandbox {
  return { bundle: bundle(pluginId), nonce, attempts: 1 };
}

function grant(pluginId: string, capabilities: PluginGrant["capabilities"]): PluginGrant {
  return {
    pluginId,
    bundleFingerprint: `fp-${pluginId}`,
    capabilities,
    networkHosts: [],
    status: "active",
    grantedAt: 1,
    updatedAt: 1,
  };
}

const LINKS = [{ href: "https://www.bible.com/bible/1/JHN.3.16", text: "John 3:16" }];

function mount(props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(PluginSandboxFarm, props as never));
  });
  roots.push(() => act(() => root.unmount()));
}

function given(pluginId: string): SlotProps | undefined {
  return handed.find((one) => one.bundle.pluginId === pluginId);
}

describe("content goes to fewer plugins than paths do", () => {
  const sandboxes = [frame("reader", "frame-reader"), frame("tagger", "frame-tagger")];
  const grants = [grant("reader", ["vault:read"]), grant("tagger", ["metadata:read"])];

  function both() {
    mount({
      sandboxes,
      onEvent: () => {},
      activeFile: { path: "1-projects/john-3.md", etag: "e1" },
      suggest: { seq: 1, pluginId: "reader", nonce: "frame-reader", line: "@ John", ch: 6 },
      preview: { seq: 2, pluginId: "reader", nonce: "frame-reader", links: LINKS },
      grants,
    });
  }

  test("a plugin granted vault:read is told the path, the line and the links", () => {
    both();
    const reader = given("reader");
    expect(reader?.activeFile?.path).toBe("1-projects/john-3.md");
    expect(reader?.suggest).toEqual({ seq: 1, line: "@ John", ch: 6 });
    expect(reader?.preview).toEqual({ seq: 2, links: LINKS });
  });

  /*
    THE ONE THE SABOTAGE FOUND NOTHING FOR.

    `metadata:read` is a real grant with a real meaning — frontmatter, headings,
    tags, the link graph — and it is the gate for a *path*. It is not the gate
    for a line somebody is typing, and it is not the gate for the URLs in their
    note. A farm that used the looser gate for either would pass every unit test
    in this section.
  */
  test("a plugin granted only metadata:read is told the path and nothing else", () => {
    /*
      Addressed to the tagger, which is the whole point and was the bug in the
      first version of this test: aimed at the *reader*, the tagger gets nothing
      because of the routing, and swapping the gate for the looser one left it
      green. A test that cannot fail for the reason it names is not a test.
    */
    mount({
      sandboxes,
      onEvent: () => {},
      activeFile: { path: "1-projects/john-3.md", etag: "e1" },
      suggest: { seq: 1, pluginId: "tagger", nonce: "frame-tagger", line: "@ John", ch: 6 },
      preview: { seq: 2, pluginId: "tagger", nonce: "frame-tagger", links: LINKS },
      grants,
    });
    const tagger = given("tagger");
    expect(tagger?.activeFile?.path).toBe("1-projects/john-3.md");
    expect(tagger?.suggest).toBeUndefined();
    expect(tagger?.preview).toBeUndefined();
  });

  test("with no grants at all, nobody is told anything", () => {
    mount({
      sandboxes,
      onEvent: () => {},
      activeFile: { path: "1-projects/john-3.md", etag: "e1" },
      suggest: { seq: 1, pluginId: "tagger", nonce: "frame-tagger", line: "@ John", ch: 6 },
      preview: { seq: 2, pluginId: "tagger", nonce: "frame-tagger", links: LINKS },
    });
    for (const one of handed) {
      expect(one.activeFile).toBeNull();
      expect(one.suggest).toBeUndefined();
      expect(one.preview).toBeUndefined();
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("an instruction reaches one frame, and never its successor", () => {
  const sandboxes = [frame("reader", "frame-2")];
  const grants = [grant("reader", ["vault:read"])];

  test("a query aimed at the frame that has gone reaches nobody", () => {
    mount({
      sandboxes,
      onEvent: () => {},
      // Both aimed at `frame-1`, which a restart replaced with `frame-2`.
      suggest: { seq: 1, pluginId: "reader", nonce: "frame-1", line: "@ John", ch: 6 },
      preview: { seq: 2, pluginId: "reader", nonce: "frame-1", links: LINKS },
      invoke: { seq: 3, pluginId: "reader", nonce: "frame-1", id: "generate-links" },
      grants,
    });
    const reader = given("reader");
    expect(reader?.suggest).toBeUndefined();
    expect(reader?.preview).toBeUndefined();
    expect(reader?.invoke).toBeUndefined();
  });

  test("and one aimed at the live frame reaches it", () => {
    mount({
      sandboxes,
      onEvent: () => {},
      suggest: { seq: 1, pluginId: "reader", nonce: "frame-2", line: "@ John", ch: 6 },
      preview: { seq: 2, pluginId: "reader", nonce: "frame-2", links: LINKS },
      invoke: { seq: 3, pluginId: "reader", nonce: "frame-2", id: "generate-links" },
      grants,
    });
    const reader = given("reader");
    expect(reader?.suggest).toEqual({ seq: 1, line: "@ John", ch: 6 });
    expect(reader?.preview).toEqual({ seq: 2, links: LINKS });
    expect(reader?.invoke).toEqual({ seq: 3, id: "generate-links" });
  });

  /*
    A command is routed but deliberately not gated: running something the owner
    pressed is not a read, and the plugin it belongs to is the only one told.
    Asserted here so that "gate everything" does not get applied to it by
    someone tidying, and break every command for a plugin with no read grant.
  */
  test("a command still runs for a plugin with no read grant at all", () => {
    mount({
      sandboxes,
      onEvent: () => {},
      invoke: { seq: 3, pluginId: "reader", nonce: "frame-2", id: "generate-links" },
      grants: [grant("reader", ["settings:read"])],
    });
    expect(given("reader")?.invoke).toEqual({ seq: 3, id: "generate-links" });
  });
});
