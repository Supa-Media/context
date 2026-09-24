/**
 * Section (15): `export_encryption_keys` — the console's key-recovery path,
 * scoped to `context:private`, rate-limited against a window that has to
 * both engage and release, and never leaking a key across a smuggled
 * workspace argument or into a log.
 *
 * Sets `harness.SMUGGLED` to the smuggled-argument attack shape section
 * (16) (rotate_encryption_keys) reuses. See encryptionGateway.test.mjs for
 * the module overview and the sabotage-testing record.
 */

import { KEY_A, KEY_B, worker } from "./fixtures.mjs";

export async function runEncryptionGatewayExportKeysChecks(check, harness) {
  const { a, call, controlPlane, env, KEYLESS, OWNER_A, OWNER_B, readA, storeA, textOf, TEAM_A } = harness;

    /* -- (15) export_encryption_keys ---------------------------------------- */

    const teamExport = await call(TEAM_A, "export_encryption_keys", {});
    check(
      "a team connection cannot see export_encryption_keys exists",
      teamExport?.isError === true && textOf(teamExport) === "unknown tool: export_encryption_keys",
    );

    /*
      THE OTHER HALF OF "DOES NOT EVEN LEARN THE TOOL EXISTS", and the half
      that was missing: the refusal above says `unknown tool` while
      `tools/list` was, until this check existed, handing the same connection
      the name, the description and the sentence "Export this context's
      workspace data key(s) in the clear". A masked refusal about a capability
      the same connection was just advertised masks nothing.

      Asked on the listing AND on the call, because either alone passes for a
      gateway that gets the other one wrong.
    */
    let id = 90_000;
    const listedFor = async (token) => {
      const res = await worker.fetch(
        new Request("https://x/mcp", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/list", params: {} }),
        }),
        env,
        { waitUntil() {} },
      );
      return ((await res.json()).result?.tools ?? []).map((tool) => tool.name);
    };
    const ownerTools = await listedFor(OWNER_A);
    const teamTools = await listedFor(TEAM_A);
    check(
      "an owner is offered both encryption tools",
      ownerTools.includes("export_encryption_keys") && ownerTools.includes("rotate_encryption_keys"),
    );
    check(
      "a team connection is not offered either of them — the listing masks what the call masks",
      !teamTools.includes("export_encryption_keys") &&
        !teamTools.includes("rotate_encryption_keys") &&
        // and the listing is not simply empty for that connection
        teamTools.includes("read_note"),
    );

    /*
      BYTE-IDENTICAL, asserted on the whole payload rather than on the message.
      `canSee`'s own idiom is that the refusal for a thing you may not have is
      indistinguishable from the refusal for a thing that never existed, and a
      check on the text alone would pass for a payload that differed in
      `isError`, in a second content block, or in a `_meta` hint.
    */
    const invented = await call(TEAM_A, "export_encryption_keys_x", {});
    check(
      "the refusal is byte-identical to the one an invented tool name gets",
      JSON.stringify(teamExport).replace("export_encryption_keys", "export_encryption_keys_x") ===
        JSON.stringify(invented),
    );

    /*
      NAMING SOMEBODY ELSE'S CONTEXT.

      The tool takes no arguments, so the only id an attacker can supply is the
      routing one — `context`, which `callToolForSession` resolves before the
      tool runs. A connection that owns context A and is merely an *editor* in
      context B holds `context:private` in the grant and reads private in A,
      so the tool is legitimately theirs *there*: the question is whether the
      capability travels with the connection or is re-decided in the context it
      is routed to. It is re-decided — `target.scope` for B is `team`, and the
      answer is the same masked refusal, with none of B's key material in it.
    */
    const OWNER_A_IN_B = "cat_test_enc_owner_a_in_b_0000000000";
    await controlPlane.addGrant({
      accessToken: OWNER_A_IN_B,
      workspaceId: "ws_enc_a",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_enc_owner_a_in_b",
      userId: "user_enc_owner_a_in_b",
      alsoMemberOf: [{ workspaceId: "ws_enc_b", role: "editor" }],
    });
    const crossExport = await call(OWNER_A_IN_B, "export_encryption_keys", { context: "@encb" });
    check(
      "an owner of one context cannot export the key of another they are only an editor in",
      crossExport?.isError === true &&
        textOf(crossExport) === "unknown tool: export_encryption_keys" &&
        !textOf(crossExport).includes(KEY_B),
    );
    const crossRotate = await call(OWNER_A_IN_B, "rotate_encryption_keys", { context: "@encb" });
    check(
      "...and cannot rotate it either",
      crossRotate?.isError === true && textOf(crossRotate) === "unknown tool: rotate_encryption_keys",
    );
    const strangerExport = await call(OWNER_B, "export_encryption_keys", { context: "@enca" });
    check(
      "a context the connection is not a member of at all answers with no-access, not with a key",
      strangerExport?.isError === true &&
        !textOf(strangerExport).includes(KEY_A) &&
        /no access to that context/.test(textOf(strangerExport)),
    );

    const keylessExport = await call(KEYLESS, "export_encryption_keys", {});
    check(
      "a context that has never encrypted anything has nothing to export, and it is not a refusal",
      !keylessExport?.isError && /nothing to export/.test(textOf(keylessExport)),
    );

    const exported = await call(OWNER_A, "export_encryption_keys", {});
    const exportedText = textOf(exported);
    const exportedDoc = JSON.parse(exportedText.slice(exportedText.indexOf("{")));
    check(
      "the export names the workspace, the current generation, and includes the live key",
      !exported?.isError &&
        exportedDoc.workspace_id === "ws_enc_a" &&
        exportedDoc.current === "k1" &&
        exportedDoc.keys.length === 1 &&
        exportedDoc.keys[0].generation === "k1" &&
        exportedDoc.keys[0].key === KEY_A,
    );
    /*
      AND NAMING IT IN EVERY OTHER ARGUMENT THE ROUTE ACCEPTS.

      `context` is the *routing* argument and it is re-decided in the context
      it points at, which the two checks above ask. This asks the rest of the
      surface, and the answer changed: the door now enforces the
      advertisement.

      It did not used to. `inputSchema` declared `properties: {}` with
      `additionalProperties: false` and nothing validated a call against it —
      `callTool` handed the object straight through — so "this tool takes no
      arguments" was a statement about the advertisement, and what made it
      true of the door was an accident of two signatures:
      `toolExportEncryptionKeys(store, scope)` and
      `toolRotateEncryptionKeys(store, scope)` are the only two tool functions
      in `index.js` that do not take `args` at all, and so had nothing to read
      an attacker-supplied id out of. A later refactor adding `args` "for
      symmetry" would have been a one-line change with nothing standing in
      front of it, and every other tool in the gateway had the same gap with
      no such accident protecting it.

      `src/toolArguments.js` is what stands there now. Every name these two
      routes could plausibly grow — the control plane's own field names
      included, `startEncryptionRotation` and `completeEncryptionRotation`
      among them — carrying context B's identifiers, on a connection that owns
      A and nothing else, is refused before the handler runs, before the
      privacy manifest is read, and before anything is looked up about the
      workspace those identifiers name.
    */
    const SMUGGLED = {
      workspaceId: "ws_enc_b",
      expectedWorkspaceId: "ws_enc_b",
      workspace: "@encb",
      workspace_id: "ws_enc_b",
      slug: "encb",
      generation: "k1",
      current: "k1",
      keys: { k1: KEY_B },
      encryptionKey: { current: "k1", keys: { k1: KEY_B } },
      startEncryptionRotation: true,
      completeEncryptionRotation: "k1",
      scope: "private",
      accessToken: OWNER_B,
    };
    const smuggledExport = await call(OWNER_A, "export_encryption_keys", { ...SMUGGLED });
    const smuggledText = textOf(smuggledExport);
    check(
      "an owner naming ANOTHER context in every argument but `context` exports nothing at all",
      smuggledExport?.isError === true &&
        smuggledText.startsWith("unknown argument") &&
        // The one property these two do advertise is the addressing argument,
        // folded in centrally by `toolDefinitions`; the refusal names it and
        // nothing else, which is the whole of what they take.
        smuggledText.includes("permitted here: context") &&
        !smuggledText.includes(KEY_A) &&
        !smuggledText.includes(KEY_B) &&
        !smuggledText.includes("ws_enc_a") &&
        !smuggledText.includes("ws_enc_b"),
    );
    /*
      And identically whether the workspace those identifiers name exists or
      not. A refusal that varied would be an existence oracle over a global
      namespace assembled out of the guard that closed the smuggling — which
      is why the check happens before anything is looked up rather than after
      the lookup fails.
    */
    const smuggledAtNobody = await call(OWNER_A, "export_encryption_keys", {
      ...SMUGGLED,
      workspaceId: "ws_no_such_workspace_anywhere",
      workspace: "@no-such-context-anywhere",
      workspace_id: "ws_no_such_workspace_anywhere",
      slug: "no-such-context-anywhere",
    });
    check(
      "...and identically whether the context it names exists or not",
      textOf(smuggledAtNobody) === smuggledText,
    );

    check(
      "the export says what it means and points at the offline decryptor",
      /one-way action/.test(exportedText) && exportedText.includes("packages/encryption-decryptor"),
    );
    check(
      "...and names the one thing it does not open, rather than leaving it to be discovered",
      /locked with a passphrase is not\s+opened by this file|locked with a passphrase is not opened by this file/.test(
        exportedText.replace(/\s+/g, " "),
      ),
    );
    check(
      "the export never appears in the audit trail",
      !(await (async () => {
        const keys = [...a.objects.keys()].filter((key) => key.startsWith(".context/audit/"));
        const text = keys.map((key) => new TextDecoder().decode(a.objects.get(key).bytes)).join("\n");
        return text.includes(KEY_A);
      })()),
    );

    /*
      THE KEY LEAVES IN THE RESPONSE BODY AND NOWHERE ELSE.

      The audit check above covers `.context/audit/`. This one covers the gateway's
      own structured logs, which are the other place a value that passes
      through a request routinely ends up — `console.log` is captured for the
      length of one export and searched for the material itself. A log line is
      not a place a key can be revoked from.
    */
    const captured = [];
    const exportLogSpy = console.log;
    const exportWarnSpy = console.warn;
    const exportErrorSpy = console.error;
    console.log = (...parts) => captured.push(parts.map(String).join(" "));
    console.warn = (...parts) => captured.push(parts.map(String).join(" "));
    console.error = (...parts) => captured.push(parts.map(String).join(" "));
    let loggedExport;
    try {
      loggedExport = await call(OWNER_A, "export_encryption_keys", {});
    } finally {
      console.log = exportLogSpy;
      console.warn = exportWarnSpy;
      console.error = exportErrorSpy;
    }
    check(
      "the exported key material never reaches a log line",
      !loggedExport?.isError &&
        textOf(loggedExport).includes(KEY_A) && // it IS in the response — the check is not vacuous
        !captured.join("\n").includes(KEY_A),
    );

    /*
      THE RATE LIMIT, ASKED THE WAY AN ATTACKER WOULD.

      Two exports have happened above — the first one and the log-capture one
      — so exactly three of the six attempts below may be accepted. It used to
      be three exports and two acceptances: the smuggled-argument call counted
      against the budget because it reached the handler. It no longer reaches
      one, and a call refused for its arguments deliberately spends nothing —
      the budget exists to bound how often key material can actually leave,
      and a call that was never going to produce any has nothing to bound. The
      limit is five per rolling day per CONTEXT,
      and the three ways a caller would try to get around it are all the same
      question — is the counter attached to the session, or to the context?

        - a second call on the same connection
        - a *different* grant, a different OAuth client, a different user, on
          the same context
        - a reconnection (every `call` here is already a fresh session: this
          worker holds no per-connection state between requests, so the loop
          below is a reconnect on every iteration)

      The counter lives in the customer's own bucket, so all three meet it.
      Asserted as an exact count rather than "one of them failed", which is
      what the first version of this check measured — a limit of one and a
      limit of five both pass that.
    */
    const OWNER_A2 = "cat_test_enc_owner_a2_00000000000000";
    await controlPlane.addGrant({
      accessToken: OWNER_A2,
      workspaceId: "ws_enc_a",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_enc_owner_a_second",
      userId: "user_enc_owner_a_second",
    });
    let accepted = 0;
    let refused = 0;
    let lastRefusal = null;
    // Alternating tokens: a second client cannot spend a budget of its own.
    for (const token of [OWNER_A, OWNER_A2, OWNER_A, OWNER_A2, OWNER_A, OWNER_A2]) {
      const attempt = await call(token, "export_encryption_keys", {});
      if (attempt?.isError) {
        refused += 1;
        lastRefusal = attempt;
      } else {
        accepted += 1;
      }
    }
    check(
      "exactly five exports per context per window are accepted, counting the ones already spent",
      accepted === 3 && refused === 3,
    );
    check(
      "a second client, a second grant and a reconnection all meet the same counter",
      lastRefusal !== null && /rate limited/.test(textOf(lastRefusal)),
    );
    check(
      "a rate-limited attempt returns no key material at all",
      !textOf(lastRefusal).includes(KEY_A),
    );

    /*
      THE COUNTER IS A NEW OBJECT IN SOMEBODY'S BUCKET, so it has to behave
      like the plumbing it claims to be: written under `.context/`, never
      listed as a note, never readable as one, and carrying nothing but two
      numbers. A counter a tool could read would leak how often the owner
      exports; a counter a tool could *write* would be a rate limit anyone
      holding a write scope could reset.
    */
    const counterKey = ".context/encryption-export-rate.json";
    const counter = JSON.parse(readA(counterKey) ?? "null");
    const listedNotes = await call(OWNER_A, "list_notes", {});
    const readCounter = await call(OWNER_A, "read_note", { path: counterKey });
    const wroteCounter = await call(OWNER_A, "write_note", {
      path: counterKey,
      content: "{\"windowStartedAt\":0,\"count\":0}",
    });
    check(
      "the export counter is plumbing: two numbers, unlisted, unreadable, unwritable",
      counter !== null &&
        Object.keys(counter).sort().join(",") === "count,windowStartedAt" &&
        !textOf(listedNotes).includes("encryption-export-rate") &&
        readCounter?.isError === true &&
        wroteCounter?.isError === true &&
        // and the refused write did not reset it
        JSON.parse(readA(counterKey)).count === counter.count,
    );

    /*
      AND THE COUNTER HAS TO LET GO AGAIN, which is the half a ceiling test
      cannot see.

      Everything above proves the limit *engages*. Nothing above proves it ever
      *releases*, and the two failures are not symmetrical: a limit that does
      not engage lets an owner export their own key too often, while a limit
      that does not release **strands the key**. `docs/decisions/encryption.md`
      makes the export the owner's route back to their own notes if we
      disappear, and non-negotiable #1 says that exit is "never gated, never
      degraded, and never behind a paywall" — a counter that cannot roll is all
      three, arrived at by accident.

      Measured before these two checks existed, against 4,123:

        the window reset deleted (the counter is monotonic for ever)      0
        a corrupt counter failing CLOSED instead of open                  0

      Both are live paths, not unreachable branches: the reset is the only code
      that clears the count, and the `catch` runs on any unparseable file in a
      bucket the customer can also write to with their own S3 credentials.

      The window is moved by writing the counter directly rather than by
      waiting or by stubbing the clock — `storeA` is the bucket behind this
      context, and putting a past `windowStartedAt` is exactly the state the
      gateway would read tomorrow.
    */
    const spent = JSON.parse(readA(counterKey));
    await storeA.put(
      counterKey,
      JSON.stringify({ ...spent, windowStartedAt: Date.now() - 25 * 60 * 60 * 1000 }),
    );
    const afterWindow = await call(OWNER_A, "export_encryption_keys", {});
    check(
      "a spent window rolls, so the exit is delayed and never closed",
      afterWindow?.isError !== true && textOf(afterWindow).includes(KEY_A),
    );

    // A plumbing file the customer's own S3 credentials can reach, and which
    // nothing here treats as canonical. Losing a day's counter is the cheaper
    // failure by a wide margin; refusing an owner their own key because a JSON
    // file got mangled is the expensive one.
    await storeA.put(counterKey, "{ not json at all");
    const afterCorrupt = await call(OWNER_A, "export_encryption_keys", {});
    check(
      "a corrupt counter fails OPEN toward a fresh window, never toward a stranded key",
      afterCorrupt?.isError !== true && textOf(afterCorrupt).includes(KEY_A),
    );

  harness.SMUGGLED = SMUGGLED;
}
