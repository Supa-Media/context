import { defineConfig } from "@supa-media/core/config";

export default defineConfig({
  app: {
    name: "Context",
    slug: "context",
    scheme: "context",
    bundleId: {
      production: "lc.context.mobile",
      staging: "lc.context.staging",
    },
  },

  multiTenant: true,
  tenantName: "workspaces",

  auth: {
    providers: ["email"],
  },

  features: {
    phoneOtp: false,
    emailOtp: true,
    pushNotifications: false,
    chat: false,
    payments: false,
  },

  deployment: {
    strictness: "standard",
  },

  infrastructure: {
    vault: "Context",
    easProjectId: "YOUR_EAS_PROJECT_ID",
    expoOwner: "supamedia",
  },
});
