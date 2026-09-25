import { check, rpc, call, lacks, succeeded, contextStore, objects, env, accessTokenFor, worker } from "./harness.mjs";

export async function runProtocolBasicsChecks() {
  // -- protocol basics
  //
  // Every `.result` access below is optional-chained on purpose.
  //
  // A break that makes an early call return an error instead of a result used to
  // throw a TypeError here and kill the process before a single check ran —
  // exit 1, zero PASS, zero FAIL. That looks like detection if you measure by
  // counting FAIL lines, and it is the opposite: the named checks that should
  // own the failure never execute, so they cannot report, and every later check
  // silently becomes dead weight. A crash is a worse signal than a failure
  // because it takes the rest of the suite with it.
  const init = await rpc("priv-token", "initialize", { protocolVersion: "2025-06-18" });
  /*
    The instructions as one line, or the empty string when there are none.

    The comment above says every `.result` access here is optional-chained; six
    of them were not, and `init.result.instructions.replace(...)` is the one that
    throws first. This section runs **outside** any suite, so the `suite` wrapper
    does not cover it — a throw here still takes the whole file, which is what
    the comment is warning about. An absent value has to reach the checks as a
    value they can fail on, and the empty string is that: every assertion below
    is a `test()` that a `""` fails, which is the direction a missing field
    should push a check.

    A `.some()` on a missing list is compared to `true` or `false` explicitly for
    the same reason and against a sharper trap: `!undefined` is `true`, so a
    negated `?.some()` would have turned a broken response into a PASS.
  */
  const instructionsText = () => String(init.result?.instructions ?? "").replace(/\s+/g, " ");
  check("initialize echoes protocol", init.result?.protocolVersion === "2025-06-18");
  check("initialize has instructions", typeof init.result?.instructions === "string" && init.result.instructions.length > 500);
  // PARA is the default scaffold, not the format. The instructions used to state
  // that the context "is organized by the PARA method" and then tell agents to
  // file under `1-projects/` — which is wrong for every customer who chose a
  // custom layout or connected a bucket they had organized years earlier, and
  // those are the people this product exists for. It may be mentioned; it may not
  // be asserted, and it must be paired with the instruction not to assume it.
  check(
    "the instructions do not assert a folder layout",
    !/is organized by the PARA/i.test(instructionsText()) && /Do not assume a layout/i.test(instructionsText())
  );
  // A client asking for a revision from the future must get a counter-offer in a
  // normal result — never a JSON-RPC error, which is how servers actually fail to
  // connect — and the counter-offer must be the newest thing we speak, not an
  // arbitrarily older one.
  const futureInit = await rpc("priv-token", "initialize", { protocolVersion: "2999-01-01" });
  check("an unknown protocol revision is answered, not errored", !futureInit.error);
  check(
    "an unknown protocol revision is counter-offered the newest we support",
    futureInit.result?.protocolVersion === "2025-11-25"
  );
  // `2026-07-28` deleted `initialize`. Counter-offering it to a client that just
  // sent one would name a revision that client cannot possibly speak.
  check(
    "the initialize counter-offer never names a revision that has no initialize",
    futureInit.result?.protocolVersion !== "2026-07-28"
  );
  const olderInit = await rpc("priv-token", "initialize", { protocolVersion: "2024-11-05" });
  check(
    "a revision we still support is echoed rather than upgraded",
    olderInit.result?.protocolVersion === "2024-11-05"
  );
  const versionlessInit = await rpc("priv-token", "initialize", {});
  check(
    "an initialize with no protocolVersion is answered with the newest we support",
    versionlessInit.result?.protocolVersion === "2025-11-25"
  );
  const newestInit = await rpc("priv-token", "initialize", { protocolVersion: "2025-11-25" });
  check(
    "the newest legacy revision is echoed and carries a server description",
    newestInit.result?.protocolVersion === "2025-11-25" &&
      typeof newestInit.result?.serverInfo.description === "string"
  );
  check("initialize prompts proactive durable memory", init.result?.instructions.includes("rediscover"));
  // Compared on whitespace-normalized text: these are wrapped prose, so a phrase
  // that reads as one sentence is two lines in the string, and an `includes` on
  // the sentence fails for a reason that has nothing to do with the meaning.
  const instructionsFlat = instructionsText();
  check(
    "initialize prompts scoped session saving",
    instructionsFlat.includes("save_context") &&
      instructionsFlat.includes("Default privacy follows this connection")
  );
  // The argument for using this at all, which is the only reason the rest gets
  // read. Asserted because it is the part a tidy-up would cut as "not a rule",
  // and because the whole payload is worthless if it opens with housekeeping.
  check(
    "initialize leads with the instruction to orient, in the clear",
    /READ THIS BEFORE YOU ANSWER ANYTHING ELSE/.test(instructionsFlat) &&
      /CALL `orient` FIRST\. EVERY SESSION\./.test(instructionsFlat)
  );
  check(
    "initialize makes the case rather than only stating rules",
    /Skipping it is not a neutral choice/i.test(instructionsFlat) &&
      /richest source of information about this person/i.test(instructionsFlat)
  );
  // It has to reach the model before any housekeeping does. Measured rather than
  // asserted in a comment: a later edit that reinstates a preamble above the
  // instruction is the exact regression this payload was rewritten to undo.
  check(
    "the call to action comes before any of the rules",
    instructionsFlat.indexOf("CALL `orient` FIRST") <
      instructionsFlat.indexOf("FIVE RULES") &&
      instructionsFlat.indexOf("CALL `orient` FIRST") < 500
  );
  const noteRes = await worker.fetch(
    new Request("https://x/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessTokenFor("priv-token")}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }),
    env,
    { waitUntil() {} }
  );
  check("notification → 202", noteRes.status === 202);
  const tools = await rpc("priv-token", "tools/list");
  // 18 became 20 when `search` and `fetch` landed — ChatGPT's ordinary chats can
  // invoke only those two names on a custom connector, so they are the same
  // read capabilities wearing OpenAI's deep-research contract. 21 with
  // `read_image`, which is a read capability over the same access map. 24 with
  // `list_meetings` and `read_meeting`: a meeting is an ordinary note, and these
  // are the two reads that know a transcript is appended to one and that a model
  // has to ask for it. 26 with `list_channel_days` and `read_channel_day`, which
  // are the same pair one layer over: a day of somebody's mail is an ordinary
  // note too, and these are the two reads that know the bodies are appended to
  // one and that a model has to ask for them. 27 with `set_encryption`, which is
  // a write over one note's own bytes and, like `set_visibility` beside it, a
  // personal connection's. 35 adds the owner-only storage-layout migration. 37
  // with `list_contacts` and `read_contact` — the same pair a layer further
  // over, over the people those days were with rather than the days. 39 with
  // `create_form`: the four form tools answer a form and none of them made one,
  // so a form was a feature an agent had to already know the block syntax of.
  // 42 with `create_link`, `list_links` and `revoke_link` — the console has had
  // share links since the beginning and nothing here could mint one, so an agent
  // asked for "a link to send them" wrote a URL out of the path it was holding.
  check("42 tools listed", tools.result?.tools.length === 42);
  check(
    "Folder lists have an explicit read-only server evaluator",
    tools.result?.tools?.find((tool) => tool.name === "evaluate_lists")?.annotations?.readOnlyHint === true,
  );
  check(
    "storage migration is advertised only to an owner-tier connection",
    tools.result?.tools?.some((tool) => tool.name === "migrate_storage_layout") === true &&
      !(await rpc("pub-token", "tools/list"))?.result?.tools?.some(
        (tool) => tool.name === "migrate_storage_layout",
      ),
  );
  check(
    "a direct team-tier migration call is masked like an unknown tool",
    (await call("pub-token", "migrate_storage_layout", {}))?.content?.[0]?.text ===
      "unknown tool: migrate_storage_layout",
  );
  await contextStore.put(".audit/000-layout-tool.json", "legacy audit");
  const layoutMigration = await call("priv-token", "migrate_storage_layout", { batch_size: 1 });
  check(
    "the owner migration tool copies a legacy object without deleting it",
    !layoutMigration.isError &&
      objects.has(".audit/000-layout-tool.json") &&
      objects.has(".context/audit/000-layout-tool.json"),
  );

  // -- list_plugins through the worker
  //
  // The unit checks in `plugins.test.mjs` cover the scan, the inventory and the
  // wording. These three cover the wiring, which nothing else would: the tool is
  // reachable, it is classified read-only so a read-only grant is offered it, and
  // a capture-only grant — which may POST to /inbox and read nothing — cannot use
  // it to read `.obsidian/`, a prefix the privacy manifest has no say over.
  await contextStore.put(
    ".obsidian/plugins/obsidian-git/manifest.json",
    JSON.stringify({ id: "obsidian-git", name: "Obsidian Git", version: "2.33.0" })
  );
  await contextStore.put(
    ".obsidian/plugins/obsidian-git/main.js",
    'const cp = require("child_process");'
  );
  const pluginReport = await call("priv-token", "list_plugins");
  check(
    "list_plugins reads .obsidian/plugins and names the call that refuses one",
    pluginReport?.content?.[0]?.text?.includes("Obsidian Git") &&
      pluginReport.content[0].text.includes("child_process")
  );
  // Both halves through the worker. The unit checks prove the section renders;
  // this proves the tool asks for it, which is the wiring nothing else covers.
  check(
    "and it reports the Context plugins this context is running in the same answer",
    pluginReport.content[0].text.includes("CONTEXT PLUGINS") &&
      pluginReport.content[0].text.includes("context-forms")
  );
  /*
    THIS ASSERTED THE OPPOSITE, AND ITS REASON IS WHAT WAS WRONG.

    It read: "and it is offered to a read-only grant, because it writes nothing."
    Writing nothing is true and is not the question. `.obsidian/` sits outside the
    privacy manifest entirely — `isPlumbing` hides every dot-segment from
    `read_note`, `list_notes` and search, for every role — so `list_plugins` is
    the only read path into that prefix, and the tier that governs it had never
    been decided.

    `readonly-token` owns this context and holds `context:read` alone, so it reads
    at `team`: an owner who deliberately did not hand this client private reach.
    It was being handed every plugin's id, name, version and author, the blocked
    internals each bundle names, and up to twelve hostnames pulled out of bundle
    text. A count over what the grant cannot see, and then the list — which is the
    reasoning that already makes the note census owner-only.

    Corrected rather than deleted, so the next reader sees which of the two
    questions this check used to answer.
  */
  check(
    "and it is NOT offered to a grant that reads at team tier, whatever it writes",
    !(await rpc("readonly-token", "tools/list"))?.result?.tools.some(
      (t) => t.name === "list_plugins"
    )
  );
  check(
    "while a grant that reads private somewhere is offered it",
    (await rpc("priv-token", "tools/list"))?.result?.tools.some((t) => t.name === "list_plugins")
  );
  check(
    "and a team-tier grant that calls it anyway is refused",
    (await call("readonly-token", "list_plugins"))?.isError === true
  );
  check(
    "a capture-only grant cannot read the vault's plugins",
    (await call("inbox-token", "list_plugins")) === undefined ||
      (await call("inbox-token", "list_plugins")).isError === true
  );
  check(
    "a plugin bundle is never reachable as a note",
    (await call("priv-token", "read_note", { path: ".obsidian/plugins/obsidian-git/main.js" }))
      .isError === true
  );

  // -- a Context plugin turned off, through the worker
  //
  // `contextPlugins.test.mjs` covers the file and the catalogue as pure
  // functions. These cover the two places the switch has to reach, which are the
  // two places authority is decided for every other reason as well: the listing
  // and the call. Both, because the listing is cached for a minute and a client
  // remembers a tool name for much longer than that — a switch enforced only in
  // the listing would be a preference an old client could ignore for as long as
  // it liked.
  const enablementKey = ".context/plugins/enabled.json";
  await contextStore.put(
    enablementKey,
    JSON.stringify({ version: 1, enabled: [], disabled: ["context-forms"] })
  );
  const listWithFormsOff = await rpc("priv-token", "tools/list");
  check(
    "a Context plugin turned off takes its tools out of the listing",
    listWithFormsOff.result?.tools.length === 38 &&
      listWithFormsOff.result?.tools?.some((tool) => tool.name === "submit_form") === false
  );
  check(
    "and leaves every tool no plugin owns exactly where it was",
    ["read_note", "write_note", "search", "list_plugins", "set_visibility"].every((name) =>
      listWithFormsOff.result?.tools?.some((tool) => tool.name === name) === true
    )
  );
  const refusedForm = await call("priv-token", "vote_form", {
    path: "1-projects/bugs.md",
    response_id: "r1",
  });
  /*
    One check rather than two, and the text is the load-bearing half.

    "`isError` is true" was written first and is not a test of this gate at all:
    with the gate deleted the call reaches the real handler, which refuses a form
    on a note that does not exist — so the weaker assertion passes on the broken
    build. Sabotage-confirmed, which is how the pair became one.

    "unknown tool" is asserted absent for the reason `report.js` gives about
    refusals generally: that is what a client would otherwise show somebody whose
    own setting caused it, and it names no way back.
  */
  check(
    "a call to a switched-off tool is refused by name, with the way to undo it",
    refusedForm?.isError === true &&
      refusedForm.content?.[0]?.text?.includes("Markdown forms") === true &&
      refusedForm.content[0].text.includes("Plugins") &&
      lacks(refusedForm.content[0].text, "unknown tool")
  );
  // The switch removes a capability, never a protection. `read_note` and the
  // privacy engine behind it are untouched by any decision in that file, and
  // this is the check that stops a later "while we are in here" from folding a
  // guard into the same lookup.
  check(
    "turning a plugin off changes nothing about what a note read is allowed to see",
    succeeded(await call("priv-token", "read_note", { path: "index.md" }))
  );
  // A file nobody can parse means the defaults, and the defaults are on. The
  // opposite failure — a typo in a preferences file taking a workspace's tools
  // away — is the one this fallback exists to prevent.
  await contextStore.put(enablementKey, "{ half a file");
  check(
    "a settings file that does not parse leaves every tool where it was",
    (await rpc("priv-token", "tools/list")).result?.tools.length === 42
  );
  await contextStore.delete(enablementKey);
  check(
    "and removing the file restores the full listing",
    (await rpc("priv-token", "tools/list")).result?.tools.length === 42
  );
  check("set_visibility tool is discoverable", tools.result?.tools.some((tool) => tool.name === "set_visibility"));
  check(
    "set_folder_visibility tool is discoverable",
    tools.result?.tools.some((tool) => tool.name === "set_folder_visibility")
  );
  const writeNoteTool = tools.result?.tools.find((tool) => tool.name === "write_note");
  const setVisibilityTool = tools.result?.tools.find((tool) => tool.name === "set_visibility");
  const setFolderVisibilityTool = tools.result?.tools.find(
    (tool) => tool.name === "set_folder_visibility"
  );
  const scopeInfoTool = tools.result?.tools.find((tool) => tool.name === "scope_info");
  const searchNotesTool = tools.result?.tools.find((tool) => tool.name === "search_notes");
  const saveContextTool = tools.result?.tools.find((tool) => tool.name === "save_context");
  check(
    "write_note advertises only private and team visibility",
    JSON.stringify(writeNoteTool.inputSchema.properties.visibility?.enum) === JSON.stringify(["private", "team"])
  );
  check(
    "set_visibility advertises explicit team-publication confirmation",
    setVisibilityTool?.inputSchema?.properties?.confirm_team_publish?.type === "boolean"
  );
  check(
    "set_folder_visibility supports dry-run, inheritance, and privacy etag protection",
    setFolderVisibilityTool?.inputSchema?.properties?.dry_run?.type === "boolean" &&
      setFolderVisibilityTool?.inputSchema?.properties?.expected_privacy_etag?.type === "string" &&
      setFolderVisibilityTool?.inputSchema?.properties?.visibility?.enum?.includes("inherit")
  );
  check("scope_info advertises an optional path", scopeInfoTool?.inputSchema?.properties?.path?.type === "string");
  check(
    "search_notes advertises an optional performance prefix",
    searchNotesTool?.inputSchema?.properties?.prefix?.type === "string"
  );
  check(
    "save_context exposes no internet-public visibility option",
    JSON.stringify(saveContextTool.inputSchema.properties.visibility?.enum) === JSON.stringify(["private", "team"])
  );
  // The tool shipped as `archive_chat`, and a client that cached the old list is
  // still calling that name. It is deliberately no longer advertised — but a
  // rename that drops somebody's session on the floor is not a rename, it is data
  // loss on the one call whose whole job is not losing anything.
  check(
    "archive_chat is no longer advertised",
    !tools.result?.tools.some((tool) => tool.name === "archive_chat")
  );
  check(
    "tool surface uses team terminology instead of the old public-access wording",
    !/(?:public connections?|writable public|public archive)/i.test(JSON.stringify(tools.result?.tools))
  );
  check(
    "read tools have read-only annotations",
    tools.result?.tools.find((tool) => tool.name === "read_note").annotations.readOnlyHint === true
  );
  await contextStore.put(
    "1-projects/list-source.md",
    "```list\nfrom: 1-projects\nwhere: list-fixture is yes\nsubfolders: yes\nsort: title\n```",
  );
  await contextStore.put(
    "1-projects/list-visible.md",
    "---\ntitle: Visible row\nlist-fixture: yes\n---\n\nVisible",
  );
  await contextStore.put(
    "1-projects/secret-thing/list-hidden.md",
    "---\ntitle: Hidden row\nlist-fixture: yes\n---\n\nHidden",
  );
  const evaluated = await call("pub-token", "evaluate_lists", { path: "1-projects/list-source.md" });
  const evaluatedText = evaluated?.content?.[0]?.text ?? "";
  check(
    "MCP list evaluation returns only rows this connection can open",
    evaluatedText.includes("Visible row") && !evaluatedText.includes("Hidden row") && !evaluatedText.includes('"total"'),
  );
  await contextStore.delete("1-projects/list-source.md");
  await contextStore.delete("1-projects/list-visible.md");
  await contextStore.delete("1-projects/secret-thing/list-hidden.md");

  // -- auth
  const bad = await worker.fetch(
    new Request("https://x/mcp", { method: "POST", body: "{}" }),
    env,
    { waitUntil() {} }
  );
  check("no token → 401", bad.status === 401);
  const teamAliasPing = await rpc("team-token", "ping", {});
  check("an editor grant authenticates as a team connection", !!teamAliasPing?.result);
  check(
    "a second editor grant is an independent connection at the same tier",
    !!(await rpc("pub-token", "ping", {}))?.result
  );
  check(
    "native team scope rules and legacy public scope rules both resolve as team-visible",
    succeeded(await call("team-token", "read_note", { path: "team-native/info.md" })) &&
      succeeded(await call("team-token", "read_note", { path: "1-projects/togather/status.md" }))
  );
  // This asserted the instructions said there was "no anonymous or
  // internet-public tier". That sentence is no longer true of the *product* — an
  // owner can hand out an unlisted link to one note from their console — and a
  // server contract that says something false is worse than one that says less.
  //
  // What is still true, and is the thing a connected client actually has to know,
  // is narrower and stronger: visibility here is private or team, and nothing on
  // this connection can publish past the people the owner named. The check is
  // pinned to that rather than to a phrase, so the day somebody gives an AI
  // client a way to publish, this fails instead of reassuring a model that it
  // cannot do what it just did.
  check(
    "server contract says visibility here is private or team",
    /team/i.test(init.result?.instructions) &&
      /private or team/i.test(init.result?.instructions)
  );

  /**
   * ...AND IT DOES NOT CLAIM THIS CONNECTION CANNOT PUBLISH, BECAUSE IT CAN.
   *
   * The check above used to also require the instructions to say no tool here can
   * publish past the people the owner named, and its own comment said it existed
   * so that "the day somebody gives an AI client a way to publish, this fails
   * instead of reassuring a model that it cannot do what it just did".
   *
   * That day was the same commit. An unlisted share serves the entry note **and
   * the notes the entry note links to**, resolved from its live body on every
   * read (`functions/lib/noteLinks.ts`, an authorization input by its own
   * header), with `/x.md` resolving from the bucket root. Nothing in the write
   * path or in this gateway knows a share exists. So `write_note` adding one
   * markdown link to a note somebody already handed an unlisted link to publishes
   * any team-visible note in that bucket to anyone holding the link -- which is
   * the ordinary shape of "add a reference to the salaries note in the plan".
   *
   * The reasoning that missed it stopped at "no tool here is named publish".
   * Publishing is not a tool, it is a consequence of an edit.
   *
   * So the instructions state what is true and say what an agent can actually act
   * on, and this pins BOTH halves: the absolute must not come back, and the
   * warning that replaces it must not quietly go away.
   */
  check(
    "and does not claim this connection cannot publish, because an edit can",
    // Word-anchored. Unanchored, `not` matches inside "note", and the warning
    // this check exists to protect trips its own assertion.
    !/\b(?:no|not|never|cannot|can't)\b[^\n.]{0,60}publish/i.test(init.result?.instructions)
  );
  check(
    "instead it warns that a link added to a note can widen a link already sent",
    /widen/i.test(init.result?.instructions) &&
      /\blinks?\b[^\n]{0,80}\bwiden|\bwiden[^\n]{0,80}\blinks?\b/i.test(
        init.result?.instructions
      )
  );

  // -- Origin validation on the Streamable HTTP transport (DNS rebinding)
  //
  // The whole point of this control is that a browser sets `Origin` and page
  // script cannot override it. So these checks are written the way a browser
  // would send them: a header that is either absent (every non-browser client) or
  // a serialized origin — never a plausible-looking string a server invented.
  //
  // ## Sabotage record
  //
  // A guard nobody has checked is not a guard, so `src/origin.js` was broken
  // thirteen ways as temporary local edits and each break was confirmed to fail a
  // named check below. Nothing ships to reproduce them — a switch that disables
  // origin validation is not something that belongs in a deployable artifact:
  //
  //   `null` folded in with an absent header ......... 1 check
  //   exact match weakened to endsWith ............... 2 checks
  //   exact match weakened to startsWith ............. 3 checks
  //   absent Origin treated as an attack ............. suite dies at the first RPC
  //   raw header compared instead of the normalized .. 2 checks
  //   opaque origins accepted after parsing .......... 1 check
  //   wildcard entries given wildcard meaning ........ 1 check
  //   /inbox dropped from the guarded paths .......... 1 check
  //   guard moved below the OPTIONS short-circuit .... 1 check
  //   refusal varying with the caller's token ........ 1 check
  //   guard applied before the token is stripped ..... 1 check
  //   unconfigured allowlist failing open ............ 1 check
  //   empty Origin header read as absent ............. 1 check
  //
  // The opaque-origin case is here *because* of that pass: the first version
  // refused `null` on the header side only, an allowlist entry of `file://`
  // normalized to the string "null" and matched it, and every other check in this
  // file stayed green.

}
