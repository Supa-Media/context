import worker from "../src/index.js";
import { R2Store } from "../src/store/r2.js";
import { runStoreChecks } from "./store.test.mjs";

// --- in-memory R2 stub, wrapped in the same adapter the worker builds ---
const objects = new Map();
let etagCounter = 0;
const bucket = {
  async get(key) {
    if (!objects.has(key)) return null;
    const { body, etag } = objects.get(key);
    return {
      etag,
      text: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  },
  async put(key, value, options = {}) {
    const expected = options?.onlyIf?.etagMatches;
    if (expected && objects.get(key)?.etag !== expected) return null;
    const body =
      typeof value === "string" ? value : new TextDecoder().decode(value);
    const etag = `e${++etagCounter}`;
    objects.set(key, { body, etag });
    return { etag };
  },
  async delete(key) {
    objects.delete(key);
  },
  async list({ prefix, cursor, limit } = {}) {
    const listed = [...objects.keys()]
      .filter((k) => !prefix || k.startsWith(prefix))
      .sort()
      .map((key) => ({ key, size: objects.get(key).body.length, uploaded: new Date() }));
    return { objects: listed, truncated: false };
  },
};

// Seeds and assertions go through the ContextStore, so the suite exercises the
// same adapter the worker uses rather than the raw binding.
const contextStore = new R2Store(bucket);

const env = {
  BRAIN: bucket,
  PRIVATE_TOKEN: "priv-token",
  TEAM_TOKEN: "team-token",
  PUBLIC_TOKEN: "pub-token",
  INBOX_TOKEN: "inbox-token",
  GRANOLA_WEBHOOK_SECRET: `whsec_${btoa("granola-webhook-secret")}`,
  GRANOLA_API_KEY: "granola-api-key",
};

// seed
await contextStore.put(
  "privacy.md",
  `---\nrole: privacy-manifest\nversion: 1\n---\n\n# Brain Privacy Map\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n\`\`\`yaml\ndefault_visibility: private\n\nfolder_defaults:\n  index.md: team\n  team-native: team\n  1-projects: team\n  1-projects/private: private\n  1-projects/secret-thing: private\n  1-projects/private-folder: private\n  1-projects/mixed/private: private\n  2-areas: team\n  2-areas/private: private\n  2-areas/calendar: private\n  2-areas/health: private\n  2-areas/engineering/one-on-ones: private\n  3-resources: team\n  3-resources/private: private\n  4-archive: team\n  4-archive/private: private\n\nnote_overrides:\n  # none\n\`\`\`\n\n<!-- END BRAIN PRIVACY RULES -->\n`
);
await contextStore.put("index.md", "# public manifest");
await contextStore.put("index-private.md", "# PRIVATE manifest");
await contextStore.put("team-native/info.md", "native team scope marker");
await contextStore.put("1-projects/togather/status.md", "togather status SECRETWORD-no wait, public");
await contextStore.put("1-projects/secret-thing/status.md", "hidden project PRIVATEWORD");
await contextStore.put("2-areas/engineering/practices.md", "eng practices");
await contextStore.put("2-areas/engineering/one-on-ones/alex.md", "sensitive 1:1");
await contextStore.put("1-projects/portable/a.md", "portable a");
await contextStore.put("1-projects/portable/existing.md", "portable existing");
await contextStore.put("1-projects/mixed/public.md", "public half");
await contextStore.put("1-projects/mixed/private/secret.md", "private half");
await contextStore.put("1-projects/private-folder/a.md", "private folder a");
await contextStore.put(".obsidian/app.json", "{}");

let rpcId = 0;
async function rpc(token, method, params) {
  const req = new Request("https://x/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const res = await worker.fetch(req, env, { waitUntil() {} });
  return res.status === 202 ? null : await res.json();
}
async function call(token, name, args = {}) {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  return r.result;
}

let failures = 0;
function check(label, cond) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
}

// -- protocol basics
const init = await rpc("priv-token", "initialize", { protocolVersion: "2025-06-18" });
check("initialize echoes protocol", init.result.protocolVersion === "2025-06-18");
check("initialize has instructions", init.result.instructions.includes("PARA"));
check("initialize prompts proactive durable memory", init.result.instructions.includes("rediscover"));
check("initialize prompts scoped chat archiving", init.result.instructions.includes("archive_chat") && init.result.instructions.includes("Default privacy is the"));
const noteRes = await worker.fetch(
  new Request("https://x/mcp", {
    method: "POST",
    headers: { Authorization: "Bearer priv-token" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }),
  env,
  { waitUntil() {} }
);
check("notification → 202", noteRes.status === 202);
const tools = await rpc("priv-token", "tools/list");
check("18 tools listed", tools.result.tools.length === 18);
check("set_visibility tool is discoverable", tools.result.tools.some((tool) => tool.name === "set_visibility"));
check(
  "set_folder_visibility tool is discoverable",
  tools.result.tools.some((tool) => tool.name === "set_folder_visibility")
);
const writeNoteTool = tools.result.tools.find((tool) => tool.name === "write_note");
const setVisibilityTool = tools.result.tools.find((tool) => tool.name === "set_visibility");
const setFolderVisibilityTool = tools.result.tools.find(
  (tool) => tool.name === "set_folder_visibility"
);
const scopeInfoTool = tools.result.tools.find((tool) => tool.name === "scope_info");
const searchNotesTool = tools.result.tools.find((tool) => tool.name === "search_notes");
const archiveChatTool = tools.result.tools.find((tool) => tool.name === "archive_chat");
check(
  "write_note advertises only private and team visibility",
  JSON.stringify(writeNoteTool.inputSchema.properties.visibility?.enum) === JSON.stringify(["private", "team"])
);
check(
  "set_visibility advertises explicit team-publication confirmation",
  setVisibilityTool?.inputSchema?.properties?.confirm_team_publish?.type === "boolean"
);
check(
  "set_folder_visibility supports dry-run, inheritance, and privacy etag protection",
  setFolderVisibilityTool?.inputSchema?.properties?.dry_run?.type === "boolean" &&
    setFolderVisibilityTool?.inputSchema?.properties?.expected_privacy_etag?.type === "string" &&
    setFolderVisibilityTool?.inputSchema?.properties?.visibility?.enum?.includes("inherit")
);
check("scope_info advertises an optional path", scopeInfoTool?.inputSchema?.properties?.path?.type === "string");
check(
  "search_notes advertises an optional performance prefix",
  searchNotesTool?.inputSchema?.properties?.prefix?.type === "string"
);
check(
  "archive_chat exposes no internet-public visibility option",
  JSON.stringify(archiveChatTool.inputSchema.properties.visibility?.enum) === JSON.stringify(["private", "team"])
);
check(
  "tool surface uses team terminology instead of the old public-access wording",
  !/(?:public connections?|writable public|public archive)/i.test(JSON.stringify(tools.result.tools))
);
check(
  "read tools have read-only annotations",
  tools.result.tools.find((tool) => tool.name === "read_note").annotations.readOnlyHint === true
);

// -- auth
const bad = await worker.fetch(
  new Request("https://x/mcp", { method: "POST", body: "{}" }),
  env,
  { waitUntil() {} }
);
check("no token → 401", bad.status === 401);
const teamAliasPing = await rpc("team-token", "ping", {});
check("TEAM_TOKEN authenticates as a team connection", !!teamAliasPing?.result);
check(
  "legacy PUBLIC_TOKEN remains a supported team-credential alias",
  !!(await rpc("pub-token", "ping", {}))?.result
);
check(
  "native team scope rules and legacy public scope rules both resolve as team-visible",
  !(await call("team-token", "read_note", { path: "team-native/info.md" })).isError &&
    !(await call("team-token", "read_note", { path: "1-projects/togather/status.md" })).isError
);
check(
  "server contract says team access is authenticated and not internet-public",
  /team/i.test(init.result.instructions) &&
    /(?:not|no|never)[^\n.]{0,40}(?:internet[- ]public|publicly accessible)/i.test(init.result.instructions)
);

// -- orient scoping
const oPriv = (await call("priv-token", "orient")).content[0].text;
const oPub = (await call("pub-token", "orient")).content[0].text;
check("private orient has private manifest", oPriv.includes("PRIVATE manifest"));
check("orient includes agent ledger contract", oPriv.includes("Read your weekly file"));
check("team orient lacks private manifest", !oPub.includes("PRIVATE manifest"));
check("team orient lacks secret project", !oPub.includes("secret-thing"));
check("team orient shows team project", oPub.includes("1-projects/togather"));
check("team orient hides 1:1 subfolder", !oPub.includes("one-on-ones"));
check("orient hides .obsidian", !oPub.includes(".obsidian") && !oPriv.includes(".obsidian"));
check("orient exposes team write surface", oPub.includes("Team-writable folder defaults") && oPub.includes("2-areas"));
check(
  "orient identifies shared credentials as team access",
  /connection (?:scope|access): team/i.test(oPub) &&
    !/connection (?:scope|access): public/i.test(oPub) &&
    !/writable public prefixes/i.test(oPub)
);
const publicScopeInfo = (await call("pub-token", "scope_info")).content[0].text;
const privateScopeInfo = (await call("priv-token", "scope_info")).content[0].text;
check("team scope_info lists broad team PARA roots", publicScopeInfo.includes("1-projects") && publicScopeInfo.includes("2-areas") && publicScopeInfo.includes("3-resources") && publicScopeInfo.includes("4-archive"));
check("team scope_info hides private override names", !publicScopeInfo.includes("one-on-ones"));
check("private scope_info can audit private overrides", privateScopeInfo.includes("one-on-ones"));

// -- list/read scoping
const lPub = (await call("pub-token", "list_notes")).content[0].text;
check("team list hides privacy.md", !lPub.includes("privacy.md"));
check("team list hides private", !lPub.includes("secret-thing") && !lPub.includes("one-on-ones"));
const rPub = await call("pub-token", "read_note", { path: "1-projects/secret-thing/status.md" });
check("team read of private → not found", rPub.isError && rPub.content[0].text === "not found");
const rPub2 = await call("pub-token", "read_note", { path: "2-areas/engineering/one-on-ones/alex.md" });
check("deeper private rule beats team parent", rPub2.isError);
const rPub3 = await call("pub-token", "read_note", { path: "2-areas/engineering/practices.md" });
check("team reads team area", rPub3.content[0].text.includes("eng practices"));

// -- writes
const wPub = await call("pub-token", "write_note", { path: "2-areas/health/gym.md", content: "x" });
check(
  "team write to private path returns non-leaking permission error",
  wPub.isError && wPub.content[0].text.includes("permission denied") && !wPub.content[0].text.includes("exists")
);
const wPub2 = await call("pub-token", "write_note", { path: "1-projects/togather/notes.md", content: "ok" });
check("legacy public token writes to a team path", !wPub2.isError);
const wPubNewFolder = await call("pub-token", "write_note", {
  path: "2-areas/apps/new-folder-created-by-note.md",
  content: "public app-area note",
});
check(
  "team connection creates a new folder under a broad team PARA root",
  !wPubNewFolder.isError && objects.has("2-areas/apps/new-folder-created-by-note.md")
);
const wPubDeepFolder = await call("team-token", "write_note", {
  path: "2-areas/apps/created-entirely-through-mcp/deep/nested/status.md",
  content: "deep team path",
});
check(
  "team connection creates arbitrarily nested implicit folders under a team default",
  !wPubDeepFolder.isError &&
    objects.has("2-areas/apps/created-entirely-through-mcp/deep/nested/status.md")
);

// -- folder defaults can be managed entirely through the personal MCP
const managedFolder = "2-areas/apps/mcp-managed-visibility";
const managedTeamPath = `${managedFolder}/team-before-change.md`;
const managedPrivatePath = `${managedFolder}/private-before-change.md`;
await call("priv-token", "write_note", {
  path: managedTeamPath,
  content: "team before folder change",
  visibility: "team",
  confirm_team_publish: true,
});
await call("priv-token", "write_note", {
  path: managedPrivatePath,
  content: "private before folder change",
  visibility: "private",
});
const folderPrivacyDryRun = await call("priv-token", "set_folder_visibility", {
  path: managedFolder,
  visibility: "private",
  dry_run: true,
});
const folderPrivacyDryRunText = folderPrivacyDryRun.content[0].text;
const folderPrivacyEtag = folderPrivacyDryRunText.match(/privacy_etag: (\S+)/)?.[1];
check(
  "folder visibility dry-run reports impact and makes no change",
  !folderPrivacyDryRun.isError &&
    folderPrivacyDryRunText.includes("dry run: no changes made") &&
    folderPrivacyDryRunText.includes("resulting_default: private") &&
    !(await call("team-token", "read_note", { path: managedTeamPath })).isError
);
const folderPrivacyMissingEtag = await call("priv-token", "set_folder_visibility", {
  path: managedFolder,
  visibility: "private",
});
check(
  "folder visibility apply requires the privacy manifest etag",
  folderPrivacyMissingEtag.isError && folderPrivacyMissingEtag.content[0].text.includes("dry_run=true")
);
const makeFolderPrivate = await call("priv-token", "set_folder_visibility", {
  path: managedFolder,
  visibility: "private",
  expected_privacy_etag: folderPrivacyEtag,
});
const makeFolderPrivateText = makeFolderPrivate.content[0].text;
const privateFolderPrivacyEtag = makeFolderPrivateText.match(/new_privacy_etag: (\S+)/)?.[1];
const privacyAfterFolderPrivate = await objects.get("privacy.md").body;
check(
  "personal MCP atomically makes a folder private and hides every inherited note from team",
  !makeFolderPrivate.isError &&
    (await call("team-token", "read_note", { path: managedTeamPath })).isError &&
    (await call("team-token", "read_note", { path: managedPrivatePath })).isError &&
    privacyAfterFolderPrivate.includes(`  ${managedFolder}: private`)
);
check(
  "folder rule change removes redundant exact-note exceptions",
  !privacyAfterFolderPrivate.includes(`  ${managedPrivatePath}: private`)
);
const teamBlockedUnderManagedPrivate = await call("team-token", "write_note", {
  path: `${managedFolder}/team-must-not-create.md`,
  content: "blocked",
});
check(
  "team nested creation is blocked only when the inherited folder default is private",
  teamBlockedUnderManagedPrivate.isError && !objects.has(`${managedFolder}/team-must-not-create.md`)
);
const publishFolderWithoutConfirmation = await call("priv-token", "set_folder_visibility", {
  path: managedFolder,
  visibility: "inherit",
  expected_privacy_etag: privateFolderPrivacyEtag,
});
check(
  "private folder to inherited-team transition requires explicit confirmation",
  publishFolderWithoutConfirmation.isError &&
    (await call("team-token", "read_note", { path: managedTeamPath })).isError
);
const publishFolderWithConfirmation = await call("priv-token", "set_folder_visibility", {
  path: managedFolder,
  visibility: "inherit",
  expected_privacy_etag: privateFolderPrivacyEtag,
  confirm_team_publish: true,
});
check(
  "confirmed inheritance change republishes the folder and removes its direct rule",
  !publishFolderWithConfirmation.isError &&
    !(await call("team-token", "read_note", { path: managedTeamPath })).isError &&
    !objects.get("privacy.md").body.includes(`  ${managedFolder}: private`)
);
const teamCannotChangeFolderVisibility = await call("team-token", "set_folder_visibility", {
  path: managedFolder,
  visibility: "private",
  dry_run: true,
});
check("team connections cannot mutate folder defaults", teamCannotChangeFolderVisibility.isError);

// -- per-note private/team visibility inside one logical folder
const teamMeetingPath = "2-areas/engineering/meetings/team-planning.md";
const privateMeetingPath = "2-areas/engineering/meetings/personnel-check-in.md";
const teamMeeting = await call("priv-token", "write_note", {
  path: teamMeetingPath,
  content: "# Team planning\n\nTEAM-SIDE-BY-SIDE-MARKER",
  visibility: "team",
  confirm_team_publish: true,
});
const privateMeeting = await call("priv-token", "write_note", {
  path: privateMeetingPath,
  content: "# Personnel check-in\n\nPRIVATE-SIDE-BY-SIDE-MARKER",
  visibility: "private",
});
check(
  "personal connection creates private and team notes side-by-side in one team folder",
  !teamMeeting.isError &&
    !privateMeeting.isError &&
    objects.has(teamMeetingPath) &&
    objects.has(privateMeetingPath)
);
check(
  "write_note reports the effective visibility explicitly",
  /visibility:\s*team/i.test(teamMeeting.content[0].text) &&
    /visibility:\s*private/i.test(privateMeeting.content[0].text)
);
const teamReadsTeamMeeting = await call("team-token", "read_note", { path: teamMeetingPath });
const teamReadsPrivateMeeting = await call("team-token", "read_note", { path: privateMeetingPath });
check("team connection reads the adjacent team note", !teamReadsTeamMeeting.isError);
check(
  "exact private note is indistinguishable from missing to a team connection",
  teamReadsPrivateMeeting.isError && teamReadsPrivateMeeting.content[0].text === "not found"
);
const teamMeetingList = (await call("team-token", "list_notes", {
  prefix: "2-areas/engineering/meetings",
})).content[0].text;
const teamPrivateSearch = (await call("team-token", "search_notes", {
  query: "PRIVATE-SIDE-BY-SIDE-MARKER",
})).content[0].text;
const teamOrientAfterPrivateNote = (await call("team-token", "orient")).content[0].text;
check(
  "private note is absent from team listings",
  teamMeetingList.includes(teamMeetingPath) && !teamMeetingList.includes(privateMeetingPath)
);
check("private note content is absent from team search", !teamPrivateSearch.includes(privateMeetingPath));
check(
  "private note name is absent from team orientation",
  !teamOrientAfterPrivateNote.includes("personnel-check-in")
);

const privateScopeByPath = await call("priv-token", "scope_info", { path: privateMeetingPath });
const teamScopeByPath = await call("priv-token", "scope_info", { path: teamMeetingPath });
const hiddenScopeByPath = await call("team-token", "scope_info", { path: privateMeetingPath });
const absentMeetingPath = "2-areas/engineering/meetings/absent-note.md";
const absentScopeByPath = await call("team-token", "scope_info", { path: absentMeetingPath });
check(
  "scope_info(path) tells a personal connection the exact effective visibility",
  privateScopeByPath.content[0].text.includes(privateMeetingPath) &&
    /visibility:\s*private/i.test(privateScopeByPath.content[0].text) &&
    teamScopeByPath.content[0].text.includes(teamMeetingPath) &&
    /visibility:\s*team/i.test(teamScopeByPath.content[0].text)
);
check(
  "scope_info(path) does not disclose a private override to a team connection",
  !/effective visibility:\s*private/i.test(hiddenScopeByPath.content[0].text) &&
    !/(?:note|path) exists:\s*(?:yes|true)/i.test(hiddenScopeByPath.content[0].text) &&
    hiddenScopeByPath.content[0].text.replaceAll(privateMeetingPath, "<path>") ===
      absentScopeByPath.content[0].text.replaceAll(absentMeetingPath, "<path>")
);

const personalPrivateRead = (await call("priv-token", "read_note", {
  path: privateMeetingPath,
})).content[0].text;
const privateMeetingEtag = personalPrivateRead.match(/etag: (\S+)/)?.[1];
const privateUpdate = await call("priv-token", "write_note", {
  path: privateMeetingPath,
  content: "# Personnel check-in\n\nPRIVATE-UPDATED-MARKER",
  expected_etag: privateMeetingEtag,
});
check("updating a note without visibility preserves its private ACL", !privateUpdate.isError);
check(
  "updated private note stays unreadable and unsearchable to team",
  (await call("team-token", "read_note", { path: privateMeetingPath })).isError &&
    !(await call("team-token", "search_notes", { query: "PRIVATE-UPDATED-MARKER" })).content[0].text.includes(privateMeetingPath)
);

const teamCannotCreatePrivatePath = "2-areas/engineering/meetings/team-cannot-hide.md";
const teamPrivateWrite = await call("team-token", "write_note", {
  path: teamCannotCreatePrivatePath,
  content: "must not be filed",
  visibility: "private",
});
check(
  "team connection cannot directly create a private note",
  teamPrivateWrite.isError && !objects.has(teamCannotCreatePrivatePath)
);
const internetPublicWrite = await call("priv-token", "write_note", {
  path: "2-areas/engineering/meetings/internet-public.md",
  content: "must not become anonymous",
  visibility: "public",
});
check(
  "write_note exposes no internet-public visibility tier",
  internetPublicWrite.isError && !objects.has("2-areas/engineering/meetings/internet-public.md")
);
const misleadingFrontmatterPath = "2-areas/engineering/meetings/frontmatter-mismatch.md";
const misleadingFrontmatter = await call("priv-token", "write_note", {
  path: misleadingFrontmatterPath,
  content: "---\nscope: private\n---\n# Sensitive",
  visibility: "team",
  confirm_team_publish: true,
});
check(
  "server rejects private frontmatter paired with team visibility",
  misleadingFrontmatter.isError && !objects.has(misleadingFrontmatterPath)
);

const teamMeetingRead = (await call("priv-token", "read_note", { path: teamMeetingPath })).content[0].text;
const teamMeetingEtag = teamMeetingRead.match(/etag: (\S+)/)?.[1];
const makeMeetingPrivate = await call("priv-token", "set_visibility", {
  path: teamMeetingPath,
  visibility: "private",
  expected_etag: teamMeetingEtag,
});
check(
  "personal connection can narrow a team note to private in place",
  !makeMeetingPrivate.isError &&
    objects.has(teamMeetingPath) &&
    (await call("team-token", "read_note", { path: teamMeetingPath })).isError
);
const nowPrivateMeetingRead = (await call("priv-token", "read_note", {
  path: teamMeetingPath,
})).content[0].text;
const nowPrivateMeetingEtag = nowPrivateMeetingRead.match(/etag: (\S+)/)?.[1];
const publishWithoutConfirmation = await call("priv-token", "set_visibility", {
  path: teamMeetingPath,
  visibility: "team",
  expected_etag: nowPrivateMeetingEtag,
});
check(
  "private to team transition requires explicit publication confirmation",
  publishWithoutConfirmation.isError &&
    (await call("team-token", "read_note", { path: teamMeetingPath })).isError
);
const publishWithConfirmation = await call("priv-token", "set_visibility", {
  path: teamMeetingPath,
  visibility: "team",
  expected_etag: nowPrivateMeetingEtag,
  confirm_team_publish: true,
});
check(
  "confirmed private to team transition publishes the same logical note",
  !publishWithConfirmation.isError &&
    objects.has(teamMeetingPath) &&
    !(await call("team-token", "read_note", { path: teamMeetingPath })).isError
);
const teamCannotChangeVisibility = await call("team-token", "set_visibility", {
  path: teamMeetingPath,
  visibility: "private",
});
check("team connections cannot mutate note ACLs", teamCannotChangeVisibility.isError);

const inheritedPrivatePath = "2-areas/private/meetings/inherited-private.md";
const inheritedPrivateWrite = await call("priv-token", "write_note", {
  path: inheritedPrivatePath,
  content: "inherited private content",
  visibility: "private",
});
const inheritedPrivateEtag = (await call("priv-token", "read_note", {
  path: inheritedPrivatePath,
})).content[0].text.match(/etag: (\S+)/)?.[1];
const publishInsidePrivateFolder = await call("priv-token", "set_visibility", {
  path: inheritedPrivatePath,
  visibility: "team",
  expected_etag: inheritedPrivateEtag,
  confirm_team_publish: true,
});
const createTeamInsidePrivateFolder = await call("priv-token", "write_note", {
  path: "2-areas/private/meetings/invalid-team-child.md",
  content: "must stay absent",
  visibility: "team",
});
check("private note can be created under an inherited-private folder", !inheritedPrivateWrite.isError);
check(
  "explicitly confirmed exact team override works inside an inherited-private folder",
  !publishInsidePrivateFolder.isError &&
    createTeamInsidePrivateFolder.isError &&
    !objects.has("2-areas/private/meetings/invalid-team-child.md") &&
    !(await call("team-token", "read_note", { path: inheritedPrivatePath })).isError
);
const teamUpdatesPublishedPrivateFolderNote = await call("team-token", "write_note", {
  path: inheritedPrivatePath,
  content: "team-updated exact exception",
  expected_etag: inheritedPrivateEtag,
});
check(
  "team connection can update a known exact-team note inside a private-default folder",
  !teamUpdatesPublishedPrivateFolderNote.isError
);

const teamToPrivateSource = "2-areas/engineering/meetings/team-to-private-move.md";
await call("priv-token", "write_note", {
  path: teamToPrivateSource,
  content: "team note that will move into a private tree",
  visibility: "team",
  confirm_team_publish: true,
});
const teamToPrivateMove = await call("priv-token", "move_note", {
  source: teamToPrivateSource,
  destination: "2-areas/private/meetings/team-to-private-move.md",
});
check(
  "moving a team note into an inherited-private folder safely tightens access",
  !teamToPrivateMove.isError &&
    (await call("team-token", "read_note", {
      path: "2-areas/private/meetings/team-to-private-move.md",
    })).isError
);

const movePrivateMeeting = await call("priv-token", "move_note", {
  source: privateMeetingPath,
  destination: "2-areas/engineering/meetings/personnel-check-in-renamed.md",
});
const movedPrivateMeetingPath = "2-areas/engineering/meetings/personnel-check-in-renamed.md";
check(
  "moving a private note within a team folder preserves its ACL",
  !movePrivateMeeting.isError &&
    objects.has(movedPrivateMeetingPath) &&
    !objects.has(privateMeetingPath) &&
    (await call("team-token", "read_note", { path: movedPrivateMeetingPath })).isError
);
const archivePrivateMeeting = await call("priv-token", "archive_note", {
  path: movedPrivateMeetingPath,
});
const archivedPrivateMeetingPath = archivePrivateMeeting.content[0].text.match(/→ (\S+)/)?.[1];
check(
  "archiving a private note preserves private visibility and logical history",
  !archivePrivateMeeting.isError &&
    archivedPrivateMeetingPath &&
    objects.has(archivedPrivateMeetingPath) &&
    !objects.has(movedPrivateMeetingPath) &&
    (await call("team-token", "read_note", { path: archivedPrivateMeetingPath })).isError
);

// -- etag CAS + history
const read1 = (await call("priv-token", "read_note", { path: "index.md" })).content[0].text;
const etag = read1.match(/etag: (\S+)/)[1];
const wOk = await call("priv-token", "write_note", { path: "index.md", content: "v2", expected_etag: etag });
check("CAS write with fresh etag ok", !wOk.isError);
const wStale = await call("priv-token", "write_note", { path: "index.md", content: "v3", expected_etag: etag });
check("CAS write with stale etag conflicts", wStale.isError && wStale.content[0].text.includes("conflict"));
check("history snapshot exists", [...objects.keys()].some((k) => k.startsWith(".history/index.md.")));

// -- search scoping
const sPub = (await call("pub-token", "search_notes", { query: "status" })).content[0].text;
check("team search hides private hits", !sPub.includes("secret-thing"));
const sPriv = (await call("priv-token", "search_notes", { query: "PRIVATEWORD" })).content[0].text;
check("private search finds private", sPriv.includes("secret-thing"));
const sPrefixed = (await call("priv-token", "search_notes", {
  query: "portable",
  prefix: "1-projects/portable",
})).content[0].text;
check(
  "prefixed search stays inside the requested visible subtree",
  sPrefixed.includes("1-projects/portable/") && !sPrefixed.includes("2-areas/")
);

// -- archive
const arch = await call("priv-token", "archive_note", { path: "1-projects/togather/notes.md" });
const privateArchiveKey = [...objects.keys()].find((key) => key.endsWith("/1-projects/togather/notes.md"));
check(
  "archive preserves private ACL without a privacy-named folder",
  !arch.isError &&
    privateArchiveKey?.startsWith("4-archive/") &&
    !privateArchiveKey.startsWith("4-archive/private/") &&
    (await call("team-token", "read_note", { path: privateArchiveKey })).isError &&
    !objects.has("1-projects/togather/notes.md")
);
await call("pub-token", "write_note", { path: "1-projects/togather/probe.md", content: "temporary probe" });
const probeRead = (await call("pub-token", "read_note", { path: "1-projects/togather/probe.md" })).content[0].text;
const probeEtag = probeRead.match(/etag: (\S+)/)[1];
const publicArchiveWithoutEtag = await call("pub-token", "archive_note", {
  path: "1-projects/togather/probe.md",
});
check("team archive requires etag", publicArchiveWithoutEtag.isError && objects.has("1-projects/togather/probe.md"));
const publicArchive = await call("pub-token", "archive_note", {
  path: "1-projects/togather/probe.md",
  expected_etag: probeEtag,
});
const publicArchiveKey = [...objects.keys()].find((key) => key.endsWith("/1-projects/togather/probe.md"));
check(
  "team archive retracts into team-visible recoverable archive",
  !publicArchive.isError &&
    publicArchiveKey?.startsWith("4-archive/") &&
    !publicArchiveKey.startsWith("4-archive/team/") &&
    !objects.has("1-projects/togather/probe.md")
);

// -- private-approval proposal queue
const proposal = await call("pub-token", "propose_note", {
  path: "2-areas/private/apps/example.md",
  content: "# Proposed app note",
  reason: "Apps belong in the apps area",
  agent: "Claude Code",
});
const proposalText = proposal.content[0].text;
const proposalId = proposalText.match(/proposal queued: ([0-9a-f-]+)/i)?.[1];
check(
  "team connection can queue a private-destination proposal without filing it",
  !proposal.isError && proposalId && !objects.has("2-areas/private/apps/example.md")
);
const publicProposalList = await call("pub-token", "list_proposals");
check("team connection cannot inspect proposal queue", publicProposalList.isError);
const privateProposalList = (await call("priv-token", "list_proposals")).content[0].text;
check(
  "private connection lists proposal metadata",
  privateProposalList.includes(proposalId) &&
    privateProposalList.includes("2-areas/private/apps/example.md") &&
    !privateProposalList.includes("# Proposed app note")
);
const privateProposalRead = (await call("priv-token", "read_proposal", { id: proposalId })).content[0].text;
check("private connection reads proposal content", privateProposalRead.includes("# Proposed app note"));
const approveProposal = await call("priv-token", "review_proposal", {
  id: proposalId,
  action: "approve",
});
check(
  "private approval files proposal and clears pending queue",
  !approveProposal.isError && objects.has("2-areas/private/apps/example.md") &&
    (await call("priv-token", "list_proposals")).content[0].text.includes("no pending")
);
const rejectedProposal = await call("pub-token", "propose_note", {
  path: "2-areas/private/apps/rejected.md",
  content: "reject me",
  reason: "testing rejection",
  agent: "Claude Code",
});
const rejectedId = rejectedProposal.content[0].text.match(/proposal queued: ([0-9a-f-]+)/i)?.[1];
const rejectReview = await call("priv-token", "review_proposal", { id: rejectedId, action: "reject" });
check("private rejection preserves no destination note", !rejectReview.isError && !objects.has("2-areas/private/apps/rejected.md"));

// -- privacy-aware chat history archives
const privateChatArchive = await call("priv-token", "archive_chat", {
  platform: "codex",
  history: "## User\nBuild the Brain.\n\n## Assistant\nDone.",
  completeness: "full-visible-transcript",
  title: "Private Codex transcript",
  session_id: "thread-private-1",
});
const privateChatPath = privateChatArchive.content[0].text.match(/chat archived: (\S+)/)?.[1];
check(
  "private connection defaults chat history to private",
  !privateChatArchive.isError &&
    privateChatPath?.startsWith("4-archive/chat-history/codex/") &&
    objects.get(privateChatPath)?.body.includes('visibility: "private"') &&
    objects.get(privateChatPath)?.body.includes('completeness: "full-visible-transcript"')
);
const publicReadPrivateChat = await call("pub-token", "read_note", { path: privateChatPath });
check("team connection cannot discover private chat history", publicReadPrivateChat.isError && publicReadPrivateChat.content[0].text === "not found");

const privatePublishedChat = await call("priv-token", "archive_chat", {
  platform: "chatgpt",
  history: "## User\nPublish this chat.\n\n## Assistant\nPublished.",
  visibility: "team",
  confirm_team_publish: true,
  completeness: "available-context",
});
const privatePublishedPath = privatePublishedChat.content[0].text.match(/chat archived: (\S+)/)?.[1];
check(
  "personal connection can explicitly publish a chat archive to team visibility",
  !privatePublishedChat.isError &&
    privatePublishedPath?.startsWith("4-archive/chat-history/chatgpt/") &&
    !((await call("pub-token", "read_note", { path: privatePublishedPath })).isError)
);

const publicChatArchive = await call("pub-token", "archive_chat", {
  platform: "claude",
  history: "## User\nTeam by default?\n\n## Assistant\nYes.",
});
const publicChatPath = publicChatArchive.content[0].text.match(/chat archived: (\S+)/)?.[1];
check(
  "team connection defaults chat history to team and labels partial context",
  !publicChatArchive.isError &&
    publicChatPath?.startsWith("4-archive/chat-history/claude/") &&
    objects.get(publicChatPath)?.body.includes('visibility: "team"') &&
    objects.get(publicChatPath)?.body.includes('completeness: "available-context"')
);

const publicPrivateChat = await call("pub-token", "archive_chat", {
  platform: "claude",
  history: "## User\nMake this one private.\n\n## Assistant\nQueued privately.",
  visibility: "private",
  completeness: "full-visible-transcript",
});
const privateChatProposalId = publicPrivateChat.content[0].text.match(/proposal queued: ([0-9a-f-]+)/i)?.[1];
const privateChatIntendedPath = publicPrivateChat.content[0].text.match(/intended path: (\S+)/)?.[1];
check(
  "team connection explicitly requesting private chat history creates a hidden proposal",
  !publicPrivateChat.isError &&
    privateChatProposalId &&
    privateChatIntendedPath?.startsWith("4-archive/chat-history/claude/") &&
    !objects.has(privateChatIntendedPath)
);
const approvePrivateChat = await call("priv-token", "review_proposal", {
  id: privateChatProposalId,
  action: "approve",
});
check(
  "personal reviewer can approve a team client's private chat archive",
  !approvePrivateChat.isError &&
    objects.has(privateChatIntendedPath) &&
    (await call("pub-token", "read_note", { path: privateChatIntendedPath })).isError
);

// -- move note / folder
const portableRead = (await call("pub-token", "read_note", { path: "1-projects/portable/a.md" })).content[0].text;
const portableEtag = portableRead.match(/etag: (\S+)/)[1];
const moveNote = await call("pub-token", "move_note", {
  source: "1-projects/portable/a.md",
  destination: "1-projects/portable/renamed.md",
  expected_source_etag: portableEtag,
});
check(
  "team move_note moves within team scope",
  !moveNote.isError && objects.has("1-projects/portable/renamed.md") && !objects.has("1-projects/portable/a.md")
);
const moveConflict = await call("pub-token", "move_note", {
  source: "1-projects/portable/renamed.md",
  destination: "1-projects/portable/existing.md",
});
check("move_note refuses destination overwrite", moveConflict.isError && objects.has("1-projects/portable/renamed.md"));
const mixedMove = await call("pub-token", "move_folder", {
  source: "1-projects/mixed",
  destination: "1-projects/mixed-dest",
});
check(
  "team move_folder refuses a tree with a private island",
  mixedMove.isError && objects.has("1-projects/mixed/public.md") && !objects.has("1-projects/mixed-dest/public.md")
);
const privateFolderMove = await call("priv-token", "move_folder", {
  source: "1-projects/private-folder",
  destination: "1-projects/private-folder-renamed",
});
check(
  "personal move_folder moves a private tree without reducing privacy",
  !privateFolderMove.isError &&
    objects.has("1-projects/private-folder-renamed/a.md") &&
    !objects.has("1-projects/private-folder/a.md") &&
    (await call("team-token", "read_note", { path: "1-projects/private-folder-renamed/a.md" })).isError
);
check(
  "moves snapshot sources to history",
  [...objects.keys()].some((key) => key.startsWith(".history/1-projects/portable/a.md.")) &&
    [...objects.keys()].some((key) => key.startsWith(".history/1-projects/private-folder/a.md."))
);

// -- batch move plan and apply
await call("pub-token", "write_note", { path: "1-projects/portable/batch-a.md", content: "batch a" });
await call("pub-token", "write_note", { path: "1-projects/portable/batch-b.md", content: "batch b" });
const batchPlan = await call("pub-token", "move_notes", {
  dry_run: true,
  moves: [
    { source: "1-projects/portable/batch-a.md", destination: "1-projects/portable-moved/batch-a.md" },
    { source: "1-projects/portable/batch-b.md", destination: "1-projects/portable-moved/batch-b.md" },
  ],
});
const batchPlanText = batchPlan.content[0].text;
const batchEtags = [...batchPlanText.matchAll(/etag (\S+)\)/g)].map((match) => match[1]);
check(
  "batch dry-run validates without changing data",
  !batchPlan.isError && batchEtags.length === 2 &&
    objects.has("1-projects/portable/batch-a.md") && !objects.has("1-projects/portable-moved/batch-a.md")
);
// Simulate a Worker invocation that copied one identical destination before
// hitting its request limit. A retry must resume without treating it as a
// conflicting overwrite.
await contextStore.put("1-projects/portable-moved/batch-a.md", "batch a");
const batchWithoutEtags = await call("pub-token", "move_notes", {
  moves: [
    { source: "1-projects/portable/batch-a.md", destination: "1-projects/portable-moved/batch-a.md" },
    { source: "1-projects/portable/batch-b.md", destination: "1-projects/portable-moved/batch-b.md" },
  ],
});
check("batch apply requires etags", batchWithoutEtags.isError && objects.has("1-projects/portable/batch-a.md"));
const batchApply = await call("pub-token", "move_notes", {
  moves: [
    {
      source: "1-projects/portable/batch-a.md",
      destination: "1-projects/portable-moved/batch-a.md",
      expected_source_etag: batchEtags[0],
    },
    {
      source: "1-projects/portable/batch-b.md",
      destination: "1-projects/portable-moved/batch-b.md",
      expected_source_etag: batchEtags[1],
    },
  ],
});
check(
  "batch apply resumes identical partial copies and moves every note",
  !batchApply.isError &&
    !objects.has("1-projects/portable/batch-a.md") &&
    !objects.has("1-projects/portable/batch-b.md") &&
    objects.has("1-projects/portable-moved/batch-a.md") &&
    objects.has("1-projects/portable-moved/batch-b.md")
);
const folderDryRun = await call("pub-token", "move_folder", {
  source: "1-projects/portable-moved",
  destination: "1-projects/portable",
  dry_run: true,
});
check(
  "folder move dry-run makes no changes",
  !folderDryRun.isError &&
    folderDryRun.content[0].text.includes("preflight ok") &&
    objects.has("1-projects/portable-moved/batch-a.md")
);

// Archive-to-archive relocations already retain a recoverable destination, so
// they avoid creating a redundant history copy when visibility is unchanged.
await contextStore.put("4-archive/old-layout/a.md", "archived a");
const archiveRelocationPlan = await call("priv-token", "move_notes", {
  dry_run: true,
  moves: [{ source: "4-archive/old-layout/a.md", destination: "4-archive/new-layout/a.md" }],
});
const archiveRelocationEtag = archiveRelocationPlan.content[0].text.match(/etag (\S+)\)/)?.[1];
const archiveRelocation = await call("priv-token", "move_notes", {
  moves: [{
    source: "4-archive/old-layout/a.md",
    destination: "4-archive/new-layout/a.md",
    expected_source_etag: archiveRelocationEtag,
  }],
});
check(
  "archive relocation moves without a redundant history snapshot",
  !archiveRelocation.isError &&
    !objects.has("4-archive/old-layout/a.md") &&
    objects.has("4-archive/new-layout/a.md") &&
    ![...objects.keys()].some((key) => key.startsWith(".history/4-archive/old-layout/a.md."))
);

