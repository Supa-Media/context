import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import {
  defaultContextId,
  describeDecisionFailure,
  errorCodeOf,
  preselectSlug,
  redirectHost,
  resolveConsentView,
  type AuthorizationRequest,
  type ConsentContext,
  type ConsentInputs,
} from "../features/consent/state";
import { isSafeRedirect } from "../features/consent/redirectSafety";

const NOW = 1_800_000_000_000;

const CONTEXTS: ConsentContext[] = [
  { id: "w1", slug: "seyi", role: "owner" },
  { id: "w2", slug: "ignite-2026", role: "editor" },
];

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

function inputs(overrides: Partial<ConsentInputs> = {}): ConsentInputs {
  return {
    requestId: "req_abc",
    auth: { isLoading: false, isAuthenticated: true },
    request: REQUEST,
    contexts: CONTEXTS,
    chosenContextId: null,
    decision: { kind: "idle" },
    now: NOW,
    ...overrides,
  };
}

const convexError = (code: string) => new ConvexError({ code, message: "nope" });

describe("resolveConsentView — the states before a decision", () => {
  test("auth still resolving renders nothing rather than flashing a screen", () => {
    expect(
      resolveConsentView(inputs({ auth: { isLoading: true, isAuthenticated: false } })).kind,
    ).toBe("wait");
  });

  test("signed out sends you to sign in and brings you back to this request", () => {
    const view = resolveConsentView(
      inputs({ auth: { isLoading: false, isAuthenticated: false } }),
    );
    expect(view).toEqual({
      kind: "signIn",
      href: "/login?next=%2Fauthorize%3Frequest_id%3Dreq_abc",
    });
  });

  test("signed out with no request id has nothing to come back for", () => {
    const view = resolveConsentView(
      inputs({ auth: { isLoading: false, isAuthenticated: false }, requestId: null }),
    );
    expect(view).toEqual({ kind: "signIn", href: "/login" });
  });

  test("the request id is url-encoded into `next`, not concatenated raw", () => {
    const view = resolveConsentView(
      inputs({
        auth: { isLoading: false, isAuthenticated: false },
        requestId: "a&b=c d",
      }),
    );
    expect(view).toEqual({
      kind: "signIn",
      href: "/login?next=%2Fauthorize%3Frequest_id%3Da%2526b%253Dc%2520d",
    });
  });

  test("the request in flight is a loading state", () => {
    expect(resolveConsentView(inputs({ request: undefined })).kind).toBe("loading");
  });

  test("the context list in flight is a loading state too", () => {
    expect(resolveConsentView(inputs({ contexts: undefined })).kind).toBe("loading");
  });
});

describe("resolveConsentView — every unusable request reads the same", () => {
  const message = "This link isn't valid any more";

  test("a request the backend refused to describe", () => {
    const view = resolveConsentView(inputs({ request: null }));
    expect(view.kind).toBe("invalid");
    expect(view).toHaveProperty("headline", message);
  });

  test("a request that expired while the screen sat open", () => {
    const view = resolveConsentView(
      inputs({ request: { ...REQUEST, expiresAt: NOW - 1 } }),
    );
    expect(view.kind).toBe("invalid");
    expect(view).toHaveProperty("headline", message);
  });

  test("no request id at all", () => {
    const view = resolveConsentView(inputs({ requestId: null }));
    expect(view.kind).toBe("invalid");
    expect(view).toHaveProperty("headline", message);
  });

  test("a query that threw for a reason that is not 'you have no context'", () => {
    const view = resolveConsentView(inputs({ request: convexError("SOMETHING_ELSE") }));
    expect(view.kind).toBe("invalid");
    expect(view).toHaveProperty("headline", message);
  });

  /**
   * The security property, stated as a test: an expired request, a spent one,
   * one belonging to somebody else, and one that never existed must be
   * indistinguishable. A `requestId` is a capability, and any difference here
   * tells whoever is guessing ids which guesses landed.
   */
  test("expired, refused, absent, and errored are byte-identical", () => {
    const views = [
      resolveConsentView(inputs({ request: null })),
      resolveConsentView(inputs({ request: { ...REQUEST, expiresAt: NOW - 1 } })),
      resolveConsentView(inputs({ requestId: null })),
      resolveConsentView(inputs({ request: convexError("WHATEVER") })),
    ];
    for (const view of views) expect(view).toEqual(views[0]);
  });

  test("an expiry exactly now has already passed", () => {
    expect(resolveConsentView(inputs({ request: { ...REQUEST, expiresAt: NOW } })).kind).toBe(
      "invalid",
    );
  });
});

describe("resolveConsentView — nowhere to grant access to", () => {
  test("NO_GRANTABLE_WORKSPACE is its own screen, not a broken link", () => {
    const view = resolveConsentView(
      inputs({ request: convexError("NO_GRANTABLE_WORKSPACE") }),
    );
    expect(view).toEqual({ kind: "noContext", clientName: null });
  });

  test("an empty context list says so, naming the client", () => {
    const view = resolveConsentView(inputs({ contexts: [] }));
    expect(view).toEqual({ kind: "noContext", clientName: "Claude Desktop" });
  });
});

