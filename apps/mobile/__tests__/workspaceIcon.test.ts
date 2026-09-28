/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * THE MARK, WHEN ITS WORKSPACE HAS CHOSEN A FACE.
 *
 * `WorkspaceMark` drew one letter off the slug, which stops distinguishing
 * anything the moment somebody holds `@seyi` and `@supa`: two **S**es in the
 * same square, in the same colour, in the control that exists to tell contexts
 * apart. An owner can now choose a photo or an emoji.
 *
 * Four properties are worth guarding, and the first two are the ones a render
 * test can see that nothing else can.
 *
 *  1. **Status survives the icon.** The mark's fill is `tone` — a workspace
 *     whose storage is in trouble is the thing your eye lands on — and a photo
 *     covers the fill. It is inset so the tone stays as the ring around it, and
 *     an emoji is drawn *on* the fill rather than instead of it.
 *
 *  2. **NOTHING HERE NEEDS A CONVEX CLIENT.** This is the property that was
 *     got wrong first and is a product bug rather than a testing one: the first
 *     version called `useAction` inside the drawing hook, and `useAction`
 *     throws outside a `ConvexProvider`. The landing page mounts a picture of
 *     the console and the demo console has no backend at all, so a mark that
 *     needed a client was a marketing page that crashed. These tests mount
 *     every drawing surface with no provider anywhere, which is the arrangement
 *     that failed.
 *
 *  3. **A photo that has not arrived is the letter**, not a blank square that
 *     fills in a beat later.
 *
 *  4. **The picker is the owner's.** A member sees the mark and no way in.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   draw the emoji instead of the letter with no icon set          2
 *   let the photo fill the square, losing the status ring          1
 *   call useAction inside useWorkspaceIcons again                 12
 *   draw the icon trigger for a member as well as an owner         2
 *   resolve a photo leaf before its bytes are cached               1
 *   key the photo cache on the leaf alone, not on the workspace    1
 *
 * The third row is 12 of 15 because that mistake does not degrade anything —
 * it takes down every surface that draws a mark, which is what made it worth
 * restructuring the hook around rather than working around in the callers.
 *
 * The last row is the isolation one and it is deliberately in this file rather
 * than the server's. A leaf is a hash of the *bytes*, so the same leaf in two
 * workspaces is two objects in two buckets; a cache keyed on it alone would
 * serve one customer's photo to another with no request ever crossing a
 * boundary the server could refuse. The client is the only place that can be
 * wrong about it, so it is the only place that can guard it.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const { WorkspaceMark } =
  require("../features/console/WorkspaceMark") as typeof import("../features/console/WorkspaceMark");
const { useWorkspaceIcons, prefetchWorkspacePhotos } =
  require("../features/console/useWorkspaceIcons") as typeof import("../features/console/useWorkspaceIcons");
const { SwitcherMenu } =
  require("../features/console/SwitcherMenu") as typeof import("../features/console/SwitcherMenu");
const { OverviewPanel } =
  require("../features/console/settings/panels/OverviewPanel") as typeof import("../features/console/settings/panels/OverviewPanel");
const { useDemoConsoleData } =
  require("../features/console/useDemoConsoleData") as typeof import("../features/console/useDemoConsoleData");
import type { ConsoleData } from "../features/console/types";
import type { ConsoleContext } from "../features/console/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const live: Array<() => void> = [];
afterEach(() => {
  while (live.length > 0) live.pop()?.();
  document.body.innerHTML = "";
});

function context(over: Partial<ConsoleContext> & { slug: string }): ConsoleContext {
  return {
    id: `id-${over.slug}`,
    displayName: over.slug,
    role: "owner",
    kind: "shared",
    status: "ok",
    ...over,
  };
}

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => root.render(element));
  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

/**
 * Put a photo in the module cache the way the console does, and wait for it.
 *
 * Through `prefetchWorkspacePhotos` rather than by reaching into the cache, so
 * these tests exercise the path `useLiveConsoleData` actually calls.
 */
async function held(slug: string, leaf: string): Promise<ConsoleContext> {
  const ctx = context({ slug, icon: { kind: "photo", leaf } });
  prefetchWorkspacePhotos([ctx], async () => ({
    bytes: new Uint8Array([137, 80, 78, 71]).buffer,
    contentType: "image/png",
  }));
  await Promise.resolve();
  await Promise.resolve();
  return ctx;
}

/** The mark, drawn for a context, through the real resolver. */
function Mark({ ctx }: { ctx: ConsoleContext }) {
  const iconFor = useWorkspaceIcons();
  return createElement(WorkspaceMark, {
    label: `@${ctx.slug}`,
    tone: ctx.status === "neutral" ? "neutral" : ctx.status,
    icon: iconFor(ctx),
  });
}

/* -------------------------------------------------------------------------- */

