/**
 * Download messages (`src/core/messages/download.ts`): the backup read back
 * from the bucket and written out, over fakes. Never a process or a network.
 *
 * ## Sabotage record
 *
 * Run as temporary edits and reverted (2026-10-26):
 *
 *   writing a log object a key outside the log names             2
 *   copying the files of a message taken back by an unsend       1
 *   a page that does not move read as the end                    1
 *   the token put in the URL                                     1
 *   insideFolder allowing a path outside the folder              1
 */

import { digestId } from "../src/core/messages/files.ts";

const LOG = ".context/messages/imessage/log/";
import { readBackupFile, readBackupLogPage, runMessagesDownload } from "../src/core/messages/download.ts";
import { createMessagesDownloader, freshFolder, insideFolder } from "../src/main/messagesDownload.ts";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PIC = "0123456789abcdef0123456789abcdef";
const GONE = "fedcba9876543210fedcba9876543210";
const line = (id, extra = {}) =>
  JSON.stringify({ v: 1, kind: "message", id, chat: "chat-ada", at: "2026-10-21T09:00:00.000Z", me: false, from: "+15550100", text: `words of ${id}`, service: "iMessage", ...extra });

function world(pages, files) {
  const written = new Map();
  const asked = [];
  return {
    written,
    asked,
    deps: {
      async readLogPage(after) {
        asked.push(after);
        return pages[after ?? "start"];
      },
      async readFile(folder, id) {
        return files.get(`${folder}/${id}`) ?? { missing: true };
      },
      async write(path, data) {
        written.set(path, data);
      },
    },
  };
}

