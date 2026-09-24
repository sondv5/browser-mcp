importScripts("lib/cdp.js", "lib/page.js", "lib/action.js", "lib/downloads.js");

const DEFAULTS = { port: 8787, token: "", autoConnect: true };
const PROTOCOL_VERSION = 1;
const PROBE_TIMEOUT_MS = 1500;
const FAST_RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
const QUIET_RETRY_DELAY_MS = 60000;

let socket = null;
let connectPromise = null;
let connectionGeneration = 0;
let reconnectTimer = null;
let pingTimer = null;
let failureCount = 0;
let nextAttemptAt = 0;
let manualStop = false;
let offscreenPromise = null;
let lastConnectedAt = 0;
let hubInfo = null;

let status = { state: "idle", connected: false, port: DEFAULTS.port, message: "Starting…" };

function setStatus(patch) {
  status = { ...status, ...patch };
}

async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function setBadge(connected) {
  try {
    await chrome.action.setBadgeText({ text: connected ? "ON" : "OFF" });
    await chrome.action.setBadgeBackgroundColor({ color: connected ? "#16a34a" : "#a1a1aa" });
  } catch {
    // badge is cosmetic
  }
}

async function fetchWithTimeout(url, timeoutMs, mode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const options = { cache: "no-store", signal: controller.signal };
    if (mode) options.mode = mode;
    return await fetch(url, options);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probe(config) {
  const query = config.token ? `?token=${encodeURIComponent(config.token)}` : "";
  const url = `http://127.0.0.1:${config.port}/health${query}`;

  const readable = await fetchWithTimeout(url, PROBE_TIMEOUT_MS);
  if (readable) {
    if (readable.status === 401 || readable.status === 403) {
      return { up: true, error: "hub rejected the token - check that popup and MCP server use the same token" };
    }
    if (readable.ok) {
      const body = await readable.json().catch(() => null);
      hubInfo = body && typeof body === "object" ? body : null;
    }
    return { up: true, error: null };
  }

  // Older hubs (or missing host permissions) answer without CORS headers, which
  // makes the readable fetch reject. An opaque request still resolves on any
  // HTTP response, so use it as a "is the port alive" fallback.
  const opaque = await fetchWithTimeout(url, PROBE_TIMEOUT_MS, "no-cors");
  return { up: opaque !== null, error: null };
}

function wasConnectedRecently() {
  return lastConnectedAt > 0 && Date.now() - lastConnectedAt < QUIET_RETRY_DELAY_MS;
}

function attemptConnect(force) {
  if (connectPromise) return connectPromise;
  connectPromise = attemptConnectInternal(force).finally(() => {
    connectPromise = null;
  });
  return connectPromise;
}

async function attemptConnectInternal(force) {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (!force && Date.now() < nextAttemptAt) return;

  const config = await getConfig();
  if (manualStop && !force) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  setStatus({ port: config.port });
  if (!config.autoConnect && !force) {
    setStatus({ state: "stopped", connected: false, message: "Auto-connect is off" });
    setBadge(false);
    return;
  }

  if (!force) {
    setStatus({ state: "connecting", connected: false, message: `Checking 127.0.0.1:${config.port}…` });
    const result = await probe(config);
    if (manualStop && !force) return;
    if (!result.up && !wasConnectedRecently()) {
      scheduleAfterFailure(config, `MCP server not running on port ${config.port}`);
      return;
    }
    if (result.error) {
      setStatus({ message: result.error });
    }
  }

  openSocket(config);
}

function openSocket(config) {
  setStatus({ state: "connecting", connected: false, message: `Connecting to 127.0.0.1:${config.port}…` });
  const query = config.token ? `?token=${encodeURIComponent(config.token)}` : "";
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}/extension${query}`);
  const generation = ++connectionGeneration;
  socket = ws;

  ws.onopen = () => {
    if (socket !== ws || generation !== connectionGeneration) {
      ws.close(1000, "stale connection");
      return;
    }
    failureCount = 0;
    nextAttemptAt = 0;
    lastConnectedAt = Date.now();
    chrome.storage.session.set({ lastConnectedAt }).catch(() => {});
    ws.send(
      JSON.stringify({
        kind: "hello",
        protocol: PROTOCOL_VERSION,
        role: "extension",
        extensionVersion: chrome.runtime.getManifest().version,
      }),
    );
    const role = hubInfo && hubInfo.role ? ` (hub ${hubInfo.role})` : "";
    setStatus({
      state: "connected",
      connected: true,
      message: `Connected on port ${config.port}${role}`,
      hubRole: hubInfo ? hubInfo.role : undefined,
    });
    setBadge(true);
    startPing();
  };

  ws.onmessage = (event) => {
    if (socket !== ws || generation !== connectionGeneration) return;
    handleMessage(ws, event.data);
  };

  ws.onclose = (event) => {
    if (socket !== ws || generation !== connectionGeneration) return;
    stopPing();
    socket = null;
    setBadge(false);
    primedEpochs.clear();
    cdp.detachAll();
    if (manualStop) {
      setStatus({ state: "stopped", connected: false, message: "Disconnected" });
      return;
    }
    scheduleAfterFailure(
      config,
      event.code === 1006 ? "Server went away" : `Disconnected (code ${event.code})`,
    );
  };

  ws.onerror = () => {
    // onclose always follows; nothing to do here.
  };
}

function scheduleAfterFailure(config, reason) {
  failureCount += 1;
  const fast = FAST_RETRY_DELAYS[Math.min(failureCount - 1, FAST_RETRY_DELAYS.length - 1)];
  const delay = failureCount <= FAST_RETRY_DELAYS.length ? fast : QUIET_RETRY_DELAY_MS;
  nextAttemptAt = Date.now() + delay;
  const seconds = Math.round(delay / 1000);
  setStatus({
    state: "retrying",
    connected: false,
    message: `${reason} - retrying in ${seconds}s`,
  });
  scheduleTimer(delay);
}

function scheduleTimer(delay) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    attemptConnect(false);
  }, delay);
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ kind: "ping" }));
    }
  }, 20000);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function disconnect() {
  manualStop = true;
  connectionGeneration += 1;
  stopPing();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const current = socket;
  socket = null;
  setBadge(false);
  setStatus({ state: "stopped", connected: false, message: "Disconnected" });
  if (current) {
    try {
      current.close(1000, "client disconnect");
    } catch {
      // already closed
    }
  }
}

async function handleMessage(ws, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message.kind === "ping") {
    ws.send(JSON.stringify({ kind: "pong" }));
    return;
  }
  if (message.kind !== "command") return;
  try {
    const result = await executeCommand(
      message.command,
      message.params || {},
      message.clientId || "unknown",
      Number(message.timeoutMs) || 30000,
    );
    ws.send(JSON.stringify({ kind: "reply", id: message.id, ok: true, result }));
  } catch (error) {
    const text = String((error && error.message) || error);
    ws.send(JSON.stringify({ kind: "reply", id: message.id, ok: false, error: { message: text } }));
  }
}

async function resolveTabId(tabId) {
  if (tabId !== undefined) {
    if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("tabId must be a positive integer");
    await chrome.tabs.get(tabId);
    return tabId;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id === undefined) throw new Error("no active tab found; pass tabId explicitly");
  return tab.id;
}

async function evalJson(tabId, expression, timeoutMs) {
  if (cdp.dialogs.has(tabId)) {
    throw new Error("a JavaScript dialog is blocking this tab - call browser_handle_dialog first");
  }
  const result = await cdp.send(
    tabId,
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
    timeoutMs,
  );
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(
      (details.exception && details.exception.description) || details.text || "page evaluation failed",
    );
  }
  return result.result ? result.result.value : undefined;
}

async function clickAt(tabId, x, y, button) {
  const mouseButton = button || "left";
  const buttons = mouseButton === "right" ? 2 : mouseButton === "middle" ? 4 : 1;
  await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: mouseButton,
    buttons,
    clickCount: 1,
  });
  await cdp.send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: mouseButton,
    buttons: 0,
    clickCount: 1,
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PRIME_ACTIVATION_MS = 220;
const primedEpochs = new Map(); // tabId -> document navigation count when primed

async function waitForPageCondition(tabId, criteria, deadline) {
  let navigationBaseline = cdp.navigationCount(tabId);
  while (Date.now() < deadline) {
    const remaining = Math.max(100, deadline - Date.now());
    try {
      const result = await evalJson(
        tabId,
        pageScripts.waitExpr(criteria, remaining),
        remaining + 1000,
      );
      if (result && result.ok) return result;
      if (result && result.error && /invalid selector|condition is required/.test(result.error)) {
        throw new Error(result.error);
      }
      throw new Error(`wait condition not met before timeout (${JSON.stringify(criteria)})`);
    } catch (error) {
      if (cdp.navigationCount(tabId) > navigationBaseline && Date.now() < deadline) {
        navigationBaseline = cdp.navigationCount(tabId);
        continue;
      }
      throw error;
    }
  }
  throw new Error("action-state wait timed out");
}

function remainingActionTime(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("action-state workflow timed out");
  return remaining;
}

async function runActionState(tabId, params, clientId, action, actionOptions = {}) {
  const options = browserMcpAction.normalizeOptions(params);
  if (!options.requested) return action();
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const beforeNavigation = cdp.navigationState(tabId);
  const usesNetwork = options.settle === "networkIdle" || options.settle === "both";
  const networkOwner = usesNetwork
    ? `action:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
    : null;
  if (networkOwner) await cdp.acquireNetwork(tabId, clientId, networkOwner);
  try {
    const result = await action();
    if (result && result.ok === false) return result;
    if (actionOptions.detectNavigation && cdp.navigationState(tabId).total === beforeNavigation.total) {
      try {
        await cdp.waitForNavigation(tabId, beforeNavigation.total, Math.min(150, remainingActionTime(deadline)));
      } catch (error) {
        if (!String(error && error.message || error).includes("navigation did not commit")) throw error;
      }
    }
    if (actionOptions.expectNavigation) {
      await cdp.waitForNavigation(tabId, beforeNavigation.total, remainingActionTime(deadline));
    }
    if (options.settle === "load" || options.settle === "both") {
      await waitForPageCondition(tabId, { load: true }, deadline);
    }
    if (usesNetwork) await cdp.waitForNetworkIdle(tabId, remainingActionTime(deadline), networkOwner);
    if (options.waitFor) await waitForPageCondition(tabId, options.waitFor, deadline);
    const page = await evalJson(
      tabId,
      "({ url: location.href, title: document.title, documentState: document.readyState })",
      remainingActionTime(deadline) + 1000,
    );
    const output = {
      ...(result && typeof result === "object" ? result : { value: result }),
      actionState: browserMcpAction.stateResult({
        options,
        startedAt,
        beforeNavigation,
        afterNavigation: cdp.navigationState(tabId),
        page,
        networkIdle: usesNetwork ? true : undefined,
      }),
    };
    if (options.snapshot) {
      output.snapshot = await commandsSnapshot(
        { tabId, timeoutMs: remainingActionTime(deadline) },
        clientId,
      );
    }
    return output;
  } finally {
    if (networkOwner) await cdp.releaseNetwork(tabId, networkOwner).catch(() => {});
  }
}

