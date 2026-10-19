/**
 * A failure `toConvexError` cannot vet leaves a trace in the logs, and a
 * sealed note that will not open is said as one.
 *
 * Before this, "Your bucket did not complete that request" was the only
 * record of any unvetted failure: nothing reached Convex's logs, so the
 * @shyoh workspace that would not open (2026-10-19) could not be diagnosed
 * from them. And a `ManagedEncryptionError` thrown inside an operation was
 * converted to STORAGE_FAILED before `rethrowUnreadable` saw it, so the app
 * retried a read no retry can cure.
 *
 * Sabotage: drop the `console.error` and the first test fails; drop the
 * `ManagedEncryptionError` branch and the second answers STORAGE_FAILED;
 * log `error.message` and the third finds the key in the line.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeFailure, toConvexError } from "../../functions/lib/filesFns/operationErrors";
import { ManagedEncryptionError } from "../../../mcp/src/store/managedEncryption.js";
import { FileOpError } from "../../functions/lib/fileOps";

afterEach(() => vi.restoreAllMocks());

describe("an unvetted failure", () => {
  test("is logged with the workspace and closed words, and still said as STORAGE_FAILED", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = toConvexError(new Error("S3 GET notes/abc.md failed with 403: AccessDenied"), "ws_1");
    expect(error.data.code).toBe("STORAGE_FAILED");
    expect(log).toHaveBeenCalledWith("file_operation.failed", {
      workspaceId: "ws_1",
      kind: "storage",
      name: "Error",
      code: null,
      detail: null,
      verb: "GET",
      status: 403,
      at: expect.any(Array),
    });
  });

  test("a sealed note that will not open is ENCRYPTED_UNREADABLE, with its own words logged", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = toConvexError(
      new ManagedEncryptionError("ENCRYPTED_UNREADABLE", "plain object in encrypted workspace"),
      "ws_2",
    );
    expect(error.data.code).toBe("ENCRYPTED_UNREADABLE");
    expect(log.mock.calls[0]?.[1]).toMatchObject({
      workspaceId: "ws_2",
      kind: "unsealed",
      code: "ENCRYPTED_UNREADABLE",
      detail: "plain object in encrypted workspace",
    });
  });

  test("never logs the message, which can name a note or an endpoint", () => {
    const described = JSON.stringify(
      describeFailure(new Error("S3 PUT notes/secret-plans.md failed with 500: <Error>https://bucket.example</Error>")),
    );
    expect(described).not.toMatch(/secret-plans|example|<Error>/);
    const odd = describeFailure({ name: "x y <script>", code: "anything", message: 42 });
    expect(odd).toEqual({ kind: "other", name: null, code: null, detail: null, verb: null, status: null, at: [] });
  });

  test("says where a plain error was thrown, and never the stack's message line", () => {
    const error = new Error("cannot read notes/secret-plans.md");
    error.stack = [
      "Error: cannot read notes/secret-plans.md",
      "    at renderForReading (../../apps/mcp/src/store/privacyAuthority.js:120:11)",
      "    at async readFile (../../apps/convex/functions/lib/fileOps/reading.ts:74:17)",
      "    at notes/secret-plans.md with spaces and (junk)",
    ].join("\n");
    const { at } = describeFailure(error);
    expect(at).toEqual([
      "at renderForReading (../../apps/mcp/src/store/privacyAuthority.js:120:11)",
      "at async readFile (../../apps/convex/functions/lib/fileOps/reading.ts:74:17)",
    ]);
    expect(JSON.stringify(at)).not.toMatch(/secret-plans/);
  });

  test("a vetted refusal is not logged", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(toConvexError(new FileOpError("FILE_NOT_FOUND", "No such note.")).data.code).toBe("FILE_NOT_FOUND");
    expect(log).not.toHaveBeenCalled();
  });
});
