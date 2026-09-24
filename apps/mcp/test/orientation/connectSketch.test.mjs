/**
 * The connect-time sketch: `initialize` embeds a live sketch of the context
 * in its instructions, gated by the same `canSee` orient uses, and it must
 * degrade to the static instructions rather than fail the handshake. See
 * orientation.test.mjs for the module overview and the sabotage-testing
 * record (§3 covers this section).
 */

import { rpc, orientText, PRIVACY_MANIFEST, OWNER_TOKEN, TEAM_TOKEN, BROKEN_TOKEN, WIDE_TOKEN, SKETCH_BUDGET, OBSERVED_CLIENT_CUT } from "./fixtures.mjs";

export async function runOrientationConnectSketchChecks(check, harness) {
  const { bucket, env, wide } = harness;

  // -- the connect-time sketch, and the handshake it must never endanger
  const connect = async (token) => {
    const { status, body } = await rpc(env, token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    // `result`, not just a 200: a thrown handler is answered with a JSON-RPC
    // error object over HTTP 200, so a status check alone would call a
    // client that cannot connect a successful handshake.
    return { status, ok: Boolean(body?.result), instructions: body?.result?.instructions || "" };
  };

  const ownerConnect = await connect(OWNER_TOKEN);
  check(
    "initialize sketches the context so a client knows what is here before calling anything",
    ownerConnect.instructions.includes("WHAT IS IN HERE") &&
      ownerConnect.instructions.includes("Shipping the gateway.")
  );
  check(
    "the connect sketch names the top level",
    ownerConnect.instructions.includes("1-projects/") &&
      ownerConnect.instructions.includes("2-areas/")
  );
  check(
    "the connect sketch points at orient for the live answer",
    /snapshot taken when this connection opened/.test(ownerConnect.instructions)
  );

  // THE SKETCH IS FILTERED, AND ONLY AN OWNER CONNECTION HAD EVER PROVED IT.
  //
  // `instructionsForSession` runs its folder prefixes through `canSee` and
  // its root notes through `isVisibleNote`, and the function's own comment
  // says a team connection "is told exactly what a team connection may
  // know". Nothing checked it: `connect` was only ever called with the owner
  // and the broken token, so removing BOTH filters left all 615 checks
  // green while a colleague's system prompt gained the owner's private root
  // folders on every conversation — silently, before they had called
  // anything.
  //
  // This manifest is `default_visibility: private` with named team folders,
  // so the three below are private by three different routes: `0-inbox/` by
  // the default, `1-projects\legacy/` because a backslash is not a path
  // separator and it is therefore its own unlisted root, and `privacy.md`
  // because it is plumbing.
  const teamConnect = await connect(TEAM_TOKEN);
  check(
    "a team connection still gets a sketch",
    teamConnect.status === 200 &&
      teamConnect.ok &&
      teamConnect.instructions.includes("WHAT IS IN HERE")
  );
  check(
    "and it names the folders that connection may see",
    teamConnect.instructions.includes("1-projects/") &&
      teamConnect.instructions.includes("2-areas/") &&
      teamConnect.instructions.includes("3-resources/")
  );
  check(
    "but never one it may not — the sketch is `canSee`-filtered, not raw",
    !teamConnect.instructions.includes("0-inbox/") &&
      !teamConnect.instructions.includes("1-projects\\legacy/") &&
      !teamConnect.instructions.includes("privacy.md")
  );
  // The owner's own sketch is the control: these are absent above because
  // they are filtered, not because the bucket lacks them.
  check(
    "and the owner's sketch does carry them, so the filter is what removed them",
    ownerConnect.instructions.includes("0-inbox/") &&
      ownerConnect.instructions.includes("1-projects\\legacy/")
  );

  // ...AND THE FRONT PAGE IS THE THIRD FILTERED COMPONENT, WHICH NOTHING
  // REACHED EITHER.
  //
  // The sketch is not only a folder map and a root-note list: it embeds the
  // *body* of `index.md`, gated by its own `canSee` in `readFrontPage`. This
  // fixture's manifest declares `index.md: team`, so that gate never had to
  // hold here and deleting the line left all 621 checks green.
  //
  // `index.md: private` is an ordinary choice — the file is a named entry in
  // `folder_defaults` precisely so it can be made one — and it is the case
  // where the gate is the only thing standing between a colleague's system
  // prompt and the owner's front-page prose, on every conversation, before
  // they have called anything. That is a worse disclosure than the folder
  // names above: names versus what the person actually wrote.
  check(
    "a team front page is given to a team connection",
    teamConnect.instructions.includes("Shipping the gateway.")
  );
  bucket.seed("privacy.md", PRIVACY_MANIFEST.replace("index.md: team", "index.md: private"));
  const withheldFrontPage = await connect(TEAM_TOKEN);
  // `ok` is NOT the control here, and the first version of this check
  // believed it was. It is `Boolean(body.result)`, and the fail-soft path
  // returns `SERVER_INSTRUCTIONS` — a perfectly good result over 200 — so a
  // collapsed sketch satisfies `status && ok` and hands the absence over for
  // free. Narrowing the bail in `instructionsForSession` to
  // `if (!frontPage) return SERVER_INSTRUCTIONS` is a plausible-looking
  // simplification, costs a team connection its ENTIRE sketch on a private
  // front page, and passed all 626 checks.
  //
  // #88's "a team connection still gets a sketch" does not cover it either:
  // that runs against `teamConnect`, captured before the reseed, when
  // `index.md` is still team-visible — so under that sabotage it has a front
  // page, builds a sketch, and passes. The control has to be re-established
  // on the connection this check actually examines, and it has to be
  // content only a real sketch contains. `1-projects/` is the second half:
  // the sketch must be intact, not merely present, or "only the front page
  // was removed" is not what was proved.
  //
  // THE TRAILING SLASH IS LOAD-BEARING, and it is worth being exact about
  // which case it buys. `SERVER_INSTRUCTIONS` names the PARA folders in
  // prose — `0-inbox, 1-projects, 2-areas, …` — so the bare `1-projects`
  // appears on every connection ever made, the fallback included. Only the
  // folder map emits the slash.
  //
  // Total collapse is caught by `WHAT IS IN HERE` whichever way this is
  // spelled. What the slash buys is the *gutted* map — a sketch that is
  // present but has lost a folder. Measured, dropping only `1-projects/`
  // from the layout: with the slash this check fails, without it the check
  // passes and the conjunct is decoration.
  //
  // The margin is one character, and it has already been the other way
  // round: this text used to tell agents to file work under `1-projects/`,
  // with the slash — see the note at `src/index.js:169`. If that phrasing
  // returns, this conjunct silently degrades and nothing here will say so.
  check(
    "a private one is withheld, and only it — the rest of the sketch survives",
    withheldFrontPage.status === 200 &&
      withheldFrontPage.ok &&
      withheldFrontPage.instructions.includes("WHAT IS IN HERE") &&
      withheldFrontPage.instructions.includes("1-projects/") &&
      !withheldFrontPage.instructions.includes("Shipping the gateway.")
  );
  // The owner is the control, for the same reason as above: absent because
  // it was filtered, not because the sketch quietly stopped being built.
  check(
    "while the owner still receives their own, so the gate is what withheld it",
    (await connect(OWNER_TOKEN)).instructions.includes("Shipping the gateway.")
  );

  // The same file and the same gate, reached by a second tool.
  // `readSaveProcedure` has its own `canSee("index.md")`, and deleting it
  // also left 621 green.
  //
  // The obvious probe is `save_context`, and it is a vacuous one: the tool
  // is a write, TEAM_TOKEN holds a read-only grant, and the refusal arrives
  // from `callToolForSession` before the procedure is ever read. Written
  // that way this passed with the gate deleted — a check answering a
  // question nobody asked. `orient` is the path that actually reaches it
  // from a read-only connection, which is also the connection this matters
  // for: the procedure lands in a colleague's orientation unbidden.
  bucket.seed(
    "index.md",
    "# The front page\n\nShipping the gateway.\n\n" +
      "## Save context\n\ndestination: 2-areas/sessions\n\n" +
      "Only the decisions, and never the transcript.\n"
  );
  // Asserted on the heading `orient` renders rather than on the prose. The
  // prose is inside `index.md`, so a broken *front page* gate would leak the
  // same words and fail this check too — and a check that fails for its
  // neighbour's defect stops telling you which one broke. This heading is
  // produced by `readSaveProcedure` and nothing else.
  const teamOriented = await orientText(env, TEAM_TOKEN);
  check(
    "a private front page's save procedure is withheld from a team connection",
    // The positive half is not decoration either: an `orient` that failed
    // outright would satisfy the absence for free.
    teamOriented.includes("## Working here") &&
      !teamOriented.includes("## Before this session ends")
  );
  const ownerOriented = await orientText(env, OWNER_TOKEN);
  check(
    "while the owner's own procedure still reaches them, so the gate withheld it",
    ownerOriented.includes("## Before this session ends") &&
      ownerOriented.includes("Only the decisions, and never the transcript")
  );

  // Restored to the pristine constants — which for `privacy.md` is not quite
  // the state this block found: the `save_context` checks above drove the
  // gateway to rewrite it through `mutateManifest`, so as-found it carried a
  // reordered `folder_defaults` and an extra override. Nothing below depends
  // on either, and re-seeding the constant is what the broken-privacy block
  // beneath already does. Said plainly because "restored" would overstate
  // it: a check inserted here that depended on accumulated manifest state
  // would silently see the constant instead.
  bucket.seed("privacy.md", PRIVACY_MANIFEST);
  bucket.seed("index.md", "# The front page\n\nShipping the gateway.");

  const deadConnect = await connect(BROKEN_TOKEN);
  check(
    "an unreachable bucket still completes the handshake",
    deadConnect.status === 200 && deadConnect.ok
  );
  check(
    "an unreachable bucket falls back to the static instructions",
    deadConnect.instructions.includes("PARA") &&
      !deadConnect.instructions.includes("WHAT IS IN HERE")
  );

  // A privacy manifest nobody can parse must fail closed everywhere, and the
  // handshake is now one of the places that reads it.
  bucket.seed("privacy.md", "# not a manifest at all\n");
  const brokenPrivacy = await connect(OWNER_TOKEN);
  check(
    "a broken privacy manifest costs the sketch, not the connection",
    brokenPrivacy.status === 200 &&
      brokenPrivacy.ok &&
      brokenPrivacy.instructions.includes("PARA") &&
      !brokenPrivacy.instructions.includes("WHAT IS IN HERE")
  );
  bucket.seed("privacy.md", PRIVACY_MANIFEST);

  // -- the person's context arrives inside the part a client delivers
  //
  // Clients cut this payload from the end: a Claude Code session connected
  // to this gateway was seen delivering 4,083 characters of it. The sketch
  // used to follow five thousand characters of static argument, so on such a
  // client a fresh conversation got the pitch and never the front page.
  // Moving the sketch back to the end fails every check below but the first.
  check(
    "the call to action still opens the connect text",
    ownerConnect.instructions.indexOf("CALL `orient` FIRST") > -1 &&
      ownerConnect.instructions.indexOf("CALL `orient` FIRST") < 500
  );
  check(
    "the front page is delivered ahead of the argument and the rules",
    ownerConnect.instructions.indexOf("Shipping the gateway.") > -1 &&
      ownerConnect.instructions.indexOf("Shipping the gateway.") <
        ownerConnect.instructions.indexOf("Skipping it is not a neutral choice") &&
      ownerConnect.instructions.indexOf("Shipping the gateway.") <
        ownerConnect.instructions.indexOf("FIVE RULES")
  );
  check(
    "and nothing of the static text is lost by the move",
    ownerConnect.instructions.includes("FIVE RULES") &&
      ownerConnect.instructions.includes("Skipping it is not a neutral choice") &&
      ownerConnect.instructions.includes("WRITE BACK")
  );

  // Worst case: every piece of the sketch at or past its cap at once.
  const FRONT_PAGE_END = "WIDE-FRONT-PAGE-CUT-HERE";
  wide.seed("privacy.md", PRIVACY_MANIFEST);
  wide.seed(
    "index.md",
    `# A long front page\n\n${"Conventions the owner wrote at length. ".repeat(29)}` +
      `${FRONT_PAGE_END}${"More than any cap allows. ".repeat(300)}`
  );
  for (let n = 0; n < 60; n += 1) {
    wide.seed(`${"folder-near-the-name-cap-".repeat(2)}${String(n).padStart(2, "0")}/note.md`, "x");
    wide.seed(`root-note-with-a-fairly-long-name-${String(n).padStart(2, "0")}.md`, "x");
  }
  // One name longer than anyone would type, which a cap has to shorten.
  const LONG_FOLDER = `a-${"very-".repeat(60)}long-folder`;
  wide.seed(`${LONG_FOLDER}/note.md`, "x");
  const wideConnect = await connect(WIDE_TOKEN);
  const wideText = wideConnect.instructions;
  // The front page is the sketch's last piece, so the end of its cut marker
  // is the end of the sketch. Measured from the sketch's own text rather
  // than from where the argument resumes, which would pass vacuously if the
  // sketch were moved back behind the argument.
  const CUT_MARKER = '[truncated — read the whole thing with read_note("index.md")]';
  const sketchEnd = wideText.indexOf(CUT_MARKER) + CUT_MARKER.length;
  check(
    "a long front page, a wide root and thirty workspaces still connect with a sketch",
    wideConnect.ok && wideText.includes("WHAT IS IN HERE") && wideText.includes(CUT_MARKER)
  );
  check(
    "the whole sketch ends inside the budget, under the cut a client was seen making",
    sketchEnd <= SKETCH_BUDGET &&
      SKETCH_BUDGET < OBSERVED_CLIENT_CUT &&
      wideText.indexOf("Skipping it is not a neutral choice") > sketchEnd
  );
  check(
    "a name past its cap is shortened, not dropped and not spelled out",
    wideText.slice(0, sketchEnd).includes(LONG_FOLDER.slice(0, 40)) &&
      !wideText.includes(LONG_FOLDER)
  );
  check(
    "the front page is cut at its own cap and says where the rest is",
    wideText.includes(FRONT_PAGE_END) &&
      !wideText.includes("More than any cap allows. ".repeat(20))
  );
  check(
    "a wide root is named up to a limit and the rest counted",
    wideText.includes(`${"folder-near-the-name-cap-".repeat(2)}00`) &&
      !wideText.includes("root-note-with-a-fairly-long-name-59.md") &&
      /\(\+\d+ more\)/.test(wideText.slice(0, sketchEnd))
  );
  check(
    "thirty workspaces are named up to a limit, the rest counted and left to orient",
    wideText.includes(`@${"a-workspace-near-the-name-cap-".repeat(2)}`) &&
      !wideText.includes(`@${"a-workspace-near-the-name-cap-".repeat(2)}30`) &&
      /\(\+\d+ more, which orient lists\)/.test(wideText.slice(0, sketchEnd))
  );
}
