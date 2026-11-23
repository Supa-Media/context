import assert from "node:assert/strict";

import { sixToolsOver } from "../../../../../packages/tex/gateway/agent/sixTools.js";
import { fixedCarriers } from "../../../../../packages/tex/gateway/agent/sixToolsFixed.js";
import { inSixNames, staleToolNames } from "../../../../../packages/tex/gateway/agent/promptNames.js";
import { readEmail } from "../../../src/tools/email.js";

const KANSI = {
  to: ["info@cityleague.example"],
  cc: ["kansi@team.example"],
  subject: "Re: Event venue",
  body: "Hi Dane,\n\nAdding Kansi, who handles our payments.\n\nThanks",
};

export default {
  id: "send-email-shape-fixed",
  incident:
    "2026-11-22: asked to reply to an email looping in the person's financial manager, Tex read the thread and called send three times. The first wrote the email's fields beside the action, the second put the sender in mailbox and the thread id without its email:<address>/ part, the third went back to the flat shape. Each was refused; the third came back without the manual, Tex ended with an empty answer, and the person was texted \"Sorry, my answer to that one got lost.\"",
  cause:
    "The refusals named what was wrong (\"unknown argument from\", \"not an email id\") but never the call that would work; the manual came back with the first failure only; and the words around the tools still taught the older names (\"the id search_email gave\").",
  path: "1:1 text",
  async run() {
    const shown = fixedCarriers("one");
    const six = sixToolsOver([...shown.values()], null, { shown });

    // Try 1: the fields beside the action are refused with the call written out, inside args.
    const flat = six.resolve("send", { action: "email", from: "me@team.example", in_reply_to: "email:me@team.example/1a205a21935afbd5", ...KANSI });
    assert.equal(flat.cause, "bad_arguments");
    assert.match(flat.error, /from, in_reply_to, to, cc, subject, body go inside args/);
    const written = JSON.parse(flat.error.slice(flat.error.indexOf("send {") + "send ".length));
    assert.deepEqual(written, { action: "email", args: { from: "me@team.example", in_reply_to: "email:me@team.example/1a205a21935afbd5", ...KANSI } });
    // ...and the copy it says to make goes through.
    const copied = six.resolve("send", written);
    assert.equal(copied.error, undefined, copied.error);
    assert.equal(copied.name, "send_email");

    // Try 2: the sender in mailbox is moved to args.from in the call it writes.
    const boxed = six.resolve("send", { action: "email", args: KANSI, mailbox: "me@team.example" });
    assert.match(boxed.error, /the mailbox it goes from is args\.from/);
    assert.match(boxed.error, /"from":"me@team\.example"/);

    // A bare thread id is refused with the whole id written out.
    const bare = readEmail({ ...KANSI, from: "me@team.example", in_reply_to: "1a205a21935afbd5" });
    assert.match(bare.error, /Call again with in_reply_to: "email:me@team\.example\/1a205a21935afbd5"/);

    // Every failure carries the manual, not only the first; and the manual names no older tool.
    const first = six.manualOnFailure("send", { action: "email" });
    assert.match(first, /The manual for email/);
    assert.equal(six.manualOnFailure("send", { action: "email" }), first);
    assert.deepEqual(staleToolNames(first), []);
    assert.deepEqual(staleToolNames(inSixNames("Pass the email:<address>/<id> id search_email gave.")), []);
  },
};
