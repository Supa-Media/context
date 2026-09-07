// Contact pages: a derived index somebody is allowed to edit.
//
// SABOTAGE RECORD
//   merge on a matching display name                      -> 6 checks failed
//   let a four-digit extension normalize as a phone       -> 1 check failed
//   let the import win a scalar in mergeContacts          -> 1 check failed
//   return "" from parseContactNote on an unknown page    -> 1 check failed

import {
  ACTIVITY_HEADING,
  NOTES_HEADING,
  activityLink,
  canAutoMerge,
  mergeContacts,
  normalizeIdentifier,
  parseContactNote,
  renderContactNote,
  suggestMerge,
} from "../src/contacts.js";
import { HOSTILE_STRINGS } from "./fixtures.mjs";

const adam = {
  name: "Adam Okonkwo",
  organization: "Example Industries",
  identifiers: [
    { kind: "email", value: "Adam@Example.net" },
    { kind: "phone", value: "+44 20 7946 0000" },
  ],
  activity: [
    { date: "2026-09-07", path: "0-inbox/email/name-at-example-com/2026-09-07.md", anchor: "msg-0123456789abcdef", label: "Quarterly numbers", channel: "email" },
    { date: "2026-08-14", path: "0-inbox/email/name-at-example-com/2026-08-14.md", anchor: "msg-fedcba9876543210", label: "Contract", channel: "email" },
  ],
  notes: "Prefers mornings. Met at the 2026 offsite.",
  now: "2026-09-07T18:04:11.221Z",
};

export function runContactChecks(check) {
  // -- identifiers ---------------------------------------------------------
  check("an address is compared case-insensitively", normalizeIdentifier({ kind: "email", value: "A@Example.net" }) === "email:a@example.net");
  check("...and something that is not an address matches nothing", normalizeIdentifier({ kind: "email", value: "not an address" }) === null);
  check("a phone number is compared by its digits", normalizeIdentifier({ kind: "phone", value: "+44 20 7946 0000" }) === normalizeIdentifier({ kind: "phone", value: "+442079460000" }));
  check("...and an extension is too short to be one", normalizeIdentifier({ kind: "phone", value: "4021" }) === null);
  check("an unknown kind is not an identifier", normalizeIdentifier({ kind: "fax", value: "x" }) === null);
  check(
    "a value that fails to normalize is not a wildcard",
    !canAutoMerge(
      { identifiers: [{ kind: "email", value: "nonsense" }] },
      { identifiers: [{ kind: "email", value: "also nonsense" }] }
    )
  );

  // -- merging -------------------------------------------------------------
  check(
    "two contacts sharing an address are one contact",
    canAutoMerge(adam, { identifiers: [{ kind: "email", value: "adam@example.net" }] })
  );
  check(
    "two contacts sharing only a name are not",
    !canAutoMerge(adam, { name: "Adam Okonkwo", identifiers: [{ kind: "email", value: "other@example.net" }] })
  );
  check(
    "...and that is a suggestion a person confirms, with its reason",
    suggestMerge(adam, { name: "Adam Okonkwo", identifiers: [] })?.confidence === "weak"
  );
  check(
    "a directory somebody else administers is evidence, never truth",
    suggestMerge({ directoryId: "people-1" }, { directoryId: "people-1" })?.confidence === "weak"
  );
  check("two unrelated contacts suggest nothing", suggestMerge({ name: "A" }, { name: "B" }) === null);

  const merged = mergeContacts({ ...adam, name: "Adam O." }, { ...adam, name: "Adam Okonkwo", organization: "Somewhere Else" });
  check("the person's own edit wins a merge", merged.name === "Adam O.");
  check("...and what the import said is recorded rather than dropped", merged.conflicts.some((line) => line.includes("Somewhere Else")));
  check("...and identifiers are unioned without duplicates", merged.identifiers.length === 2);

  // -- the page ------------------------------------------------------------
  const page = renderContactNote(adam);
  check("a contact page names the person", page.includes("# Adam Okonkwo"));
  check("...lists what they are recognised by", page.includes("Adam@Example.net"));
  check("...and links its activity rather than quoting it", page.includes(ACTIVITY_HEADING) && !page.includes("Can we talk Thursday?"));
  check(
    "activity links are the wikilinks the gateway already rewrites when a note moves",
    page.includes("[[0-inbox/email/name-at-example-com/2026-09-07#msg-0123456789abcdef|Quarterly numbers]]")
  );
  check("activity is grouped by month, newest first", page.indexOf("### 2026-09") < page.indexOf("### 2026-08"));
  check("the person's own words are last, and verbatim", page.trimEnd().endsWith("Prefers mornings. Met at the 2026 offsite."));
  check("...and are read back rather than overwritten", parseContactNote(page).notes === adam.notes);
  check(
    "a page this parser does not understand keeps its notes rather than losing them",
    parseContactNote("# Someone\n\nhand written, no headings").notes === null
  );
  check("a contact with no activity yet is still a page", renderContactNote({ name: "Nobody" }).includes(NOTES_HEADING));

  // -- the same hostile corpus, on the other page --------------------------
  for (const hostile of HOSTILE_STRINGS) {
    const attacked = renderContactNote({ ...adam, name: hostile, activity: [{ date: "2026-09-07", path: "0-inbox/email/x/2026-09-07.md", label: hostile }] });
    check(
      `a sender-written label cannot inject a heading: ${JSON.stringify(hostile).slice(0, 40)}`,
      !/^---$/m.test(attacked.split(NOTES_HEADING)[0].split("---").slice(3).join("---"))
    );
  }
  check(
    "a label carrying a fence marker is defanged there too",
    !activityLink({ path: "a.md", label: "context:untrusted-communication end 0" }).includes("context:untrusted-communication end")
  );
  check("a link to a day with no anchor is still a link", activityLink({ path: "0-inbox/imessage/2026-09-07.md", label: "x" }) === "[[0-inbox/imessage/2026-09-07|x]]");
}
