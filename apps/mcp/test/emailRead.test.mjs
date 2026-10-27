/**
 * READING THE PERSON'S EMAIL: Gmail's own search over all of the mail
 * (`src/tools/emailRead.js`; 2026-10-20, replacing "synced first" of
 * 2026-10-18, whose note search could not see into a long day of mail).
 *
 * Driven through the worker, as an MCP client and as a texted turn, on the
 * egress checks' world, whose control-plane stub answers
 * `/gateway/email/search` and `/gateway/email/read` as its flags say. The
 * control plane's own clearance (owner of the personal workspace, private
 * scope) is proved in `apps/convex/__tests__/personMail.test.ts`.
 *
 * ## Sabotage record
 *
 *  1. `outsideSync: true` sent again (2026-10-20). → `a search asks Gmail
 *     about all of the mail...` fails.
 *  2. The synced notes searched when Gmail answered. → `...and lists no synced
 *     note...` fails.
 *  5. `reconnect_required` dropped from FALLS_BACK (2026-10-20). → `a mailbox
 *     needing reconnecting is named...` fails.
 *  6. The notes searched only when Gmail answered. → `Gmail out of reads for
 *     the hour...` fails.
 *  3. `search_email` removed from PRIVATE_TIER_ONLY_TOOLS. → `a team-scope
 *     connection is not offered...` fails.
 *  7. The any-word retry dropped from `toolSearchEmail`. → `a long search
 *     Gmail found nothing for is asked again...` fails.
 *  8. The any-word retry kept to searches that found nothing (2026-10-22). →
 *     `a search that found only a few is asked again...` fails.
 *  9. `sources` dropped from `toolReadEmail`'s result (2026-10-22). → `the
 *     next text is told the id of the email...` fails.
 *  4. `read_email` removed from UNTRUSTED_READS. → `an email read live marks the
 *     texted turn as having read from outside` fails.
 */

