import { describe, expect, it } from "vitest";
import { COPY, linkCode, replyTo, type Message, type ReplyDeps } from "./reply";
import type { Fetch } from "./clients";

const message = (text: string): Message => ({
  kind: "message",
  eventId: "evt_1",
  chatId: "chat_1",
  from: "+15555550100",
  messageId: "msg_1",
  text,
});

type Route = (body: Record<string, unknown>, auth: string | null) => [number, unknown];

function deps(routes: Record<string, Route>, seen: string[] = []): ReplyDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    seen.push(path);
    const route = routes[path];
    if (!route) throw new Error(`unexpected call to ${path}`);
    const [status, body] = route(
      JSON.parse(String(init.body)),
      new Headers(init.headers).get("authorization"),
    );
    return new Response(JSON.stringify(body), { status });
  }) as unknown as Fetch;
  return {
    fetch: fetcher,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "worker-secret",
    gatewayOrigin: "https://gw.example",
  };
}

describe("linkCode", () => {
  it("reads the code in any case, with light punctuation", () => {
    expect(linkCode("link abcd2345")).toBe("ABCD2345");
    expect(linkCode("  LINK ABCD2345. ")).toBe("ABCD2345");
  });
  it("does not treat ordinary sentences as a link command", () => {
    expect(linkCode("link my notes about Paris please")).toBeNull();
    expect(linkCode("can you link abcd2345")).toBeNull();
    expect(linkCode("link abc")).toBeNull();
  });
});

describe("replyTo", () => {
  it("links the phone with the code, and never asks the gateway", async () => {
    const seen: string[] = [];
    const reply = await replyTo(
      message("link ABCD2345"),
      deps(
        {
          "/agent-texts/link": (body, auth) => {
            expect(body).toEqual({ phone: "+15555550100", code: "ABCD2345" });
            expect(auth).toBe("Bearer worker-secret");
            return [200, { status: "linked", handle: "ada" }];
          },
        },
        seen,
      ),
    );
    expect(reply).toBe(COPY.linked("ada"));
    expect(reply).toContain("@ada");
    expect(seen).toEqual(["/agent-texts/link"]);
  });

  it("says a refused code didn't work", async () => {
    const reply = await replyTo(
      message("link ABCD2345"),
      deps({ "/agent-texts/link": () => [200, { status: "refused" }] }),
    );
    expect(reply).toBe(COPY.linkRefused);
  });

  it("explains how to link from an unlinked phone, without calling the gateway", async () => {
    const seen: string[] = [];
    const reply = await replyTo(
      message("what's on my list?"),
      deps({ "/agent-texts/session": () => [200, { status: "unlinked" }] }, seen),
    );
    expect(reply).toBe(COPY.unlinked);
    expect(seen).toEqual(["/agent-texts/session"]);
  });

  it("answers a linked phone through the gateway with that person's grant", async () => {
    const reply = await replyTo(
      message("what's on my list?"),
      deps({
        "/agent-texts/session": () => [200, { status: "linked", accessToken: "grant-for-this-person" }],
        "/agent": (body, auth) => {
          expect(auth).toBe("Bearer grant-for-this-person");
          expect(body).toEqual({ question: "what's on my list?", conversation: "texts" });
          return [200, { answer: "Three things." }];
        },
      }),
    );
    expect(reply).toBe("Three things.");
  });

  it("says no model is connected when the gateway refuses for that reason", async () => {
    const reply = await replyTo(
      message("hi"),
      deps({
        "/agent-texts/session": () => [200, { status: "linked", accessToken: "t" }],
        "/agent": () => [409, { error: "no_provider" }],
      }),
    );
    expect(reply).toBe(COPY.noModel);
  });

  it("says today's questions are used up when the built-in model's cap is reached", async () => {
    const reply = await replyTo(
      message("hi"),
      deps({
        "/agent-texts/session": () => [200, { status: "linked", accessToken: "t" }],
        "/agent": () => [429, { error: "daily_limit" }],
      }),
    );
    expect(reply).toBe(COPY.dailyLimit);
  });

  it("says something went wrong when the control plane or gateway fails", async () => {
    expect(await replyTo(message("hi"), deps({ "/agent-texts/session": () => [500, {}] }))).toBe(
      COPY.unavailable,
    );
    expect(await replyTo(message("link ABCD2345"), deps({ "/agent-texts/link": () => [502, {}] }))).toBe(
      COPY.unavailable,
    );
    expect(
      await replyTo(
        message("hi"),
        deps({
          "/agent-texts/session": () => [200, { status: "linked", accessToken: "t" }],
          "/agent": () => [500, {}],
        }),
      ),
    ).toBe(COPY.unavailable);
  });
});