async function enableFocusEmulation(tabId) {
  await cdp.send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await cdp.send(tabId, "Page.setWebLifecycleState", { state: "active" }).catch(() => {});
}

// Counting probe: how many real input events reached the page since it was
// armed. The marker identifies the document, so a navigation (which replaces
// the document) is also recognised as "the input landed".
async function armInputProbe(tabId) {
  const result = await evalJson(
    tabId,
    `(() => {
      if (window.__mcpInputProbe && window.__mcpInputProbe.marker) {
        return { n: window.__mcpInputProbe.n, marker: window.__mcpInputProbe.marker };
      }
      const marker = Math.random().toString(36).slice(2);
      const state = { n: 0, marker };
      const bump = () => { state.n += 1; };
      for (const type of ["mousemove", "mousedown", "mouseup", "click", "keydown", "keypress", "wheel", "beforeinput", "input"]) {
        document.addEventListener(type, bump, true);
      }
      window.__mcpInputProbe = state;
      return { n: state.n, marker };
    })()`,
  );
  if (result && typeof result.n === "number") return result;
  return { n: 0, marker: null };
}

async function inputProbeState(tabId) {
  try {
    const state = await evalJson(
      tabId,
      "({ n: window.__mcpInputProbe ? window.__mcpInputProbe.n : 0, marker: window.__mcpInputProbe ? window.__mcpInputProbe.marker : null })",
    );
    return state && typeof state.n === "number" ? state : { n: 0, marker: null };
  } catch {
    return { n: 0, marker: null, unavailable: true };
  }
}

