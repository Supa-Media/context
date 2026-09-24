// Gmail sync against a fake Gmail API and an in-memory store.
//
// The fixture server is data-driven rather than a hand-rolled mock of one
// call: it holds a small mailbox (a `Map` of message resources, shaped like
// Google's documented `Message` resource — see
// https://developers.google.com/gmail/api/reference/rest/v1/users.messages)
// and answers `messages.list`, `messages.get`, `users.getProfile` and
// `history.list` the way the real API does for that mailbox, including
// pagination and history's documented 404-on-expired-cursor. Nothing here
// touches the network; `gmailSync.js` never imports one either — it takes
// `fetchImpl` as a parameter, which is what makes this possible.
//
// SABOTAGE RECORD
//   syncOneDay's quota check disabled                            -> 2 checks failed
//   writeDayPart skips the "already exactly this" no-op check    -> 2 checks failed
//   runIncrementalSync lets a 404 propagate instead of catching  -> throws, suite aborts
//   buildDayQuery drops "-in:spam -in:trash"                     -> 1 check failed
//   sanitizeAttachmentFilename stops stripping "/" (no basename) -> 5 checks failed
//   resolveDayAttachments does not check `manifest.resolved` first
//     (always re-fetches)                                        -> 4 checks failed
//   listAllHistory reports the mailbox head after hitting maxPages
//     instead of the last record it walked                       -> 4 checks failed
//   writeDayPart puts unconditionally where the store cannot do
//     a conditional write (no read-compare first)                -> 2 checks failed
//
// This file used to hold every one of these checks directly, in one
// 1,706-line function. It is now a thin facade over `test/gmailSync/*.test.mjs`,
// split by topic, so `import { runGmailSyncChecks } from "./gmailSync.test.mjs"`
// keeps working unchanged and every check still runs in its original order.
// `event`, the parsed message the original file built once and reused across
// the render/quota sections, is threaded through as the one piece of state
// those sections actually share.

import { runGmailParsingAndQueryChecks } from "./gmailSync/parsingAndQuery.test.mjs";
import { runGmailRestCallsChecks } from "./gmailSync/restCalls.test.mjs";
import { runGmailRenderAndWriteChecks } from "./gmailSync/renderAndWrite.test.mjs";
import { runGmailDayAndBackfillChecks } from "./gmailSync/dayAndBackfill.test.mjs";
import { runGmailAttachmentChecks } from "./gmailSync/attachments.test.mjs";
import { runGmailAdversarialFilenameChecks } from "./gmailSync/adversarialFilenames.test.mjs";
import { runGmailAdversarialSyncChecks } from "./gmailSync/adversarialSync.test.mjs";

export async function runGmailSyncChecks(check) {
  const { event } = await runGmailParsingAndQueryChecks(check);
  await runGmailRestCallsChecks(check);
  await runGmailRenderAndWriteChecks(check, { event });
  await runGmailDayAndBackfillChecks(check);
  await runGmailAttachmentChecks(check);
  await runGmailAdversarialFilenameChecks(check);
  await runGmailAdversarialSyncChecks(check);
}
