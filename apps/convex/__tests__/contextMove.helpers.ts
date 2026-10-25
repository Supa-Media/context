/**
 * Two contexts with a bucket each, for the cross-context move suites
 * (`contextMoveEndToEnd.test.ts`, `contextMoveKeyed.test.ts`,
 * `contextMoveKeyedRace.test.ts`, `contextMoveGatewayRoute.test.ts`).
 *
 * Both workspaces are keyed by the real copy pass, as every workspace is, so a
 * move carries notes by id. With `mover: true` the deployment's
 * `STORAGE_MOVER_ORIGIN` is set; a keyed move does not use the gateway's mover,
 * and `opened` records any page it did open, so a suite can show that.
 * Every bucket request made outside the mover is recorded in `outside`.
 */

import { afterEach, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  FAKE_STORAGE,
  TEST_GATEWAY_SECRET,
  addMember,
  asUser,
  copyTree,
  drainDueScheduled,
  createUser,
  createWorkspace,
  gatewayPost,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import { handleMoverPage } from "../../mcp/src/moves/mover.js";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifestForFolders } from "./seededRules.helpers";
import { nodeAt as treeNodeAt } from "../functions/lib/nodes/paths";
import { rowsAsRead } from "./nodes/treeRows.helpers";

export const MOVER = "https://mover.example.invalid";

const SOURCE_BUCKET = "example-source-bucket";
const DESTINATION_BUCKET = "example-destination-bucket";

/**
 * One `fetch` over two buckets.
 *
 * Each `memoryS3` answers `NoSuchBucket` for a path that is not its own, so
 * "try the other one" is a complete router rather than a guess — and a request
 * that reached neither still comes back as a 404 the adapter understands,
 * instead of as a hung promise that would make a misrouted call look like a
 * slow one.
 */
function twoBuckets(source: MemoryS3, destination: MemoryS3) {
  return async (input: URL | RequestInfo, init: RequestInit = {}): Promise<Response> => {
    const first = await source.fetchImpl(input, init);
    if (first.status !== 404) return first;
    const body = await first.clone().text();
    if (!body.includes("NoSuchBucket")) return first;
    return await destination.fetchImpl(input, init);
  };
}

