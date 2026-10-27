// The Messages backup contract: what the gateway keeps from a batch the Mac sends.
//
// SABOTAGE RECORD — applied to src/backup.js, suite re-run, reverted:
//
//   keep unknown fields (spread raw into the record)       -> 3 checks failed
//   keep `from` on a record the person sent (me: true)     -> 1 check failed
//   keep text on an unsent message                          -> 1 check failed
//   drop the bidi strip from names                          -> 1 check failed
//   accept a batch over LIMITS.records                      -> 1 check failed
//   keep a file id that is not 32 hex characters            -> 1 check failed
//   parseFileRoute accepting a third path segment           -> 1 check failed
//   isVideoFile reading the type only                       -> 1 check failed

import { createHash } from "node:crypto";
import {
  BACKUP_PREFIX,
  BACKUP_VERSION,
  LIMITS,
  MESSAGES_BACKUP_FILE_ROUTE,
  MESSAGES_BACKUP_ROUTE,
  digestId,
  fileKeyOf,
  filesFolderKeyOf,
  isVideoFile,
  monthOf,
  parseFileRoute,
  normalizeBackupRecord,
  readBackupBatch,
  recordKey,
} from "../src/backup.js";

const message = (extra = {}) => ({
  v: 1,
  kind: "message",
  id: "AAAA-1111",
  chat: "iMessage;-;+15550100",
  at: "2026-10-21T19:12:00.000Z",
  me: false,
  from: "+15550100",
  text: "Dinner at 4. Can you bring the rice?",
  service: "iMessage",
  ...extra,
});

export async function runBackupChecks(check) {
  check("backup: the prefix is hidden plumbing under .context/", BACKUP_PREFIX.startsWith(".context/") && BACKUP_PREFIX.endsWith("/"));
  check("backup: the route has no selector or token in it", MESSAGES_BACKUP_ROUTE === "/messages/imessage/batch");

  const kept = normalizeBackupRecord(message({ smuggled: "x", workspaceId: "w1" }));
  check("backup: a message is kept with its words", kept?.text === "Dinner at 4. Can you bring the rice?" && kept.from === "+15550100");
  check("backup: fields the contract does not name are dropped", kept !== null && !("smuggled" in kept) && !("workspaceId" in kept));
  check("backup: version and kind are stamped", kept?.v === BACKUP_VERSION && kept.kind === "message");

  const mine = normalizeBackupRecord(message({ me: true, from: "+15550199" }));
  check("backup: a text the person sent carries no sender", mine?.me === true && !("from" in mine));

  const unsent = normalizeBackupRecord(message({ unsent: true, files: [{ name: "a.jpg", type: "image/jpeg", bytes: 10 }] }));
  check("backup: an unsent message keeps no words and no files", unsent?.unsent === true && unsent.text === "" && !("files" in unsent));

  const long = normalizeBackupRecord(message({ text: "x".repeat(LIMITS.text + 5) }));
  check("backup: a long text is cut and says so", long?.text.length === LIMITS.text && long.cut === true);

  check("backup: a record with no id is refused", normalizeBackupRecord(message({ id: "" })) === null);
  check("backup: a record with a bad date is refused", normalizeBackupRecord(message({ at: "yesterday" })) === null);
  check("backup: an unknown version is refused", normalizeBackupRecord(message({ v: 2 })) === null);
  check("backup: an unknown kind is refused", normalizeBackupRecord({ v: 1, kind: "note", id: "x" }) === null);
  check("backup: an unknown service reads as other", normalizeBackupRecord(message({ service: "Carrier pigeon" }))?.service === "other");

  const chat = normalizeBackupRecord({ v: 1, kind: "chat", id: "chat1", name: "Fam\u202eily", members: ["+1", "+1", "", 4, "+2"], service: "iMessage" });
  check("backup: a chat name loses invisible direction marks", chat?.name === "Family");
  check("backup: chat members are distinct handles", JSON.stringify(chat?.members) === JSON.stringify(["+1", "+2"]));

  const reaction = normalizeBackupRecord({ v: 1, kind: "reaction", id: "r1", chat: "chat1", at: "2026-10-21T19:13:00Z", me: false, from: "+1", target: "AAAA-1111", reaction: "hearts" });
  check("backup: an unknown tapback reads as reacted", reaction?.reaction === "reacted");
  check("backup: a reaction needs a target", normalizeBackupRecord({ v: 1, kind: "reaction", id: "r1", chat: "c", at: "2026-10-21T19:13:00Z" }) === null);

  const person = normalizeBackupRecord({ v: 1, kind: "person", handle: "+15550100", name: "Ada Okafor", notes: "secret" });
  check("backup: a person is a handle and a name, nothing else", JSON.stringify(person) === JSON.stringify({ v: 1, kind: "person", handle: "+15550100", name: "Ada Okafor" }));

  check("backup: records fold by kind and id", recordKey(kept) === "message:AAAA-1111" && recordKey(person) === "person:+15550100");
  check("backup: a message's month is its UTC month", monthOf(kept) === "2026-10");

  const batch = readBackupBatch({ v: 1, records: [message(), { v: 1, kind: "junk" }] });
  check("backup: a batch keeps records and counts the rest", batch.ok === true && batch.records.length === 1 && batch.dropped === 1);
  check("backup: an empty batch is refused", readBackupBatch({ v: 1, records: [] }).reason === "empty");
  check("backup: a batch over the record limit is refused", readBackupBatch({ v: 1, records: Array.from({ length: LIMITS.records + 1 }, () => message()) }).reason === "too_many");
  check("backup: a batch of another version is refused", readBackupBatch({ v: 9, records: [message()] }).reason === "version");

  await runFileChecks(check);
}

