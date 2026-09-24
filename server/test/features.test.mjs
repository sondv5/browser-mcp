import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  prepareDownloadDir,
  sanitizeDownloadSnapshot,
  validateDownloadFilename,
  validateDownloadRequestId,
  validateDownloadUrl,
} from "../dist/downloads.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function context(globals) {
  return vm.createContext({
    Array,
    Date,
    JSON,
    Map,
    Math,
    Promise,
    RegExp,
    Set,
    String,
    TextEncoder,
    URL,
    clearTimeout,
    console,
    setTimeout,
    ...globals,
  });
}

function loadScript(relativePath, globals) {
  const vmContext = context(globals);
  vm.runInContext(fs.readFileSync(path.join(root, relativePath), "utf8"), vmContext, {
    filename: relativePath,
  });
  return vmContext;
}

function fakeDebugger() {
  const eventListeners = [];
  const detachListeners = [];
  const commands = [];
  let nextUuid = 1;
  const chrome = {
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (target, method, params = {}) => {
        commands.push({ tabId: target.tabId, method, params });
        if (method === "Network.getRequestPostData") return { postData: "request-body" };
        if (method === "Network.getResponseBody") return { body: "response-body", base64Encoded: false };
        return {};
      },
      onEvent: { addListener: (listener) => eventListeners.push(listener) },
      onDetach: { addListener: (listener) => detachListeners.push(listener) },
    },
  };
  return {
    chrome,
    commands,
    emit(method, params, tabId = 7) {
      for (const listener of eventListeners) listener({ tabId }, method, params);
    },
    detach(tabId = 7) {
      for (const listener of detachListeners) listener({ tabId });
    },
    crypto: {
      randomUUID: () => `00000000-0000-4000-8000-${String(nextUuid++).padStart(12, "0")}`,
    },
  };
}

test("network capture records, redacts, paginates, and retrieves bodies", async () => {
  const fake = fakeDebugger();
  const vmContext = loadScript("extension/lib/cdp.js", {
    chrome: fake.chrome,
    crypto: fake.crypto,
  });
  const cdp = vmContext.cdp;
  const started = await cdp.networkStart(7, "client-a", true);
  assert.equal(started.active, true);
  assert.equal(started.total, 0);

  fake.emit("Network.requestWillBeSent", {
    requestId: "request-1",
    type: "Fetch",
    frameId: "frame-1",
    request: {
      method: "post",
      url: "https://user:pass@example.test/api?token=top-secret&X-Amz-Signature=aws-secret&safe=yes#private",
      postData: "request-body",
      headers: {
        Authorization: "Bearer secret",
        Cookie: "session=secret",
        "Content-Type": "application/json",
      },
    },
    initiator: { type: "script", url: "https://example.test/app.js?key=secret" },
  });
  fake.emit("Network.responseReceived", {
    requestId: "request-1",
    response: {
      status: 200,
      statusText: "OK",
      mimeType: "application/json",
      protocol: "h2",
      headers: { "Content-Type": "application/json", "Set-Cookie": "session=secret" },
    },
  });
  fake.emit("Network.loadingFinished", { requestId: "request-1", encodedDataLength: 20 });

  const listed = cdp.networkList(7, { limit: 10, urlContains: "example.test" });
  assert.equal(listed.total, 1);
  assert.equal(listed.entries[0].state, "success");
  assert.equal(listed.entries[0].requestHeaders, undefined);
  assert.match(listed.entries[0].url, /token=__REDACTED__/);
  assert.doesNotMatch(JSON.stringify(listed), /top-secret|aws-secret|Bearer secret|session=secret|user:pass/);

  const entryId = listed.entries[0].entryId;
  const detail = await cdp.networkGet(7, { entryId, includeBody: true });
  assert.equal(detail.entry.requestHeaders.values["content-type"], "application/json");
  assert.deepEqual(Array.from(detail.entry.requestHeaders.redacted), ["authorization", "cookie"]);
  assert.deepEqual(Array.from(detail.entry.responseHeaders.redacted), ["set-cookie"]);
  assert.equal(detail.bodies.request.text, "request-body");
  assert.equal(detail.bodies.response.text, "response-body");

  const stopped = await cdp.networkStop(7, "client-a");
  assert.equal(stopped.active, false);
  assert.equal(stopped.cleared, 1);
  assert.ok(fake.commands.some((command) => command.method === "Network.disable"));
});

