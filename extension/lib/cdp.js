// CDP helpers: attach one chrome.debugger session per tab, shared by every
// MCP client through refcounting, plus a small per-tab console buffer.
globalThis.cdp = (() => {
  const attached = new Map();
  const consoleBuffers = new Map();
  const dialogs = new Map();
  const navigationCounts = new Map();
  const committedNavigationCounts = new Map();
  const sameDocumentNavigationCounts = new Map();
  const networkStates = new Map();
  const attaching = new Map();
  const MAX_CONSOLE_ENTRIES = 300;
  const MAX_NETWORK_ENTRIES = 500;
  const MAX_NETWORK_BODY_LENGTH = 32768;
  const REQUEST_HEADER_ALLOWLIST = new Set([
    "accept",
    "accept-encoding",
    "accept-language",
    "cache-control",
    "content-length",
    "content-type",
    "origin",
    "pragma",
    "range",
    "referer",
    "user-agent",
  ]);
  const RESPONSE_HEADER_ALLOWLIST = new Set([
    "access-control-allow-credentials",
    "access-control-allow-origin",
    "access-control-expose-headers",
    "access-control-request-headers",
    "access-control-request-method",
    "accept-ranges",
    "age",
    "cache-control",
    "content-encoding",
    "content-length",
    "content-range",
    "content-type",
    "date",
    "expires",
    "last-modified",
    "location",
    "pragma",
    "timing-allow-origins",
    "vary",
  ]);
  const SENSITIVE_QUERY_KEY =
    /^(access[_-]?token|assertion|auth|authorization|api[_-]?key|client[_-]?secret|code|credential|id[_-]?token|jwt|key|oauth[_-]?token|password|passwd|refresh[_-]?token|secret|session(?:[_-]?(?:id|token))?|sig|signature|state|token|x-amz-(?:credential|security-token|signature)|x-goog-signature)$/i;

  function argText(arg) {
    if (!arg) return "";
    if (arg.value !== undefined) {
      return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
    }
    if (arg.description) return arg.description;
    return arg.type || "";
  }

  function record(tabId, entry) {
    const buffer = consoleBuffers.get(tabId) || [];
    buffer.push(entry);
    if (buffer.length > MAX_CONSOLE_ENTRIES) buffer.splice(0, buffer.length - MAX_CONSOLE_ENTRIES);
    consoleBuffers.set(tabId, buffer);
  }

  function randomId() {
    return globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function cleanText(value, limit) {
    return String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, limit);
  }

  function sanitizeUrl(value) {
    const raw = cleanText(value, 16384);
    if (!raw) return "";
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return "[invalid-url]";
    }
    if (parsed.protocol === "data:" || parsed.protocol === "blob:" || parsed.protocol === "file:") {
      return `${parsed.protocol}__REDACTED__`;
    }
    parsed.username = "";
    parsed.password = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.set(key, "__REDACTED__");
    }
    if (parsed.hash) parsed.hash = "__REDACTED_HASH__";
    const normalized = parsed.toString();
    return normalized.length > 2048 ? `${parsed.origin}/__TRUNCATED__` : normalized;
  }

  function sanitizeHeaders(headers, response) {
    const allowlist = response ? RESPONSE_HEADER_ALLOWLIST : REQUEST_HEADER_ALLOWLIST;
    const values = {};
    const redacted = [];
    let truncated = false;
    let totalLength = 0;
    for (const [name, rawValue] of Object.entries(headers && typeof headers === "object" ? headers : {})) {
      const lower = name.toLowerCase();
      if (!allowlist.has(lower) && !lower.startsWith("sec-fetch-")) {
        redacted.push(lower);
        continue;
      }
      const rawLength = String(rawValue ?? "").length;
      const value = lower === "location" || lower === "referer" ? sanitizeUrl(rawValue) : cleanText(rawValue, 1024);
      if (rawLength > 1024 || totalLength + value.length > 4096) {
        truncated = true;
        continue;
      }
      values[lower] = value;
      totalLength += value.length;
    }
    const sorted = {};
    for (const name of Object.keys(values).sort()) sorted[name] = values[name];
    redacted.sort();
    return { values: sorted, redacted, truncated };
  }

  function publicNetworkEntry(entry, detail = false) {
    const result = {
      entryId: entry.entryId,
      sequence: entry.sequence,
      startedAt: entry.startedAt,
      lastEventAt: entry.lastEventAt,
      durationMs: entry.durationMs,
      state: entry.state,
      resourceType: entry.resourceType,
      method: entry.method,
      url: entry.url,
      frameId: entry.frameId,
      isNavigation: entry.isNavigation,
      hasPostData: entry.hasPostData,
      postDataBytes: entry.postDataBytes,
      response: entry.response,
      redirect: entry.redirect,
      failure: entry.failure,
      initiator: entry.initiator,
    };
    if (detail) {
      result.requestHeaders = entry.requestHeaders;
      result.responseHeaders = entry.responseHeaders;
    }
    return result;
  }

  function networkStatus(tabId, state, extra = {}) {
    return {
      tabId,
      active: Boolean(state),
      captureId: state ? state.captureId : null,
      startedAt: state ? state.startedAt : null,
      lastEventAt: state ? state.lastEventAt : null,
      total: state ? state.entries.length : 0,
      dropped: state ? state.dropped : 0,
      ...extra,
    };
  }

  function createNetworkState() {
    return {
      captureId: randomId(),
      ownerId: `capture:${randomId()}`,
      startedAt: Date.now(),
      lastEventAt: null,
      dropped: 0,
      sequence: 0,
      entries: [],
      byEntryId: new Map(),
      currentByCdpRequestId: new Map(),
    };
  }

  function appendNetworkEntry(tabId, state, params) {
    state.sequence += 1;
    const now = Date.now();
    const request = params.request && typeof params.request === "object" ? params.request : {};
    const hasPostData = typeof request.postData === "string" && request.postData.length > 0;
    const entry = {
      entryId: `${state.captureId}:${state.sequence}`,
      sequence: state.sequence,
      cdpRequestId: String(params.requestId || ""),
      startedAt: now,
      lastEventAt: now,
      durationMs: undefined,
      state: "pending",
      resourceType: String(params.type || "Other"),
      method: cleanText(request.method || "GET", 32).toUpperCase(),
      url: sanitizeUrl(request.url),
      frameId: params.frameId ? String(params.frameId) : undefined,
      isNavigation: params.type === "Document",
      hasPostData,
      postDataBytes: hasPostData ? request.postData.length : undefined,
      requestHeaders: sanitizeHeaders(request.headers, false),
      responseHeaders: undefined,
      response: undefined,
      redirect: undefined,
      failure: undefined,
      initiator: params.initiator && typeof params.initiator === "object"
        ? {
            type: cleanText(params.initiator.type || "other", 64),
            url: params.initiator.url ? sanitizeUrl(params.initiator.url) : undefined,
          }
        : undefined,
    };
    state.entries.push(entry);
    state.byEntryId.set(entry.entryId, entry);
    state.currentByCdpRequestId.set(entry.cdpRequestId, entry);
    while (state.entries.length > MAX_NETWORK_ENTRIES) {
      const removed = state.entries.shift();
      state.byEntryId.delete(removed.entryId);
      if (state.currentByCdpRequestId.get(removed.cdpRequestId) === removed) {
        state.currentByCdpRequestId.delete(removed.cdpRequestId);
      }
      state.dropped += 1;
    }
    state.lastEventAt = now;
    return entry;
  }

  function clearNetworkState(tabId) {
    const state = networkStates.get(tabId);
    networkStates.delete(tabId);
    return state;
  }

  function clearNavigationState(tabId) {
    navigationCounts.delete(tabId);
    committedNavigationCounts.delete(tabId);
    sameDocumentNavigationCounts.delete(tabId);
  }

  function rejectNetworkWaiters(entry, reason, ownerId) {
    for (const waiter of entry.networkWaiters) {
      if (ownerId && waiter.ownerId !== ownerId) continue;
      clearTimeout(waiter.timer);
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(reason));
      entry.networkWaiters.delete(waiter);
    }
    if (!ownerId) entry.networkWaiters.clear();
  }

  function refreshNetworkWaiters(entry) {
    for (const waiter of entry.networkWaiters) clearTimeout(waiter.timer);
    if (entry.inflight.size > 0) return;
    for (const waiter of entry.networkWaiters) {
      waiter.timer = setTimeout(() => {
        clearTimeout(waiter.timeout);
        entry.networkWaiters.delete(waiter);
        waiter.resolve(true);
      }, 100);
    }
  }

  async function attach(tabId, clientId) {
    const existing = attached.get(tabId);
    if (existing) {
      existing.clients.add(clientId);
      return tabId;
    }
    let pending = attaching.get(tabId);
    if (!pending) {
      pending = (async () => {
        try {
          await chrome.debugger.attach({ tabId }, "1.3");
        } catch (error) {
          const message = String((error && error.message) || error);
          if (/already attached/i.test(message)) {
            throw new Error(
              `Cannot attach to tab ${tabId}: another debugger (DevTools?) is attached. Close DevTools for that tab and retry.`,
            );
          }
          throw new Error(`Cannot attach to tab ${tabId}: ${message}`);
        }
        const entry = {
          clients: new Set(),
          networkEnabled: false,
          networkUsers: new Set(),
          inflight: new Set(),
          networkWaiters: new Set(),
          navigationWaiters: new Set(),
          networkQueue: Promise.resolve(),
        };
        try {
          await chrome.debugger.sendCommand({ tabId }, "Page.enable");
          await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
          await chrome.debugger.sendCommand({ tabId }, "Log.enable").catch(() => {});
        } catch (error) {
          await chrome.debugger.detach({ tabId }).catch(() => {});
          throw error;
        }
        attached.set(tabId, entry);
        return entry;
      })();
      attaching.set(tabId, pending);
    }
    try {
      const entry = await pending;
      entry.clients.add(clientId);
      return tabId;
    } finally {
      if (attaching.get(tabId) === pending) attaching.delete(tabId);
    }
  }

  function withNetworkLock(tabId, operation) {
    const entry = attached.get(tabId);
    if (!entry) return Promise.reject(new Error("debugger is not attached to this tab"));
    const result = entry.networkQueue.then(operation, operation);
    entry.networkQueue = result.catch(() => {});
    return result;
  }

  async function enableNetworkEntry(tabId, entry) {
    if (entry.networkEnabled) return entry;
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
      maxTotalBufferSize: 2 * 1024 * 1024,
      maxResourceBufferSize: 128 * 1024,
      maxPostDataSize: 32 * 1024,
    });
    entry.networkEnabled = true;
    return entry;
  }

  async function enableNetwork(tabId, clientId) {
    await attach(tabId, clientId);
    return withNetworkLock(tabId, () => enableNetworkEntry(tabId, attached.get(tabId)));
  }

  async function acquireNetwork(tabId, clientId, ownerId) {
    await enableNetwork(tabId, clientId);
    return withNetworkLock(tabId, () => {
      attached.get(tabId).networkUsers.add(ownerId);
    });
  }

  async function releaseNetwork(tabId, ownerId) {
    return withNetworkLock(tabId, async () => {
      const entry = attached.get(tabId);
      if (!entry) return;
      entry.networkUsers.delete(ownerId);
      if (!networkStates.has(tabId) && entry.networkUsers.size === 0 && entry.networkEnabled) {
        entry.networkEnabled = false;
        entry.inflight.clear();
        await chrome.debugger.sendCommand({ tabId }, "Network.disable").catch(() => {});
      }
    });
  }

  function send(tabId, method, params = {}, timeoutMs = 25000) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    const command = Promise.resolve().then(() =>
      chrome.debugger.sendCommand({ tabId }, method, params),
    );
    return Promise.race([command, timeout]).finally(() => clearTimeout(timer));
  }

  async function networkStart(tabId, clientId, clear = true) {
    await attach(tabId, clientId);
    return withNetworkLock(tabId, async () => {
      const entry = attached.get(tabId);
      await enableNetworkEntry(tabId, entry);
      const existing = networkStates.get(tabId);
      if (existing && !clear) {
        entry.networkUsers.add(existing.ownerId);
        return networkStatus(tabId, existing, { alreadyActive: true, cleared: 0 });
      }
      const cleared = existing ? existing.entries.length : 0;
      if (existing) {
        entry.networkUsers.delete(existing.ownerId);
        rejectNetworkWaiters(entry, "network capture restarted", existing.ownerId);
        if (entry.networkUsers.size === 0) entry.inflight.clear();
      }
      const state = createNetworkState();
      entry.networkUsers.add(state.ownerId);
      networkStates.set(tabId, state);
      return networkStatus(tabId, state, { alreadyActive: false, cleared });
    });
  }

  function networkList(tabId, params = {}) {
    const state = networkStates.get(tabId);
    if (!state) return networkStatus(tabId, null, { matched: 0, returned: 0, nextBeforeSequence: null, entries: [] });
    const limit = Math.min(200, Math.max(1, Number(params.limit) || 100));
    const beforeSequence = Number(params.beforeSequence);
    const urlContains = typeof params.urlContains === "string" ? params.urlContains.toLowerCase() : "";
    const method = typeof params.method === "string" ? params.method.toUpperCase() : "";
    const matches = state.entries
      .filter((entry) => Number.isInteger(beforeSequence) && beforeSequence > 0 ? entry.sequence < beforeSequence : true)
      .filter((entry) => !urlContains || entry.url.toLowerCase().includes(urlContains))
      .filter((entry) => !method || entry.method === method)
      .filter((entry) => !params.resourceType || entry.resourceType === params.resourceType)
      .filter((entry) => !params.state || entry.state === params.state)
      .sort((left, right) => right.sequence - left.sequence);
    const returned = matches.slice(0, limit);
    return networkStatus(tabId, state, {
      matched: matches.length,
      returned: returned.length,
      nextBeforeSequence: returned.length ? returned[returned.length - 1].sequence : null,
      entries: returned.map((entry) => publicNetworkEntry(entry)),
    });
  }

  function limitedBody(body) {
    if (!body || typeof body.body !== "string" || body.base64Encoded) return null;
    const text = body.body;
    return {
      text: text.slice(0, MAX_NETWORK_BODY_LENGTH),
      truncated: text.length > MAX_NETWORK_BODY_LENGTH,
    };
  }

  function limitedPostData(body) {
    if (!body || typeof body.postData !== "string") return null;
    const text = body.postData;
    return {
      text: text.slice(0, MAX_NETWORK_BODY_LENGTH),
      truncated: text.length > MAX_NETWORK_BODY_LENGTH,
    };
  }

  async function networkGet(tabId, params) {
    const state = networkStates.get(tabId);
    if (!state) throw new Error("network capture is not active for this tab; call browser_network_start first");
    const entry = state.byEntryId.get(String(params.entryId || ""));
    if (!entry) throw new Error("network entry is unavailable; it was cleared, evicted, detached, or the extension restarted");
    const result = {
      tabId,
      captureId: state.captureId,
      entry: publicNetworkEntry(entry, true),
    };
    if (params.includeBody === true) {
      result.bodies = {};
      if (entry.hasPostData && Number(entry.postDataBytes) > MAX_NETWORK_BODY_LENGTH) {
        result.bodies.request = { status: "unavailable", reason: "body-too-large" };
      } else if (entry.hasPostData) {
        try {
          const body = limitedPostData(
            await send(tabId, "Network.getRequestPostData", { requestId: entry.cdpRequestId }, 5000),
          );
          result.bodies.request = body
            ? { status: "available", ...body }
            : { status: "unavailable", reason: "cdp-unavailable" };
        } catch {
          result.bodies.request = { status: "unavailable", reason: "cdp-unavailable" };
        }
      } else {
        result.bodies.request = { status: "unavailable", reason: "no-post-data" };
      }
      const responseLength = Number(entry.responseHeaders?.values?.["content-length"]);
      if (entry.state === "success" && !entry.redirect && responseLength > MAX_NETWORK_BODY_LENGTH) {
        result.bodies.response = { status: "unavailable", reason: "body-too-large" };
      } else if (entry.state === "success" && !entry.redirect) {
        try {
          const body = limitedBody(await send(tabId, "Network.getResponseBody", { requestId: entry.cdpRequestId }, 5000));
          result.bodies.response = body
            ? { status: "available", ...body }
            : { status: "unavailable", reason: "cdp-unavailable" };
        } catch {
          result.bodies.response = { status: "unavailable", reason: "cdp-unavailable" };
        }
      } else {
        result.bodies.response = { status: "unavailable", reason: entry.redirect ? "redirected" : "not-finished" };
      }
    }
    if (networkStates.get(tabId) !== state) {
      throw new Error("network capture changed while retrieving this request");
    }
    return result;
  }

  async function networkStop(tabId, clientId) {
    await attach(tabId, clientId);
    return withNetworkLock(tabId, async () => {
      const existing = networkStates.get(tabId);
      clearNetworkState(tabId);
      const entry = attached.get(tabId);
      if (entry) {
        if (existing) {
          entry.networkUsers.delete(existing.ownerId);
          rejectNetworkWaiters(entry, "network capture stopped", existing.ownerId);
        }
        if (entry.networkUsers.size === 0 && entry.networkEnabled) {
          entry.networkEnabled = false;
          entry.inflight.clear();
          await chrome.debugger.sendCommand({ tabId }, "Network.disable").catch(() => {});
        }
      }
      return networkStatus(tabId, null, { cleared: existing ? existing.entries.length : 0 });
    });
  }

  function waitForNetworkIdle(tabId, timeoutMs, ownerId) {
    const entry = attached.get(tabId);
    if (!entry) return Promise.reject(new Error("debugger is not attached to this tab"));
    return new Promise((resolve, reject) => {
      const waiter = { timer: null, timeout: null, ownerId, resolve, reject };
      waiter.timeout = setTimeout(() => {
        clearTimeout(waiter.timer);
        entry.networkWaiters.delete(waiter);
        reject(new Error(`network idle timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      entry.networkWaiters.add(waiter);
      refreshNetworkWaiters(entry);
    });
  }

  function waitForNavigation(tabId, afterCount, timeoutMs) {
    const entry = attached.get(tabId);
    if (!entry) return Promise.reject(new Error("debugger is not attached to this tab"));
    if (cdpNavigationCount(tabId) > afterCount) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const waiter = { timeout: null, resolve, reject };
      entry.navigationWaiters.add(waiter);
      if (cdpNavigationCount(tabId) > afterCount) {
        entry.navigationWaiters.delete(waiter);
        resolve(true);
        return;
      }
      waiter.timeout = setTimeout(() => {
        entry.navigationWaiters.delete(waiter);
        reject(new Error(`navigation did not commit after ${timeoutMs} ms`));
      }, timeoutMs);
    });
  }

  function cdpNavigationCount(tabId) {
    return navigationCounts.get(tabId) || 0;
  }

  function navigationState(tabId) {
    return {
      total: cdpNavigationCount(tabId),
      committed: committedNavigationCounts.get(tabId) || 0,
      sameDocument: sameDocumentNavigationCounts.get(tabId) || 0,
    };
  }

  function resolveNavigationWaiters(tabId) {
    const entry = attached.get(tabId);
    if (!entry) return;
    for (const waiter of entry.navigationWaiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(true);
    }
    entry.navigationWaiters.clear();
  }

  function rejectNavigationWaiters(entry, reason) {
    for (const waiter of entry.navigationWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(reason));
    }
    entry.navigationWaiters.clear();
  }

  async function detachClient(clientId) {
    for (const [tabId, entry] of attached) {
      entry.clients.delete(clientId);
      if (entry.clients.size === 0) {
        rejectNetworkWaiters(entry, "debugger detached");
        rejectNavigationWaiters(entry, "debugger detached");
        attached.delete(tabId);
        clearNetworkState(tabId);
        await chrome.debugger.detach({ tabId }).catch(() => {});
      }
    }
  }

  async function forget(tabId) {
    const entry = attached.get(tabId);
    if (entry) {
      rejectNetworkWaiters(entry, "tab closed or detached");
      rejectNavigationWaiters(entry, "tab closed or detached");
    }
    attached.delete(tabId);
    consoleBuffers.delete(tabId);
    dialogs.delete(tabId);
    clearNavigationState(tabId);
    clearNetworkState(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  async function detachAll() {
    for (const [tabId, entry] of attached) {
      rejectNetworkWaiters(entry, "extension disconnected");
      rejectNavigationWaiters(entry, "extension disconnected");
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
    attached.clear();
    consoleBuffers.clear();
    dialogs.clear();
    navigationCounts.clear();
    committedNavigationCounts.clear();
    sameDocumentNavigationCounts.clear();
    networkStates.clear();
  }

  function handleNetworkEvent(tabId, method, params) {
    const entry = attached.get(tabId);
    if (!entry || !entry.networkEnabled) return;
    const state = networkStates.get(tabId);
    if (method === "Network.requestWillBeSent") {
      const requestId = String(params.requestId || "");
      if (params.redirectResponse && state) {
        const previous = state.currentByCdpRequestId.get(requestId);
        if (previous) {
          previous.state = "redirected";
          previous.lastEventAt = Date.now();
          previous.durationMs = previous.lastEventAt - previous.startedAt;
          previous.redirect = {
            statusCode: Number(params.redirectResponse.status || 0),
            location: params.redirectResponse.headers
              ? sanitizeUrl(params.redirectResponse.headers.location || params.redirectResponse.headers.Location)
              : undefined,
          };
        }
      }
      if (
        !params.redirectResponse &&
        !["EventSource", "WebSocket"].includes(String(params.type || ""))
      ) {
        entry.inflight.add(requestId);
      }
      if (state) appendNetworkEntry(tabId, state, params);
      refreshNetworkWaiters(entry);
      return;
    }
    if (method === "Network.responseReceived") {
      const current = state && state.currentByCdpRequestId.get(String(params.requestId || ""));
      if (current) {
        const response = params.response || {};
        current.lastEventAt = Date.now();
        current.response = {
          statusCode: Number(response.status || 0),
          statusText: cleanText(response.statusText || "", 256),
          mimeType: cleanText(response.mimeType || "", 256),
          protocol: cleanText(response.protocol || "", 64),
          fromCache: response.fromDiskCache === true || response.fromPrefetchCache === true,
        };
        current.responseHeaders = sanitizeHeaders(response.headers, true);
        if (response.fromDiskCache === true || response.fromPrefetchCache === true) {
          current.response.fromCache = true;
        }
      }
      return;
    }
    if (method === "Network.requestServedFromCache") {
      const current = state && state.currentByCdpRequestId.get(String(params.requestId || ""));
      if (current) {
        current.lastEventAt = Date.now();
        current.response = { ...(current.response || { statusCode: 0 }), fromCache: true };
      }
      return;
    }
    if (method === "Network.loadingFinished") {
      const requestId = String(params.requestId || "");
      entry.inflight.delete(requestId);
      const current = state && state.currentByCdpRequestId.get(requestId);
      if (current) {
        current.state = "success";
        current.lastEventAt = Date.now();
        current.durationMs = Math.max(0, current.lastEventAt - current.startedAt);
      }
      refreshNetworkWaiters(entry);
      return;
    }
    if (method === "Network.loadingFailed") {
      const requestId = String(params.requestId || "");
      entry.inflight.delete(requestId);
      const current = state && state.currentByCdpRequestId.get(requestId);
      if (current) {
        current.state = "failed";
        current.lastEventAt = Date.now();
        current.durationMs = Math.max(0, current.lastEventAt - current.startedAt);
        current.failure = {
          errorText: cleanText(params.errorText || "request failed", 256),
          canceled: params.canceled === true,
          blockedReason: cleanText(params.blockedReason || "", 128) || undefined,
        };
      }
      refreshNetworkWaiters(entry);
    }
  }

  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    if (method.startsWith("Network.")) {
      handleNetworkEvent(tabId, method, params || {});
      return;
    }
    if (method === "Page.javascriptDialogOpening") {
      dialogs.set(tabId, {
        type: params.type,
        message: params.message,
        defaultPrompt: params.defaultPrompt,
        at: Date.now(),
      });
      return;
    }
    if (method === "Page.javascriptDialogClosed") {
      dialogs.delete(tabId);
      return;
    }
    if (method === "Page.frameNavigated") {
      if (params.frame && !params.frame.parentId) {
        navigationCounts.set(tabId, cdpNavigationCount(tabId) + 1);
        committedNavigationCounts.set(tabId, (committedNavigationCounts.get(tabId) || 0) + 1);
        resolveNavigationWaiters(tabId);
      }
      return;
    }
    if (method === "Page.navigatedWithinDocument") {
      navigationCounts.set(tabId, cdpNavigationCount(tabId) + 1);
      sameDocumentNavigationCounts.set(tabId, (sameDocumentNavigationCounts.get(tabId) || 0) + 1);
      resolveNavigationWaiters(tabId);
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      const text = (params.args || []).map(argText).join(" ").slice(0, 4000);
      record(tabId, { type: params.type, text, at: Date.now() });
    } else if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails || {};
      const description =
        (details.exception && details.exception.description) || details.text || "unknown exception";
      record(tabId, { type: "exception", text: String(description).slice(0, 4000), at: Date.now() });
    }
  });

  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId === undefined) return;
    const entry = attached.get(source.tabId);
    if (entry) {
      rejectNetworkWaiters(entry, "debugger detached");
      rejectNavigationWaiters(entry, "debugger detached");
    }
    attached.delete(source.tabId);
    consoleBuffers.delete(source.tabId);
    dialogs.delete(source.tabId);
    clearNavigationState(source.tabId);
    clearNetworkState(source.tabId);
  });

  return {
    attach,
    send,
    enableNetwork,
    acquireNetwork,
    releaseNetwork,
    detachClient,
    detachAll,
    forget,
    detachTab: forget,
    consoleBuffers,
    dialogs,
    navigationCount: (tabId) => navigationCounts.get(tabId) || 0,
    navigationState,
    networkStart,
    networkList,
    networkGet,
    networkStop,
    waitForNetworkIdle,
    waitForNavigation,
  };
})();
