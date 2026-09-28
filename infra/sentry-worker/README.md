# Sentry incident inbox

This Worker turns each newly created Sentry issue into one short, team-visible
note at a fixed path in Context. Repeated deliveries for the same Sentry issue
replace that generated note instead of flooding the folder.

The adapter verifies Sentry's HMAC signature before parsing the body, accepts
only the configured Sentry project, strips URL query strings, redacts
credential-shaped text, and never stores a raw event or stack trace. The
request cannot select a Context workspace or destination folder.

## Authentication

The dedicated journey-test user is an editor of the destination workspace. Its
OAuth grant is stored as a refresh token plus public client id. Context access
tokens are short-lived and refresh tokens rotate, so a singleton Durable Object
serializes refreshes and persists the latest token pair. This prevents two
concurrent Sentry deliveries from replaying the same refresh token and revoking
the grant.

The grant has `context:read context:write` because the MCP transport currently
requires read scope before dispatching `tools/call`; the Worker itself exposes
only a fixed `write_note` operation. The service account is not a member of the
owner's personal context.

## Configuration

All values are Worker secrets and GitHub environment secrets sourced from the
matching 1Password items:

```text
SENTRY_WEBHOOK_CLIENT_SECRET
CONTEXT_MCP_REFRESH_TOKEN
CONTEXT_MCP_CLIENT_ID
CONTEXT_MCP_ENDPOINT
SENTRY_PROJECT_SLUG
SENTRY_INCIDENT_PREFIX
SENTRY_INBOX_URL
```

`SENTRY_INBOX_URL` is used only by the deployment smoke check. The other six
values are synchronized to the Worker after deployment.

## Failure behavior

Invalid signatures are rejected without a write. Foreign projects are quietly
ignored. If token refresh or the Context write fails, the Worker returns `503`
so Sentry retries instead of losing the issue.

Run `pnpm --filter @context/sentry-worker test` from the repository root.
