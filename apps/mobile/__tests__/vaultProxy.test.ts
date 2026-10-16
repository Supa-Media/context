import { describe, expect, test } from "@jest/globals";
import { PROXY_OFF, chosenStyle, guessStyle, pickStyle, proxyDraft, proxyProblem, typedHost } from "../features/vault/vaultProxy";

describe("the save page's AI switch", () => {
  const on = { ...PROXY_OFF, on: true };

  test("off sends nothing and holds nothing", () => {
    expect(proxyDraft(PROXY_OFF)).toBeUndefined();
    expect(proxyProblem(PROXY_OFF)).toBeNull();
  });

  test("a website is needed, typed any way a person types one", () => {
    expect(proxyProblem(on)).toMatch(/website/);
    expect(typedHost(" https://API.Stripe.com/v1 ")).toBe("api.stripe.com");
    expect(proxyProblem({ ...on, host: "api.stripe.com" })).toBeNull();
  });

  test("most sites are a sign-in header; known ones are found", () => {
    expect(guessStyle("api.stripe.com")).toEqual({ style: "bearer", name: "" });
    expect(chosenStyle({ ...on, host: "api.anthropic.com" })).toEqual({ style: "header", name: "x-api-key", guessed: true });
    expect(proxyDraft({ ...on, host: "api.stripe.com" })).toEqual({ host: "api.stripe.com", style: "bearer", ask: true });
  });

  test("picking a style keeps the guessed name, and a named style needs a name", () => {
    const picked = pickStyle({ ...on, host: "maps.googleapis.com" }, "query");
    expect(picked.paramName).toBe("key");
    expect(proxyDraft(picked)).toEqual({ host: "maps.googleapis.com", style: "query", name: "key", ask: true });
    const header = pickStyle({ ...on, host: "api.example.com" }, "header");
    expect(proxyProblem(header)).toMatch(/header/);
    expect(proxyDraft({ ...header, headerName: " x-token " })?.name).toBe("x-token");
  });
});
