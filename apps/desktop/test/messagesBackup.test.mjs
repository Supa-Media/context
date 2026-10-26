/**
 * The Messages backup's pure half: rows to records, names for numbers, the
 * cursor, one pass over fakes, and the upload's batching and refusals.
 *
 * `messagesBackupSqlite.test.mjs` runs the same SQL against a real database;
 * this file never touches a process or the network.
 *
 * ## Sabotage record
 *
 * Run as temporary edits and reverted:
 *
 *   records.ts keeping text on an unsent message                 1
 *   records.ts using the stored path as a file's name            2
 *   contacts.ts naming a handle two contacts disagree about      1
 *   contacts.ts naming every Contacts row, not only chat handles 1
 *   pass.ts reading history before new texts                     2
 *   pass.ts moving the cursor past a failed upload               3
 *   pass.ts sending chats again when nothing changed             1
 *   upload.ts putting the token in the URL                       2
 *   upload.ts reading a non-JSON 200 as kept                     1
 */

import { LIMITS } from "@context/communications/backup";
import { recordsFromRows, chatRecords, isTapback } from "../src/core/messages/records.ts";
import { addressKey, isAllowedAddressBookPath, personRecords } from "../src/core/messages/contacts.ts";
import { FRESH_BACKUP_CURSOR, historyDone, laterNs, normalizeBackupCursor } from "../src/core/messages/cursor.ts";
import { runBackupPass } from "../src/core/messages/pass.ts";
import { batchesOf, classifyStatus, uploadBackupRecords } from "../src/core/messages/upload.ts";
import { backupBridgeStatus, machineLabel, maskAccount } from "../src/main/messagesBackup.ts";

const NS_2026_10_21 = "814295520000000000"; // 2026-10-21T17:12:00Z in Apple-epoch nanoseconds

function row(overrides = {}) {
  return {
    rowid: "1",
    guid: "G1",
    date_ns: NS_2026_10_21,
    text: "Dinner at 4",
    attributed_body_hex: null,
    is_from_me: 0,
    associated_message_type: 0,
    associated_message_guid: null,
    chat_guid: "iMessage;-;+15550100100",
    sender_address: "+15550100100",
    date_edited_ns: null,
    date_retracted_ns: null,
    reply_to_guid: null,
    service: "iMessage",
    ...overrides,
  };
}

