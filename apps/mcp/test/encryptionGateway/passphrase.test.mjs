/**
 * Section (14): a passphrase-locked note, which this gateway is not a
 * reader of. Nothing here can open it, no tool takes a passphrase, and a
 * client writing to it must be refused rather than have the gateway seal
 * the replacement with the workspace key and destroy the only copy. See
 * encryptionGateway.test.mjs for the module overview and the
 * sabotage-testing record.
 *
 * Sets `harness.LOCKED` to the path this section pins, which section (16)
 * (rotate_encryption_keys) reads to prove a rotation does not touch it.
 */

import { PASSPHRASE_VECTOR, worker } from "./fixtures.mjs";

export async function runEncryptionGatewayPassphraseChecks(check, harness) {
  const { a, call, env, KEYLESS, MACHINE_A, OWNER_A, readA, storeA, textOf } = harness;

    /* -- (14) a passphrase-locked note, which this gateway is not a reader of */
    //
    // The Phase 2 mode, and the one this section exists to police: a note whose
    // only recipient is a passphrase. Nothing here can open it, no tool takes a
    // passphrase, and the failure that would be catastrophic is not "a client
    // cannot read it" — it is a client *writing* to it, because the gateway
    // would otherwise have sealed the replacement with the workspace key and
    // reported success while destroying the only copy of the note.
    //
    // Every call below runs inside a log capture, and the checks run after it is
    // released — a check that prints into its own evidence is a check nobody can
    // read, and the first version of this section did exactly that.

    const LOCKED = "1-projects/locked.md";
    const lockedBytes = PASSPHRASE_VECTOR.document.replace(
      PASSPHRASE_VECTOR.workspaceId,
      "ws_enc_a",
    );
    await storeA.put(LOCKED, lockedBytes);
    await storeA.put("1-projects/keyless.md", readA("1-projects/conflict.md") ?? lockedBytes);

    const lockedBefore = readA(LOCKED);
    const lockedLines = [];
    const realLockedLog = console.log;
    let locked;
    console.log = (...args) => lockedLines.push(args.map(String).join(" "));
    try {
      locked = {
        read: await call(OWNER_A, "read_note", { path: LOCKED }),
        // The same refusal a note whose *key* did not arrive gets. Two reasons,
        // one answer: a client cannot learn from a refusal whether a note is
        // passphrase-locked or merely unreachable today, so Phase 2 adds no
        // inference channel that Phase 1 did not already have.
        keyless: await call(KEYLESS, "read_note", { path: "1-projects/keyless.md" }),
        write: await call(OWNER_A, "write_note", {
          path: LOCKED,
          content: "# I am overwriting this\n",
        }),
        // The argument that does not exist. A client that has heard of the
        // feature and guesses at an interface must not find one.
        writeWithPassphrase: await call(OWNER_A, "write_note", {
          path: LOCKED,
          content: "# I am overwriting this\n",
          passphrase: PASSPHRASE_VECTOR.passphrase,
          password: PASSPHRASE_VECTOR.passphrase,
        }),
        readWithPassphrase: await call(OWNER_A, "read_note", {
          path: LOCKED,
          passphrase: PASSPHRASE_VECTOR.passphrase,
        }),
        decrypt: await call(OWNER_A, "set_encryption", {
          path: LOCKED,
          encrypted: false,
          passphrase: PASSPHRASE_VECTOR.passphrase,
        }),
        search: await call(OWNER_A, "search_notes", { query: "pinned passphrase vector" }),
        list: await call(OWNER_A, "list_notes", { prefix: "1-projects" }),
        tools: await (async () => {
          const res = await worker.fetch(
            new Request("https://x/mcp", {
              method: "POST",
              headers: { Authorization: `Bearer ${OWNER_A}`, "Content-Type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 9001, method: "tools/list" }),
            }),
            env,
            { waitUntil() {} },
          );
          return (await res.json()).result.tools;
        })(),
      };
    } finally {
      console.log = realLockedLog;
    }
    const lockedAfter = readA(LOCKED);

    check(
      "a client cannot read a passphrase-locked note, and is not handed its envelope",
      textOf(locked.read).includes("encrypted") &&
        !textOf(locked.read).includes("A256GCM") &&
        !textOf(locked.read).includes("pinned passphrase vector"),
    );
    check(
      "...and the refusal is the same shape as the one a missing key produces",
      textOf(locked.read).replace(LOCKED, "\u00abpath\u00bb") ===
        textOf(locked.keyless).replace("1-projects/keyless.md", "\u00abpath\u00bb"),
    );
    check(
      "a write to a passphrase-locked note is refused",
      textOf(locked.write).includes("encrypted") && !textOf(locked.write).includes("written:"),
    );
    check("...and the stored object is byte-for-byte what it was", lockedAfter === lockedBefore);
    /*
      The guess is now refused rather than ignored, which is the stronger of
      the two answers and the one that matters here: an argument this gateway
      never advertised does not reach a handler at all, so the passphrase a
      client volunteered is never read, never compared, and never logged. The
      refusal names the property and never its value — asserted, because a
      validator that echoed what it rejected would put a secret a client
      guessed into a tool result and from there into a transcript.
    */
    check(
      "...and supplying a passphrase to the gateway is refused before the tool runs",
      textOf(locked.writeWithPassphrase).includes('unknown argument "passphrase"') &&
        !textOf(locked.writeWithPassphrase).includes(PASSPHRASE_VECTOR.passphrase),
    );
    check(
      "...on the read path either",
      textOf(locked.readWithPassphrase).includes('unknown argument "passphrase"') &&
        !textOf(locked.readWithPassphrase).includes(PASSPHRASE_VECTOR.passphrase),
    );
    check(
      "...and `set_encryption` cannot turn the lock off with one",
      !textOf(locked.decrypt).includes("decrypted:"),
    );
    check(
      "no tool this gateway advertises takes a passphrase, a password or a key",
      locked.tools.every((tool) =>
        Object.keys(tool.inputSchema?.properties ?? {}).every(
          (name) => !/pass(phrase|word)|secret|kek|key$/i.test(name),
        ),
      ),
    );
    check(
      "search does not quote a passphrase-locked note",
      !textOf(locked.search).includes("Only the passphrase beside this"),
    );
    check(
      "...and the note is still listed, because its existence was never the secret",
      textOf(locked.list).includes("locked.md"),
    );

    const lockedLog = JSON.stringify(lockedLines);
    check(
      "nothing about a locked note reaches a log line but its path",
      lockedLines.length > 0 &&
        !lockedLog.includes(PASSPHRASE_VECTOR.passphrase) &&
        !lockedLog.includes(PASSPHRASE_VECTOR.kek) &&
        !lockedLog.includes("Only the passphrase beside this"),
    );
    const lockedAudit = [...a.objects.keys()]
      .filter((key) => key.startsWith(".context/audit/"))
      .map((key) => new TextDecoder().decode(a.objects.get(key).bytes))
      .join("\n");
    check(
      "...and no audit row carries a passphrase, because no call ever had one to record",
      !lockedAudit.includes(PASSPHRASE_VECTOR.passphrase) &&
        !lockedAudit.includes(PASSPHRASE_VECTOR.kek),
    );

    /*
      WHAT KEEPS THE DESKTOP MACHINE GRANT AWAY FROM THE KEYS, and it is not
      the gate on the tool.

      This block exists because a review of mine got it wrong and the wrong
      version is the one worth pinning against. The reasoning was: the tool is
      gated only on `scope !== "private"`; `scope` is the visibility TIER, and
      `visibilityTierForGrant` answers `"private"` for any owner-held grant
      carrying `context:private`; `DESKTOP_SCOPE` is exactly
      `context:write context:private`; the tool is `readOnlyHint: true` so
      `toolIsWriting` is false and the operation-scope gate is skipped. Every
      one of those is true. The conclusion — that a machine grant can export
      the workspace keys — is false, because none of them is reached.

      `/mcp` requires `context:read` at the transport, before a store exists
      and before any tool is dispatched. A grant without it gets `403
      insufficient_scope` and never sees a tool at all. So the credential that
      is minted with no approve screen is kept out by the scope its own design
      deliberately omits — which is the property `main/connect.ts` claims when
      it says "a laptop credential that could read every note its owner ever
      wrote is past what the feature is worth."

      Pinned here rather than assumed, because the reasoning above is what a
      future change to that transport gate would silently unlock, and because
      an enumeration of the gates INSIDE a dispatcher says nothing about the
      one in front of it.
    */
    const machineRaw = await worker.fetch(
      new Request("https://x/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${MACHINE_A}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9911,
          method: "tools/call",
          params: { name: "export_encryption_keys", arguments: {} },
        }),
      }),
      env,
      { waitUntil() {} },
    );
    const machineBody = await machineRaw.json();
    check(
      "THE DESKTOP MACHINE GRANT NEVER REACHES A TOOL: /mcp REQUIRES context:read",
      machineRaw.status === 403 && machineBody?.error === "insufficient_scope",
    );
    check(
      "...and the refusal names the scope, so a client knows what to ask for",
      String(machineBody?.error_description || "").includes("context:read"),
    );
    /*
      Deliberately not asserted here: that this grant is otherwise live. The
      obvious demonstration — a meetings GET — is refused for scope too, since
      `scopeForMeetingRequest` wants read for a read. What this credential can
      actually do is POST a meeting, which needs a real body and belongs in the
      meetings suite that already covers it. A check that cannot make its point
      without contortion is better left out than stretched into one that
      passes; the first version of it asserted `!== 401 && !== 403` and would
      have gone green on a fixture that was simply broken.
    */

  harness.LOCKED = LOCKED;
}
