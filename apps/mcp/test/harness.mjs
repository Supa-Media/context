/**
 * Shared fixture and harness for the gateway's flat, sequential check suite.
 *
 * This used to be the top of one 4,800-line test.mjs: one in-memory R2 stub,
 * one control plane, one seeded bucket, and the `rpc`/`call`/`check` helpers
 * every subject file below builds its checks on. It is now its own module so
 * every subject file can import the same live state — the same `objects`
 * Map, the same `contextStore`, the same `controlPlane` — and see exactly the
 * fixture the original flat file built, in the same order.
 *
 * Nothing here is wrapped in `suite()`: a throw during setup killed the whole
 * process before, and still does, which is intentional — see `suite`'s own
 * comment below for why that discipline is deliberate for the checks that
 * come after it, not for this.
 */
import worker from "../src/index.js";
import { R2Store } from "../src/store/r2.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
} from "./controlPlaneStub.mjs";

// --- in-memory R2 stub, wrapped in the same adapter the worker builds ---
//
// Objects are held as bytes, not as strings. This stub used to decode every
// non-string `put` with a `TextDecoder` and re-encode it on the way out, which
// is lossless only for text: any byte sequence that is not valid UTF-8 came
// back as U+FFFD. That made it impossible to test a stored image at all, and
// worse, it would have made a broken binary write *pass*. Bytes in, bytes out;
// `text()` decodes on demand, exactly as R2 does.
const objects = new Map();
let etagCounter = 0;
let enforceOneUseBodies = false;
let concurrentCreateOnAbsent = null;
const encoder = new TextEncoder();
const bucket = {
  async get(key) {
    if (!objects.has(key)) return null;
    const { bytes, etag } = objects.get(key);
    let consumed = false;
    const consume = () => {
      if (!enforceOneUseBodies) return;
      if (consumed) throw new TypeError("Body has already been used");
      consumed = true;
    };
    return {
      etag,
      text: async () => {
        consume();
        return new TextDecoder().decode(bytes);
      },
      // Real R2 bodies are one-use streams. Return a fresh byte copy on that
      // one read so callers cannot mutate the stored object through the back
      // door, and throw on a second read exactly as production does.
      arrayBuffer: async () => {
        consume();
        return bytes.slice().buffer;
      },
    };
  },
  async put(key, value, options = {}) {
    const expected = options?.onlyIf?.etagMatches;
    if (expected && objects.get(key)?.etag !== expected) return null;
    const createOnly =
      options?.onlyIf?.absent === true || options?.onlyIf?.etagDoesNotMatch === "*";
    if (createOnly && concurrentCreateOnAbsent?.key === key) {
      const winner = concurrentCreateOnAbsent;
      concurrentCreateOnAbsent = null;
      if (!objects.has(key)) {
        objects.set(key, { bytes: encoder.encode(winner.text), etag: `e${++etagCounter}` });
      }
    }
    if (
      createOnly &&
      objects.has(key)
    ) {
      return null;
    }
    const bytes =
      typeof value === "string"
        ? encoder.encode(value)
        : value instanceof Uint8Array
          ? new Uint8Array(value)
          : new Uint8Array(value);
    const etag = `e${++etagCounter}`;
    objects.set(key, { bytes, etag });
    return { etag };
  },
  async delete(key) {
    objects.delete(key);
  },
  async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
    const entries = [];
    const seenPrefixes = new Set();
    for (const key of [...objects.keys()].filter((candidate) => candidate.startsWith(prefix)).sort()) {
      const remainder = key.slice(prefix.length);
      const split = delimiter ? remainder.indexOf(delimiter) : -1;
      if (split >= 0) {
        const child = `${prefix}${remainder.slice(0, split + delimiter.length)}`;
        if (!seenPrefixes.has(child)) {
          seenPrefixes.add(child);
          entries.push({ prefix: child });
        }
        continue;
      }
      entries.push({
        object: {
          key,
          size: objects.get(key).bytes.length,
          uploaded: new Date(),
          // `etag` per listed object mirrors what R2 and S3 both report, and
          // the search index's staleness diff is built on it. Without it every
          // note compares unequal on every sync and the backfill never converges.
          etag: objects.get(key).etag,
        },
      });
    }
    const start = cursor === undefined ? 0 : Number(cursor);
    const page = entries.slice(start, start + limit);
    const truncated = start + page.length < entries.length;
    return {
      objects: page.flatMap((entry) => entry.object ? [entry.object] : []),
      delimitedPrefixes: page.flatMap((entry) => entry.prefix ? [entry.prefix] : []),
      truncated,
      ...(truncated ? { cursor: String(start + page.length) } : {}),
    };
  },
};

