/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import {
  APPLY_STRUCTURE,
  useOnboarding,
  type OnboardingController,
} from "../features/onboarding/useOnboarding";
import { afterStructure } from "../features/onboarding/flow";

// React only treats `act` as authoritative when this is set, and warns loudly on
// every call when it is not. Setting it keeps the suite's output readable and
// makes an update outside `act` a signal rather than background noise.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The first run, mounted and driven.
 *
 * `consoleRenderLoop.test.ts` explains why a hook that talks to Convex needs a
 * real reconciler and cannot be probed with `renderToStaticMarkup`; the same
 * reasoning applies here, and this file adds the other half — it does not just
 * check that the hook mounts, it **presses the buttons** and looks at what
 * reached the client.
 *
 * That distinction is the whole reason this file exists. Every pure module
 * beside `useOnboarding` was tested and green while the flow's central action
 * did nothing at all:
 *
 *  - `applyStructure` looked its callable up by walking
 *    `Object.values(api.functions)`. `api` is `anyApi`, a `Proxy` with only a
 *    `get` trap, so enumeration falls through to its empty target and that
 *    expression is `[]` on every deployment there has ever been. The lookup
 *    returned `undefined` forever, and "Create these" advanced to the last
 *    screen without sending anything.
 *  - `createWorkspace` was told `structureTemplate: "custom"` before the person
 *    had been shown the choice, under a comment saying nothing was decided
 *    there.
 *  - the custom-folder editor's output had no path to a server at all.
 *
 * None of those is visible from a pure function. All of them are visible from
 * "what did the client get asked to do".
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRef = FunctionReference<any, any, any, any>;

interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * The smallest client the Convex hooks accept, plus a tape.
 *
 * Queries answer from a table keyed by function name, so the fake deployment
 * can say "that name is free" and "that bucket is connected" without a socket.
 * Mutations and actions record and resolve — what this file asserts on is the
 * tape.
 */
function fakeConvexClient(results: Record<string, unknown>) {
  const calls: RecordedCall[] = [];

  const client = {
    watchQuery: (ref: AnyRef) => {
      const name = getFunctionName(ref);
      return {
        localQueryResult: () => results[name],
        onUpdate: () => () => {},
        journal: () => undefined,
      };
    },
    watchPaginatedQuery: () => ({
      localQueryResult: () => undefined,
      onUpdate: () => () => {},
      journal: () => undefined,
    }),
    mutation: async (ref: AnyRef, args: Record<string, unknown>) => {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      const thrown = results[`${name}:throws`];
      if (thrown !== undefined) throw thrown;
      return results[`${name}:result`] ?? {};
    },
    action: async (ref: AnyRef, args: Record<string, unknown>) => {
      calls.push({ name: getFunctionName(ref), args });
      return results[`${getFunctionName(ref)}:result`] ?? {};
    },
    connectionState: () => ({ isWebSocketConnected: true }),
  };

  return { client: client as never, calls };
}

const RUNAWAY = 30;

interface Harness {
  /** The controller as of the last render. Always current. */
  current: () => OnboardingController;
  calls: RecordedCall[];
  renders: () => number;
  act: (body: () => void | Promise<void>) => Promise<void>;
  unmount: () => void;
}