function inputLanded(before, after) {
  if (!after || after.unavailable) return false;
  if (after.marker !== before.marker) return true;
  return after.n > before.n;
}

async function activateBriefly(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.active) {
    if (!(await isWindowFocused(tab.windowId))) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    return;
  }
  const [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  await chrome.tabs.update(tabId, { active: true });
  await sleep(PRIME_ACTIVATION_MS);
  if (previous && previous.id !== undefined && previous.id !== tabId) {
    await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
  }
}

async function isWindowFocused(windowId) {
  try {
    const window = await chrome.windows.get(windowId);
    return window.focused === true;
  } catch {
    return false;
  }
}

// CDP input events only reach a renderer that Chrome considers focused/rendered.
// In order of preference:
//   1. the tab is active in the focused window - dispatch directly;
//   2. the tab is known-good for this document - dispatch directly;
//   3. silent path: focus emulation + a page-side probe to *verify* delivery;
//   4. fallback: borrow focus for ~220 ms, dispatch, verify again;
//   5. still nothing: fail loudly instead of pretending the action happened.
async function withTrustedInput(tabId, options, action) {
  const mode = (options && options.focus) || (options && options.keepFocus ? "keep" : "auto");

  if (mode === "keep") {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await sleep(150);
    }
    if (tab.windowId !== undefined && !(await isWindowFocused(tab.windowId))) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    return await action();
  }
  if (mode === "never") return await action();
  if (mode === "emulate") {
    await enableFocusEmulation(tabId);
    return await action();
  }

  const tab = await chrome.tabs.get(tabId);
  if (tab.active && (await isWindowFocused(tab.windowId))) return await action();
  if (primedEpochs.get(tabId) === cdp.navigationCount(tabId)) return await action();

  await enableFocusEmulation(tabId);
  const before = await armInputProbe(tabId);
  const navBefore = cdp.navigationCount(tabId);
  await action();
  await sleep(250);
  const state = await inputProbeState(tabId);
  if (cdp.navigationCount(tabId) > navBefore || inputLanded(before, state)) {
    primedEpochs.set(tabId, cdp.navigationCount(tabId));
    return;
  }

  await activateBriefly(tabId);
  const retryBefore = await armInputProbe(tabId);
  const retryNav = cdp.navigationCount(tabId);
  await action();
  await sleep(250);
  const retryState = await inputProbeState(tabId);
  if (cdp.navigationCount(tabId) > retryNav || inputLanded(retryBefore, retryState)) {
    primedEpochs.set(tabId, cdp.navigationCount(tabId));
    return;
  }

  throw new Error(
    `the browser did not deliver the input events (probe ${before.n} -> ${state ? state.n : "?"}, retry ${retryBefore.n} -> ${retryState ? retryState.n : "?"}) - the target window may be occluded or minimized. Bring it to the front, or retry with focus: "keep".`,
  );
}