function checkRecords(check) {
  const [message] = recordsFromRows([row()], [{ message_guid: "G1", filename: "~/Library/Messages/Attachments/ab/12/IMG_1.HEIC", transfer_name: "IMG_1.HEIC", mime_type: "image/heic", total_bytes: "2048" }]);
  check("records: a text becomes a message record with its words", message?.kind === "message" && message.text === "Dinner at 4" && message.from === "+15550100100");
  check("records: the date is the message's own, in UTC", message?.at === "2026-10-21T17:12:00.000Z");
  check("records: a file is named as it was sent, never by where the Mac keeps it", message?.files?.[0]?.name === "IMG_1.HEIC" && !JSON.stringify(message).includes("Library"));

  const [stored] = recordsFromRows([row()], [{ message_guid: "G1", filename: "~/Library/Messages/Attachments/ab/IMG_2.HEIC", transfer_name: null, mime_type: null, total_bytes: null }]);
  check("records: with no sent name, only the file's own name is kept", stored?.files?.[0]?.name === "IMG_2.HEIC");

  const [mine] = recordsFromRows([row({ is_from_me: 1, sender_address: "+15550100100" })], []);
  check("records: a text the person sent has no sender", mine?.me === true && !("from" in mine));

  const [unsent] = recordsFromRows([row({ text: "oops", date_retracted_ns: NS_2026_10_21 })], [{ message_guid: "G1", filename: null, transfer_name: "a.jpg", mime_type: "image/jpeg", total_bytes: "1" }]);
  check("records: an unsent message is sent with no words and no files", unsent?.unsent === true && unsent.text === "" && !("files" in unsent));

  const [edited] = recordsFromRows([row({ text: "Dinner at 5", date_edited_ns: NS_2026_10_21 })], []);
  check("records: an edit carries its new words and when", edited?.text === "Dinner at 5" && edited.edited === "2026-10-21T17:12:00.000Z");

  check("records: a row with nothing in it is a system row and is left out", recordsFromRows([row({ text: null })], []).length === 0);
  check("records: a row with no readable date is left out", recordsFromRows([row({ date_ns: null })], []).length === 0);

  const [loved] = recordsFromRows([row({ guid: "R1", text: "Loved “Dinner at 4”", associated_message_type: 2000, associated_message_guid: "p:0/G1" })], []);
  check("records: a tapback is its own record naming its target", loved?.kind === "reaction" && loved.target === "G1" && loved.reaction === "loved" && !("text" in loved));
  const [removed] = recordsFromRows([row({ guid: "R2", associated_message_type: 3001, associated_message_guid: "bp:G1" })], []);
  check("records: a tapback taken back says so", removed?.kind === "reaction" && removed.reaction === "liked" && removed.removed === true);
  const [emoji] = recordsFromRows([row({ guid: "R3", text: "Reacted 🎉 to “Dinner at 4”", associated_message_type: 2006, associated_message_guid: "p:0/G1" })], []);
  check("records: a newer kind of tapback is a reaction, never a message", emoji?.kind === "reaction" && emoji.reaction === "reacted");
  check("records: tapback kinds are 2000 to 3999", isTapback(2000) && isTapback(3006) && !isTapback(0) && !isTapback(1000));

  const chats = chatRecords(
    [{ chat_guid: "c2", display_name: " Okafor family ", chat_identifier: "chat1", service_name: "iMessage" }, { chat_guid: "c1", display_name: null, chat_identifier: "+1", service_name: "SMS" }],
    [{ chat_guid: "c2", address: "+3" }, { chat_guid: "c2", address: "+2" }, { chat_guid: "c2", address: "+2" }],
  );
  check("records: chats come sorted, named, with distinct sorted members", chats.map((chat) => chat.id).join() === "c1,c2" && chats[1].name === "Okafor family" && chats[1].members.join() === "+2,+3");
  check("records: an unnamed chat has no name field", !("name" in chats[0]) && chats[0].service === "SMS");
}

function checkContacts(check) {
  check("contacts: two spellings of one number share a key", addressKey("+1 (555) 010-0100") === addressKey("+15550100100"));
  check("contacts: emails match case-blind", addressKey("Ada@Example.com") === "ada@example.com");
  check("contacts: a short code matches nothing", addressKey("22395") === null);

  const rows = [
    { first: "Ada", last: "Okafor", nickname: null, organization: null, address: "+1 (555) 010-0100" },
    { first: null, last: null, nickname: null, organization: "Dentist", address: "+1 555 010 0200" },
    { first: "Sam", last: null, nickname: null, organization: null, address: "+15550100300" },
    { first: "Samuel", last: null, nickname: null, organization: null, address: "555-010-0300" },
    { first: "Never", last: "Texted", nickname: null, organization: null, address: "+15550109999" },
  ];
  const people = personRecords(["+15550100100", "+15550100200", "+15550100300"], rows);
  check("contacts: a handle gets its contact's name", people.find((p) => p.handle === "+15550100100")?.name === "Ada Okafor");
  check("contacts: an organization stands in for a person's name", people.find((p) => p.handle === "+15550100200")?.name === "Dentist");
  check("contacts: a number two contacts disagree about is left unnamed", !people.some((p) => p.handle === "+15550100300"));
  check("contacts: nobody who never texted is sent", !people.some((p) => p.name === "Never Texted"));

  const root = "/Users/sam/Library/Application Support/AddressBook";
  check("contacts: the top-level database is allowed", isAllowedAddressBookPath(`${root}/AddressBook-v22.abcddb`, root));
  check("contacts: one under Sources is allowed", isAllowedAddressBookPath(`${root}/Sources/ABC-123/AddressBook-v22.abcddb`, root));
  check("contacts: anything else is refused", !isAllowedAddressBookPath(`${root}/Sources/ABC/../../../../Messages/chat.db`, root) && !isAllowedAddressBookPath(`${root}/Sources/ABC/other.db`, root) && !isAllowedAddressBookPath(null, root));
}

