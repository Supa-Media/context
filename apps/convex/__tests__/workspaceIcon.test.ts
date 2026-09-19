/**
 * WHAT A WORKSPACE LOOKS LIKE, AND WHO GETS TO SAY.
 *
 * `WorkspaceMark` draws one letter derived from the slug, which stops
 * distinguishing anything the moment somebody holds `@seyi` and `@supa`: two
 * **S**es, same square, same colour, in the control whose entire job is telling
 * contexts apart. An owner can now choose an emoji or a photo instead.
 *
 * Three properties are worth a suite, and the third is the one with teeth.
 *
 *  1. **An icon is the owner's.** It is rendered in the rail of every member of
 *     a shared context, so an editor setting it would be an editor changing
 *     what somebody else's screen looks like. Editors write notes; the
 *     workspace's face goes with its name and its storage.
 *
 *  2. **An emoji is one glyph, structurally.** Not "short". The value lands in
 *     an 18pt square on other people's screens, so what has to be refused is
 *     plain text, a right-to-left override, and a combining stack that draws
 *     over the row above — none of which a length check catches.
 *
 *  3. **THE PHOTO PATH CANNOT NAME AN OBJECT.** An image in the opaque store
 *     has no visibility of its own; it borrows it from the notes that
 *     reference it, and `readNoteImage` is built on exactly that gate. An icon
 *     has no note. The wrong fix is to loosen the gate; what happens instead is
 *     that `workspaceIconPhoto` takes **only a workspaceId** and reads the leaf
 *     off the row — so there is no argument through which a caller can ask for
 *     an object, and the set of objects it can ever return is at most one per
 *     workspace, chosen by that workspace's owner. The argument shape is
 *     asserted below, because that absence is the whole security argument and a
 *     later convenience parameter would end it silently.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   accept any string instead of isSingleEmoji                    1
 *   take `owner` down to `editor` on setWorkspaceIcon             1
 *   take `owner` down to `editor` on setWorkspaceIconPhoto        1
 *   take `member` up to `owner` on workspaceIconPhoto             1
 *   drop the membership check inside workspaceIconLeaf            1
 *   store a letter on clear rather than clearing                  1
 *   accept image/heic (a type no browser draws)                   1
 *   drop the WORKSPACE_ICON_MAX_BYTES cap                         1
 *   patch the row before the bucket write lands                   1
 *
 * One apiece, which is the honest number rather than a flattering one: each
 * rule is asserted once, deliberately, in the test named after it. The emoji
 * row is 1 and not 6 because the five shape tests call `isSingleEmoji`
 * directly — they pin the rule, and the sixth pins that the mutation uses it.
 *
 * **Two of these rows cost the suite a test to earn.** The first run reported
 * *zero* failures for the `setWorkspaceIconPhoto` role and for the
 * `workspaceIconLeaf` check, and both times the reason was the same: a second
 * gate behind the first kept the outcome identical, so nothing could see the
 * one being removed. That is defence in depth doing its job and it is also how
 * a check quietly becomes decorative. The gap was closed rather than the record
 * fudged — one test now asserts that an editor is refused *before any bytes
 * reach the bucket*, and one asks the internal query directly, the way a second
 * caller would.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../_generated/api";
import * as fileFunctions from "../functions/files";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { IMAGE_PREFIX } from "../functions/lib/fileOps";
import {
  PINNED_CONTEXT_SLUG,
  WORKSPACE_ICON_EMOJI,
  WORKSPACE_ICON_MAX_BYTES,
  isSingleEmoji,
} from "@context/shared";
import { memoryS3, type MemoryS3, type MemoryS3Options } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  type TestConvex,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedStorageBinding,
  setupTest,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A PNG-ish blob with every byte value, so a re-encoding stub cannot pass. */
const PHOTO = new Uint8Array(256);
for (let i = 0; i < PHOTO.length; i += 1) PHOTO[i] = i;

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  editor: Id<"users">;
  reader: Id<"users">;
  stranger: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

