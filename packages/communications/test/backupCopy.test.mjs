// A copy of the Messages backup is the backup as kept: log objects at their
// own paths, and the fold that says which files the live messages hold.
//
// SABOTAGE RECORD — applied to src/backupLog.js, suite re-run, reverted:
//
//   copyPathOf taking any key under the backup              -> 1 check failed
//   copyPathOf allowing ".." as a segment                    -> 1 check failed
//   foldRecords keeping the first record, not the last       -> 1 check failed

import { BACKUP_PREFIX } from "../src/backup.js";
import { BACKUP_LOG_PREFIX, copyPathOf, foldRecords } from "../src/backupLog.js";

export function runBackupCopyChecks(check) {
  check("copy: a log object keeps its own path under the backup", copyPathOf(`${BACKUP_LOG_PREFIX}2026/10/1760000000000-aa.jsonl`) === "log/2026/10/1760000000000-aa.jsonl");
  check("copy: chats and people keep theirs", copyPathOf(`${BACKUP_LOG_PREFIX}chats/1760000000000-aa.jsonl`) === "log/chats/1760000000000-aa.jsonl");
  check(
    "copy: nothing outside the log is copied as a log object",
    [`${BACKUP_PREFIX}files/a/b`, `${BACKUP_PREFIX}reads/2026/10/x.json`, "notes/x.md", null, 7].every((key) => copyPathOf(key) === null),
  );
  check(
    "copy: no key that could climb out of the folder or hide is copied",
    [`${BACKUP_LOG_PREFIX}../../x`, `${BACKUP_LOG_PREFIX}2026//x`, `${BACKUP_LOG_PREFIX}.hidden`, `${BACKUP_LOG_PREFIX}a\\b`, `${BACKUP_LOG_PREFIX}a b`].every((key) => copyPathOf(key) === null),
  );

  const message = (id, extra = {}) => ({ v: 1, kind: "message", id, chat: "chat-ada", at: "2026-10-21T09:00:00.000Z", me: true, text: id, service: "iMessage", ...extra });
  const fold = foldRecords([
    message("m-1", { files: [{ id: "a".repeat(32), name: "IMG_1.HEIC" }] }),
    message("m-1", { unsent: true, text: "" }),
    message("m-2", { chat: "chat-trip" }),
    { v: 1, kind: "chat", id: "chat-ada", members: [] },
  ]);
  check("copy: the later record wins, so an unsent message holds no files", fold.messages.find((m) => m.id === "m-1")?.unsent === true && !fold.messages.some((m) => m.files));
  check("copy: conversations are counted from the messages", fold.chats.size === 2);
}
