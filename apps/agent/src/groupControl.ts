/**
 * Who a group chat is, asked of the control plane (`POST /agent-texts/group`)
 * on every message Tex acts on (moved out of `groupInbox.ts` whole).
 */

import { readTexStyle, type TexStyle } from "./texStyle";
import { post, record, ServiceError } from "./clients";
import { GROUP_STYLES, type GroupStyle } from "./decide";
import type { GroupDeps, Command } from "./groupInbox";
import type { GroupMessage } from "./sendblueGroups";

export type ControlAnswer =
  | { status: "refused" | "muted" | "stopped" | "started" | "no_shared" }
  | { status: "not_allowed"; slug: string }
  | { status: "invited"; slug: string; count: number; role: string }
  | { status: "mail_shared"; address: string; narrowed: boolean }
  | { status: "mail_unshared"; count: number }
  | { status: "mail_refused" }
  | { status: "unknown_sender"; tell?: boolean }
  | {
      status: "ready";
      slug: string;
      /** The slugs of the shared workspaces every account holder here shares (`lib/textGroupReach.ts`): none when anyone has no account. */
      reach?: string[];
      intro: boolean;
      timeZone?: string;
      handle?: string;
      accessToken?: string;
      names?: { phone: string; handle: string }[];
      guests?: { phone: string; label: string }[];
      /** Mailboxes shared with this chat (`chat-mail.md`): the turn is told whose and which. */
      mail?: { handle: string; address: string }[];
      /** When Tex speaks up here (`groupStyle.ts`); absent from a control plane that has none. */
      engagement?: GroupStyle;
      engagementChosen?: boolean;
      /** How Tex talks in this chat (`texStyle.ts`): the group's own, never a member's personal one. */
      texStyle?: TexStyle;
    };

const LABEL = /^guest-[0-9a-f]{4}$/;
const MAIL_ADDRESS = /^[^\s@/]{1,64}@[^\s@/]{1,190}$/;

export async function askControlPlane(deps: GroupDeps, message: GroupMessage, people: string[], command: Command | null): Promise<ControlAnswer> {
  const wire = command === null || command.kind === "status" || command.kind === "settings" || command.kind === "style" || command.kind === "review_sharing" ? undefined : command;
  const { status, json } = await post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/group`, deps.workerSecret, {
    line: message.line,
    groupId: message.groupId,
    sender: message.from,
    participants: people.includes(message.from) ? people : [...people, message.from],
    ...(wire !== undefined ? { command: wire } : {}),
    ...(command === null ? { mint: true } : {}),
    // A routine's or check-in's own turn is nobody talking: the chat's last word stays when it was (`textGroupLooks.ts`).
    ...(message.routine !== undefined ? { routine: true } : {}),
  });
  if (status !== 200) throw new ServiceError("control_plane", status);
  const body = record(json);
  const slug = (value: unknown) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,64}$/.test(value);
  switch (body.status) {
    case "refused":
    case "muted":
    case "stopped":
    case "started":
    case "no_shared":
      return { status: body.status };
    case "unknown_sender":
      return { status: "unknown_sender", tell: body.tell === true };
    case "not_allowed":
      if (!slug(body.slug)) throw new ServiceError("control_plane", status);
      return { status: "not_allowed", slug: body.slug as string };
    case "mail_shared":
      if (typeof body.address !== "string" || !MAIL_ADDRESS.test(body.address)) throw new ServiceError("control_plane", status);
      return { status: "mail_shared", address: body.address, narrowed: body.narrowed === true };
    case "mail_unshared":
      return { status: "mail_unshared", count: typeof body.count === "number" && Number.isInteger(body.count) ? Math.max(0, Math.min(body.count, 10)) : 0 };
    case "mail_refused":
      return { status: "mail_refused" };
    case "invited":
      if (!slug(body.slug) || typeof body.count !== "number" || !Number.isInteger(body.count) || body.count < 0) throw new ServiceError("control_plane", status);
      return { status: "invited", slug: body.slug as string, count: Math.min(body.count, 64), role: body.role === "member" ? "member" : "editor" };
    case "ready":
      if (!slug(body.slug)) throw new ServiceError("control_plane", status);
      return {
        status: "ready",
        slug: body.slug as string,
        ...(Array.isArray(body.reach) ? { reach: (body.reach.filter(slug) as string[]).slice(0, 12) } : {}),
        intro: body.intro === true,
        ...(typeof body.timeZone === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(body.timeZone) ? { timeZone: body.timeZone } : {}),
        ...(slug(body.handle) ? { handle: body.handle as string } : {}),
        ...(typeof body.accessToken === "string" && body.accessToken !== "" ? { accessToken: body.accessToken } : {}),
        names: (Array.isArray(body.names) ? body.names : []).map(record).flatMap((entry) =>
          typeof entry.phone === "string" && slug(entry.handle) ? [{ phone: entry.phone, handle: entry.handle as string }] : [],
        ),
        guests: (Array.isArray(body.guests) ? body.guests : []).map(record).flatMap((entry) =>
          typeof entry.phone === "string" && typeof entry.label === "string" && LABEL.test(entry.label) ? [{ phone: entry.phone, label: entry.label }] : [],
        ),
        mail: (Array.isArray(body.mail) ? body.mail : []).slice(0, 10).map(record).flatMap((entry) =>
          slug(entry.handle) && typeof entry.address === "string" && MAIL_ADDRESS.test(entry.address) ? [{ handle: entry.handle as string, address: entry.address }] : [],
        ),
        ...(GROUP_STYLES.includes(body.engagement as GroupStyle) ? { engagement: body.engagement as GroupStyle } : {}),
        ...(typeof body.engagementChosen === "boolean" ? { engagementChosen: body.engagementChosen } : {}),
        ...(readTexStyle(body.texStyle) ? { texStyle: readTexStyle(body.texStyle) } : {}),
      };
    default:
      throw new ServiceError("control_plane", status);
  }
}