describe("what the mark draws", () => {
  test("a workspace that has chosen nothing still draws its letter", () => {
    const container = mount(createElement(Mark, { ctx: context({ slug: "seyi" }) }));
    expect(container.textContent).toBe("S");
  });

  test("an emoji replaces the letter, and the letter is not also drawn", () => {
    const container = mount(
      createElement(Mark, {
        ctx: context({ slug: "seyi", icon: { kind: "emoji", emoji: "🧠" } }),
      }),
    );
    expect(container.textContent).toBe("🧠");
    // The bug this pins is a mark that draws both, which at 18pt is a smudge.
    expect(container.textContent).not.toContain("S");
  });

  test("two workspaces that share a letter no longer share a mark", () => {
    // The whole reason the feature exists, asserted as the difference it makes.
    const seyi = mount(
      createElement(Mark, {
        ctx: context({ slug: "seyi", icon: { kind: "emoji", emoji: "🧠" } }),
      }),
    );
    const supa = mount(
      createElement(Mark, {
        ctx: context({ slug: "supa", icon: { kind: "emoji", emoji: "🏗" } }),
      }),
    );
    expect(seyi.textContent).not.toBe(supa.textContent);
  });

  test("a photo is drawn, and no letter is drawn under it", async () => {
    const ctx = await held("seyi", "icon-drawn.png");
    const container = mount(createElement(Mark, { ctx }));
    expect(container.querySelector("img")?.getAttribute("src")).toContain("data:image/png;base64,");
    expect(container.textContent).toBe("");
  });

  test("the photo does not fill the square, so the status ring survives", async () => {
    const ctx = await held("seyi", "icon-inset.png");
    const container = mount(createElement(Mark, { ctx }));
    const mark = container.firstElementChild as HTMLElement;
    const photo = mark.firstElementChild as HTMLElement;
    /*
      16 inside 18. The point of margin either side is what keeps `tone` visible
      once a photo covers the fill, and without it a workspace whose bucket is
      failing looks exactly like one that is fine.

      Compared as *different* rather than read as pixels: react-native-web emits
      atomic class names and injects no stylesheet under jsdom, so there is no
      computed width here to assert. Two width classes that differ is the
      strongest true statement available — see the header for what that means
      the pixels are worth.
    */
    const widthClass = (el: HTMLElement) =>
      Array.from(el.classList).find((name) => name.startsWith("r-width-"));
    expect(widthClass(photo)).toBeDefined();
    expect(widthClass(photo)).not.toBe(widthClass(mark));
  });

  test("the tone still reaches the mark when a photo covers its fill", async () => {
    const base = await held("seyi", "icon-tone.png");
    const fill = (status: ConsoleContext["status"]) => {
      const container = mount(
        createElement(Mark, { ctx: { ...base, status } }),
      );
      /*
        Asserted rather than assumed. Without this the test passes for the wrong
        reason — two *letter* marks also differ by tone — which is exactly how
        it first went green while the photo was not being drawn at all.
      */
      expect(container.querySelector("img")).not.toBeNull();
      const mark = container.firstElementChild as HTMLElement;
      return Array.from(mark.classList).find((name) => name.startsWith("r-backgroundColor-"));
    };
    // A failing bucket and a healthy one are still two different marks.
    expect(fill("crit")).not.toBe(fill("ok"));
  });

  test("a photo that has not arrived is the letter, not a blank square", () => {
    const container = mount(
      createElement(Mark, {
        ctx: context({ slug: "seyi", icon: { kind: "photo", leaf: "icon-never-fetched.png" } }),
      }),
    );
    expect(container.textContent).toBe("S");
    expect(container.querySelector("img")).toBeNull();
  });
});

/**
 * The arrangement that broke the first version of this feature.
 *
 * Every one of these mounts a real drawing surface with **no `ConvexProvider`
 * anywhere in the tree**, which is how the landing page and the demo console
 * mount them. A `useAction` in the drawing path throws here, which is what it
 * would do in front of somebody reading the marketing page.
 */