test("network capture is bounded and network idle is event-driven", async () => {
  const fake = fakeDebugger();
  const vmContext = loadScript("extension/lib/cdp.js", {
    chrome: fake.chrome,
    crypto: fake.crypto,
  });
  const cdp = vmContext.cdp;
  await cdp.networkStart(7, "client-a", true);
  for (let index = 1; index <= 501; index += 1) {
    fake.emit("Network.requestWillBeSent", {
      requestId: `request-${index}`,
      type: "XHR",
      request: { method: "GET", url: `https://example.test/${index}` },
    });
  }
  const listed = cdp.networkList(7, { limit: 1 });
  assert.equal(listed.total, 500);
  assert.equal(listed.dropped, 1);
  assert.equal(listed.entries[0].sequence, 501);
  assert.equal(listed.nextBeforeSequence, 501);
  for (let index = 1; index <= 501; index += 1) {
    fake.emit("Network.loadingFinished", { requestId: `request-${index}` });
  }

  fake.emit("Network.requestWillBeSent", {
    requestId: "pending",
    type: "Fetch",
    request: { method: "GET", url: "https://example.test/pending" },
  });
  const idle = cdp.waitForNetworkIdle(7, 1000);
  fake.emit("Network.loadingFinished", { requestId: "pending" });
  assert.equal(await idle, true);
  await cdp.networkStop(7, "client-a");
  fake.detach(7);
});

test("navigation waiters observe same-document navigation without a race", async () => {
  const fake = fakeDebugger();
  const vmContext = loadScript("extension/lib/cdp.js", {
    chrome: fake.chrome,
    crypto: fake.crypto,
  });
  const cdp = vmContext.cdp;
  await cdp.attach(7, "client-a");
  const before = cdp.navigationState(7);
  const navigation = cdp.waitForNavigation(7, before.total, 1000);
  fake.emit("Page.navigatedWithinDocument", { frameId: "frame-1", url: "https://example.test/#done" });
  assert.equal(await navigation, true);
  const after = cdp.navigationState(7);
  assert.equal(after.total, before.total + 1);
  assert.equal(after.sameDocument, before.sameDocument + 1);
  assert.equal(after.committed, before.committed);
  await cdp.detachAll();
});

test("action options normalize and produce additive state", () => {
  const vmContext = loadScript("extension/lib/action.js", {});
  const action = vmContext.browserMcpAction;
  assert.equal(action.normalizeOptions({}).requested, false);
  const options = action.normalizeOptions({
    waitFor: { selector: "#done", visible: true },
    settle: "both",
    snapshot: true,
    timeoutMs: 5000,
  });
  assert.equal(options.requested, true);
  assert.equal(options.timeoutMs, 5000);
  const state = action.stateResult({
    options,
    startedAt: Date.now() - 25,
    beforeNavigation: { total: 2, committed: 1, sameDocument: 1 },
    afterNavigation: { total: 3, committed: 2, sameDocument: 1 },
    page: { url: "https://example.test/done", title: "Done", documentState: "complete" },
    networkIdle: true,
  });
  assert.equal(state.phase, "settled");
  assert.equal(state.navigation, "committed");
  assert.equal(state.networkIdle, true);
  assert.deepEqual(Array.from(state.waited), ["selector:#done"]);
  assert.throws(() => action.normalizeOptions({ waitFor: {} }), /requires selector/);
});