async function fixture(bucket: MemoryS3Options = {}): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const editor = await createUser(t, "editor@example.invalid");
  const reader = await createUser(t, "reader@example.invalid");
  const stranger = await createUser(t, "stranger@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "atlas");
  await addMember(t, workspaceId, editor, "editor", owner);
  await addMember(t, workspaceId, reader, "member", owner);
  // A real, authenticated user with a context of her own — not a bare id.
  await createWorkspace(t, stranger, "elsewhere");

  const backend = memoryS3(FAKE_STORAGE.bucket, bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed("2-areas/private-note.md", "# Private\n");
  vi.stubGlobal("fetch", backend.fetchImpl);
  await seedStorageBinding(t, { workspaceId, boundBy: owner });

  return { t, owner, editor, reader, stranger, workspaceId, backend };
}

/** The icon on the row, read directly rather than through a query. */
async function iconOf(f: Fixture) {
  const row = await f.t.run((ctx) => ctx.db.get(f.workspaceId));
  return row?.icon;
}

async function setPhoto(f: Fixture, as: Id<"users">) {
  return await asUser(f.t, as).action(api.functions.files.setWorkspaceIconPhoto, {
    workspaceId: f.workspaceId,
    bytes: PHOTO.buffer,
    contentType: "image/png",
  });
}

/* -------------------------------------------------------------------------- */

describe("an emoji icon", () => {
  test("a workspace that has never chosen carries nothing, so the letter stands", async () => {
    const f = await fixture();
    // Absent rather than a stored letter: see the clearing test below for why
    // freezing today's derivation onto the row is the bug, not the tidy-up.
    expect(await iconOf(f)).toBeUndefined();
  });

  test("the owner can choose one, and it reaches the console's own query", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).mutation(api.functions.workspaces.setWorkspaceIcon, {
      workspaceId: f.workspaceId,
      emoji: "🧠",
    });
    expect(await iconOf(f)).toEqual({ kind: "emoji", emoji: "🧠" });

    // Through `listMyWorkspaces`, because a row the rail cannot read is a
    // setting that appears to work and changes nothing on screen.
    const mine = await asUser(f.t, f.owner).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    expect(mine.find((row) => row.slug === "atlas")?.icon).toEqual({
      kind: "emoji",
      emoji: "🧠",
    });
  });

  test("every emoji the picker offers is one the server accepts", () => {
    // The picker's list and the server's rule are one module precisely so this
    // cannot drift; this is the assertion that says so out loud.
    for (const emoji of WORKSPACE_ICON_EMOJI) {
      expect(isSingleEmoji(emoji), emoji).toBe(true);
    }
  });

  test("a single emoji is a structure, not a length", () => {
    // Multi-code-point sequences that are genuinely one glyph.
    expect(isSingleEmoji("👍🏽")).toBe(true); // skin-tone modifier
    expect(isSingleEmoji("🇬🇧")).toBe(true); // a pair of regional indicators
    expect(isSingleEmoji("👩‍💻")).toBe(true); // a ZWJ sequence
    expect(isSingleEmoji("👨‍👩‍👧‍👦")).toBe(true); // four people, one glyph
    expect(isSingleEmoji("3️⃣")).toBe(true); // a keycap
    expect(isSingleEmoji("❤️")).toBe(true); // a variation selector
  });

  test("what an 18pt square on somebody else's screen must refuse", () => {
    expect(isSingleEmoji("")).toBe(false);
    expect(isSingleEmoji("A")).toBe(false);
    expect(isSingleEmoji("ab")).toBe(false);
    expect(isSingleEmoji("3")).toBe(false); // a digit is not a keycap
    expect(isSingleEmoji("🧠🧠")).toBe(false); // two glyphs, unjoined
    expect(isSingleEmoji("🧠 ")).toBe(false); // nothing may ride along
    expect(isSingleEmoji(" 🧠")).toBe(false);
    expect(isSingleEmoji("🧠a")).toBe(false);
    // The layout attacks, which no length check catches.
    expect(isSingleEmoji("‮evil")).toBe(false); // RTL override
    expect(isSingleEmoji("é́́́")).toBe(false); // combining stack
    expect(isSingleEmoji("🇬")).toBe(false); // half a flag is not a flag
    // A hundred joins is one "grapheme" and a kilobyte on every row.
    expect(isSingleEmoji(Array(50).fill("🧠").join("‍"))).toBe(false);
  });

  test("the mutation refuses what the validator refuses", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.owner).mutation(api.functions.workspaces.setWorkspaceIcon, {
        workspaceId: f.workspaceId,
        emoji: "not an emoji",
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_ICON_INVALID");
    expect(await iconOf(f)).toBeUndefined();
  });

  test("clearing removes the row's value rather than freezing today's letter", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).mutation(api.functions.workspaces.setWorkspaceIcon, {
      workspaceId: f.workspaceId,
      emoji: "🧠",
    });
    await asUser(f.t, f.owner).mutation(api.functions.workspaces.setWorkspaceIcon, {
      workspaceId: f.workspaceId,
      emoji: null,
    });
    // Undefined, not "A". A stored letter would stop following the slug, so a
    // renamed workspace would keep an answer nobody thinks of the row as
    // holding.
    expect(await iconOf(f)).toBeUndefined();
  });
});

