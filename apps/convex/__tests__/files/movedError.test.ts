/**
 * A save to a name a queued folder move already carried away is refused with
 * `MovingPathError` (`apps/mcp/src/moves/queued.js`). It reaches the app as
 * `MOVED`, in its own words, rather than as "Your bucket did not complete that
 * request", which devices retry forever.
 *
 * Sabotage: drop the `MovingPathError` branch in `toConvexError` and this
 * answers STORAGE_FAILED.
 */
import { describe, expect, test } from "vitest";
import { toConvexError } from "../../functions/lib/filesFns/operationErrors";
import { MovingPathError } from "../../../mcp/src/moves/queued.js";

describe("a save to a name a move carried away", () => {
  test("is said as MOVED", () => {
    const error = toConvexError(new MovingPathError());
    expect(error.data.code).toBe("MOVED");
    expect(error.data.message).toMatch(/moved/);
  });
});
