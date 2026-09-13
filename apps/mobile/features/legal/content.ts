import type { LegalPageContent } from "./LegalPage";

export const privacyContent: LegalPageContent = {
  eyebrow: "Privacy",
  title: "Privacy Policy",
  updated: "September 13, 2026",
  intro:
    "Context.lc is a personal context workspace. This policy explains what we collect, why we collect it, and how Google-connected data is used when you choose to connect Gmail, Google Calendar, or Google Chat.",
  sections: [
    {
      title: "Information we collect",
      body: [
        "We collect account information you provide when you sign in, such as your email address, authentication identifiers, workspace memberships, and settings.",
        "When you connect storage or an integration, we store the configuration needed to operate that connection, including encrypted OAuth tokens or provider credentials where applicable.",
        "When you connect Google, Context.lc may receive your Google account identity, Gmail message metadata and content, Google Calendar event details, and Google Chat spaces and messages, depending on the scopes you approve and the sync features you enable.",
      ],
    },
    {
      title: "How we use Google data",
      body: [
        "We use Google data only to provide the integration you requested: connecting your Google accounts to your personal Context.lc workspace and syncing selected communications or calendar information into your context.",
        "Email and chat sync are forward-only unless the product explicitly offers a user-initiated import. Calendar sync is used to keep current and upcoming calendar context available to you.",
        "We do not sell Google user data, use it for advertising, or use it to train third-party AI models.",
      ],
    },
    {
      title: "Where your data is stored",
      body: [
        "Context.lc stores context as files and folders in the storage connected to your account or in Context-managed storage when you choose that option.",
        "Synced communication and calendar notes are private to your personal workspace by default. Email, chat, and iMessage-style communication sync is not intended for shared workspaces.",
        "OAuth tokens are encrypted server-side and are used only to maintain the connection you authorized.",
      ],
    },
    {
      title: "Sharing",
      body: [
        "Your private context is not shared with other users unless you explicitly share it, invite someone, publish a note, or move information into a workspace with broader access.",
        "We may process data with service providers that help operate Context.lc, such as hosting, storage, observability, and authentication providers. They are permitted to process data only for the service we provide.",
      ],
    },
    {
      title: "Google API Limited Use",
      body: [
        "Context.lc's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.",
        "We request only the Google scopes needed for the features you enable, and you can disconnect a Google account from Context.lc or revoke access from your Google Account permissions at any time.",
      ],
    },
    {
      title: "Retention and deletion",
      body: [
        "We retain synced files and account records while your account, context, or connected integration remains active, unless you delete them sooner.",
        "You can disconnect an integration, delete synced notes from your context, revoke provider access, or contact us to request account deletion.",
      ],
    },
    {
      title: "Security",
      body: [
        "We use HTTPS in transit, encrypted credential storage, access controls, and operational monitoring to protect account and integration data.",
        "No system can guarantee perfect security. If we learn of a security incident affecting your data, we will notify affected users when required by law and appropriate for the risk.",
      ],
    },
    {
      title: "Contact",
      body: [
        "For privacy questions, security concerns, or data requests, contact context@supa.media.",
      ],
    },
  ],
};

export const termsContent: LegalPageContent = {
  eyebrow: "Terms",
  title: "Terms of Service",
  updated: "September 13, 2026",
  intro:
    "These terms govern your use of Context.lc, a personal context workspace operated by Supa Media.",
  sections: [
    {
      title: "Using Context.lc",
      body: [
        "You may use Context.lc to create, organize, sync, and share notes, files, and connected personal context.",
        "You are responsible for your account, the content you add or sync, and the people or tools you choose to share it with.",
      ],
    },
    {
      title: "Connected services",
      body: [
        "You can connect services such as Google, Dropbox, S3-compatible storage, or other providers when the product supports them.",
        "By connecting a provider, you authorize Context.lc to access and process the provider data needed to deliver the selected feature. You can disconnect providers through Context.lc settings or revoke access directly with the provider.",
      ],
    },
    {
      title: "Google integrations",
      body: [
        "Google integrations are optional. If you connect Gmail, Google Calendar, or Google Chat, Context.lc uses the approved scopes only to sync the information you enabled into your personal context.",
        "Google-connected communications are meant for personal workspaces, not shared ones. You are responsible for ensuring that any synced content you later share is appropriate to share.",
      ],
    },
    {
      title: "Your content",
      body: [
        "You keep ownership of the notes, files, and source data you add to Context.lc.",
        "You grant Context.lc the limited rights needed to host, process, sync, display, and transmit your content so the service can work.",
      ],
    },
    {
      title: "Acceptable use",
      body: [
        "Do not use Context.lc to violate law, infringe rights, compromise systems, send spam, distribute malware, or access data you are not authorized to access.",
        "We may suspend or limit access when necessary to protect users, the service, connected providers, or the public.",
      ],
    },
    {
      title: "Availability",
      body: [
        "Context.lc is provided as-is. We work to keep the service reliable, but we do not guarantee uninterrupted availability, error-free syncing, or compatibility with every provider configuration.",
        "Third-party services may change their APIs, limits, pricing, or policies, and those changes can affect integrations.",
      ],
    },
    {
      title: "Privacy",
      body: [
        "Our Privacy Policy explains how we collect, use, store, and protect data. It is part of these terms.",
      ],
    },
    {
      title: "Changes",
      body: [
        "We may update these terms as the product changes. When changes are material, we will make reasonable efforts to notify users or make the update clear in the product.",
      ],
    },
    {
      title: "Contact",
      body: ["Questions about these terms can be sent to context@supa.media."],
    },
  ],
};
