/**
 * The model account the agent spends, fetched across the gateway/control-plane
 * wire and nowhere else.
 *
 * The customer connects their own Anthropic or OpenAI key. The control plane
 * holds it encrypted, `/gateway/provider` opens it for one request, and the
 * gateway spends it — so this is a credential travelling the same wire as a
 * storage secret, and it owes the same proofs.
 *
 * Offline and dependency-free, like the tenancy suite: the control plane is the
 * in-memory server in `controlPlaneStub.mjs`, which enforces the rules the
 * contract asks Convex to enforce, and the gateway builds a real
 * `createControlPlane()` and makes real `fetch` calls at it. If the Convex side
 * were built to a different shape, `apps/convex/__tests__/providerCredentials.test.ts`
 * and this file would disagree, which is the point of having both.
 *
 * ## What is actually at stake here
 *
 * Two customers, and one of them can spend the other's provider account. That
 * is a bill somebody else pays and a key we cannot rotate — it was issued by
 * Anthropic's or OpenAI's console, not by us — so the isolation checks below
 * are written the way the tenancy suite's are: same shape of grant, adjacent
 * ids, and the attacker holding a *valid* token of their own rather than none.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. The stub's `/gateway/provider` keying its lookup on `body.provider`
 *     alone, ignoring the workspace — the shape a missing index half has.
 *     → **1 fails**: `a token cannot reach another tenant's model account`.
 *
 *     The draft of this entry predicted two, adding `naming another tenant's
 *     workspace reaches nothing`, and that one does not fail: the membership
 *     selection runs before the lookup, so a token naming a workspace outside
 *     its own set never reaches the broken line at all. The two checks are not
 *     redundant — they cover the two different doors, membership and the
 *     lookup key — but only one of them is evidence about *this* edit, and the
 *     prediction is corrected rather than dropped because the shape recurs:
 *     `apps/convex/__tests__/providerCredentials.test.ts`'s sabotage 7 records
 *     the same surprise on the real implementation.
 *  2. `getProviderCredential` reading `parsed.credential ?? null` instead of
 *     going through `required`.
 *     → **1 fails**: `a control plane that answers a different contract is an
 *     error, not "nothing connected"`. This is the fast-search bug's exact
 *     shape — a missing key read as an absent value — and it is why `required`
 *     exists at all.
 *  3. The stub answering `{ credential: null }` with a 404 rather than a 200.
 *     → **2 fail**: `a provider nobody connected is null, not an error` and
 *     `a refusal is a 200 with a null, never a status the caller can count`. A
 *     status that varies with whether a provider is connected is an oracle,
 *     and `ControlPlaneError` carries the status.
 *
 *     First run of this sabotage failed *nothing* and instead killed the whole
 *     suite: `ControlPlaneError: status 404` escaped the first unguarded call
 *     and no check after it ran. That is a red run, but it names no guarantee.
 *     The two refusal checks now catch, so the suite reports which promise
 *     broke instead of stopping — and this entry records the crash because the
 *     fix came from the sabotage rather than from review.
 */

