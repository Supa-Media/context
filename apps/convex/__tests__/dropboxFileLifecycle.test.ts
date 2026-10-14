/** Real authorized file actions and DropboxStore; only the HTTP socket is fake. */
import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { asUser, captureError, copyTree, errorCode } from "./fixtures.helpers";
import { fixture, share, type Fixture } from "./files/fixtures.helpers";

/**
 * Dropbox has directories, rather than object-store prefixes. In particular,
 * list_folder('/Context/note.md') answers path/not_folder for a real file.
 * Keep that distinction at the HTTP boundary so this catches adapter defects.
 */
function dropboxHttp(initial: Record<string, string>) {
  let version = 1;
  const files = new Map(Object.entries(initial).map(([path, text]) => [path, { text, rev: `rev${version++}` }]));
  const probes: string[] = [];
  const mutations: string[] = [];
  const keyOf = (path: string) => path.replace(/^\/Context\/?/, "").replace(/\/$/, "");
  const fail = (tag: string, status = 409) => {
    const parts = tag.split("/");
    let error: Record<string, unknown> = { ".tag": parts.at(-1) };
    for (let i = parts.length - 2; i >= 0; i -= 1) error = { ".tag": parts[i], [parts[i]!]: error };
    return Response.json({ error_summary: `${tag}/`, error }, { status });
  };
  const metadata = (key: string) => ({
    ".tag": "file", path_display: `/Context/${key}`, path_lower: `/context/${key.toLowerCase()}`,
    name: key.split("/").at(-1), rev: files.get(key)!.rev, size: files.get(key)!.text.length,
    server_modified: "2026-10-12T12:00:00Z",
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = new URL(String(input)).pathname;
    const arg = endpoint.endsWith("download") || endpoint.endsWith("upload")
      ? JSON.parse(new Headers(init?.headers).get("Dropbox-API-Arg") ?? "{}")
      : JSON.parse(String(init?.body ?? "{}"));
    const path = keyOf(String(arg.path ?? ""));
    if (endpoint === "/2/files/list_folder") {
      probes.push(path);
      if (files.has(path)) return fail("path/not_folder");
      const prefix = path === "" ? "" : `${path}/`;
      const below = [...files.keys()].filter(key => key.startsWith(prefix));
      if (path !== "" && below.length === 0) return fail("path/not_found");
      const entries: Record<string, unknown>[] = [];
      const folders = new Set<string>();
      for (const key of below) {
        const tail = key.slice(prefix.length);
        if (arg.recursive || !tail.includes("/")) entries.push(metadata(key));
        const pieces = tail.split("/");
        for (let n = 1; n < pieces.length; n += 1) {
          if (!arg.recursive && n > 1) break;
          folders.add(`${prefix}${pieces.slice(0, n).join("/")}`);
        }
      }
      for (const folder of folders) entries.push({ ".tag": "folder", path_display: `/Context/${folder}`, path_lower: `/context/${folder.toLowerCase()}` });
      return Response.json({ entries, has_more: false, cursor: "finished" });
    }
    if (endpoint === "/2/files/get_metadata") {
      if (files.has(path)) return Response.json(metadata(path));
      if ([...files.keys()].some(key => key.startsWith(`${path}/`))) return Response.json({ ".tag": "folder" });
      return fail("path/not_found");
    }
    if (endpoint === "/2/files/download") {
      if (!files.has(path)) return fail("path/not_found");
      return new Response(files.get(path)!.text, { headers: { "Dropbox-API-Result": JSON.stringify(metadata(path)) } });
    }
    if (endpoint === "/2/files/upload") {
      const existing = files.get(path);
      if ((arg.mode?.[".tag"] === "add" && existing) ||
        (arg.mode?.[".tag"] === "update" && existing?.rev !== arg.mode.update)) return fail("path/conflict/file");
      const text = await new Response(init?.body).text();
      files.set(path, { text, rev: `rev${version++}` });
      mutations.push(`upload ${path}`);
      return Response.json(metadata(path));
    }
    if (endpoint === "/2/files/delete_v2") {
      if (!files.has(path)) return fail("path/not_found");
      const entry = metadata(path);
      files.delete(path); mutations.push(`delete ${path}`);
      return Response.json({ metadata: entry });
    }
    throw new Error(`Unexpected Dropbox test endpoint: ${endpoint}`);
  });
  return { files, probes, mutations };
}

