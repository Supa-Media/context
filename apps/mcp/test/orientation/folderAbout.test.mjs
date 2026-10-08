/**
 * The one-line description `orient` draws beside each folder, read from the
 * folder's front note. See orientation.test.mjs for the module overview.
 *
 * What the map promises, and what each check holds it to:
 *
 * - a description comes from the folder's own `about.md`, first prose line;
 * - `overview.md` describes a folder that has no `about.md`, and `about.md`
 *   beats it when both exist;
 * - a note the caller cannot see is neither read nor named, so a team caller
 *   learns nothing about a private folder's or a private note's text;
 * - the placeholders we wrote long ago, and an encrypted note's body, are never
 *   shown;
 * - the reads are bounded, so a context with many folders pays a fixed price.
 */

import { orientText, createBucket, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./fixtures.mjs";

const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n  2-areas: private\n" +
  "  3-resources: team\n  4-archive: team\n  5-notes: team\n\n" +
  "note_overrides:\n  1-projects/quiet/about.md: private\n  5-notes/about.md: private\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/** Thirty folders, each one team-visible by its own rule. */
const MANY_FOLDERS_MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n" +
  Array.from({ length: 30 }, (_, n) => `  p${String(n).padStart(2, "0")}: team\n`).join("") +
  "```\n\n<!-- END BRAIN PRIVACY RULES -->\n";

const ENCRYPTED_ABOUT =
  "---\ncontext_encryption: v1\n---\n\nLocked plans for the summer.\n\n" +
  "```context-encrypted\nAAAA\n```\n";

/** The one map line for `prefix`, trimmed, or undefined when the map omits it. */
function lineOf(text, prefix) {
  if (typeof text !== "string") return undefined;
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line === `- ${prefix}` || line.startsWith(`- ${prefix} `));
}

function workspaceEnv(id, bucket) {
  return {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
    NATIVE_BINDINGS: `${id.toUpperCase()}_BUCKET`,
    [`${id.toUpperCase()}_BUCKET`]: bucket,
  };
}

async function addWorkspaceWithTokens(controlPlane, id, tokenSeed) {
  await controlPlane.addWorkspace(id, id.replace("ws_", ""), {
    provider: "r2-binding",
    bindingName: `${id.toUpperCase()}_BUCKET`,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  });
  const owner = `cat_orientation_${tokenSeed}_owner_${"0".repeat(12)}`;
  const team = `cat_orientation_${tokenSeed}_team_${"0".repeat(13)}`;
  await controlPlane.addGrant({
    accessToken: owner,
    workspaceId: id,
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: `mcp_client_${tokenSeed}_owner`,
    userId: `user_${tokenSeed}_owner`,
  });
  await controlPlane.addGrant({
    accessToken: team,
    workspaceId: id,
    role: "editor",
    scopes: ["context:read"],
    clientId: `mcp_client_${tokenSeed}_team`,
    userId: `user_${tokenSeed}_team`,
  });
  return { owner, team };
}

