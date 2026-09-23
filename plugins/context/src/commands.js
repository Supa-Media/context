/**
 * The commands, as functions — so the CLI is a thin shell around something the
 * tests can drive without spawning a process or opening a browser.
 *
 * Everything a test needs to substitute is a parameter with a real default:
 * `fetchImpl`, `openBrowser`, `log`, and the two config paths. Nothing reaches
 * for a global at call time.
 */

import {
  loadEndpoint,
  saveEndpoint,
  forgetEndpoint,
  defaultConfigPath,
  endpointKey,
  credentialEndpointKey,
  baseEndpoint,
} from "./config.js";
import { installHook, uninstallHook, clientById } from "./install.js";
import { fetchOrientation, startContext } from "./orient.js";
import {
  HOOK_SCOPE,
  LOGIN_SCOPE,
  ORIENT_SCOPE,
  authorizeUrl,
  createPkce,
  discover,
  exchangeCode,
  listenForCode,
  refreshTokens,
  registerClient,
  stateMatches,
} from "./oauth.js";
import { captureBody, transcriptToMarkdown } from "./transcript.js";
import { PROJECT_FILE, normalizeWorkspace, resolveSettings, workspaceUrl, writeSetting } from "./settings.js";
import { listWorkspaces } from "./mcp.js";
import { homedir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat, unlink as unlinkFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";

/**
 * Sign in once, then write the hook into the client's settings.
 *
 * The order matters: authorize first, and only touch somebody's settings file
 * once there is a credential for the hook to use. Installing a hook that cannot
 * authenticate means every session from now on ends with a failure the person
 * did not ask for and cannot see.
 */
export async function install({
  endpoint,
  client: clientId = "claude-code",
  orient = false,
  configPath = defaultConfigPath(),
  fetchImpl = fetch,
  openBrowser,
  log = console.log,
}) {
  clientById(clientId); // fail before the browser opens, not after
  const record = await authorize({ endpoint, orient, configPath, fetchImpl, openBrowser, log });
  const { path, commands: installed } = await installHook({ clientId, endpoint });

  log(`Hooks installed for ${clientById(clientId).name}.`);
  log(`  settings: ${path}`);
  for (const [event, command] of Object.entries(installed)) log(`  ${event}: ${command}`);
  log(`  scope:    ${record.scope || (orient ? ORIENT_SCOPE : HOOK_SCOPE)}`);
  log("");
  log(
    orient
      ? "At session start your orientation is put in front of the model before it answers."
      : "At session start the model is told to call orient before answering."
  );
  log("When a session ends, its user-visible messages are saved to 0-inbox/.");
  if (!clientById(clientId).transcriptVerified) {
    log("");
    log(`Note: this package's transcript parser was written against Claude Code's`);
    log(`format, not ${clientById(clientId).name}'s. The session-start half does not`);
    log("read the transcript at all and is unaffected. If a save finds nothing to");
    log("keep it says so on the spot rather than failing quietly — tell us if it does.");
  }
  if (!orient) {
    log("");
    log("To have the orientation itself injected instead of an instruction to fetch it,");
    log("re-run with --orient. That asks for read access, on a credential that lives on");
    log("this machine unattended — your call to make, not a default.");
  }
  log("Revoke it any time from Connections in the Context console.");
  return { path, commands: installed };
}

/** The OAuth half on its own, for re-authorizing without touching settings. */
export async function authorize({
  endpoint,
  orient = false,
  scope: requestedScope,
  clientLabel = "Context hook",
  configPath = defaultConfigPath(),
  fetchImpl = fetch,
  openBrowser,
  log = console.log,
}) {
  // Refused before the first `.well-known` request, not after. `loadEndpoint`
  // below would catch it, but by then two cleartext discovery requests have
  // gone out — no credential in them, and still enough to tell a passive
  // observer that this machine is installing against that endpoint.
  credentialEndpointKey(endpoint);
  const discovery = await discover(endpoint, { fetchImpl });
  const scope = requestedScope || (orient ? ORIENT_SCOPE : HOOK_SCOPE);
  const existing = await loadEndpoint(endpoint, configPath);
  // A change of scope is a new authorization, and re-using a client registered
  // for the narrower one would ask for something it never declared. Widening
  // silently is the thing this whole flow exists to not do.
  let clientId = existing?.scope === scope ? existing.clientId : null;
  if (!clientId) {
    const registration = await registerClient(discovery, {
      clientName: `${clientLabel} (${hostname()})${orient ? " — orienting" : ""}`,
      // Declared, not assumed. The comment above is only true if the new client
      // says what it is about to ask for.
      scope,
      fetchImpl,
    });
    clientId = registration.clientId;
  }

  const listener = await listenForCode();
  const pkce = createPkce();
  const state = randomBytes(24).toString("base64url");
  const href = authorizeUrl(discovery, {
    clientId,
    redirectUri: listener.redirectUri,
    challenge: pkce.challenge,
    state,
    scope,
  });

  log("Opening your browser to approve this hook…");
  log(`If it does not open, go to:\n  ${href}\n`);
  try {
    await (openBrowser ? openBrowser(href) : defaultOpenBrowser(href));
  } catch {
    // A machine with no browser is a real case — a server, a container, ssh.
    // The URL is already printed, so this is not fatal.
  }

  let returned;
  try {
    returned = await listener.waitForCode();
  } finally {
    listener.close();
  }
  // The state check is what stops somebody else's authorization code being fed
  // to this listener while it is open. It is compared in constant time and a
  // mismatch is fatal, never a warning.
  if (!stateMatches(state, returned.state)) {
    throw new Error("the browser came back with the wrong state; nothing was saved");
  }
  if (!returned.code) throw new Error("the browser came back without an authorization code");

  const tokens = await exchangeCode(
    discovery,
    { clientId, code: returned.code, verifier: pkce.verifier, redirectUri: listener.redirectUri },
    { fetchImpl }
  );

  return saveEndpoint(
    endpoint,
    {
      clientId,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope || scope,
      issuer: discovery.issuer,
    },
    configPath
  );
}

/**
 * A usable access token, refreshing if the stored one is spent.
 *
 * The refreshed pair is written back before it is used, because a rotating
 * refresh token that is spent and not persisted leaves the install permanently
 * unable to authenticate — and the failure surfaces at the end of some future
 * session, where nobody is looking.
 */
export async function accessTokenFor({ endpoint, configPath, fetchImpl = fetch }) {
  const record = await loadEndpoint(endpoint, configPath);
  if (!record?.refreshToken && !record?.accessToken) {
    throw new Error(`not signed in for ${endpointKey(endpoint)} — run: npx -y @supa-media/context install`);
  }
  if (record.accessToken && Number(record.expiresAt) > Date.now()) return record.accessToken;
  if (!record.refreshToken) {
    throw new Error("the stored session has expired — run: npx -y @supa-media/context install");
  }

  // One refresh at a time per credentials file. Refresh tokens rotate and the
  // gateway treats a spent one as a replay, so two hooks refreshing together
  // (two sessions closing at once) would lose the sign-in. Whoever waits
  // re-reads the file and uses the token the other one stored.
  const release = await acquireLock(`${configPath}.lock`);
  try {
    const current = await loadEndpoint(endpoint, configPath);
    if (current?.accessToken && Number(current.expiresAt) > Date.now()) return current.accessToken;
    if (!current?.refreshToken) {
      throw new Error("the stored session has expired — run: npx -y @supa-media/context login");
    }
    const discovery = await discover(endpoint, { fetchImpl });
    const tokens = await refreshTokens(
      discovery,
      { clientId: current.clientId, refreshToken: current.refreshToken },
      { fetchImpl }
    );
    await saveEndpoint(
      endpoint,
      {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken || current.refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope || current.scope,
      },
      configPath
    );
    return tokens.accessToken;
  } finally {
    await release();
  }
}

/**
 * An exclusive lock file, created with `wx` so only one process wins.
 *
 * A lock older than `staleMs` belonged to a process that died holding it and is
 * taken over rather than waited on forever.
 */
async function acquireLock(path, { waitMs = 10_000, staleMs = 30_000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      return () => unlinkFile(path).catch(() => {});
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const age = await stat(path).then((info) => Date.now() - info.mtimeMs).catch(() => 0);
      if (age > staleMs) {
        await unlinkFile(path).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error("another Context process is refreshing the sign-in; try again");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/**
 * Sign in with read and write, then learn which workspaces that reaches.
 *
 * The personal workspace is recorded so captures land in this person's own
 * inbox even from a project bound to a shared one. An older gateway cannot
 * list workspaces; the sign-in still works and captures then go to the
 * workspace it was approved for.
 */
export async function login({ endpoint, configPath = defaultConfigPath(), fetchImpl = fetch, openBrowser, log = console.log }) {
  const { settings } = await resolveSettings({ flags: { endpoint } });
  const base = baseEndpoint(settings.endpoint);
  await authorize({
    endpoint: base,
    scope: LOGIN_SCOPE,
    clientLabel: "Context CLI",
    configPath,
    fetchImpl,
    openBrowser,
    log,
  });
  const token = await accessTokenFor({ endpoint: base, configPath, fetchImpl });
  const workspaces = await listWorkspaces({ url: base, token, fetchImpl });
  log(`Signed in to ${endpointKey(base)}.`);
  if (!workspaces) {
    log("Could not list your workspaces (this server is older than that). Captures go to the");
    log("workspace this sign-in was approved for.");
    return { workspaces: null };
  }
  const personal = workspaces.find((entry) => entry.kind === "personal");
  if (personal) await writeSetting("personal", personal.slug);
  log("Workspaces this sign-in reaches:");
  for (const entry of workspaces) {
    log(`  @${entry.slug}  ${entry.kind}, ${entry.role}${entry.slug === personal?.slug ? "  (captures go here)" : ""}`);
  }
  return { workspaces };
}

export async function logout({ endpoint, configPath = defaultConfigPath(), log = console.log }) {
  const { settings } = await resolveSettings({ flags: { endpoint } });
  const forgotten = await forgetEndpoint(settings.endpoint, configPath);
  log(forgotten ? "Signed out: the stored sign-in is deleted from this machine." : "There was no stored sign-in.");
  log("The grant itself is revoked from Connections in the Context console.");
  return { forgotten };
}

/**
 * Bind a folder to a workspace by writing `.context.json` there.
 *
 * The workspace must be one this sign-in reaches, so a typo is caught here and
 * not at the end of somebody's session. `private` keeps the file out of git
 * through `.git/info/exclude`, which is this clone's alone.
 */
export async function link({ workspace, cwd = process.cwd(), private: keepPrivate = false, endpoint, configPath = defaultConfigPath(), fetchImpl = fetch, log = console.log }) {
  const slug = normalizeWorkspace(workspace);
  if (!slug) throw new Error("name a workspace: context-lc link @slug");
  const { settings } = await resolveSettings({ flags: { endpoint }, cwd });
  const base = baseEndpoint(settings.endpoint);
  const token = await accessTokenFor({ endpoint: base, configPath, fetchImpl });
  const workspaces = await listWorkspaces({ url: base, token, fetchImpl });
  if (workspaces && !workspaces.some((entry) => entry.slug === slug)) {
    throw new Error(`this sign-in does not reach @${slug}. It reaches: ${workspaces.map((entry) => `@${entry.slug}`).join(", ")}`);
  }
  const path = join(cwd, PROJECT_FILE);
  const current = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
  await writeFile(path, `${JSON.stringify({ ...current, workspace: slug }, null, 2)}\n`);
  if (keepPrivate) await excludeFromGit(cwd, PROJECT_FILE);
  log(`Linked ${cwd} to @${slug}${keepPrivate ? " (kept out of git)" : ""}.`);
  if (!workspaces) log("Could not check that name against your workspaces (older server).");
  return { path, workspace: slug };
}

export async function unlink({ cwd = process.cwd(), log = console.log }) {
  const path = join(cwd, PROJECT_FILE);
  const current = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
  delete current.workspace;
  if (Object.keys(current).length) await writeFile(path, `${JSON.stringify(current, null, 2)}\n`);
  else await unlinkFile(path).catch(() => {});
  log(`Unlinked ${cwd}.`);
  return { path };
}

async function excludeFromGit(cwd, name) {
  const excludePath = join(cwd, ".git", "info", "exclude");
  // Only inside a git repository, and only this clone's own exclude file.
  const isRepo = await stat(join(cwd, ".git")).then((info) => info.isDirectory()).catch(() => false);
  if (!isRepo) return false;
  const existing = await readFile(excludePath, "utf8").catch(() => "");
  await mkdir(join(cwd, ".git", "info"), { recursive: true });
  if (existing.split("\n").includes(name)) return true;
  await writeFile(excludePath, `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}${name}\n`);
  return true;
}

/** `config list | get <key> | set <key> <value>`. `null` or an empty value unsets. */
export async function config({ action = "list", key, value, cwd = process.cwd(), log = console.log }) {
  if (action === "set") {
    const parsed =
      value === null || value === undefined || value === "" || value === "null"
        ? null
        : key === "captureExclude"
          ? String(value).split(",").map((entry) => entry.trim()).filter(Boolean)
          : value;
    await writeSetting(key, parsed);
    log(parsed === null ? `${key} unset` : `${key} = ${JSON.stringify(parsed)}`);
    return;
  }
  const { settings, sources, projectFile } = await resolveSettings({ cwd });
  if (action === "get") {
    if (!(key in settings)) throw new Error(`unknown setting "${key}"`);
    log(Array.isArray(settings[key]) ? settings[key].join(",") : String(settings[key] ?? ""));
    return;
  }
  for (const [name, current] of Object.entries(settings)) {
    const shown = Array.isArray(current) ? current.join(",") || "(none)" : current ?? "(none)";
    log(`${name.padEnd(15)} ${shown}  (${sources[name]})`);
  }
  if (projectFile) log(`project file: ${projectFile}`);
}

/**
 * What the hook itself runs. Reads the client's session-end payload on stdin.
 *
 * Every failure here is quiet and non-zero-free: this runs while somebody is
 * closing their laptop, and a hook that prints a stack trace over the end of a
 * session — or worse, fails the session — is a hook they uninstall. It reports
 * what happened on stdout and exits 0 regardless.
 */
export async function capture({
  endpoint,
  client = "claude-code",
  configPath = defaultConfigPath(),
  stdin = process.stdin,
  fetchImpl = fetch,
  readTranscript = (path) => readFile(path, "utf8"),
  log = console.log,
}) {
  const payload = await readJsonStdin(stdin);
  // Settings come from the SESSION's folder, not this process's: a hook runs
  // wherever the agent started it, and the project file that decides where
  // this capture goes is the one above the session's working directory.
  const { settings } = await resolveSettings({ flags: { endpoint }, cwd: payload?.cwd || homedir() });
  if (settings.capture === "off") {
    log("context: capture is off here; nothing saved");
    return { saved: false, reason: "off" };
  }
  if (payload?.cwd && isExcluded(payload.cwd, settings.captureExclude)) {
    log("context: this folder is excluded from capture; nothing saved");
    return { saved: false, reason: "excluded" };
  }
  const transcriptPath = payload?.transcript_path || payload?.transcriptPath;
  if (!transcriptPath) {
    log("context: no transcript in the session payload; nothing saved");
    return { saved: false, reason: "no-transcript" };
  }

  let raw;
  try {
    raw = await readTranscript(transcriptPath);
  } catch {
    log("context: could not read the session transcript; nothing saved");
    return { saved: false, reason: "unreadable" };
  }

  const { markdown, messages, truncated } = transcriptToMarkdown(raw);
  if (!messages) {
    // A session with nothing the person said or was told is not worth a note,
    // and an empty capture is refused by the gateway anyway.
    log("context: nothing user-visible in this session; nothing saved");
    return { saved: false, reason: "empty" };
  }

  const body = captureBody({
    client,
    sessionId: payload.session_id || payload.sessionId || "",
    cwd: payload.cwd || "",
    at: new Date().toISOString(),
    markdown,
    messages,
    truncated,
  });

  const token = await accessTokenFor({ endpoint: settings.endpoint, configPath, fetchImpl });
  // Personal unless this person or project chose the project's workspace. With
  // no personal workspace on record (an older gateway told us nothing), no
  // slug: the gateway files it in the workspace the sign-in was approved for.
  const destination =
    settings.captureTo === "workspace" && settings.workspace ? settings.workspace : settings.personal;
  const response = await fetchImpl(workspaceUrl(settings.endpoint, destination, "/inbox"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    log(`context: the gateway refused the capture (${response.status})`);
    return { saved: false, reason: `http-${response.status}` };
  }
  log(`context: saved ${messages} messages to your context`);
  return { saved: true, messages, truncated };
}

/**
 * What the `SessionStart` hook runs. Prints the block Claude Code injects.
 *
 * Every failure path ends in the directive rather than in nothing, and never in
 * an error: this runs before a person has typed anything, and a hook that
 * prints a stack trace over the top of their opening prompt has made the
 * session worse than not being installed. Not signed in, no read scope, gateway
 * down, token revoked — all of them come out as "call orient first", which is
 * still better than silence.
 */
export async function sessionStart({
  endpoint,
  configPath = defaultConfigPath(),
  stdin = process.stdin,
  fetchImpl = fetch,
  emit = (text) => process.stdout.write(text),
}) {
  const payload = await readJsonStdin(stdin); // drained: Claude Code closes the pipe on our exit
  let orientation = null;
  let workspace = null;
  try {
    const { settings, sources } = await resolveSettings({ flags: { endpoint }, cwd: payload?.cwd || homedir() });
    // Only a project's own binding is named: a person's default workspace is
    // already what the connection uses when no `context` is passed.
    if (sources.workspace === "project") workspace = settings.workspace;
    endpoint = settings.endpoint;
    const record = await loadEndpoint(endpoint, configPath);
    // No point spending a round trip to be told no. A capture-only grant cannot
    // read, and asking anyway would put an error in the logs on every session.
    if (record && String(record.scope || "").includes("context:read")) {
      const token = await accessTokenFor({ endpoint, configPath, fetchImpl });
      orientation = await fetchOrientation({ endpoint: workspaceUrl(endpoint, workspace), token, fetchImpl });
    }
  } catch {
    orientation = null;
  }

  const context = startContext({ orientation, workspace });
  // The documented JSON form rather than bare stdout: `additionalContext` is
  // the field Claude Code injects, and plain text is a looser contract that has
  // meant different things across versions.
  emit(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
    })}\n`
  );
  return { injected: context, live: Boolean(orientation) };
}

export async function status({ endpoint, configPath = defaultConfigPath(), log = console.log }) {
  const record = await loadEndpoint(endpoint, configPath);
  if (!record) {
    log(`Not signed in for ${endpointKey(endpoint)}.`);
    return { signedIn: false };
  }
  // Never the tokens themselves. There is a test asserting that.
  const scope = record.scope || HOOK_SCOPE;
  log(`Signed in for ${endpointKey(endpoint)}`);
  log(`  scope:   ${scope}`);
  log(`  start:   ${scope.includes("context:read") ? "injects your orientation" : "tells the agent to call orient"}`);
  log(`  client:  ${record.clientId}`);
  log(`  expires: ${record.expiresAt ? new Date(record.expiresAt).toISOString() : "unknown"}`);
  return { signedIn: true };
}

export async function uninstall({
  endpoint,
  client: clientId = "claude-code",
  configPath = defaultConfigPath(),
  log = console.log,
}) {
  const { path, removed } = await uninstallHook({ clientId });
  const forgotten = await forgetEndpoint(endpoint, configPath);
  log(removed ? `Removed the hook from ${path}.` : `No hook of ours was in ${path}.`);
  log(forgotten ? "Forgot the stored credential." : "There was no stored credential.");
  log("The grant itself is revoked from Connections in the Context console.");
  return { removed, forgotten };
}

/** Whether `cwd` is one of the excluded folders or inside one. `~` means home. */
function isExcluded(cwd, excluded = []) {
  const here = resolvePath(cwd);
  return excluded.some((entry) => {
    const folder = resolvePath(entry.replace(/^~(?=$|\/)/, homedir()));
    return here === folder || here.startsWith(folder + sep);
  });
}

async function readJsonStdin(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function defaultOpenBrowser(href) {
  const { spawn } = await import("node:child_process");
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  // No shell: the URL is built by us, but a spawn through a shell is a habit
  // worth not having in a file that also handles credentials.
  spawn(command, [href], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}
