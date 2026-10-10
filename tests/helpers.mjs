// Spawn a server and speak JSON-RPC to it over stdio, exactly as a client does.
//
// Testing through the real interface rather than importing internals means these
// tests also cover the protocol layer — the handshake, the tool schemas, and the
// drain-on-stdin-close behavior that a direct function import would skip.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const serverPath = (name) => path.join(ROOT, "servers", name, "index.js");
export const fixture = (name) => path.join(ROOT, "tests", "fixtures", name);

/**
 * Send a list of JSON-RPC requests to a server, close stdin, collect replies.
 * Closing stdin immediately is deliberate: a server that exits without draining
 * in-flight work will silently drop responses, which is a bug we shipped once.
 */
export function rpc(server, requests, { env = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath(server)], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${server} timed out after ${timeoutMs}ms. stderr: ${err.slice(0, 400)}`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      const messages = out
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      resolve({ messages, stderr: err });
    });

    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
    child.stdin.end();
  });
}

/** Call one tool and return its parsed result payload. */
export async function callTool(server, name, args = {}, opts = {}) {
  const { messages } = await rpc(
    server,
    [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }],
    opts
  );
  const reply = messages.find((m) => m.id === 1);
  if (!reply) throw new Error(`${server}.${name}: no reply received (server exited before answering)`);
  const content = reply.result?.content?.[0]?.text ?? "";
  return {
    isError: Boolean(reply.result?.isError),
    text: content,
    json: (() => {
      try {
        return JSON.parse(content);
      } catch {
        return null;
      }
    })(),
  };
}

/** Handshake + tools/list, for protocol-level assertions. */
export async function listTools(server, opts = {}) {
  const { messages } = await rpc(
    server,
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ],
    opts
  );
  return {
    init: messages.find((m) => m.id === 1)?.result,
    tools: messages.find((m) => m.id === 2)?.result?.tools ?? [],
  };
}
