import { check, call, contextStore, lacks, env, accessTokenFor, suite, getFailures, controlPlane, storedText, WORKSPACE_ID } from "./harness.mjs";
import { runStoreChecks } from "./store.test.mjs";
import { messageAnchor } from "../../../packages/communications/src/anchors.js";
import { renderChannelDayNote } from "../../../packages/communications/src/note.js";
import { runCommentFormatChecks, runCommentToolChecks } from "./comments.test.mjs";
import { runProtocolBasicsChecks } from "./protocolBasics.test.mjs";
import { runTransportSecurityChecks } from "./transportSecurity.test.mjs";
import { runTokenTransportChecks } from "./tokenTransport.test.mjs";
import { runProtocolVersioningChecks } from "./protocolVersioning.test.mjs";
import { runOrientVisibilityChecks } from "./orientVisibility.test.mjs";
import { runPrivacyAclChecks } from "./privacyAcl.test.mjs";
import { runProposalsAndArchiveChecks } from "./proposalsAndArchive.test.mjs";
import { runMovesAndBatchChecks } from "./movesAndBatch.test.mjs";
import { runInboxCaptureChecks } from "./inboxCapture.test.mjs";
import { runAttachmentsCoreChecks } from "./attachmentsCore.test.mjs";
import { runAttachmentsEdgeChecks } from "./attachmentsEdge.test.mjs";
import { runUploadedImageChecks } from "./uploadedImages.test.mjs";
import { runImageUploadLinkChecks } from "./imageUploadLinks.test.mjs";
import { runPictureCompressionChecks } from "./pictureCompression.test.mjs";

/**
 * This file used to hold the ~4,100 lines of sequential checks below inline.
 * They are now ten subject files, split by topic and run here in their
 * original order against the one shared fixture `harness.mjs` builds (the
 * same in-memory bucket, control plane and `rpc`/`call`/`check` helpers every
 * check below was written against). None of these calls is wrapped in
 * `suite()` — a throw during this shared-fixture portion of the file always
 * killed the whole process before the split, and still does; `suite()`'s own
 * comment below explains why that is deliberate for the checks that come
 * after it, not for these.
 */
await runProtocolBasicsChecks();
await runTransportSecurityChecks();
await runTokenTransportChecks();
await runProtocolVersioningChecks();
await runOrientVisibilityChecks();
await runPrivacyAclChecks();
await runProposalsAndArchiveChecks();
await runMovesAndBatchChecks();
await runInboxCaptureChecks();
await runAttachmentsCoreChecks();
await runAttachmentsEdgeChecks();
await runUploadedImageChecks();
await runImageUploadLinkChecks();
await runPictureCompressionChecks();

await suite("runStoreChecks", () => runStoreChecks(check, {
  // The hostile-backend checks need a real way in; there is only one.
  env,
  ownerToken: accessTokenFor("priv-token"),
}));

// Every suite that stands up its own world (its own control plane, bucket or
// fake server) runs from test/isolated.mjs instead, in shards beside this
// process; see test/run.mjs. What stays here is what reads or writes the one
// shared fixture harness.mjs builds.

await suite("runCommentFormatChecks", () => runCommentFormatChecks(check));
await suite("runCommentToolChecks", () => runCommentToolChecks(check, { call, controlPlane, contextStore, storedText, WORKSPACE_ID }));

/*
  A MESSAGE DEEP LINK IS A KEY THE READ TOOLS ACCEPT.

  `search_notes` prints a channel-day hit as `<notePath>#<anchor>` and an
  agent's next move is `read_note` on exactly that string; the ChatGPT
  dialect's entire contract is `search` then `fetch(id)`. Reviewed as a round
  trip rather than as two features: the shape the answer hands out is asserted
  in `commsSearchIndex.test.mjs`, and what the tools do with that shape is
  asserted here, against the real worker.

  Seeded here, at the end of this file's shared-fixture assertions, so one
  extra object in the bucket cannot move a count somebody above is asserting.
*/
{
  const dayPath = "0-inbox/email/name-at-example-com/2026-09-07.md";
  const event = {
    channel: "email",
    account: "name-at-example-com",
    messageId: "<deep-link@mail.example.net>",
    threadId: "thread-1",
    sentAt: "2026-09-07T09:14:00.000Z",
    subject: "Quarterly numbers",
    from: { name: "Adam Okonkwo", address: "adam@example.net" },
    to: [{ address: "name@example.com" }],
    body: "DEEPLINKWORD in the body of one message",
    attachments: [],
  };
  await contextStore.put(
    dayPath,
    renderChannelDayNote({
      channel: "email",
      account: "name-at-example-com",
      address: "name@example.com",
      date: "2026-09-07",
      nonce: "0123456789abcdef",
      now: "2026-09-07T18:04:11.221Z",
      events: [event],
    })
  );
  const anchor = messageAnchor(event);
  const deepLink = `${dayPath}#${anchor}`;

  const read = await call("priv-token", "read_note", { path: deepLink });
  check(
    "read_note opens the containing note when handed a search hit's message deep link",
    (read?.content?.[0]?.text || "").includes("DEEPLINKWORD")
  );
  check(
    "...and reports the note's own path, never the key with the anchor still on it",
    (read?.content?.[0]?.text || "").includes(`path: ${dayPath}`) &&
      lacks(read?.content?.[0]?.text, `path: ${deepLink}`)
  );
  const fetched = await call("chatgpt-token", "fetch", { id: deepLink });
  check(
    "the ChatGPT dialect's fetch takes the id its own search would have handed out",
    (fetched?.content?.[0]?.text || "").includes("DEEPLINKWORD")
  );
  check(
    "...answering under the note's id, so a second fetch of it is the same call",
    (fetched?.content?.[0]?.text || "").includes(`"id":"${dayPath}"`)
  );
  // Only a well-formed trailing anchor is one: a `#` in a path stays a
  // character in a path, and nothing here invents a note that does not exist.
  const notAnAnchor = await call("priv-token", "read_note", { path: `${dayPath}#msg-nothex` });
  check(
    "a trailing # that is not a message anchor is still part of the path, and still not found",
    (notAnAnchor?.content?.[0]?.text || "").includes("not found")
  );
  const teamRead = await call("team-token", "read_note", { path: deepLink });
  check(
    "and the deep link is no way around canSee: a team connection cannot read a private day through one",
    (teamRead?.content?.[0]?.text || "").includes("not found")
  );
}

console.log(getFailures() ? `\n${getFailures()} FAILURES` : "\nALL PASS");
