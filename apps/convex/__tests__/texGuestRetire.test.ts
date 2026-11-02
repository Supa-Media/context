/**
 * RETIRING TEX'S GUEST CHATS: EACH CHAT'S FOLDER MOVES INTO THE CHAT'S HOME (`functions/texGuestRetire.ts`,
 * `lib/contextMoveChatHome.ts`; owner-approved 2026-10-31; `docs/decisions/texting-assistant/group-guests.md`).
 *
 * A guest chat kept its notes in `tex/chats/<words>/` of the workspace it was bound to. Guest mode is gone, so the whole
 * folder, the notes its members wrote in it included, goes into the chat's home in the pinned workspace by the ordinary
 * cross-context move, marked as the chat's own. What must hold:
 *
 *  - a dry run writes nothing, and a real run moves the folder, sealed, into the chat's object, readable by the chat's
 *    people and by nobody who runs the pin;
 *  - running it twice is safe;
 *  - the marker moves one chat's folder into that chat's home and nothing else: not another chat's folder, not another
 *    path, not into another home, not into a workspace that is not the pin, not from another workspace;
 *  - a person's own `startContextMove` still cannot move into a home, and nothing outside the system can set the marker.
 *
 * Every value is fake. The Durable Object is the real object behind the real door; its ticket is the real one.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `chatHomeMoveAccess` without the `from` check            -> "another path" and "another chat's folder" fail.
 *  2. `chatHomeMoveAccess` without the `to` check              -> "another chat's home" fails.
 *  3. `chatHomeMoveAccess` without the pinned-workspace check  -> "a workspace that is not the pin" fails.
 *  4. `chatHomeMoveAccess` without the source-workspace check  -> "another workspace's folder" fails.
 *  5. `chatsOfHomes` answering nothing (no ticket for the chat) -> "a real run moves the folder" fails.
 *  6. `reopenMove` without the marker refusal                  -> "a person cannot resume" fails.
 *  7. `retireChat` writing on a dry run                        -> "a dry run writes nothing" fails.
 *  8. `finishChat` skipped                                     -> "a real run moves the folder" fails (guest fields stay).
 */

import { createRequire } from "node:module";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { handleTexStoreDoor } from "../../mcp/src/texStore/door.js";
import { texObjects } from "../../mcp/src/texStore/objects.js";
import { serveTexStore } from "../../mcp/src/texStore/wire.js";
import { visibleGrantedPaths } from "../functions/lib/grants/outsider";
import { syncChatPhones } from "../functions/lib/guestPhones";
import { ensureChatHome } from "../functions/lib/textGroupHome";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { asUser, addMember, copyTree, createUser, createWorkspace, drainScheduled, gatewayPost, seedStorageBinding, TEST_GATEWAY_SECRET } from "./fixtures.helpers";
import { liveFileAt, liveFilesUnder } from "./contextMove.helpers";
import { migrate, pinnedWorld, visibleTo, clearanceOf, type PinnedWorld } from "./pinnedReaders.helpers";
import { renderPrivacyManifestForFolders } from "./seededRules.helpers";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const GATEWAY = "https://gateway.example.invalid";
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const WORDS_A = "chair-blast-tiger";
const WORDS_B = "lamp-river-stone";
const FOLDER_A = `tex/chats/${WORDS_A}`;
const FOLDER_B = `tex/chats/${WORDS_B}`;
const HOME_A = `tex/groups/${WORDS_A}`;
const MARKER = "zzretiremarker";

function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...binds: unknown[]) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...(binds as never[]));
        return { toArray: () => all };
      }
      statement.run(...(binds as never[]));
      return { toArray: () => [] };
    },
  };
}

type World = PinnedWorld & {
  ada: Id<"users">;
  bo: Id<"users">;
  acme: Id<"workspaces">;
  other: Id<"workspaces">;
  source: MemoryS3;
  objects: Map<string, ReturnType<typeof texObjects>>;
  chatA: Id<"textGroups">;
  chatB: Id<"textGroups">;
};