// -- immutable, scope-filtered audit log
await call("priv-token", "write_note", {
  path: "1-projects/secret-thing/private-update.md",
  content: "private audit marker",
});
const publicChanges = (await call("pub-token", "list_changes", { limit: 100 })).content[0].text;
const privateChanges = (await call("priv-token", "list_changes", { limit: 100 })).content[0].text;
check("team change log shows team move", publicChanges.includes("move_note"));
check("team change log hides private paths", !publicChanges.includes("secret-thing") && !publicChanges.includes("private-folder"));
check("private change log includes private paths", privateChanges.includes("secret-thing") && privateChanges.includes("private-folder"));
check(
  "team audit log filters exact-note private ACL events inside team folders",
  !publicChanges.includes("personnel-check-in") &&
    publicChanges
      .split("\n")
      .filter((line) => line.includes("set_visibility") && line.includes(teamMeetingPath)).length === 0
);
check(
  "personal audit log retains private ACL, move, and archive events",
  privateChanges.includes("personnel-check-in") &&
    privateChanges.includes("set_visibility") &&
    privateChanges.includes("inherited-private")
);
const listAfterAudit = (await call("priv-token", "list_notes")).content[0].text;
check("audit plumbing is hidden from note listings", !listAfterAudit.includes(".audit/"));

