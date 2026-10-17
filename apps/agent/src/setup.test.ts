import { describe, expect, it } from "vitest";
import { COPY, replyTo, type Message, type ReplyDeps } from "./reply";
import { handleCandidate, SETUP_COPY } from "./setup";
import type { Fetch } from "./clients";

/**
 * SETTING SOMEBODY UP BY TEXT, THE WORKER'S HALF.
 *
 * The control plane decides; the Worker must (1) send it one word at most,
 * never the message, (2) never run a model or fetch a file before the phone
 * is linked, (3) text only a console link for the handle it was told, and
 * (4) fall back to the sign-in link for anyone the control plane will not set
 * up, including a control plane too old to know the route.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `handleCandidate` passing a sentence on                               2
 *   any link the control plane names texted, not only its console's       1
 *   a 404 not falling back to the sign-in link                            1
 *   `replyTo` skipping setup                                              4
 */

const PHONE = "+15555550100";
const message = (text: string, extra: Partial<Message> = {}): Message => ({
  kind: "message",
  eventId: "evt_1",
  chatId: "chat_1",
  from: PHONE,
  messageId: "msg_1",
  text,
  ...extra,
});

type Route = (body: Record<string, unknown>) => [number, unknown];

function deps(routes: Record<string, Route>, seen: string[] = []): ReplyDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    seen.push(path);
    const route = routes[path];
    if (!route) throw new Error(`unexpected call to ${url}`);
    const [status, body] = route(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as Fetch;
  return { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: "s", gatewayOrigin: "https://gw.example" };
}

const unlinked: Route = () => [200, { status: "unlinked" }];

describe("handleCandidate", () => {
  it("takes one word, with an @ and a full stop allowed", () => {
    expect(handleCandidate("ada")).toBe("ada");
    expect(handleCandidate("  @Ada-Lovelace. ")).toBe("Ada-Lovelace");
    expect(handleCandidate("ada!")).toBe("ada");
  });
  it("never passes on a sentence, an empty text or a long one", () => {
    expect(handleCandidate("what's on my list?")).toBeUndefined();
    expect(handleCandidate("call me ada")).toBeUndefined();
    expect(handleCandidate("   ")).toBeUndefined();
    expect(handleCandidate("@")).toBeUndefined();
    expect(handleCandidate("a".repeat(65))).toBeUndefined();
  });
});