export async function runOrientationFolderAboutChecks(check, harness) {
  const { controlPlane } = harness;

  // -- one workspace with every case the description rules name ---------------
  const { owner, team } = await addWorkspaceWithTokens(controlPlane, "ws_folderabout", "folderabout");
  const bucket = createBucket();
  bucket.seed("privacy.md", MANIFEST);
  bucket.seed("index.md", "# Front page");
  for (const [key, text] of Object.entries({
    "1-projects/about.md": "---\ntitle: Projects\n---\n\n# Projects\n\nThe work with a finish line.\n",
    "1-projects/alpha/about.md": "# Alpha\n\nThe client site rebuild.\n",
    "1-projects/alpha/overview.md": "Overview text that should lose.\n",
    "1-projects/quiet/about.md": "PRIVATE QUIET about text.\n",
    "1-projects/quiet/overview.md": "Quiet overview is what shows.\n",
    "1-projects/locked/about.md": ENCRYPTED_ABOUT,
    "2-areas/about.md": "SECRET AREA about text.\n",
    "3-resources/overview.md": "Things we keep for reference.\n",
    "3-resources/long/about.md":
      "This description has no full stop anywhere in it, so it has to be cut down to the " +
      "character cap rather than shown whole, which is the point of the check.\n",
    // A folder the team can see only because its overview is shared: the
    // private about.md beside it is a top-level listing entry, the case the
    // survey's own front-note candidates must filter.
    "5-notes/about.md": "PRIVATE 5 about text.\n",
    "5-notes/overview.md": "Team-visible overview of notes.\n",
    "4-archive/README.md": "Folder placeholder.\n\nThis folder was created automatically.\n",
  })) {
    bucket.seed(key, text);
  }
  const env = workspaceEnv("ws_folderabout", bucket);
  const ownerMap = await orientText(env, owner);
  const teamMap = await orientText(env, team);

  check(
    "a folder's description is the first prose line of its about.md, with the heading and frontmatter left out",
    lineOf(ownerMap, "1-projects/")?.endsWith(" — The work with a finish line.")
  );
  check(
    "the description sits beside the count, in the compact form the map uses",
    /^- 1-projects\/ \(\d+ notes\) — The work with a finish line\.$/.test(lineOf(ownerMap, "1-projects/") || "")
  );
  check(
    "a subfolder's about.md describes the subfolder, on its own line",
    lineOf(ownerMap, "1-projects/alpha/") === "- 1-projects/alpha/ (2 notes) — The client site rebuild."
  );
  check(
    "overview.md describes a folder that has no about.md",
    lineOf(ownerMap, "3-resources/")?.endsWith(" — Things we keep for reference.")
  );
  check(
    "about.md beats overview.md when a folder has both",
    lacks(ownerMap, "Overview text that should lose") && ownerMap?.includes("The client site rebuild.")
  );
  check(
    "a description longer than the cap is cut to it, with a mark that it was cut",
    (() => {
      const line = lineOf(ownerMap, "3-resources/long/") || "";
      const description = line.split(" — ")[1] || "";
      return description.endsWith("…") && description.length <= 120 && description.length > 100;
    })()
  );

  // -- privacy: the caller's view decides what is read and named ---------------
  check(
    "the owner sees a private folder's about text",
    lineOf(ownerMap, "2-areas/")?.endsWith(" — SECRET AREA about text.")
  );
  check(
    "a team caller is shown no line for a private folder, and none of its text",
    lineOf(teamMap, "2-areas/") === undefined && lacks(teamMap, "SECRET AREA")
  );
  check(
    "a private about.md inside a team folder is not shown to a team caller",
    lacks(teamMap, "PRIVATE QUIET")
  );
  check(
    "...so the overview they can see describes that folder instead",
    lineOf(teamMap, "1-projects/quiet/")?.endsWith(" — Quiet overview is what shows.")
  );
  check(
    "a top-level folder's private about.md is not shown to a team caller, who gets its overview",
    lineOf(teamMap, "5-notes/")?.endsWith(" — Team-visible overview of notes.") &&
      lacks(teamMap, "PRIVATE 5")
  );
  check(
    "the owner, who can see the private about.md, gets it",
    lineOf(ownerMap, "1-projects/quiet/")?.endsWith(" — PRIVATE QUIET about text.")
  );

  // -- placeholders and encryption are never shown -----------------------------
  check(
    "a README.md placeholder we wrote earlier is not shown as a description",
    lineOf(ownerMap, "4-archive/") === "- 4-archive/ (1 note)" && lacks(ownerMap, "Folder placeholder")
  );
  check(
    "an encrypted front note is skipped, and its plaintext-looking body is not shown",
    lineOf(ownerMap, "1-projects/locked/") === "- 1-projects/locked/ (1 note)" &&
      lacks(ownerMap, "Locked plans for the summer") &&
      lacks(teamMap, "Locked plans for the summer")
  );

  // -- the guidance that teaches an agent where descriptions live --------------
  check(
    "orient tells the agent where a folder's description lives and to keep it current",
    ownerMap?.includes("first line of its `about.md`") && ownerMap?.includes("write or update its `about.md`")
  );

  // -- a bounded number of reads -----------------------------------------------
  // Thirty folders, each with an about.md, on a bucket that counts what it is
  // asked for. The map draws every folder, but reads only as many descriptions
  // as the budget allows, and says nothing about the rest rather than guessing.
  const budget = await addWorkspaceWithTokens(controlPlane, "ws_folderbudget", "folderbudget");
  const many = createBucket();
  many.seed("privacy.md", MANY_FOLDERS_MANIFEST);
  many.seed("index.md", "# Front page");
  for (let n = 0; n < 30; n += 1) {
    const folder = `p${String(n).padStart(2, "0")}`;
    many.seed(`${folder}/about.md`, `Folder ${folder} is for work.\n`);
  }
  const aboutReads = [];
  const realGet = many.get;
  many.get = async (key) => {
    if (key.endsWith("/about.md")) aboutReads.push(key);
    return realGet(key);
  };
  const manyText = await orientText(workspaceEnv("ws_folderbudget", many), budget.owner);
  const described = (manyText || "")
    .split("\n")
    .filter((line) => /^- p\d\d\/ \(1 note\) — Folder p\d\d is for work\.$/.test(line));
  check(
    "a context with many folders reads no more front notes than the orient budget allows",
    aboutReads.length <= 24 && aboutReads.length > 0
  );
  check(
    "...describes exactly as many folders as it read, and draws the rest without a description",
    described.length === aboutReads.length &&
      described.length === 24 &&
      manyText?.includes("- p29/ (1 note)\n")
  );
}

function lacks(text, needle) {
  return typeof text === "string" && !text.includes(needle);
}
