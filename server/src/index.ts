#!/usr/bin/env node
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_PORT } from "./protocol.js";
import { startHub } from "./hub.js";
import { prepareDownloadDir } from "./downloads.js";
import { registerTools } from "./tools.js";

function readArgs(name: string): string[] {
  const flag = `--${name}`;
  const values: string[] = [];
  process.argv.forEach((value, index) => {
    if (value === flag) {
      const next = process.argv[index + 1];
      if (next !== undefined) values.push(next);
    } else if (value.startsWith(`${flag}=`)) {
      values.push(value.slice(flag.length + 1));
    }
  });
  return values;
}

function readArg(name: string): string | undefined {
  return readArgs(name)[0];
}

const port = Number(readArg("port") ?? process.env.BROWSER_MCP_PORT ?? DEFAULT_PORT);
const token = readArg("token") ?? process.env.BROWSER_MCP_TOKEN;
const extensionId = readArg("extension-id") ?? process.env.BROWSER_MCP_EXTENSION_ID;
const uploadDirs = [
  ...readArgs("upload-dir"),
  ...(process.env.BROWSER_MCP_UPLOAD_DIRS ?? "").split(path.delimiter),
]
  .map((dir) => dir.trim())
  .filter(Boolean)
  .map((dir) => path.resolve(dir));
const verbose = process.argv.includes("--verbose") || process.env.BROWSER_MCP_DEBUG === "1";
let downloadDir: string | undefined;
try {
  downloadDir = prepareDownloadDir(readArg("download-dir") ?? process.env.BROWSER_MCP_DOWNLOAD_DIR);
} catch (error) {
  process.stderr.write(`[browser-mcp] invalid download directory: ${String(error)}\n`);
  process.exit(1);
}

const log = (message: string) => {
  if (verbose) process.stderr.write(`[browser-mcp] ${message}\n`);
};

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  process.stderr.write(`[browser-mcp] invalid port: ${String(port)}\n`);
  process.exit(1);
}

const hub = await startHub({ port, token, extensionId, log });

process.stderr.write(
  `[browser-mcp] role=${hub.role} port=${port} token=${token ? "set" : "UNSET (any local process can connect; set BROWSER_MCP_TOKEN)"} uploadDirs=${uploadDirs.length === 0 ? "none (browser_upload_file disabled)" : uploadDirs.join(", ")} downloadDir=${downloadDir ?? "none (download tools disabled)"}\n`,
);

const server = new Server(
  { name: "browser-mcp", version: "0.2.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Controls the user's real, already-logged-in Chrome through the Browser MCP Bridge extension. " +
      "Prefer browser_read { action: 'snapshot' } before clicking or typing: refs are stable only until the next snapshot or navigation. " +
      "The user is working in the same browser: never activate or navigate their active tab unless asked; pass tabId explicitly and prefer background tabs. " +
      "Confirm with the user before side-effecting actions (submitting forms, sending messages, deleting data, purchases).",
  },
);

registerTools(server, hub, { uploadDirs, downloadDir });

const transport = new StdioServerTransport();
await server.connect(transport);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await hub.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
