import { describe, expect, test } from "@jest/globals";
import { messageAnchor, planChannelDay, renderChannelDayNote } from "@context/communications";
import { flattenDayMessages, messageAt, shapeChannelDay } from "../features/console/communications/day";

/**
 * The same fixtures `packages/communications/test/fixtures.mjs` builds,
 * reproduced here rather than imported: that file is outside this package's
 * `rootDir` and Jest's module resolution stops at the workspace boundary the
 * way `transformIgnorePatterns` already does for everything else in
 * `node_modules`. `@context/communications` itself — the built contract — is
 * imported for real; only the fixture *data* is copied, and it is copied
 * verbatim.
 */
function message(overrides: Record<string, unknown> = {}) {
  return {
    channel: "email" as const,
    account: "name-at-example-com",
    messageId: "<a1@mail.example.net>",
    threadId: "thread-1",
    sentAt: "2026-09-07T09:14:00.000Z",
    subject: "Quarterly numbers",
    from: { name: "Adam Okonkwo", address: "adam@example.net" },
    to: [{ address: "name@example.com" }],
    body: "The numbers are attached. Can we talk Thursday?",
    attachments: [] as { filename?: string; contentType?: string; size?: number }[],
    ...overrides,
  };
}

function day(overrides: Record<string, unknown> = {}) {
  return {
    channel: "email" as const,
    account: "name-at-example-com",
    address: "name@example.com",
    date: "2026-09-07",
    nonce: "0123456789abcdef",
    now: "2026-09-07T18:04:11.221Z",
    events: [
      message({
        messageId: "<c1@mail.example.net>",
        threadId: "thread-2",
        sentAt: "2026-09-07T15:02:00.000Z",
        subject: "Lunch?",
        from: { name: "Bea Lindqvist", address: "bea@example.net" },
        body: "Thursday works.",
      }),
      message(),
      message({
        messageId: "<a2@mail.example.net>",
        threadId: "thread-1",
        sentAt: "2026-09-07T11:31:00.000Z",
        subject: "Re: Quarterly numbers",
        from: { name: "Name", address: "name@example.com" },
        body: "Thursday at two.",
      }),
    ],
    ...overrides,
  };
}

describe("shapeChannelDay", () => {
  test("one part: threads and messages, in the day's own order", () => {
    const view = shapeChannelDay("email", "name-at-example-com", "2026-09-07", [
      { part: 1, text: renderChannelDayNote(day()) },
    ]);
    expect(view.partial).toBe(false);
    expect(view.threads.map((thread) => thread.thread)).toEqual(["Quarterly numbers", "Lunch?"]);
    expect(view.threads[0].messages).toHaveLength(2);
    expect(view.threads[0].messages[0].sender).toBe("Adam Okonkwo");
    expect(view.threads[0].messages[0].body).toBe(message().body);
  });

  test("every message carries the anchor a link would target", () => {
    const view = shapeChannelDay("email", "name-at-example-com", "2026-09-07", [
      { part: 1, text: renderChannelDayNote(day()) },
    ]);
    const anchors = flattenDayMessages(view).map((m) => m.anchor);
    expect(anchors).toContain(messageAnchor(message()));
  });

  test("messageAt finds one message by its anchor", () => {
    const view = shapeChannelDay("email", "name-at-example-com", "2026-09-07", [
      { part: 1, text: renderChannelDayNote(day()) },
    ]);
    const found = messageAt(view, messageAnchor(message()));
    expect(found?.subject).toBe("Quarterly numbers");
    expect(messageAt(view, "msg-0000000000000000")).toBeNull();
  });

  test("split parts stitch into the same threads, in part order", () => {
    const bulky = {
      ...day(),
      events: Array.from({ length: 12 }, (_, i) =>
        message({
          messageId: `<bulk-${i}@mail.example.net>`,
          threadId: `thread-${i % 3}`,
          sentAt: new Date(Date.UTC(2026, 8, 7, 8, i)).toISOString(),
          subject: `Message ${i}`,
          body: "x".repeat(6_000),
        }),
      ),
    };
    const parts = planChannelDay(bulky, { threshold: 2_048 + 8_000 });
    expect(parts.length).toBeGreaterThan(1);

    const whole = shapeChannelDay(
      "email",
      "name-at-example-com",
      "2026-09-07",
      [...parts].reverse().map((part) => ({ part: part.part, text: part.text })),
    );
    const singleFile = shapeChannelDay("email", "name-at-example-com", "2026-09-07", [
      { part: 1, text: renderChannelDayNote(bulky) },
    ]);
    expect(flattenDayMessages(whole).map((m) => m.anchor)).toEqual(
      flattenDayMessages(singleFile).map((m) => m.anchor),
    );
    expect(whole.partial).toBe(false);
  });

  test("a part that failed to load leaves the view partial, not empty", () => {
    const view = shapeChannelDay("email", "name-at-example-com", "2026-09-07", [
      { part: 1, text: renderChannelDayNote(day()) },
      { part: 2, text: null },
    ]);
    expect(view.partial).toBe(true);
    expect(view.threads.length).toBeGreaterThan(0);
  });

  test("no parts at all is partial and empty, not a crash", () => {
    const view = shapeChannelDay("email", "name-at-example-com", "2026-09-07", []);
    expect(view.partial).toBe(true);
    expect(view.threads).toEqual([]);
  });

  test("an attachment is metadata only — never bytes, never a URL", () => {
    const withAttachment = day({
      events: [message({ attachments: [{ filename: "rider.pdf", contentType: "application/pdf", size: 48213 }] })],
    });
    const view = shapeChannelDay("email", "name-at-example-com", "2026-09-07", [
      { part: 1, text: renderChannelDayNote(withAttachment) },
    ]);
    const attachment = flattenDayMessages(view)[0].attachments[0];
    expect(attachment).toEqual({ filename: "rider.pdf", contentType: "application/pdf", size: "48213 bytes" });
  });
});
