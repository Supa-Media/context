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

PostHog's top-level `properties.token` is its public, write-only project routing
key, not a user credential. The web transport scrubs every ordinary property,
then restores only that one top-level field from `EXPO_PUBLIC_POSTHOG_KEY`.
Never preserve the event's incoming value, and never exempt nested `token`
fields from redaction: without the routing key PostHog silently drops the
event, while a broader exemption could leak a real credential.

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

Convex backend exceptions use Convex's native Sentry integration rather than
the mobile SDK. Configure it independently for every Convex deployment in
Deployment Settings → Integrations, using the same Sentry DSN and a static
`service=context-control-plane` tag. The production integration is expected to
be Active; mobile/EAS environment variables do not configure it.

In PostHog, keep **Record user sessions** enabled, remove stale authorized-domain
allowlists, select total-privacy masking, and leave console-log, canvas, network,
header, and payload capture disabled. SDK masking remains the primary boundary;
the project settings are defense in depth.

## Release verification

For staging first:

1. Produce a new EAS build so the Sentry native module is linked.
2. Confirm the build uploaded Hermes source maps to Sentry.
3. Launch the app, sign in, move through two screens, and trigger a controlled
   render error in a non-production build.
4. In Sentry, confirm the issue has readable application frames, an internal
   user id, environment/release data, and a `posthog.session_id` tag.
5. Trigger one controlled, non-mutating Convex authorization error and confirm
   it arrives in the same Sentry project with `service=context-control-plane`,
   the Convex function name/type, deployment, environment, and request id.
6. In PostHog web, confirm the matching session has screen events and a replay
   in which text and images are masked. On native, confirm analytics only and no
   replay.
7. Inspect both payloads and verify there is no email, context handle, note path,
   note body, OAuth code, share token, or storage credential.

## Quiet incident inbox and alerts

Sentry remains the diagnostic source, but a signed internal-integration webhook
also files each newly created issue as one compact note under the configured
Context incident prefix. The note starts with a single `What is happening`
sentence and links back to Sentry; raw events, stack traces, note content, and
request payloads are not copied. A stable issue id produces a stable note path,
so retries and recurrences do not create a stream of duplicate files.

`infra/sentry-worker` owns this adapter. Its request cannot choose a workspace
or path, and a foreign Sentry project is ignored. A singleton Durable Object
serializes Context OAuth refresh-token rotation. A failed Context write returns
`503`, allowing Sentry to retry.

Routine per-issue email notifications for the production Context project are
disabled. The Context incident folder is the quiet review queue; urgent
notifications should be reserved for an explicit outage or sustained-impact
monitor, not every new exception.

## Dashboards

Create these after the first staging events establish the project schema:

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
