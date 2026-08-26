#!/usr/bin/env node

import readline from "node:readline";

const MCP_URL = process.env.CONTEXT_MCP_URL ?? "https://mcp.context.lc/mcp";
const PROTOCOL_VERSION = "2025-06-18";

function loadToken() {
  const token = process.env.AI_BRAIN_PRIVATE_TOKEN ?? "";
  delete process.env.AI_BRAIN_PRIVATE_TOKEN;
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(token)) {
    throw new Error("The Brain bridge did not receive a valid private token.");
  }
  return token;
}

function decodeResponseBody(contentType, body) {
  if (!body.trim()) return [];

  if (contentType.includes("text/event-stream")) {
    const messages = [];
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      messages.push(JSON.parse(data));
    }
    return messages;
  }

  return [JSON.parse(body)];
}

async function postMcp(token, message) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(message),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Brain MCP returned HTTP ${response.status}.`);
  }

  return decodeResponseBody(response.headers.get("content-type") ?? "", body);
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorResponse(id, error) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: -32000,
      message: error instanceof Error ? error.message : "Brain MCP proxy error.",
    },
  };
}

async function checkConnection(token) {
  const initialized = await postMcp(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "brain-keychain-check", version: "1.0.0" },
    },
  });
  const initializeResult = initialized.find((message) => message.id === 1)?.result;
  if (initializeResult?.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error("Brain MCP initialization response was not recognized.");
  }

  await postMcp(token, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  const listed = await postMcp(token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const tools = listed.find((message) => message.id === 2)?.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error("Brain MCP did not return its tool list.");
  }
  process.stdout.write(
    `Live private MCP authentication and tools: OK (${tools.length} tools)\n`,
  );
}

async function runProxy(token) {
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  let queue = Promise.resolve();

  input.on("line", (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        emit(errorResponse(null, new Error("Invalid JSON received by Brain MCP proxy.")));
        return;
      }

      try {
        const responses = await postMcp(token, message);
        for (const response of responses) emit(response);
      } catch (error) {
        if (Object.hasOwn(message, "id")) emit(errorResponse(message.id, error));
        else process.stderr.write(`${error.message}\n`);
      }
    });
  });

  await new Promise((resolve) => input.once("close", resolve));
  await queue;
}

try {
  const token = loadToken();
  if (process.argv.includes("--check")) await checkConnection(token);
  else await runProxy(token);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
