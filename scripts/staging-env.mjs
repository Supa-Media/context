import { pathToFileURL } from 'node:url';
import { syncConvexEnv } from './convex-env-sync.mjs';

export function validateStaging(env) {
  if (env.APP_ENV !== "staging") throw new Error("APP_ENV must be staging.");
  const deployment = env.STAGING_CONVEX_DEPLOYMENT;
  if (!deployment || !/^[a-z0-9-]+$/.test(deployment)) throw new Error('STAGING_CONVEX_DEPLOYMENT must name the staging deployment.');
  if (env.CONVEX_DEPLOY_KEY?.split('|')[0] !== `prod:${deployment}`) throw new Error('Deploy key does not target the staging deployment.');
  if (env.EXPO_PUBLIC_CONVEX_URL !== `https://${deployment}.convex.cloud` || env.CONTROL_PLANE_URL !== `https://${deployment}.convex.site`) throw new Error('Staging frontend and gateway must target the staging deployment.');
  if (env.APP_ORIGIN !== 'https://staging.context.lc') throw new Error('APP_ORIGIN must be the staging origin.');
  const zone = env.CUSTOM_DOMAINS_ZONE_ID?.trim() || '';
  const target = env.CUSTOM_DOMAINS_TARGET?.trim().toLowerCase() || '';
  if (zone || target) {
    if (!/^[0-9a-f]{32}$/.test(zone) || !/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(target)) {
      throw new Error('Staging custom domains need both a valid zone ID and a bare target hostname.');
    }
    // A new CNAME under the production zone still shares its SaaS registry
    // and wildcard Worker. Staging needs a separately configured SaaS zone.
    if (target === 'context.lc' || target.endsWith('.context.lc')) {
      throw new Error('Staging custom domains must use a SaaS zone outside context.lc.');
    }
  }
  for (const key of ['GATEWAY_SECRET', 'STORAGE_SECRET_ENCRYPTION_KEY', 'JWT_PRIVATE_KEY', 'JWKS', 'EMAIL_WORKER_SECRET', 'TRANSCRIBE_WORKER_SECRET', 'TRANSCRIBE_WORKER_URL']) {
    if (!env[key]?.trim()) throw new Error(`Missing staging secret: ${key}`);
  }
}

export const backendKeys = ['APP_ENV', 'STAGING_CONVEX_DEPLOYMENT', 'APP_ORIGIN', 'GATEWAY_SECRET', 'STORAGE_SECRET_ENCRYPTION_KEY', 'STORAGE_SECRET_ENCRYPTION_KEY_ID', 'JWT_PRIVATE_KEY', 'JWKS', 'ADMIN_EMAILS', 'AUTH_EMAIL_FROM', 'RESEND_API_KEY', 'EMAIL_WORKER_SECRET', 'AGENT_WORKER_SECRET', 'TRANSCRIBE_WORKER_SECRET', 'TRANSCRIBE_WORKER_URL', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'MAIL_CONNECT_ENABLED', 'CALENDAR_CONNECT_ENABLED', 'DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'PLUGIN_EGRESS_URL', 'PLUGIN_EGRESS_SECRET', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'MANAGED_R2_ACCOUNT_ID', 'CUSTOM_DOMAINS_ZONE_ID', 'CUSTOM_DOMAINS_TARGET', 'FEEDBACK_SENTRY_DSN'];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateStaging(process.env);
  console.log('Staging deployment, frontend, gateway and app origin agree.');
  if (process.argv.includes('--sync')) {
    // One request for every variable (scripts/convex-env-sync.mjs), not one
    // CLI process each; same rule as before: an empty value is never pushed.
    await syncConvexEnv({
      names: [...backendKeys, 'SITE_URL'],
      values: { ...process.env, SITE_URL: process.env.APP_ORIGIN },
      url: process.env.EXPO_PUBLIC_CONVEX_URL,
      key: process.env.CONVEX_DEPLOY_KEY,
    });
  }
}