// -- path token + inbox
const pt = await worker.fetch(
  new Request("https://x/t/pub-token/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "ping" }),
  }),
  env,
  { waitUntil() {} }
);
check("token-in-path auth works", (await pt.json()).id === 999);
const inbox = await worker.fetch(
  new Request("https://x/inbox", {
    method: "POST",
    headers: { Authorization: "Bearer inbox-token", "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Idea!", text: "capture me" }),
  }),
  env,
  { waitUntil() {} }
);
const inboxBody = await inbox.json();
check("inbox capture lands in 0-inbox", inboxBody.ok && inboxBody.path.startsWith("0-inbox/") && objects.has(inboxBody.path));
const granolaPayload = {
  title: "Weekly Leadership Sync",
  text: "## Summary\nWe made a decision.",
  source: "granola",
  external_id: "granola-note-123",
  source_url: "https://app.granola.ai/notes/granola-note-123",
  source_created_at: "2026-08-21T15:00:00Z",
  attendees: ["Seyi", "Alex"],
  metadata: { calendar_event: "Weekly Leadership Sync" },
};
const granolaRequest = () =>
  new Request("https://x/inbox", {
    method: "POST",
    headers: { Authorization: "Bearer inbox-token", "Content-Type": "application/json" },
    body: JSON.stringify(granolaPayload),
  });