/**
 * Decode a stored object for an assertion. The stub holds bytes, so the checks
 * that used to reach in for `.body` decode here instead of each doing it.
 * Returns undefined for a key that was never written, so `?.includes(...)` at a
 * call site still short-circuits rather than throwing.
 */
function storedText(key) {
  const entry = objects.get(key);
  return entry ? new TextDecoder().decode(entry.bytes) : undefined;
}

// Seeds and assertions go through the ContextStore, so the suite exercises the
// same adapter the worker uses rather than the raw binding.
const contextStore = new R2Store(bucket);

/**
 * This suite used to hand the worker three static env tokens. There are no
 * static tokens any more: every request resolves through OAuth and the control
 * plane, so the harness stands up a control plane that speaks the real HTTP
 * contract and binds one workspace to the in-memory bucket above.
 *
 * The short names below (`priv-token`, `team-token`, …) survive as *labels*
 * only, mapped to real OAuth-shaped access tokens by `accessTokenFor`. Keeping
 * them means the ~200 behavioural checks in this file stayed exactly as they
 * were while the access model underneath them changed completely — which is the
 * point: privacy semantics are supposed to be unaffected by how a caller
 * authenticated.
 */
const controlPlane = createControlPlaneStub();
controlPlane.install();

const WORKSPACE_ID = "ws_primary";
controlPlane.addWorkspace(WORKSPACE_ID, "primary", {
  provider: "r2-binding",
  bindingName: "CONTEXT_BUCKET",
  capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
  status: "active",
});

/**
 * Real tokens are long and opaque; the labels are not. Anything short would be
 * rejected before it reached the control plane, which is itself correct.
 */
const ACCESS_TOKENS = {
  "priv-token": "cat_test_owner_full_0000000000000000",
  "team-token": "cat_test_member_read_000000000000000",
  "pub-token": "cat_test_member_alias_00000000000000",
  "inbox-token": "cat_test_capture_only_00000000000000",
  "readonly-token": "cat_test_owner_readonly_000000000000",
  // The tier is a property of the grant now, so "an owner" is no longer one
  // fixture. These two differ in exactly one scope and in nothing else.
  "owner-team-token": "cat_test_owner_team_tier_00000000000",
  "member-asked-private-token": "cat_test_member_asked_private_000000",
};
function accessTokenFor(label) {
  return ACCESS_TOKENS[label] || label;
}