describe("who may change a workspace's face", () => {
  test("an editor may not — they write notes, not the workspace", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.editor).mutation(api.functions.workspaces.setWorkspaceIcon, {
        workspaceId: f.workspaceId,
        emoji: "🧠",
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(await iconOf(f)).toBeUndefined();
  });

  test("an editor may paste an image and still not make one the icon", async () => {
    const f = await fixture();
    // The distinction that makes this its own test: `storeNoteImage` takes an
    // editor, because writing bytes to the bucket is editor work. This writes
    // bytes *and* changes what every member sees, so it takes the stricter of
    // the two roles.
    const error = await captureError(() => setPhoto(f, f.editor));
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(await iconOf(f)).toBeUndefined();
    /*
      AND THE REFUSAL CAME BEFORE THE BUCKET WAS TOUCHED.

      This line is the one that pins the *outer* gate, and it was added because
      a sabotage run found the suite could not see that gate at all: with
      `setWorkspaceIconPhoto` dropped to `editor`, the row is still protected by
      `recordWorkspaceIconPhoto`'s own owner check, so the action still fails
      and every other assertion here still holds — while an editor's bytes have
      by then been written into the customer's bucket. Defence in depth is why
      that is not a vulnerability; it is also why "the action threw" is not
      evidence that the first check exists.
    */
    expect([...f.backend.objects.keys()].some((key) => key.startsWith(IMAGE_PREFIX))).toBe(
      false,
    );
  });

  test("a stranger cannot learn the workspace exists by trying", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.stranger).mutation(api.functions.workspaces.setWorkspaceIcon, {
        workspaceId: f.workspaceId,
        emoji: "🧠",
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });
});