function checkCursor(check) {
  check("cursor: rubbish reads as fresh", JSON.stringify(normalizeBackupCursor("x")) === JSON.stringify(FRESH_BACKUP_CURSOR));
  check("cursor: a history position above the forward one reads as fresh", normalizeBackupCursor({ version: 1, newest: 5, oldest: 50, changesAfterNs: "0" }).oldest === null);
  const kept = normalizeBackupCursor({ version: 1, newest: 900, oldest: 400, changesAfterNs: "123", chatsDigest: "a".repeat(64), peopleDigest: "zz" });
  check("cursor: a good cursor is kept, a bad digest dropped", kept.newest === 900 && kept.oldest === 400 && kept.chatsDigest === "a".repeat(64) && kept.peopleDigest === null);
  check("cursor: history is done at row 1", historyDone({ ...kept, oldest: 1 }) && !historyDone(kept) && !historyDone(FRESH_BACKUP_CURSOR));
  check("cursor: later instants compare as numbers, not text", laterNs("9", "10") === "10");
}

/** A fake `chat.db` of `count` messages, ROWIDs 1..count, plus fakes for everything else a pass asks. */
function fakeDeps({ count = 25, upload = async () => ({ ok: true }), changed = [], addressBook = [] } = {}) {
  const sent = [];
  const saved = [];
  const reads = [];
  const deps = {
    columns: async () => new Set(["date_edited", "date_retracted"]),
    maxRowId: async () => count,
    messages: async (window) => {
      reads.push(window);
      if (window.kind === "changed") return changed;
      const rows = [];
      for (let id = window.afterRowId + 1; id <= window.throughRowId; id += 1) rows.push(row({ rowid: String(id), guid: `G${id}`, text: `text ${id}` }));
      return rows;
    },
    attachmentsInRange: async () => [],
    attachmentsForRows: async () => [],
    chats: async () => [{ chat_guid: "iMessage;-;+15550100100", display_name: null, chat_identifier: "+15550100100", service_name: "iMessage" }],
    participants: async () => [{ chat_guid: "iMessage;-;+15550100100", address: "+15550100100" }],
    addressBook: async () => addressBook,
    upload: async (records) => {
      const result = await upload(records);
      if (result.ok) sent.push(...records);
      return result;
    },
    nowNs: () => "700000000000000000",
    digest: (text) => text.length.toString(16).padStart(64, "0"),
    saveCursor: async (cursor) => saved.push(cursor),
    stillWanted: () => true,
  };
  return { deps, sent, saved, reads };
}

