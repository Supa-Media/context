// Archiving contact pages with no activity in a year, and bringing them back.
//
// SABOTAGE RECORD (each broken on purpose, suite run, then restored)
//   isDormantContactPage answers true for any rendered page        -> 4 checks failed
//   drop the hasPendingReview check from isDormantContactPage      -> 2 checks failed
//   drop the isContactNote gate from isDormantContactPage          -> 2 checks failed
//   newestActivityDate answers "0000-01-01" for no activity        -> 5 checks failed
//   ignore `limit` (sweep every candidate)                         -> 3 checks failed
//   skip the re-read: move straight from the lookup's candidates   -> 3 checks failed
//   archive to a path that is not the mirror                       -> 6 checks failed
//   drop the hold-back filter from dormantPages                    -> 1 check failed
//   let a thrown move escape the sweep                             -> 1 check failed
//   the lookup forgets the activity date (`a: ""`)                 -> 10 checks failed

import { renderContactNote } from "../src/contacts.js";
import { CONTACT_INDEX_VERSION, createContactLookup, upsertContactDraft } from "../src/contactLookup.js";
import {
  dormancyCutoff,
  hasPendingReview,
  isDormantContactPage,
  newestActivityDate,
  sweepDormantContacts,
} from "../src/contactDormancy.js";
import { archivedContactPath, liveContactPathForArchived } from "../src/paths.js";
import { memoryBucket } from "./contactLookup.test.mjs";

const NOW = "2026-10-12T12:00:00.000Z";
const OLD = "2025-09-01";
const RECENT = "2026-09-01";

function activity(dates) {
  return dates.map((date, index) => ({
    date,
    channel: "email",
    path: `inbox/email/owner/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`,
    anchor: `msg-${String(index + 1).padStart(16, "0")}`,
    label: "hello",
  }));
}

function page(name, email, dates, extra = {}) {
  return renderContactNote({
    name,
    slug: "x",
    now: "2026-01-01T00:00:00.000Z",
    identifiers: [{ kind: "email", value: email }],
    activity: activity(dates),
    ...extra,
  });
}

const lookupFor = (bucket) => createContactLookup({ list: bucket.list, read: bucket.read });
const keysUnder = (bucket, prefix) => [...bucket.objects.keys()].filter((key) => key.startsWith(prefix)).sort();