describe("resolveConsentView — ready", () => {
  test("shows the client, the destination host, and the scopes as sentences", () => {
    const view = resolveConsentView(inputs());
    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") return;
    expect(view.clientName).toBe("Claude Desktop");
    expect(view.redirectHost).toBe("claude.ai");
    expect(view.scopeLines.map((line) => line.sentence)).toEqual([
      "Read your notes",
      "Create and edit notes",
    ]);
  });

  test("falls back to the `scope` string when `scopes` is absent", () => {
    const view = resolveConsentView(
      inputs({ request: { ...REQUEST, scopes: undefined, scope: "context:read" } }),
    );
    expect(view.kind === "ready" && view.scopeLines.map((l) => l.id)).toEqual(["read"]);
  });

  test("nothing is busy and approving is possible once a context is settled", () => {
    const view = resolveConsentView(inputs());
    expect(view.kind === "ready" && view.busy).toBe(null);
    expect(view.kind === "ready" && view.canApprove).toBe(true);
  });

  test("preselects the context the backend resolved", () => {
    const view = resolveConsentView(inputs());
    expect(view.kind === "ready" && view.selectedContextId).toBe("w1");
  });

  test("an explicit choice overrides the preselection", () => {
    const view = resolveConsentView(inputs({ chosenContextId: "w2" }));
    expect(view.kind === "ready" && view.selectedContextId).toBe("w2");
  });

  test("a choice naming a context you have since left falls back, never dangles", () => {
    const view = resolveConsentView(inputs({ chosenContextId: "gone" }));
    expect(view.kind === "ready" && view.selectedContextId).toBe("w1");
  });

  /**
   * Several contexts and no usable hint means the screen asks. Silently
   * picking the first would grant access to a context nobody named.
   */
  test("several contexts and no hint leaves nothing selected and blocks Approve", () => {
    const view = resolveConsentView(
      inputs({ request: { ...REQUEST, workspaceSlug: null, requestedWorkspaceSlug: null } }),
    );
    expect(view.kind === "ready" && view.selectedContextId).toBe(null);
    expect(view.kind === "ready" && view.canApprove).toBe(false);
  });

  test("one context is not a choice, so it selects itself", () => {
    const view = resolveConsentView(
      inputs({
        contexts: [CONTEXTS[0]],
        request: { ...REQUEST, workspaceSlug: null, requestedWorkspaceSlug: null },
      }),
    );
    expect(view.kind === "ready" && view.contextIsAChoice).toBe(false);
    expect(view.kind === "ready" && view.selectedContextId).toBe("w1");
  });

  test("submitting marks which half is busy and stops Approve firing twice", () => {
    const view = resolveConsentView(
      inputs({ decision: { kind: "submitting", choice: "approve" } }),
    );
    expect(view.kind === "ready" && view.busy).toBe("approve");
    expect(view.kind === "ready" && view.canApprove).toBe(false);
  });

  test("a failed decision comes back to the same screen carrying the error", () => {
    const error = { headline: "Couldn't approve this request" };
    const view = resolveConsentView(inputs({ decision: { kind: "idle", error } }));
    expect(view.kind === "ready" && view.error).toEqual(error);
  });

  /**
   * The sentences follow the picker, because the grant does.
   *
   * `w1` is owned and `w2` is not, and the same `context:read` reaches every
   * private note in the first and none in the second. A screen that described
   * both the same way would be lying to whichever half it did not describe —
   * which is what it did, always in the owner's direction.
   */
  describe("the scope sentences follow the selected context's role", () => {
    const readDetail = (view: ReturnType<typeof resolveConsentView>) =>
      (view.kind === "ready" && view.scopeLines.find((line) => line.id === "read")?.detail) || "";

    test("the owned context's read line does not promise an exclusion", () => {
      const view = resolveConsentView(inputs({ chosenContextId: "w1" }));
      expect(readDetail(view)).not.toMatch(/\bexcept\b/i);
      expect(readDetail(view)).toMatch(/private/i);
    });

    test("switching to the context you only edit changes what you are told", () => {
      const owned = resolveConsentView(inputs({ chosenContextId: "w1" }));
      const edited = resolveConsentView(inputs({ chosenContextId: "w2" }));
      expect(readDetail(edited)).toMatch(/except/i);
      expect(readDetail(edited)).not.toBe(readDetail(owned));
    });

    test("with no context picked yet, it claims no exclusion rather than guessing", () => {
      const view = resolveConsentView(
        inputs({ request: { ...REQUEST, workspaceSlug: null, requestedWorkspaceSlug: null } }),
      );
      expect(view.kind === "ready" && view.selectedContextId).toBe(null);
      expect(readDetail(view)).not.toMatch(/\bexcept\b/i);
    });
  });
});

