/**
 * WHERE A `/note/@slug/<path>` LINK OPENS FOR SOMEBODY SIGNED IN (`functions/noteLinks.ts`).
 *
 * The owner, 2026-10-27: a chat guest with an account tapped Tex's note link and landed on his own workspace, with
 * no word about the note, because the console address only opens a member's notes. A member still goes to the
 * console; someone named on the note or a folder above it goes to @shared; anyone else hears one answer, whether the
 * note is there or not.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - answer `granted` without `authorizeGrant`: "a stranger hears none" fails;
 *  - drop the membership check: "a member goes to the console" fails (a member holds no outsider grant).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { asUser } from "../fixtures.helpers";
import { GONE, PLAN, SECRET, grantUser, setBase, trashNote, world } from "./outsider.helpers";

vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a note link, signed in", () => {
  test("a member goes to the console", async () => {
    const w = await world();
    expect(await asUser(w.t, w.bob).query(api.functions.noteLinks.target, { slug: "acme", path: PLAN })).toEqual({ kind: "member" });
    expect(await asUser(w.t, w.owner).query(api.functions.noteLinks.target, { slug: "@Acme", path: PLAN })).toEqual({ kind: "member" });
  });

  test("an outsider named on the note opens it in @shared", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.kola);
    expect(await asUser(w.t, w.kola).query(api.functions.noteLinks.target, { slug: "acme", path: PLAN })).toEqual({
      kind: "granted",
      workspaceId: w.ws,
      path: PLAN,
    });
  });

  test("an outsider named on a folder opens a note beneath it, and not a private one", async () => {
    const w = await world();
    await grantUser(w, "1-projects", w.kola);
    await setBase(w, "1-projects/private", "private");
    expect(await asUser(w.t, w.kola).query(api.functions.noteLinks.target, { slug: "acme", path: PLAN })).toMatchObject({ kind: "granted" });
    expect(await asUser(w.t, w.kola).query(api.functions.noteLinks.target, { slug: "acme", path: SECRET })).toEqual({ kind: "none" });
  });

  test("a stranger hears none, for a note that is there, one that is gone, and a workspace that isn't", async () => {
    const w = await world();
    await trashNote(w, GONE);
    for (const [slug, path] of [["acme", PLAN], ["acme", GONE], ["acme", "1-projects/never.md"], ["nobody-here", PLAN]]) {
      expect(await asUser(w.t, w.carol).query(api.functions.noteLinks.target, { slug, path })).toEqual({ kind: "none" });
    }
  });

  test("nobody signed in is told so, and nothing else", async () => {
    const w = await world();
    expect(await w.t.query(api.functions.noteLinks.target, { slug: "acme", path: PLAN })).toEqual({ kind: "signed_out" });
  });
});
