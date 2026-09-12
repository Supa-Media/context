/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PART_HEADER_RESERVE } from "@context/communications/protocol";
import { messageAnchor, planChannelDay } from "@context/communications";
import type { CommunicationEvent } from "@context/communications/protocol";
import { ChannelDayView } from "../features/console/communications/ChannelDayView";
import { space } from "../features/design/tokens";
import { emptyEditor } from "../features/console/files/editor";
import type { FileBrowser } from "../features/console/files/browser";

/**
 * The `ChannelDayView` is mounted for real here rather than tested only
 * through `day.ts`'s pure functions, because the two things this file checks
 * — the fetch cap on split parts, and the anchor scroll landing on the
 * *right* message — are decisions the component makes, not the pure shaping
 * layer. `commsDay.test.ts` already proves `shapeChannelDay`/`messageAt`
 * stitch parts and resolve an anchor correctly; this proves the component
 * wired on top of them does not turn a hostile or merely large `parts` claim
 * into an unbounded fetch storm, and does not scroll to the first message it
 * finds merely because it loaded first.
 */

function flushMicrotasks(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function browser(readRaw: FileBrowser["readRaw"]): FileBrowser {
  const noop = () => {};
  return {
    canEdit: false,
    submitForm: async () => ({ ok: true, message: "Sent." }),
    contextId: "w1",
    loading: false,
    busy: false,
    listings: {},
    expanded: new Set<string>(),
    toggleFolder: noop,
    collapseAll: noop,
    selectedPath: null,
    opening: null,
    select: () => true,
    deselect: () => true,
    search: async () => ({
      hits: [],
      indexMissing: false,
      indexIncomplete: false,
      reducedRecall: false,
      reducedRecallNotes: [],
    }),
    editor: emptyEditor,
    setDraft: noop,
    save: noop,
    flushAutosave: () => false,
    discardLocalCopies: noop,
    encryptedElsewhere: noop,
    useTheirs: noop,
    keepMine: noop,
    conflict: null,
    resolveWith: noop,
    discard: noop,
    notice: null,
    dismissNotice: noop,
    toasts: [],
    dismissToast: noop,
    clipboard: null,
    copy: noop,
    cut: noop,
    paste: noop,
    copyTo: noop,
    createNote: noop,
    createFolder: noop,
    rename: noop,
    move: noop,
    duplicate: noop,
    archive: noop,
    destroy: noop,
    setVisibility: noop,
    shareWithGroup: () => {},
    setScope: noop,
    openLinkPaths: new Set<string>(),
    linkPaths: [],
    resetPrivacy: noop,
    canResetPrivacy: false,
    canSetVisibility: false,
    canShare: false,
    shares: undefined,
    share: async () => ({ ok: false, message: null }),
    revokeShare: noop,
    setSharePreviewTitle: noop,
    copyShareLink: async () => ({ ok: false, message: null }),
    ensureListing: noop,
    readRaw,
  };
}

function commsMessage(
  overrides: Partial<CommunicationEvent> &
    Pick<CommunicationEvent, "messageId" | "threadId" | "sentAt" | "subject" | "from" | "body">,
): CommunicationEvent {
  return {
    channel: "email",
    account: "name-at-example-com",
    to: [{ address: "name@example.com" }],
    attachments: [],
    ...overrides,
  };
}

describe("ChannelDayView", () => {
  const roots: (() => void)[] = [];
  afterEach(() => {
    while (roots.length > 0) roots.pop()!();
    document.body.innerHTML = "";
    jest.restoreAllMocks();
  });

  function mount(files: FileBrowser, anchor: string | null): HTMLElement {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    roots.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    act(() => {
      root.render(
        createElement(ChannelDayView, {
          channel: "email",
          account: "name-at-example-com",
          date: "2026-09-07",
          files,
          anchor,
        }),
      );
    });
    return container;
  }

  test("a hostile `parts` claim in part 1's frontmatter does not fetch every part it names", async () => {
    // Part 1's own note is a message this scope can genuinely see; its
    // frontmatter is the one field this view trusts to say how many parts
    // exist, and nothing stops that number from being absurd — a sync bug
    // upstream, or literally a hostile write at the path. The view must not
    // turn that into thousands of `readRaw` calls.
    const requested: string[] = [];
    const readRaw: FileBrowser["readRaw"] = async (path) => {
      requested.push(path);
      if (path.endsWith("2026-09-07.md")) {
        return {
          text: [
            "---",
            'type: "channel-day"',
            'parts: "50000"',
            "---",
            "",
            "# 2026-09-07",
            "",
            "## Thread — Hello",
            "",
            "### 09:00 · Someone · Hello {#msg-0123456789abcdef}",
            "",
            "<!-- context:untrusted-communication begin nonce -->",
            "",
            "hi",
            "",
            "<!-- context:untrusted-communication end nonce -->",
          ].join("\n"),
          etag: "e1",
        };
      }
      // Every sibling part this view might ask for: answered, but counted.
      return null;
    };

    mount(browser(readRaw), null);
    // Several rounds: each resolved batch can grow `partPaths` again once
    // `parts` is learned from part 1, and each round is its own microtask.
    for (let i = 0; i < 6; i += 1) await flushMicrotasks();

    expect(requested.length).toBeLessThanOrEqual(50);
    expect(requested.length).toBeGreaterThan(1); // it did follow `parts`, just not off a cliff
  });

  test("an anchor in part 3 scrolls to that message, not to the first one that loaded", async () => {
    // Three real parts, each with one identifiable message, built with the
    // package's own renderer — not hand-typed markdown standing in for it.
    const events = [
      commsMessage({
        messageId: "<one@mail.example.net>",
        threadId: "thread-1",
        sentAt: "2026-09-07T09:00:00.000Z",
        subject: "First",
        from: { name: "Adam Okonkwo", address: "adam@example.net" },
        body: "first message",
      }),
      commsMessage({
        messageId: "<two@mail.example.net>",
        threadId: "thread-2",
        sentAt: "2026-09-07T10:00:00.000Z",
        subject: "Second",
        from: { name: "Bea Lindqvist", address: "bea@example.net" },
        body: "second message",
      }),
      commsMessage({
        messageId: "<three@mail.example.net>",
        threadId: "thread-3",
        sentAt: "2026-09-07T11:00:00.000Z",
        subject: "Third, the target",
        from: { name: "Cy Okafor", address: "cy@example.net" },
        body: "third message, the one the link points at",
      }),
    ];
    const targetAnchor = messageAnchor(events[2]);

    const day = {
      channel: "email" as const,
      account: "name-at-example-com",
      address: "name@example.com",
      date: "2026-09-07",
      nonce: "abcdef0123456789",
      now: "2026-09-07T18:04:11.221Z",
      events,
    };
    // A threshold with barely more than a header's worth of room forces one
    // message per part, so "part 3" is real.
    const parts = planChannelDay(day, { threshold: PART_HEADER_RESERVE + 50 });
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const byPath = new Map(parts.map((part) => [part.path, part.text]));

    const readRaw: FileBrowser["readRaw"] = async (path) => {
      const text = byPath.get(path);
      return text === undefined ? null : { text, etag: "e" };
    };

    // jsdom lays nothing out, so every node's real `getBoundingClientRect`
    // reads all-zero regardless of where it sits on screen — measured, not
    // assumed. `ChannelDayView` reads through `getBoundingClientRect` rather
    // than accumulating `onLayout` offsets precisely so a message nested
    // under a later thread is not shorted by the height of every thread
    // before it; to prove *that* rather than "some scroll happened", every
    // message node here is given a distinct measured position, patched in
    // before mount so the scroll effect sees it on its very first run.
    const TARGET_TOP = 900;
    const OTHER_TOP = 10;
    jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const testId = this.getAttribute("data-testid") ?? "";
      const top =
        testId === "channel-day-scroll" ? 0 : testId === `message-${targetAnchor}` ? TARGET_TOP : OTHER_TOP;
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top } as DOMRect;
    });
    const container = mount(browser(readRaw), targetAnchor);
    for (let i = 0; i < 6; i += 1) await flushMicrotasks();

    // Every message rendered — proving the split day actually stitched
    // across three real files, not just that the target part loaded alone.
    expect(container.querySelectorAll('[data-testid^="message-"]').length).toBe(3);
    expect(container.querySelector(`[data-testid="message-${targetAnchor}"]`)).not.toBeNull();

    // `react-native-web`'s `ScrollView.scrollTo` (`node.scrollTo = this.scrollTo`
    // in its own source) falls back to setting `scrollTop`/`scrollLeft`
    // directly whenever the host has no native `.scroll()` — which jsdom does
    // not — so the DOM's own `scrollTop` is the effect's real, observable
    // result, not an implementation detail this test invented.
    const scroller = container.querySelector('[data-testid="channel-day-scroll"]') as HTMLElement;
    expect(scroller.scrollTop).toBeCloseTo(TARGET_TOP - space.x4, 0);
    // Landing anywhere near either decoy's measured position — including
    // "did not move" — would mean the wrong node, or no node, was targeted.
    expect(scroller.scrollTop).not.toBeCloseTo(OTHER_TOP - space.x4, 0);
    expect(scroller.scrollTop).not.toBe(0);
  });
});