/**
 * The pinned world, a shared workspace `acme` holding two guest chats' folders and a neighbour note, a second shared
 * workspace, and the gateway's Tex door in front of real Durable Object storage.
 */
async function world(): Promise<World> {
  const w = await pinnedWorld();
  await migrate(w);
  const ada = await createUser(w.t, "ada@example.invalid");
  const bo = await createUser(w.t, "bo@example.invalid");
  const acme = await createWorkspace(w.t, ada, "acme", { kind: "shared" });
  await addMember(w.t, acme, bo, "editor", ada);
  const other = await createWorkspace(w.t, ada, "elsewhere", { kind: "shared" });

  const source = memoryS3("acme-bucket", { ignoreConditionalDelete: true });
  source.seed(PRIVACY_KEY, renderPrivacyManifestForFolders(["1-projects", "tex"], "shared"));
  source.seed(`${FOLDER_A}/flights.md`, `# Flights\n\n${MARKER}\n`);
  source.seed(`${FOLDER_A}/hotels.md`, `# Hotels, written by a member\n\n${MARKER}\n`);
  source.seed(`${FOLDER_A}/sub/notes.md`, `# Deeper\n\n${MARKER}\n`);
  source.seed(`${FOLDER_B}/other-chat.md`, `# Another chat\n\n${MARKER}\n`);
  source.seed("1-projects/neighbour.md", `# Neighbour\n\n${MARKER}\n`);
  const otherBucket = memoryS3("elsewhere-bucket", { ignoreConditionalDelete: true });
  otherBucket.seed(PRIVACY_KEY, renderPrivacyManifestForFolders(["1-projects"], "shared"));
  otherBucket.seed("1-projects/hello.md", "# Hello\n");
  // A folder at the very path a guest chat's is, in a workspace that is not the chat's.
  otherBucket.seed(`${FOLDER_A}/decoy.md`, "# Decoy\n");
  const capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false };
  await w.t.run(async (ctx) => {
    const binding = await ctx.db.query("storageBindings").withIndex("by_workspace", (q) => q.eq("workspaceId", w.pinned)).unique();
    await ctx.db.patch(binding!._id, { capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false } });
  });
  await seedStorageBinding(w.t, { workspaceId: acme, boundBy: ada, bucket: "acme-bucket", capabilities });
  await seedStorageBinding(w.t, { workspaceId: other, boundBy: ada, bucket: "elsewhere-bucket", capabilities });

  const objects = new Map<string, ReturnType<typeof texObjects>>();
  const env = {
    GATEWAY_SECRET: TEST_GATEWAY_SECRET,
    TEX_STORE: {
      idFromName: (name: string) => name,
      // The gateway reaches each owner's store placed in eastern North America, `enam:<owner>` (`texStore/move.js`); kept here by owner.
      get: (placed: string) => {
        const name = placed.replace(/^enam:/, "");
        if (!objects.has(name)) objects.set(name, texObjects(durableSql()));
        const held = objects.get(name)!;
        return { fetch: (request: Request) => serveTexStore(held, request) };
      },
    },
  };
  const controlPlane = {
    async openTexStoreTicket(ticket: string) {
      const response = await gatewayPost(w.t, "/gateway/tex-store/open", { ticket });
      const { opened } = (await response.json()) as { opened: { workspaceId: string; owners: string[] } | null };
      return opened;
    },
  };
  const buckets = [w.backend, source, otherBucket];
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(GATEWAY)) return await handleTexStoreDoor(new Request(url, init), env, { controlPlane });
    let last: Response | null = null;
    for (const bucket of buckets) {
      const answer = await bucket.fetchImpl(input, init);
      if (answer.status !== 404 || !(await answer.clone().text()).includes("NoSuchBucket")) return answer;
      last = answer;
    }
    return last!;
  });
  await copyTree(w.t, acme);
  await copyTree(w.t, other);
  await drainScheduled(w.t);
  // The console reaches Tex's objects only once the workspaces are laid (the copy passes would otherwise use the door).
  vi.stubEnv("STORAGE_MOVER_ORIGIN", GATEWAY);
  vi.stubEnv("GATEWAY_SECRET", TEST_GATEWAY_SECRET);

  const guestChat = async (key: string, words: string): Promise<Id<"textGroups">> =>
    await w.t.run(async (ctx) => {
      const groupId = await ctx.db.insert("workspaceGroups", { workspaceId: acme, name: `acme-${words}`, createdBy: ada, createdAt: 1 });
      const chatId = await ctx.db.insert("textGroups", {
        groupKey: key,
        workspaceId: acme,
        boundBy: ada,
        guestGroupId: groupId,
        guestFolder: `tex/chats/${words}`,
        guestToken: "chat-token-test",
        lastSeenAt: 1,
      });
      await ctx.db.insert("workspaceGroupMembers", { groupId, workspaceId: acme, userId: bo, addedBy: ada, addedAt: 1, viaChat: chatId });
      await syncChatPhones(ctx as unknown as MutationCtx, (await ctx.db.get(chatId))!, ["+15555550188"]);
      return chatId;
    });
  const chatA = await guestChat(KEY_A, WORDS_A);
  const chatB = await guestChat(KEY_B, WORDS_B);
  return { ...w, ada, bo, acme, other, source, objects, chatA, chatB };
}

