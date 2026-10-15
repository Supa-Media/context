# App Store readiness

The October 15 audit is tracked in Context MCP at
`@supa/1-projects/mobile-app/ios-launch/submission-audit.md`. Screenshot and
metadata tasks for Claude are alongside it. No submission is confirmed yet.

## Native purchases

The native companion shows the current plan without prices, paid choices,
checkout, billing-portal links, or instructions to buy elsewhere. Free managed
storage and bring-your-own storage remain available. The browser and desktop
web shell keep their billing controls. Both settings and first-run handlers
refuse paid actions on native, even if called without their UI.

This follows the free companion approach in Apple guideline 3.1.3(f). It does
not guarantee approval; review the product's eligibility with the final binary.
Do not add a worldwide "buy on the website" instruction without checking the
app category, storefront rules, and any required entitlements.

## Notifications

Account settings offers optional registration with the device's push service.
This release exposes registration only on iOS; Android needs FCM configuration
before that control can be offered. The person must press Enable notifications; the app never prompts at launch
and denial never blocks use. Registration failures are visible and retryable. Permission can be
changed through the system-settings control.

This prepares OS permission and native APNs registration only. There is no
server token registry or delivery service in this change. Tokens are not stored,
logged, associated with an account, or sent to the backend. A later delivery
feature needs authenticated token ownership, revocation on sign-out and account
deletion, token rotation, sender credentials, and an actual device delivery test.
Do not describe push delivery as working until those exist.

## Review account

Current sign-in includes phone authentication, with email as an alternative.
The dedicated reviewer email provider already exists. It gets its fixed code
from deployment configuration and its exact identity is exempt from the phone
check. The production CUJ account is also exempt. Prefer the dedicated reviewer
identity: the CUJ account has test-only provisioning and cleanup powers.

Verify reviewer sign-in, waitlist/admission, a synthetic workspace with storage,
read/write/search, and sign-out/sign-in on the candidate binary. Put credentials
in App Store Connect review fields, never this repository. Do not create a global
OTP bypass or reuse a real person's phone number.

## Remaining release gates

- Inspect the live App Store Connect record and latest processed build.
- Verify signing and push capability in the candidate binary, then device-test
  notification allow/deny/retry, microphone recording/background behavior,
  account deletion, native billing restrictions, and fresh reviewer login.
- Capture real iPhone and iPad screenshots. The app currently supports iPad.
- Update App Privacy from the current Sentry/PostHog implementation and actual
  content, audio, identity, and diagnostics handling. Older notes claiming no
  analytics SDKs are stale. Verify privacy/support URLs and age rating.
- Green CI, merged code, staging verification, production release, native build,
  upload, metadata completion, and App Review submission are distinct steps.

References checked October 15, 2026:

- https://developer.apple.com/app-store/review/guidelines/
- https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications
- https://docs.expo.dev/versions/v54.0.0/sdk/notifications/
