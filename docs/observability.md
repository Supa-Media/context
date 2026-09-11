# Observability

Context uses Sentry for crash/error diagnosis and PostHog for product analytics
and privacy-masked web session replay. Telemetry is optional: a missing key
disables that pipeline, and an initialization failure never prevents the app
from rendering.

## Privacy contract

Context is a notes product. Telemetry may describe app behavior, never note
content.

- PostHog web replay masks every text input, rendered text node, image,
  sensitive DOM attribute, video, canvas, and file input.
- Native replay is disabled. The native SDK cannot globally mask rendered text,
  so enabling it would expose context names and other private interface text.
- Replay does not capture console logs or network telemetry.
- Screen names replace context handles and invite/share capabilities with route
  parameters.
- Sentry does not send default PII. Its final event and breadcrumb processors
  redact authorization, cookie, secret, token, note-content, OAuth-code, and AWS
  access-key shaped values.
- User correlation uses the internal Convex user id only. Email, context slug,
  note path, storage provider credentials, and note body are forbidden event
  properties.

The executable privacy boundary is
`apps/mobile/features/observability/privacy.ts`; changes to it require tests.

## Configuration

Set these in the EAS environment used by each build/update. The sample rates
accept numbers from `0` to `1` and default to `0.1` in production.

```text
EXPO_PUBLIC_SENTRY_DSN
EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
SENTRY_AUTH_TOKEN
SENTRY_ORG
SENTRY_PROJECT

EXPO_PUBLIC_POSTHOG_KEY
EXPO_PUBLIC_POSTHOG_HOST
EXPO_PUBLIC_POSTHOG_REPLAY_SAMPLE_RATE
```

The `EXPO_PUBLIC_*` values are public ingest configuration, not administrative
credentials. `SENTRY_AUTH_TOKEN` is private and is used only by the build to
upload source maps.

Sentry adds native code. It is deliberately listed as `gated` in
`apps/mobile/native-deps.json`, and the runtime check disables native capture on
older binaries that receive a newer OTA bundle. A fresh EAS build is required
before native crashes become available. PostHog analytics is cross-platform;
masked replay is web-only and does not need a native bridge.

## Release verification

For staging first:

1. Produce a new EAS build so the Sentry native module is linked.
2. Confirm the build uploaded Hermes source maps to Sentry.
3. Launch the app, sign in, move through two screens, and trigger a controlled
   render error in a non-production build.
4. In Sentry, confirm the issue has readable application frames, an internal
   user id, environment/release data, and a `posthog.session_id` tag.
5. In PostHog web, confirm the matching session has screen events and a replay
   in which text and images are masked. On native, confirm analytics only and no
   replay.
6. Inspect both payloads and verify there is no email, context handle, note path,
   note body, OAuth code, share token, or storage credential.

## Initial alerts and dashboards

Create these after the first staging events establish the project schema:

- Sentry: alert immediately on a new fatal issue; alert when the same error
  affects at least 3 users in 30 minutes; alert when crash-free sessions fall
  below 99.5% over 24 hours.
- Sentry dashboard: crash-free sessions, affected users, top issues, p95 app
  start, and p95 screen/navigation duration by release.
- PostHog dashboard: unique signed-in users, screen sequence, onboarding start
  to first connected storage, first note opened, save success/failure, and
  replay availability.

Page views, lifecycle events, boundary failures, retries, and reloads are wired
today. Funnel events beyond those should be added only at the successful domain
operation boundary, using low-cardinality properties from the allowlist below.

Allowed property classes: boolean capability/state, coarse role, provider name,
result enum, duration/count, release/build, and sanitized route. Never add a
free-form string from a user or backend error response.

## Incident loop

Start with Sentry to identify the release and failure. Use its
`posthog.session_id` tag to find the masked replay, reproduce against staging,
and record the root cause and repair in the active `1-projects/context-lc`
notes. If a privacy-sensitive value reaches either vendor, pause that pipeline,
delete the affected event/replay in the vendor, update the redaction rule and
regression test, then resume collection.
