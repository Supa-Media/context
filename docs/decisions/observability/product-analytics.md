# Product analytics records outcomes and named interactions

Decided 2026-10-21 when the owner asked to understand Context/Tex drop-off and
clicks. Keep the existing PostHog destination. Context and Tex share the
pipeline and are distinguished by `app_product`, with production separated
from staging and development by `app_env`.

A submit is an attempt. A server reply or successful domain operation is its
outcome. Waitlist joins, existing waitlist entries, code requests, verified
sign-ins and the Messages handoff are separate events. A Messages click never
claims that a text was actually sent. Early analytics events must survive SDK
startup in order; opt-out and sign-out discard queued events.

Private content stays out of DOM analytics. The public homepage may record
heatmap coordinates and clicks on explicitly tagged static controls with all
text and attributes masked, followed by a final allowlist for autocapture
properties. Element chains are discarded because PostHog can include hrefs
and classes even with attribute masks enabled. Private screens retain named
console button events, safe domain outcomes and globally masked web replay.
Heatmap dictionary keys are sanitized separately: the SDK uses raw
`location.href`, bypassing `get_current_url`.

`observabilityJourneys.test.ts` holds the URL/DOM boundary,
`observabilityStartup.test.ts` holds startup order and opt-out/sign-out,
and `authJourneyEvents.test.ts` proves server refusals do not become successful
conversions or leak entered contact details. Native replay remains disabled.
The event catalog and dashboard recipes live in `docs/observability.md`.
