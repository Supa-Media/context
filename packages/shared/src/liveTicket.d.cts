/** Types for `liveTicket.cjs`; see that file. */

export declare const LIVE_TICKET_PATH: "/presence/ticket";
export declare const TICKET_PROTOCOL_PREFIX: "context.ticket.";
export declare function ticketProtocols(protocol: string, ticket: string): string[];
export type TicketFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export declare function fetchLiveTicket(options: { gatewayOrigin: string; token: string; socket: string; fetch?: TicketFetch }): Promise<string>;