describe("the inner query carries its own gate", () => {
  /*
    `workspaceIconPhoto` checks membership before it ever asks for the leaf, so
    the check inside `workspaceIconLeaf` is never reached by a caller the outer
    one would refuse — which means the suite could not see it: a sabotage run
    deleted it and all twenty-one tests still passed.

    It stays, because an internal query that assumes its caller checked is a
    landmine for the second caller, and this is what makes it visible: the query
    is asked directly, the way a future caller would ask it.
  */
  test("a stranger asking it directly gets nothing, not a leaf", async () => {
    const f = await fixture();
    const { leaf } = await setPhoto(f, f.owner);

    const mine = await f.t.query(internal.functions.workspaces.workspaceIconLeaf, {
      workspaceId: f.workspaceId,
      actorUserId: f.owner,
    });
    expect(mine).toBe(leaf);

    const error = await captureError(() =>
      f.t.query(internal.functions.workspaces.workspaceIconLeaf, {
        workspaceId: f.workspaceId,
        actorUserId: f.stranger,
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });
});

describe("a photo icon lives in the customer's bucket", () => {
  test("the bytes go to the bucket and only the leaf goes on the row", async () => {
    const f = await fixture();
    const { leaf } = await setPhoto(f, f.owner);

    // Named from the content, labelled by where it came from.
    expect(leaf).toMatch(/^icon-[a-f0-9]{16}\.png$/);
    expect(await iconOf(f)).toEqual({ kind: "photo", leaf });

    // In the opaque store, in the workspace's own bucket.
    expect([...f.backend.objects.keys()]).toContain(`${IMAGE_PREFIX}${leaf}`);

    // Byte for byte, in the bucket — compared as bytes, because a PNG decoded
    // as UTF-8 is mojibake and a stub that re-encodes would pass a text check.
    expect(f.backend.bytesOf(`${IMAGE_PREFIX}${leaf}`)).toEqual(PHOTO);

    // AND THE ROW HOLDS THE NAME AND NOTHING ELSE. The control plane keeps
    // metadata, never content, so a customer who revokes our credential leaves
    // with the picture (CLAUDE.md #1). Asserted as the exact shape rather than
    // by sniffing for an encoding, because the point is that there is no
    // second field for bytes to hide in.
    expect(await iconOf(f)).toEqual({ kind: "photo", leaf });
  });

  test("the owner reads it back, byte for byte", async () => {
    const f = await fixture();
    await setPhoto(f, f.owner);
    const read = await asUser(f.t, f.owner).action(
      api.functions.files.workspaceIconPhoto,
      { workspaceId: f.workspaceId },
    );
    expect(new Uint8Array(read.bytes)).toEqual(PHOTO);
    expect(read.contentType).toBe("image/png");
  });

  test("every member reads it, because it is drawn in their rail", async () => {
    const f = await fixture();
    await setPhoto(f, f.owner);
    for (const who of [f.editor, f.reader]) {
      const read = await asUser(f.t, who).action(
        api.functions.files.workspaceIconPhoto,
        { workspaceId: f.workspaceId },
      );
      expect(new Uint8Array(read.bytes)).toEqual(PHOTO);
    }
  });

  test("a stranger gets the same answer as for a workspace that never existed", async () => {
    const f = await fixture();
    await setPhoto(f, f.owner);
    const error = await captureError(() =>
      asUser(f.t, f.stranger).action(api.functions.files.workspaceIconPhoto, {
        workspaceId: f.workspaceId,
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("a workspace with no photo is an absence, not an error to reason from", async () => {
    const f = await fixture();
    const missing = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.workspaceIconPhoto, {
        workspaceId: f.workspaceId,
      }),
    );
    expect(errorCode(missing)).toBe("FILE_NOT_FOUND");

    // An emoji icon is the same absence: there is no photo to serve.
    await asUser(f.t, f.owner).mutation(api.functions.workspaces.setWorkspaceIcon, {
      workspaceId: f.workspaceId,
      emoji: "🧠",
    });
    const emojiInstead = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.workspaceIconPhoto, {
        workspaceId: f.workspaceId,
      }),
    );
    expect(errorCode(emojiInstead)).toBe("FILE_NOT_FOUND");
  });

  test("choosing an emoji afterwards replaces the photo on the row", async () => {
    const f = await fixture();
    const { leaf } = await setPhoto(f, f.owner);
    await asUser(f.t, f.owner).mutation(api.functions.workspaces.setWorkspaceIcon, {
      workspaceId: f.workspaceId,
      emoji: "🧠",
    });
    expect(await iconOf(f)).toEqual({ kind: "emoji", emoji: "🧠" });
    // The object stays. It is content-addressed and in the customer's bucket:
    // it may be another workspace's icon or a note's embed, and it is theirs.
    expect([...f.backend.objects.keys()]).toContain(`${IMAGE_PREFIX}${leaf}`);
  });
});

/**
 * The pinned context is reached without a membership row, and its icon has to
 * survive that.
 *
 * `@context-lc` is in every account's rail (`lib/pinnedContext.ts`) and nobody
 * is a member of it — which is exactly the shape that breaks a second
 * authorization check written from habit. `authorizeFileAccess` knows about the
 * pin and `requireWorkspaceAccess` does not, so an inner gate built on the
 * latter refuses a workspace the outer gate just admitted, and the pinned
 * context is the only row in the product where those two disagree.
 *
 * Found by reading the diff rather than by a failing test, which is why it has
 * one now: the console catches the refusal and falls back to the letter, so the
 * symptom would have been "the pinned context is the one workspace whose photo
 * never appears", with nothing in any log.
 */
describe("the pinned context", () => {
  async function pinnedFixture() {
    const t = setupTest();
    vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
    const staff = await createUser(t, "staff@example.invalid");
    await createWorkspace(t, staff, "staff-personal");
    const pinnedId = await createWorkspace(t, staff, PINNED_CONTEXT_SLUG, {
      kind: "shared",
      displayName: "Context",
    });
    // An ordinary customer, who is a member of nothing staff owns.
    const visitor = await createUser(t, "visitor@example.invalid");
    await createWorkspace(t, visitor, "visitor-own");

    const backend = memoryS3(FAKE_STORAGE.bucket);
    backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
    backend.seed("index.md", "# Context\n");
    vi.stubGlobal("fetch", backend.fetchImpl);
    await seedStorageBinding(t, { workspaceId: pinnedId, boundBy: staff });
    return { t, staff, visitor, pinnedId, backend };
  }

  test("somebody who only reaches it by the pin still sees its photo", async () => {
    const f = await pinnedFixture();
    await asUser(f.t, f.staff).action(api.functions.files.setWorkspaceIconPhoto, {
      workspaceId: f.pinnedId,
      bytes: PHOTO.buffer,
      contentType: "image/png",
    });

    const read = await asUser(f.t, f.visitor).action(
      api.functions.files.workspaceIconPhoto,
      { workspaceId: f.pinnedId },
    );
    expect(new Uint8Array(read.bytes)).toEqual(PHOTO);
  });

  test("reaching it by the pin is still not membership, so its icon is not theirs to set", async () => {
    const f = await pinnedFixture();
    const error = await captureError(() =>
      asUser(f.t, f.visitor).mutation(api.functions.workspaces.setWorkspaceIcon, {
        workspaceId: f.pinnedId,
        emoji: "🧠",
      }),
    );
    // Read without membership, write never: the pin is reach, not a role.
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });
});

/**
 * The property the whole photo path rests on.
 *
 * `readNoteImage` takes a leaf and gates it on a note the caller can see. This
 * takes no leaf at all, so there is nothing to gate: the object is chosen by
 * the workspace's own row. These tests are about the *shape* of the door, not
 * about one attempt to walk through it.
 */
describe("the read path is not a general object reader", () => {
  test("it has no argument through which an object can be named", () => {
    /*
      Read from the validator Convex will actually enforce, not from the source
      text — `docs/decisions/testing.md` records two guards that were defeated
      by reading source as prose. `connectBinding.test.ts` does the same.
    */
    const exported = JSON.parse(
      (fileFunctions.workspaceIconPhoto as unknown as { exportArgs: () => string })
        .exportArgs(),
    ) as { value?: Record<string, unknown> };
    // Exactly one argument, and it is a workspace. If a `leaf` (or a `path`, or
    // a `key`) is ever added here for convenience, this feature's security
    // argument is over, and this test is where that gets said out loud.
    expect(Object.keys(exported.value ?? {})).toEqual(["workspaceId"]);
  });

  test("a leaf smuggled in beside the workspace is refused, not ignored", async () => {
    const f = await fixture();
    await setPhoto(f, f.owner);
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(
        api.functions.files.workspaceIconPhoto,
        { workspaceId: f.workspaceId, leaf: "../../privacy.md" } as never,
      ),
    );
    /*
      Stronger than "ignored", and worth pinning as the actual behaviour: the
      declared validator is closed, so an unknown field fails the call before
      the handler runs. A caller cannot pass an object name to this function
      even to have it dropped.
    */
    expect(String(error)).toContain("Unexpected field `leaf`");
    // And the object it does serve is still the row's own.
    const read = await asUser(f.t, f.owner).action(
      api.functions.files.workspaceIconPhoto,
      { workspaceId: f.workspaceId },
    );
    expect(new Uint8Array(read.bytes)).toEqual(PHOTO);
  });
});

describe("an icon is small, and draws in a browser", () => {
  test("a type no browser renders is refused, however valid the image", async () => {
    const f = await fixture();
    // HEIC is what an iPhone holds a photo as, and what no browser draws. The
    // image store itself accepts it; an icon cannot, or a mark chosen on a
    // phone is a blank square on the web app.
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.setWorkspaceIconPhoto, {
        workspaceId: f.workspaceId,
        bytes: PHOTO.buffer,
        contentType: "image/heic",
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_ICON_TYPE");
    expect(await iconOf(f)).toBeUndefined();
  });

  test("the cap is this feature's, well under what the image store allows", async () => {
    const f = await fixture();
    const oversized = new Uint8Array(WORKSPACE_ICON_MAX_BYTES + 1);
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.setWorkspaceIconPhoto, {
        workspaceId: f.workspaceId,
        bytes: oversized.buffer,
        contentType: "image/png",
      }),
    );
    // Not CONTENT_TOO_LARGE, which is `writeImage`'s five-megabyte refusal:
    // this one is checked before the bytes ever reach the bucket, because the
    // console draws this square once per workspace per paint.
    expect(errorCode(error)).toBe("WORKSPACE_ICON_TOO_LARGE");
    expect(await iconOf(f)).toBeUndefined();
    expect([...f.backend.objects.keys()].some((key) => key.startsWith(IMAGE_PREFIX))).toBe(
      false,
    );
  });

  test("a failed write leaves the old icon standing", async () => {
    // The bucket takes the first photo and then refuses the prefix, which is
    // what a tightened bucket policy looks like from in here.
    let refusing = false;
    const f = await fixture({
      refuseWrite: (key) => refusing && key.startsWith(IMAGE_PREFIX),
    });
    const first = await setPhoto(f, f.owner);

    refusing = true;
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.setWorkspaceIconPhoto, {
        workspaceId: f.workspaceId,
        bytes: new Uint8Array([9, 9, 9]).buffer,
        contentType: "image/png",
      }),
    );
    expect(error).toBeDefined();
    // The row still points at an object that is actually there. Patching it
    // before the write landed would leave the workspace pointing at nothing,
    // which draws as a broken mark for every member rather than as the letter.
    expect(await iconOf(f)).toEqual({ kind: "photo", leaf: first.leaf });
  });
});
