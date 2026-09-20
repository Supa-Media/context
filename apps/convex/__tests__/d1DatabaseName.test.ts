import { describe, expect, test } from "vitest";
import { databaseNameFor } from "../functions/lib/d1";

/**
 * The database name is an IDENTITY, and an identity may not be lossy.
 *
 * `ensureDatabase` adopts a database whose name is already taken in our
 * account, and the argument for why that is safe is written at the site: the
 * name is `context-search-<workspace id>`, the id is immutable and
 * unguessable, and only this deployment creates databases there — so a
 * database of that name IS this workspace's. Every word of that rests on one
 * unstated premise: **that two workspaces cannot produce the same name.**
 *
 * `databaseNameFor` ended in `.slice(0, 63)`, which is exactly the operation
 * that breaks the premise. It is unreachable today — a Convex id is 32
 * characters and the prefix is 15, so 47 of the 63 are used — and that is the
 * whole reason it is worth pinning rather than shrugging at. What used to
 * happen when two contexts collided was a refused create: broken, and safe.
 * What happens now is that the second context ADOPTS the first one's database,
 * runs `RESET_STATEMENTS` over it — dropping `notes`, both FTS tables and the
 * cursor — and projects its own notes in. One tenant reaching another, on a
 * silent truncation, behind an id-length change nobody would think to review
 * as a security change.
 *
 * So the fix is not a longer cap. It is refusing to answer at all rather than
 * answering with a name that is not this workspace's, which is the same choice
 * `readSearchIndexBinding` makes about a half-formed descriptor and
 * `selectWorkspace` makes about a default outside the covered set: when the
 * honest answer is unavailable, fail rather than substitute.
 *
 * SABOTAGE: restore `.slice(0, 63)` and the first test below goes green
 * silently while the second reddens — which is the point. The second is the
 * one that would have caught the original.
 */
describe("the search database name identifies exactly one workspace", () => {
  const PREFIX = "context-search-";
  // Convex document ids are 32 characters. Not asserted as a promise about
  // Convex — asserted as the reason the cap is not reached today.
  const REAL_ID = "0123456789abcdef0123456789abcdef";

  test("an ordinary workspace id is carried whole", () => {
    expect(databaseNameFor(REAL_ID)).toBe(`${PREFIX}${REAL_ID}`);
    expect(databaseNameFor(REAL_ID).length).toBeLessThanOrEqual(63);
  });

  test("an id too long for the cap is refused, never truncated into somebody else's name", () => {
    // Two distinct ids sharing the first 48 characters. Under a truncating
    // `databaseNameFor` these are ONE name, and `ensureDatabase` would hand
    // the second workspace the first workspace's database.
    const shared = "a".repeat(48);
    const first = `${shared}1111`;
    const second = `${shared}2222`;

    expect(() => databaseNameFor(first)).toThrow(/workspace id/i);
    expect(() => databaseNameFor(second)).toThrow(/workspace id/i);
  });

  test("the longest id that still fits is not refused", () => {
    const exact = "b".repeat(63 - PREFIX.length);
    expect(databaseNameFor(exact)).toBe(`${PREFIX}${exact}`);
    expect(databaseNameFor(exact).length).toBe(63);
  });

  test("an empty id is refused rather than naming the prefix itself", () => {
    // `context-search-` with nothing after it belongs to no workspace, and is
    // the name every workspace would collide on if an id ever arrived empty.
    expect(() => databaseNameFor("")).toThrow(/workspace id/i);
  });
});
