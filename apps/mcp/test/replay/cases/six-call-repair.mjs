import assert from "node:assert/strict";

import { sixToolsOver } from "../../../../../packages/tex/gateway/agent/sixTools.js";
import { fixedCarriers } from "../../../../../packages/tex/gateway/agent/sixToolsFixed.js";

/** Each slip Tex made, rewritten with invented values, and the call it can only have meant. */
export default {
  id: "six-call-repair",
  incident:
    "2026-11-16 to 11-23: 68 of 791 calls Tex made in four chats (8.6%) were refused for their shape, and 23% of turns had one: an email search's dates written as after, from, to or a second query; a picture beside a note's path; an email's fields beside the action; a browse's steps as JSON text; mail: true on an email id. Tex often gave up instead of retrying, and the person got no answer.",
  cause:
    "Every family tool's args is an open object, so the model guessed where a key goes and what it is called, and every guess that had one reading was refused rather than run.",
  path: "1:1 text",
  async run() {
    const shown = fixedCarriers("one");
    const six = sixToolsOver([...shown.values()], null, { shown });
    const ran = (name, args) => {
      const out = six.resolve(name, args);
      assert.equal(out.error, undefined, `${name} ${JSON.stringify(args)}: ${out.error}`);
      return out;
    };

    // An email search's dates and second query are its Gmail query.
    assert.deepEqual(ran("search", { query: "Puttery", args: { email: true, after: "1795201217" } }), {
      name: "search_email",
      args: { query: "Puttery after:1795201217" },
    });
    assert.deepEqual(ran("search", { query: "new mail", args: { email: true, from: "2026-11-19", to: "2026-11-20" } }).args, {
      query: "new mail after:2026/11/19 before:2026/11/21",
    });
    assert.equal(ran("search", { query: "cake", args: { email: true, query: "after:1795129218" } }).args.query, "cake after:1795129218");
    // An account is only an email search's, and a limit past the most is the most.
    assert.deepEqual(ran("search", { query: "Puttery", args: { account: "me@team.example", limit: 20 } }), {
      name: "search_email",
      args: { query: "Puttery", account: "me@team.example", limit: 10 },
    });
    // `email: true` beside the query, and an email search asked for as a send action.
    assert.equal(ran("search", { query: "receipt", email: true }).name, "search_email");
    assert.deepEqual(ran("send", { action: "search_email", args: { query: "newer_than:1d", account: "me@team.example" } }), {
      name: "search_email",
      args: { query: "newer_than:1d", account: "me@team.example" },
    });

    // A picture beside a note's path belongs to the note.
    const saved = ran("write", { action: "save", path: "projects/a.page.md", content: "# A", images: [{ name: "cover.png", url: "https://pictures.example/cover.png" }] });
    assert.equal(saved.name, "write_note");
    assert.deepEqual(saved.args.images, [{ name: "cover.png", url: "https://pictures.example/cover.png" }]);

    // An email read asks for nothing more with mail: true or a from that is no offset.
    assert.deepEqual(ran("fetch", { id: "email:me@team.example/1a1f95e092c19134", args: { mail: true } }).args, { id: "email:me@team.example/1a1f95e092c19134" });
    assert.equal(ran("fetch", { id: "email:me@team.example/1a1f95e092c19134", args: { from: true } }).name, "read_email");

    // A browse's steps as JSON text are the list, and a step under another name for one of its own is that step.
    const steps = ran("send", { action: "browse", steps: '[{"do":"goto","url":"https://venue.example/pricing"},{"do":"read"}]' });
    assert.deepEqual(steps.args.steps, [{ do: "goto", url: "https://venue.example/pricing" }, { do: "read" }]);
    assert.equal(ran("send", { action: "browse", args: { steps: [{ do: "open", url: "https://venue.example" }] } }).args.steps[0].do, "goto");

    // A doubled @ on a workspace is the one workspace.
    assert.equal(ran("fetch", { id: "inbox/meetings/weekly.md", context: "@@team" }).args.context, "@team");

    // What has more than one reading is still refused with its fix: more steps than one call runs, an arg nobody defined.
    const eleven = Array.from({ length: 11 }, () => ({ do: "wait", seconds: 1 }));
    assert.match(six.resolve("send", { action: "browse", args: { steps: eleven } }).error ?? "", /at most 10/);
    assert.match(six.resolve("fetch", { id: "inbox/sessions/one.md", args: { part: 2 } }).error ?? "", /takes args/);
  },
};
