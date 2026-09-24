/**
 * What `scope_info` (and orient's write-surface section) tells a connection
 * about where it may write: the team-writable folders, and the private
 * overrides beneath them.
 */

import { readOnlyNotice } from "../orient/access.js";

function teamWritableRules(rules) {
  return rules.filter((rule) => rule.vis === "team").sort((a, b) => a.prefix.localeCompare(b.prefix));
}

function visiblePrivateOverrides(rules) {
  const teamRules = teamWritableRules(rules);
  return rules
    .filter(
      (rule) =>
        rule.vis === "private" &&
        teamRules.some(
          (teamRule) =>
            rule.prefix === teamRule.prefix || rule.prefix.startsWith(`${teamRule.prefix}/`)
        )
    )
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}

export function scopeInfoText(scope, rules, reach = null) {
  const teamRules = teamWritableRules(rules);
  const overrides = visiblePrivateOverrides(rules);
  const teamList = teamRules.length
    ? teamRules.map((rule) => `- ${rule.prefix}`).join("\n")
    : "- (none)";
  const overrideList = overrides.length
    ? overrides.map((rule) => `- ${rule.prefix}`).join("\n")
    : "- (none)";

  if (scope === "private") {
    return (
      "## Write surface\n" +
      readOnlyNotice(reach) +
      "Connection access: personal. New notes default to private.\n\n" +
      "Writable: every non-reserved Markdown path. privacy.md is readable here but protected from ordinary note writes.\n\n" +
      "Team-default folder prefixes:\n" +
      teamList +
      "\n\nFolder-level private overrides inside team-default trees:\n" +
      overrideList +
      "\n\nExact private or team notes may override a folder default through privacy.md. " +
      "Frontmatter is never access control. Publishing private content to team requires explicit confirmation. " +
      "A note reads as team, or it does not; what holds a note back is not disclosed here. " +
    "The owner may separately have handed out an unlisted link to a note; you are not told which. " +
      "A link you add to a note can widen one already sent, because such a link also serves what the note links to. " +
      "Personal reviewers can process queued proposals." +
      "\n\n## Forms and links, on write_note\n" +
      "A fenced ```form block in a note IS a form: writing the note validates it and creates its answers note in the same call. write_note's own description carries the block's grammar. " +
      "Pass share=anyone, share=members or share=collect on the same write_note call to hand out a link to it — share=collect is what lets people with NO account fill in the form — and share_short for a memorable address under this handle. " +
      "When they ask for a form to send people, that is one call: the form block, share=collect, and a share_short made from the form's name (new-client, feedback). Asking for the link also publishes the note to this workspace, because a link only opens what the workspace can read; the answers note keeps its own visibility. " +
      "These are arguments rather than separate tools on purpose: a client that has not re-fetched its tool list cannot call a new tool, but it can always pass a new argument. " +
      ""
    );
  }

  return (
    "## Write surface\n" +
    readOnlyNotice(reach) +
    "Connection access: team. New notes default to team.\n\n" +
    "Team-writable folder defaults:\n" +
    teamList +
    "\n\nAny new .md file or subfolder under a writable prefix is allowed; the folder does not need to exist first. " +
    "Exact private notes and private folders may exist inside a team prefix; their paths remain undisclosed. " +
    "Explicitly published team notes may also exist inside private-default folders and remain individually visible. " +
    "Reads outside the visible surface return not found to avoid leaking private-path existence. " +
    "Write and move destinations outside the surface return permission denied without confirming whether anything exists there.\n\n" +
    "If the PARA-correct destination is not writable, use propose_note. A personal connection must approve it before the note is filed. " +
    "Archive paths never encode visibility. Exact archive visibility is enforced through privacy.md. " +
    "A note reads as team, or it does not; what holds a note back is not disclosed here. " +
    "The owner may separately have handed out an unlisted link to a note; you are not told which. " +
    "A link you add to a note can widen one already sent, because such a link also serves what the note links to." +
    "\n\n## Forms and links, on write_note\n" +
      "A fenced ```form block in a note IS a form: writing the note validates it and creates its answers note in the same call. write_note's own description carries the block's grammar. " +
    "Handing out a link is the context owner's, so write_note's share argument is not yours to pass here." +
    ""
  );
}