const granolaInbox = await worker.fetch(granolaRequest(), env, { waitUntil() {} });
const granolaBody = await granolaInbox.json();
const granolaNote = objects.get(granolaBody.path)?.body || "";
check(
  "structured Granola capture preserves context",
  granolaBody.ok &&
    granolaBody.path.startsWith("0-inbox/granola/") &&
    granolaNote.includes('source: "granola"') &&
    granolaNote.includes('external-id: "granola-note-123"') &&
    granolaNote.includes("Seyi") &&
    granolaNote.includes("https://app.granola.ai/notes/granola-note-123") &&
    granolaNote.includes('"calendar_event": "Weekly Leadership Sync"')
);
const granolaRetry = await worker.fetch(granolaRequest(), env, { waitUntil() {} });
const granolaRetryBody = await granolaRetry.json();
check(
  "structured inbox capture deduplicates provider retries",
  granolaRetryBody.ok && granolaRetryBody.duplicate === true && granolaRetryBody.path === granolaBody.path
);
const invalidInboxJson = await worker.fetch(
  new Request("https://x/inbox", {
    method: "POST",
    headers: { Authorization: "Bearer inbox-token", "Content-Type": "application/json" },
    body: "{nope",
  }),
  env,
  { waitUntil() {} }
);
check("inbox rejects malformed JSON", invalidInboxJson.status === 400);
const oversizedInbox = await worker.fetch(
  new Request("https://x/inbox", {
    method: "POST",
    headers: {
      Authorization: "Bearer inbox-token",
      "Content-Type": "text/plain",
      "Content-Length": "2000001",
    },
    body: "too large",
  }),
  env,
  { waitUntil() {} }
);
check("inbox rejects oversized captures", oversizedInbox.status === 413);
const inboxBad = await worker.fetch(
  new Request("https://x/inbox", { method: "POST", headers: { Authorization: "Bearer pub-token" }, body: "hi" }),
  env,
  { waitUntil() {} }
);
check("inbox rejects team token", inboxBad.status === 401);