test("page wait expression resolves immediately for a matching condition", async () => {
  const element = {
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
  };
  const document = {
    body: { innerText: "Done" },
    documentElement: {},
    readyState: "complete",
    title: "Fixture",
    querySelector: (selector) => (selector === "#done" ? element : null),
  };
  const window = {
    addEventListener() {},
    removeEventListener() {},
  };
  const vmContext = loadScript("extension/lib/page.js", {
    document,
    window,
    location: { href: "https://example.test/done" },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  const expression = vmContext.pageScripts.waitExpr({ selector: "#done", visible: true }, 1000);
  const result = await vm.runInContext(expression, vmContext);
  assert.equal(result.ok, true);
  assert.equal(result.documentState, "complete");
});

function fakeDownloads(downloadDir) {
  const listeners = { created: [], changed: [], erased: [] };
  const storage = {};
  const items = new Map();
  let nextNativeId = 41;
  const commands = [];
  const chrome = {
    runtime: { id: "browser-mcp-test-extension" },
    storage: {
      session: {
        get: async (defaults) => {
          const result = { ...defaults };
          for (const [key, value] of Object.entries(storage)) result[key] = value;
          return result;
        },
        set: async (values) => Object.assign(storage, values),
      },
    },
    downloads: {
      download: async (options) => {
        commands.push({ method: "download", options });
        const id = nextNativeId++;
        const item = {
          id,
          url: options.url,
          finalUrl: options.url,
          filename: path.join(path.dirname(downloadDir), options.filename),
          state: "in_progress",
          paused: false,
          canResume: true,
          danger: "safe",
          bytesReceived: 0,
          totalBytes: 100,
          fileSize: 0,
          startTime: new Date().toISOString(),
          byExtensionId: chrome.runtime.id,
        };
        items.set(id, item);
        for (const listener of listeners.created) listener(item);
        return id;
      },
      search: async (query) => {
        if (Number.isInteger(query.id)) {
          const item = items.get(query.id);
          return item ? [item] : [];
        }
        return [...items.values()].filter((item) => !query.url || item.url === query.url);
      },
      cancel: async (id) => {
        const item = items.get(id);
        if (item) {
          item.state = "interrupted";
          item.error = "USER_CANCELED";
        }
      },
      onCreated: { addListener: (listener) => listeners.created.push(listener) },
      onChanged: { addListener: (listener) => listeners.changed.push(listener) },
      onErased: { addListener: (listener) => listeners.erased.push(listener) },
    },
  };
  return { chrome, commands, items, storage };
}

test("download manager is idempotent, waits, exposes safe paths, and cancels", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "browser-mcp-download-test-"));
  const downloadDir = path.join(temporary, "browser-mcp");
  fs.mkdirSync(downloadDir);
  const fake = fakeDownloads(downloadDir);
  const vmContext = loadScript("extension/lib/downloads.js", { chrome: fake.chrome });
  const downloads = vmContext.browserMcpDownloads;

  const first = await downloads.start({
    url: "https://example.test/report.txt?token=download-secret",
    filename: "../report.txt",
    requestId: "download-request-1",
    downloadDir,
  });
  const repeated = await downloads.start({
    url: "https://example.test/report.txt?token=download-secret",
    filename: "../report.txt",
    requestId: "download-request-1",
    downloadDir,
  });
  assert.equal(first.downloadId, "download-request-1");
  assert.equal(repeated.downloadId, first.downloadId);
  assert.doesNotMatch(JSON.stringify(first), /download-secret/);
  assert.equal(fake.commands.filter((command) => command.method === "download").length, 1);
  assert.equal(fake.commands[0].options.filename, "browser-mcp/report.txt");

  const item = fake.items.get(41);
  item.state = "complete";
  item.bytesReceived = 100;
  item.endTime = new Date().toISOString();
  const completed = await downloads.status({ downloadId: first.downloadId, wait: true, timeoutMs: 1000, downloadDir });
  assert.equal(completed.state, "complete");
  assert.equal(completed.wait.outcome, "terminal");
  assert.equal(path.dirname(completed.path), downloadDir);

  const second = await downloads.start({
    url: "https://example.test/slow.bin",
    requestId: "download-request-2",
    downloadDir,
  });
  const cancelled = await downloads.cancel({ downloadId: second.downloadId, downloadDir });
  assert.equal(cancelled.state, "cancelled");

  const interrupted = await downloads.start({
    url: "https://example.test/failed.bin",
    requestId: "download-request-3",
    downloadDir,
  });
  const interruptedItem = fake.items.get(43);
  interruptedItem.state = "interrupted";
  interruptedItem.error = "NETWORK_FAILED";
  const unchanged = await downloads.cancel({ downloadId: interrupted.downloadId, downloadDir });
  assert.equal(unchanged.state, "interrupted");

  fs.rmSync(temporary, { recursive: true, force: true });
});

test("server download validation contains paths and URLs", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "browser-mcp-download-security-"));
  const downloadDir = prepareDownloadDir(path.join(temporary, "browser-mcp"));
  assert.ok(downloadDir);
  assert.equal(validateDownloadUrl("https://example.test/file"), "https://example.test/file");
  assert.throws(() => validateDownloadUrl("file:///C:/secret.txt"), /http: or https:/);
  assert.throws(() => validateDownloadFilename("../secret.txt"), /leaf name/);
  assert.equal(validateDownloadRequestId("download:retry-1"), "download:retry-1");
  assert.throws(() => validateDownloadRequestId("../bad"), /requestId/);

  const file = path.join(downloadDir, "safe.txt");
  fs.writeFileSync(file, "safe");
  const inside = sanitizeDownloadSnapshot({ state: "complete", path: file }, downloadDir);
  assert.equal(inside.file.name, "safe.txt");
  const outside = sanitizeDownloadSnapshot({ state: "complete", path: process.execPath }, downloadDir);
  assert.equal(outside.file, null);
  assert.equal(outside.path, undefined);
  assert.equal(outside.fileError, "outside_allowed_directory");

  fs.rmSync(temporary, { recursive: true, force: true });
});
