// The app's telemetry client, stood in for the preview: it loads Sentry's React Native SDK, which a static page cannot
// bundle. Nothing is reported from the preview.
export const sentryLoader = { load: async () => null };
export const initObservability = async () => {};
export const reportError = () => undefined;
export const trackEvent = () => {};
export const trackButton = () => {};
export const trackActive = () => {};
export const trackScreen = () => {};
export const setObservabilityUser = () => {};
export const resetObservabilityUser = () => {};
export const observedUserId = () => null;
export const onObservedUserChange = () => () => {};
export const hasObservedUser = () => false;