/** The guest-mode fields a chat row still carries. */
const guestFieldsOf = (chat: Doc<"textGroups"> | null) =>
  (["guestGroupId", "guestFolder", "guestToken", "guestFolderGranted", "guestFolderUsers"] as const).filter((field) => chat?.[field] !== undefined);

const run = (w: World, dryRun: boolean) => w.t.action(internal.functions.texGuestRetire.run, { dryRun });
const chatRow = (w: World, id: Id<"textGroups">) => w.t.run((ctx) => ctx.db.get(id));
const movesOf = (w: World) => w.t.run((ctx) => ctx.db.query("contextMoves").collect());

/** What the chat's object holds, as note keys. */
const keptFor = (w: World, key: string) => (w.objects.get(`chat:${key}`)?.list({}).objects ?? []).map((object) => object.key);

/** A move row as the marker would make it, with the ends chosen by the test. */
async function markedMove(
  w: World,
  ends: { chat: Id<"textGroups">; source?: Id<"workspaces">; from: string; destination?: Id<"workspaces">; to: string },
) {
  const moveId = await w.t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("contextMoves", {
      sourceWorkspaceId: ends.source ?? w.acme,
      destinationWorkspaceId: ends.destination ?? w.pinned,
      actorUserId: w.ada,
      from: ends.from,
      to: ends.to,
      status: "moving",
      movedObjects: 0,
      movedBytes: 0,
      skipped: [],
      chatHome: { groupId: ends.chat },
      createdAt: now,
      updatedAt: now,
    });
  });
  await w.t.action(internal.functions.contextMoves.advanceContextMove, { moveId, passesLeft: 10 });
  await drainScheduled(w.t);
  return (await w.t.run((ctx) => ctx.db.get(moveId)))!;
}

/** Make a home for a chat, as its tag would. */
async function homeFor(w: World, chatId: Id<"textGroups">, people: Id<"users">[]): Promise<string> {
  const folder = await w.t.run(async (ctx) => await ensureChatHome(ctx as unknown as MutationCtx, (await ctx.db.get(chatId))!, people, w.ada));
  if (folder === null) throw new Error("no home was made");
  return folder;
}

describe("a dry run", () => {
  test("writes nothing, and counts what a real run would do", async () => {
    const w = await world();
    const before = { a: await chatRow(w, w.chatA), moves: await movesOf(w) };
    const answer = await run(w, true);
    expect(answer).toMatchObject({ chats: 2, wouldMove: 2, started: 0, moving: 0, done: 0, refused: {}, finished: true });
    await drainScheduled(w.t);
    expect(await movesOf(w)).toEqual(before.moves);
    expect(await chatRow(w, w.chatA)).toEqual(before.a);
    expect((await chatRow(w, w.chatA))?.homeWords).toBeUndefined();
    expect(await liveFilesUnder(w.t, w.acme, FOLDER_A)).toHaveLength(3);
    expect(await liveFilesUnder(w.t, w.pinned, "tex/groups/")).toEqual([]);
    expect([...w.objects.keys()]).toEqual([]);
  });
});

