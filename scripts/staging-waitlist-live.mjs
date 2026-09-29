/**
 * Invite-only sign-in, the waitlist and both kinds of invite, live against
 * staging with real mail.
 *
 * Runs from `.github/workflows/waitlist-live-staging.yml`. The backend suite
 * (`apps/convex/__tests__/waitlistJourney.test.ts`) walks the same journeys
 * against a fake mailbox; this is the same walk against the deployed staging
 * backend, with every code and link read out of a real inbox, so it also
 * proves the mail is sent, arrives, and carries links that work.
 *
 * Who plays whom:
 *  - staff is the seeded `alpha@supa.media` persona (docs/staging.md), which
 *    signs in with the staging-only fixed code and must be in staging's
 *    `ADMIN_EMAILS`;
 *  - the stranger, their teammate and their friend are fresh AgentMail inboxes
 *    made for this run, so no run sees another's mail.
 *
 * One staff action stands in for a step outside this backend: invites unlock
 * once somebody's AI client has connected, and here staff give the new person
 * an invite instead (the console's "give more invites", which also unlocks).
 * The CLI live run covers connecting a client.
 *
 * Everything it creates is removed at the end, whatever happened: the three
 * accounts delete themselves (and with them their workspaces), the run's
 * community link is deleted, and the inboxes are deleted. The waitlist row
 * stays, marked removed, because the list keeps one row per address for good.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const STAFF = "alpha@supa.media";
const STAFF_CODE = "000000";
const AGENTMAIL = "https://api.agentmail.to/v0";
const MAIL_TIMEOUT_MS = 3 * 60 * 1000;

const deployment = process.env.STAGING_CONVEX_DEPLOYMENT;
const agentmailKey = process.env.AGENTMAIL_API_KEY;
assert.equal(process.env.APP_ENV, "staging", "APP_ENV must be staging");
assert.ok(deployment && /^[a-z0-9-]+$/.test(deployment), "STAGING_CONVEX_DEPLOYMENT is required");
assert.ok(agentmailKey, "AGENTMAIL_API_KEY is required (GitHub staging environment)");

const CONVEX_URL = `https://${deployment}.convex.cloud`;
const ref = (name) => makeFunctionReference(name);
const client = () => new ConvexHttpClient(CONVEX_URL, { logger: false });
const pass = (label) => console.log(`PASS  ${label}`);
const run = randomBytes(4).toString("hex");

// -- the real mailbox --------------------------------------------------------

async function agentmail(method, path, body) {
  const response = await fetch(`${AGENTMAIL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${agentmailKey}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`AgentMail ${method} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

const inboxes = [];
async function newInbox(role) {
  const inbox = await agentmail("POST", "/inboxes", {
    username: `ctx-e2e-${run}-${role}`,
    display_name: `Context e2e ${role}`,
    client_id: `ctx-e2e-${run}-${role}`,
  });
  inboxes.push(inbox);
  return { id: inbox.inbox_id, email: inbox.email.toLowerCase() };
}

/** Wait for the first mail whose subject matches and that `seen` has not had yet. */
async function waitForMail(inbox, subject, seen = new Set()) {
  const deadline = Date.now() + MAIL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const list = await agentmail("GET", `/inboxes/${encodeURIComponent(inbox.id)}/messages?limit=50`);
    const hit = list.messages.find((m) => subject.test(m.subject ?? "") && !seen.has(m.message_id));
    if (hit) {
      seen.add(hit.message_id);
      return agentmail(
        "GET",
        `/inboxes/${encodeURIComponent(inbox.id)}/messages/${encodeURIComponent(hit.message_id)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error(`no mail matching ${subject} reached the ${inbox.email.split("@")[0]} inbox`);
}

function linkIn(mail, path) {
  const body = `${mail.text ?? ""}\n${mail.html ?? ""}`;
  const links = [...body.matchAll(/https:\/\/[^\s"<>)]+/g)].map((match) => new URL(match[0].replace(/&amp;/g, "&")));
  const link = links.find((url) => path.test(url.pathname));
  assert.ok(link, `no ${path} link in "${mail.subject}"`);
  return link;
}

// -- signing in ---------------------------------------------------------------

const sessions = [];
async function signInWithMailedCode(inbox, seen) {
  const convex = client();
  await convex.action(ref("auth:signIn"), { provider: "email", params: { email: inbox.email } });
  const mail = await waitForMail(inbox, /is your Context code$/, seen);
  const code = /^(\d{6}) /.exec(mail.subject)?.[1];
  assert.ok(code, "the sign-in mail carries no code in its subject");
  const signed = await convex.action(ref("auth:signIn"), { provider: "email", params: { email: inbox.email, code } });
  assert.ok(signed.tokens?.token, `sign-in with the mailed code failed for the ${inbox.email.split("@")[0]} inbox`);
  convex.setAuth(signed.tokens.token);
  sessions.push(convex);
  return { convex, userId: userIdOf(signed.tokens.token) };
}

/** `@convex-dev/auth`'s subject is `<userId>|<sessionId>`. */
function userIdOf(jwt) {
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  return String(payload.sub).split("|")[0];
}

async function expectRefused(email) {
  await assert.rejects(
    client().action(ref("auth:signIn"), { provider: "email", params: { email } }),
    `a code was offered to ${email.split("@")[0]}, who is not let in`,
  );
}

// -- the run ------------------------------------------------------------------

let staff = null;
let linkId = null;
const accounts = [];

try {
  staff = client();
  await staff.action(ref("auth:signIn"), { provider: "email", params: { email: STAFF } });
  const signed = await staff.action(ref("auth:signIn"), { provider: "email", params: { email: STAFF, code: STAFF_CODE } });
  assert.ok(signed.tokens?.token, "the staff persona could not sign in; run Seed Staging Personas");
  staff.setAuth(signed.tokens.token);
  assert.equal(
    await staff.query(ref("functions/admin:amIAdmin"), {}),
    true,
    `${STAFF} is not staff on staging: add it to ADMIN_EMAILS, sync secrets, and redeploy staging`,
  );
  pass("staff signed in and the console knows them");

  // 1. Joining from the homepage, with the optional reason.
  const stranger = await newInbox("stranger");
  const strangerSeen = new Set();
  const reason = `E2E run ${run}: client notes my agents can read`;
  assert.deepEqual(await client().mutation(ref("functions/waitlist:enter"), { email: stranger.email, source: "homepage" }), {
    status: "joined",
  });
  await client().mutation(ref("functions/waitlist:describe"), { email: stranger.email, useFor: reason });
  const joined = await waitForMail(stranger, /waitlist/i, strangerSeen);
  assert.equal(joined.subject, "You're on the Context.LC waitlist");
  assert.deepEqual(await client().mutation(ref("functions/waitlist:enter"), { email: stranger.email }), { status: "already" });
  await expectRefused(stranger.email);
  pass("homepage join: on the list, mailed, reason kept, and still refused a code");

  // 2. Staff see the reason and let them in; "You're in" brings them back.
  const waiting = await staff.query(ref("functions/admin:listWaitlist"), { status: "waiting" });
  const row = waiting.rows.find((r) => r.email === stranger.email);
  assert.ok(row, "the new row is not in the staff Waitlist");
  assert.equal(row.useFor, reason);
  assert.equal(row.source, "homepage");
  assert.equal((await staff.mutation(ref("functions/admin:admitWaitlist"), { ids: [row.id] })).changed, 1);
  const youreIn = await waitForMail(stranger, /^You're in$/, strangerSeen);
  assert.equal(linkIn(youreIn, /^\/login$/).search, "", "the 'you're in' link carries something it should not");
  assert.deepEqual(await client().mutation(ref("functions/waitlist:enter"), { email: stranger.email }), { status: "admitted" });
  const member = await signInWithMailedCode(stranger, strangerSeen);
  accounts.push(member.convex);
  assert.equal(await member.convex.query(ref("functions/admin:amIAdmin"), {}), false);
  pass("staff saw the reason, let them in, and the mailed code signed them in");

  // 3. A community link staff set reaches members only.
  linkId = (
    await staff.mutation(ref("functions/admin:saveCommunityLink"), {
      kind: "other",
      label: `E2E ${run}`,
      url: `https://example.com/e2e-${run}`,
      audience: "members",
    })
  ).id;
  const seenByMember = await member.convex.query(ref("functions/referrals:communityLinks"), {});
  assert.ok(seenByMember.some((link) => link.id === linkId), "a signed-in member does not see the members link");
  const seenSignedOut = await client().query(ref("functions/referrals:communityLinks"), {});
  assert.ok(!seenSignedOut.some((link) => link.id === linkId), "a signed-out visitor sees a members-only link");
  const discord = (await staff.query(ref("functions/admin:listCommunityLinks"), {})).find((link) => link.kind === "discord");
  console.log(discord ? `  the Discord link is set (${discord.audience})` : "  no Discord link is set on staging yet");
  pass("community links: staff set one, members see it, visitors do not");

  // 4. A workspace for their business, and a teammate invited into it.
  const handle = `e2e${run}`;
  await member.convex.mutation(ref("functions/workspaces:createWorkspace"), { slug: handle, displayName: `E2E ${run}`, kind: "personal" });
  const team = await member.convex.mutation(ref("functions/workspaces:createWorkspace"), {
    slug: `${handle}-studio`,
    displayName: `E2E Studio ${run}`,
    kind: "shared",
  });
  const teammate = await newInbox("teammate");
  await expectRefused(teammate.email);
  await member.convex.mutation(ref("functions/invitations:inviteMember"), {
    workspaceId: team.workspaceId,
    invitee: teammate.email,
    role: "editor",
  });
  assert.deepEqual(await client().mutation(ref("functions/waitlist:enter"), { email: teammate.email }), { status: "admitted" });
  const invitation = linkIn(await waitForMail(teammate, /./), /^\/invite\//);
  const linkCode = invitation.searchParams.get("code");
  assert.ok(linkCode, "the invitation link does not sign its holder in");
  const teammateClient = client();
  const byLink = await teammateClient.action(ref("auth:signIn"), { provider: "magic-link", params: { code: linkCode } });
  assert.ok(byLink.tokens?.token, "the invitation link did not sign the teammate in");
  teammateClient.setAuth(byLink.tokens.token);
  sessions.push(teammateClient);
  accounts.push(teammateClient);
  const token = decodeURIComponent(invitation.pathname.slice("/invite/".length));
  const accepted = await teammateClient.mutation(ref("functions/invitations:acceptInvitation"), { token });
  assert.equal(accepted.role, "editor");
  const members = await member.convex.query(ref("functions/workspaces:listMembers"), { workspaceId: team.workspaceId });
  assert.equal(members.length, 2);
  pass("business workspace: the teammate got in from the invitation link alone and joined as editor");

  // 5. A friend invited to Context itself.
  assert.equal((await member.convex.query(ref("functions/referrals:mine"), {})).locked, "setup");
  await staff.mutation(ref("functions/admin:grantInvites"), { userId: member.userId, add: 1 });
  const friend = await newInbox("friend");
  const friendSeen = new Set();
  await expectRefused(friend.email);
  assert.deepEqual(await member.convex.mutation(ref("functions/referrals:send"), { email: friend.email }), { status: "sent" });
  const invite = await waitForMail(friend, /invited you to Context\.LC/, friendSeen);
  assert.equal(invite.subject, `@${handle} invited you to Context.LC`);
  const joinToken = linkIn(invite, /^\/join\//).pathname.slice("/join/".length);
  assert.deepEqual(await client().query(ref("functions/referrals:preview"), { token: joinToken }), {
    works: true,
    inviterHandle: handle,
  });
  assert.deepEqual(await client().mutation(ref("functions/waitlist:enter"), { email: friend.email }), { status: "admitted" });
  const friendAccount = await signInWithMailedCode(friend, friendSeen);
  accounts.push(friendAccount.convex);
  const mine = await member.convex.query(ref("functions/referrals:mine"), {});
  assert.equal(mine.invites.find((i) => i.email === friend.email)?.status, "joined");
  pass("referral: the friend got the mail, the /join link worked, and they signed in");

  // 6. Staff can trace it.
  const referrals = await staff.query(ref("functions/admin:listReferrals"), {});
  const traced = referrals.rows.find((r) => r.email === friend.email);
  assert.equal(traced?.status, "joined");
  assert.equal(traced?.inviterHandle, handle);
  console.log(`  staff counts: waitlist ${JSON.stringify(waiting.counts)}, referrals ${JSON.stringify(referrals.counts)}`);
  pass("staff see the referral as joined, credited to the person who sent it");
} finally {
  for (const convex of accounts.reverse()) {
    await convex
      .mutation(ref("functions/account:deleteAccount"), {})
      .catch((error) => console.log(`  could not delete a run account: ${error.message}`));
  }
  if (staff !== null) {
    if (linkId !== null) await staff.mutation(ref("functions/admin:deleteCommunityLink"), { id: linkId }).catch(() => {});
    const rows = await staff.query(ref("functions/admin:listWaitlist"), { status: "admitted" }).catch(() => ({ rows: [] }));
    const ours = rows.rows.filter((r) => r.email.startsWith(`ctx-e2e-${run}-`)).map((r) => r.id);
    if (ours.length > 0) await staff.mutation(ref("functions/admin:removeFromWaitlist"), { ids: ours }).catch(() => {});
    await staff.action(ref("auth:signOut"), {}).catch(() => {});
  }
  for (const convex of sessions) await convex.action(ref("auth:signOut"), {}).catch(() => {});
  for (const inbox of inboxes) {
    await agentmail("DELETE", `/inboxes/${encodeURIComponent(inbox.inbox_id)}`).catch(() => {});
  }
  console.log(`  cleaned up run ${run}`);
}