describe("resolveConsentView — leaving", () => {
  test("a decision beats everything, including auth still resolving", () => {
    const view = resolveConsentView(
      inputs({
        auth: { isLoading: true, isAuthenticated: false },
        request: null,
        decision: { kind: "leaving", choice: "approve", redirectTo: "https://claude.ai/cb?code=x" },
      }),
    );
    expect(view).toEqual({
      kind: "leaving",
      choice: "approve",
      redirectTo: "https://claude.ai/cb?code=x",
    });
  });

  test("refusing leaves too — a person who says no lands back where they came from", () => {
    const view = resolveConsentView(
      inputs({
        decision: {
          kind: "leaving",
          choice: "deny",
          redirectTo: "https://claude.ai/cb?error=access_denied",
        },
      }),
    );
    expect(view.kind === "leaving" && view.choice).toBe("deny");
  });
});

describe("preselection and small helpers", () => {
  test("the backend's resolved slug beats the client's request", () => {
    expect(
      preselectSlug({ ...REQUEST, workspaceSlug: "seyi", requestedWorkspaceSlug: "other" }),
    ).toBe("seyi");
  });

  test("the client's request is the fallback when the backend omits its own", () => {
    expect(
      preselectSlug({ ...REQUEST, workspaceSlug: null, requestedWorkspaceSlug: "ignite-2026" }),
    ).toBe("ignite-2026");
  });

  test("defaultContextId tolerates an @-prefixed hint", () => {
    expect(defaultContextId(CONTEXTS, "@ignite-2026")).toBe("w2");
  });

  test("a hint naming a context you do not belong to selects nothing", () => {
    expect(defaultContextId(CONTEXTS, "somebody-else")).toBe(null);
  });

  test("no contexts selects nothing", () => {
    expect(defaultContextId([], "seyi")).toBe(null);
  });

  test("redirectHost names a hosted client by its host", () => {
    expect(redirectHost("https://claude.ai/cb")).toBe("claude.ai");
  });

  // `URL` gives `cursor://auth/callback` a host of "auth". "Sends it back to
  // auth" tells nobody anything, so a custom scheme keeps its scheme.
  test("a custom app scheme keeps the scheme, which is the recognisable part", () => {
    expect(redirectHost("cursor://auth/callback")).toBe("cursor://auth");
  });

  test("a URI that will not parse is shown raw rather than hidden", () => {
    expect(redirectHost("not a url")).toBe("not a url");
  });

  test("errorCodeOf reads a ConvexError and shrugs at anything else", () => {
    expect(errorCodeOf(convexError("NOPE"))).toBe("NOPE");
    expect(errorCodeOf(new Error("plain"))).toBe(undefined);
    expect(errorCodeOf(null)).toBe(undefined);
  });
});

describe("describeDecisionFailure", () => {
  test("a spent request reads as an invalid link, not as a diagnostic", () => {
    expect(
      describeDecisionFailure(convexError("AUTHORIZATION_REQUEST_NOT_FOUND"), "approve").headline,
    ).toBe("This link isn't valid any more");
  });

  test("a lost session says so", () => {
    expect(describeDecisionFailure(convexError("NOT_AUTHENTICATED"), "approve").headline).toContain(
      "session ended",
    );
  });

  test("losing access to the chosen context points at picking another", () => {
    expect(describeDecisionFailure(convexError("WORKSPACE_NOT_FOUND"), "approve").next).toContain(
      "Pick a different one",
    );
  });

  test("an unknown failure never claims something was granted", () => {
    const failure = describeDecisionFailure(new Error("socket hang up"), "approve");
    expect(failure.headline).toBe("Couldn't approve this request");
    expect(failure.next).toContain("Nothing was granted");
  });

  test("the wording follows which half was pressed", () => {
    expect(describeDecisionFailure(new Error("x"), "deny").headline).toBe(
      "Couldn't refuse this request",
    );
  });
});

describe("isSafeRedirect", () => {
  test("accepts https and the custom schemes native clients register", () => {
    expect(isSafeRedirect("https://claude.ai/cb?code=x")).toBe(true);
    expect(isSafeRedirect("cursor://auth/callback")).toBe(true);
  });

  test("refuses the schemes that execute rather than navigate", () => {
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "file:///etc/passwd",
      "blob:https://evil.example/x",
      "about:blank",
    ]) {
      expect(isSafeRedirect(url)).toBe(false);
    }
  });

  test("refuses cleartext http, because a code in a query string is the code", () => {
    expect(isSafeRedirect("http://evil.example/cb?code=x")).toBe(false);
  });

  test("allows loopback http, which is what native OAuth clients use", () => {
    expect(isSafeRedirect("http://localhost:7842/cb")).toBe(true);
    expect(isSafeRedirect("http://127.0.0.1:7842/cb")).toBe(true);
  });

  test("refuses anything that is not an absolute URL", () => {
    expect(isSafeRedirect("/relative")).toBe(false);
    expect(isSafeRedirect("")).toBe(false);
  });
});
