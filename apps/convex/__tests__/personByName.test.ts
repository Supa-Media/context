/**
 * `names.personByName`: whether an `@name` belongs to a person, so the share field offers the name only once it
 * does (Dev2, 2026-10-25: "a suggested box should not pop up if the alias doesn't exist"). It answers yes or no and
 * nothing about who: no id, no name, no address.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { asUser, captureError, createUser, createWorkspace, setupTest } from "./fixtures.helpers";

async function world() {
  const t = setupTest();
  const asker = await createUser(t, "asker@example.invalid");
  const ana = await createUser(t, "ana@example.invalid");
  await createWorkspace(t, ana, "ana", { kind: "personal" });
  await createWorkspace(t, asker, "team-acme", { kind: "shared" });
  return { t, asker, ana };
}

describe("whether an @name is a person", () => {
  test("a person's own name is found, with or without the @ and in any case, and says nothing else", async () => {
    const { t, asker } = await world();
    for (const name of ["ana", "@ana", "  @ANA "]) {
      expect(await asUser(t, asker).query(api.functions.names.personByName, { name })).toEqual({ found: true });
    }
  });

  test("a name nobody holds, a shared workspace's name, a malformed or reserved one are not a person", async () => {
    const { t, asker } = await world();
    for (const name of ["@nobody-holds-this", "@team-acme", "@a b", "@-x", "@shared", "@"]) {
      expect(await asUser(t, asker).query(api.functions.names.personByName, { name })).toEqual({ found: false });
    }
  });

  test("a deleted person is nobody", async () => {
    const { t, asker, ana } = await world();
    await t.run(async (ctx) => ctx.db.delete(ana));
    expect(await asUser(t, asker).query(api.functions.names.personByName, { name: "@ana" })).toEqual({ found: false });
  });

  test("only for someone signed in", async () => {
    const { t } = await world();
    expect(await captureError(() => t.query(api.functions.names.personByName, { name: "@ana" }))).toBeDefined();
  });
});