async function bindBucket(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  boundBy: Id<"users">,
  bucket: string,
): Promise<void> {
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
      bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      /*
        THE SHAPE A REAL BINDING PROBES AS, NOT THE FLATTERING ONE.

        R2 accepts `If-Match` on DELETE and ignores it, so every real row comes
        back `conditionalDelete: false` with the other two true — measured in
        `apps/mcp`'s "Move a note on storage that will not enforce a
        conditional delete". Writing `true` here would run this whole suite
        down a branch no customer is on and leave `retireMovedSource`'s
        conditional-PUT substitute — the thing that actually protects an edit
        made mid-move — untested end to end.
      */
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

export interface Pair {
  t: TestConvex;
  mover: Id<"users">;
  from: Id<"workspaces">;
  to: Id<"workspaces">;
  source: MemoryS3;
  destination: MemoryS3;
  /** Bucket requests made outside the mover, as `METHOD key`. */
  outside: string[];
  /** What each object read outside the mover answered. */
  outsideReads: { key: string; body: string }[];
  /** Pages the mover opened. */
  opened: unknown[];
}

/**
 * Two contexts and a bucket each.
 *
 * `into` is the half worth choosing per test, because the two real shapes read
 * differently at the far end and both have to work:
 *
 *  - `"shared"` — somebody else's shared context that the mover is an `editor`
 *    of. Its folders scaffold `team`, which is what makes an editor able to
 *    write into them at all, and which is exactly the case where a private
 *    note has to arrive carrying an exception.
 *  - `"own"` — a second personal context the mover owns. Its folders are
 *    private, and only an owner's `private` scope can see them, so this is the
 *    case a hardcoded `team` at the destination used to refuse with "not
 *    found" about the mover's own folder.
 *
 * @param notes how many notes to put in `1-projects/acme`. The default is more
 * than one batch carries, so the chain has to run more than once.
 */
export async function pair(
  options: { notes?: number; into?: "shared" | "own"; mover?: boolean } = {},
): Promise<Pair> {
  const t = setupTest();
  const mover = await createUser(t, "mover@example.invalid");
  const other = await createUser(t, "other@example.invalid");
  const from = await createWorkspace(t, mover, "ada-context");
  const into = options.into ?? "shared";
  const to =
    into === "own"
      ? await createWorkspace(t, mover, "cee-context")
      : await createWorkspace(t, other, "bee-context", { kind: "shared" });
  if (into === "shared") await addMember(t, to, mover, "editor", other);

  const source = memoryS3(SOURCE_BUCKET, { ignoreConditionalDelete: true });
  source.seed(PRIVACY_KEY, renderPrivacyManifestForFolders(["1-projects"], "personal"));
  source.seed("1-projects/README.md", "# Projects\n");
  const notes = options.notes ?? 55;
  for (let index = 0; index < notes; index += 1) {
    source.seed(`1-projects/acme/note-${String(index).padStart(3, "0")}.md`, `# ${index}\n`);
  }

  const destination = memoryS3(DESTINATION_BUCKET, { ignoreConditionalDelete: true });
  destination.seed(
    PRIVACY_KEY,
    renderPrivacyManifestForFolders(["work"], into === "own" ? "personal" : "shared"),
  );
  destination.seed("work/README.md", "# Work\n");

  const outside: string[] = [];
  const outsideReads: { key: string; body: string }[] = [];
  const opened: unknown[] = [];
  const buckets = twoBuckets(source, destination);
  let inMover = 0;
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(MOVER)) {
      const path = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).slice(1).join("/"));
      const response = await buckets(input, init);
      if (inMover === 0 && path !== "") {
        outside.push(`${init.method ?? "GET"} ${path}`);
        if ((init.method ?? "GET") === "GET" && response.status === 200) {
          outsideReads.push({ key: path, body: await response.clone().text() });
        }
      }
      return response;
    }
    inMover += 1;
    try {
      return await handleMoverPage(
        new Request(url, { method: "POST", headers: new Headers(init.headers), body: init.body }),
        { GATEWAY_SECRET: TEST_GATEWAY_SECRET },
        {
          controlPlane: {
            async openMoverPage(ticket: string) {
              const response = await gatewayPost(t, "/gateway/mover/open", { ticket });
              if (response.status !== 200) throw new Error("control plane unavailable");
              const { page } = (await response.json()) as { page: unknown };
              opened.push(page);
              return page as object | null;
            },
          },
        },
      );
    } finally {
      inMover -= 1;
    }
  });
  if (options.mover === true) vi.stubEnv("STORAGE_MOVER_ORIGIN", MOVER);
  await bindBucket(t, from, mover, SOURCE_BUCKET);
  await bindBucket(t, to, into === "own" ? mover : other, DESTINATION_BUCKET);
  // Both workspaces copied and keyed, as every workspace is: a note's bytes live
  // at `notes/<noteId>.md`, and the tree names them.
  await copyTree(t, from);
  await copyTree(t, to);
  // The copies' own follow-ups (front matter read, parity) run now, so what
  // the tests count outside the mover is the move's alone.
  await drainDueScheduled(t);
  outside.length = 0;
  outsideReads.length = 0;
  opened.length = 0;

  return { t, mover, from, to, source, destination, outside, outsideReads, opened };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** The live file rows under `prefix`, as the tree names them. Trashed rows and folders are left out. */
export async function liveFilesUnder(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  prefix: string,
): Promise<Doc<"nodes">[]> {
  return await t.run(async (ctx) =>
    (await rowsAsRead(ctx, workspaceId)).filter(
      (row) =>
        row.kind === "file" &&
        row.goneAt === undefined &&
        row.path.startsWith(prefix),
    ),
  );
}

/** The live file row at `path`, or `null`. */
export async function liveFileAt(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  path: string,
): Promise<Doc<"nodes"> | null> {
  return await t.run(async (ctx) => {
    const row = await treeNodeAt(ctx.db, workspaceId, path);
    return row !== null && row.kind === "file" && row.goneAt === undefined
      ? row
      : null;
  });
}

/** The body a row's note holds, read at the note's own key. */
export function bodyOfRow(bucket: MemoryS3, row: Doc<"nodes"> | null): string | undefined {
  if (row === null || row.storageKey === undefined) return undefined;
  return bucket.objects.get(row.storageKey)?.body;
}

/**
 * Write a note through the product, as `userId`. The only way a test changes
 * a note once its workspace is keyed.
 */
export async function writeAs(
  p: Pair,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
  path: string,
  text: string,
): Promise<void> {
  await asUser(p.t, userId).action(api.functions.files.writeNote, { workspaceId, path, text });
}
