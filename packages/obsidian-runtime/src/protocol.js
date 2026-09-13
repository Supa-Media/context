// @ts-check

export const PLUGIN_RPC_VERSION = 1;

const MAX_PATH_LENGTH = 1024;
const MAX_TEXT_LENGTH = 5_000_000;
const MAX_SETTINGS_LENGTH = 262_144;
const MAX_NETWORK_BODY_LENGTH = 1_048_576;
const MAX_HEADERS = 64;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ETAG = /^\S.{0,255}$/s;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "referer",
]);

const CAPABILITIES = Object.freeze({
  "vault.list": "vault:read",
  "vault.read": "vault:read",
  "metadata.get": "metadata:read",
  "vault.create": "vault:write",
  "vault.modify": "vault:write",
  "vault.rename": "vault:rename",
  "vault.delete": "vault:delete",
  "settings.load": "settings:read",
  "settings.save": "settings:write",
  "network.request": "network:request",
});

/** @typedef {keyof typeof CAPABILITIES} OperationKind */
/** @typedef {"vault:read" | "metadata:read" | "vault:write" | "vault:rename" | "vault:delete" | "settings:read" | "settings:write" | "network:request"} PluginCapability */
/** @typedef {{code: string, message: string}} ProtocolError */
/** @typedef {{version: 1, requestId: string, operation: Record<string, unknown>}} PluginRpcRequest */

/**
 * Return the grant required to execute an already-validated operation.
 * @param {{kind: OperationKind}} operation
 * @returns {PluginCapability}
 */
export function capabilityForOperation(operation) {
  return CAPABILITIES[operation.kind];
}

/**
 * Apply the persisted grant after parsing and before dispatching an operation.
 * The trusted host chooses the grant; neither workspace nor plugin identity is
 * accepted from the sandbox message itself.
 *
 * @param {PluginRpcRequest} request
 * @param {{capabilities: readonly PluginCapability[], networkHosts: readonly string[]}} grant
 * @returns {{ok: true, capability: PluginCapability} | {ok: false, error: ProtocolError}}
 */
export function authorizePluginRpcRequest(request, grant) {
  const operation = /** @type {{kind: OperationKind, url?: string}} */ (request.operation);
  const capability = capabilityForOperation(operation);
  if (!grant.capabilities.includes(capability)) {
    return failure("CAPABILITY_DENIED", `Plugin was not granted ${capability}`);
  }
  if (operation.kind === "network.request") {
    const hostname = new URL(/** @type {string} */ (operation.url)).hostname.toLowerCase();
    if (!grant.networkHosts.includes(hostname)) {
      return failure("NETWORK_HOST_DENIED", "Plugin was not granted this exact network host");
    }
  }
  return { ok: true, capability };
}

/**
 * Validate untrusted messages crossing the plugin sandbox boundary. Workspace and
 * plugin identity are deliberately absent: the trusted host supplies both from
 * the sandbox instance instead of accepting caller-provided authority.
 *
 * @param {unknown} value
 * @returns {{ok: true, request: PluginRpcRequest} | {ok: false, error: ProtocolError}}
 */
export function parsePluginRpcRequest(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, ["version", "requestId", "operation"])) {
    return failure("INVALID_REQUEST", "Request must contain only version, requestId, and operation");
  }
  if (value.version !== PLUGIN_RPC_VERSION) {
    return failure("UNSUPPORTED_VERSION", "Unsupported plugin RPC version");
  }
  if (typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)) {
    return failure("INVALID_REQUEST", "Invalid requestId");
  }

  const operation = parseOperation(value.operation);
  if (operation.ok === false) return { ok: false, error: operation.error };

  return {
    ok: true,
    request: {
      version: PLUGIN_RPC_VERSION,
      requestId: value.requestId,
      operation: operation.value,
    },
  };
}

/**
 * @param {unknown} value
 * @returns {{ok: true, value: Record<string, unknown>} | {ok: false, error: ProtocolError}}
 */