async function runFileChecks(check) {
  const id = "0123456789abcdef0123456789abcdef";
  const withId = normalizeBackupRecord(message({ files: [{ id, name: "IMG_1.HEIC", type: "image/heic", bytes: 9 }] }));
  check("backup files: a file keeps its id", withId?.files?.[0]?.id === id);
  const badId = normalizeBackupRecord(message({ files: [{ id: "../../notes/x", name: "a.jpg" }, { id: id.toUpperCase(), name: "b.jpg" }] }));
  check("backup files: an id that is not 32 lowercase hex characters is dropped, the file kept", badId?.files?.length === 2 && badId.files.every((file) => !("id" in file)));

  const digest = await digestId("p:0/AAAA-1111");
  check(
    "backup files: the digest is SHA-256's first 32 hex characters, as Node computes it on the Mac",
    digest === createHash("sha256").update("p:0/AAAA-1111").digest("hex").slice(0, 32),
  );
  check("backup files: a file lives under its message's folder", fileKeyOf(digest, id) === `${BACKUP_PREFIX}files/${digest}/${id}` && filesFolderKeyOf(digest) === `${BACKUP_PREFIX}files/${digest}/`);
  let refused = 0;
  for (const [folder, file] of [["../x", id], [digest, "a/b"], [digest, ""]]) {
    try {
      fileKeyOf(folder, file);
    } catch {
      refused += 1;
    }
  }
  check("backup files: a key is never built from anything but two digests", refused === 3);

  check("backup files: the route parses to its folder and id", JSON.stringify(parseFileRoute(`${MESSAGES_BACKUP_FILE_ROUTE}/${digest}/${id}`)) === JSON.stringify({ folder: digest, id }));
  check(
    "backup files: any other path under the route is not a file",
    [
      `${MESSAGES_BACKUP_FILE_ROUTE}/${digest}`,
      `${MESSAGES_BACKUP_FILE_ROUTE}/${digest}/${id}/more`,
      `${MESSAGES_BACKUP_FILE_ROUTE}/../${id}`,
      `${MESSAGES_BACKUP_FILE_ROUTE}${digest}/${id}`,
      MESSAGES_BACKUP_ROUTE,
    ].every((path) => parseFileRoute(path) === null),
  );

  check("backup files: a video is told by its type", isVideoFile({ type: "video/quicktime", name: "clip" }));
  check("backup files: a video with no type is told by its name", isVideoFile({ name: "IMG_2.MOV" }) && isVideoFile({ type: "application/octet-stream", name: "a.mp4" }));
  check("backup files: pictures and documents are not videos", !isVideoFile({ type: "image/heic", name: "IMG_1.HEIC" }) && !isVideoFile({ type: "application/pdf", name: "lease.pdf" }) && !isVideoFile({}));
  check("backup files: the size limit is 25 MB", LIMITS.fileBytes === 25 * 1024 * 1024);
}