const KEY_DEFS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32 },
};

const MODIFIERS = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };

function keyDefinition(key) {
  if (KEY_DEFS[key]) return KEY_DEFS[key];
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const isDigit = /[0-9]/.test(key);
    return {
      key,
      code: isDigit ? `Digit${key}` : `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      text: key,
    };
  }
  return { key, code: key, keyCode: 0 };
}

async function commandsList() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((tab) => ({
      tabId: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      active: tab.active,
      pinned: tab.pinned,
      groupId: tab.groupId,
      title: tab.title,
      url: tab.url,
    })),
  };
}

async function commandsNewTab(params) {
  const tab = await chrome.tabs.create({
    url: typeof params.url === "string" && params.url ? params.url : "about:blank",
    active: params.active === true,
  });
  return { tabId: tab.id, windowId: tab.windowId, active: tab.active, url: tab.url };
}

async function commandsNewWindow(params) {
  const createData = {
    url: typeof params.url === "string" && params.url ? params.url : "about:blank",
    focused: params.focused === true,
    type: "normal",
  };
  if (Number.isFinite(params.width)) createData.width = Math.round(params.width);
  if (Number.isFinite(params.height)) createData.height = Math.round(params.height);
  if (Number.isFinite(params.left)) createData.left = Math.round(params.left);
  if (Number.isFinite(params.top)) createData.top = Math.round(params.top);
  const window = await chrome.windows.create(createData);
  const tab = window.tabs && window.tabs[0];
  return {
    windowId: window.id,
    tabId: tab ? tab.id : undefined,
    focused: window.focused,
    url: tab ? tab.url : undefined,
  };
}

async function commandsWindowsList() {
  const windows = await chrome.windows.getAll({ populate: false });
  return {
    windows: windows.map((window) => ({
      windowId: window.id,
      focused: window.focused,
      state: window.state,
      type: window.type,
      left: window.left,
      top: window.top,
      width: window.width,
      height: window.height,
    })),
  };
}

async function commandsCdp(params, clientId) {
  if (!params.method) throw new Error("cdp requires a method, e.g. \"Page.captureScreenshot\"");
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  const result = await cdp.send(tabId, String(params.method), params.params || {});
  return { result: result === undefined ? null : result };
}

async function commandsCloseTab(params) {
  const tabId = await resolveTabId(params.tabId);
  primedEpochs.delete(tabId);
  await cdp.forget(tabId);
  await chrome.tabs.remove(tabId);
  return { ok: true, tabId };
}

async function commandsDetach(params) {
  if (params.tabId !== undefined) {
    if (!Number.isInteger(params.tabId) || params.tabId <= 0) throw new Error("tabId must be a positive integer");
    primedEpochs.delete(params.tabId);
    await cdp.detachTab(params.tabId);
    return { ok: true, detached: [params.tabId] };
  }
  primedEpochs.clear();
  await cdp.detachAll();
  return { ok: true, detached: "all" };
}

async function commandsDialog(params, clientId) {
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  const dialog = cdp.dialogs.get(tabId);
  if (!dialog) throw new Error("no JavaScript dialog is open on this tab");
  const accept = params.accept !== false;
  await cdp.send(tabId, "Page.handleJavaScriptDialog", {
    accept,
    promptText: typeof params.promptText === "string" ? params.promptText : undefined,
  });
  return { ok: true, handled: dialog.type, accepted: accept };
}

async function commandsHover(params, clientId) {
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  let { x, y } = params;
  if ((x === undefined || y === undefined) && params.ref) {
    const position = await evalJson(tabId, pageScripts.resolveExpr(params.ref));
    if (!position || !position.ok) throw new Error((position && position.error) || "could not resolve ref");
    x = position.x;
    y = position.y;
  }
  if (x === undefined || y === undefined) throw new Error("hover requires ref or x/y coordinates");
  await withTrustedInput(tabId, params, async () => {
    await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x) - 4, y: Math.round(y) - 4 });
    await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  });
  return { ok: true, x, y };
}

async function commandsSelect(params, clientId) {
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  if (!params.ref) throw new Error("select_option requires a ref to a <select> element");
  return runActionState(tabId, params, clientId, async () => {
    const result = await evalJson(
      tabId,
      pageScripts.selectExpr(params.ref, { value: params.value, label: params.label, index: params.index }),
    );
    if (!result || !result.ok) {
      const details = result && result.available ? ` (available: ${result.available.join("; ")})` : "";
      throw new Error(((result && result.error) || "could not select option") + details);
    }
    return result;
  });
}

async function commandsHistory(params, clientId, direction) {
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  return runActionState(tabId, params, clientId, async () => {
    const history = await cdp.send(tabId, "Page.getNavigationHistory");
    const targetIndex = direction === "back" ? history.currentIndex - 1 : history.currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= history.entries.length) {
      return { ok: false, message: direction === "back" ? "no previous history entry" : "no next history entry" };
    }
    const entry = history.entries[targetIndex];
    await cdp.send(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
    return { ok: true, url: entry.url, title: entry.title };
  }, { expectNavigation: true });
}

async function commandsReload(params, clientId) {
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  return runActionState(tabId, params, clientId, async () => {
    await cdp.send(tabId, "Page.reload", { ignoreCache: params.ignoreCache === true });
    return { ok: true, ignoreCache: params.ignoreCache === true };
  }, { expectNavigation: true });
}

async function elementObjectId(tabId, ref) {
  if (!ref) throw new Error("a ref is required");
  const result = await cdp.send(tabId, "Runtime.evaluate", {
    expression: pageScripts.objectExpr(ref),
    returnByValue: false,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error((details.exception && details.exception.description) || details.text || "could not resolve ref");
  }
  const objectId = result.result && result.result.objectId;
  if (!objectId) throw new Error("could not resolve ref - take a new browser_snapshot");
  return objectId;
}

async function commandsUpload(params, clientId) {
  if (!Array.isArray(params.files) || params.files.length === 0) {
    throw new Error("files must be a non-empty array of absolute paths");
  }
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  const objectId = await elementObjectId(tabId, params.ref);
  await cdp.send(tabId, "DOM.setFileInputFiles", { files: params.files, objectId });
  return { ok: true, files: params.files };
}

async function commandsScroll(params, clientId) {
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  if (params.ref) {
    const result = await evalJson(tabId, pageScripts.scrollToExpr(params.ref));
    if (!result || !result.ok) throw new Error((result && result.error) || "could not scroll to ref");
    return { ok: true, scrolledTo: params.ref };
  }
  const deltaY = Number(params.deltaY) || 600;
  const deltaX = Number(params.deltaX) || 0;
  const viewport = await evalJson(tabId, "({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) })");
  const positionBefore = await evalJson(tabId, "({ x: Math.round(scrollX), y: Math.round(scrollY) })");
  await withTrustedInput(tabId, params, () =>
    cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: viewport.x,
      y: viewport.y,
      deltaX,
      deltaY,
    }),
  );
  await sleep(120);
  const afterWheel = await evalJson(tabId, "({ x: Math.round(scrollX), y: Math.round(scrollY) })");
  if (afterWheel.x !== positionBefore.x || afterWheel.y !== positionBefore.y) {
    return { ok: true, deltaX, deltaY, method: "wheel" };
  }
  // Some pages ignore synthesised wheels; fall back to a direct scroll so the
  // agent still gets where it asked for.
  await evalJson(tabId, `(window.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: "instant" }), "ok")`);
  await sleep(80);
  const afterFallback = await evalJson(tabId, "({ x: Math.round(scrollX), y: Math.round(scrollY) })");
  const moved = afterFallback.x !== positionBefore.x || afterFallback.y !== positionBefore.y;
  return { ok: true, deltaX, deltaY, method: moved ? "scrollBy" : "none" };
}

async function commandsFind(params, clientId) {
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  const result = await evalJson(tabId, pageScripts.findExpr(params.query, params.maxResults));
  if (!result) throw new Error("find failed");
  if (!result.ok) throw new Error(result.error || "find failed");
  return result;
}

async function commandsActivateTab(params) {
  const tabId = await resolveTabId(params.tabId);
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  return { ok: true, tabId };
}

async function commandsSnapshot(params, clientId) {
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  const dialog = cdp.dialogs.get(tabId);
  if (dialog) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return {
      url: tab ? tab.url : "",
      title: tab ? tab.title : "",
      dialog: { type: dialog.type, message: dialog.message, defaultPrompt: dialog.defaultPrompt },
    };
  }
  const snapshot = await evalJson(
    tabId,
    pageScripts.snapshotExpr({ maxRefs: params.maxRefs }),
    params.timeoutMs,
  );
  if (!snapshot || typeof snapshot !== "object") throw new Error("snapshot failed");
  return snapshot;
}

async function commandsClick(params, clientId) {
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  let { x, y } = params;
  if ((x === undefined || y === undefined) && params.ref) {
    const position = await evalJson(tabId, pageScripts.resolveExpr(params.ref));
    if (!position || !position.ok) throw new Error((position && position.error) || "could not resolve ref");
    x = position.x;
    y = position.y;
  }
  if (x === undefined || y === undefined) throw new Error("click requires ref or x/y coordinates");
  return runActionState(tabId, params, clientId, async () => {
    await withTrustedInput(tabId, params, () => clickAt(tabId, x, y, params.button));
    return { ok: true, x, y };
  }, { detectNavigation: true });
}

async function commandsType(params, clientId) {
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  return runActionState(tabId, params, clientId, async () => {
    await withTrustedInput(tabId, params, async () => {
      if (params.ref) {
        const position = await evalJson(tabId, pageScripts.resolveExpr(params.ref));
        if (!position || !position.ok) throw new Error((position && position.error) || "could not resolve ref");
        await clickAt(tabId, position.x, position.y);
      }
      await cdp.send(tabId, "Input.insertText", { text: String(params.text) });
      if (params.submit) {
        await dispatchKey(tabId, "Enter", []);
      }
    });
    return { ok: true, length: String(params.text).length };
  }, { detectNavigation: true });
}

async function dispatchKey(tabId, key, modifiers) {
  const definition = keyDefinition(key);
  let modifierMask = 0;
  for (const modifier of modifiers || []) {
    modifierMask |= MODIFIERS[modifier] || 0;
  }
  const base = {
    modifiers: modifierMask,
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
  };
  await cdp.send(tabId, "Input.dispatchKeyEvent", {
    type: definition.text ? "keyDown" : "rawKeyDown",
    ...base,
    text: definition.text,
  });
  await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function commandsPressKey(params, clientId) {
  if (!params.key) throw new Error("key is required");
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  return runActionState(tabId, params, clientId, async () => {
    await withTrustedInput(tabId, params, () => dispatchKey(tabId, String(params.key), params.modifiers || []));
    return { ok: true, key: params.key, modifiers: params.modifiers || [] };
  }, { detectNavigation: true });
}

async function commandsNavigate(params, clientId) {
  if (!params.url) throw new Error("url is required");
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  return runActionState(tabId, params, clientId, async () => {
    const result = await cdp.send(tabId, "Page.navigate", { url: String(params.url) });
    return { ok: true, url: params.url, frameId: result.frameId };
  }, { expectNavigation: true });
}

async function commandsScreenshot(params, clientId) {
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  const tab = await chrome.tabs.get(tabId);
  let clip;
  if (params.ref) {
    // rectExpr scrolls the element into view first, so the clip region is always
    // inside the rendered surface. captureBeyondViewport must stay off: on a
    // background tab it blocks the renderer waiting for a frame that never comes.
    const rect = await evalJson(tabId, pageScripts.rectExpr(params.ref));
    if (!rect || !rect.ok) throw new Error((rect && rect.error) || "could not resolve ref");
    clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
  } else if (params.fullPage) {
    if (!tab.active) {
      throw new Error(
        "full-page screenshots need a visible tab - call browser_tab_activate first, or capture the viewport or a single element by ref",
      );
    }
  }
  const result = await cdp.send(
    tabId,
    "Page.captureScreenshot",
    clip
      ? { format: "png", clip }
      : params.fullPage
        ? { format: "png", captureBeyondViewport: true }
        : { format: "png" },
  );
  let width;
  let height;
  if (clip) {
    width = clip.width;
    height = clip.height;
  } else if (params.fullPage) {
    const metrics = await cdp.send(tabId, "Page.getLayoutMetrics");
    const size = metrics.cssContentSize || metrics.contentSize || {};
    width = size.width ? Math.ceil(size.width) : undefined;
    height = size.height ? Math.ceil(size.height) : undefined;
  } else {
    const layout = await cdp.send(tabId, "Page.getLayoutMetrics").catch(() => null);
    const viewport = layout && (layout.cssVisualViewport || layout.visualViewport);
    width = viewport ? Math.ceil(viewport.clientWidth) : undefined;
    height = viewport ? Math.ceil(viewport.clientHeight) : undefined;
  }
  return { data: result.data, width, height };
}

async function commandsGetText(params, clientId) {
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  if (params.ref) {
    const result = await evalJson(tabId, pageScripts.textExpr(params.ref));
    if (!result || !result.ok) throw new Error((result && result.error) || "could not resolve ref");
    return { text: result.text };
  }
  const text = await evalJson(tabId, "((document.body && document.body.innerText) || '').slice(0, 20000)");
  return { text: text || "" };
}

async function commandsEvaluate(params, clientId) {
  if (!params.expression) throw new Error("expression is required");
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  const value = await evalJson(tabId, String(params.expression));
  return { value: value === undefined ? null : value };
}

async function commandsWaitFor(params, clientId) {
  const tabId = await resolveTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  const timeoutMs = Math.min(300000, Math.max(100, Number(params.timeoutMs) || 10000));
  const criteria = {
    text: typeof params.text === "string" ? params.text : undefined,
    selector: typeof params.selector === "string" ? params.selector : undefined,
    url: typeof params.url === "string" ? params.url : undefined,
    visible: params.visible === true,
    load: params.load === true,
  };
  const hasPageCondition =
    typeof criteria.text === "string" ||
    typeof criteria.selector === "string" ||
    typeof criteria.url === "string" ||
    criteria.load;
  if (!hasPageCondition && params.networkIdle !== true) {
    throw new Error("wait_for requires text, selector, url, load, or networkIdle");
  }
  const deadline = Date.now() + timeoutMs;
  const networkOwner = params.networkIdle === true
    ? `wait:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
    : null;
  if (networkOwner) await cdp.acquireNetwork(tabId, clientId, networkOwner);
  try {
    let page;
    if (hasPageCondition) page = await waitForPageCondition(tabId, criteria, deadline);
    if (networkOwner) {
      await cdp.waitForNetworkIdle(tabId, remainingActionTime(deadline), networkOwner);
    }
    return { found: true, ...(page || {}) };
  } finally {
    if (networkOwner) await cdp.releaseNetwork(tabId, networkOwner).catch(() => {});
  }
}

