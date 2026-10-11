/**
 * Section (15): there is no key export. The owner removed
 * `export_encryption_keys` from the MCP on 2026-10-08 ("Remove it"): leaving
 * the product already hands back every note in plain text, and a tool that
 * returned the workspace data key in the clear let any AI app pull it into a
 * chat. So every caller, the owner included, gets exactly what an invented
 * name gets, and no listing names it.
 *
 * What this section still owns: the listing half of the rotation tool's
 * existence mask, and `harness.SMUGGLED`, the smuggled-argument attack shape
 * section (16) (rotate_encryption_keys) reuses. See encryptionGateway.test.mjs
 * for the module overview and the sabotage-testing record.
 */

import { KEY_A, KEY_B, worker } from "./fixtures.mjs";

export async function runEncryptionGatewayExportKeysChecks(check, harness) {
  const { call, controlPlane, env, KEYLESS, OWNER_A, OWNER_B, textOf, TEAM_A } = harness;

    /* -- (15) no export_encryption_keys -------------------------------------- */

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
      "no connection is offered a key export, the owner's included",
      ownerTools.includes("read_note") &&
        !ownerTools.includes("export_encryption_keys") &&
        !teamTools.includes("export_encryption_keys"),
    );
    check(
      "an owner is offered key rotation, and a team connection is not: the listing masks what the call masks",
      ownerTools.includes("rotate_encryption_keys") &&
        !teamTools.includes("rotate_encryption_keys") &&
        // and the listing is not simply empty for that connection
        teamTools.includes("read_note"),
    );

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
    /*
      BYTE-IDENTICAL TO AN INVENTED NAME, for every caller there is: the owner
      of a context with keys, a team connection, an owner without keys, an
      owner routed to a context they only edit, and a stranger. Asserted on the
      whole payload rather than the message, so a refusal that differed in
      `isError`, a second content block or a `_meta` hint would fail too, and
      none of them may carry key material.
    */
    const callers = [
      ["the owner", OWNER_A, {}],
      ["a team connection", TEAM_A, {}],
      ["an owner that never encrypted anything", KEYLESS, {}],
      ["an owner routed to a context they only edit", OWNER_A_IN_B, { context: "@encb" }],
    ];
    for (const [who, token, args] of callers) {
      const asked = await call(token, "export_encryption_keys", args);
      const invented = await call(token, "export_encryption_keys_x", args);
      check(
        `${who} gets an unknown tool for the key export, byte-identical to an invented name`,
        asked?.isError === true &&
          textOf(asked) === "unknown tool: export_encryption_keys" &&
          JSON.stringify(asked).replace("export_encryption_keys", "export_encryption_keys_x") ===
            JSON.stringify(invented) &&
          !JSON.stringify(asked).includes(KEY_A) &&
          !JSON.stringify(asked).includes(KEY_B),
      );
    }
    const strangerExport = await call(OWNER_B, "export_encryption_keys", { context: "@enca" });
    check(
      "a context the connection is not a member of at all answers with no-access, not with a key",
      strangerExport?.isError === true &&
        !textOf(strangerExport).includes(KEY_A) &&
        /no access to that context/.test(textOf(strangerExport)),
    );

    const crossRotate = await call(OWNER_A_IN_B, "rotate_encryption_keys", { context: "@encb" });
    check(
      "an owner of one context cannot rotate the key of another they are only an editor in",
      crossRotate?.isError === true && textOf(crossRotate) === "unknown tool: rotate_encryption_keys",
    );

    /*
      The smuggled-argument shape section (16) asks of `rotate_encryption_keys`:
      every name a key route could plausibly grow, the control plane's own
      field names included, carrying context B's identifiers.
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

  harness.SMUGGLED = SMUGGLED;
}