// -- native Granola webhook: signed event → API fetch → private inbox
async function signedGranolaRequest(event, { timestamp = Math.floor(Date.now() / 1000), signature = null } = {}) {
  const raw = JSON.stringify(event);
  const webhookId = event.event_id;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("granola-webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${webhookId}.${timestamp}.${raw}`)
    )
  );
  const encoded = btoa(String.fromCharCode(...bytes));
  return new Request("https://x/granola-webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature || `v1,${encoded}`,
    },
    body: raw,
  });
}

const granolaEvent = {
  event_id: "8f1c2a4e-6b3d-4e8f-9a2b-1c5d7e9f0a3b",
  event_type: "note.generated",
  note_id: "not_1d3tmYTlCICgjy",
  occurred_at: "2026-08-21T15:30:00Z",
};
let granolaAuthorization = null;
globalThis.fetch = async (url, options) => {
  if (String(url).includes("public-api.granola.ai/v1/notes/not_1d3tmYTlCICgjy")) {
    granolaAuthorization = options?.headers?.Authorization ?? null;
    return Response.json({
      id: "not_1d3tmYTlCICgjy",
      title: "Quarterly yoghurt budget review",
      created_at: "2026-08-21T15:30:00Z",
      updated_at: "2026-08-21T16:45:00Z",
      web_url: "https://notes.granola.ai/d/example",
      owner: { name: "Seyi", email: "seyi@example.com" },
      attendees: [{ name: "Raisin Patel", email: "raisin@example.com" }],
      calendar_event: { event_title: "Yoghurt review" },
      folder_membership: [{ id: "fol_123", name: "AI Brain Inbox" }],
      summary_markdown: "## Decision\n\nBuy more yoghurt.",
    });
  }
  return new Response("not found", { status: 404 });
};
const granolaWork = [];
const granolaWebhook = await worker.fetch(await signedGranolaRequest(granolaEvent), env, {
  waitUntil: (promise) => granolaWork.push(promise),
});
await Promise.all(granolaWork);
const nativeGranolaNotes = [...objects.entries()].filter(([key]) => key.startsWith("0-inbox/granola/"));
const nativeGranolaText = nativeGranolaNotes.map(([, value]) => value.body).join("\n");
check(
  "signed Granola webhook fetches and files the full note",
  granolaWebhook.status === 202 &&
    nativeGranolaText.includes("Buy more yoghurt") &&
    nativeGranolaText.includes("Raisin Patel <raisin@example.com>") &&
    nativeGranolaText.includes("AI Brain Inbox")
);
check(
  "Granola note fetch still carries its API credential",
  granolaAuthorization === "Bearer granola-api-key"
);
check(
  "completed Granola webhook leaves no pending event",
  ![...objects.keys()].some((key) => key.startsWith(".granola-events/pending/")) &&
    [...objects.keys()].some((key) => key.startsWith(".granola-events/completed/"))
);
const granolaDuplicate = await worker.fetch(await signedGranolaRequest(granolaEvent), env, {
  waitUntil() {},
});
check("Granola webhook deduplicates event retries", (await granolaDuplicate.json()).duplicate === true);
const badGranolaSignature = await worker.fetch(
  await signedGranolaRequest({ ...granolaEvent, event_id: "another-event-id" }, { signature: "v1,bad" }),
  env,
  { waitUntil() {} }
);
check("Granola webhook rejects invalid signatures", badGranolaSignature.status === 401);
const staleGranolaSignature = await worker.fetch(
  await signedGranolaRequest(
    { ...granolaEvent, event_id: "stale-event-id" },
    { timestamp: Math.floor(Date.now() / 1000) - 601 }
  ),
  env,
  { waitUntil() {} }
);
check("Granola webhook rejects replayed old deliveries", staleGranolaSignature.status === 401);

