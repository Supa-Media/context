/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { memoryStore } from "../features/offline/memory";
import { MeetingsController } from "../features/meetings/controller";
import { fakeGateway } from "../features/meetings/fakeGateway";
import { fakeRecorder } from "../features/meetings/capture/fake";
import {
  resolveTranscriber,
  setTranscriber,
  setTranscriptionClient,
  type ActionRunner,
} from "../features/meetings/capture/transcriber";

/**
 * Three things about capture that are true of the *wiring* rather than of any
 * one module, and that a review found were not true at all.
 *
 * ## A recording outlives the screens that started it, and so must its parts
 *
 * `RecordingBar` is mounted at `app/(app)/_layout.tsx` — above every route —
 * precisely because "a recording session with no visible indicator is a bug,
 * not a mode" (`docs/decisions/meetings.md`). Two things the recording needs
 * were wired to `app/(app)/meetings/_layout.tsx` instead, which is the half
 * that unmounts the moment somebody leaves the section:
 *
 *  - the Convex client the recorders ship chunks through, so leaving the
 *    section turned the rest of the meeting into audio that was recorded,
 *    base64-ed, deleted and thrown away while the bar drew a live timer;
 *  - the recorder itself, minted fresh inside the effect body, so coming *back*
 *    to the section swapped a new idle recorder into the controller and End
 *    then stopped that one — leaving the live recorder with its rotation timer,
 *    its open microphone and its `onSegment` binding, forever.
 *
 * Both are asserted here by driving the real thing rather than by reading the
 * source: a layout is mounted and unmounted, and a controller is re-configured
 * the way every screen in the feature re-configures it on mount.
 *
 * ## Nothing above `capture/` can reach the audio
 *
 * `setTranscriber` installs an object that sees every chunk's bytes, and
 * `capture/index.ts` re-exported it beside the types. `fakeTranscriber` already
 * retains every chunk by design, so one import above `capture/` is all it took
 * to keep an hour of somebody's meeting in memory — while `audio.ts` and
 * `capture/index.ts` both say in prose that nothing above there could.
 *
 * ## The sabotage record
 *
 * Broken deliberately, all three meetings-capture suites run together (230
 * tests), reverted:
 *
 *  - `retainedRecorder` returning the incoming recorder unconditionally: 1 —
 *    **"re-configuring mid-meeting keeps the recorder that is holding the
 *    microphone"**. Not "a finished meeting lets the next recorder through",
 *    which passes either way and is there to show the retention is scoped to a
 *    live recording rather than permanent.
 *  - `useTranscriptionClient()` removed from `app/(app)/_layout.tsx`: 2 —
 *    **"the layout that mounts the recording bar is the one that installs
 *    it"** and **"leaving the meetings section does not switch transcription
 *    off"**. The second is the bug as it was reported; the first is what makes
 *    the fix a placement rather than an accident.
 *  - `setTranscriber` re-exported from `capture/index.ts`: 1 — **"the barrel
 *    does not hand out a way to install a transcriber"**. "No module outside
 *    capture/ imports past the barrel" stays green, because a re-export is not
 *    a deep import — which is exactly why both are asserted.
 */

/* -------------------------------------------------------------------------- */
/*                                   mocks                                    */
/* -------------------------------------------------------------------------- */

const mockClient: ActionRunner = {
  async action() {
    return { segments: [] };
  },
};

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("expo-router", () => {
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const { createElement: h } = require("react") as typeof import("react");
  return {
    Redirect: ({ href }: { href: string }) =>
      h("div", { "data-testid": "redirect", "data-href": href }),
    Stack: () => null,
    Slot: () => null,
    useRouter: () => ({ replace: () => {}, push: () => {}, back: () => {} }),
    useLocalSearchParams: () => ({}),
    usePathname: () => "/meetings",
    useUnstableGlobalHref: () => "/meetings",
  };
});

jest.mock("convex/react", () => {
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const actual = jest.requireActual("convex/react") as Record<string, unknown>;
  return {
    ...actual,
    useConvex: () => mockClient,
    useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
    useQuery: () => undefined,
    useQueries: () => ({}),
    useAction: () => async () => ({}),
    useMutation: () => async () => ({}),
  };
});

/* eslint-disable @typescript-eslint/no-require-imports */
const AppLayout = require("../app/(app)/_layout.tsx").default as () => ReactElement;
const MeetingsLayout = require("../app/(app)/meetings/_layout.tsx")
  .default as () => ReactElement;
/* eslint-enable @typescript-eslint/no-require-imports */

// React only treats `act` as authoritative when this is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: ReactElement): { unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(node);
  });
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  setTranscriber(null);
  setTranscriptionClient(null);
});

afterEach(() => {
  setTranscriber(null);
  setTranscriptionClient(null);
});

/* -------------------------------------------------------------------------- */

