// End-to-end smoke test:
//   1. MCP client A spawns the server (ports becomes the hub host).
//   2. A fake extension connects to /extension with a chrome-extension:// Origin.
//   3. MCP client B spawns a second server on the same port -> it must become a guest.
//   4. Both clients drive tools through the hub; the fake extension answers.
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "dist", "index.js");
const PORT = 18787;
const TOKEN = "smoke-token";
const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const UPLOAD_DIR = path.join(os.tmpdir(), "browser-mcp-smoke");
const UPLOAD_FILE = path.join(UPLOAD_DIR, "sample.txt");
const DOWNLOAD_DIR = path.join(os.tmpdir(), "browser-mcp-smoke-downloads", "browser-mcp");
const DOWNLOAD_FILE = path.join(DOWNLOAD_DIR, "download.txt");
const OUTSIDE_FILE = process.execPath;

const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, condition, detail) {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
    failures.push(name);
  }
}

function startClient(label, extraArgs = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "--port", String(PORT), "--token", TOKEN, ...extraArgs],
    stderr: "pipe",
  });
  const client = new Client({ name: `smoke-${label}`, version: "0.0.0" });
  return { transport, client };
}

function connectExtension() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/extension?token=${TOKEN}`, {
      origin: EXTENSION_ORIGIN,
    });
    socket.once("error", reject);
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          kind: "hello",
          protocol: 1,
          role: "extension",
          extensionVersion: "smoke",
        }),
      );
      resolve(socket);
    });
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.kind !== "command") return;
      const canned = {
        tabs_list: {
          tabs: [
            {
              tabId: 7,
              windowId: 1,
              index: 0,
              active: true,
              pinned: false,
              groupId: -1,
              title: "Fake Tab",
              url: "https://example.com/",
            },
          ],
        },
        snapshot: {
          url: "https://example.com/",
          title: "Fake Tab",
          epoch: "abc123",
          count: 1,
          text: '- button "Go" [ref=abc123_1]',
          viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0, dpr: 1 },
        },
        click: { ok: true, x: 10, y: 20 },
        hover: { ok: true, x: 10, y: 20 },
        select: { ok: true, selected: { value: "b", label: "Bravo", index: 1 } },
        back: { ok: true, url: "https://example.com/previous" },
        forward: { ok: true, url: "https://example.com/next" },
        reload: { ok: true, ignoreCache: false },
        dialog: { ok: true, handled: "alert", accepted: true },
        scroll: { ok: true, deltaY: 600 },
        find: { ok: true, count: 1, epoch: "abc123", text: '- [abc123_9] text "sign in"' },
        upload: { ok: true, files: ["sample.txt"] },
        detach: { ok: true, detached: [7] },
        screenshot: { data: Buffer.from("fake-png").toString("base64"), width: 100, height: 50 },
        download_start: {
          downloadId: "00000000-0000-4000-8000-000000000001",
          state: "complete",
          url: "https://example.test/download.txt",
          finalUrl: "https://example.test/download.txt",
          name: "download.txt",
          path: fs.realpathSync.native(DOWNLOAD_FILE),
        },
        download_list: {
          downloads: [
            {
              downloadId: "00000000-0000-4000-8000-000000000001",
              state: "complete",
              url: "https://example.test/download.txt",
              name: "download.txt",
              path: fs.realpathSync.native(DOWNLOAD_FILE),
            },
          ],
        },
        download_status: {
          downloadId: "00000000-0000-4000-8000-000000000001",
          state: "complete",
          url: "https://example.test/download.txt",
          name: "download.txt",
          path: fs.realpathSync.native(DOWNLOAD_FILE),
          wait: { outcome: "terminal", timeoutMs: 1000, elapsedMs: 10 },
        },
        download_cancel: {
          downloadId: "00000000-0000-4000-8000-000000000001",
          state: "cancelled",
          url: "https://example.test/download.txt",
        },
        network_start: {
          tabId: 7,
          active: true,
          captureId: "capture-1",
          startedAt: 1,
          lastEventAt: null,
          total: 0,
          dropped: 0,
          alreadyActive: false,
          cleared: 0,
        },
        network_list: {
          tabId: 7,
          active: true,
          captureId: "capture-1",
          total: 1,
          dropped: 0,
          matched: 1,
          returned: 1,
          nextBeforeSequence: 1,
          entries: [
            {
              entryId: "capture-1:1",
              sequence: 1,
              state: "success",
              method: "GET",
              url: "https://example.test/api?token=__REDACTED__",
              resourceType: "Fetch",
            },
          ],
        },
        network_get: {
          tabId: 7,
          captureId: "capture-1",
          entry: {
            entryId: "capture-1:1",
            sequence: 1,
            state: "success",
            method: "GET",
            url: "https://example.test/api?token=__REDACTED__",
            resourceType: "Fetch",
            requestHeaders: { values: { accept: "application/json" }, redacted: ["authorization"], truncated: false },
          },
        },
        network_stop: { tabId: 7, active: false, captureId: null, total: 0, dropped: 0, cleared: 1 },
      };
      if (
        message.command === "click" &&
        message.params.snapshot === true &&
        message.params.waitFor &&
        message.params.settle === "both"
      ) {
        canned.click = {
          ok: true,
          x: 10,
          y: 20,
          actionState: {
            phase: "settled",
            navigation: "same-document",
            networkIdle: true,
            waited: ["selector:#done"],
            snapshot: true,
          },
          snapshot: canned.snapshot,
        };
      }
      const result = canned[message.command] ?? { echoed: message.command, params: message.params };
      socket.send(JSON.stringify({ kind: "reply", id: message.id, ok: true, result }));
    });
  });
}

async function connectExtensionWithRetry() {
  let lastError;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      return await connectExtension();
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }
  throw lastError ?? new Error("extension could not connect");
}

async function main() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(UPLOAD_FILE, "smoke");
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.writeFileSync(DOWNLOAD_FILE, "download smoke");

  const a = startClient("a", ["--upload-dir", UPLOAD_DIR, "--download-dir", DOWNLOAD_DIR]);
  await a.client.connect(a.transport);
  const extension = await connectExtensionWithRetry();
  const b = startClient("b", ["--download-dir", DOWNLOAD_DIR]);
  await b.client.connect(b.transport);

  const health = await fetch(`http://127.0.0.1:${PORT}/health?token=${TOKEN}`)
    .then((response) => response.json())
    .catch(() => null);
  check(
    "GET /health reports the hub and the extension",
    !!health && health.service === "browser-mcp" && health.role === "host" && health.extensionConnected === true,
    JSON.stringify(health),
  );

  const healthWithoutToken = await fetch(`http://127.0.0.1:${PORT}/health`)
    .then((response) => response.status)
    .catch(() => 0);
  check("GET /health without the token is rejected", healthWithoutToken === 401, String(healthWithoutToken));

  const corsResponse = await fetch(`http://127.0.0.1:${PORT}/health?token=${TOKEN}`, {
    headers: { origin: EXTENSION_ORIGIN },
  }).catch(() => null);
  check(
    "GET /health allows chrome-extension origins (CORS fallback)",
    !!corsResponse && corsResponse.headers.get("access-control-allow-origin") === EXTENSION_ORIGIN,
    String(corsResponse && corsResponse.headers.get("access-control-allow-origin")),
  );

  const tools = await a.client.listTools();
  check(
    "tools/list exposes browser_tab",
    tools.tools.some((tool) => tool.name === "browser_tab"),
    `got ${tools.tools.length} tools`,
  );

  const requiredTools = [
    "browser_tab",
    "browser_act",
    "browser_read",
    "browser_network",
    "browser_download",
    "browser_server_status",
    "browser_cdp",
  ];
  check(
    "tools/list exposes all 7 compact tools",
    requiredTools.every((name) => tools.tools.some((tool) => tool.name === name)),
    `got ${tools.tools.length} tools`,
  );
  check("tools/list contains 7 tools", tools.tools.length === 7, `got ${tools.tools.length}`);
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(here, "..", "..", "extension", "manifest.json"), "utf8"),
  );
  check(
    "extension requests downloads without file-system permissions",
    manifest.permissions.includes("downloads") &&
      !manifest.permissions.includes("downloads.open") &&
      !manifest.permissions.includes("files"),
    JSON.stringify(manifest.permissions),
  );

  const tabsA = await a.client.callTool({ name: "browser_tab", arguments: { action: "list" } });
  check("host browser_tab/list reaches the extension", JSON.stringify(tabsA.content).includes("Fake Tab"));

  const snapshot = await a.client.callTool({ name: "browser_read", arguments: { action: "snapshot", tabId: 7 } });
  check("host snapshot returns refs", JSON.stringify(snapshot.content).includes("ref=abc123_1"));

  const networkStart = await a.client.callTool({
    name: "browser_network",
    arguments: { action: "start", tabId: 7, clear: true },
  });
  const networkStartJson = JSON.parse(String(networkStart.content[0]?.text ?? "{}"));
  check("network capture starts", networkStartJson.active === true, JSON.stringify(networkStartJson));

  const networkList = await a.client.callTool({
    name: "browser_network",
    arguments: { action: "list", tabId: 7, limit: 10, urlContains: "example.test" },
  });
  const networkListJson = JSON.parse(String(networkList.content[0]?.text ?? "{}"));
  check(
    "network requests are listed with redacted URLs",
    networkListJson.entries?.[0]?.entryId === "capture-1:1" &&
      !JSON.stringify(networkListJson).includes("top-secret"),
    JSON.stringify(networkListJson),
  );

  const networkGet = await b.client.callTool({
    name: "browser_network",
    arguments: { action: "get", tabId: 7, entryId: "capture-1:1" },
  });
  check(
    "guest network detail is tunnelled through the host",
    JSON.stringify(networkGet.content).includes("authorization"),
    JSON.stringify(networkGet.content),
  );

  const action = await a.client.callTool({
    name: "browser_act",
    arguments: {
      action: "click",
      tabId: 7,
      x: 10,
      y: 20,
      settle: "both",
      waitFor: { selector: "#done", visible: true },
      snapshot: true,
      timeoutMs: 5000,
    },
  });
  const actionJson = JSON.parse(String(action.content[0]?.text ?? "{}"));
  check(
    "action-state options return settled state and snapshot",
    actionJson.actionState?.phase === "settled" && actionJson.snapshot?.count === 1,
    JSON.stringify(actionJson),
  );

  const downloadStart = await a.client.callTool({
    name: "browser_download",
    arguments: {
      action: "start",
      url: "https://example.test/download.txt",
      filename: "download.txt",
      requestId: "00000000-0000-4000-8000-000000000001",
    },
  });
  const downloadStartJson = JSON.parse(String(downloadStart.content[0]?.text ?? "{}"));
  check(
    "download start returns an opaque id and contained file metadata",
    downloadStartJson.downloadId === "00000000-0000-4000-8000-000000000001" &&
      downloadStartJson.file?.name === "download.txt",
    JSON.stringify(downloadStartJson),
  );

  const downloadStatus = await b.client.callTool({
    name: "browser_download",
    arguments: {
      action: "status",
      downloadId: "00000000-0000-4000-8000-000000000001",
      wait: true,
      timeoutMs: 1000,
    },
  });
  const downloadStatusJson = JSON.parse(String(downloadStatus.content[0]?.text ?? "{}"));
  check(
    "guest download status waits through the host",
    downloadStatusJson.wait?.outcome === "terminal",
    JSON.stringify(downloadStatusJson),
  );

  const downloadList = await a.client.callTool({ name: "browser_download", arguments: { action: "list" } });
  check("download list routes to the extension", JSON.stringify(downloadList.content).includes("download.txt"));
  const downloadCancel = await a.client.callTool({
    name: "browser_download",
    arguments: { action: "cancel", downloadId: "00000000-0000-4000-8000-000000000001" },
  });
  check("download cancel routes to the extension", JSON.stringify(downloadCancel.content).includes("cancelled"));

  const invalidDownload = await a.client.callTool({
    name: "browser_download",
    arguments: { action: "start", url: "file:///C:/secret.txt" },
  });
  check(
    "download rejects non-HTTP URLs",
    invalidDownload.isError === true && JSON.stringify(invalidDownload.content).includes("http:"),
    JSON.stringify(invalidDownload.content),
  );

  const networkStop = await a.client.callTool({ name: "browser_network", arguments: { action: "stop", tabId: 7 } });
  const networkStopJson = JSON.parse(String(networkStop.content[0]?.text ?? "{}"));
  check("network capture stops", networkStopJson.active === false, JSON.stringify(networkStopJson));

  const statusA = await a.client.callTool({ name: "browser_server_status", arguments: {} });
  const statusAJson = JSON.parse(String(statusA.content[0]?.text ?? "{}"));
  check("first server is the hub host", statusAJson.role === "host", JSON.stringify(statusAJson));

  const tabsB = await b.client.callTool({ name: "browser_tab", arguments: { action: "list" } });
  check(
    "guest browser_tab/list is tunnelled through the host",
    JSON.stringify(tabsB.content).includes("Fake Tab"),
    JSON.stringify(tabsB.content).slice(0, 400),
  );

  const statusB = await b.client.callTool({ name: "browser_server_status", arguments: {} });
  const statusBJson = JSON.parse(String(statusB.content[0]?.text ?? "{}"));
  check("second server reports guest role", statusBJson.role === "guest", JSON.stringify(statusBJson));

  const shot = await a.client.callTool({ name: "browser_read", arguments: { action: "screenshot", tabId: 7 } });
  check(
    "screenshot is returned as an image content block",
    Array.isArray(shot.content) && shot.content[0]?.type === "image",
  );

  const detach = await a.client.callTool({ name: "browser_tab", arguments: { action: "detach", tabId: 7 } });
  const detachJson = JSON.parse(String(detach.content[0]?.text ?? "{}"));
  check(
    "browser_tab/detach routes to the extension",
    Array.isArray(detachJson.detached) && detachJson.detached[0] === 7,
    JSON.stringify(detachJson),
  );

  const hover = await a.client.callTool({ name: "browser_act", arguments: { action: "hover", tabId: 7, ref: "abc123_1" } });
  check("browser_act/hover routes to the extension", !hover.isError, JSON.stringify(hover.content));

  const select = await a.client.callTool({
    name: "browser_act",
    arguments: { action: "select", tabId: 7, ref: "abc123_1", label: "Bravo" },
  });
  const selectJson = JSON.parse(String(select.content[0]?.text ?? "{}"));
  check("browser_act/select returns the selected option", selectJson.selected?.value === "b", JSON.stringify(selectJson));

  const back = await a.client.callTool({ name: "browser_tab", arguments: { action: "back", tabId: 7 } });
  check("browser_tab/back routes to the extension", !back.isError, JSON.stringify(back.content));

  const reload = await a.client.callTool({ name: "browser_tab", arguments: { action: "reload", tabId: 7 } });
  check("browser_tab/reload routes to the extension", !reload.isError, JSON.stringify(reload.content));

  const dialog = await a.client.callTool({
    name: "browser_act",
    arguments: { action: "dialog", tabId: 7, accept: true },
  });
  check("browser_act/dialog routes to the extension", !dialog.isError, JSON.stringify(dialog.content));

  const find = await a.client.callTool({ name: "browser_read", arguments: { action: "find", tabId: 7, query: "sign in" } });
  check("browser_read/find returns refs", JSON.stringify(find.content).includes("abc123_9"), JSON.stringify(find.content));

  const uploadInside = await a.client.callTool({
    name: "browser_act",
    arguments: { action: "upload", tabId: 7, ref: "abc123_1", files: [UPLOAD_FILE] },
  });
  check("browser_act/upload allows paths inside --upload-dir", !uploadInside.isError, JSON.stringify(uploadInside.content));

  const uploadOutside = await a.client.callTool({
    name: "browser_act",
    arguments: { action: "upload", tabId: 7, ref: "abc123_1", files: [OUTSIDE_FILE] },
  });
  check(
    "browser_act/upload rejects paths outside --upload-dir",
    uploadOutside.isError === true && JSON.stringify(uploadOutside.content).includes("outside"),
    JSON.stringify(uploadOutside.content),
  );

  extension.close();
  await sleep(400);
  const offline = await a.client.callTool({ name: "browser_tab", arguments: { action: "list" } });
  check(
    "clear error when the extension is offline",
    offline.isError === true && JSON.stringify(offline.content).includes("not connected"),
    JSON.stringify(offline.content),
  );

  await a.client.close();
  await b.client.close();
}

try {
  await main();
} catch (error) {
  console.error(`FAIL harness error: ${error && error.stack ? error.stack : error}`);
  failures.push("harness");
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall smoke checks passed");
process.exit(0);