export async function runContactDormancyChecks(check) {
  // -- the rule, on bytes ---------------------------------------------------
  check("the cutoff is a year before now, as a day",
    dormancyCutoff(NOW) === "2025-10-12" && dormancyCutoff(new Date(NOW)) === "2025-10-12" && dormancyCutoff("not a time") === null);
  check("the newest dated activity is what counts, whatever order the lines are in",
    newestActivityDate(page("A", "a@example.net", [OLD, RECENT, "2024-01-01"])) === RECENT &&
      newestActivityDate(page("A", "a@example.net", [])) === null);
  check("a page whose newest activity is older than a year is dormant", isDormantContactPage(page("A", "a@example.net", [OLD]), NOW));
  check("...and one with activity inside the year is not", !isDormantContactPage(page("A", "a@example.net", [OLD, RECENT]), NOW));
  check("...nor one exactly a year old to the day",
    !isDormantContactPage(page("A", "a@example.net", ["2025-10-12"]), NOW) && isDormantContactPage(page("A", "a@example.net", ["2025-10-11"]), NOW));
  check("a page with no dated activity is never dormant", !isDormantContactPage(page("A", "a@example.net", []), NOW));
  check("a review: question keeps a page live, inline or as a list",
    hasPendingReview(page("A", "a@example.net", [OLD], { frontmatter: ['review: "possible duplicate"'] })) &&
      hasPendingReview(page("A", "a@example.net", [OLD], { frontmatter: ["review:", "  - is this Claire?"] })) &&
      !isDormantContactPage(page("A", "a@example.net", [OLD], { frontmatter: ['review: "possible duplicate"'] }), NOW));
  check("...and an empty one does not",
    ['review: ""', "review: []", "review:", "review: null"].every((line) =>
      !hasPendingReview(page("A", "a@example.net", [OLD], { frontmatter: [line] }))) &&
      isDormantContactPage(page("A", "a@example.net", [OLD], { frontmatter: ['review: ""'] }), NOW));
  check("owner-written notes do not keep a page live (the archive is recoverable)",
    isDormantContactPage(page("A", "a@example.net", [OLD], { notes: "Met at the conference." }), NOW));
  check("the archive path is the live path one prefix down, and its exact inverse",
    archivedContactPath("inbox/contacts/c/claire.md") === "archive/inbox/contacts/c/claire.md" &&
      liveContactPathForArchived(archivedContactPath("inbox/contacts/c/claire.md")) === "inbox/contacts/c/claire.md" &&
      archivedContactPath("1-projects/claire.md") === null && archivedContactPath("archive/inbox/contacts/c/claire.md") === null);

  // -- the sweep --------------------------------------------------------------
  {
    const imported = "---\ntitle: \"Alex\"\nrole: communication-contact\n---\n\n# Alex\n\n## Identities\n\n- iMessage: `+1 (555) 123-4567`\n\n- 2024-01-01 · imessage — [[inbox/imessage/2024/01/2024-01-01|hi]]\n";
    const handWritten = "# Bob\n\n## Activity\n\n- 2024-01-01 · email — [[inbox/email/owner/2024/01/2024-01-01|hi]]\n";
    const bucket = memoryBucket({
      "inbox/contacts/c/claire.md": page("Claire", "claire@example.net", [OLD]),
      "inbox/contacts/d/dana.md": page("Dana", "dana@example.net", [OLD, RECENT]),
      "inbox/contacts/e/eve.md": page("Eve", "eve@example.net", [OLD], { frontmatter: ['review: "possible duplicate of [[inbox/contacts/e/eve-2]]"'] }),
      "inbox/contacts/imessage/alex.md": imported,
      "inbox/contacts/b/bob.md": handWritten,
      "inbox/contacts/f/fay.md": page("Fay", "fay@example.net", []),
    });
    const result = await sweepDormantContacts(lookupFor(bucket), bucket.io, { now: NOW });
    check("a dormant page is moved to its archive mirror",
      bucket.text("archive/inbox/contacts/c/claire.md")?.includes("# Claire") && bucket.text("inbox/contacts/c/claire.md") === null &&
        result.archived.length === 1 && result.archived[0] === "archive/inbox/contacts/c/claire.md");
    check("an active page is kept", bucket.text("inbox/contacts/d/dana.md") !== null);
    check("a page waiting on review is kept", bucket.text("inbox/contacts/e/eve.md") !== null);
    check("an imported page is kept, however old", bucket.text("inbox/contacts/imessage/alex.md") === imported);
    check("a hand-written note in the contacts folder is kept", bucket.text("inbox/contacts/b/bob.md") === handWritten);
    check("a page with no dated activity is kept", bucket.text("inbox/contacts/f/fay.md") !== null);
    check("...and the archive holds exactly the one page", keysUnder(bucket, "archive/").length === 1);
    check("a note with year-old activity lines is still not dormant unless this package rendered it",
      newestActivityDate(handWritten) === "2024-01-01" && !isDormantContactPage(handWritten, NOW));
  }
  {
    // The lookup is only a cache: a listing that versions by size can keep
    // calling a page a dormant contact after the owner rewrote it as their own.
    const path = "inbox/contacts/b/bob.md";
    const own = "# Bob\n\n## Activity\n\n- 2024-01-01 · email — [[inbox/email/owner/2024/01/2024-01-01|hi]]\n";
    const bucket = memoryBucket({ [path]: own });
    const stale = { version: CONTACT_INDEX_VERSION, pages: { [path]: { v: bucket.objects.get(path).etag, k: "contact", ids: ["email:bob@example.net"], a: "2024-01-01", r: false } } };
    const lookup = createContactLookup({ list: bucket.list, read: bucket.read, snapshot: stale });
    const listed = await lookup.dormantPages(dormancyCutoff(NOW));
    await sweepDormantContacts(lookup, bucket.io, { now: NOW });
    check("a page the stale lookup calls a dormant contact is re-read and left alone when it is not one",
      listed.includes(path) && bucket.text(path) === own && keysUnder(bucket, "archive/").length === 0);
  }
  {
    const seed = {};
    for (let index = 0; index < 30; index += 1) {
      const name = `person-${String(index).padStart(2, "0")}`;
      seed[`inbox/contacts/p/${name}.md`] = page(name, `${name}@example.net`, [OLD]);
    }
    const bucket = memoryBucket(seed);
    const first = await sweepDormantContacts(lookupFor(bucket), bucket.io, { now: NOW, limit: 25 });
    check("one pass archives no more than its batch",
      first.archived.length === 25 && keysUnder(bucket, "archive/").length === 25 && keysUnder(bucket, "inbox/contacts/").length === 5);
    const second = await sweepDormantContacts(lookupFor(bucket), bucket.io, { now: NOW, limit: 25 });
    check("...and the next pass takes the rest", second.archived.length === 5 && keysUnder(bucket, "inbox/contacts/").length === 0);
  }
  {
    // Listed (and remembered) as dormant; a message lands before the sweep moves it.
    const path = "inbox/contacts/c/claire.md";
    const bucket = memoryBucket({ [path]: page("Claire", "claire@example.net", [OLD]) });
    const lookup = lookupFor(bucket);
    const listed = await lookup.dormantPages(dormancyCutoff(NOW));
    bucket.put(path, page("Claire", "claire@example.net", [OLD, "2026-10-12"]));
    const result = await sweepDormantContacts(lookup, bucket.io, { now: NOW });
    check("a page that gained activity between listing and move is kept",
      listed.includes(path) && bucket.text(path) !== null && keysUnder(bucket, "archive/").length === 0 && result.kept === 1);
    check("...and the lookup learns it, so it is no longer a candidate",
      (await lookup.dormantPages(dormancyCutoff(NOW))).length === 0);
  }
  {
    const path = "inbox/contacts/c/claire.md";
    const bucket = memoryBucket({ [path]: page("Claire", "claire@example.net", [OLD]) });
    const lookup = lookupFor(bucket);
    await lookup.dormantPages(dormancyCutoff(NOW));
    bucket.put(path, page("Claire", "claire@example.net", [OLD], { frontmatter: ['review: "same as Claire D.?"'] }));
    await sweepDormantContacts(lookup, bucket.io, { now: NOW });
    check("a review: added between listing and move keeps the page too", bucket.text(path) !== null);
  }
  {
    // A refused move (an older archived copy already sits at the mirror) is
    // held back rather than taking a place in the batch every pass.
    const bucket = memoryBucket({
      "inbox/contacts/a/ada.md": page("Ada", "ada@example.net", ["2024-01-01"]),
      "archive/inbox/contacts/a/ada.md": page("Ada", "ada.old@example.net", ["2023-01-01"]),
      "inbox/contacts/c/claire.md": page("Claire", "claire@example.net", [OLD]),
    });
    const lookup = lookupFor(bucket);
    const first = await sweepDormantContacts(lookup, bucket.io, { now: NOW, limit: 1 });
    const second = await sweepDormantContacts(lookup, bucket.io, { now: NOW, limit: 1 });
    check("a refused move is counted, and the next pass moves on to the next page",
      first.failed === 1 && second.archived[0] === "archive/inbox/contacts/c/claire.md" &&
        bucket.text("inbox/contacts/a/ada.md") !== null);
    const later = await lookup.dormantPages(dormancyCutoff("2026-10-20T00:00:00.000Z"), "2026-10-13");
    check("...and is tried again a week later", later.includes("inbox/contacts/a/ada.md"));
  }
  {
    const bucket = memoryBucket({ "inbox/contacts/c/claire.md": page("Claire", "claire@example.net", [OLD]) });
    const throwing = { ...bucket.io, move: async () => { throw new Error("store unreachable"); } };
    let threw = false;
    let result;
    try {
      result = await sweepDormantContacts(lookupFor(bucket), throwing, { now: NOW });
    } catch {
      threw = true;
    }
    check("a move that throws is counted, never thrown to the sync", !threw && result.failed === 1 && bucket.text("inbox/contacts/c/claire.md") !== null);
  }

  // -- the round trip ---------------------------------------------------------
  {
    const live = "inbox/contacts/c/claire.md";
    const bucket = memoryBucket({ [live]: page("Claire", "claire@example.net", [OLD], { notes: "Met in Lyon." }) });
    const sweep = await sweepDormantContacts(lookupFor(bucket), bucket.io, { now: NOW });
    const draft = {
      name: "Claire",
      identifiers: [{ kind: "email", value: "claire@example.net" }],
      activity: activity(["2026-10-12"]),
      updatedAt: NOW,
    };
    await upsertContactDraft(lookupFor(bucket), draft, bucket.io);
    check("an archived page is revived by that person's next message",
      sweep.archived.length === 1 && bucket.text(live)?.includes("2026-10-12") && bucket.text(live).includes(OLD));
    check("...with no duplicate, live or archived", keysUnder(bucket, "inbox/contacts/").length === 1 && keysUnder(bucket, "archive/").length === 0);
    check("...and the owner's notes come back with it", bucket.text(live).includes("Met in Lyon."));
    const again = await sweepDormantContacts(lookupFor(bucket), bucket.io, { now: NOW });
    check("...and the revived page is not swept again", again.archived.length === 0 && bucket.text(live) !== null);
  }

  // -- the lookup remembers enough to find candidates without reading -------
  {
    const bucket = memoryBucket({ "inbox/contacts/c/claire.md": page("Claire", "claire@example.net", [RECENT]) });
    const first = lookupFor(bucket);
    await first.dormantPages(dormancyCutoff(NOW));
    bucket.stats.reads = 0;
    const second = createContactLookup({ list: bucket.list, read: bucket.read, snapshot: first.snapshot() });
    const candidates = await second.dormantPages(dormancyCutoff(NOW));
    check("a pass handed the snapshot finds no candidate without reading a page", candidates.length === 0 && bucket.stats.reads === 0);
    check("...and the snapshot carries the activity date it decided from",
      first.snapshot().pages["inbox/contacts/c/claire.md"].a === RECENT);
  }
}