async function checkPass(check) {
  {
    const { deps, sent, reads } = fakeDeps({ count: 25 });
    const report = await runBackupPass(deps, FRESH_BACKUP_CURSOR, { pageRows: 10, historyPages: 1 });
    check("pass: the first look starts both ends at the newest row", report.cursor.newest === 25 && report.cursor.oldest === 16);
    check("pass: the first look sends the chat before any text", sent[0]?.kind === "chat");
    const ranges = reads.filter((w) => w.kind === "range");
    check("pass: history is read newest first", ranges[0]?.afterRowId === 15 && ranges[0]?.throughRowId === 25);
    check("pass: more is waiting while history remains", report.more === true && report.stopped === undefined);

    const second = await runBackupPass(deps, report.cursor, { pageRows: 10, historyPages: 5 });
    check("pass: the rest of history arrives and the backup is done", historyDone(second.cursor) && second.more === false);
    const ids = sent.filter((r) => r.kind === "message").map((r) => r.id);
    check("pass: every row is sent exactly once across passes", new Set(ids).size === 25 && ids.length === 25);
    check("pass: chats unchanged since last sent are not sent again", sent.filter((r) => r.kind === "chat").length === 1);
  }
  {
    const { deps, reads } = fakeDeps({ count: 40 });
    await runBackupPass(deps, { ...FRESH_BACKUP_CURSOR, newest: 30, oldest: 20, changesAfterNs: "1" }, { pageRows: 5, historyPages: 1, forwardPages: 5 });
    const ranges = reads.filter((w) => w.kind === "range");
    check("pass: new texts are read before history", ranges[0]?.afterRowId === 30 && ranges.at(-1)?.throughRowId === 19);
  }
  {
    let calls = 0;
    const { deps, saved } = fakeDeps({ count: 30, upload: async () => (++calls >= 3 ? { ok: false, retry: true, code: "offline" } : { ok: true }) });
    const start = { ...FRESH_BACKUP_CURSOR, newest: 10, oldest: 1, changesAfterNs: "1", chatsDigest: null, peopleDigest: null };
    const report = await runBackupPass(deps, start, { pageRows: 5 });
    check("pass: a failed upload ends the pass and says it may retry", report.stopped?.retry === true && report.stopped.code === "offline");
    check("pass: the cursor stops before the page that failed", report.cursor.newest === 15 && saved.at(-1).newest === 15);
  }
  {
    const { deps } = fakeDeps({ upload: async () => ({ ok: false, retry: false, code: "reconnect" }) });
    const report = await runBackupPass(deps, FRESH_BACKUP_CURSOR);
    check("pass: a refusal the person must fix says not to retry", report.stopped?.retry === false && report.stopped.code === "reconnect");
  }
  {
    const changed = [row({ rowid: "3", guid: "G3", text: "", date_retracted_ns: "800000000000000000" }), row({ rowid: "4", guid: "G4", text: "fixed", date_edited_ns: "800000000000000500" })];
    const { deps, sent } = fakeDeps({ count: 10, changed });
    const report = await runBackupPass(deps, { ...FRESH_BACKUP_CURSOR, newest: 10, oldest: 1, changesAfterNs: "1" });
    check("pass: edits and unsends are sent", sent.some((r) => r.id === "G3" && r.unsent === true) && sent.some((r) => r.id === "G4" && r.text === "fixed"));
    check("pass: the change position moves to the latest change seen", report.cursor.changesAfterNs === "800000000000000500");
  }
  {
    const { deps, sent } = fakeDeps({ count: 10, addressBook: [{ first: "Ada", last: null, nickname: null, organization: null, address: "+15550100100" }] });
    await runBackupPass(deps, FRESH_BACKUP_CURSOR);
    check("pass: names are sent for handles in chats", sent.some((r) => r.kind === "person" && r.name === "Ada"));
  }
  {
    let wanted = true;
    const { deps, sent } = fakeDeps({ count: 50 });
    deps.stillWanted = () => wanted;
    deps.upload = async (records) => {
      sent.push(...records);
      wanted = false;
      return { ok: true };
    };
    const report = await runBackupPass(deps, { ...FRESH_BACKUP_CURSOR, newest: 10, oldest: 1, changesAfterNs: "1", chatsDigest: "x", peopleDigest: "y" }, { pageRows: 5 });
    check("pass: turning the backup off ends the pass at the next step", report.stopped === undefined && report.more === false && sent.length <= 6);
  }
}