async function scenario() {
  const f = await fixture();
  const http = dropboxHttp(f.backend.snapshot());
  const sealed = (text: string) => encryptSecret(text, requireKeyset(), { workspaceId: f.workspaceId });
  const refresh = await sealed("fake-refresh");
  const access = await sealed("fake-access");
  await f.t.run(async ctx => {
    const binding = await ctx.db.query("storageBindings").withIndex("by_workspace", q => q.eq("workspaceId", f.workspaceId)).unique();
    await ctx.db.patch(binding!._id, {
      provider: "dropbox", rootPrefix: "Context/", encryptedRefreshToken: refresh,
      encryptedAccessToken: access, accessTokenExpiresAt: Date.now() + 3_600_000,
      dropboxAccountId: "dbid:TEST", capabilities: { conditionalWrite: true, conditionalCreate: true },
    });
    // A Dropbox tree as an earlier sweep left it: marked unsupported, because
    // Dropbox ignores key order. The sweep now pages it by its own token
    // (`lib/nodes/sweep.ts`), so the copy below fills it and every write's
    // name check has a tree to ask.
    const tree = await ctx.db.query("nodeTrees").withIndex("by_workspace", q => q.eq("workspaceId", f.workspaceId)).unique();
    if (tree) await ctx.db.patch(tree._id, { status: "unsupported" });
  });
  await copyTree(f.t, f.workspaceId);
  return { ...f, http };
}

type Operation = "move" | "duplicate" | "trash";
function perform(f: Fixture, user: Id<"users">, operation: Operation, path: string) {
  const as = asUser(f.t, user);
  if (operation === "move") return as.action(api.functions.files.moveEntry, { workspaceId: f.workspaceId, from: path, to: "1-projects/renamed.md" });
  if (operation === "duplicate") return as.action(api.functions.files.duplicateEntry, { workspaceId: f.workspaceId, path });
  return as.action(api.functions.files.trashEntry, { workspaceId: f.workspaceId, path });
}

const operations: Operation[] = ["move", "duplicate", "trash"];
describe("Dropbox file lifecycle through authorized actions", () => {
  test.each(operations)("%s handles an existing file despite Dropbox's not_folder probe response", async operation => {
    const f = await scenario();
    const path = "1-projects/shared.md";
    const original = f.http.files.get(path)!.text;
    const result = await perform(f, f.owner, operation, path);
    expect(f.http.probes).toContain(path);
    expect(f.http.files.get(result.to)?.text).toBe(original);
    // Dropbox has no conditional delete, so the store's logical-delete view
    // can retain backing bytes. Assert the user-facing source is gone.
    if (operation === "duplicate") {
      const source = await asUser(f.t, f.owner).action(api.functions.files.readNote, { workspaceId: f.workspaceId, path });
      expect(source.text).toBe(original);
    } else if (operation === "move") {
      const source = await asUser(f.t, f.owner).action(api.functions.files.readNote, { workspaceId: f.workspaceId, path });
      expect(source.path).toBe(result.to); // Old links follow the move's forwarding record.
      // The folder is listed from the tree the token sweep filled, never the bucket.
      const listing = await asUser(f.t, f.owner).action(api.functions.files.listFiles, { workspaceId: f.workspaceId, path: "1-projects" });
      const paths = (listing as { entries: { path: string }[] }).entries.map((entry) => entry.path);
      expect(paths).toContain(result.to);
      expect(paths).not.toContain(path);
    } else {
      const error = await captureError(() => asUser(f.t, f.owner).action(api.functions.files.readNote, { workspaceId: f.workspaceId, path }));
      expect(errorCode(error)).toBe("FILE_NOT_FOUND");
    }
    await f.t.finishInProgressScheduledFunctions();
    if (operation === "trash") expect(result.to).toMatch(/^\.context\/trash\//);
  });

  test.each(operations)("%s still refuses read-only members before any provider mutation", async operation => {
    const f = await scenario();
    await share(f);
    f.http.mutations.length = 0;
    const before = [...f.http.files];
    const error = await captureError(() => perform(f, f.reader, operation, "1-projects/shared.md"));
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(f.http.mutations).toEqual([]);
    expect([...f.http.files]).toEqual(before);
    await f.t.finishInProgressScheduledFunctions();
  });

  test.each(operations)("%s gives editors identical errors for private and absent files", async operation => {
    const f = await scenario();
    const before = [...f.http.files];
    const hidden = await captureError(() => perform(f, f.editor, operation, "2-areas/private-note.md"));
    const absent = await captureError(() => perform(f, f.editor, operation, "2-areas/absent.md"));
    expect(errorCode(hidden)).toBe("FILE_NOT_FOUND");
    expect((hidden as { data: unknown }).data).toEqual((absent as { data: unknown }).data);
    expect(f.http.mutations).toEqual([]);
    expect([...f.http.files]).toEqual(before);
    await f.t.finishInProgressScheduledFunctions();
  });
});
