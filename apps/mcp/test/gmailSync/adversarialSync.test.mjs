// Gmail sync: adversarial review, 2026-09-07, sync half — the 25MB cap and
// quota enforced on actual (not declared) bytes, 404 typing narrowed so an
// ordinary "message vanished" never wears the history-gap error, the sweep
// treating the manifest as data rather than instructions, and inline images.
//
// Split out of gmailSync.test.mjs; see adversarialFilenames.test.mjs for the
// filename half of the same review, and fixtures.mjs for the fixture server.

import { parseChannelDayNote } from "../../../../packages/communications/src/index.js";
import {
  GMAIL_ATTACHMENT_MAX_BYTES,
  GmailApiError,
  GmailHistoryExpiredError,
  extractBody,
  getMessage,
  listAllHistory,
  manifestPath,
  readManifest,
  resolveDayAttachments,
  runIncrementalSync,
  sha256Hex,
  sweepExpiredAttachments,
  syncDayFromGmail,
} from "../../src/communications/gmailSync.js";
import { base64Url, createFixtureGmail, createMemoryStore, fixtureMessage, jsonResponse } from "./fixtures.mjs";

export async function runGmailAdversarialSyncChecks(check) {
  // -- the 25 MB cap and the quota are enforced on the ACTUAL bytes ------------
  //
  // THE HOLE THIS FOUND. `extractBody` maps a part with no `body.size` to
  // `size: undefined`, and `resolveDayAttachments` mapped that to a declared
  // size of ZERO — which passes `> GMAIL_ATTACHMENT_MAX_BYTES` and
  // `> remaining` no matter how large the part really is. Before the fix,
  // running this block fetched and wrote 30 MB into the store with the
  // connection's quota set to nothing at all.

  function createSizedAttachmentGmail(byteCount) {
    let attachmentCalls = 0;
    const content = "A".repeat(byteCount);
    const fetchImpl = async (url) => {
      if (url.includes("/attachments/")) {
        attachmentCalls += 1;
        return jsonResponse({ size: content.length, data: base64Url(content) });
      }
      return jsonResponse({});
    };
    return { fetchImpl, attachmentCalls: () => attachmentCalls };
  }

  async function resolveOneUndeclaredAttachment({ byteCount, remainingQuotaBytes }) {
    const written = [];
    const store = {
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      async get() {
        return null;
      },
      async put(path, bytes) {
        written.push({ path, size: bytes.length });
        return { etag: "e" };
      },
      async delete() {},
    };
    const gmail = createSizedAttachmentGmail(byteCount);
    const events = [
      {
        messageId: "m1",
        // NO `size` — exactly what `extractBody` produces when Gmail omits
        // `body.size` for a part.
        attachments: [{ filename: "mystery.bin", contentType: "application/octet-stream", attachmentId: "A1" }],
      },
    ];
    const result = await resolveDayAttachments({
      store,
      fetchImpl: gmail.fetchImpl,
      accessToken: "tok",
      mailboxSlug: "m",
      date: "2026-09-07",
      events,
      attachmentMode: "store",
      retentionDays: 90,
      now: new Date().toISOString(),
      remainingQuotaBytes,
      manifest: { version: 1, resolved: {}, files: {} },
    });
    return { written, result, events };
  }

  const undeclaredOverCap = await resolveOneUndeclaredAttachment({
    byteCount: GMAIL_ATTACHMENT_MAX_BYTES + 1,
    remainingQuotaBytes: 10 * GMAIL_ATTACHMENT_MAX_BYTES,
  });
  check(
    "AN ATTACHMENT WITH NO DECLARED SIZE IS STILL BOUND BY THE 25MB CAP — the actual bytes decide, not Gmail's word",
    undeclaredOverCap.written.length === 0 && undeclaredOverCap.result.bytesWritten === 0,
  );
  check(
    "...and it is not recorded as resolved, so a later pass can try again rather than remembering a skip",
    Object.keys(undeclaredOverCap.result.manifest.resolved).length === 0,
  );
  check(
    "...and the message's note still describes it, metadata-only",
    undeclaredOverCap.events[0].attachments[0].path === undefined,
  );

  const undeclaredOverQuota = await resolveOneUndeclaredAttachment({
    byteCount: 4096,
    remainingQuotaBytes: 0,
  });
  check(
    "AN ATTACHMENT WITH NO DECLARED SIZE CANNOT SPEND QUOTA THE CONNECTION DOES NOT HAVE",
    undeclaredOverQuota.written.length === 0 && undeclaredOverQuota.result.bytesWritten === 0,
  );

  const undeclaredWithinBounds = await resolveOneUndeclaredAttachment({
    byteCount: 4096,
    remainingQuotaBytes: 1_000_000,
  });
  check(
    "...while one that fits is still fetched and written — the fix is a bound, not a refusal",
    undeclaredWithinBounds.written.length === 1 && undeclaredWithinBounds.result.bytesWritten === 4096,
  );

  // -- a 404 is not universally an expired history cursor ----------------------
  //
  // THE SECOND HOLE. `gmailFetch` promoted every 404 to
  // `GmailHistoryExpiredError`, so a message deleted between being listed and
  // being fetched — the single most ordinary transient in a live mailbox —
  // came back to the caller wearing the name of the one error whose documented
  // answer is a full 90-day reconcile.

  // Pinned at the type, not only at the behaviour. Both call sites that skip a
  // vanished message exclude `GmailHistoryExpiredError` explicitly rather than
  // letting `instanceof GmailApiError` swallow it (it is a subclass with the
  // same 404), precisely so that re-widening `gmailFetch` to promote every 404
  // fails HERE rather than being absorbed downstream and failing nothing.
  const notFoundFetch = async () => jsonResponse({ error: { code: 404 } }, 404);
  let messageGetError = null;
  try {
    await getMessage({ fetchImpl: notFoundFetch, accessToken: "tok", id: "gone" });
  } catch (error) {
    messageGetError = error;
  }
  check(
    "a 404 from messages.get is a plain GmailApiError, NOT the history-gap type",
    messageGetError instanceof GmailApiError &&
      !(messageGetError instanceof GmailHistoryExpiredError) &&
      messageGetError.status === 404,
  );
  const rateLimitedFetch = async () =>
    jsonResponse(
      {
        error: {
          code: 403,
          status: "RESOURCE_EXHAUSTED",
          errors: [{ reason: "userRateLimitExceeded" }],
        },
      },
      403,
    );
  let rateLimitError = null;
  try {
    await getMessage({ fetchImpl: rateLimitedFetch, accessToken: "tok", id: "stopped" });
  } catch (error) {
    rateLimitError = error;
  }
  check(
    "a structured Gmail 403 keeps Google's safe reason so the worker can tell quota from auth refusal",
    rateLimitError instanceof GmailApiError &&
      rateLimitError.status === 403 &&
      rateLimitError.reason === "userRateLimitExceeded" &&
      rateLimitError.googleStatus === "RESOURCE_EXHAUSTED",
  );
  let historyPageError = null;
  try {
    await listAllHistory({ fetchImpl: notFoundFetch, accessToken: "tok", startHistoryId: "1" });
  } catch (error) {
    historyPageError = error;
  }
  check(
    "...while the same 404 from history.list still IS the history-gap type",
    historyPageError instanceof GmailHistoryExpiredError,
  );

  const vanishingMessages = [
    fixtureMessage({
      id: "stays",
      threadId: "t1",
      date: "2026-09-07T09:00:00.000Z",
      from: "a@example.invalid",
      to: "p@example.invalid",
      subject: "Still here",
      text: "Present.",
    }),
  ];
  const vanishingGmail = createFixtureGmail({ messages: vanishingMessages });
  // `messages.list` is answered from `config.messages`, so injecting an id the
  // map does not hold is exactly "listed a moment ago, gone now".
  const listedThenGone = {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/gmail/v1/users/me/messages") {
        return jsonResponse({
          messages: [{ id: "stays", threadId: "t1" }, { id: "deleted-since", threadId: "t2" }],
          resultSizeEstimate: 2,
        });
      }
      return vanishingGmail.fetchImpl(url);
    },
  };
  const vanishingStore = createMemoryStore();
  let vanishingThrew = null;
  let vanishingResult = null;
  try {
    vanishingResult = await syncDayFromGmail({
      store: vanishingStore,
      fetchImpl: listedThenGone.fetchImpl,
      accessToken: "tok",
      mailboxSlug: "p-at-example-invalid",
      address: "p@example.invalid",
      folders: ["inbox", "sent"],
      date: "2026-09-07",
      nonce: "n",
      remainingQuotaBytes: 1_000_000,
    });
  } catch (error) {
    vanishingThrew = error;
  }
  check(
    "A MESSAGE DELETED BETWEEN LIST AND FETCH DOES NOT ABORT THE DAY",
    vanishingThrew === null && vanishingResult !== null && vanishingResult.partsWritten === 1,
  );
  const vanishingNote = await (
    await vanishingStore.get("0-inbox/email/p-at-example-invalid/2026/09/2026-09-07.md")
  ).text();
  check(
    "...and the day is written from what Gmail still has",
    parseChannelDayNote(vanishingNote).messages.length === 1,
  );

  const historyThenGone = {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/gmail/v1/users/me/history") {
        return jsonResponse({
          history: [{ messagesAdded: [{ message: { id: "deleted-since" } }] }],
          historyId: "3000",
        });
      }
      if (parsed.pathname === "/gmail/v1/users/me/messages") {
        return jsonResponse({ messages: [], resultSizeEstimate: 0 });
      }
      // Every messages.get 404s: the one id history named is gone.
      return jsonResponse({ error: { code: 404 } }, 404);
    },
  };
  let historyGoneThrew = null;
  let historyGoneResult = null;
  try {
    historyGoneResult = await runIncrementalSync({
      store: createMemoryStore(),
      fetchImpl: historyThenGone.fetchImpl,
      accessToken: "tok",
      mailboxSlug: "p-at-example-invalid",
      address: "p@example.invalid",
      folders: ["inbox", "sent"],
      startHistoryId: "1",
      nonce: "n",
      quotaBytes: 1_000_000,
    });
  } catch (error) {
    historyGoneThrew = error;
  }
  check(
    "A MESSAGE HISTORY NAMED AND GMAIL NO LONGER HAS IS NOT AN EXPIRED CURSOR",
    historyGoneThrew === null &&
      historyGoneResult !== null &&
      historyGoneResult.gapDetected === false &&
      historyGoneResult.daysTouched.length === 0,
  );
  check(
    "...and the cursor still advances, so the same dead id is not re-walked forever",
    historyGoneResult !== null && historyGoneResult.historyId === "3000",
  );
  check(
    "an EXPIRED CURSOR is still the one 404 that means a gap — the narrowing did not silence it",
    (
      await runIncrementalSync({
        store: createMemoryStore(),
        fetchImpl: createFixtureGmail({ messages: [], history: { expired: true } }).fetchImpl,
        accessToken: "tok",
        mailboxSlug: "p-at-example-invalid",
        address: "p@example.invalid",
        folders: ["inbox"],
        startHistoryId: "1",
        nonce: "n",
        quotaBytes: 1_000_000,
      })
    ).gapDetected === true,
  );

  // An attachment Gmail no longer holds must cost the picture, not the note.
  const goneAttachmentMessages = [
    fixtureMessage({
      id: "ga1",
      threadId: "t1",
      date: "2026-09-07T09:00:00.000Z",
      from: "a@example.invalid",
      to: "p@example.invalid",
      subject: "It was here a minute ago",
      text: "See attached.",
      attachments: [{ filename: "gone.pdf", contentType: "application/pdf", size: 9, attachmentId: "ATT-GONE" }],
    }),
  ];
  // `attachmentContents` is empty, so the fixture 404s `attachments.get`.
  const goneAttachmentGmail = createFixtureGmail({ messages: goneAttachmentMessages, attachmentContents: {} });
  const goneAttachmentStore = createMemoryStore();
  let goneAttachmentThrew = null;
  let goneAttachmentResult = null;
  try {
    goneAttachmentResult = await syncDayFromGmail({
      store: goneAttachmentStore,
      fetchImpl: goneAttachmentGmail.fetchImpl,
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
  } catch (error) {
    goneAttachmentThrew = error;
  }
  check(
    "AN ATTACHMENT GMAIL NO LONGER HAS COSTS THE FILE, NEVER THE NOTE",
    goneAttachmentThrew === null && goneAttachmentResult !== null && goneAttachmentResult.partsWritten === 1,
  );
  check(
    "...and it is not recorded as resolved, so it is retried if it comes back",
    Object.keys((await readManifest(goneAttachmentStore, "p-at-example-invalid")).resolved).length === 0,
  );

  // The same rule for a body that is not decodable base64 at all: one
  // attachment lost, the note kept.
  const undecodableStore = createMemoryStore();
  let undecodableThrew = null;
  let undecodableResult = null;
  try {
    undecodableResult = await syncDayFromGmail({
      store: undecodableStore,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.includes("/attachments/")) return jsonResponse({ data: "!!! not base64 !!!" });
        return createFixtureGmail({ messages: goneAttachmentMessages }).fetchImpl(url);
      },
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
  } catch (error) {
    undecodableThrew = error;
  }
  check(
    "an undecodable attachment body costs the file, never the note",
    undecodableThrew === null && undecodableResult !== null && undecodableResult.partsWritten === 1,
  );

  // -- the sweep acts on the manifest as DATA, not as instructions -------------
  //
  // The manifest is our bookkeeping inside a bucket the customer also syncs to
  // Obsidian and rclone. "Deletes only files this sync wrote" has to be a
  // property of the code that reads it, not only of the code that writes it.
  const hostileManifestStore = createMemoryStore();
  await hostileManifestStore.put("privacy.md", "# privacy");
  await hostileManifestStore.put("0-inbox/email/p-at-example-invalid/attachments/2026-09-07/h-real.pdf", "bytes");
  await hostileManifestStore.put(
    manifestPath("p-at-example-invalid"),
    JSON.stringify({
      version: 1,
      resolved: {},
      files: {
        outside: { path: "privacy.md", size: 9, writtenAt: "2026-09-07T00:00:00.000Z", expiresAt: "2026-09-08T00:00:00.000Z", expired: false },
        elsewhere: { path: "0-inbox/email/other-at-example-invalid/attachments/2026-09-07/h-x.pdf", size: 9, writtenAt: "2026-09-07T00:00:00.000Z", expiresAt: "2026-09-08T00:00:00.000Z", expired: false },
        real: { path: "0-inbox/email/p-at-example-invalid/attachments/2026-09-07/h-real.pdf", size: 5, writtenAt: "2026-09-07T00:00:00.000Z", expiresAt: "2026-09-08T00:00:00.000Z", expired: false },
      },
    }),
  );
  const hostileSweep = await sweepExpiredAttachments({
    store: hostileManifestStore,
    mailboxSlug: "p-at-example-invalid",
    now: "2026-09-09T00:00:00.000Z",
  });
  check(
    "A MANIFEST ENTRY POINTING OUTSIDE THE MAILBOX'S OWN FOLDER DELETES NOTHING",
    (await hostileManifestStore.get("privacy.md")) !== null,
  );
  check(
    "...not even another mailbox's attachments folder in the same bucket",
    hostileSweep.expiredHashes.includes("elsewhere") === false,
  );
  check(
    "...while the entry that IS this mailbox's own is still swept",
    hostileSweep.expiredHashes.includes("real") &&
      (await hostileManifestStore.get("0-inbox/email/p-at-example-invalid/attachments/2026-09-07/h-real.pdf")) ===
        null,
  );

  // -- an inline image is an attachment, per the owner's brief ------------------
  //
  // Gmail gives an inline image a `filename` and a `body.attachmentId` exactly
  // like a "real" attachment, differing only in `Content-Disposition: inline`
  // and a `Content-ID` header this module never reads. The claim in the module
  // comment was unproven until here.
  const inlineMessage = {
    id: "inline1",
    threadId: "t1",
    internalDate: String(Date.parse("2026-09-07T09:00:00.000Z")),
    payload: {
      mimeType: "multipart/related",
      headers: [
        { name: "From", value: "a@example.invalid" },
        { name: "To", value: "p@example.invalid" },
        { name: "Subject", value: "Signature image" },
      ],
      parts: [
        { mimeType: "text/html", body: { size: 30, data: base64Url("<p>See <img src=\"cid:sig\"></p>") } },
        {
          partId: "1",
          mimeType: "image/png",
          filename: "signature.png",
          headers: [
            { name: "Content-Disposition", value: 'inline; filename="signature.png"' },
            { name: "Content-ID", value: "<sig>" },
          ],
          body: { size: 8, attachmentId: "ATT-INLINE" },
        },
      ],
    },
  };
  check(
    "an INLINE image is parsed as an attachment, not skipped as body decoration",
    (() => {
      const parsed = extractBody(inlineMessage.payload);
      return (
        parsed.attachments.length === 1 &&
        parsed.attachments[0].filename === "signature.png" &&
        parsed.attachments[0].attachmentId === "ATT-INLINE"
      );
    })(),
  );
  const inlineGmail = createFixtureGmail({
    messages: [inlineMessage],
    attachmentContents: { "inline1/ATT-INLINE": "PNGBYTES" },
  });
  const inlineStore = createMemoryStore();
  await syncDayFromGmail({
    store: inlineStore,
    fetchImpl: inlineGmail.fetchImpl,
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
  const inlineHash = await sha256Hex(new TextEncoder().encode("PNGBYTES"));
  check(
    "...and its bytes are fetched into the bucket like any other attachment",
    (await inlineStore.get(
      `0-inbox/email/p-at-example-invalid/attachments/2026/09/07/${inlineHash}-signature.png`,
    )) !== null,
  );
}
