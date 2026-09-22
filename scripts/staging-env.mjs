import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function validateStaging(env) {
  if (env.APP_ENV !== "staging") throw new Error("APP_ENV must be staging.");
  const deployment = env.STAGING_CONVEX_DEPLOYMENT;
  if (!deployment || !/^[a-z0-9-]+$/.test(deployment)) throw new Error('STAGING_CONVEX_DEPLOYMENT must name the staging deployment.');
  if (env.CONVEX_DEPLOY_KEY?.split('|')[0] !== `prod:${deployment}`) throw new Error('Deploy key does not target the staging deployment.');
  if (env.EXPO_PUBLIC_CONVEX_URL !== `https://${deployment}.convex.cloud` || env.CONTROL_PLANE_URL !== `https://${deployment}.convex.site`) throw new Error('Staging frontend and gateway must target the staging deployment.');
  if (env.APP_ORIGIN !== 'https://staging.context.lc') throw new Error('APP_ORIGIN must be the staging origin.');
  for (const key of ['GATEWAY_SECRET', 'STORAGE_SECRET_ENCRYPTION_KEY', 'JWT_PRIVATE_KEY', 'JWKS', 'EMAIL_WORKER_SECRET', 'TRANSCRIBE_WORKER_SECRET', 'TRANSCRIBE_WORKER_URL']) {
    if (!env[key]?.trim()) throw new Error(`Missing staging secret: ${key}`);
  }
}

export const backendKeys = ['APP_ENV', 'STAGING_CONVEX_DEPLOYMENT', 'APP_ORIGIN', 'GATEWAY_SECRET', 'STORAGE_SECRET_ENCRYPTION_KEY', 'STORAGE_SECRET_ENCRYPTION_KEY_ID', 'JWT_PRIVATE_KEY', 'JWKS', 'ADMIN_EMAILS', 'AUTH_EMAIL_FROM', 'RESEND_API_KEY', 'EMAIL_WORKER_SECRET', 'TRANSCRIBE_WORKER_SECRET', 'TRANSCRIBE_WORKER_URL', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'MAIL_CONNECT_ENABLED', 'CALENDAR_CONNECT_ENABLED', 'DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'PLUGIN_EGRESS_URL', 'PLUGIN_EGRESS_SECRET', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'MANAGED_R2_ACCOUNT_ID'];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateStaging(process.env);
  console.log('Staging deployment, frontend, gateway and app origin agree.');
  if (process.argv.includes('--sync')) {
    const values = { ...process.env, SITE_URL: process.env.APP_ORIGIN };
    for (const key of [...backendKeys, 'SITE_URL']) {
      if (!values[key]) continue;
      const result = spawnSync(process.execPath, ['node_modules/convex/bin/main.js', 'env', 'set', key], { input: values[key], encoding: 'utf8', env: process.env });
      if (result.status !== 0) throw new Error(`Failed to set staging environment variable ${key}; inspect the deployment configuration.`);
      console.log(`Set staging variable: ${key}`);
    }
  }
}
