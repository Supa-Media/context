/**
 * @jest-environment jsdom
 */

/**
 * The consent screen's controls, rendered and pressed.
 *
 * ## What this is not
 *
 * It is not a security test. Nothing a person does on this screen is trusted:
 * `applyApproval` narrows whatever is submitted against the request and clamps
 * it against the approver's role, and `apps/convex/__tests__/authorizations.test.ts`
 * proves that with the argument shapes a hostile client would send. Unticking a
 * box in a browser is a convenience.
 *
 * ## What it is
 *
 * Proof that the convenience exists and is wired to the thing that gets
 * submitted. Three gaps got this feature filed, and all three were failures of
 * this layer rather than of the backend:
 *
 *  1. the requested scopes were rendered with Approve and Deny and no way to
 *     grant a subset;
 *  2. there was no read-only, because there was no way to say so;
 *  3. the privacy tier was never on screen at all — it came from the approver's
 *     membership role, so an owner always handed over every private note.
 *
 * So this presses the controls and asserts what `onDecide` receives. A screen
 * that draws tick boxes and submits the request anyway would pass every test in
 * `consentState.test.ts` and would be the same bug with a nicer picture.
 *
 * `react-native-web` renders these components to real DOM (see
 * `jest.config.js`), so the clicks below are the clicks a person makes.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";

/**
 * `ConsentBody` uses no router. `ConsentScreen`, in the same module, does — and
 * `expo-router` ships untranspiled JSX that this project's jest transform does
 * not reach into `node_modules` for. Stubbing the three names that module
 * exports is the whole of it; nothing below touches any of them.
 */
jest.mock("expo-router", () => ({
  Redirect: () => null,
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ replace: () => {} }),
}));

import { ConsentBody } from "../features/consent/ConsentScreen";
import {
  resolveConsentView,
  toggleScopeSelection,
  type AuthorizationRequest,
  type ConsentContext,
  type ConsentView,
} from "../features/consent/state";
import type { GrantableTier } from "../features/consent/scopes";

// React only treats `act` as authoritative when this is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000_000;

const OWNED: ConsentContext = { id: "w1", slug: "seyi", role: "owner" };
const EDITED: ConsentContext = { id: "w2", slug: "ignite", role: "editor" };
const READ_ONLY: ConsentContext = { id: "w3", slug: "shared", role: "member" };

const REQUEST: AuthorizationRequest = {
  requestId: "req_abc",
  clientName: "Claude Desktop",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  scope: "context:read context:write",
  scopes: ["context:read", "context:write"],
  requestedWorkspaceSlug: "seyi",
  workspaceSlug: "seyi",
  expiresAt: NOW + 300_000,
};

interface Decision {
  choice: "approve" | "deny";
  workspaceId: string | null;
  grantedScopes: string[];
}

/**
 * The screen's own state handling, minus Convex.
 *
 * `ConsentScreen` holds exactly these three pieces of state and hands them to
 * `resolveConsentView`; everything else it does is fetch and navigate. Mounting
 * the body with the same wiring exercises the real components and the real
 * resolver, and `toggleScopeSelection` is the actual function the screen calls
 * rather than a copy of it — so a change to how a tick is applied is caught
 * here rather than only in the component nobody can mount.
 */
function Harness({
  contexts,
  request,
  onDecide,
}: {
  contexts: ConsentContext[];
  request: AuthorizationRequest;
  onDecide: (decision: Decision) => void;
}) {
  const [chosenContextId, setChosenContextId] = useState<string | null>(null);
  const [chosenScopes, setChosenScopes] = useState<readonly string[] | null>(null);
  const [chosenTier, setChosenTier] = useState<GrantableTier | null>(null);

  const view: ConsentView = resolveConsentView({
    requestId: "req_abc",
    auth: { isLoading: false, isAuthenticated: true },
    request,
    contexts,
    chosenContextId,
    chosenScopes,
    chosenTier,
    decision: { kind: "idle" },
    now: NOW,
  });

  return createElement(ConsentBody, {
    view,
    onChooseContext: (id: string) => {
      setChosenContextId(id);
      setChosenScopes(null);
      setChosenTier(null);
    },
    onToggleScope: (scope: string, next: boolean) => {
      if (view.kind !== "ready") return;
      setChosenScopes(toggleScopeSelection(view.scopeChoices, scope, next));
    },
    onChooseTier: setChosenTier,
    onDecide: (choice, workspaceId, grantedScopes) =>
      onDecide({ choice, workspaceId, grantedScopes }),
    onLeaveForConsole: () => {},
    onLeaveForHome: () => {},
  });
}

interface Screen {
  q: (testID: string) => HTMLElement | null;
  text: () => string;
  click: (testID: string) => void;
  approve: () => Decision | null;
  unmount: () => void;
}