describe("a real run", () => {
  test("moves the folder into the chat's home, sealed, into the chat's own object, and clears the chat's guest mode", async () => {
    const w = await world();
    expect(await run(w, false)).toMatchObject({ chats: 2, started: 2, refused: {}, finished: true });
    await drainScheduled(w.t);

    const chat = (await chatRow(w, w.chatA))!;
    // Chat A's own folder, whole: three notes, and the sub-folder's.
    const words = chat.homeWords!;
    expect(words).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    const moved = await liveFilesUnder(w.t, w.pinned, `tex/groups/${words}/`);
    expect(moved.map((row) => row.path.slice(`tex/groups/${words}/`.length)).sort()).toEqual(["flights.md", "hotels.md", "sub/notes.md"]);
    // Kept in the chat's Durable Object under its key, and in no bucket.
    for (const row of moved) expect(row.storageKey).toMatch(new RegExp(`^tex/chat:${KEY_A}/`));
    expect(keptFor(w, KEY_A)).toHaveLength(3);
    const bodies = keptFor(w, KEY_A).map((key) => new TextDecoder().decode((w.objects.get(`chat:${KEY_A}`)!.get(key) as unknown as { body: Uint8Array }).body));
    expect(bodies.join("")).toContain(MARKER);
    expect(JSON.stringify([...w.backend.objects.keys()])).not.toContain("tex/groups");
    // Gone from the source, which keeps its neighbour; the other chat's folder is its own move.
    expect(await liveFilesUnder(w.t, w.acme, `${FOLDER_A}/`)).toEqual([]);
    expect(await liveFileAt(w.t, w.acme, "1-projects/neighbour.md")).not.toBeNull();
    expect(await liveFilesUnder(w.t, w.pinned, "tex/chats/")).toEqual([]);
    // The chat's guest mode is cleared: fields, the members the chat put in its group, and its numbers.
    expect(guestFieldsOf(chat)).toEqual([]);
    expect(await w.t.run((ctx) => ctx.db.query("workspaceGroupMembers").collect())).toEqual([]);
    expect(await w.t.run((ctx) => ctx.db.query("chatGuestPhones").collect())).toEqual([]);
    expect((await movesOf(w)).map((row) => row.status)).toEqual(["complete", "complete"]);
    // Chat B's notes went to chat B's object, not to A's.
    expect(keptFor(w, KEY_B)).toHaveLength(1);
  });

  test("the people named on the home read what moved, and nobody who runs the pin does", async () => {
    const w = await world();
    await run(w, false);
    await drainScheduled(w.t);
    const words = (await chatRow(w, w.chatA))!.homeWords!;
    const paths = ["flights.md", "hotels.md", "sub/notes.md"].map((name) => `tex/groups/${words}/${name}`);
    // The binder is named on the home when the move has to make it.
    const named = await w.t.run(async (ctx) => await visibleGrantedPaths(ctx, { userId: w.ada, workspaceId: w.pinned, paths }));
    expect(named.sort()).toEqual([...paths].sort());
    // Not another member of the pin, not an owner of it, not the editor of the source who is not named.
    for (const userId of [w.mel, w.sayo, w.staff, w.bo]) {
      const { scope, grantedNames } = await clearanceOf(w, userId);
      expect(await visibleTo(w, scope, grantedNames), String(userId)).not.toEqual(expect.arrayContaining(paths));
      const seen = await w.t.action(internal.functions.files.runFileOperation, { workspaceId: w.pinned, scope, ...(grantedNames === undefined ? {} : { grantedNames }), operation: { kind: "visiblePaths", paths } });
      expect(seen.kind === "visiblePaths" ? seen.paths : null, String(userId)).toEqual([]);
    }
  });

  test("an arrival's row is sealed under the home, never opened to the pin's team", async () => {
    const w = await world();
    await run(w, false);
    await drainScheduled(w.t);
    const words = (await chatRow(w, w.chatA))!.homeWords!;
    const row = await liveFileAt(w.t, w.pinned, `tex/groups/${words}/flights.md`);
    expect(row).not.toBeNull();
    const grants = await w.t.run((ctx) => ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", row!._id)).collect());
    expect(grants.filter((grant) => grant.granteeKind !== "user")).toEqual([]);
  });

  test("running it again is safe: a chat with a move under way is left to it, and a finished one is not found", async () => {
    const w = await world();
    expect(await run(w, false)).toMatchObject({ started: 2 });
    // Before the moves ran: the same chats are moving, and no second move is opened for them.
    expect(await run(w, false)).toMatchObject({ chats: 2, started: 0, moving: 2 });
    expect(await movesOf(w)).toHaveLength(2);
    await drainScheduled(w.t);
    expect(await run(w, false)).toMatchObject({ chats: 0, started: 0, moving: 0, done: 0, wouldMove: 0 });
    expect(await movesOf(w)).toHaveLength(2);
    expect(keptFor(w, KEY_A)).toHaveLength(3);
    expect(await liveFilesUnder(w.t, w.pinned, "tex/groups/")).toHaveLength(4);
  });

  test("a chat whose folder holds nothing is cleared at once, with no move and no home", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.chatB, { guestFolder: "tex/chats/nothing-here-at-all" });
    });
    expect(await run(w, false)).toMatchObject({ chats: 2, started: 1, done: 1 });
    expect(guestFieldsOf(await chatRow(w, w.chatB))).toEqual([]);
    expect((await chatRow(w, w.chatB))?.homeWords).toBeUndefined();
    expect(await movesOf(w)).toHaveLength(1);
  });

  test("a move that failed is started again where it stopped, on the same row", async () => {
    const w = await world();
    await run(w, false);
    const [first] = await movesOf(w);
    await w.t.run(async (ctx) => {
      for (const row of await ctx.db.query("contextMoves").collect()) await ctx.db.patch(row._id, { status: "failed", error: "stopped" });
    });
    expect(await run(w, true)).toMatchObject({ chats: 2, wouldMove: 2 });
    expect(await run(w, false)).toMatchObject({ chats: 2, started: 2 });
    await drainScheduled(w.t);
    const rows = await movesOf(w);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row._id === first._id)?.status).toBe("complete");
    expect(await liveFilesUnder(w.t, w.pinned, "tex/groups/")).toHaveLength(4);
    expect(guestFieldsOf(await chatRow(w, w.chatA))).toEqual([]);
  });
});

