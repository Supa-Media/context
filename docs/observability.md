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

## Collection audit, 2026-09-29

The current clients collect the following data when their public ingest key is
present. There is no in-app preference that disables either pipeline yet.

| Pipeline | Web | Native |
| --- | --- | --- |
| Sentry | Unhandled and reported errors, auto session tracking, sampled traces, sanitized route breadcrumbs, and the internal Convex user id. | The same data, but only in a binary that includes the gated native module. |
| PostHog | Sanitized screen views, two error-boundary recovery actions, the internal Convex user id, and sampled replay with text and media masking. Autocapture, page views, console capture, and network bodies are off. | Sanitized screen views, the two recovery actions, lifecycle events, and the internal Convex user id. Replay and automatic error tracking are off. |
| Convex | Backend exceptions through Convex's Sentry integration. | The same control-plane pipeline serves every client. |

The application does not set a retention period. Sentry and PostHog retain data
according to their project settings, which this repository cannot verify. The
public privacy policy does not yet name Sentry, PostHog, or replay. Both are
release blockers for an in-app feedback feature.

The quiet incident inbox now derives its note from bounded metadata only: the
configured project, a restricted issue id, a restricted short id, a closed
severity and environment value, and an HTTPS `sentry.io` issue link. It does
not copy the Sentry title, exception type, message, culprit, stack, tags, or
request fields into the team workspace. Redacting known secret shapes was not
enough because arbitrary exception text can contain a note body or note path.

## In-app feedback contract

Status: proposed backend contract. The report endpoint, attachment path, and
telemetry preferences remain disabled until Seyi approves the feedback design
and the privacy policy and vendor retention settings are updated.

### Authentication and abuse limits

- Only an authenticated account may submit.
- The server accepts at most 10 successful reports per account per fixed
  24-hour window. A refusal returns `FEEDBACK_RATE_LIMITED` and a retry time.
- `client_report_id` is a UUID generated on the device. It makes an offline
  retry idempotent for 30 days. The server returns a separate, stable
  `report_id`; neither id grants read access to a report.
- The server rejects unknown fields. It does not silently start collecting a
  field added by a newer client.

### Accepted content

- `message` is required, trimmed, and limited to 4,000 UTF-8 bytes. It is the
  one free-form field the person explicitly submits.
- `app` contains a closed platform enum, release, build, and runtime version.
- `device` contains OS family and version only. Device names, advertising ids,
  network addresses, locale, contacts, and hardware serials are forbidden.
- `screen` is the result of `telemetryRoute`, never a concrete URL or path.
- `activity` is optional and limited to 200 entries from the prior 10 minutes.
  An entry may contain only a sanitized route, a closed action name, a relative
  timestamp, or a Sentry event id. It has no value field for note names, note
  paths, search text, backend responses, or other free-form content.
- `error` is optional and must be a Sentry event id already known to the
  client. It is a link, not a copy of the Sentry event.
- `posthog_session_id` is optional. It links to an existing masked replay and
  does not copy replay data into the report.
- `screenshot` is optional, limited to one PNG, JPEG, or WebP image of at most
  2 MiB and 4,096 pixels on either side. The client must mask text before
  upload, show the exact image to the person, and require separate attachment
  consent. The backend cannot prove a screenshot was masked, so attachments
  stay disabled until that preview flow is approved and implemented.

### Data that is never implicit

Credentials, authorization headers, cookies, OAuth values, storage endpoints,
note bodies, note paths, context handles, capability links, email addresses,
clipboard data, console output, network bodies, and unrelated screen content
are never added automatically. A person may type sensitive text into
`message`; the submit screen must say that the text will be sent to Supa Media.
The message and screenshot must never be copied into logs, analytics events,
breadcrumbs, control-plane tables, or the Context incident note.

### Consent and triage

Submitting the report is consent for the required message and coarse app and OS
metadata. Activity, replay linkage, and a screenshot each have a separate
choice on that report. A standing telemetry preference does not consent to an
attachment, and submitting one report does not turn telemetry on for later
sessions.

Sentry is the only store for the approved message and attachment. The Context
triage note may contain the `report_id`, status, coarse app/build values, and a
Sentry link. It may not contain the message, image, activity entries, device
details, user id, PostHog session id, Sentry event payload, or vendor error
text.

### Retention and deletion

- Message, screenshot, activity, and feedback-specific Sentry data: 30 days
  maximum, with earlier deletion after triage allowed.
- Idempotency and delivery metadata in the control plane: 30 days maximum.
  It contains ids, status, coarse app/build values, and timestamps only.
- Rate-limit rows use the existing control-plane retention and contain no
  report content.
- A linked PostHog replay keeps the PostHog project's own retention. The report
  does not extend it or make a copy.
- Context triage notes contain no report content. They follow the ordinary
  incident archive policy.

The feedback feature must stay off until project settings and a deletion job
enforce the two 30-day limits. Retention documented without enforcement is not
a retention control.

Stable client errors are `FEEDBACK_UNAUTHENTICATED`,
`FEEDBACK_RATE_LIMITED`, `FEEDBACK_TOO_LARGE`, and
`FEEDBACK_ATTACHMENT_FAILED`. Validation failures may identify the invalid
field but must not echo its value.

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
Context incident prefix. The note contains a generic `What is happening`
sentence, bounded Sentry identifiers, closed severity and environment values,
and a link back to Sentry. Vendor-supplied error text, raw events, stack traces,
note content, and request payloads are not copied. A stable issue id produces a
stable note path, so retries and recurrences do not create a stream of duplicate
files.

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
