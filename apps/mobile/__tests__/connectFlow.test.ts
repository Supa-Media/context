import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import {
  EXPIRED_LINK_MESSAGE,
  callbackMessage,
  completionKey,
  connectHref,
  connectLinkCopy,
  failureMessage,
  parseConnectCallback,
  providerParam,
  rememberCompletionSecret,
  takeCompletionSecret,
  type CompletionStore,
} from "../features/connect/connectFlow";

function memoryStore(): CompletionStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("connect link paths", () => {
  test("the link page is /connect/<provider>/<token>, with the token escaped", () => {
    expect(connectHref("slack", "abc123")).toBe("/connect/slack/abc123");
    expect(connectHref("slack", "a/b?c")).toBe("/connect/slack/a%2Fb%3Fc");
  });

  test("a provider parameter is read only when it is a known provider", () => {
    expect(providerParam("slack")).toBe("slack");
    expect(providerParam(["slack", "other"])).toBe("slack");
    expect(providerParam("google")).toBeNull();
    expect(providerParam("Slack")).toBeNull();
    expect(providerParam("")).toBeNull();
    expect(providerParam(undefined)).toBeNull();
  });
});

describe("the completion secret", () => {
  test("it is kept per provider, under a key of its own", () => {
    expect(completionKey("slack")).toBe("context.connect.slack.completion");
    expect(completionKey("linear")).toBe("context.connect.linear.completion");
  });

  test("it is read once and then removed", () => {
    const store = memoryStore();
    expect(rememberCompletionSecret("slack", "secret-1", store)).toBe(true);
    expect(takeCompletionSecret("slack", store)).toBe("secret-1");
    expect(takeCompletionSecret("slack", store)).toBeNull();
    expect(store.values.size).toBe(0);
  });

  test("one provider's secret is never handed to another", () => {
    const store = memoryStore();
    rememberCompletionSecret("slack", "secret-1", store);
    expect(takeCompletionSecret("linear", store)).toBeNull();
    expect(takeCompletionSecret("slack", store)).toBe("secret-1");
  });

  test("an empty secret is refused, and no store means nothing is kept", () => {
    expect(rememberCompletionSecret("slack", "", memoryStore())).toBe(false);
    expect(rememberCompletionSecret("slack", "secret-1", null)).toBe(false);
    expect(takeCompletionSecret("slack", null)).toBeNull();
  });

  test("a store that throws keeps nothing and answers nothing", () => {
    const broken: CompletionStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(rememberCompletionSecret("slack", "secret-1", broken)).toBe(false);
    expect(takeCompletionSecret("slack", broken)).toBeNull();
  });
});

describe("the callback", () => {
  test("a code and a state make a ready callback", () => {
    expect(parseConnectCallback({ code: "code-1", state: "state-1" })).toEqual({
      kind: "ready",
      code: "code-1",
      state: "state-1",
    });
  });

  test("a denied consent is its own answer, whatever else came back", () => {
    expect(parseConnectCallback({ error: "access_denied" })).toEqual({ kind: "denied" });
    expect(parseConnectCallback({ error: "access_denied", state: "state-1" })).toEqual({ kind: "denied" });
  });

  test("a callback missing its code or state is incomplete", () => {
    expect(parseConnectCallback({ code: "code-1" })).toEqual({ kind: "incomplete" });
    expect(parseConnectCallback({ state: "state-1" })).toEqual({ kind: "incomplete" });
    expect(parseConnectCallback({ code: "", state: "state-1" })).toEqual({ kind: "incomplete" });
  });

  test("a repeated parameter reads its first value", () => {
    expect(parseConnectCallback({ code: ["code-1", "code-2"], state: "state-1" })).toEqual({
      kind: "ready",
      code: "code-1",
      state: "state-1",
    });
  });
});

describe("the messages", () => {
  test("a connected team names itself and points back to Tex", () => {
    expect(callbackMessage({ kind: "connected", teamName: "Acme" })).toEqual({
      headline: "Acme is connected.",
      body: "Go back to your texts with Tex.",
    });
  });

  test("a denied consent says nothing was connected", () => {
    expect(callbackMessage({ kind: "denied" })).toEqual({
      headline: "Not connected",
      body: "You didn't allow it, so nothing was connected.",
    });
  });

  test("a missing secret asks for the same browser", () => {
    expect(callbackMessage({ kind: "missing-secret" })).toEqual({
      headline: "Could not finish connecting",
      body: "Open the link from Tex again in this same browser.",
    });
  });

  test("a failure shows the server's own words", () => {
    const error = new ConvexError({ code: "CONNECT_LINK_EXPIRED", message: EXPIRED_LINK_MESSAGE });
    expect(failureMessage(error)).toBe(EXPIRED_LINK_MESSAGE);
    expect(callbackMessage({ kind: "failed", message: failureMessage(error) }).body).toBe(EXPIRED_LINK_MESSAGE);
  });

  test("an unknown failure has a plain fallback", () => {
    expect(failureMessage(new Error("network"))).toBe("This connection did not finish. Try the link again from Tex.");
    expect(failureMessage(new ConvexError({ code: "X", message: "" }))).toBe(
      "This connection did not finish. Try the link again from Tex.",
    );
  });

  test("the expired copy is the one Tex is asked to say", () => {
    expect(EXPIRED_LINK_MESSAGE).toBe("This link has expired or was already used. Ask Tex for a new one.");
  });
});

describe("the link page copy", () => {
  test("a ready link names the provider and what Tex may do in it", () => {
    const copy = connectLinkCopy({ providerName: "Slack", connectedTeams: [], available: true });
    expect(copy.title).toBe("Connect Slack to Tex");
    expect(copy.line).toBe(
      "Tex will be able to read and act in Slack as you. Anything it posts or changes waits for your yes.",
    );
    expect(copy.already).toBeNull();
    expect(copy.unavailableLine).toBeNull();
    expect(copy.button).toBe("Continue to Slack");
  });

  test("the teams already connected are listed", () => {
    const copy = connectLinkCopy({ providerName: "Slack", connectedTeams: ["Acme", "Lab"], available: true });
    expect(copy.already).toBe("Already connected: Acme, Lab");
  });

  test("a provider with no client on this deployment says so, with no button", () => {
    const copy = connectLinkCopy({ providerName: "Slack", connectedTeams: [], available: false });
    expect(copy.unavailableLine).toBe("Slack isn't set up on Context yet.");
    expect(copy.button).toBeNull();
  });
});