describe("the marker moves one chat's folder into that chat's home, and nothing else", () => {
  async function ready() {
    const w = await world();
    const homeA = await homeFor(w, w.chatA, [w.ada]);
    return { w, homeA };
  }

  test("the chat's own folder into its own home goes through", async () => {
    const { w, homeA } = await ready();
    const row = await markedMove(w, { chat: w.chatA, from: FOLDER_A, to: homeA });
    expect([row.status, row.error]).toEqual(["complete", undefined]);
    expect(row.movedObjects).toBe(3);
  });

  test("another path is refused, and nothing is carried", async () => {
    const { w, homeA } = await ready();
    const row = await markedMove(w, { chat: w.chatA, from: "1-projects", to: homeA });
    expect(row.status).toBe("failed");
    expect(row.movedObjects).toBe(0);
    expect(await liveFileAt(w.t, w.acme, "1-projects/neighbour.md")).not.toBeNull();
    expect(await liveFilesUnder(w.t, w.pinned, `${homeA}/`)).toEqual([]);
  });

  test("another chat's folder is refused, and stays where it is", async () => {
    const { w, homeA } = await ready();
    const row = await markedMove(w, { chat: w.chatA, from: FOLDER_B, to: homeA });
    expect(row.status).toBe("failed");
    expect(await liveFilesUnder(w.t, w.acme, `${FOLDER_B}/`)).toHaveLength(1);
    expect(await liveFilesUnder(w.t, w.pinned, `${homeA}/`)).toEqual([]);
  });

  test("another chat's home is refused, and holds nothing of this chat's", async () => {
    const { w } = await ready();
    const homeB = await homeFor(w, w.chatB, [w.ada]);
    const row = await markedMove(w, { chat: w.chatA, from: FOLDER_A, to: homeB });
    expect(row.status).toBe("failed");
    expect(await liveFilesUnder(w.t, w.pinned, `${homeB}/`)).toEqual([]);
    expect(await liveFilesUnder(w.t, w.acme, `${FOLDER_A}/`)).toHaveLength(3);
  });

  test("a workspace that is not the pin is refused as the destination, even at the home's own path", async () => {
    const { w, homeA } = await ready();
    const row = await markedMove(w, { chat: w.chatA, from: FOLDER_A, destination: w.other, to: homeA });
    expect(row.status).toBe("failed");
    expect(await liveFilesUnder(w.t, w.other, "tex/groups/")).toEqual([]);
    expect(await liveFilesUnder(w.t, w.acme, `${FOLDER_A}/`)).toHaveLength(3);
  });

  test("another workspace's folder is refused as the source, even at the guest folder's own path", async () => {
    const { w, homeA } = await ready();
    const row = await markedMove(w, { chat: w.chatA, source: w.other, from: FOLDER_A, to: homeA });
    expect(row.status).toBe("failed");
    expect(await liveFilesUnder(w.t, w.pinned, `${homeA}/`)).toEqual([]);
    expect(await liveFileAt(w.t, w.other, `${FOLDER_A}/decoy.md`)).not.toBeNull();
  });

  test("a chat with no guest folder, or that was never a chat, can move nothing", async () => {
    const { w, homeA } = await ready();
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.chatA, { guestFolder: undefined });
    });
    const row = await markedMove(w, { chat: w.chatA, from: FOLDER_A, to: homeA });
    expect(row.status).toBe("failed");
    expect(await liveFilesUnder(w.t, w.pinned, `${homeA}/`)).toEqual([]);
  });
});

