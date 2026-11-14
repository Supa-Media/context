/** The texting Worker's bindings, as its chat object and Workflows read them (`index.ts` re-exports it). */

import type { GroupTurnParams } from "./groupTurnWorkflow";
import type { JobRunParams } from "./jobWorkflow";
import type { TextsBinding } from "./gatewaySession";
import type { TimingDataset } from "./textTiming";
import type { CountDataset } from "./textCounts";

export interface Env {
  SENDER_INBOX: DurableObjectNamespace;
  /** Sees each group turn through, with retries (`groupTurnWorkflow.ts`); absent, group turns are answered in their object. */
  GROUP_TURN?: Workflow<GroupTurnParams>;
  JOB_RUN?: Workflow<JobRunParams>;
  /** Linq's `whsec_…` webhook signing secret. */
  LINQ_WEBHOOK_SECRET: string;
  /** Linq Partner API key, used to send replies. */
  LINQ_API_KEY: string;
  /** Sendblue's API key id and secret, used to send replies on Tex's dedicated line. */
  SENDBLUE_API_KEY_ID?: string;
  SENDBLUE_API_SECRET?: string;
  /** The secret set on Sendblue's receive webhook; it arrives verbatim in `sb-signing-secret`. */
  SENDBLUE_WEBHOOK_SECRET?: string;
  SENDBLUE_STATUS_URL?: string; // where each send's status goes, `https://<worker>/sendblue/status/<secret>` (`sendblueStatus.ts`)
  /** Tex's WhatsApp line (`whapi.ts`): the Whapi channel's token and the line's own number (E.164). */
  WHAPI_TOKEN?: string;
  WHAPI_LINE?: string;
  /** The value Whapi's webhook settings send in `x-tex-webhook-secret`. Absent, every WhatsApp delivery is refused. */
  WHAPI_WEBHOOK_SECRET?: string;
  /** Opens the control plane's /agent-texts/* routes and nothing else. */
  AGENT_WORKER_SECRET: string;
  /** The Convex HTTP origin (…convex.site). */
  CONTROL_PLANE_ORIGIN: string;
  /** The gateway origin, e.g. https://mcp.context.lc */
  GATEWAY_ORIGIN: string;
  GATEWAY_TEXTS?: TextsBinding; // the gateway's `TexTexts`: a text's session from the person object (`gatewaySession.ts`)
  /** The chat object's way out to the network, when it runs in the gateway (`apps/mcp/src/texChat.js`); absent, the global fetch. */
  FETCH?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Where an incoming text's head runs: "gateway" hands it to the gateway's TexChat (`/texts/arrive`); anything else keeps the SenderInbox queue (`handOver.ts`). */
  INTAKE?: string;
  /** "on" serves the texts simulator (simulator.ts). Only staging sets it. */
  SIMULATOR?: string;
  /** Turns a texted photo the model cannot read (HEIC) into a JPEG (`attachments.ts`). */
  IMAGES?: ImagesBinding;
  /** Each answered text's wait, arrival to first bubble (`textTiming.ts`); absent when self-hosting. */
  TEX_TEXTS?: TimingDataset;
  /** Each text in and out, and who texted, for the staff dashboard (`textCounts.ts`); absent when self-hosting. */
  TEX_COUNTS?: CountDataset;
  /** "on" sends Context cards to every chat, "app" only to chats that have shown the app (`appCards.ts`, `cardChats.ts`). */
  APP_CARDS?: string;
  APP_CARD_EXTENSION_ID?: string;
  APPLE_TEAM_ID?: string;
  APP_STORE_ID?: string;
}