describe("an unlinked phone the control plane may set up", () => {
  it("is asked for a handle, and the message's words never leave the Worker", async () => {
    const seen: string[] = [];
    const sent: Record<string, unknown>[] = [];
    const reply = await replyTo(
      message("hey tex, what can you do?", {
        attachments: [{ url: "https://cdn.example/a.jpg", mimeType: "image/jpeg", filename: "a.jpg", size: 10 }],
      }),
      deps(
        {
          "/agent-texts/session": unlinked,
          "/agent-texts/setup": (body) => {
            sent.push(body);
            return [200, { status: "ask" }];
          },
        },
        seen,
      ),
    );
    expect(reply).toEqual([SETUP_COPY.ask]);
    expect(sent).toEqual([{ phone: PHONE }]);
    // No model, no sign-in link, and the stranger's photo is never fetched.
    expect(seen).toEqual(["/agent-texts/session", "/agent-texts/setup"]);
  });

  it("sends the one word as the candidate", async () => {
    const sent: Record<string, unknown>[] = [];
    await replyTo(
      message("@ada"),
      deps({
        "/agent-texts/session": unlinked,
        "/agent-texts/setup": (body) => {
          sent.push(body);
          return [200, { status: "rejected", reason: "taken", handle: "ada" }];
        },
      }),
    );
    expect(sent).toEqual([{ phone: PHONE, candidate: "ada" }]);
  });

  it("says why a handle was refused, and asks again", async () => {
    const cases: [unknown, string][] = [
      [{ status: "rejected", reason: "taken", handle: "ada" }, SETUP_COPY.taken("ada")],
      [{ status: "rejected", reason: "taken" }, SETUP_COPY.taken()],
      [{ status: "rejected", reason: "reserved", handle: "admin" }, SETUP_COPY.reserved("admin")],
      [{ status: "rejected", reason: "invalid_characters" }, SETUP_COPY.format],
      [{ status: "rejected", reason: "not_a_handle" }, SETUP_COPY.format],
      // A handle that is not one is never echoed back.
      [{ status: "rejected", reason: "taken", handle: "<script>" }, SETUP_COPY.taken()],
      [{ status: "too_many" }, SETUP_COPY.tooMany],
    ];
    for (const [answer, copy] of cases) {
      const reply = await replyTo(
        message("ada"),
        deps({ "/agent-texts/session": unlinked, "/agent-texts/setup": () => [200, answer] }),
      );
      expect(reply).toEqual([copy]);
    }
  });

  it("confirms the handle and texts the workspace link on its own", async () => {
    const url = "https://app.example/console/ada";
    const reply = await replyTo(
      message("ada"),
      deps({
        "/agent-texts/session": unlinked,
        "/agent-texts/setup": () => [200, { status: "set_up", handle: "ada", storage: "on_the_way", url }],
      }),
    );
    expect(reply).toEqual([SETUP_COPY.setUp("ada", "on_the_way"), url]);
    expect(reply[0]).toContain("@ada");
    expect(reply[0]).toContain("UNLINK");
  });

  it("texts no link but the console's, for the handle it was told", async () => {
    for (const url of [
      "http://app.example/console/ada",
      "javascript:alert(1)",
      "https://app.example/console/someone-else",
      "https://app.example/texts/ada",
      "https://app.example/console/ada?next=https://evil.example",
    ]) {
      const reply = await replyTo(
        message("ada"),
        deps({
          "/agent-texts/session": unlinked,
          "/agent-texts/setup": () => [200, { status: "set_up", handle: "ada", storage: "none", url }],
        }),
      );
      expect(reply).toEqual([SETUP_COPY.setUp("ada", "none", false)]);
    }
  });

  it("refuses a malformed handle in a finished setup as a failure", async () => {
    const reply = await replyTo(
      message("ada"),
      deps({
        "/agent-texts/session": unlinked,
        "/agent-texts/setup": () => [200, { status: "set_up", handle: "Ada Lovelace", storage: "none" }],
      }),
    );
    expect(reply).toEqual([COPY.unavailable]);
  });
});

describe("everyone else", () => {
  it("gets the sign-in link, as before", async () => {
    const seen: string[] = [];
    const url = "https://app.example/texts/abc123";
    const reply = await replyTo(
      message("hi"),
      deps(
        {
          "/agent-texts/session": unlinked,
          "/agent-texts/setup": () => [200, { status: "not_eligible" }],
          "/agent-texts/invite": () => [200, { status: "issued", url }],
        },
        seen,
      ),
    );
    expect(reply).toEqual(COPY.unlinked(url));
    expect(seen).toEqual(["/agent-texts/session", "/agent-texts/setup", "/agent-texts/invite"]);
  });

  it("gets the sign-in link from a control plane that has no setup route yet", async () => {
    const url = "https://app.example/texts/abc123";
    const reply = await replyTo(
      message("hi"),
      deps({
        "/agent-texts/session": unlinked,
        "/agent-texts/setup": () => [404, {}],
        "/agent-texts/invite": () => [200, { status: "issued", url }],
      }),
    );
    expect(reply).toEqual(COPY.unlinked(url));
  });

  it("is told something went wrong when setup fails, and never sees a model", async () => {
    const seen: string[] = [];
    const reply = await replyTo(
      message("ada"),
      deps({ "/agent-texts/session": unlinked, "/agent-texts/setup": () => [500, {}] }, seen),
    );
    expect(reply).toEqual([COPY.unavailable]);
    expect(seen).not.toContain("/agent");
  });

  it("a linked phone never reaches setup", async () => {
    const seen: string[] = [];
    await replyTo(
      message("ada"),
      deps(
        {
          "/agent-texts/session": () => [200, { status: "linked", accessToken: "t" }],
          "/agent": () => [200, { answer: "Hi." }],
        },
        seen,
      ),
    );
    expect(seen).toEqual(["/agent-texts/session", "/agent"]);
  });
});