describe("nothing outside the system can set the marker", () => {
  test("a person's own startContextMove cannot move into a home, whatever their roles", async () => {
    const w = await world();
    const homeA = await homeFor(w, w.chatA, [w.ada]);
    // Ada owns the source and is made an editor of the pin: every role the console asks for.
    await addMember(w.t, w.pinned, w.ada, "editor", w.staff);
    const { moveId } = await asUser(w.t, w.ada).action(api.functions.contextMoves.startContextMove, {
      sourceWorkspaceId: w.acme,
      from: FOLDER_A,
      destinationWorkspaceId: w.pinned,
      to: homeA,
    });
    await drainScheduled(w.t);
    const row = await w.t.run((ctx) => ctx.db.get(moveId));
    expect(row?.status).toBe("failed");
    expect(row?.chatHome).toBeUndefined();
    expect(await liveFilesUnder(w.t, w.pinned, `${homeA}/`)).toEqual([]);
    expect(await liveFilesUnder(w.t, w.acme, `${FOLDER_A}/`)).toHaveLength(3);
  });

  test("the console's and the gateway's way of opening a move takes no marker", async () => {
    const w = await world();
    await expect(
      w.t.mutation(internal.functions.contextMoves.openMove, {
        sourceWorkspaceId: w.acme,
        destinationWorkspaceId: w.other,
        actorUserId: w.ada,
        from: FOLDER_A,
        to: "somewhere",
        chatHome: { groupId: w.chatA },
      } as never),
    ).rejects.toThrow();
    expect(await movesOf(w)).toEqual([]);
  });

  test("a person cannot resume a chat's failed move", async () => {
    const w = await world();
    const homeA = await homeFor(w, w.chatA, [w.ada]);
    // Every role the console asks for is held, so only the marker stands in the way.
    await addMember(w.t, w.pinned, w.ada, "editor", w.staff);
    const row = await markedMove(w, { chat: w.chatA, from: "1-projects", to: homeA });
    expect(row.status).toBe("failed");
    await expect(
      asUser(w.t, w.ada).action(api.functions.contextMoves.resumeContextMove, { moveId: row._id }),
    ).rejects.toThrow();
    expect((await w.t.run((ctx) => ctx.db.get(row._id)))?.status).toBe("failed");
  });
});