import { createControlPlane, ControlPlaneError } from "../src/controlPlane.js";
import { createControlPlaneStub, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";

const TOKEN_A = `cat_provider_a_${"0".repeat(26)}`;
const TOKEN_B = `cat_provider_b_${"0".repeat(26)}`;

/** Obviously fake, long, and shaped like nothing else in the suite. */
const KEY_A = "zarquon-plumbago-alfa-not-a-real-key-and-never-was";
const KEY_B = "zarquon-plumbago-bravo-not-a-real-key-and-never-was";

const ENV = {
  CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
};

export async function runProviderCredentialChecks(check) {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();

  try {
    controlPlane.addWorkspace("ws_pa", "alfa", {
      provider: "s3",
      status: "active",
      endpoint: "https://s3.example-provider.test",
      region: "auto",
      bucket: "tenant-a",
      accessKeyId: "AKIAEXAMPLEEXAMPLEAA",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAA",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true },
    });
    controlPlane.addWorkspace("ws_pb", "alphabet", {
      provider: "s3",
      status: "active",
      endpoint: "https://s3.example-provider.test",
      region: "auto",
      bucket: "tenant-ab",
      accessKeyId: "AKIAEXAMPLEEXAMPLEBB",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEBB",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true },
    });

    await controlPlane.addGrant({
      accessToken: TOKEN_A,
      workspaceId: "ws_pa",
      clientId: "mcp_client_alpha",
      userId: "user_a",
    });
    await controlPlane.addGrant({
      accessToken: TOKEN_B,
      workspaceId: "ws_pb",
      clientId: "mcp_client_beta",
      userId: "user_b",
    });

    controlPlane.connectProvider("ws_pa", "anthropic", KEY_A);
    controlPlane.connectProvider("ws_pb", "anthropic", KEY_B);

    const client = createControlPlane(ENV);

    // -- the ordinary case -------------------------------------------------

    const mine = await client.getProviderCredential(TOKEN_A, null, "anthropic");
    check(
      "a live token opens its own workspace's model account",
      mine?.apiKey === KEY_A && mine?.provider === "anthropic"
    );

    check(
      "the answer is two fields and nothing beside them",
      JSON.stringify(Object.keys(mine).sort()) === JSON.stringify(["apiKey", "provider"])
    );

    const named = await client.getProviderCredential(TOKEN_A, "ws_pa", "anthropic");
    check(
      "naming its own workspace is the same answer as naming none",
      named?.apiKey === KEY_A
    );

    // -- isolation ---------------------------------------------------------

    /*
      The attack, with the attacker holding a real token. Tenant B asks for
      tenant A's context by id: the id is outside the set B's grant covers, so
      it selects nothing — and the answer is the same `null` an unknown token
      gets, so it is not a probe either.
    */
    const crossNamed = await client.getProviderCredential(TOKEN_B, "ws_pa", "anthropic");
    check("naming another tenant's workspace reaches nothing", crossNamed === null);

    const theirs = await client.getProviderCredential(TOKEN_B, null, "anthropic");
    check(
      "a token cannot reach another tenant's model account",
      theirs?.apiKey === KEY_B && theirs.apiKey !== KEY_A
    );

    const unknownToken = await client.getProviderCredential(
      "cat_not_a_token_at_all_000000000000",
      null,
      "anthropic"
    );
    check("an unknown token opens nothing", unknownToken === null);

    // -- refusals are uniform ----------------------------------------------

    /*
      Both of these catch rather than letting the call escape, and the reason is
      a sabotage: making the stub answer a refusal with a 404 killed the whole
      run at the first unguarded call, so nothing after it was checked and no
      check was named. A throw is a failure either way — but a suite that names
      which guarantee broke is worth more than one that stops.
    */
    async function opened(label, run) {
      try {
        return { ok: true, value: await run() };
      } catch (error) {
        return { ok: false, value: null, error, label };
      }
    }

    const unconnected = await opened("openai", () =>
      client.getProviderCredential(TOKEN_A, null, "openai")
    );
    check(
      "a provider nobody connected is null, not an error",
      unconnected.ok && unconnected.value === null
    );

    const unknownProvider = await opened("ollama", () =>
      client.getProviderCredential(TOKEN_A, null, "ollama")
    );
    check(
      "a provider this build does not know is null, not an error",
      unknownProvider.ok && unknownProvider.value === null
    );

    /*
      A refusal must not be a status. `ControlPlaneError` carries one, and a
      caller that can tell 404 from 200 can ask whether a context has connected
      a provider — for a context it cannot otherwise see at all.
    */
    const refusals = [
      () => client.getProviderCredential(TOKEN_B, "ws_pa", "anthropic"),
      () => client.getProviderCredential(TOKEN_A, null, "openai"),
      () => client.getProviderCredential(TOKEN_A, null, "ollama"),
      () => client.getProviderCredential("cat_nope_0000000000000000000000000", null, "anthropic"),
    ];
    let allNull = true;
    for (const refusal of refusals) {
      try {
        if ((await refusal()) !== null) allNull = false;
      } catch {
        allNull = false;
      }
    }
    check("a refusal is a 200 with a null, never a status the caller can count", allNull);

    // -- the two proofs ----------------------------------------------------

    let withoutSecret = false;
    try {
      await createControlPlane({ ...ENV, GATEWAY_SECRET: "not-the-gateway-secret" })
        .getProviderCredential(TOKEN_A, null, "anthropic");
    } catch (error) {
      withoutSecret = error instanceof ControlPlaneError;
    }
    check("the gateway secret is necessary", withoutSecret);

    /*
      And never sufficient. The wrong secret is refused above; here the *right*
      secret is presented with no live grant behind it, which must open nothing
      — the two-factor property this route inherits from `/gateway/binding`.
    */
    check(
      "the gateway secret is never sufficient",
      (await client.getProviderCredential("", null, "anthropic")) === null
    );

    // -- the wire ----------------------------------------------------------

    const sent = controlPlane.calls.filter((call) => call.path === "/gateway/provider");
    check("the gateway asks the route by name", sent.length > 0);
    check(
      "every call presents the token and the provider, and nothing else",
      sent.every(
        (call) =>
          JSON.stringify(Object.keys(call.body).sort()) ===
          JSON.stringify(["accessToken", "expectedWorkspaceId", "provider"])
      )
    );

    /*
      THE FAST-SEARCH BUG'S EXACT SHAPE, ASSERTED RATHER THAN DESCRIBED.
      A control plane answering some other contract sends no `credential` key
      at all. Reading that as "nothing connected" is how `store.searchIndex`
      was null on every production request for a year; `required` refuses it.
    */
    const skewed = createControlPlane(ENV, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ providerCredential: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    let skewThrew = false;
    try {
      await skewed.getProviderCredential(TOKEN_A, null, "anthropic");
    } catch (error) {
      skewThrew = error instanceof ControlPlaneError;
    }
    check(
      'a control plane that answers a different contract is an error, not "nothing connected"',
      skewThrew
    );
  } finally {
    restore();
  }
}
