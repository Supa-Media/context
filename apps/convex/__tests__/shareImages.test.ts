/**
 * A shared link shows the pictures its note embeds, and no other picture.
 *
 * Dev2 (2026-10-25): a note with pasted screenshots, shared by link, opened
 * with every picture broken ("Not in this bucket: paste-….png"). The share page
 * had no way to ask for a picture at all. `readSharedImage` is that way, and it
 * is bounded by the same read the note itself goes through: the link must
 * resolve, the note must be readable through it right now, and the note's own
 * text (outside code) must embed the picture. A picture in the store that the
 * note does not embed is as absent as one that was never stored.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

// Each test builds a workspace with a bucket and a copied tree, which takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  asUser,
  captureError,
  copyTree,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { renderPrivacyManifest } from "./seededRules.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const IMAGES = ".context/assets/images/";
const ENTRY = "1-projects/feedback/site.md";
const LINKED = "1-projects/feedback/catalogue.md";
const UNLINKED = "1-projects/feedback/sibling.md";
const PRIVATE_NOTE = "2-areas/salaries.md";

const ON_ENTRY = "paste-837e9da1b5c5d2b8.png";
const ON_LINKED = "paste-cda7f7282f0794c2.jpg";
const ON_UNLINKED = "paste-1111111111111111.png";
const ON_PRIVATE = "paste-2222222222222222.png";
const IN_CODE = "paste-3333333333333333.png";
const NOWHERE = "paste-4444444444444444.png";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 3, 4]);

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");

  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed(
    ENTRY,
    [
      "# Site feedback",
      "",
      "Color scheme hurts my eyes.",
      `![[${ON_ENTRY}]]`,
      "",
      "See [the catalogue](catalogue.md).",
      "",
      "```",
      `![[${IN_CODE}]]`,
      "```",
      "",
    ].join("\n"),
  );
  backend.seed(LINKED, `# Catalogue\n\n![a shot](${ON_LINKED})\n`);
  backend.seed(UNLINKED, `# Sibling\n\n![[${ON_UNLINKED}]]\n`);
  backend.seed(PRIVATE_NOTE, `# Salaries\n\n![[${ON_PRIVATE}]]\n`);
  for (const leaf of [ON_ENTRY, ON_UNLINKED, ON_PRIVATE, IN_CODE, NOWHERE]) {
    backend.seed(`${IMAGES}${leaf}`, PNG);
  }
  backend.seed(`${IMAGES}${ON_LINKED}`, JPG);
  vi.stubGlobal("fetch", backend.fetchImpl);

  const encryptedSecretAccessKey = await encryptSecret(
    FAKE_STORAGE.secretAccessKey,
    requireKeyset(),
    { workspaceId },
  );
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  await copyTree(t, workspaceId);
  await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId,
    path: "1-projects",
    visibility: "team",
  });
  return { t, owner, workspaceId, backend };
}

async function unlisted(f: Fixture, path: string = ENTRY): Promise<string> {
  const { token } = await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
    workspaceId: f.workspaceId,
    path,
  });
  return token;
}

/** Ask for a picture with no session at all, as an unlisted link's reader does. */
function picture(f: Fixture, token: string, leaf: string, path?: string) {
  return f.t.action(api.functions.shares.readSharedImage, {
    token,
    leaf,
    ...(path === undefined ? {} : { path }),
  });
}

describe("a shared link's pictures", () => {
  test("a picture the shared note embeds comes back, to a reader with no session", async () => {
    const f = await fixture();
    const token = await unlisted(f);

    const read = await picture(f, token, ON_ENTRY);
    expect(read.contentType).toBe("image/png");
    expect(new Uint8Array(read.bytes)).toEqual(PNG);
  });

  test("and one a linked note embeds, asked for on that note", async () => {
    const f = await fixture();
    const token = await unlisted(f);

    const read = await picture(f, token, ON_LINKED, LINKED);
    expect(read.contentType).toBe("image/jpeg");
    expect(new Uint8Array(read.bytes)).toEqual(JPG);
  });

  test("a stored picture the note does not embed is refused like any other miss", async () => {
    const f = await fixture();
    const token = await unlisted(f);

    expect(errorCode(await captureError(() => picture(f, token, NOWHERE)))).toBe("NOT_AUTHENTICATED");
    // A picture another note embeds is not the shared note's to hand out.
    expect(errorCode(await captureError(() => picture(f, token, ON_LINKED)))).toBe("NOT_AUTHENTICATED");
  });

  test("a picture named only inside code is not an embed", async () => {
    const f = await fixture();
    const token = await unlisted(f);

    expect(errorCode(await captureError(() => picture(f, token, IN_CODE)))).toBe("NOT_AUTHENTICATED");
  });

  test("a note the link cannot read vouches for nothing", async () => {
    const f = await fixture();
    const token = await unlisted(f);

    expect(errorCode(await captureError(() => picture(f, token, ON_UNLINKED, UNLINKED)))).toBe(
      "NOT_AUTHENTICATED",
    );
    expect(errorCode(await captureError(() => picture(f, token, ON_PRIVATE, PRIVATE_NOTE)))).toBe(
      "NOT_AUTHENTICATED",
    );
  });

  test("a revoked link reaches no picture", async () => {
    const f = await fixture();
    const token = await unlisted(f);
    expect((await picture(f, token, ON_ENTRY)).contentType).toBe("image/png");

    const rows = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    const live = rows.find((row) => row.token === token);
    await asUser(f.t, f.owner).mutation(api.functions.shares.revokeShare, { shareId: live!.shareId });

    expect(errorCode(await captureError(() => picture(f, token, ON_ENTRY)))).toBe("NOT_AUTHENTICATED");
  });

  test("a note made private after the link was minted takes its pictures with it", async () => {
    const f = await fixture();
    const token = await unlisted(f);

    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects",
      visibility: "private",
    });

    expect(errorCode(await captureError(() => picture(f, token, ON_ENTRY)))).toBe("NOT_AUTHENTICATED");
  });

  test("a short link reaches the same pictures, by name", async () => {
    const f = await fixture();
    const token = await unlisted(f);
    const rows = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    const live = rows.find((row) => row.token === token)!;
    await asUser(f.t, f.owner).mutation(api.functions.shares.setShareSlug, {
      shareId: live.shareId,
      slug: "feedback",
    });
    const read = await f.t.action(api.functions.shares.readSharedImage, {
      handle: "atlas",
      slug: "feedback",
      leaf: ON_ENTRY,
    });
    expect(new Uint8Array(read.bytes)).toEqual(PNG);
  });
});
