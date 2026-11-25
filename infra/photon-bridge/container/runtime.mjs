/**
 * The Photon side of the container: mints line tokens, runs one listener per
 * line, and executes the ops. The only module that imports the SDK.
 */
import { createGrpcClient, MessageEffect } from "@photon-ai/advanced-imessage/grpc";
import { createDeliveryWatch } from "./delivery.mjs";
import { createEnricher, createLru } from "./enrich.mjs";
import { RequestError } from "./errors.mjs";
import { fetchFile, nameFor } from "./files.mjs";
import { runLine } from "./listener.mjs";
import { MAX_PHOTO_BYTES, readWhole } from "./photo.mjs";
import { createLedger } from "./ledger.mjs";
import { last4 } from "./log.mjs";
import { POLL_INTERVAL_MS, readHealth } from "./readHealth.mjs";
import { createReads } from "./reads.mjs";
import { issueTokens, linesOf, renewalDelayMs, RETRY_MS } from "./tokens.mjs";

function compact(object) {
  for (const key of Object.keys(object)) {
    if (object[key] === undefined) delete object[key];
  }
  return object;
}

/** {bytes, name} for an upload: inline base64, or an https URL fetched under the size cap. */
/** The name a re-uploaded sticker goes under: its own, without any folder, or "sticker.png". */
export function stickerName(info) {
  const name = typeof info?.fileName === "string" ? info.fileName.split(/[\\/]/).pop() : "";
  return name && name.length <= 255 ? name : "sticker.png";
}

export async function fileBytes(file, fetchImpl = fetch) {
  if (file.data !== undefined) {
    return { bytes: Buffer.from(file.data, "base64"), name: nameFor(file.name, file.mimeType) };
  }
  const fetched = await fetchFile(file.url, file.mimeType, fetchImpl);
  return { bytes: fetched.bytes, name: nameFor(file.name, fetched.mimeType) };
}

