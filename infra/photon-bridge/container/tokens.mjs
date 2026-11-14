/**
 * Line tokens from Photon's cloud (spectrum.photon.codes), as
 * @photon-ai/spectrum-ts issues them: POST with HTTP Basic (project id and
 * secret), answered by {succeed, data}. A dedicated project's data carries
 * one token per line instance (`auth`), the line's E.164 number (`numbers`)
 * and the token lifetime in seconds (`expiresIn`).
 */

export const SPECTRUM_CLOUD_URL = "https://spectrum.photon.codes";

/** Renew at this fraction of the lifetime (the SDK's own ratio). */
const RENEWAL_RATIO = 0.8;
const MIN_RENEWAL_MS = 5000;
export const RETRY_MS = 30000;

export class TokenError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "TokenError";
    this.code = code;
    this.status = status;
  }
}

export function basicAuth(projectId, projectSecret) {
  return `Basic ${Buffer.from(`${projectId}:${projectSecret}`, "utf8").toString("base64")}`;
}

/** Validates the cloud's answer and returns {auth, numbers, expiresIn}. */
export function parseTokenData(json) {
  if (json?.succeed !== true || json.data === null || typeof json.data !== "object") {
    throw new TokenError("malformed_response");
  }
  const data = json.data;
  if (data.type !== "dedicated") throw new TokenError("unsupported_line_type");
  if (data.auth === null || typeof data.auth !== "object") throw new TokenError("malformed_response");
  const expiresIn = data.expiresIn;
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new TokenError("malformed_response");
  return {
    auth: { ...data.auth },
    numbers: { ...(data.numbers ?? {}) },
    expiresIn,
  };
}

/** The lines that have a number: {instanceId, line, address} for each. */
export function linesOf(data) {
  return Object.keys(data.auth)
    .filter((instanceId) => typeof data.numbers[instanceId] === "string")
    .map((instanceId) => ({
      instanceId,
      line: data.numbers[instanceId],
      address: `${instanceId}.imsg.photon.codes:443`,
    }));
}

export async function issueTokens({
  projectId,
  projectSecret,
  fetchImpl = fetch,
  baseUrl = SPECTRUM_CLOUD_URL,
  signal,
}) {
  const response = await fetchImpl(`${baseUrl}/projects/${encodeURIComponent(projectId)}/imessage/tokens`, {
    method: "POST",
    headers: { authorization: basicAuth(projectId, projectSecret) },
    signal,
  });
  if (!response.ok) throw new TokenError("cloud_refused", response.status);
  return parseTokenData(await response.json());
}

/** Milliseconds until the next renewal of a token that lives `expiresIn` seconds. */
export function renewalDelayMs(expiresIn) {
  return Math.max(expiresIn * 1000 * RENEWAL_RATIO, MIN_RENEWAL_MS);
}
