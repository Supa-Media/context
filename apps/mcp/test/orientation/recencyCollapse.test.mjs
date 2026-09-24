/**
 * Automated capture is not attention: the recency collapse, and `canSee`
 * still filtering everything the collapsed line summarises. See
 * orientation.test.mjs for the module overview and the sabotage-testing
 * record (§4 covers this section).
 *
 * docs/decisions/communications.md, "A firehose is not attention": a
 * connected mailbox writes a note every active day, forever, and a
 * meeting note lands just as often — so a recency list ranked by raw
 * timestamp becomes nothing but that traffic within days of either being
 * switched on, and the note a person actually touched falls off the
 * bottom. The fix is not exclusion (an agent asked "what came in?" would
 * learn nothing): each automated kind collapses to one line, never
 * individual entries, and never at the cost of a note a person edited.
 */

import { orientText, createBucket, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./fixtures.mjs";

export async function runOrientationRecencyCollapseChecks(check, harness) {
  const { controlPlane } = harness;

  // Its own workspace and bucket, seeded fresh, so the assertions below do
  // not have to account for anything the blocks above already wrote.
  controlPlane.addWorkspace("ws_recency", "recency", {
    provider: "r2-binding",
    bindingName: "RECENCY_BUCKET",
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  });
  const RECENCY_OWNER = `cat_orientation_recency_owner_${"0".repeat(6)}`;
  const RECENCY_TEAM = `cat_orientation_recency_team_${"0".repeat(7)}`;
  await controlPlane.addGrant({
    accessToken: RECENCY_OWNER,
    workspaceId: "ws_recency",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_recency_owner",
    userId: "user_recency_owner",
  });
  await controlPlane.addGrant({
    accessToken: RECENCY_TEAM,
    workspaceId: "ws_recency",
    role: "editor",
    scopes: ["context:read"],
    clientId: "mcp_client_recency_member",
    userId: "user_recency_member",
  });

  const recencyBucket = createBucket();
  recencyBucket.seed(
    "privacy.md",
    "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
      "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
      "folder_defaults:\n  index.md: team\n  1-projects: team\n  2-areas: team\n" +
      "  0-inbox: team\n  0-inbox/email/private-at-example-com: private\n```\n\n" +
      "<!-- END BRAIN PRIVACY RULES -->\n"
  );
  recencyBucket.seed("index.md", "# Front page");

  const recencyNow = Date.parse("2026-09-07T12:00:00Z");
  // 30 team-visible mail days, oldest first. Written by a connected
  // mailbox exactly the way docs/decisions/communications.md describes —
  // one note per active day — so any one of these, taken alone, would rank
  // above every hand-edited note below on raw timestamp.
  let newestMailKey = "";
  for (let day = 0; day < 30; day += 1) {
    const at = new Date(recencyNow - (30 - day) * 24 * 60 * 60 * 1000);
    const key = `0-inbox/email/name-at-example-com/${at.toISOString().slice(0, 10)}.md`;
    recencyBucket.seed(key, "a day of mail", at);
    newestMailKey = key;
  }
  // A second, private mailbox — not a colleague's business, and its days
  // must not reach a team caller's collapsed count at all. Dated well
  // before the newest team-visible mail day, so the owner's "newest"
  // pointer below is proved against the team-visible group, not this one.
  recencyBucket.seed(
    "0-inbox/email/private-at-example-com/2026-08-20.md",
    "private mail",
    new Date(recencyNow - 18 * 24 * 60 * 60 * 1000)
  );
  // Two meetings, a different automated kind, collapsing to its own line.
  recencyBucket.seed(
    "0-inbox/meetings/2026-09-05-standup-aaaaaaaa.md",
    "meeting one",
    new Date(recencyNow - 2 * 24 * 60 * 60 * 1000)
  );
  recencyBucket.seed(
    "0-inbox/meetings/2026-09-06-standup-bbbbbbbb.md",
    "meeting two",
    new Date(recencyNow - 1 * 24 * 60 * 60 * 1000)
  );
  // One saved session at the unrouted default.
  recencyBucket.seed(
    "0-inbox/sessions/claude/2026-09-06T10-00-00-000Z.md",
    "session one",
    new Date(recencyNow - 12 * 60 * 60 * 1000)
  );
  // Three calendar days — its own kind, never folded into the mail count
  // above even though both are "automated capture" in the same sense.
  let newestCalendarKey = "";
  for (let day = 0; day < 3; day += 1) {
    const at = new Date(recencyNow - (3 - day) * 24 * 60 * 60 * 1000);
    const key = `0-inbox/calendar/${at.toISOString().slice(0, 10)}.md`;
    recencyBucket.seed(key, "a day of the calendar", at);
    newestCalendarKey = key;
  }
  // Three notes a person actually wrote or edited, oldest and newest far
  // enough apart that a broken sort cannot pass by accident.
  recencyBucket.seed("1-projects/alpha.md", "alpha", new Date(recencyNow - 1 * 60 * 60 * 1000));
  recencyBucket.seed("1-projects/beta.md", "beta", new Date(recencyNow - 5 * 60 * 60 * 1000));
  recencyBucket.seed("2-areas/gamma.md", "gamma", new Date(recencyNow - 40 * 24 * 60 * 60 * 1000));

  const recencyEnv = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
    NATIVE_BINDINGS: "RECENCY_BUCKET",
    RECENCY_BUCKET: recencyBucket,
  };

  const recencyOwnerText = await orientText(recencyEnv, RECENCY_OWNER);
  const ownerRecent = recencyOwnerText.split("## Recently updated")[1]?.split("---")[0] || "";

  check(
    "a hand-edited note still appears individually in the recency list",
    ownerRecent.includes("1-projects/alpha.md —") &&
      ownerRecent.includes("1-projects/beta.md —") &&
      ownerRecent.includes("2-areas/gamma.md —")
  );
  check(
    "the ordering among hand-edited notes is unchanged by the collapse",
    ownerRecent.indexOf("1-projects/alpha.md —") < ownerRecent.indexOf("1-projects/beta.md —") &&
      ownerRecent.indexOf("1-projects/beta.md —") < ownerRecent.indexOf("2-areas/gamma.md —")
  );
  check(
    "not one of 30 mail-day notes appears as an individual recency entry",
    !/^- 0-inbox\/email\//m.test(ownerRecent)
  );
  check(
    "30 team-visible mail days collapse to a single line naming the count",
    /^- 31 mail days arrived/m.test(ownerRecent)
  );
  // 31, not 30: the owner's own scope sees the private mailbox too, and it
  // is the same `channel-day` kind — proved apart from the team scope below.
  check(
    "the collapsed mail line points at the newest day, not an arbitrary one",
    ownerRecent.includes(`newest \`${newestMailKey}\``)
  );
  check(
    "meetings collapse likewise: one line, not two individual entries",
    /^- 2 meetings arrived/m.test(ownerRecent) &&
      !ownerRecent.includes("0-inbox/meetings/2026-09-05-standup-aaaaaaaa.md —") &&
      !ownerRecent.includes("0-inbox/meetings/2026-09-06-standup-bbbbbbbb.md —")
  );
  check(
    "the collapsed meeting line points at the newer of the two",
    ownerRecent.includes("newest `0-inbox/meetings/2026-09-06-standup-bbbbbbbb.md`")
  );
  check(
    "a saved session at the unrouted default collapses to its own kind",
    /^- 1 saved session arrived/m.test(ownerRecent) &&
      !ownerRecent.includes("0-inbox/sessions/claude/2026-09-06T10-00-00-000Z.md —")
  );
  check(
    "calendar days collapse to their own line — never counted as mail, never as an individual entry",
    /^- 3 calendar days arrived/m.test(ownerRecent) &&
      !/^- 34 mail days arrived/m.test(ownerRecent) &&
      !/^- 0-inbox\/calendar\//m.test(ownerRecent)
  );
  check(
    "the collapsed calendar line points at the newest calendar day",
    ownerRecent.includes(`newest \`${newestCalendarKey}\``)
  );
  // Sabotage, measured: dropped `"calendar-day"` from `summarizeCaptured`'s
  // `order` array (leaving `classifyCaptureKind` itself untouched) — 2
  // checks failed, exactly these two, and not the individual-entry check
  // three lines up, which is the interesting result rather than a shortfall:
  // a calendar day is still classified as automated capture, so it is
  // still removed from `authored` before `mostRecent` runs, and it simply
  // vanishes from orient's answer with no summary line either — the
  // "silence" failure "A firehose is not attention" was written to reject,
  // reached from `order` instead of from `classifyCaptureKind`.
  check(
    "the section explains that automated capture is collapsed",
    ownerRecent.includes("collapsed to one")
  );
  // The property that separates this from the exclusion this decision
  // rejected: an agent asking "what came in?" is answered, not met with a
  // recency list that simply never mentions mail, meetings or sessions.
  check(
    "toolOrient answers \"what came in\" with a pointer, never silence",
    ownerRecent.includes("mail days arrived") &&
      ownerRecent.includes("meetings arrived") &&
      ownerRecent.includes("saved session arrived")
  );

  // The person edits a channel-day note — the only lever available, since
  // nothing in this stack records who made a write (see
  // src/communications/paths.js). The etag and the modified time both
  // change, exactly as they would for an ingestion rewrite; the path does
  // not. It must stay collapsed regardless.
  recencyBucket.seed(
    `0-inbox/email/name-at-example-com/${new Date(recencyNow - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}.md`,
    "a day of mail, edited by hand just now",
    new Date(recencyNow + 60 * 1000)
  );
  const afterEditText = await orientText(recencyEnv, RECENCY_OWNER);
  const afterEditRecent = afterEditText.split("## Recently updated")[1]?.split("---")[0] || "";
  check(
    "a person's edit to a channel-day note stays collapsed, not promoted to an entry",
    !/^- 0-inbox\/email\//m.test(afterEditRecent) && /^- 31 mail days arrived/m.test(afterEditRecent)
  );
  check(
    "and the collapsed line's newest pointer moves to the edited note",
    afterEditRecent.includes(
      `newest \`0-inbox/email/name-at-example-com/${new Date(recencyNow - 1 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10)}.md\``
    )
  );
  check(
    "the edit did not displace or reorder the hand-edited notes",
    afterEditRecent.indexOf("1-projects/alpha.md —") < afterEditRecent.indexOf("1-projects/beta.md —") &&
      afterEditRecent.indexOf("1-projects/beta.md —") < afterEditRecent.indexOf("2-areas/gamma.md —")
  );

  // -- canSee still filters everything the collapsed line summarises
  const recencyTeamText = await orientText(recencyEnv, RECENCY_TEAM);
  const teamRecent = recencyTeamText.split("## Recently updated")[1]?.split("---")[0] || "";
  check(
    "a team caller's collapsed mail count excludes a private mailbox",
    /^- 30 mail days arrived/m.test(teamRecent) && !teamRecent.includes("31 mail days")
  );
  check(
    "a team caller never sees the private mailbox's folder name anywhere in the list",
    !teamRecent.includes("private-at-example-com")
  );
  check(
    "a team caller's collapsed newest day is never the private mailbox's",
    !teamRecent.includes("newest `0-inbox/email/private-at-example-com")
  );
}
