import type { LegalPageContent } from "./LegalPage";

export const privacyContent: LegalPageContent = {
  eyebrow: "Privacy",
  title: "Privacy Policy",
  updated: "October 5, 2026",
  intro:
    "Context.lc is a workspace for notes and connected information. This policy explains what we collect, why we collect it, how Google-connected data is used, and what an AI assistant you connect can see and do.",
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
      title: "Diagnostics and feedback",
      body: [
        "Context.lc is in early beta. To find and fix problems, the app sends crash reports to Sentry and counts which screens are opened with PostHog, linked to your internal account id rather than your name or email. On the web, PostHog also records some visits with every word, picture and form field hidden.",
        "These never include your notes, their titles, your folder names, your links, your email address or your @handle. Addresses in the app are reduced to the kind of screen before they are sent.",
        "You can turn crash reports, screen counts and recordings off in Settings, under Feedback. The switches follow your account to every device you sign in on.",
        "Our public homepage at context.lc loads the advertising pixels of X (Twitter) and Meta (Facebook and Instagram), so we can tell whether our ads there bring people who join. They run only on that page, never inside the app or on your notes. When you join the waitlist or create an account, we also tell X and Meta about the signup with a one-way hash of your email address and, if you arrived from one of their ads, that ad's click id and their browser id, never the address itself.",
        "When you send a feedback report, it goes through Context.lc to Sentry with what you typed and only the attachments you left ticked: the app version and your browser or system version, a log of the screens and errors from the last ten minutes, and a screenshot, whose words are hidden unless you choose to show them. We use reports only to fix Context.lc and to reply to you.",
      ],
    },
    {
      title: "AI assistants you connect",
      body: [
        "You can connect AI assistants, such as Claude, ChatGPT, or Codex, to Context.lc. Each one signs in with your permission and gets its own access, which you can revoke at any time from your Context.lc settings.",
        "A connected assistant can read and search only the notes you can already see, in the workspaces you belong to, filtered by each workspace's privacy settings. It can write, move, or comment only where your role allows, and every change it makes is recorded in that workspace's activity under the assistant's name.",
        "Notes reach an assistant only when it asks for them on your behalf. What the assistant's provider does with that content is governed by its own terms and privacy policy, not this one.",
        "We do not use your notes to train AI models, and we do not sell them.",
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