async function checkUpload(check) {
  const record = (i, text = "x") => ({ v: 1, kind: "message", id: `G${i}`, chat: "c", at: "2026-10-21T17:12:00.000Z", me: false, text, service: "iMessage" });
  check("upload: batches stop at the record limit", batchesOf(Array.from({ length: LIMITS.records + 1 }, (_, i) => record(i))).length === 2);
  const big = Array.from({ length: 300 }, (_, i) => record(i, "y".repeat(LIMITS.text)));
  const batches = batchesOf(big);
  check("upload: batches stop below the body limit", batches.length > 1 && batches.every((b) => new TextEncoder().encode(JSON.stringify({ v: 1, records: b })).length < LIMITS.bodyBytes));
  check("upload: no record is lost or repeated in batching", batches.flat().length === 300);

  check("upload: signed out means reconnect, not retry", classifyStatus(401).code === "reconnect" && classifyStatus(401).retry === false);
  check("upload: a server error is retried", classifyStatus(503).retry === true && classifyStatus(429).retry === true);

  const calls = [];
  const ok = await uploadBackupRecords(
    { baseUrl: "https://mcp.example.test", token: async () => "secret-token", fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true, kept: 1 }), { status: 200 }); } },
    [record(1)],
  );
  check("upload: a kept batch is ok", ok.ok === true);
  check("upload: the token rides in the header and never the URL", calls[0]?.init.headers.authorization === "Bearer secret-token" && !calls[0].url.includes("secret-token"));
  check("upload: the batch posts to the backup route", calls[0]?.url === "https://mcp.example.test/messages/imessage/batch" && JSON.parse(calls[0].init.body).records.length === 1);

  const portal = await uploadBackupRecords({ baseUrl: "https://x.test", token: async () => "t", fetch: async () => new Response("<html>Sign in to Wi-Fi</html>", { status: 200 }) }, [record(1)]);
  check("upload: a page that is not the gateway's answer is retried, never read as kept", portal.ok === false && portal.retry === true);
  const offline = await uploadBackupRecords({ baseUrl: "https://x.test", token: async () => "t", fetch: async () => { throw new TypeError("fetch failed https://x.test?secret"); } }, [record(1)]);
  check("upload: a network failure is retried with no text from the error", offline.ok === false && offline.code === "offline");
  const noToken = await uploadBackupRecords({ baseUrl: "https://x.test", token: async () => null, fetch: async () => new Response("{}") }, [record(1)]);
  check("upload: no credential means reconnect", noToken.ok === false && noToken.code === "reconnect");
}

function checkMask(check) {
  check("account: a phone number shows its last four only", maskAccount("P:+15550104410") === "+1 ••• 4410");
  check("account: an email shows its first letter and domain", maskAccount("E:ada@example.com") === "a••@example.com");
  check("account: nothing readable shows nothing", maskAccount(null) === null && maskAccount("P:12") === null);

  check("machine: the Mac's name reads as its owner wrote it", machineLabel("Sams-MacBook-Pro.local") === "Sams MacBook Pro");
  check("machine: an empty name is no name", machineLabel("") === null && machineLabel(".local") === null && machineLabel(undefined) === null);

  const status = {
    enabled: true,
    phase: "copying",
    permission: "granted",
    copiedRows: 10,
    totalRows: 40,
    lastCopiedAt: 5,
    reachedBack: 3,
    problem: "server",
    account: "+1 ••• 4410",
  };
  const told = backupBridgeStatus(status, "Sams MacBook Pro");
  check(
    "bridge: the console is told the switch, the grant and the progress",
    told.enabled && told.permission === "granted" && told.lastSyncedAt === 5 && told.backup.copiedRows === 10 && told.backup.totalRows === 40 && told.backup.reachedBack === 3 && told.backup.machine === "Sams MacBook Pro",
  );
  check("bridge: a problem is told only when the backup stopped on it", told.backup.problem === null && backupBridgeStatus({ ...status, phase: "stopped" }, null).backup.problem === "server");
  check(
    "bridge: the view carries the contract's fields and nothing else",
    Object.keys(told.backup).sort().join() === "account,copiedRows,machine,phase,problem,reachedBack,totalRows",
  );
}

export async function runMessagesBackupChecks(check) {
  checkRecords(check);
  checkContacts(check);
  checkCursor(check);
  await checkPass(check);
  await checkUpload(check);
  checkMask(check);
}
