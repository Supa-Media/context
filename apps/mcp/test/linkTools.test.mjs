/**
 * THE THREE LINK TOOLS — an agent asking for a link and getting a URL.
 *
 * The console has had share links since the beginning and nothing in this
 * surface could mint one, so an agent asked for "a link to send them" had two
 * options and took the wrong one: it wrote a URL out of the path it was
 * holding. A guessed URL is worse than no URL — it looks right, it gets
 * pasted, and it opens nothing.
 *
 * What is proved here is the boundary rather than the happy path:
 *
 *  1. **The gateway builds nothing.** What comes back is what the control
 *     plane returned, and the *token never appears in it*. An agent that could
 *     see a token could assemble an address, which is the thing being removed.
 *  2. **Minting is the owner's**, at the listing and at the call, and the
 *     refusal is one sentence for every cause.
 *  3. **A short name that cannot be claimed does not lose the link.** The row
 *     is real and usable at its long URL either way.
 *  4. **Revoke is uniform**: not yours, already gone and never existed are one
 *     answer, and an id from another context is not an oracle.
 */

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { effectiveVisibility, parsePrivacyManifest } from "../src/privacy/engine.js";

const OWNER_TOKEN = `cat_links_owner_${"0".repeat(16)}`;
const READONLY_TOKEN = `cat_links_readonly_${"0".repeat(13)}`;
const MEMBER_TOKEN = `cat_links_member_${"0".repeat(15)}`;
const OTHER_TOKEN = `cat_links_other_${"0".repeat(16)}`;
/** Writes, and reads at team tier — the grant the tier gate is actually about. */
const TEAM_TIER_TOKEN = `cat_links_team_${"0".repeat(17)}`;

const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

const NOTE = "1-projects/plan.md";
/** What the real control plane tells an owner it cleared and could not link. */
const NOTE_REFUSED_SENTENCE = "Your team cannot read that note, so a link cannot either.";
const NOT_TEAM_VISIBLE = NOTE_REFUSED_SENTENCE;

function createBucket() {
  const objects = new Map();
  let etags = 0;
  return {
    objects,
    seed(key, body) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async put(key, value) {
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
    async list({ prefix } = {}) {
      return {
        objects: [...objects.keys()]
          .filter((key) => !prefix || key.startsWith(prefix))
          .sort()
          .map((key) => ({
            key,
            size: objects.get(key).body.length,
            uploaded: objects.get(key).uploaded,
            etag: objects.get(key).etag,
          })),
        truncated: false,
      };
    },
  };
}

async function rpc(env, token, method, params) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx,
  );
  const body = await response.json();
  await settle();
  return body;
}

async function call(env, token, name, args = {}) {
  const body = await rpc(env, token, "tools/call", { name, arguments: args });
  return {
    text: body?.result?.content?.[0]?.text ?? "",
    isError: body?.result?.isError === true,
  };
}

/** The share id out of what `create_link` or `list_links` printed. */
function idIn(text) {
  return /^id: (\S+)$/m.exec(text)?.[1] ?? null;
}