describe("drawing a mark needs no backend", () => {
  test("the mark resolver runs with no provider in the tree", () => {
    expect(() =>
      mount(
        createElement(Mark, {
          ctx: context({ slug: "seyi", icon: { kind: "emoji", emoji: "🧠" } }),
        }),
      ),
    ).not.toThrow();
  });

  test("the account card draws four workspaces with no provider in the tree", () => {
    const contexts = [
      context({ slug: "seyi", kind: "personal", icon: { kind: "emoji", emoji: "🧠" } }),
      context({ slug: "supa", role: "editor", icon: { kind: "emoji", emoji: "🏗" } }),
      context({ slug: "public-worship", role: "member" }),
      // A photo nobody has fetched: the card must not reach for it itself.
      context({ slug: "context-lc", role: "member", icon: { kind: "photo", leaf: "icon-b.png" } }),
    ];
    let base: ConsoleData | null = null;
    function Probe() {
      base = useDemoConsoleData();
      return null;
    }
    mount(createElement(Probe));
    if (base === null) throw new Error("the demo console did not resolve");
    const data: ConsoleData = { ...(base as ConsoleData), contexts };
    mount(createElement(SwitcherMenu, { data, label: "@seyi", onOpenContext: () => {} }));
    const trigger = document.body.querySelector<HTMLElement>('[data-testid="account-switcher"]');
    if (trigger === null) throw new Error("no account button");
    act(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (const slug of ["seyi", "supa", "public-worship", "context-lc"]) {
      expect(document.body.querySelector(`[data-testid="switcher-context-${slug}"]`)?.textContent).toContain(
        `@${slug}`,
      );
    }
  });
});

describe("the cache is keyed on the leaf, which is a content hash", () => {
  test("two workspaces do not share one workspace's photo", async () => {
    const calls: string[] = [];
    const contexts = [
      context({ slug: "one", icon: { kind: "photo", leaf: "icon-shared.png" } }),
      context({ slug: "two", icon: { kind: "photo", leaf: "icon-shared.png" } }),
    ];
    prefetchWorkspacePhotos(contexts, async (args) => {
      calls.push(args.workspaceId);
      return { bytes: new Uint8Array([7]).buffer, contentType: "image/png" };
    });
    await Promise.resolve();
    /*
      The same leaf in two workspaces is two objects in two buckets — the leaf
      is a hash of the bytes, not an identifier of the picture's owner — so this
      is two requests and not one. A cache keyed on the leaf alone would serve
      one workspace's photo for the other, across a tenant boundary.
    */
    expect(calls).toEqual(["id-one", "id-two"]);
  });

  test("a photo already held is not fetched again", async () => {
    let calls = 0;
    const contexts = [context({ slug: "held", icon: { kind: "photo", leaf: "icon-held.png" } })];
    const read = async () => {
      calls += 1;
      return { bytes: new Uint8Array([7]).buffer, contentType: "image/png" };
    };
    prefetchWorkspacePhotos(contexts, read);
    await Promise.resolve();
    await Promise.resolve();
    prefetchWorkspacePhotos(contexts, read);
    expect(calls).toBe(1);
  });

  test("a photo that cannot be read is asked for once, then left alone", async () => {
    let calls = 0;
    const contexts = [context({ slug: "gone", icon: { kind: "photo", leaf: "icon-gone.png" } })];
    const read = async () => {
      calls += 1;
      throw new Error("bucket is down");
    };
    prefetchWorkspacePhotos(contexts, read);
    await Promise.resolve();
    await Promise.resolve();
    prefetchWorkspacePhotos(contexts, read);
    /*
      Once. A failing bucket must not become a request per render for as long as
      the app is open — the mark falls back to the letter, so the failure is
      invisible and has to be cheap.
    */
    expect(calls).toBe(1);
  });
});

/**
 * Who gets a way in.
 *
 * The icon is drawn in the rail of every member of a shared workspace, so
 * choosing it goes with the workspace's name and its storage rather than with
 * the notes an editor may write. The server refuses a non-owner either way —
 * `apps/convex/__tests__/workspaceIcon.test.ts` proves that — and this is the
 * other half: a control that is **absent** rather than present-and-refusing,
 * which is the settings catalogue's own stated rule.
 */
describe("choosing an icon is the owner's", () => {
  /** The demo console, resolved before mounting: an `act` inside an `act` never flushes. */
  function demoData(): ConsoleData {
    let data: ConsoleData | null = null;
    function Probe() {
      data = useDemoConsoleData();
      return null;
    }
    mount(createElement(Probe));
    if (data === null) throw new Error("the demo console did not resolve");
    return data;
  }

  function panelFor(role: string): HTMLElement {
    const base = demoData();
    const selected = base.contexts[0];
    if (selected === undefined) throw new Error("the demo console has no contexts");
    const data: ConsoleData = {
      ...base,
      selectedContextId: selected.id,
      contexts: base.contexts.map((entry) =>
        entry.id === selected.id ? { ...entry, role } : entry,
      ),
    };
    // `onSelect` present, which is what the console passes and the landing page
    // does not — see `OverviewPanel`'s own note on that prop.
    return mount(createElement(OverviewPanel, { data, onSelect: () => {} }));
  }

  const trigger = (container: HTMLElement) =>
    container.querySelector('[data-testid="overview-icon-trigger"]');

  test("an owner can press the mark to change it", () => {
    expect(trigger(panelFor("owner"))).not.toBeNull();
  });

  test("an editor gets the mark and no way in", () => {
    expect(trigger(panelFor("editor"))).toBeNull();
  });

  test("a member gets the mark and no way in", () => {
    const container = panelFor("member");
    expect(trigger(container)).toBeNull();
    // The identity block is still drawn: what is withheld is the control, not
    // the workspace's face.
    expect(container.querySelector('[data-testid="overview-identity"]')).not.toBeNull();
  });
});