// An owner who granted private-tier: sees every note, including their own
// private ones. Note that this now takes THREE scopes. The tier is something
// the person chose on the consent screen and the grant records — being the
// owner is necessary and no longer sufficient, which is the entire point of
// this change and the reason ~200 privacy checks below still read the same.
await controlPlane.addGrant({
  accessToken: ACCESS_TOKENS["priv-token"],
  workspaceId: WORKSPACE_ID,
  role: "owner",
  scopes: ["context:read", "context:write", "context:private"],
  clientId: "mcp_client_owner",
  userId: "user_owner",
});
// The same owner, connecting a different client at team level — the thing that
// was impossible before and the thing they asked for. Identical in every
// respect except the missing `context:private`.
//
// It is also what every grant issued before the tier existed looks like, so the
// checks against this token are simultaneously the migration test: an unmarked
// legacy grant reads as `team`, not as the owner's ceiling.
await controlPlane.addGrant({
  accessToken: ACCESS_TOKENS["owner-team-token"],
  workspaceId: WORKSPACE_ID,
  role: "owner",
  scopes: ["context:read", "context:write"],
  clientId: "mcp_client_owner_team",
  userId: "user_owner",
});
// A member whose grant somehow carries the tier scope anyway — the control
// plane refuses to write this, twice, so reaching it takes a compromised
// control plane. The gateway must still refuse to honour it.
await controlPlane.addGrant({
  accessToken: ACCESS_TOKENS["member-asked-private-token"],
  workspaceId: WORKSPACE_ID,
  role: "member",
  scopes: ["context:read", "context:write", "context:private"],
  clientId: "mcp_client_member_private",
  userId: "user_member",
});
// Editors: privacy tier `team`, may write team content. Two of them, because
// `pub-token` used to be a second static credential and the checks that used it
// are really checks about the team tier.
for (const label of ["team-token", "pub-token"]) {
  await controlPlane.addGrant({
    accessToken: ACCESS_TOKENS[label],
    workspaceId: WORKSPACE_ID,
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: `mcp_client_${label}`,
    userId: "user_colleague",
  });
}
// Capture-only: may POST to /inbox and may not read a single note.
await controlPlane.addGrant({
  accessToken: ACCESS_TOKENS["inbox-token"],
  workspaceId: WORKSPACE_ID,
  role: "editor",
  scopes: ["context:capture"],
  clientId: "mcp_client_capture",
  userId: "user_automation",
});
// An owner whose client was connected read-only.
await controlPlane.addGrant({
  accessToken: ACCESS_TOKENS["readonly-token"],
  workspaceId: WORKSPACE_ID,
  role: "owner",
  scopes: ["context:read"],
  clientId: "mcp_client_readonly",
  userId: "user_owner",
});