export function createRuntime({
  projectId,
  projectSecret,
  log,
  makeClient = createGrpcClient,
  issue = issueTokens,
  fetchImpl = fetch,
}) {
  const configured = Boolean(projectId && projectSecret);
  const ledger = createLedger();
  // Shared by every line: message guids are unique across them.
  const recent = createLru();
  const rememberSent = (sent, text) => {
    if (sent?.guid && typeof text === "string") recent.set(sent.guid, { text, fromMe: true });
  };
  const tokens = new Map();
  const clients = new Map();
  // Each send is read back for its error code and delivery (`delivery.mjs`): Photon has no delivery event.
  const delivery = createDeliveryWatch({
    get: (line, guid) => clientFor(line).messages.get(guid),
    push: (line, event) => ledger.push(line, event),
    log,
  });
  const watch = (args, sent) => delivery.watch(args.line, args.chat, sent);
  const controller = new AbortController();
  const reads = createReads(log);
  let startPromise;

  function tokenFor(instanceId) {
    const token = tokens.get(instanceId);
    if (!token) throw new Error("no line token");
    return token;
  }

  async function mintAndListen() {
    const data = await issue({ projectId, projectSecret, fetchImpl });
    for (const [instanceId, token] of Object.entries(data.auth)) tokens.set(instanceId, token);
    for (const { instanceId, line, address } of linesOf(data)) {
      if (clients.has(line)) continue;
      const client = makeClient({
        address,
        tls: true,
        autoIdempotency: true,
        retry: true,
        token: async () => tokenFor(instanceId),
      });
      clients.set(line, client);
      log({ event: "line.start", line });
      const enricher = createEnricher({
        cache: recent,
        lookup: async (guid) => {
          const message = await client.messages.get(guid);
          return { text: message.content?.text ?? "", fromMe: message.isFromMe === true };
        },
        poll: async (guid) => await client.polls.get(guid),
        chat: async (guid) => await client.chats.get(guid),
      });
      runLine({
        client,
        line,
        ledger,
        onQueued: () => {},
        signal: controller.signal,
        log,
        enrich: enricher.enrich,
        onCatchup: (stats) => reads.catchup(line, stats),
        onPoll: () => reads.poll(line),
        onPollFailed: (code) => reads.fail(line, code),
        pollMs: POLL_INTERVAL_MS,
      }).catch((error) => {
        log({ event: "line.crashed", line, error: typeof error?.code === "string" ? error.code : "unknown" });
      });
    }
    return data.expiresIn;
  }

  function scheduleRenewal(delay) {
    setTimeout(async () => {
      try {
        const expiresIn = await mintAndListen();
        scheduleRenewal(renewalDelayMs(expiresIn));
      } catch (error) {
        log({ event: "token.renew_failed", error: typeof error?.code === "string" ? error.code : "unknown", delay_ms: RETRY_MS });
        scheduleRenewal(RETRY_MS);
      }
    }, delay);
  }

  function clientFor(line) {
    const client = clients.get(line);
    if (!client) throw new RequestError(404, "line_not_active");
    return client;
  }

  function anyClient() {
    const first = clients.values().next();
    if (first.done) throw new RequestError(503, "no_line_active");
    return first.value;
  }

  async function uploadFile(client, file) {
    const { bytes, name } = await fileBytes(file, fetchImpl);
    const uploaded = await client.attachments.upload({ fileName: name, data: bytes });
    return uploaded.attachment.guid;
  }

  async function uploadStickerFrom(client, guid) {
    let info;
    const bytes = await readWhole(client.attachments.downloadStream(guid), MAX_PHOTO_BYTES, (header) => (info = header));
    const uploaded = await client.attachments.upload({ fileName: stickerName(info), data: bytes });
    return uploaded.attachment.guid;
  }

  return {
    configured,

    /** The oldest unacked mapped event of a chat not in `skip`, waiting up to `ms` for one. */
    nextEvent(ms, skip) {
      return ledger.wait(ms, skip);
    },

    /** The object stored event `id`; returns {line, frontier}, or null if unknown. */
    ack(id) {
      return ledger.ack(id);
    },

    /** Mints tokens and starts the listeners. Idempotent; a failure can be retried. */
    start(checkpoints) {
      if (!configured) throw new RequestError(503, "unconfigured");
      reads.start();
      if (!startPromise) {
        for (const [line, seq] of Object.entries(checkpoints ?? {})) {
          if (Number.isSafeInteger(seq)) ledger.initialize(line, seq);
        }
        startPromise = mintAndListen().then((expiresIn) => {
          scheduleRenewal(renewalDelayMs(expiresIn));
        });
        startPromise.catch((error) => {
          log({ event: "start.failed", error: typeof error?.code === "string" ? error.code : error?.name ?? "unknown" });
          startPromise = undefined;
        });
      }
      return startPromise;
    },

    /** Each line's frontier, for the Durable Object to store (`/frontiers`). */
    frontiers() {
      return ledger.checkpoints();
    },

    health() {
      const snapshot = ledger.snapshot();
      const { startedAt, lastReadAt } = reads.snapshot();
      const started = startPromise !== undefined;
      const verdict = readHealth({ now: Date.now(), started, startedAt, lastReadAt });
      return {
        ok: verdict.ok,
        read: verdict.read,
        readAgeMs: verdict.readAgeMs,
        lastReadAt,
        startedAt,
        configured,
        started,
        lines: snapshot.lines.map(({ line, frontier, stuckMs }) => ({ line: last4(line), frontier, stuckMs })),
        queued: snapshot.queued,
        skipped: snapshot.skipped,
        replayDropped: snapshot.replayDropped,
        gapSkipped: snapshot.gapSkipped,
        checks: delivery.size(),
      };
    },

    async execute(op, args) {
      switch (op) {
        case "send/text": {
          const client = clientFor(args.line);
          const sent = await client.messages.sendText(
            args.chat,
            args.text,
            compact({
              replyTo: args.replyTo,
              effect: args.effect ? MessageEffect[args.effect] : undefined,
              enableLinkPreview: args.linkPreview ? true : undefined,
            }),
          );
          rememberSent(sent, args.text);
          watch(args, sent);
          return { ok: true, guid: sent.guid };
        }
        case "send/attachment": {
          const client = clientFor(args.line);
          const attachment = await uploadFile(client, args.file);
          const sent = await client.messages.sendAttachment(args.chat, attachment, compact({ replyTo: args.replyTo }));
          watch(args, sent);
          return { ok: true, guid: sent.guid, attachment };
        }
        case "send/multipart": {
          const client = clientFor(args.line);
          const parts = [];
          for (const part of args.parts) {
            if (part.text !== undefined) {
              parts.push(compact({ text: part.text, mentionedAddress: part.mention }));
            } else {
              const guid = await uploadFile(client, part.attachment);
              parts.push({ attachmentGuid: guid, attachmentName: part.attachment.name });
            }
          }
          const sent = await client.messages.sendMultipart(args.chat, parts, compact({ replyTo: args.replyTo }));
          watch(args, sent);
          return { ok: true, guid: sent.guid };
        }
        case "send/app": {
          const client = clientFor(args.line);
          const { card } = args;
          const sent = await client.messages.sendCustomizedMiniApp(args.chat, compact({
            appName: card.appName,
            appStoreId: card.appStoreId,
            extensionBundleId: card.extensionBundleId,
            teamId: card.teamId,
            url: card.url,
            live: card.live,
            layout: compact({
              caption: card.layout.caption,
              subcaption: card.layout.subcaption,
              imageTitle: card.layout.imageTitle,
              imageSubtitle: card.layout.imageSubtitle,
              summary: card.layout.summary,
              trailingCaption: card.layout.trailingCaption,
              trailingSubcaption: card.layout.trailingSubcaption,
              image: card.layout.image ? Buffer.from(card.layout.image, "base64") : undefined,
            }),
          }));
          watch(args, sent);
          return { ok: true, guid: sent.guid, sessionId: sent.miniAppCardSession?.sessionId };
        }
        case "edit": {
          const sent = await clientFor(args.line).messages.edit(args.chat, args.guid, args.text);
          rememberSent({ guid: args.guid }, args.text);
          return { ok: true, guid: sent.guid };
        }
        case "unsend":
          await clientFor(args.line).messages.unsend(args.chat, args.guid);
          return { ok: true };
        case "react":
          await clientFor(args.line).messages.setReaction(
            args.chat,
            args.guid,
            compact({ kind: args.kind, emoji: args.emoji }),
            args.on,
          );
          return { ok: true };
        case "sticker": {
          const client = clientFor(args.line);
          // A sticker someone stuck in the chat is read off the line and uploaded again as Tex's own, as a photo is
          // read for `group/photo`: a received attachment's guid is never handed to Photon as an upload.
          const sticker = args.sticker.attachment !== undefined
            ? await uploadStickerFrom(client, args.sticker.attachment)
            : await uploadFile(client, args.sticker.file);
          const placed = await client.messages.placeSticker(args.chat, args.guid, sticker, args.placement, compact({ partIndex: args.part }));
          return { ok: true, guid: placed.guid, attachment: sticker };
        }
        case "typing":
          await clientFor(args.line).chats.setTyping(args.chat, args.on);
          return { ok: true };
        case "read":
          await clientFor(args.line).chats.markRead(args.chat);
          return { ok: true };
        case "contact":
          await clientFor(args.line).chats.shareContactInfo(args.chat);
          return { ok: true };
        case "chat/resolve": {
          const created = await clientFor(args.line).chats.create([args.address]);
          return { ok: true, guid: created.chat.guid };
        }
        case "group/members": {
          const chat = await clientFor(args.line).chats.get(args.chat);
          return { ok: true, participants: chat.participants.map((p) => p.address) };
        }
        case "poll/create": {
          const poll = await clientFor(args.line).polls.create(args.chat, args.title, args.choices);
          return { ok: true, guid: poll.pollMessageGuid };
        }
        case "group/name": {
          await clientFor(args.line).groups.setDisplayName(args.chat, args.name);
          return { ok: true };
        }
        case "group/photo": {
          const client = clientFor(args.line);
          await client.groups.setIcon(args.chat, await readWhole(client.attachments.downloadStream(args.attachment), MAX_PHOTO_BYTES));
          return { ok: true };
        }
        case "group/add": {
          const chat = await clientFor(args.line).groups.addParticipants(args.chat, [args.address]);
          return { ok: true, participants: chat.participants.map((p) => p.address) };
        }
        case "group/remove": {
          const chat = await clientFor(args.line).groups.removeParticipants(args.chat, [args.address]);
          return { ok: true, participants: chat.participants.map((p) => p.address) };
        }
        default:
          throw new RequestError(404, "unknown_op");
      }
    },

    /** Opens an attachment's bytes: the header, then an async iterable of chunks. */
    async openAttachment(guid, line) {
      const client = line === undefined ? anyClient() : clientFor(line);
      const stream = client.attachments.downloadStream(guid);
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || first.value.type !== "header") {
        await stream.close();
        throw new RequestError(502, "attachment_header_missing");
      }
      async function* chunks() {
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) return;
            if (next.value.type === "primaryChunk") yield next.value.data;
          }
        } finally {
          await stream.close();
        }
      }
      return { info: first.value.info, chunks: chunks() };
    },

    stop() {
      controller.abort();
    },
  };
}
