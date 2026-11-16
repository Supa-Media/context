/**
 * @jest-environment jsdom
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * "Sign out everywhere" (Dev2, 2026-11-16: "sign out of all devices I'm
 * currently signed into").
 *
 * The order is the feature. Unsent work is asked about while this session can
 * still answer; the server ends every session next; only then does this device
 * clear its copy and leave. A refusal (no emailed code, a network failure)
 * must leave this device exactly as it was, signed in with its notes, so the
 * person can try again rather than be half signed out.
 */

const mockSteps: string[] = [];
let mockUnsent = { pending: 0, conflicted: 0, rejected: 0 };

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({
    replace: (href: string) => {
      mockSteps.push(`go ${href}`);
    },
  }),
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({
    signOut: async () => {
      mockSteps.push("sign out here");
    },
  }),
}));

jest.mock("../features/offline/forget", () => ({
  forgetLocalCopies: async () => {
    mockSteps.push("forget");
    return { verdict: "cleared" };
  },
  unsentOnDevice: async () => mockUnsent,
  unsentMeetingAudio: () => 0,
}));

let mockSessions: { id: string; signedInAt: number; current: boolean }[] | undefined = [];

jest.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: (ref: unknown) => (String(ref).includes("mySessions") ? mockSessions : null),
  useMutation: () => async () => {
    mockSteps.push("server");
    return { signedOut: 2 };
  },
}));

jest.mock("@context/convex/_generated/api", () => ({
  api: new Proxy(
    {},
    {
      get: (_target, area: string) =>
        new Proxy({}, { get: (_t, mod: string) => new Proxy({}, { get: (_x, fn: string) => `${area}.${mod}.${fn}` }) }),
    },
  ),
}));

const { useSignOutFlow } =
  require("../features/console/useSignOutFlow") as typeof import("../features/console/useSignOutFlow");
const { AccountSafetyCard } =
  require("../features/console/settings/panels/AccountSafetyCard") as typeof import("../features/console/settings/panels/AccountSafetyCard");

type Flow = ReturnType<typeof useSignOutFlow>;

const DATA = {
  selectedContextId: "w1",
  files: { sync: { counts: { pending: 0, conflicted: 0, rejected: 0 }, ready: true } },
} as never;

function mountFlow() {
  let flow: Flow | null = null;
  function Host() {
    flow = useSignOutFlow(DATA);
    return flow.dialog as never;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(Host)));
  return {
    flow: () => flow!,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function settle() {
  for (let turn = 0; turn < 4; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function buttonLabelled(label: string): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>("[role=button], button")].find(
    (node) => node.textContent === label,
  );
  if (found === undefined) throw new Error(`no button "${label}" in: ${document.body.textContent}`);
  return found;
}

async function press(node: HTMLElement) {
  await act(async () => {
    node.click();
  });
  await settle();
}

beforeEach(() => {
  mockSteps.length = 0;
  mockUnsent = { pending: 0, conflicted: 0, rejected: 0 };
  mockSessions = [];
  document.body.innerHTML = "";
});

describe("signing out everywhere", () => {
  test("ends every session on the server first, then clears this device and leaves", async () => {
    const app = mountFlow();
    let finished = false;
    void app.flow().requestSignOutEverywhere(async () => {
      mockSteps.push("server");
    }).then(() => {
      finished = true;
    });
    await settle();
    expect(mockSteps).toEqual(["server", "forget", "sign out here", "go /"]);
    expect(finished).toBe(true);
    app.unmount();
  });

  test("a refusal leaves this device signed in with its notes, and reaches the button", async () => {
    const app = mountFlow();
    let refused: unknown = null;
    void app
      .flow()
      .requestSignOutEverywhere(async () => {
        mockSteps.push("server");
        throw new Error("Check it's you: confirm with a code we email you.");
      })
      .catch((failure: unknown) => {
        refused = failure;
      });
    await settle();
    expect(mockSteps).toEqual(["server"]);
    expect((refused as Error).message).toMatch(/Check it's you/);
    app.unmount();
  });

  test("with unsent work it asks before anything happens, and Cancel does nothing", async () => {
    mockUnsent = { pending: 2, conflicted: 0, rejected: 0 };
    const app = mountFlow();
    let finished = false;
    void app.flow().requestSignOutEverywhere(async () => {
      mockSteps.push("server");
    }).then(() => {
      finished = true;
    });
    await settle();
    expect(document.body.textContent).toContain("Sign out everywhere with work still on this device?");
    expect(mockSteps).toEqual([]);
    await press(buttonLabelled("Cancel"));
    expect(mockSteps).toEqual([]);
    expect(finished).toBe(true);
    app.unmount();
  });

  test("with unsent work, confirming signs out everywhere in the same order", async () => {
    mockUnsent = { pending: 1, conflicted: 0, rejected: 0 };
    const app = mountFlow();
    void app.flow().requestSignOutEverywhere(async () => {
      mockSteps.push("server");
    });
    await settle();
    await press(buttonLabelled("Sign out everywhere and discard"));
    expect(mockSteps).toEqual(["server", "forget", "sign out here", "go /"]);
    app.unmount();
  });

  test("plain Sign out still asks in its own words and never touches other devices", async () => {
    mockUnsent = { pending: 1, conflicted: 0, rejected: 0 };
    const app = mountFlow();
    act(() => app.flow().requestSignOut());
    await settle();
    expect(document.body.textContent).toContain("Sign out with work still on this device?");
    await press(buttonLabelled("Sign out and discard"));
    expect(mockSteps).toEqual(["forget", "sign out here", "go /"]);
    app.unmount();
  });
});

describe("the Signed in card", () => {
  function mountCard(onSignOutEverywhere?: (call: () => Promise<unknown>) => Promise<void>) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(AccountSafetyCard, { onSignOutEverywhere })));
    return () => {
      act(() => root.unmount());
      container.remove();
    };
  }
  const find = () => document.body.querySelector<HTMLElement>('[data-testid="account-sign-out-everywhere"]');

  test("offers it once another device is signed in, and hands the server call to the flow", async () => {
    mockSessions = [
      { id: "s1", signedInAt: 1, current: true },
      { id: "s2", signedInAt: 2, current: false },
    ];
    const asked: string[] = [];
    const unmount = mountCard(async (call) => {
      asked.push("flow");
      await call();
    });
    expect(find()).not.toBeNull();
    await press(find()!);
    expect(asked).toEqual(["flow"]);
    expect(mockSteps).toEqual(["server"]);
    unmount();
  });

  test("not with this device alone: that is the plain Sign out", () => {
    mockSessions = [{ id: "s1", signedInAt: 1, current: true }];
    const unmount = mountCard(async () => {});
    expect(find()).toBeNull();
    unmount();
  });

  test("not where there is no session to end", () => {
    mockSessions = [
      { id: "s1", signedInAt: 1, current: true },
      { id: "s2", signedInAt: 2, current: false },
    ];
    const unmount = mountCard(undefined);
    expect(find()).toBeNull();
    unmount();
  });

  test("a refusal is said on the card", async () => {
    mockSessions = [
      { id: "s1", signedInAt: 1, current: true },
      { id: "s2", signedInAt: 2, current: false },
    ];
    const unmount = mountCard(async () => {
      throw { data: { message: "Check it's you: confirm with a code we email you." } };
    });
    await press(find()!);
    expect(document.body.textContent).toContain("Check it's you");
    unmount();
  });
});
