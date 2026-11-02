/**
 * Pictures attached to a captured email are stored compressed (the owner's
 * 2026-11-01 rule; `packages/shared/src/pictureCompression.cjs`), through the
 * `compressPicture` the Worker injects into `decideCapture`.
 */
import { describe, expect, it } from "vitest";
import { decideCapture, DEFAULT_TARGET_FOLDER, type IngestConfig } from "./ingest";
import { DEFAULT_MIME_LIMITS } from "./mime";
import type { SenderMatcher } from "./policy";
import { AUTHSERV } from "./fixtures.test-helpers";

const allowAll: SenderMatcher = () => true;

function decide(raw: Uint8Array, overrides: Partial<IngestConfig> = {}) {
  return decideCapture(
    { recipient: "seyi@context.lc", owner: "seyi", raw, now: new Date("2026-08-26T09:00:00.000Z"), fenceNonce: "0123456789abcdef" },
    {
      targetFolder: DEFAULT_TARGET_FOLDER,
      policy: { allowedSenders: ["alice@example.com"], allowedDomains: [], allowAnySender: false },
      attachmentPolicy: "list",
      maxMessageBytes: 5_000_000,
      limits: DEFAULT_MIME_LIMITS,
      authServiceId: AUTHSERV,
      ...overrides,
    },
    allowAll,
  );
}

describe("a stored picture", () => {
  const withImage = (filename: string) =>
    new TextEncoder().encode(
      [
        `Authentication-Results: ${AUTHSERV}; dmarc=pass header.from=example.com`,
        "From: alice@example.com",
        "Message-ID: <img@example.com>",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "see attached",
        "--b",
        "Content-Type: image/png",
        `Content-Disposition: attachment; filename="${filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        // A real PNG header followed by bytes that are not valid UTF-8.
        "iVBORw0KGgr//sCAAE=",
        "--b--",
        "",
      ].join("\r\n"),
    );

  it("stores the compressed copy, named from the bytes that arrived, and links it", async () => {
    // Pictures are kept compressed (the owner's 2026-11-01 rule). Sabotage:
    // store `attachment.bytes` or name the key from the sender's type, and
    // this fails.
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const asked: string[] = [];
    const plain = await decide(withImage("shot.png"), { attachmentPolicy: "store" });
    const decision = await decide(withImage("shot.png"), {
      attachmentPolicy: "store",
      compressPicture: async (_bytes, type) => {
        asked.push(type.contentType);
        return { bytes: webp, contentType: "image/webp", extension: "webp" };
      },
    });
    if (decision.kind !== "capture" || plain.kind !== "capture") throw new Error("expected a capture");
    expect(asked).toEqual(["image/png"]);
    const write = decision.attachments[0]!;
    expect(write.key).toBe(plain.attachments[0]!.key.replace(/\.png$/, ".webp"));
    expect(write.bytes).toBe(webp);
    expect(write.contentType).toBe("image/webp");
    expect(decision.note).toContain(`![shot.png](${write.key})`);
  });

  it("never stores an attachment whose bytes are not the picture its headers claim", async () => {
    // The allowlist exists because bytes outside it have no way back out of the
    // bucket, and `compressPicture`'s type must be what the bytes sniffed as,
    // never what a caller declared. A sender writes the Content-Type, so an
    // attachment that lies is a stranger's arbitrary bytes stored in the
    // customer's storage and handed to a model as a PNG. Sabotage: take the
    // extension from `attachment.contentType` again, and this fails.
    const lying = new TextEncoder().encode(
      [
        `Authentication-Results: ${AUTHSERV}; dmarc=pass header.from=example.com`,
        "From: alice@example.com",
        "Message-ID: <lie@example.com>",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "see attached",
        "--b",
        "Content-Type: image/png",
        'Content-Disposition: attachment; filename="shot.png"',
        "Content-Transfer-Encoding: base64",
        "",
        // Not a picture at all: `<html>hello</html>`.
        "PGh0bWw+aGVsbG88L2h0bWw+",
        "--b--",
        "",
      ].join("\r\n"),
    );
    const asked: string[] = [];
    const decision = await decide(lying, {
      attachmentPolicy: "store",
      compressPicture: async (bytes, type) => {
        asked.push(type.contentType);
        return { bytes, contentType: type.contentType, extension: type.extension };
      },
    });
    if (decision.kind !== "capture") throw new Error("expected a capture");
    expect(asked).toEqual([]);
    expect(decision.attachments).toEqual([]);
    expect(decision.note).not.toContain(".png)");
  });
});