function mountOnboarding(results: Record<string, unknown> = {}): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const { client, calls } = fakeConvexClient(results);

  let latest: OnboardingController | null = null;
  let renders = 0;

  function Probe() {
    renders++;
    if (renders > RUNAWAY) throw new Error(`runaway render: ${renders} renders`);
    latest = useOnboarding();
    // An effect loop never reaches React's own re-render limit, so it has to be
    // caught here. See `consoleRenderLoop.test.ts`.
    const seen = useRef(0);
    useEffect(() => {
      seen.current++;
      if (seen.current > RUNAWAY) throw new Error(`runaway effect: ${seen.current} runs`);
    });
    return null;
  }

  const root = createRoot(container, {
    onUncaughtError: () => {},
    onCaughtError: () => {},
  });

  act(() => {
    root.render(createElement(ConvexProvider, { client }, createElement(Probe)));
  });

  return {
    current: () => {
      if (latest === null) throw new Error("the hook never rendered");
      return latest;
    },
    calls,
    renders: () => renders,
    act: async (body) => {
      await act(async () => {
        await body();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** A deployment where `seyi` is free and the bucket connected cleanly. */
function happyDeployment() {
  return {
    "functions/names:checkNameAvailable": { available: true, normalized: "seyi" },
    "functions/workspaces:createWorkspace:result": { workspaceId: "w1", slug: "seyi" },
    "functions/storage:getStorageBinding": { status: "connected", scaffoldReason: "created" },
    "functions/workspaces:applyStructure:result": {
      queued: true,
      template: "para",
      folders: [],
    },
  };
}

/** Type a name the fake deployment says is free, and claim it. */
async function claimSeyi(harness: Harness) {
  await harness.act(() => {
    harness.current().setName("seyi");
  });
  expect(harness.current().nameStatus.kind).toBe("available");
  await harness.act(() => harness.current().claim());
  expect(harness.current().claimed).toEqual({ workspaceId: "w1", slug: "seyi" });
}

describe("the flow mounts without looping", () => {
  test("a first render subscribes and settles", () => {
    const harness = mountOnboarding(happyDeployment());
    expect(harness.renders()).toBeLessThan(RUNAWAY);
    harness.unmount();
  });

  test("typing does not restart the world on every keystroke", async () => {
    // `useQueries` sets state *during render* when its spec changes identity,
    // and the availability spec changes on every character. Returning a fresh
    // `{}` for "no query yet" is the version of this that loops.
    const harness = mountOnboarding(happyDeployment());
    for (const value of ["s", "se", "sey", "seyi", "sey", "se", "s", ""]) {
      await harness.act(() => harness.current().setName(value));
    }
    expect(harness.renders()).toBeLessThan(RUNAWAY);
    harness.unmount();
  });

  test("a keystroke that asks the server nothing costs exactly one render", async () => {
    // Both names are too short to be worth checking, so the availability spec
    // is the "no queries" one before and after. Returning a fresh `{}` there —
    // rather than the shared frozen `EMPTY_QUERY_SPEC` — gives it a new
    // identity every time, and `useSubscription` answers a new identity with a
    // `setState` **during render** plus a full observer teardown and
    // resubscribe. That is two wasted renders per keystroke and, in the
    // console, was the shape that turned into an infinite loop
    // (`features/console/querySpec.ts`).
    const harness = mountOnboarding(happyDeployment());
    await harness.act(() => harness.current().setName("s"));

    const before = harness.renders();
    await harness.act(() => harness.current().setName(""));

    expect(harness.renders() - before).toBe(1);
    harness.unmount();
  });
});

describe("claiming a name", () => {
  test("does not decide the layout on the way past", async () => {
    // `structureTemplate: "custom"` used to be sent here, two screens before
    // anybody was shown the choice — and the choice screen then promised five
    // PARA folders. Passing the field *is* the decision.
    const harness = mountOnboarding(happyDeployment());
    await claimSeyi(harness);

    const create = harness.calls.find(
      (call) => call.name === "functions/workspaces:createWorkspace",
    );
    expect(create).toBeDefined();
    expect(create!.args).toEqual({
      slug: "seyi",
      displayName: "seyi",
      kind: "personal",
    });
    expect("structureTemplate" in create!.args).toBe(false);
    harness.unmount();
  });
});

describe("pressing “Create these”", () => {
  test("actually calls the mutation, with the layout that was chosen", async () => {
    // The regression: `findApplyStructure()` enumerated `api.functions`, which
    // is a `Proxy` with no `ownKeys` trap, so it was always `[]` and the button
    // silently advanced to the last screen. There was no deployment on which
    // this could work.
    const harness = mountOnboarding(happyDeployment());
    await claimSeyi(harness);

    await harness.act(() => harness.current().applyStructure());

    const applied = harness.calls.filter((call) => call.name === APPLY_STRUCTURE);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.args).toEqual({ workspaceId: "w1", template: "para" });
    // Read from `afterStructure()` rather than written out, so that moving the
    // step after this one cannot make this assertion quietly wrong — which is
    // what it was between the tools step landing and this line being updated.
    // What is being asserted is that a successful mutation *advances*, which is
    // the half the sibling test below proves a failure must not do.
    expect(harness.current().step).toBe(afterStructure());
    harness.unmount();
  });

  test("sends the folders somebody typed, which had no path to a server at all", async () => {
    const harness = mountOnboarding(happyDeployment());
    await claimSeyi(harness);

    await harness.act(() => {
      harness.current().setTemplate("custom");
    });
    await harness.act(() => {
      harness.current().setFolders([
        { name: " clients ", description: " one folder per engagement " },
        { name: "reading", description: "things to get to" },
        { name: "", description: "" },
      ]);
    });
    expect(harness.current().canApply).toBe(true);

    await harness.act(() => harness.current().applyStructure());

    const applied = harness.calls.filter((call) => call.name === APPLY_STRUCTURE);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.args).toEqual({
      workspaceId: "w1",
      template: "custom",
      folders: [
        { folder: "clients", description: "one folder per engagement" },
        { folder: "reading", description: "things to get to" },
      ],
    });
    harness.unmount();
  });

  test("holds still for a custom layout with nothing named in it", async () => {
    // `applyStructure` refuses an empty list. Sending it would put a refusal in
    // front of somebody for following the instruction on screen.
    const harness = mountOnboarding(happyDeployment());
    await claimSeyi(harness);

    await harness.act(() => harness.current().setTemplate("custom"));
    expect(harness.current().canApply).toBe(false);

    await harness.act(() => harness.current().applyStructure());
    expect(harness.calls.filter((call) => call.name === APPLY_STRUCTURE)).toHaveLength(0);
    harness.unmount();
  });

  test("a refusal is shown rather than swallowed, and does not advance the flow", async () => {
    // The old code's "this deployment has no such function" branch called
    // `setStep("done")` and said nothing — the same silent success a genuine
    // failure would now get if this were dropped. A failure is a failure.
    const harness = mountOnboarding({
      ...happyDeployment(),
      [`${APPLY_STRUCTURE}:throws`]: new Error("Could not find public function"),
    });
    await claimSeyi(harness);

    await harness.act(() => harness.current().applyStructure());

    expect(harness.calls.filter((call) => call.name === APPLY_STRUCTURE)).toHaveLength(1);
    expect(harness.current().step).not.toBe("done");
    expect(harness.current().structureFailure?.next).toMatch(/could not find public function/i);
    harness.unmount();
  });
});

describe("carrying on past a bucket we could not check", () => {
  test("is not recorded as a connected bucket", async () => {
    // The button only appears when the probe failed or timed out. Nobody has
    // looked inside that bucket — it could be a live Obsidian vault — so the
    // layout step must not open with "Your bucket is empty".
    const harness = mountOnboarding(happyDeployment());
    await claimSeyi(harness);

    await harness.act(() => harness.current().continuePastStorage());

    expect(harness.current().shape.storage).toBe("unverified");
    expect(harness.current().step).toBe("done");
    harness.unmount();
  });

  test("skipping is its own state, and also not connected", async () => {
    const harness = mountOnboarding(happyDeployment());
    await claimSeyi(harness);

    await harness.act(() => harness.current().skipStorage());

    expect(harness.current().shape.storage).toBe("skipped");
    expect(harness.current().step).toBe("done");
    harness.unmount();
  });
});