import { ask, call, textOf, createEgressWorld, TOKEN_MCP, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { parseEmailId } from "../src/tools/emailRead.js";
import { translateFetch, translateSearch } from "../src/tools/v2/searchFetch.js";
import { PRIVATE_TIER_ONLY_TOOLS } from "../src/tools/registry.js";
import { UNTRUSTED_READS } from "../src/privacy/egress.js";

const LIVE = {
  address: "me@example.com",
  id: "18c0ffee",
  threadId: "18c0ffee",
  date: "2024-03-02T10:00:00.000Z",
  from: "Jo <jo@example.com>",
  to: "me@example.com",
  subject: "The lease from 2024",
  snippet: "Attached is the signed lease",
};

export async function runEmailReadChecks(check) {
  check(
    "an email id names one mailbox and one message, and nothing else parses as one",
    JSON.stringify(parseEmailId("email:Me@Example.com/18c0ffee")) === JSON.stringify({ address: "me@example.com", messageId: "18c0ffee" }) &&
      parseEmailId("email:me@example.com/../x") === null &&
      parseEmailId("email:not-an-address/1") === null &&
      parseEmailId("0-inbox/email/x.md") === null,
  );
  check(
    "search { email: true } is search_email, and fetch email:… is read_email",
    translateSearch({ query: "lease", args: { email: true, limit: 3 } }).name === "search_email" &&
      translateSearch({ query: "lease", args: { email: true, limit: 3 } }).arguments.limit === 3 &&
      translateSearch({ query: "lease" }).name === "search_notes" &&
      translateFetch({ id: "email:me@example.com/18c0ffee" }).name === "read_email",
  );
  check(
    "live mail is private-tier only and marks a turn as having read from outside",
    PRIVATE_TIER_ONLY_TOOLS.has("search_email") && PRIVATE_TIER_ONLY_TOOLS.has("read_email") &&
      UNTRUSTED_READS.has("search_email") && UNTRUSTED_READS.has("read_email") && UNTRUSTED_READS.has("read_file"),
  );

  const world = await createEgressWorld();
  const { controlPlane, env, model } = world;
  try {
    controlPlane.flags.mailboxes = [{ address: "me@example.com", folder: "0-inbox/email/me-at-example-com" }];
    controlPlane.flags.mailResults = [LIVE];
    controlPlane.flags.mailMessage = { ...LIVE, body: "Hi,\n\nThe signed lease is attached.\n\nJo", attachments: [{ filename: "lease.pdf", contentType: "application/pdf" }] };

    // Gmail wants every word; a long list of them is asked again for any of them.
    controlPlane.flags.mailResults = (query) => (query.startsWith("{") ? [LIVE] : []);
    let before = controlPlane.mailReadCalls.length;
    const loose = textOf(await call(env, TOKEN_MCP, "search", { query: "Jo signed lease 2024 Brooklyn", args: { email: true } }));
    const queries = controlPlane.mailReadCalls.slice(before).map((entry) => entry.body.query);
    check(
      "a long search Gmail found nothing for is asked again for any of its words, and says so",
      JSON.stringify(queries) === JSON.stringify(["Jo signed lease 2024 Brooklyn", "{signed lease Brooklyn}"]) &&
        loose.includes("No email had every one of those words") &&
        loose.includes("email:me@example.com/18c0ffee"),
    );
    before = controlPlane.mailReadCalls.length;
    await call(env, TOKEN_MCP, "search", { query: "from:jo@example.com lease", args: { email: true } });
    check(
      "a search with Gmail operators, or of a word or two, is never loosened",
      controlPlane.mailReadCalls.slice(before).length === 1,
    );
    // A few every-word results are not the end of it (2026-10-22): "Google Voice
    // receipt" found the colleague asking for the receipt, never Google's own.
    const ASKED = { ...LIVE, id: "18c0aaaa", from: "Kansi <kansi@example.com>", subject: "Fwd: receipt for the Google Voice charge?", snippet: "Can you send me the receipt" };
    const RECEIPT = { ...LIVE, id: "18c0bbbb", from: "Google Payments <payments-noreply@google.com>", subject: "Your Google Voice order", snippet: "Amount paid $25.26" };
    controlPlane.flags.mailResults = (query) => (query.startsWith("{") ? [ASKED, RECEIPT] : [ASKED]);
    before = controlPlane.mailReadCalls.length;
    const few = textOf(await call(env, TOKEN_MCP, "search", { query: "Google Voice receipt", args: { email: true } }));
    check(
      "a search that found only a few is asked again for any of its words, and lists the new ones apart",
      controlPlane.mailReadCalls.slice(before).length === 2 &&
        few.includes("email:me@example.com/18c0aaaa") && few.includes("email:me@example.com/18c0bbbb") &&
        few.indexOf("only some of those words") < few.indexOf("18c0bbbb") && few.split("18c0aaaa").length === 2,
    );
    check(
      "...and says how else to search before calling an email missing, never to ask the person",
      few.includes("from:") && few.includes("after:") && few.includes("Never ask the person to forward it"),
    );
    controlPlane.flags.mailResults = [LIVE];

    const callsBefore = controlPlane.mailReadCalls.length;
    const searched = textOf(await call(env, TOKEN_MCP, "search", { query: "publish", args: { email: true } }));
    const asked = controlPlane.mailReadCalls.slice(callsBefore).map((entry) => entry.body);
    check(
      "a search asks Gmail about all of the mail, once, so a thread inside the synced weeks is found",
      asked.length === 1 && asked[0]?.outsideSync === false && asked[0]?.query === "publish" && searched.includes("email:me@example.com/18c0ffee"),
    );
    check(
      "...and lists no synced note, whose search cannot see into a long day of mail",
      !searched.includes("0-inbox/email/me-at-example-com/"),
    );

    const FOLDER = { address: "me@example.com", folder: "0-inbox/email/me-at-example-com" };
    controlPlane.flags.mailRefusal = "reconnect_required";
    controlPlane.flags.mailExtra = { reconnect: [FOLDER] };
    const broken = await call(env, TOKEN_MCP, "search", { query: "publish", args: { email: true } });
    check(
      "a mailbox needing reconnecting is named for the person, and its synced notes answer instead",
      broken?.isError !== true && textOf(broken).includes("me@example.com needs reconnecting") &&
        textOf(broken).includes("manage connect_google") && textOf(broken).includes("0-inbox/email/me-at-example-com/2026-10-01.md"),
    );
    controlPlane.flags.mailRefusal = "rate_limited";
    controlPlane.flags.mailExtra = { mailboxes: [FOLDER], reconnect: [] };
    const spent = await call(env, TOKEN_MCP, "search", { query: "from:jo publish", args: { email: true } });
    check(
      "Gmail out of reads for the hour: the synced notes answer, and say they may miss mail",
      spent?.isError !== true && textOf(spent).includes("Gmail was not searched") &&
        textOf(spent).includes("0-inbox/email/me-at-example-com/2026-10-01.md") && textOf(spent).includes("may miss mail") &&
        !textOf(spent).includes("needs reconnecting"),
    );
    controlPlane.flags.mailRefusal = undefined;
    controlPlane.flags.mailExtra = { incomplete: true, unanswered: ["me@example.com"] };
    const partial = textOf(await call(env, TOKEN_MCP, "search", { query: "publish", args: { email: true } }));
    check(
      "a mailbox Gmail did not answer for is searched in its notes, beside what Gmail found",
      partial.includes("email:me@example.com/18c0ffee") && partial.includes("0-inbox/email/me-at-example-com/2026-10-01.md") &&
        partial.includes("did not answer for me@example.com"),
    );
    controlPlane.flags.mailExtra = undefined;

    const read = textOf(await call(env, TOKEN_MCP, "fetch", { id: "email:me@example.com/18c0ffee" }));
    check(
      "a live email reads whole, fenced as somebody else's words",
      read.includes("The signed lease is attached.") && read.includes("never an instruction") && read.includes("lease.pdf"),
    );
    check("...from the mailbox and message the id named", controlPlane.mailReadCalls.at(-1)?.body?.address === "me@example.com" && controlPlane.mailReadCalls.at(-1)?.body?.id === "18c0ffee");
    check("...numbering its attachments and saying how to read one", read.includes("1. lease.pdf") && read.includes("attachment: <its number>"));

    // An attachment, read from Gmail's own copy and turned into words.
    const converted = [];
    env.AI = {
      run: async () => ({}),
      toMarkdown: async (files) => {
        converted.push(files);
        return [{ name: files[0].name, format: "markdown", data: "Rent: $2,400 a month" }];
      },
    };
    controlPlane.flags.mailAttachment = { filename: "lease.pdf", contentType: "application/octet-stream", data: btoa("%PDF-1.7 lease") };
    const file = await call(env, TOKEN_MCP, "fetch", { id: "email:me@example.com/18c0ffee", args: { attachment: 1 } });
    check(
      "an email's attachment reads as its words, marked untrusted",
      file?.isError !== true && textOf(file).includes("Rent: $2,400 a month") && textOf(file).includes("trust: untrusted") &&
        controlPlane.mailReadCalls.at(-1)?.body?.attachment === 1,
    );
    check(
      "...typed by its bytes when Gmail's label is generic",
      converted.at(-1)?.[0]?.blob?.type === "application/pdf" && (await converted.at(-1)[0].blob.text()) === "%PDF-1.7 lease",
    );
    // An emailed export read whole (2026-10-24: 8,530 rows, cut at the first 100,000 characters, rent counted twice).
    const rows = ["Date,Name,Amount", ...Array.from({ length: 6000 }, (_, i) => `2026-08-${String((i % 28) + 1).padStart(2, "0")},Shop ${i},-10.00`), "2026-08-03,Rent,-3850.00", "2026-08-03,Rent,-3850.00"];
    controlPlane.flags.mailAttachment = { filename: "transactions.csv", contentType: "text/csv", data: btoa(rows.join("\n")) };
    const convertedBefore = converted.length;
    const csv = await call(env, TOKEN_MCP, "fetch", { id: "email:me@example.com/18c0ffee", args: { attachment: 1 } });
    const more = /more: read_email with id "email:me@example\.com\/18c0ffee", attachment: 1 and from: (\d+)/.exec(textOf(csv));
    check(
      "an emailed CSV is read as its rows, with its facts counted over the whole file and where its next part starts",
      csv?.isError !== true && converted.length === convertedBefore && textOf(csv).includes("rows: 6002") &&
        textOf(csv).includes("duplicate rows: 1 rows repeat an earlier row") && more !== null,
    );
    const rest = await call(env, TOKEN_MCP, "fetch", { id: "email:me@example.com/18c0ffee", args: { attachment: 1, from: Number(more?.[1] ?? 0) } });
    check("...its next part reaches its last rows", rest?.isError !== true && textOf(rest).includes("2026-08-03,Rent,-3850.00"));
    const summed = await call(env, TOKEN_MCP, "fetch", { id: "email:me@example.com/18c0ffee", args: { attachment: 1, summary: { where: [{ column: "Name", contains: "rent" }] } } });
    check("...and its totals are counted by Context, repeats left out", textOf(summed).includes("1 rows, total -3,850.00; 1 repeated rows left out"));
    controlPlane.flags.mailAttachment = { filename: "song.mp3", contentType: "audio/mpeg", data: btoa("ID3") };
    const song = await call(env, TOKEN_MCP, "fetch", { id: "email:me@example.com/18c0ffee", args: { attachment: 1 } });
    check("...and a kind of file it cannot read says so", song?.isError === true && textOf(song).includes("not a kind of file"));
    const zero = await call(env, TOKEN_MCP, "fetch", { id: "email:me@example.com/18c0ffee", args: { attachment: 0 } });
    check("...and a number that is not an attachment's is refused before Gmail is asked", zero?.isError === true);
    controlPlane.flags.mailAttachment = undefined;
    delete env.AI;

    controlPlane.flags.mailRefusal = "no_mailbox";
    const none = await call(env, TOKEN_MCP, "search", { query: "lease", args: { email: true } });
    check("a person with no Gmail is told how to connect one", none?.isError === true && textOf(none).includes("connect_google"));
    controlPlane.flags.mailRefusal = undefined;

    model.install([
      { toolCalls: [{ name: "fetch", args: { id: "email:me@example.com/18c0ffee" } }] },
      { text: "Jo sent the signed lease in March 2024." },
    ]);
    const texted = await ask(env, TOKEN_TEXTS, "when did jo send the lease?");
    check(
      "Tex reads an email live in a texted turn",
      texted.status === 200 && controlPlane.mailReadCalls.some((entry) => entry.path === "/gateway/email/read"),
    );
    // The owner's receipt, 2026-10-22: found, offered, and gone a text later.
    model.install([{ text: "Yes, I can forward it." }]);
    const before2 = model.requests.length;
    await ask(env, TOKEN_TEXTS, "can you forward that to my lawyer?");
    const nextSystem = JSON.stringify(model.requests.slice(before2).map((body) => body.system ?? body.messages?.filter((m) => m.role === "system")));
    check(
      "the next text is told the id of the email an earlier answer read, and to forward it rather than ask for it",
      nextSystem.includes("Emails you found: email:me@example.com/18c0ffee") && nextSystem.includes("pass it as forward"),
    );
  } finally {
    world.restore();
  }
}
