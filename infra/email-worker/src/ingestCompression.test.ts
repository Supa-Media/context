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

});