function parseOperation(value) {
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    return failure("INVALID_OPERATION", "Operation must have a supported kind");
  }

  switch (value.kind) {
    case "vault.list":
      if (!hasExactKeys(value, ["kind", "prefix"])) return invalidOperation();
      if (!isVaultPath(value.prefix, true)) return invalidPath();
      return success({ kind: value.kind, prefix: value.prefix });
    case "vault.read":
    case "metadata.get":
      if (!hasExactKeys(value, ["kind", "path"])) return invalidOperation();
      if (!isVaultPath(value.path)) return invalidPath();
      return success({ kind: value.kind, path: value.path });
    case "vault.create":
      if (!hasExactKeys(value, ["kind", "path", "text"])) return invalidOperation();
      if (!isVaultPath(value.path)) return invalidPath();
      if (!isBoundedString(value.text, MAX_TEXT_LENGTH)) return failure("INVALID_CONTENT", "Text is too large or invalid");
      return success({ kind: value.kind, path: value.path, text: value.text });
    case "vault.modify":
      if (!isEtag(value.expectedEtag)) return etagRequired();
      if (!hasExactKeys(value, ["kind", "path", "text", "expectedEtag"])) return invalidOperation();
      if (!isVaultPath(value.path)) return invalidPath();
      if (!isBoundedString(value.text, MAX_TEXT_LENGTH)) return failure("INVALID_CONTENT", "Text is too large or invalid");
      return success({ kind: value.kind, path: value.path, text: value.text, expectedEtag: value.expectedEtag });
    case "vault.rename":
      if (!isEtag(value.expectedEtag)) return etagRequired();
      if (!hasExactKeys(value, ["kind", "from", "to", "expectedEtag"])) return invalidOperation();
      if (!isVaultPath(value.from) || !isVaultPath(value.to)) return invalidPath();
      return success({ kind: value.kind, from: value.from, to: value.to, expectedEtag: value.expectedEtag });
    case "vault.delete":
      if (!isEtag(value.expectedEtag)) return etagRequired();
      if (!hasExactKeys(value, ["kind", "path", "expectedEtag"])) return invalidOperation();
      if (!isVaultPath(value.path)) return invalidPath();
      return success({ kind: value.kind, path: value.path, expectedEtag: value.expectedEtag });
    case "settings.load":
      if (!hasExactKeys(value, ["kind"])) return invalidOperation();
      return success({ kind: value.kind });
    case "settings.save":
      if (!isEtag(value.expectedEtag)) return etagRequired();
      if (!hasExactKeys(value, ["kind", "json", "expectedEtag"])) return invalidOperation();
      if (!isBoundedString(value.json, MAX_SETTINGS_LENGTH) || !isJsonObject(value.json)) {
        return failure("INVALID_SETTINGS", "Settings must be a JSON object within the size limit");
      }
      return success({ kind: value.kind, json: value.json, expectedEtag: value.expectedEtag });
    case "network.request":
      return parseNetworkRequest(value);
    default:
      return invalidOperation();
  }
}

/** @param {Record<string, unknown>} value */
function parseNetworkRequest(value) {
  const allowed = value.body === undefined
    ? ["kind", "url", "method", "headers"]
    : ["kind", "url", "method", "headers", "body"];
  if (!hasExactKeys(value, allowed)) return invalidOperation();
  if (!isHttpsUrl(value.url)) return failure("INVALID_URL", "Network URLs must use HTTPS without credentials or fragments");
  if (typeof value.method !== "string" || !HTTP_METHODS.has(value.method)) {
    return failure("INVALID_METHOD", "Unsupported network method");
  }
  if (!Array.isArray(value.headers) || value.headers.length > MAX_HEADERS) {
    return failure("INVALID_HEADERS", "Invalid network headers");
  }
  for (const header of value.headers) {
    if (!isPlainObject(header) || !hasExactKeys(header, ["name", "value"]) ||
      typeof header.name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(header.name) ||
      FORBIDDEN_HEADERS.has(header.name.toLowerCase()) ||
      typeof header.value !== "string" || /[\r\n]/.test(header.value) || header.value.length > 8_192) {
      return failure("INVALID_HEADERS", "Invalid network headers");
    }
  }
  if (value.body !== undefined && !isBoundedString(value.body, MAX_NETWORK_BODY_LENGTH)) {
    return failure("INVALID_CONTENT", "Network body is too large or invalid");
  }
  const headers = /** @type {{name: string, value: string}[]} */ (value.headers);
  return success(value.body === undefined
    ? { kind: "network.request", url: value.url, method: value.method, headers: headers.map(copyHeader) }
    : { kind: "network.request", url: value.url, method: value.method, headers: headers.map(copyHeader), body: value.body });
}

/** @param {unknown} value @param {boolean} [allowEmpty] */
function isVaultPath(value, allowEmpty = false) {
  if (typeof value !== "string" || value.length > MAX_PATH_LENGTH || /[\0-\x1f\x7f\\]/.test(value)) return false;
  if (allowEmpty && value === "") return true;
  if (value === "" || value.startsWith("/") || value.endsWith("/")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.startsWith("."));
}

/** @param {unknown} value */
function isHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "" && url.hostname !== "";
  } catch {
    return false;
  }
}

/** @param {unknown} value */
function isJsonObject(value) {
  try {
    const parsed = JSON.parse(/** @type {string} */ (value));
    return isPlainObject(parsed);
  } catch {
    return false;
  }
}

/** @param {unknown} value @param {number} maximum */
function isBoundedString(value, maximum) {
  return typeof value === "string" && value.length <= maximum;
}

/** @param {unknown} value */
function isEtag(value) {
  return typeof value === "string" && ETAG.test(value);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {Record<string, unknown>} value @param {string[]} keys */
function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/** @param {{name: unknown, value: unknown}} header */
function copyHeader(header) {
  return { name: header.name, value: header.value };
}

/** @param {Record<string, unknown>} value @returns {{ok: true, value: Record<string, unknown>}} */
function success(value) {
  return { ok: true, value };
}

/** @param {string} code @param {string} message @returns {{ok: false, error: ProtocolError}} */
function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function invalidOperation() {
  return failure("INVALID_OPERATION", "Operation contains unsupported or unexpected fields");
}

function invalidPath() {
  return failure("INVALID_PATH", "Path must remain inside the visible vault and outside hidden directories");
}

function etagRequired() {
  return failure("ETAG_REQUIRED", "A non-empty expectedEtag is required for this mutation");
}
