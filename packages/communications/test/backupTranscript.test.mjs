// The Messages backup read back as transcripts: one Markdown file per
// conversation per month, pictures linked beside it.
//
// SABOTAGE RECORD — applied to src/backupTranscript.js, suite re-run, reverted:
//
//   fold keeping the first record of a key, not the last     -> 3 checks failed
//   safeSegment keeping "/"                                  -> 1 check failed
//   two conversations with one name sharing a folder         -> 1 check failed
//   links: false still linking pictures                      -> 1 check failed

import { foldRecords, safeSegment, transcriptFiles } from "../src/backupTranscript.js";

const message = (id, at, extra = {}) => ({ v: 1, kind: "message", id, chat: "chat-ada", at, me: false, from: "+15550100", text: `words ${id}`, service: "iMessage", ...extra });

export function runBackupTranscriptChecks(check) {
  const fold = foldRecords([
    { v: 1, kind: "chat", id: "chat-ada", members: ["+15550100"], service: "iMessage" },
    { v: 1, kind: "person", handle: "+15550100", name: "Ada Okafor" },
    message("m-1", "2026-10-21T17:12:00.000Z", { text: "Dinner at 4" }),
    message("m-1", "2026-10-21T17:12:00.000Z", { text: "Dinner at 5", edited: "2026-10-21T17:20:00.000Z" }),
    message("m-2", "2026-10-21T17:13:00.000Z", { me: true, from: undefined, text: "", files: [{ id: "0123456789abcdef0123456789abcdef", name: "IMG_1.HEIC" }, { name: "old.pdf" }] }),
    message("m-3", "2026-10-22T08:00:00.000Z", { text: "taken back" }),
    message("m-3", "2026-10-22T08:00:00.000Z", { text: "", unsent: true }),
    message("m-4", "2026-09-30T23:59:00.000Z", { text: "Last month" }),
    { v: 1, kind: "reaction", id: "r-1", chat: "chat-ada", at: "2026-10-21T17:14:00.000Z", me: true, target: "m-1", reaction: "loved" },
    { v: 1, kind: "reaction", id: "r-2", chat: "chat-ada", at: "2026-10-21T17:15:00.000Z", me: true, target: "m-1", reaction: "liked", removed: true },
  ]);
  const files = transcriptFiles(fold);
  check("transcripts: one file per conversation per month, named for the person", files.map((f) => f.path).join() === "Ada Okafor/2026-09.md,Ada Okafor/2026-10.md");
  const october = files[1].text;
  check("transcripts: the later record of a text wins", october.includes("Ada Okafor: Dinner at 5 (edited)") && !october.includes("Dinner at 4"));
  check("transcripts: an unsent text keeps no words", october.includes("Ada Okafor: (unsent)") && !october.includes("taken back"));
  check("transcripts: a copied picture is linked beside the transcript, one never copied is named", october.includes("[IMG_1.HEIC](files/0123456789abcdef0123456789abcdef-IMG_1.HEIC)") && october.includes("(old.pdf)"));
  check("transcripts: the pictures to write are listed with what names their bytes", files[1].files.length === 1 && files[1].files[0].messageId === "m-2" && files[1].files[0].path === "files/0123456789abcdef0123456789abcdef-IMG_1.HEIC");
  check("transcripts: a tapback reads as one, and one taken back is left out", october.includes("You loved “Dinner at 5”") && !october.includes("liked"));
  check("transcripts: days are headed and times say they are UTC", october.includes("**Wed 21 October**") && october.includes("Times are UTC.") && october.includes("- 17:12 · "));
  const plain = transcriptFiles(fold, { links: false });
  check("transcripts: a text-only copy names every file and links none", plain[1].files.length === 0 && plain[1].text.includes("(IMG_1.HEIC)") && !plain[1].text.includes("](files/") && plain[1].text.includes("Dinner at 5"));

  check("transcripts: a name is one safe path segment", safeSegment("../../etc/passwd") === "etc passwd" && safeSegment("A/B:C") === "A B C" && safeSegment("\u202eevil") === "evil" && safeSegment("") === "Conversation");
  const twins = transcriptFiles(foldRecords([
    { v: 1, kind: "chat", id: "c1", name: "Family", members: [] },
    { v: 1, kind: "chat", id: "c2", name: "family", members: [] },
    message("a", "2026-10-01T00:00:00.000Z", { chat: "c1" }),
    message("b", "2026-10-01T00:00:00.000Z", { chat: "c2" }),
  ]));
  check("transcripts: two conversations with one name keep two folders", new Set(twins.map((f) => f.path.split("/")[0].toLowerCase())).size === 2);
}
