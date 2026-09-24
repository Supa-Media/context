// Gmail sync: attachments fetched into the bucket, retained on a timer.
//
// The owner's decision (2026-09-07), reversing the metadata-only default:
// "sometimes an email says look at the PDF attached, and it should land
// somewhere referenceable in the bucket." Filename sanitization, fetch and
// note-reference, idempotent re-sync, expiry, 'forever' retention, the size
// cap and quota, metadata-only mode, and cross-message dedup.
//
// Split out of gmailSync.test.mjs; see fixtures.mjs for the fixture server.

import { GMAIL_ATTACHMENT_MAX_BYTES, attachmentPath, manifestPath, readManifest, sanitizeAttachmentFilename, sha256Hex, sweepExpiredAttachments, syncDayFromGmail } from "../../src/communications/gmailSync.js";
import { assertSafeKey } from "../../src/store/index.js";
import { createFixtureGmail, createMemoryStore, fixtureMessage } from "./fixtures.mjs";

export async function runGmailAttachmentChecks(check) {
  // -- filename sanitization: a hostile name must not escape the folder --------

  check(
    "path traversal in a filename never escapes the attachments folder",
    attachmentPath({
      mailboxSlug: "p-at-example-invalid",
      date: "2026-09-07",
      contentHash: "abc123",
      filename: "../../../etc/passwd",
    }).startsWith("0-inbox/email/p-at-example-invalid/attachments/2026/09/07/abc123-"),
  );
  check(
    "...and the sanitized name itself carries no '..' segment",
    !sanitizeAttachmentFilename("../../etc/passwd").includes(".."),
  );
  check(
    "an absolute path is reduced to its basename",
    sanitizeAttachmentFilename("/etc/passwd") === "passwd",
  );
  check(
    "a Windows-style traversal is reduced the same way",
    sanitizeAttachmentFilename("..\\..\\windows\\system32\\config") === "config",
  );
  check(
    "wikilink-syntax characters are stripped from the filename — the path is embedded in [[path|label]] verbatim",
    (() => {
      const safe = sanitizeAttachmentFilename("evil]] and [[.context/audit/x|y#z.pdf");
      return !/[[\]|#]/.test(safe);
    })()
  );
  check(
    "a filename that sanitizes to nothing falls back to a safe default, never an empty path segment",
    sanitizeAttachmentFilename("../..") === "attachment" && sanitizeAttachmentFilename("") === "attachment",
  );
  check(
    "every attachment path this module builds is a key the store itself accepts",
    (() => {
      const hostileNames = [
        "../../../etc/passwd",
        "..\\..\\windows\\config",
        "/etc/passwd",
        "evil]] and [[.context/audit/x|y#z",
        "..",
        ".",
        "",
        "a\u0000b",
      ];
      return hostileNames.every((filename) => {
        const path = attachmentPath({ mailboxSlug: "p-at-example-invalid", date: "2026-09-07", contentHash: "h", filename });
        try {
          assertSafeKey(path);
          return true;
        } catch {
          return false;
        }
      });
    })()
  );
  check(
    "a date bound (Gmail's own 25MB attachment limit) is a real, named constant",
    GMAIL_ATTACHMENT_MAX_BYTES === 25 * 1024 * 1024,
  );

  // -- fetch, reference, and idempotent re-sync ---------------------------------

  const attachmentMessages = [
    fixtureMessage({
      id: "att1",
      threadId: "t1",
      date: "2026-09-07T09:00:00.000Z",
      from: "a@example.invalid",
      to: "p@example.invalid",
      subject: "See attached",
      text: "The report is attached.",
      attachments: [{ filename: "report.pdf", contentType: "application/pdf", size: 11, attachmentId: "ATT-1" }],
    }),
  ];
  const attachmentGmail = createFixtureGmail({
    messages: attachmentMessages,
    attachmentContents: { "att1/ATT-1": "pdf-bytes!!" },
  });
  const attachmentStore = createMemoryStore();
  const fetchDayOptions = {
    store: attachmentStore,
    fetchImpl: attachmentGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    date: "2026-09-07",
    nonce: "n",
    remainingQuotaBytes: 1_000_000,
    attachmentMode: "store",
    attachmentRetentionDays: 90,
  };
  const firstFetch = await syncDayFromGmail(fetchDayOptions);
  check("fetching a day with a storable attachment writes bytes for both the note and the attachment", firstFetch.bytesWritten > "pdf-bytes!!".length);

  const expectedHash = await sha256Hex(new TextEncoder().encode("pdf-bytes!!"));
  const expectedAttachmentPath = attachmentPath({
    mailboxSlug: "p-at-example-invalid",
    date: "2026-09-07",
    contentHash: expectedHash,
    filename: "report.pdf",
  });
  const storedAttachment = await attachmentStore.get(expectedAttachmentPath);
  check("the attachment's bytes actually landed at the content-hashed path", storedAttachment !== null);
  check("...with the exact bytes Gmail served", storedAttachment !== null && (await storedAttachment.text()) === "pdf-bytes!!");

  const dayNoteAfterFetch = await attachmentStore.get("0-inbox/email/p-at-example-invalid/2026/09/2026-09-07.md");
  const dayNoteText = dayNoteAfterFetch ? await dayNoteAfterFetch.text() : "";
  check(
    "the channel-day note LINKS to the fetched attachment",
    dayNoteText.includes(`[[${expectedAttachmentPath}|report.pdf]]`),
  );

  const customFolderGmail = createFixtureGmail({
    messages: attachmentMessages,
    attachmentContents: { "att1/ATT-1": "pdf-bytes!!" },
  });
  const customFolderStore = createMemoryStore();
  await syncDayFromGmail({
    ...fetchDayOptions,
    store: customFolderStore,
    fetchImpl: customFolderGmail.fetchImpl,
    folder: "2-areas/communications/supa-mail",
  });
  check(
    "a mailbox destination folder moves the day note",
    (await customFolderStore.get("2-areas/communications/supa-mail/2026/09/2026-09-07.md")) !== null,
  );
  check(
    "...and moves the attachment manifest beside that mailbox destination",
    (await customFolderStore.get("2-areas/communications/supa-mail/attachments/.manifest.json")) !== null,
  );

  const attachmentCallCountAfterFirstFetch = attachmentGmail.calls.filter((call) => call.includes("/attachments/")).length;
  check("exactly one attachment fetch happened for one attachment", attachmentCallCountAfterFirstFetch === 1);

  const resyncSameDay = await syncDayFromGmail(fetchDayOptions);
  check(
    "RE-SYNCING THE SAME DAY DOES NOT RE-FETCH THE ATTACHMENT — the manifest already resolved it",
    attachmentGmail.calls.filter((call) => call.includes("/attachments/")).length === attachmentCallCountAfterFirstFetch,
  );
  check("...and writes no new attachment bytes on the resync", resyncSameDay.bytesWritten === 0);

  // -- expiry, and no re-fetch after expiry -------------------------------------

  const nearFuture = new Date(Date.now() + 1000).toISOString();
  const sweepResult = await sweepExpiredAttachments({
    store: attachmentStore,
    mailboxSlug: "p-at-example-invalid",
    now: nearFuture, // Nothing has expired yet — retention is 90 days.
  });
  check("nothing expires before its retention window has passed", sweepResult.expiredHashes.length === 0);

  const farFuture = new Date(Date.now() + 91 * 24 * 60 * 60 * 1000).toISOString();
  const expirySweep = await sweepExpiredAttachments({
    store: attachmentStore,
    mailboxSlug: "p-at-example-invalid",
    now: farFuture,
  });
  check("91 days later, the attachment has expired", expirySweep.expiredHashes.includes(expectedHash));
  check("the sweep names the affected date, for a caller that wants to re-render its note", expirySweep.affectedDates.includes("2026-09-07"));
  check(
    "the file itself is deleted from the bucket",
    (await attachmentStore.get(expectedAttachmentPath)) === null,
  );

  const resyncAfterExpiry = await syncDayFromGmail(fetchDayOptions);
  check(
    "A RE-SYNC AFTER EXPIRY DOES NOT RE-FETCH — the manifest remembers this attachment is gone",
    attachmentGmail.calls.filter((call) => call.includes("/attachments/")).length === attachmentCallCountAfterFirstFetch,
  );
  const noteAfterExpiry = await attachmentStore.get("0-inbox/email/p-at-example-invalid/2026/09/2026-09-07.md");
  const noteTextAfterExpiry = noteAfterExpiry ? await noteAfterExpiry.text() : "";
  check(
    "the note's link is rewritten to name and size only once expired",
    !noteTextAfterExpiry.includes("[[") && noteTextAfterExpiry.includes("report.pdf") && noteTextAfterExpiry.includes("(not stored)"),
  );

  check(
    "sweeping twice in a row is idempotent — nothing is deleted a second time",
    (
      await sweepExpiredAttachments({ store: attachmentStore, mailboxSlug: "p-at-example-invalid", now: farFuture })
    ).expiredHashes.length === 0,
  );

  // -- 'keep forever' never expires ---------------------------------------------

  const foreverMessages = [
    fixtureMessage({
      id: "forever1",
      threadId: "t1",
      date: "2026-09-07T09:00:00.000Z",
      from: "a@example.invalid",
      to: "p@example.invalid",
      subject: "Keep this",
      text: "x",
      attachments: [{ filename: "keepsake.pdf", contentType: "application/pdf", size: 5, attachmentId: "ATT-2" }],
    }),
  ];
  const foreverGmail = createFixtureGmail({ messages: foreverMessages, attachmentContents: { "forever1/ATT-2": "abcde" } });
  const foreverStore = createMemoryStore();
  await syncDayFromGmail({
    store: foreverStore,
    fetchImpl: foreverGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    date: "2026-09-07",
    nonce: "n",
    remainingQuotaBytes: 1_000_000,
    attachmentMode: "store",
    attachmentRetentionDays: "forever",
  });
  const foreverManifest = await readManifest(foreverStore, "p-at-example-invalid");
  const foreverHash = await sha256Hex(new TextEncoder().encode("abcde"));
  check("'forever' retention records no expiry at all", foreverManifest.files[foreverHash]?.expiresAt == null);
  const distantFuture = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString();
  const foreverSweep = await sweepExpiredAttachments({ store: foreverStore, mailboxSlug: "p-at-example-invalid", now: distantFuture });
  check("...and never expires, no matter how far in the future the sweep runs", !foreverSweep.expiredHashes.includes(foreverHash));

  // -- size cap and quota: too large or too expensive stays metadata-only -------

  const oversizedMessages = [
    fixtureMessage({
      id: "big1",
      threadId: "t1",
      date: "2026-09-07T09:00:00.000Z",
      from: "a@example.invalid",
      to: "p@example.invalid",
      subject: "Huge file",
      text: "x",
      attachments: [
        { filename: "huge.zip", contentType: "application/zip", size: GMAIL_ATTACHMENT_MAX_BYTES + 1, attachmentId: "ATT-BIG" },
      ],
    }),
  ];
  const oversizedGmail = createFixtureGmail({ messages: oversizedMessages, attachmentContents: {} });
  const oversizedStore = createMemoryStore();
  await syncDayFromGmail({
    store: oversizedStore,
    fetchImpl: oversizedGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    date: "2026-09-07",
    nonce: "n",
    remainingQuotaBytes: 1_000_000,
    attachmentMode: "store",
    attachmentRetentionDays: 90,
  });
  check(
    "an attachment over Gmail's own size cap is never fetched — declared size alone decides",
    oversizedGmail.calls.filter((call) => call.includes("/attachments/")).length === 0,
  );

  const quotaBoundMessages = [
    fixtureMessage({
      id: "q1",
      threadId: "t1",
      date: "2026-09-07T09:00:00.000Z",
      from: "a@example.invalid",
      to: "p@example.invalid",
      subject: "Small enough, but no quota",
      text: "x",
      attachments: [{ filename: "small.pdf", contentType: "application/pdf", size: 100, attachmentId: "ATT-Q" }],
    }),
  ];
  const quotaGmail = createFixtureGmail({ messages: quotaBoundMessages, attachmentContents: { "q1/ATT-Q": "y".repeat(100) } });
  const quotaBoundStore = createMemoryStore();
  const quotaBoundResult = await syncDayFromGmail({
    store: quotaBoundStore,
    fetchImpl: quotaGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    date: "2026-09-07",
    nonce: "n",
    remainingQuotaBytes: 10, // Smaller than even this one small attachment.
    attachmentMode: "store",
    attachmentRetentionDays: 90,
  });
  check(
    "a quota too small for even a small attachment leaves it metadata-only, without spending the fetch",
    quotaGmail.calls.filter((call) => call.includes("/attachments/")).length === 0,
  );
  void quotaBoundResult;

  // -- metadata-only mode never fetches ------------------------------------------

  const metadataOnlyGmail = createFixtureGmail({ messages: attachmentMessages, attachmentContents: { "att1/ATT-1": "pdf-bytes!!" } });
  const metadataOnlyStore = createMemoryStore();
  await syncDayFromGmail({
    store: metadataOnlyStore,
    fetchImpl: metadataOnlyGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    date: "2026-09-07",
    nonce: "n",
    remainingQuotaBytes: 1_000_000,
    attachmentMode: "metadata-only",
  });
  check(
    "attachmentMode: metadata-only never calls Gmail's attachments.get at all",
    metadataOnlyGmail.calls.filter((call) => call.includes("/attachments/")).length === 0,
  );

  // -- cross-message dedup: the same bytes twice is one file --------------------

  const dedupMessages = [
    fixtureMessage({
      id: "dup1",
      threadId: "t1",
      date: "2026-09-07T09:00:00.000Z",
      from: "a@example.invalid",
      to: "p@example.invalid",
      subject: "First copy",
      text: "x",
      attachments: [{ filename: "shared.pdf", contentType: "application/pdf", size: 9, attachmentId: "ATT-A" }],
    }),
    fixtureMessage({
      id: "dup2",
      threadId: "t2",
      date: "2026-09-07T10:00:00.000Z",
      from: "b@example.invalid",
      to: "p@example.invalid",
      subject: "Second copy, identical bytes",
      text: "y",
      attachments: [{ filename: "shared.pdf", contentType: "application/pdf", size: 9, attachmentId: "ATT-B" }],
    }),
  ];
  const dedupGmail = createFixtureGmail({
    messages: dedupMessages,
    attachmentContents: { "dup1/ATT-A": "identical", "dup2/ATT-B": "identical" },
  });
  const dedupStore = createMemoryStore();
  await syncDayFromGmail({
    store: dedupStore,
    fetchImpl: dedupGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    date: "2026-09-07",
    nonce: "n",
    remainingQuotaBytes: 1_000_000,
    attachmentMode: "store",
    attachmentRetentionDays: 90,
  });
  const dedupManifest = await readManifest(dedupStore, "p-at-example-invalid");
  check("the same bytes from two different messages is ONE file entry", Object.keys(dedupManifest.files).length === 1);
  check("...but both messages' attachments resolved to it", Object.keys(dedupManifest.resolved).length === 2);

  // -- the manifest itself is plumbing, never a note ----------------------------

  check(
    "the manifest lives at a dot-prefixed path — plumbing, hidden from every note-listing tool",
    manifestPath("p-at-example-invalid")
      .split("/")
      .some((segment) => segment.startsWith(".")),
  );
}
