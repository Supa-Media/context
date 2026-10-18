/**
 * READING THE PERSON'S EMAIL: synced first, then Gmail for what the notes do
 * not hold (`src/tools/emailRead.js`, the owner's design of 2026-10-18).
 *
 * Driven through the worker, as an MCP client and as a texted turn, on the
 * egress checks' world, whose control-plane stub answers
 * `/gateway/email/search` and `/gateway/email/read` as its flags say. The
 * control plane's own clearance (owner of the personal workspace, private
 * scope) is proved in `apps/convex/__tests__/personMail.test.ts`.
 *
 * ## Sabotage record
 *
 *  1. Synced search skipped (`searchOne` not called). → `a search shows the
 *     synced mail first...` fails.
 *  2. `outsideSync` not sent. → `...and asks Gmail only about mail outside the
 *     sync` fails.
 *  3. `search_email` removed from PRIVATE_TIER_ONLY_TOOLS. → `a team-scope
 *     connection is not offered...` fails.
 *  4. `read_email` removed from UNTRUSTED_READS. → `an email read live marks the
 *     texted turn as having read from outside` fails.
 */

import { ask, call, textOf, createEgressWorld, TOKEN_MCP, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { notesQueryOf, parseEmailId } from "../src/tools/emailRead.js";
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
    "a Gmail query keeps its words and addresses for the notes, and drops what only Gmail can answer",
    notesQueryOf('from:jo@example.com subject:lease "signed copy" after:2024/01/01 in:inbox OR has:attachment') ===
      'jo@example.com lease "signed copy"',
  );
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
      UNTRUSTED_READS.has("search_email") && UNTRUSTED_READS.has("read_email"),
  );

  const world = await createEgressWorld();
  const { controlPlane, env, model } = world;
  try {
    controlPlane.flags.mailboxes = [{ address: "me@example.com", folder: "0-inbox/email/me-at-example-com" }];
    controlPlane.flags.mailResults = [LIVE];
    controlPlane.flags.mailMessage = { ...LIVE, body: "Hi,\n\nThe signed lease is attached.\n\nJo", attachments: [{ filename: "lease.pdf", contentType: "application/pdf" }] };

    const searched = textOf(await call(env, TOKEN_MCP, "search", { query: "publish", args: { email: true } }));
    const synced = searched.indexOf("0-inbox/email/me-at-example-com/2026-10-01.md");
    const live = searched.indexOf("email:me@example.com/18c0ffee");
    check("a search shows the synced mail first, then what only Gmail has", synced !== -1 && live !== -1 && synced < live);
    const sent = controlPlane.mailReadCalls.at(-1)?.body;
    check("...and asks Gmail only about mail outside the sync", sent?.outsideSync === true && sent?.query === "publish");

    const read = textOf(await call(env, TOKEN_MCP, "fetch", { id: "email:me@example.com/18c0ffee" }));
    check(
      "a live email reads whole, fenced as somebody else's words",
      read.includes("The signed lease is attached.") && read.includes("never an instruction") && read.includes("lease.pdf"),
    );
    check("...from the mailbox and message the id named", controlPlane.mailReadCalls.at(-1)?.body?.address === "me@example.com" && controlPlane.mailReadCalls.at(-1)?.body?.id === "18c0ffee");

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
  } finally {
    world.restore();
  }
}