async function commandsConsole(params) {
  const tabId = await resolveTabId(params.tabId);
  return { entries: cdp.consoleBuffers.get(tabId) || [] };
}

async function commandsDownloadStart(params) {
  return browserMcpDownloads.start(params);
}

async function commandsDownloadList(params) {
  return browserMcpDownloads.list(params);
}

async function commandsDownloadStatus(params) {
  return browserMcpDownloads.status(params);
}

async function commandsDownloadCancel(params) {
  return browserMcpDownloads.cancel(params);
}

function requireNetworkTabId(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("network tools require an explicit positive tabId");
  return tabId;
}

async function commandsNetworkStart(params, clientId) {
  const tabId = requireNetworkTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  return cdp.networkStart(tabId, clientId, params.clear !== false);
}

async function commandsNetworkList(params, clientId) {
  const tabId = requireNetworkTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  return cdp.networkList(tabId, params);
}

async function commandsNetworkGet(params, clientId) {
  const tabId = requireNetworkTabId(params.tabId);
  await cdp.attach(tabId, clientId);
  return cdp.networkGet(tabId, params);
}

async function commandsNetworkStop(params, clientId) {
  const tabId = requireNetworkTabId(params.tabId);
  return cdp.networkStop(tabId, clientId);
}

async function executeCommand(command, params, clientId, timeoutMs) {
  switch (command) {
    case "tabs_list":
      return commandsList();
    case "tab_new":
      return commandsNewTab(params);
    case "window_new":
      return commandsNewWindow(params);
    case "windows_list":
      return commandsWindowsList();
    case "cdp":
      return commandsCdp(params, clientId);
    case "tab_close":
      return commandsCloseTab(params);
    case "detach":
      return commandsDetach(params);
    case "dialog":
      return commandsDialog(params, clientId);
    case "hover":
      return commandsHover(params, clientId);
    case "select":
      return commandsSelect(params, clientId);
    case "back":
      return commandsHistory(params, clientId, "back");
    case "forward":
      return commandsHistory(params, clientId, "forward");
    case "reload":
      return commandsReload(params, clientId);
    case "upload":
      return commandsUpload(params, clientId);
    case "scroll":
      return commandsScroll(params, clientId);
    case "find":
      return commandsFind(params, clientId);
    case "tab_activate":
      return commandsActivateTab(params);
    case "snapshot":
      return commandsSnapshot(params, clientId);
    case "click":
      return commandsClick(params, clientId);
    case "type":
      return commandsType(params, clientId);
    case "press_key":
      return commandsPressKey(params, clientId);
    case "navigate":
      return commandsNavigate(params, clientId);
    case "screenshot":
      return commandsScreenshot(params, clientId);
    case "get_text":
      return commandsGetText(params, clientId);
    case "evaluate":
      return commandsEvaluate(params, clientId);
    case "wait_for":
      return commandsWaitFor(params, clientId);
    case "console_logs":
      return commandsConsole(params);
    case "download_start":
      return commandsDownloadStart(params);
    case "download_list":
      return commandsDownloadList(params);
    case "download_status":
      return commandsDownloadStatus(params);
    case "download_cancel":
      return commandsDownloadCancel(params);
    case "network_start":
      return commandsNetworkStart(params, clientId);
    case "network_list":
      return commandsNetworkList(params, clientId);
    case "network_get":
      return commandsNetworkGet(params, clientId);
    case "network_stop":
      return commandsNetworkStop(params, clientId);
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen();
  attemptConnect(false);
});
chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreen();
  attemptConnect(false);
});
chrome.alarms.create("browser-mcp-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "browser-mcp-keepalive") attemptConnect(false);
});