function mount(contexts: ConsentContext[], request = REQUEST): Screen {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  let last: Decision | null = null;

  act(() => {
    root.render(
      createElement(Harness, {
        contexts,
        request,
        onDecide: (decision) => {
          last = decision;
        },
      }),
    );
  });

  const q = (testID: string) =>
    container.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;

  return {
    q,
    text: () => container.textContent ?? "",
    click: (testID: string) => {
      const element = q(testID);
      if (element === null) throw new Error(`no control called ${testID}`);
      act(() => {
        element.click();
      });
    },
    approve: () => {
      act(() => {
        q("consent-approve")!.click();
      });
      return last;
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("the requested scopes are controls, not a display", () => {
  test("every requested operation is a tick box, ticked", () => {
    const screen = mount([OWNED]);
    for (const scope of ["context:read", "context:write"]) {
      const box = screen.q(`consent-scope-${scope}`);
      expect(box).not.toBeNull();
      expect(box!.getAttribute("aria-checked")).toBe("true");
    }
    screen.unmount();
  });

  test("unticking one changes what Approve submits", () => {
    const screen = mount([OWNED]);
    screen.click("consent-scope-context:write");
    expect(screen.q("consent-scope-context:write")!.getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.approve()).toEqual({
      choice: "approve",
      workspaceId: "w1",
      grantedScopes: ["context:read"],
    });
    screen.unmount();
  });

  test("touching nothing submits what the client asked for", () => {
    const screen = mount([OWNED]);
    expect(screen.approve()?.grantedScopes).toEqual(["context:read", "context:write"]);
    screen.unmount();
  });

  test("unticking everything disables Approve rather than granting nothing", () => {
    const screen = mount([OWNED]);
    screen.click("consent-scope-context:read");
    screen.click("consent-scope-context:write");
    expect(screen.q("consent-approve")!.getAttribute("aria-disabled")).toBe("true");
    expect(screen.text()).toContain("Nothing is ticked");
    screen.unmount();
  });
});

describe("the privacy tier is on the screen, and defaults to the narrow one", () => {
  test("an owner is offered both tiers with team preselected", () => {
    const screen = mount([OWNED]);
    expect(screen.q("consent-tier-team")!.getAttribute("aria-checked")).toBe("true");
    expect(screen.q("consent-tier-private")!.getAttribute("aria-checked")).toBe("false");
    screen.unmount();
  });

  test("an owner who leaves it alone does not hand over their private notes", () => {
    // The whole bug, in one assertion. This was not a default anybody chose —
    // it was the only thing an owner's grant could be.
    const screen = mount([OWNED]);
    expect(screen.approve()?.grantedScopes).not.toContain("context:private");
    screen.unmount();
  });

  test("choosing private puts the tier scope into what is submitted", () => {
    const screen = mount([OWNED]);
    screen.click("consent-tier-private");
    expect(screen.approve()?.grantedScopes).toEqual([
      "context:read",
      "context:write",
      "context:private",
    ]);
    screen.unmount();
  });

  test("choosing private rewrites the read line rather than leaving a stale one", () => {
    const screen = mount([OWNED]);
    expect(screen.text()).toContain("except notes marked private");
    screen.click("consent-tier-private");
    expect(screen.text()).not.toContain("except notes marked private");
    expect(screen.text()).toContain("including the ones you marked private");
    screen.unmount();
  });

  test("an editor gets no tier control, and is told why rather than shown a dead radio", () => {
    const screen = mount([EDITED], {
      ...REQUEST,
      requestedWorkspaceSlug: "ignite",
      workspaceSlug: "ignite",
    });
    expect(screen.q("consent-tier-private")).toBeNull();
    expect(screen.q("consent-tier-single")).not.toBeNull();
    expect(screen.text()).toContain("Only a context's owner can hand over private notes");
    expect(screen.approve()?.grantedScopes).not.toContain("context:private");
    screen.unmount();
  });
});

describe("what an approver cannot grant is shown, never granted", () => {
  test("a member sees the write request, cannot tick it, and does not submit it", () => {
    const screen = mount([READ_ONLY], {
      ...REQUEST,
      requestedWorkspaceSlug: "shared",
      workspaceSlug: "shared",
    });
    // Shown — hiding it would conceal why their client half-works afterwards.
    expect(screen.text()).toContain("Create and edit notes");
    // Not a control: it is not in the tick list at all.
    expect(screen.q("consent-scope-context:write")).toBeNull();
    expect(screen.approve()?.grantedScopes).toEqual(["context:read"]);
    screen.unmount();
  });
});

describe("switching context re-derives the controls instead of carrying a stale choice", () => {
  test("private chosen in a context you own does not survive a move to one you edit", () => {
    const screen = mount([OWNED, EDITED]);
    screen.click("consent-tier-private");
    expect(screen.q("consent-tier-private")!.getAttribute("aria-checked")).toBe("true");

    screen.click("consent-context-w2");
    // No tier control at all now, and nothing private in what would be sent.
    expect(screen.q("consent-tier-private")).toBeNull();
    expect(screen.approve()).toEqual({
      choice: "approve",
      workspaceId: "w2",
      grantedScopes: ["context:read", "context:write"],
    });
    screen.unmount();
  });
});