describe("the transcription client outlives the meetings section", () => {
  /**
   * Where the client is installed has to be where the recording is visible,
   * because they are the same claim: the bar is at `(app)/_layout.tsx` so that
   * a recording is visible from wherever somebody is, and a recording that is
   * visible from there has to be *working* from there.
   */
  test("the layout that mounts the recording bar is the one that installs it", () => {
    const app = mount(createElement(AppLayout));
    expect(resolveTranscriber()).not.toBeNull();
    app.unmount();
  });

  /**
   * The bug: `useMeetingsSetup` installed it and cleared it on unmount, and
   * `useMeetingsSetup` lives in the meetings navigator. Leave `/meetings/*`
   * mid-meeting and from the next chunk on `send()` had nowhere to go.
   */
  test("leaving the meetings section does not switch transcription off", () => {
    const app = mount(createElement(AppLayout));
    const section = mount(createElement(MeetingsLayout));
    expect(resolveTranscriber()).not.toBeNull();

    section.unmount();

    expect(resolveTranscriber()).not.toBeNull();
    app.unmount();
  });

  /** And leaving the whole signed-in area does forget it, as it must. */
  test("leaving the signed-in area forgets it", () => {
    const app = mount(createElement(AppLayout));
    app.unmount();
    expect(resolveTranscriber()).toBeNull();
  });
});

describe("one recorder for the life of a recording", () => {
  /**
   * Every screen in this feature configures the controller on mount, and the
   * same-workspace path is a fast path that just swaps the input in. A recorder
   * minted per effect run therefore replaced the live one on a remount — and
   * `end()` stopped the replacement, which had never recorded anything.
   *
   * The sequence is ordinary: start a meeting, leave the section, tap the bar
   * (which lives a level up for exactly this reason), come back.
   */
  test("re-configuring mid-meeting keeps the recorder that is holding the microphone", async () => {
    const controller = new MeetingsController();
    const live = fakeRecorder();
    const store = memoryStore();
    const gateway = fakeGateway();
    const base = {
      workspaceId: "ws-1",
      store,
      gateway,
      device: { platform: "ios" as const, name: "a phone" },
      persistDebounceMs: 0,
    };

    await controller.configure({ ...base, recorder: live });
    await controller.start({ title: "Design review" });
    expect(live.calls).toEqual(["start"]);

    // The remount: a fresh recorder handed to the same workspace.
    const remounted = fakeRecorder();
    await controller.configure({ ...base, recorder: remounted });

    await controller.end();

    expect(live.calls).toEqual(["start", "stop"]);
    expect(remounted.calls).toEqual([]);
  });

  /** Once nothing is live, the next configuration is adopted as normal. */
  test("a finished meeting lets the next recorder through", async () => {
    const controller = new MeetingsController();
    const first = fakeRecorder();
    const base = {
      workspaceId: "ws-1",
      store: memoryStore(),
      gateway: fakeGateway(),
      device: { platform: "ios" as const, name: "a phone" },
      persistDebounceMs: 0,
    };

    await controller.configure({ ...base, recorder: first });
    await controller.start({ title: "Design review" });
    await controller.end();

    const second = fakeRecorder();
    await controller.configure({ ...base, recorder: second });
    await controller.start({ title: "Standup" });

    expect(second.calls).toEqual(["start"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                        the audio stays inside capture/                     */
/* -------------------------------------------------------------------------- */

const FEATURE_DIR = join(__dirname, "..", "features", "meetings");
const CAPTURE_DIR = join(FEATURE_DIR, "capture");
const APP_ROOT = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") return [];
      return sourceFiles(full);
    }
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
  });
}

describe("nothing above capture/ can reach the audio", () => {
  /**
   * `setTranscriber` installs an object that is handed every chunk's bytes.
   * `setTranscriptionClient` genuinely has to be reachable from above — the app
   * has one Convex client and only React can see it — and `setTranscriber` does
   * not: it exists so a test can stay off the network, and a test reaches into
   * `capture/transcriber` by its own path.
   */
  test("the barrel does not hand out a way to install a transcriber", () => {
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const barrel = require("../features/meetings/capture") as Record<string, unknown>;
    expect(Object.keys(barrel)).toContain("setTranscriptionClient");
    expect(Object.keys(barrel)).not.toContain("setTranscriber");
    expect(Object.keys(barrel)).not.toContain("fakeTranscriber");
  });

  /**
   * And the deep path is not an alternative route in, which is what makes the
   * line above a boundary rather than a preference. Everything outside
   * `capture/` imports the barrel; a module that reached past it would be one
   * import away from holding an hour of somebody's meeting in memory.
   */
  test("no module outside capture/ imports past the barrel", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(APP_ROOT)) {
      if (file.startsWith(CAPTURE_DIR)) continue;
      if (file.includes(`${join("__tests__")}`)) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+"([^"]*capture\/[^"]+)"/g)) {
        offenders.push(`${relative(APP_ROOT, file)} -> ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