// The offscreen document holds a runtime port and pings it every 20 s, which
// keeps this service worker (and therefore the WebSocket) alive indefinitely.
function ensureOffscreen() {
  if (offscreenPromise) return offscreenPromise;
  offscreenPromise = (async () => {
    if (!chrome.offscreen || !chrome.runtime.getContexts) return;
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL("offscreen.html")],
    });
    if (contexts.length > 0) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Keep the MCP bridge connection to the local hub alive.",
    });
  })()
    .catch(() => {})
    .finally(() => {
      offscreenPromise = null;
    });
  return offscreenPromise;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "browser-mcp-keepalive") return;
  port.onMessage.addListener(() => {
    // Message traffic from the offscreen document resets the worker idle timer.
  });
  port.onDisconnect.addListener(() => {
    // The offscreen document reconnects on its own.
  });
});

self.addEventListener("error", (event) => {
  console.error("[browser-mcp] uncaught error:", event.message);
});
self.addEventListener("unhandledrejection", (event) => {
  console.error("[browser-mcp] unhandled rejection:", event.reason);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if (message.type === "status") {
    sendResponse(status);
    return false;
  }
  if (message.type === "connect") {
    manualStop = false;
    failureCount = 0;
    nextAttemptAt = 0;
    attemptConnect(true);
    sendResponse(status);
    return false;
  }
  if (message.type === "disconnect") {
    disconnect();
    sendResponse(status);
    return false;
  }
  if (message.type === "apply") {
    const config = {
      port: Number(message.config && message.config.port) || DEFAULTS.port,
      token: String((message.config && message.config.token) || ""),
      autoConnect: !(message.config && message.config.autoConnect === false),
    };
    chrome.storage.local
      .set(config)
      .then(() => {
        failureCount = 0;
        nextAttemptAt = 0;
        manualStop = false;
        if (config.autoConnect) {
          attemptConnect(true);
        } else {
          disconnect();
        }
        sendResponse(status);
      })
      .catch(() => sendResponse(status));
    return true;
  }
  return false;
});

ensureOffscreen();

chrome.storage.session
  .get({ lastConnectedAt: 0 })
  .then((stored) => {
    lastConnectedAt = Number(stored.lastConnectedAt) || 0;
  })
  .catch(() => {})
  .finally(() => attemptConnect(false));
