/**
 * What this server issues and accepts: token lifetime, the scope a silent
 * client is given, and the caps on what a stranger may send.
 */

/** Access tokens are short-lived; the refresh token is the durable half. */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;

/**
 * What a client gets when it sends no `scope` at all.
 *
 * Deliberately not `SUPPORTED_SCOPES`. A client that names nothing is asking
 * for the ordinary thing, and `context:private` is never the ordinary thing —
 * it is the one scope a person is asked about separately, and defaulting it on
 * would hand every silent client the whole context including notes its owner
 * marked private. The consent screen still shows the tier as an explicit
 * choice; this only decides what the *request* said.
 */
export const DEFAULT_REQUESTED_SCOPE = "context:read context:write";

/** RFC 7591 caps nothing; this worker does. A registration is a few hundred bytes. */
export const REGISTRATION_BYTE_CAP = 32_000;
export const MAX_REDIRECT_URIS = 10;
export const MAX_CLIENT_NAME_LENGTH = 120;