export async function runMessagesDownloadChecks(check) {
  const pages = {
    start: {
      ok: true,
      objects: [{ key: `${LOG}chats/0001-aa.jsonl`, text: `${JSON.stringify({ v: 1, kind: "chat", id: "chat-ada", name: "Ada", members: [] })}\n` }],
      next: "a",
    },
    a: {
      ok: true,
      objects: [
        { key: `${LOG}2026/10/0002-aa.jsonl`, text: `${line("m-1", { text: "first" })}\n${line("m-3", { files: [{ id: PIC, name: "IMG_3.HEIC" }] })}\n` },
        { key: `${LOG}2026/10/0003-aa.jsonl`, text: `${line("m-1", { text: "Dinner at 5" })}\n${line("m-2", { text: "", files: [{ id: PIC, name: "IMG_1.HEIC" }, { id: GONE, name: "IMG_2.HEIC" }] })}\n${line("m-3", { unsent: true, text: "" })}\n` },
        { key: ".context/messages/imessage/reads/../../../x", text: "not a log object" },
      ],
      next: null,
    },
  };
  const files = new Map([
    [`${digestId("m-2")}/${PIC}`, { ok: true, bytes: new TextEncoder().encode("picture bytes") }],
    [`${digestId("m-3")}/${PIC}`, { ok: true, bytes: new TextEncoder().encode("unsent picture") }],
  ]);
  const w = world(pages, files);
  const result = await runMessagesDownload(w.deps);
  check("download: every page of the log is read", w.asked.length === 2 && w.asked[1] === "a");
  check(
    "download: each log object is written as it is kept, at its own path",
    result.ok && result.transcripts === 3 && w.written.get("log/2026/10/0003-aa.jsonl") === pages.a.objects[1].text && w.written.has("log/chats/0001-aa.jsonl"),
  );
  check("download: a key outside the log is never written", ![...w.written.keys()].some((path) => !path.startsWith("log/") && !path.startsWith("files/")));
  check("download: a file the bucket holds lands at its own path", new TextDecoder().decode(w.written.get(`files/${digestId("m-2")}/${PIC}`) ?? new Uint8Array()) === "picture bytes" && result.pictures === 1);
  check("download: one it does not hold is counted, not written", result.notCopied === 1 && !w.written.has(`files/${digestId("m-2")}/${GONE}`));
  check("download: a message taken back by an unsend has no files to copy", !w.written.has(`files/${digestId("m-3")}/${PIC}`));
  check("download: conversations are counted", result.conversations === 1);

  const failing = world({ start: { ok: true, objects: [{ key: `${LOG}2026/10/0001-aa.jsonl`, text: `${line("m-1")}\n` }], next: "a" }, a: { ok: false, retry: true, code: "offline" } }, new Map());
  const failed = await runMessagesDownload(failing.deps);
  check("download: a log that could not be read to its end writes nothing", !failed.ok && failed.code === "offline" && failing.written.size === 0);
  const stuck = world({ start: { ok: true, objects: [], next: "a" }, a: { ok: true, objects: [], next: "a" } }, new Map());
  const stuckResult = await runMessagesDownload(stuck.deps);
  check("download: a page that does not move is a failure, not the end", !stuckResult.ok && stuck.written.size === 0);
  const refusedFile = world(pages, new Map([[`${digestId("m-2")}/${PIC}`, { ok: false, retry: false, code: "reconnect" }]]));
  const refused = await runMessagesDownload(refusedFile.deps);
  check("download: a refused file stops the download with its code", !refused.ok && refused.code === "reconnect");
  let wantedCalls = 0;
  const cancelled = await runMessagesDownload({ ...world(pages, files).deps, stillWanted: () => (wantedCalls += 1) < 2 });
  check("download: cancelling stops it", !cancelled.ok && cancelled.code === "cancelled");

  // The reads: the credential in a header only, and a closed set of codes.
  const seen = [];
  const config = (answer) => ({
    baseUrl: "https://gateway.example.test",
    token: async () => "cat_fake_token",
    fetch: async (url, init) => {
      seen.push({ url, init });
      return answer();
    },
  });
  const page = await readBackupLogPage(config(() => new Response(JSON.stringify({ ok: true, objects: [{ key: "k", text: "t" }], next: null }))), "after key");
  check("download: a log page is read with the token in a header, never the URL", page.ok && seen[0].init.headers.authorization === "Bearer cat_fake_token" && !seen[0].url.includes("cat_fake_token") && seen[0].url.endsWith("/messages/imessage/log?after=after%20key"));
  const portal = await readBackupLogPage(config(() => new Response("<html>sign in</html>", { status: 200 })), undefined);
  check("download: a page that is not the contract's JSON is not read as one", !portal.ok && portal.retry === true);
  const missing = await readBackupFile(config(() => new Response("{}", { status: 404 })), digestId("m-2"), PIC);
  check("download: a file the bucket does not hold is missing, not a failure", "missing" in missing);
  const forbidden = await readBackupFile(config(() => new Response("{}", { status: 403 })), digestId("m-2"), PIC);
  check("download: a refusal reports only its code", !forbidden.ok && forbidden.code === "not_allowed");

  // On disk: a new folder every time, nothing written outside it, and counts only back.
  const downloads = await mkdtemp(join(tmpdir(), "context-download-"));
  try {
    const first = await freshFolder(downloads, "Messages backup 2026-10-26");
    const second = await freshFolder(downloads, "Messages backup 2026-10-26");
    check("download: a second download never shares the first one's folder", first !== second && second.endsWith("Messages backup 2026-10-26 2"));
    check("download: a path that climbs out of the folder is refused", insideFolder(first, "../x") === null && insideFolder(first, "/etc/x") === null && insideFolder(first, "log/2026/10/x.jsonl") !== null);

    const logBody = JSON.stringify({ ok: true, objects: [{ key: `${LOG}2026/10/0001-aa.jsonl`, text: `${line("m-2", { text: "hello", files: [{ id: PIC, name: "IMG_1.HEIC" }] })}\n` }], next: null });
    const revealed = [];
    const download = createMessagesDownloader({
      connection: { baseUrl: () => "https://gateway.example.test", token: async () => "cat_fake_token" },
      downloadsDir: () => downloads,
      reveal: (folder) => revealed.push(folder),
      now: () => Date.parse("2026-10-27T12:00:00Z"),
      fetch: async (url) => (String(url).includes("/log") ? new Response(logBody) : new Response("picture bytes")),
    });
    const done = await download();
    const folder = join(downloads, "Messages backup 2026-10-27");
    const log = await readFile(join(folder, "log", "2026", "10", "0001-aa.jsonl"), "utf8").catch(() => "");
    const picture = await readFile(join(folder, "files", digestId("m-2"), PIC), "utf8").catch(() => "");
    check("download: the log and its picture land as kept in a new folder in Downloads, which is shown", log.includes("hello") && picture === "picture bytes" && revealed[0] === folder);
    check("download: the console is told counts, not where", done.ok && done.pictures === 1 && !JSON.stringify(done).includes(downloads));
    const offline = await createMessagesDownloader({
      connection: { baseUrl: () => "https://gateway.example.test", token: async () => "cat_fake_token" },
      downloadsDir: () => downloads,
      reveal: () => {},
      now: () => Date.parse("2026-10-28T12:00:00Z"),
      fetch: async () => {
        throw new Error("offline");
      },
    })();
    check("download: one that fails before the first write leaves no folder behind", !offline.ok && offline.problem === "offline" && !(await readdir(downloads)).some((name) => name.includes("2026-10-28")));
  } finally {
    await rm(downloads, { recursive: true, force: true });
  }
}
