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
  const listeners = new Set<() => void>();

  const client = {
    watchQuery: (ref: AnyRef) => {
      const name = getFunctionName(ref);
      return {
        localQueryResult: () => results[name],
        // Subscribers are kept so a test can change an answer and tell them —
        // the way a probe landing reaches the hook in production.
        onUpdate: (callback: () => void) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
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

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return { client: client as never, calls, notify };
}

const RUNAWAY = 30;

interface Harness {
  /** The controller as of the last render. Always current. */
  current: () => OnboardingController;
  calls: RecordedCall[];
  renders: () => number;
  act: (body: () => void | Promise<void>) => Promise<void>;
  /** Tell every subscription its answer may have changed. */
  notify: () => Promise<void>;
  unmount: () => void;
}

function mountOnboarding(
  results: Record<string, unknown> = {},
  options: Parameters<typeof useOnboarding>[0] = {},
): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const { client, calls, notify } = fakeConvexClient(results);

  let latest: OnboardingController | null = null;
  let renders = 0;

  function Probe() {
    renders++;
    if (renders > RUNAWAY) throw new Error(`runaway render: ${renders} renders`);
    latest = useOnboarding(options);
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
    notify: async () => {
      await act(async () => {
        notify();
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

describe("leaving the storage step without a verified bucket", () => {
  test("carrying on past a failed check goes to the console and writes nothing", async () => {
    // Nobody has looked inside that bucket — it could be a live Obsidian vault
    // — so no layout is asked for on the way out.
    const harness = mountOnboarding(happyDeployment());
    await claimSeyi(harness);
    await harness.act(() => harness.current().pickOwn());

    await harness.act(() => harness.current().continuePastStorage());

    expect(harness.current().finished).toBe(true);
    expect(harness.calls.map((call) => call.name)).not.toContain(APPLY_STRUCTURE);
    harness.unmount();
  });

  test("“I'll do this later” goes to the console too, and writes nothing", async () => {
    const harness = mountOnboarding(happyDeployment());
    await claimSeyi(harness);
    await harness.act(() => harness.current().pickOwn());

    await harness.act(() => harness.current().skipStorage());

    expect(harness.current().finished).toBe(true);
    expect(harness.calls.map((call) => call.name)).not.toContain(APPLY_STRUCTURE);
    harness.unmount();
  });
});

describe("coming back from Stripe with a managed bucket", () => {
  /**
   * A deployment where the payment landed and provisioning already finished.
   *
   * This is the state the person in the bug report was actually in: the bucket
   * existed, the binding said `connected`, and a second tab showed the app
   * using it — while `/welcome?checkout=done` sat on "Creating your storage".
   */
  function settledManagedDeployment(bindingStatus: string) {
    return {
      "functions/workspaces:listMyWorkspaces": [
        { workspaceId: "w1", slug: "blessing", kind: "personal", role: "owner" },
      ],
      "functions/storage:getStorageBinding": {
        status: bindingStatus,
        scaffoldReason: "created",
      },
      "functions/billing:status": {
        status: "active",
        selected: { managedStorage: true, fastSearch: false },
        active: { managedStorage: true, fastSearch: false },
        canManage: true,
        configured: true,
        priceCents: 500,
        currency: "usd",
        interval: "month",
        ceilingBytes: 50 * 1024 * 1024 * 1024,
        storageIsManaged: true,
        managedStorageAvailable: true,
        managedProvisioning: "ready",
      },
    };
  }

  test("the settling screen hands over once the bucket answers", () => {
    /*
      THE DEFECT THIS FILE EXISTS FOR, IN ITS SECOND FORM.

      Managed storage is bound by the control plane while the person is at
      Stripe, so the client that comes back has submitted nothing — it is a
      fresh page load. `connectProgress` read that as `idle`, `storageReady`
      was false forever, and the hand-off past the storage step never fired:
      a paid-for, working bucket behind a spinner that could not stop.
    */
    const harness = mountOnboarding(settledManagedDeployment("connected"), {
      resume: "storage",
      checkout: "done",
    });

    expect(harness.current().claimed).toEqual({ workspaceId: "w1", slug: "blessing" });
    expect(harness.current().connectState.kind).toBe("connected");
    expect(harness.current().finished).toBe(true);
    harness.unmount();
  });

  test("a bucket that was already laid out is not asked to be laid out again", async () => {
    // `created` is a layout the provisioning run already wrote.
    // `applyStructure` refuses it; asking would be a failed call on every
    // return from Stripe.
    const harness = mountOnboarding(settledManagedDeployment("connected"), {
      resume: "storage",
      checkout: "done",
    });
    await harness.notify();
    expect(harness.current().finished).toBe(true);
    expect(harness.calls.map((call) => call.name)).not.toContain(APPLY_STRUCTURE);
    harness.unmount();
  });

  test("and holds while the bucket is still being made", () => {
    // The other half of the guard: `unverified` is the ordinary wait, and
    // hurrying somebody past it lands them on a layout step for storage that
    // has not proved it can be written to.
    const harness = mountOnboarding(settledManagedDeployment("unverified"), {
      resume: "storage",
      checkout: "done",
    });

    expect(harness.current().connectState.kind).toBe("idle");
    expect(harness.current().step).toBe("storage");
    expect(harness.current().finished).toBe(false);
    harness.unmount();
  });
});

/*
  THE FORK, THE DRY RUN AND THE LIVE CHECK, PRESSED.

  Each of these is a button whose whole job is a call and a hand-off, which is
  exactly what a pure test of `flow.ts` cannot see: the free card has to reach
  `startFreeManaged` and nothing that costs money, a bucket somebody brought
  has to be reported on before the vault question, and the live check has to
  sit between the bootstrap prompt and the last screen.
*/
describe("the redesigned steps, wired", () => {
  const FAKE_VALUES = {
    provider: "r2" as const,
    endpoint: "https://0000000000000000000000000000000f.r2.cloudflarestorage.com",
    region: "auto",
    bucket: "example-bucket",
    accessKeyId: "AKIAEXAMPLEEXAMPLE00",
    secretAccessKey: "not-a-real-secret-key-for-tests-only",
    rootPrefix: "",
    forcePathStyle: null,
  };

  test("a claimed name asks where the notes live, before any storage form", async () => {
    const harness = mountOnboarding(happyDeployment());
    await claimSeyi(harness);
    expect(harness.current().step).toBe("fork");
    // No billing answer means no managed offer: the only card is their own bucket.
    expect(harness.current().forkOffer).toBeNull();
    harness.unmount();
  });

  test("the free card starts the free tier — and never a checkout", async () => {
    const results: Record<string, unknown> = {
      ...happyDeployment(),
      "functions/storage:getStorageBinding": null,
      "functions/billing:status": {
        status: "none",
        priceCents: 0,
        currency: "usd",
        interval: "month",
        selected: { managedStorage: false, fastSearch: false },
        active: { managedStorage: false, fastSearch: false },
        freeManagedAvailable: true,
        freeManagedEligible: true,
        freeManagedNoteCap: 1000,
        storageIsManaged: false,
      },
    };
    const harness = mountOnboarding(results);
    await claimSeyi(harness);
    expect(harness.current().forkOffer).toEqual({ kind: "free", cap: 1000 });

    await harness.act(() => harness.current().pickManaged());
    const names = harness.calls.map((call) => call.name);
    expect(names).toContain("functions/billing:startFreeManaged");
    expect(names).not.toContain("functions/billing:startCheckout");
    expect(names).not.toContain("functions/billing:setEntitlements");
    expect(harness.current().step).toBe("storage");
    expect(harness.current().shape.route).toBe("managed");
    harness.unmount();
  });

  test("a bucket somebody brought is reported on, then the console — and never written to", async () => {
    const results: Record<string, unknown> = {
      ...happyDeployment(),
      "functions/storage:getStorageBinding": null,
      "functions/storage:bindStorage:result": { status: "unverified" },
    };
    const harness = mountOnboarding(results);
    await claimSeyi(harness);
    await harness.act(() => harness.current().pickOwn());
    expect(harness.current().step).toBe("storage");

    // The probe lands on the subscription a moment after the bind returns.
    results["functions/storage:getStorageBinding"] = {
      status: "connected",
      provider: "r2",
      bucket: "example-bucket",
      capabilities: { conditionalWrite: true },
      scaffoldReason: "empty",
      noteCount: 0,
    };
    await harness.act(async () => {
      await harness.current().connect(FAKE_VALUES);
    });
    await harness.notify();
    expect(harness.current().step).toBe("dryrun");
    expect(harness.current().shape.route).toBe("byo");
    expect(harness.current().dryRun?.looksReady).toBe(true);
    expect(harness.current().dryRun?.bucket).toBe("example-bucket");

    await harness.act(() => harness.current().finishDryRun());
    expect(harness.current().finished).toBe(true);
    // Their bucket: nothing is laid out into it from here, empty or not. The
    // console's own offer is the only thing that ever does.
    expect(harness.calls.map((call) => call.name)).not.toContain(APPLY_STRUCTURE);
    harness.unmount();
  });

  test("“Start fresh” lays out the five folders once our bucket answers, then the console", async () => {
    const results: Record<string, unknown> = {
      ...happyDeployment(),
      "functions/storage:getStorageBinding": null,
      "functions/billing:status": {
        status: "none",
        priceCents: 0,
        currency: "usd",
        interval: "month",
        selected: { managedStorage: false, fastSearch: false },
        active: { managedStorage: false, fastSearch: false },
        freeManagedAvailable: true,
        freeManagedEligible: true,
        freeManagedNoteCap: 1000,
        storageIsManaged: false,
      },
    };
    const harness = mountOnboarding(results);
    await claimSeyi(harness);
    await harness.act(() => harness.current().pickManaged());
    expect(harness.current().finished).toBe(false);

    // Our bucket is made and verifies — empty, because nothing has written to it.
    results["functions/storage:getStorageBinding"] = { status: "connected", scaffoldReason: "empty" };
    await harness.notify();

    const layout = harness.calls.find((call) => call.name === APPLY_STRUCTURE);
    expect(layout?.args).toEqual({ workspaceId: "w1", template: "para" });
    expect(harness.current().finished).toBe(true);
    harness.unmount();
  });

  test("a layout that fails to queue still lets them in — the console offers it again", async () => {
    const results: Record<string, unknown> = {
      ...happyDeployment(),
      "functions/storage:getStorageBinding": { status: "connected", scaffoldReason: "empty" },
      [`${APPLY_STRUCTURE}:throws`]: new Error("queue unavailable"),
      "functions/workspaces:listMyWorkspaces": [
        { workspaceId: "w1", slug: "blessing", kind: "personal", role: "owner" },
      ],
    };
    const harness = mountOnboarding(results, { resume: "storage", checkout: "done" });
    await harness.notify();
    expect(harness.calls.map((call) => call.name)).toContain(APPLY_STRUCTURE);
    expect(harness.current().finished).toBe(true);
    harness.unmount();
  });
});