const env = {
  CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  // The one binding name this deployment will honour from a control-plane
  // answer. Anything else is refused even if it exists on `env`.
  NATIVE_BINDINGS: "CONTEXT_BUCKET",
  CONTEXT_BUCKET: bucket,
  // Cron and webhook ingestion only; no caller can reach this.
  LOCAL_CONTEXT_BUCKET: bucket,
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
    headers: {
      Authorization: `Bearer ${accessTokenFor(token)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const res = await worker.fetch(req, env, { waitUntil() {} });
  return res.status === 202 ? null : await res.json();
}
async function call(token, name, args = {}) {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  return r.result;
}

/**
 * TEXT came back, and it does not contain NEEDLE.
 *
 * The symmetric counterpart to `succeeded()`, and needed for the same reason.
 * `!text.includes(x)` is the natural way to assert something is hidden, and
 * once `text` is optional-chained — which the crash convention requires — an
 * absent result reads `!undefined`, which is `true`. So every "a team
 * connection cannot see this" check would pass on a call that returned
 * nothing, which is the failure those checks exist to catch. Six of them have
 * no positive companion on the same variable, so nothing else would go red.
 *
 * `typeof text === "string"` is the half that rejects the absent result;
 * `!text.includes` is the half that does the actual hiding assertion.
 */
function lacks(text, needle) {
  return typeof text === "string" && !text.includes(needle);
}

/**
 * A tool call SUCCEEDED: a result came back, and it is not an error.
 *
 * `!(await call(...)).isError` is the natural way to write this and it is not
 * the same claim. `isError` is absent on success, so optional-chaining it —
 * which the crash convention above otherwise requires — makes the expression
 * read true when there is no result AT ALL: a JSON-RPC error, or a handler
 * that threw. That is precisely the failure such a check exists to catch, so
 * the guard against a crash would have bought a silent pass instead.
 *
 * Both halves are load-bearing. `Boolean(result)` rejects the absent result;
 * `!result.isError` rejects the tool-level refusal.
 */
function succeeded(result) {
  return Boolean(result) && !result.isError;
}

let failures = 0;
function check(label, cond) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
}

/**
 * ONE SUITE, AND A THROW INSIDE IT REPORTED RATHER THAN FATAL.
 *
 * The comment above already names this failure mode and answers it with a
 * discipline — *"every `.result` access below is optional-chained on
 * purpose"* — applied by hand, at every site, for ever. That discipline is
 * not holdable and was already broken elsewhere: a `check` in the desktop's
 * `transcribeRequest` suite read `answer.speechEvidence.keptNoSpeechMax`, and
 * the one edit it existed to catch made that `null`.
 *
 * **What a throw costs, measured rather than assumed.** It is not the exit
 * code — the process does exit 1, and CI does go red. It is that the throw
 * unwinds past every suite queued behind it: in `apps/desktop` one such throw
 * took **1,129 of 1,780 checks** out of the run, and not one of them was
 * reported as failed, skipped, or missing. A run that silently stops being
 * 63% of itself, while showing red for one unrelated-looking reason, is the
 * worst shape a suite can fail in — worse than a plain failure, because the
 * number nobody reads is the one that moved.
 *
 * So a suite that throws is **one named failure**, and the suites behind it
 * still run. `report` is injectable only so this wrapper can be checked by
 * the suite it belongs to without printing a failure nobody should act on.
 */
function fail(label) {
  failures++;
  console.log(`FAIL  ${label}`);
}

async function suite(name, run, report = fail) {
  try {
    await run();
  } catch (error) {
    report(`${name} threw, so its remaining checks did not run — ${error?.message ?? error}`);
  }
}
const MODERN = "2026-07-28";

async function modernFetch({
  method,
  params = {},
  id = 4242,
  bodyVersion = MODERN,
  headerVersion = MODERN,
  headerMethod,
  headerName,
  token = "priv-token",
  omitBodyVersion = false,
  omitHeaderVersion = false,
  omitHeaderMethod = false,
  omitHeaderName = false,
  rawBody,
  httpMethod = "POST",
} = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${accessTokenFor(token)}`;
  if (!omitHeaderVersion) headers["MCP-Protocol-Version"] = headerVersion;
  if (!omitHeaderMethod) headers["Mcp-Method"] = headerMethod ?? method;
  const nameSource = method === "tools/call" ? params.name : undefined;
  if (nameSource !== undefined && !omitHeaderName) {
    headers["Mcp-Name"] = headerName ?? nameSource;
  }
  const meta = omitBodyVersion
    ? {}
    : { "io.modelcontextprotocol/protocolVersion": bodyVersion };
  const body =
    rawBody !== undefined
      ? rawBody
      : JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } });
  const res = await worker.fetch(
    new Request("https://x/mcp", {
      method: httpMethod,
      headers,
      body: httpMethod === "POST" ? body : undefined,
    }),
    env,
    { waitUntil() {} }
  );
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 202 and 405 carry no body */
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

// Setters for the bucket stub's mutable knobs above. They used to be plain
// module-scope `let` reassignments from checks living in this same file;
// those checks now live in their own subject files, which cannot assign into
// another module's bindings directly, so the assignment is wrapped here
// instead. Same effect, same order, called from the same call sites.
function setEnforceOneUseBodies(value) {
  enforceOneUseBodies = value;
}
function setConcurrentCreateOnAbsent(value) {
  concurrentCreateOnAbsent = value;
}

function getFailures() {
  return failures;
}

export {
  bucket,
  objects,
  storedText,
  contextStore,
  controlPlane,
  WORKSPACE_ID,
  ACCESS_TOKENS,
  accessTokenFor,
  env,
  rpc,
  call,
  lacks,
  succeeded,
  check,
  fail,
  suite,
  worker,
  setEnforceOneUseBodies,
  setConcurrentCreateOnAbsent,
  getFailures,
  MODERN,
  modernFetch,
};