// -- calendar cron
env.CALENDAR_ICS_URL = "https://fake/cal.ics";
const soon = new Date(Date.now() + 3 * 24 * 3600 * 1000);
const y = soon.getUTCFullYear(), mo = String(soon.getUTCMonth() + 1).padStart(2, "0"), d = String(soon.getUTCDate()).padStart(2, "0");
globalThis.fetch = async () =>
  new Response(
    `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:${y}${mo}${d}T140000Z\r\nSUMMARY:Team\r\n  sync\r\nLOCATION:HQ\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
  );
await worker.scheduled({}, env, { waitUntil: (p) => p });
await new Promise((r) => setTimeout(r, 50));
const cal = objects.get("2-areas/calendar/next-14-days.md")?.body || "";
check("cron writes calendar note", cal.includes("Team sync") && cal.includes("@ HQ") && cal.includes("14:00"));

function icsStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function utcAt(date, hour) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour));
}
function shifted(date, { days = 0, months = 0, years = 0 } = {}) {
  const copy = new Date(date);
  if (years) copy.setUTCFullYear(copy.getUTCFullYear() + years);
  if (months) copy.setUTCMonth(copy.getUTCMonth() + months);
  if (days) copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

const targetDay = new Date(Date.now() + 3 * 24 * 3600 * 1000);
const weeklyTarget = utcAt(targetDay, 10);
const weeklyStart = shifted(weeklyTarget, { days: -21 });
const weeklyExcluded = shifted(weeklyTarget, { days: 7 });
const movedMasterStart = utcAt(shifted(targetDay, { days: -21 }), 16);
const movedOriginal = utcAt(targetDay, 16);
const movedActual = utcAt(targetDay, 17);
const cancelledMasterStart = utcAt(shifted(targetDay, { days: -21 }), 18);
const cancelledOriginal = utcAt(targetDay, 18);
const dailyStart = utcAt(targetDay, 9);

const monthlyTargetDay = new Date(targetDay);
if (monthlyTargetDay.getUTCDate() > 28) {
  monthlyTargetDay.setUTCDate(monthlyTargetDay.getUTCDate() + (32 - monthlyTargetDay.getUTCDate()));
}
const monthlyTarget = utcAt(monthlyTargetDay, 11);
const monthlyStart = shifted(monthlyTarget, { months: -3 });
const bySetPos = Math.ceil(monthlyTarget.getUTCDate() / 7);
const bySetPosWeekday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][monthlyTarget.getUTCDay()];
const bySetPosStartMonth = shifted(monthlyTarget, { months: -3 });
const firstOfStartMonth = new Date(Date.UTC(
  bySetPosStartMonth.getUTCFullYear(),
  bySetPosStartMonth.getUTCMonth(),
  1,
  13
));
const bySetPosStart = new Date(firstOfStartMonth);
bySetPosStart.setUTCDate(
  1 + ((monthlyTarget.getUTCDay() - firstOfStartMonth.getUTCDay() + 7) % 7) + (bySetPos - 1) * 7
);
const endedStart = shifted(weeklyTarget, { days: -21 });
const endedUntil = shifted(weeklyTarget, { days: -7 });

const yearlyTargetDay = new Date(targetDay);
if (yearlyTargetDay.getUTCMonth() === 1 && yearlyTargetDay.getUTCDate() === 29) {
  yearlyTargetDay.setUTCDate(28);
}
const yearlyTarget = utcAt(yearlyTargetDay, 12);
const yearlyStart = shifted(yearlyTarget, { years: -3 });

globalThis.fetch = async () =>
  new Response(
    `BEGIN:VCALENDAR\r\n` +
    `BEGIN:VEVENT\r\nUID:weekly\r\nDTSTART:${icsStamp(weeklyStart)}\r\nRRULE:FREQ=WEEKLY;COUNT=8\r\nEXDATE:${icsStamp(weeklyExcluded)}\r\nSUMMARY:Weekly review\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:moved\r\nDTSTART:${icsStamp(movedMasterStart)}\r\nRRULE:FREQ=WEEKLY;COUNT=8\r\nSUMMARY:Regular slot\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:moved\r\nRECURRENCE-ID:${icsStamp(movedOriginal)}\r\nDTSTART:${icsStamp(movedActual)}\r\nSUMMARY:Rescheduled slot\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:cancelled\r\nDTSTART:${icsStamp(cancelledMasterStart)}\r\nRRULE:FREQ=WEEKLY;COUNT=8\r\nSUMMARY:Cancelled occurrence\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:cancelled\r\nRECURRENCE-ID:${icsStamp(cancelledOriginal)}\r\nDTSTART:${icsStamp(cancelledOriginal)}\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:daily\r\nDTSTART:${icsStamp(dailyStart)}\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Daily focus\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:monthly\r\nDTSTART:${icsStamp(monthlyStart)}\r\nRRULE:FREQ=MONTHLY;COUNT=6;BYMONTHDAY=${monthlyTarget.getUTCDate()}\r\nSUMMARY:Monthly review\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:bysetpos\r\nDTSTART:${icsStamp(bySetPosStart)}\r\nRRULE:FREQ=MONTHLY;COUNT=6;BYDAY=${bySetPosWeekday};BYSETPOS=${bySetPos}\r\nSUMMARY:Positioned monthly review\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:ended\r\nDTSTART:${icsStamp(endedStart)}\r\nRRULE:FREQ=WEEKLY;UNTIL=${icsStamp(endedUntil)}\r\nSUMMARY:Expired recurrence\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:yearly\r\nDTSTART:${icsStamp(yearlyStart)}\r\nRRULE:FREQ=YEARLY;COUNT=6;BYMONTH=${yearlyTarget.getUTCMonth() + 1};BYMONTHDAY=${yearlyTarget.getUTCDate()}\r\nSUMMARY:Yearly reminder\r\nEND:VEVENT\r\n` +
    `END:VCALENDAR\r\n`
  );
await worker.scheduled({}, env, { waitUntil: (p) => p });
await new Promise((r) => setTimeout(r, 50));
const recurringCal = objects.get("2-areas/calendar/next-14-days.md")?.body || "";
const targetSection = recurringCal
  .split(`## ${weeklyTarget.toISOString().slice(0, 10)}\n`)[1]
  ?.split("\n## ")[0] || "";
check("cron expands past-anchored weekly recurrence", recurringCal.includes("10:00 — Weekly review"));
check("cron honors recurrence EXDATE", (recurringCal.match(/Weekly review/g) || []).length === 1);
check("cron applies moved recurrence exception", targetSection.includes("17:00 — Rescheduled slot") && !targetSection.includes("16:00 — Regular slot"));
check("cron applies cancelled recurrence exception", !targetSection.includes("18:00 — Cancelled occurrence"));
check("cron honors recurrence COUNT", (recurringCal.match(/Daily focus/g) || []).length === 3);
check("cron expands monthly recurrence", recurringCal.includes("11:00 — Monthly review"));
check("cron honors recurrence BYSETPOS", recurringCal.includes("13:00 — Positioned monthly review"));
check("cron honors recurrence UNTIL", !recurringCal.includes("Expired recurrence"));
check("cron expands yearly recurrence", recurringCal.includes("12:00 — Yearly reminder"));
check("calendar note reports recurring support", recurringCal.includes("Common recurring-event rules are expanded"));

// -- storage adapters: signing, listing, rootPrefix, capability probe
await runStoreChecks(check);

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