export async function runLinkToolChecks(check) {
  const bucket = createBucket();
  const otherBucket = createBucket();
  /*
    The real mint refuses a note the workspace cannot read, with the sentence
    below. Judged from the bucket's own live manifest, as the real one is —
    a stub that minted over anything is how this suite stayed green while
    every owner's `write_note(share)` failed in production.
  */
  const controlPlane = createControlPlaneStub({
    linkRefusal: async (workspaceId, path) => {
      const held = (workspaceId === "ws_links" ? bucket : otherBucket).objects;
      const manifest = held.get("privacy.md")?.body;
      if (!manifest || !held.has(path)) return NOT_TEAM_VISIBLE;
      const { rules, overrides } = parsePrivacyManifest(manifest);
      return effectiveVisibility(path, rules, overrides) === "team" ? null : NOT_TEAM_VISIBLE;
    },
  });
  const restore = controlPlane.install();
  try {

    const binding = (bindingName) => ({
      provider: "r2-binding",
      bindingName,
      capabilities: { conditionalWrite: true, conditionalCreate: true },
      status: "active",
    });
    // A key, so an encrypted note can really be written here — see the
    // encrypted-note check under "publishing without the link tools".
    controlPlane.addWorkspace("ws_links", "seyi", {
      ...binding("LINKS_BUCKET"),
      encryptionKey: { current: "k1", keys: { k1: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=" } },
    });
    controlPlane.addWorkspace("ws_other", "other", binding("OTHER_BUCKET"));

    await controlPlane.addGrant({
      accessToken: OWNER_TOKEN,
      workspaceId: "ws_links",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_links_owner",
      userId: "user_seyi",
    });
    await controlPlane.addGrant({
      accessToken: READONLY_TOKEN,
      workspaceId: "ws_links",
      role: "owner",
      scopes: ["context:read", "context:private"],
      clientId: "mcp_client_links_readonly",
      userId: "user_seyi",
    });
    await controlPlane.addGrant({
      accessToken: MEMBER_TOKEN,
      workspaceId: "ws_links",
      role: "member",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_links_member",
      userId: "user_dan",
    });
    await controlPlane.addGrant({
      accessToken: TEAM_TIER_TOKEN,
      workspaceId: "ws_links",
      role: "owner",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_links_team_tier",
      userId: "user_seyi",
    });
    await controlPlane.addGrant({
      accessToken: OTHER_TOKEN,
      workspaceId: "ws_other",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_links_other",
      userId: "user_out",
    });

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "LINKS_BUCKET,OTHER_BUCKET",
      LINKS_BUCKET: bucket,
      OTHER_BUCKET: otherBucket,
    };
    bucket.seed("privacy.md", MANIFEST);
    bucket.seed("index.md", "# Context\n");
    bucket.seed(NOTE, "# Plan\n");
    // Real, team-visible notes for `create_link` to point at. The real mint
    // refuses a path the workspace cannot read, and so does the stub now.
    for (const path of [
      "1-projects/intake.md",
      "1-projects/other.md",
      "1-projects/reserved.md",
      "1-projects/clients.md",
      "1-projects/plain.md",
      "1-projects/typo.md",
      "1-projects/big-intake.md",
      "1-projects/silly.md",
    ]) {
      bucket.seed(path, "# Linked\n");
    }
    otherBucket.seed("privacy.md", MANIFEST);

    /* ------------------------- the URL, not the token ---------------------- */

    const minted = await call(env, OWNER_TOKEN, "create_link", { path: NOTE });
    check("an owner can mint a link", !minted.isError);
    check("...and is handed the URL rather than a token", /link: https:\/\/\S+\/s\/\S+/.test(minted.text));
    check(
      "...and is told what it opens and who it is for",
      minted.text.includes(`opens: ${NOTE}`) &&
        minted.text.includes("anyone with the link, no account needed"),
    );
    check(
      "...and that anyone holding it needs no account",
      /without an account/.test(minted.text),
    );

    const shareId = idIn(minted.text);
    check("...and an id it can revoke with later", typeof shareId === "string" && shareId !== "");

    /* --------------------------- the short name ---------------------------- */

    const named = await call(env, OWNER_TOKEN, "create_link", {
      path: "1-projects/intake.md",
      short: "Intake",
    });
    check("a short name is claimed, lowercased", named.text.includes("/@seyi/intake"));
    check(
      "...and the agent is told a short name is guessable, which the long one is not",
      /guessable by anyone who types it/.test(named.text),
    );

    const clash = await call(env, OWNER_TOKEN, "create_link", {
      path: "1-projects/other.md",
      short: "intake",
    });
    check("a name already taken does not lose the link", !clash.isError);
    check("...the link is still there", /link: https:\/\//.test(clash.text));
    check("...and the reason the name was refused is reported", /already points at another link/.test(clash.text));
    check("...with no short link claimed", !clash.text.includes("short link:"));

    const reserved = await call(env, OWNER_TOKEN, "create_link", {
      path: "1-projects/reserved.md",
      short: "1-projects",
    });
    check("a name Context writes into every workspace is refused", /reserved for Context/.test(reserved.text));

    /* ------------------------------ collect mode --------------------------- */

    /*
      A COLLECT LINK IS THE ONLY WRITE IN THIS PRODUCT WITH NO ACCOUNT BEHIND IT.

      What is checked here is the gateway's half: the argument reaches the
      control plane as `mode`, what comes back says the link takes answers, and
      the agent is handed the three sentences it has to pass on. Whether the
      row is honoured is `collectMode.test.ts`'s, where the real mint is.
    */
    const collecting = await call(env, OWNER_TOKEN, "create_link", {
      path: "1-projects/clients.md",
      mode: "collect",
    });
    check("an owner can mint a link that takes answers", !collecting.isError);
    check(
      "...and the mode reached the control plane rather than being dropped",
      controlPlane.calls.some(
        (entry) => entry.path === "/gateway/links/create" && entry.body?.mode === "collect",
      ),
    );
    check("...and the link says it is taking answers", /taking answers: yes/.test(collecting.text));
    check(
      "...and the agent is told strangers need no account and are not named",
      /without an account and without being named/.test(collecting.text),
    );
    check(
      "...that nobody reads the answers through it, so an answer is final",
      /nobody can read .* through it/.test(collecting.text) && /final once sent/.test(collecting.text),
    );
    check("...and the number it stops at", /stops on its own at 500 answers/.test(collecting.text));

    const plain = await call(env, OWNER_TOKEN, "create_link", { path: "1-projects/plain.md" });
    check(
      "an ordinary link says none of that, because it takes nothing",
      !/taking answers/.test(plain.text) && !/TAKES ANSWERS/.test(plain.text),
    );

    // Anything that is not the literal is a READ link. A misspelling must not
    // land on the one mode that opens a write path to strangers.
    const misspelled = await call(env, OWNER_TOKEN, "create_link", {
      path: "1-projects/typo.md",
      mode: "Collect",
    });
    check(
      "a mode that is not the literal is an ordinary link",
      !/taking answers/.test(misspelled.text),
    );

    const capped = await call(env, OWNER_TOKEN, "create_link", {
      path: "1-projects/big-intake.md",
      mode: "collect",
      collect_cap: 2000,
    });
    check("an owner's own ceiling is carried", /of 2000 so far/.test(capped.text));
    check("...and the agent is told the number it will stop at", /stops on its own at 2000/.test(capped.text));

    // A cap past the maximum is not an error and does not remove the ceiling:
    // the default stands, which is the only direction a typo may go.
    const silly = await call(env, OWNER_TOKEN, "create_link", {
      path: "1-projects/silly.md",
      mode: "collect",
      collect_cap: 5_000_000,
    });
    check("a cap past the maximum leaves the default standing", /of 500 so far/.test(silly.text));
    check("...and still mints a working link", /link: https:\/\//.test(silly.text));

    const withCollecting = await call(env, OWNER_TOKEN, "list_links");
    check(
      "the listing tells the two apart",
      /taking answers: yes/.test(withCollecting.text) &&
        (withCollecting.text.match(/taking answers: yes/g) ?? []).length === 3,
    );

    /* ------------------- publishing without the link tools ----------------- */

    /*
      THE WHOLE POINT OF THIS BLOCK: A CLIENT WITH A STALE TOOL LIST.

      `create_link` and `create_form` are new. A connected client caches
      `tools/list` and re-fetches on its own schedule, so for some clients they
      do not exist yet and cannot be called — the name is not in the list, and
      no amount of prose makes an absent tool callable.

      `write_note` is in every client's list, has been from the beginning, and
      already parses a form block and creates its answers file. So the two
      halves of "make me a form and publish it" are reachable through it: the
      block is ordinary Markdown, and `share` mints the link.

      An ARGUMENT survives a stale list where a TOOL does not: arguments are
      validated against the schema this server advertises now, never against
      the client's copy, so a client may pass `share` before it has ever seen
      it advertised.
    */

    const published = await call(env, OWNER_TOKEN, "write_note", {
      path: "1-projects/published-intake.md",
      content: "# Intake\n\nTell me about the project.\n",
      share: "anyone",
    });
    check("write_note can publish the note it just wrote", !published.isError);
    check("...and the note landed", /written: 1-projects\/published-intake\.md/.test(published.text));
    check("...and the URL came back, not a token", /link: https:\/\/\S+\/s\/\S+/.test(published.text));
    check(
      "...and it says the reader needs no account",
      /without an account/.test(published.text),
    );

    const namedShare = await call(env, OWNER_TOKEN, "write_note", {
      path: "1-projects/named-share.md",
      content: "# Named\n",
      share: "anyone",
      share_short: "Signup",
    });
    check("a short name can be claimed on the same call", namedShare.text.includes("/@seyi/signup"));

    const membersShare = await call(env, OWNER_TOKEN, "write_note", {
      path: "1-projects/members-only.md",
      content: "# Members\n",
      share: "members",
    });
    check(
      "share=members mints the workspace link, not the open one",
      membersShare.text.includes("members of this context"),
    );

    /*
      `collect` is one word rather than an audience plus a mode.

      `create_link` keeps the two axes apart because a share row has both. Here
      one enum of three plain words is what an agent can use without reading a
      schema it may not have, and the mapping to (audience, mode) is made in
      exactly one place.
    */
    const collectWrite = await call(env, OWNER_TOKEN, "write_note", {
      path: "1-projects/collect-form.md",
      content: [
        "# Intake",
        "",
        "```form",
        "id: intake",
        "responses: 1-projects/collect-form-responses.md",
        "layout: table",
        "submit: member",
        "fields:",
        "  - { name: who, type: line, max: 120, required: true }",
        "```",
        "",
      ].join("\n"),
      share: "collect",
    });
    check("share=collect publishes a form for people with no account", !collectWrite.isError);
    check(
      "...and the answers file was created by the same call",
      /response file created: 1-projects\/collect-form-responses\.md/.test(collectWrite.text),
    );
    check("...and the link says it takes answers", /taking answers: yes/.test(collectWrite.text));
    check(
      "...and the agent is told to pass on what a collect link hands out",
      /without an account and without being named/.test(collectWrite.text),
    );

    /*
      THE INCIDENT, EXACTLY (2026-09-24).

      An owner asked their assistant for a client intake form and a link. The
      form went where their own clients live — a folder that defaults to
      private — and a personal connection's new note is private anyway. The
      link was refused, the refusal arrived as "control plane unavailable:
      status 500", and four retries changed nothing.

      Asking for a link anyone can open is asking for the note to be readable
      by the workspace, so the one call now does both — and leaves the answers
      where their folder puts them, because who reads the answers is a
      separate question the owner did not ask.
    */
    const intake = await call(env, OWNER_TOKEN, "write_note", {
      path: "2-areas/clients/new-client.md",
      content: [
        "# New client intake",
        "",
        "```form",
        "id: new-client",
        "responses: 2-areas/clients/new-client-responses.md",
        "layout: table",
        "submit: member",
        "fields:",
        "  - { name: name, type: line, max: 120, required: true }",
        "  - { name: brief, type: text, max: 4000, required: true }",
        "```",
        "",
      ].join("\n"),
      share: "collect",
      share_short: "new-client",
    });
    check("a form in a private folder publishes with one call", !intake.isError);
    check(
      "...and comes back with its short link",
      intake.text.includes("short link: ") && intake.text.includes("/@seyi/new-client"),
    );
    check("...and it takes answers", /taking answers: yes/.test(intake.text));
    check(
      "...and it says the note was published to the workspace for the link",
      /visibility: team \(published to this workspace so the link can open it/.test(intake.text),
    );
    {
      const { rules, overrides } = parsePrivacyManifest(bucket.objects.get("privacy.md").body);
      check(
        "...and the form note really is team-visible now",
        effectiveVisibility("2-areas/clients/new-client.md", rules, overrides) === "team",
      );
      check(
        "...while its answers stay where their folder puts them — private",
        effectiveVisibility("2-areas/clients/new-client-responses.md", rules, overrides) === "private",
      );
    }

    const contradictory = await call(env, OWNER_TOKEN, "write_note", {
      path: "2-areas/clients/kept-private.md",
      content: "# Kept private\n",
      visibility: "private",
      share: "anyone",
    });
    check("share with visibility=private is refused as a contradiction", contradictory.isError);
    check(
      "...before anything is written",
      !bucket.objects.has("2-areas/clients/kept-private.md"),
    );

    // An encrypted note is never linked for anyone, so asking for that link
    // must not first publish it to the workspace for a link that is then
    // refused. A real encrypted note, written with this workspace's key.
    await call(env, OWNER_TOKEN, "write_note", { path: "2-areas/sealed.md", content: "# Sealed\n" });
    const sealing = await call(env, OWNER_TOKEN, "set_encryption", {
      path: "2-areas/sealed.md",
      encrypted: true,
    });
    check("(fixture) the note is really encrypted", !sealing.isError);
    const sealedBefore = bucket.objects.get("2-areas/sealed.md").body;
    const sealedShare = await call(env, OWNER_TOKEN, "write_note", {
      path: "2-areas/sealed.md",
      content: "# Sealed\n\nnew words\n",
      share: "anyone",
    });
    check("an encrypted note asked for an open link is refused", sealedShare.isError);
    {
      const { rules, overrides } = parsePrivacyManifest(bucket.objects.get("privacy.md").body);
      check(
        "...and is neither published to the workspace nor rewritten on the way",
        effectiveVisibility("2-areas/sealed.md", rules, overrides) === "private" &&
          bucket.objects.get("2-areas/sealed.md").body === sealedBefore,
      );
    }

    /*
      A REFUSAL THAT IS THE OWNER'S TO FIX IS NAMED, NOT A 500.

      `create_link` never publishes on its own — it only links — so a private
      note is refused. The owner is told why, in the control plane's own words.
    */
    bucket.seed("2-areas/salaries.md", "# Salaries\n");
    const privateLink = await call(env, OWNER_TOKEN, "create_link", { path: "2-areas/salaries.md" });
    check("create_link over a private note is refused", privateLink.isError);
    check(
      "...with the reason, rather than 'control plane unavailable'",
      privateLink.text.includes(NOTE_REFUSED_SENTENCE) && !/unavailable/.test(privateLink.text),
    );

    const plainWrite = await call(env, OWNER_TOKEN, "write_note", {
      path: "1-projects/unshared.md",
      content: "# Private thought\n",
    });
    check(
      "a write that did not ask to share mints nothing",
      !plainWrite.isError && !/link: https/.test(plainWrite.text),
    );

    /*
      THE NOTE IS NEVER LOST TO A REFUSED SHARE.

      A read-only grant cannot mint. The write it asked for is a separate
      authority that it also does not have, so this one refuses outright — but
      the case that matters is the *writer who is not an owner*, below, where
      the note must land and only the link is refused.
    */
    const memberShare = await call(env, MEMBER_TOKEN, "write_note", {
      path: "1-projects/member-write.md",
      content: "# From a member\n",
      share: "anyone",
    });
    check("a member cannot publish through write_note either", memberShare.isError);

    /*
      THE CASE THAT MATTERS: A CALLER WHO MAY WRITE AND MAY NOT MINT.

      This grant writes — it is shown `write_note` — and reads at team tier, so
      the control plane refuses it a link. Returning an error would throw away
      a note that was correctly written and is already stored, and the caller
      would have no way to tell "nothing happened" from "everything happened
      but the link". Both outcomes, named, is the only honest answer.

      Sabotaging the refusal line failed NOTHING until this existed, which is
      the whole reason it is here.
    */
    const writerNotOwner = await call(env, TEAM_TIER_TOKEN, "write_note", {
      path: "1-projects/writer-not-owner.md",
      content: "# Written but not published\n",
      share: "anyone",
    });
    check("a writer who is not the owner still gets their note", !writerNotOwner.isError);
    check(
      "...and the write is reported as having happened",
      /written: 1-projects\/writer-not-owner\.md/.test(writerNotOwner.text),
    );
    check(
      "...and the refused link is reported beside it, not swallowed",
      /the note was written, but/.test(writerNotOwner.text),
    );
    check("...and no URL is invented for it", !/link: https/.test(writerNotOwner.text));

    /* ----------------------------- who may mint ---------------------------- */

    const memberList = await rpc(env, MEMBER_TOKEN, "tools/list");
    check(
      "a member is not shown the link tools at all",
      !memberList.result.tools.some((tool) => tool.name === "create_link"),
    );
    const memberMint = await call(env, MEMBER_TOKEN, "create_link", { path: NOTE });
    check("...and a member that calls one anyway is refused", memberMint.isError);

    /*
      THE TIER GATE, WHICH IS A DIFFERENT GATE FROM THE ROLE ONE.

      A member is filtered out by write scope and would be whatever this set
      said. This grant writes — it is shown `write_note` — and reads at team
      tier, which is exactly what `PRIVATE_TIER_ONLY_TOOLS` decides. Without
      that entry it would be offered three tools the control plane refuses
      every time, and an agent would spend a turn finding that out.
    */
    const teamTierList = await rpc(env, TEAM_TIER_TOKEN, "tools/list");
    check(
      "a team-tier grant is shown the write tools",
      teamTierList.result.tools.some((tool) => tool.name === "write_note"),
    );
    check(
      "...and not the link tools, which are the owner's private-tier ones",
      !teamTierList.result.tools.some((tool) =>
        ["create_link", "list_links", "revoke_link"].includes(tool.name),
      ),
    );
    const teamTierMint = await call(env, TEAM_TIER_TOKEN, "create_link", { path: NOTE });
    check("...and calling one anyway is refused", teamTierMint.isError);

    const readOnlyMint = await call(env, READONLY_TOKEN, "create_link", { path: NOTE });
    check("a read-only grant cannot mint, whatever its role", readOnlyMint.isError);
    check(
      "...and the refusal names no reason it could not have known",
      !readOnlyMint.text.includes(NOTE),
    );

    /* ------------------------------- listing ------------------------------- */

    const listed = await call(env, OWNER_TOKEN, "list_links");
    check("the owner's listing names what it published", listed.text.includes(`opens: ${NOTE}`));
    check("...and every row carries a URL", (listed.text.match(/link: https:\/\//g) ?? []).length >= 2);
    check(
      "...and no row carries a token to assemble one from",
      !/token/i.test(listed.text),
    );

    const otherList = await call(env, OTHER_TOKEN, "list_links");
    check(
      "another context's owner sees nothing of this one",
      !otherList.text.includes(NOTE),
    );

    /* ------------------------------- revoking ------------------------------ */

    const foreign = await call(env, OTHER_TOKEN, "revoke_link", { share_id: shareId });
    check("an id from another context cannot be revoked", foreign.isError);
    const invented = await call(env, OTHER_TOKEN, "revoke_link", { share_id: "share_nope" });
    check(
      "...and answers exactly as an invented id does",
      foreign.text === invented.text,
    );

    /*
      AND THE FOUR CAUSES MUST COST THE SAME, NOT ONLY READ THE SAME.

      The check above closes the channel a caller READS. This closes the one a
      caller MEASURES: two answers that are byte-identical to read and a
      different number of round trips apart are still two answers. The trips
      that matter on this tool are the gateway's calls to the control plane
      rather than the bucket's, because that is where a share row is looked up
      and where "found but not yours" could cost more than "never minted".

      Counted rather than timed, so this is deterministic. The number is not
      the invariant; the equality is.
    */
    const revokeTripsFor = async (token, id) => {
      const before = controlPlane.gatewayCalls.total;
      await call(env, token, "revoke_link", { share_id: id });
      return controlPlane.gatewayCalls.total - before;
    };
    const foreignTrips = await revokeTripsFor(OTHER_TOKEN, shareId);
    const inventedTrips = await revokeTripsFor(OTHER_TOKEN, "share_nope");
    check(
      `a real id from another context costs what an invented one costs `
        + `(foreign ${foreignTrips}, invented ${inventedTrips})`,
      foreignTrips === inventedTrips,
    );

    const revoked = await call(env, OWNER_TOKEN, "revoke_link", { share_id: shareId });
    check("the owner can revoke", !revoked.isError);
    check(
      "...and is told the card that already unfurled cannot be recalled",
      /cannot be recalled/.test(revoked.text),
    );
    const again = await call(env, OWNER_TOKEN, "revoke_link", { share_id: shareId });
    check("revoking twice refuses like an id that never existed", again.isError);
    const goneTrips = await revokeTripsFor(OWNER_TOKEN, shareId);
    const neverTrips = await revokeTripsFor(OWNER_TOKEN, "share_never_minted");
    check(
      `an id already gone costs what one that never existed costs `
        + `(gone ${goneTrips}, never ${neverTrips})`,
      goneTrips === neverTrips,
    );

    const afterRevoke = await call(env, OWNER_TOKEN, "list_links");
    check("...and the link is out of the listing", !afterRevoke.text.includes(`opens: ${NOTE}\n`));
  } finally {
    restore?.();
  }
}
