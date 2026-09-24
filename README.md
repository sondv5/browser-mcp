# browser-mcp

Combo **MCP server + Chrome MV3 extension** that lets an agent drive the browser you are already
using — same profile, same cookies, same logins — without launching a separate browser and without
touching the tab the user is working in.

```
MCP client (opencode / Claude Code / Cursor)
    │  stdio (JSON-RPC)
    ▼
MCP server process #1  ── hub host ── WebSocket 127.0.0.1:8787 ── Chrome MV3 extension
MCP server process #2  ── guest ─────┘  (tunnels calls through the host)
```

- The **first** server process to start binds the port and owns the single extension connection.
- Every later process (another editor window, another agent) becomes a **guest** and tunnels its
  tool calls through the host, so several agents share one browser instead of fighting over a port.
- The extension performs DOM automation through `chrome.debugger` (CDP): trusted input events, real
  screenshots, works on background tabs and behind SSO.

## Layout

```
server/     Node 18+ / TypeScript MCP stdio server (hub host/guest, tools)
extension/  Chrome MV3 extension, no build step (load unpacked as-is)
```

## Quickstart

1. Build the server:

   ```bash
   npm install
   npm run build
   ```

2. Load the extension: `chrome://extensions` → enable Developer mode → **Load unpacked** →
   select `extension/`. Pin the extension and copy its **ID** (optional but recommended).

3. Decide a token (any random string) and put it in the extension popup (port + token), then
   register the MCP server with the same values. Example for opencode (`opencode.json`):

   ```json
   {
     "mcp": {
       "browser": {
         "type": "local",
         "command": [
           "node", "E:\\ideas\\browser-mcp\\server\\dist\\index.js",
           "--port", "8787",
           "--token", "PASTE_RANDOM_TOKEN",
           "--extension-id", "PASTE_EXTENSION_ID",
           "--verbose"
         ],
         "enabled": true
       }
     }
   }
   ```

   Claude Code:

   ```bash
   claude mcp add browser -- node /abs/path/server/dist/index.js --port 8787 --token TOKEN
   ```

4. Reload the extension (or hit **Save & reconnect** in its popup). Badge `ON` = connected.

CLI flags: `--port` (default 8787), `--token`, `--extension-id`, `--upload-dir <dir>` (repeatable,
enables `browser_upload_file` for files inside those directories), `--download-dir <dir>` (enables
download tools for Chrome's `Downloads/browser-mcp` directory), `--verbose`.
Env fallbacks: `BROWSER_MCP_PORT`, `BROWSER_MCP_TOKEN`, `BROWSER_MCP_EXTENSION_ID`,
`BROWSER_MCP_UPLOAD_DIRS` (path-separator separated), `BROWSER_MCP_DOWNLOAD_DIR`.

## Tools

| Tool | Notes |
| --- | --- |
| `browser_server_status` | host/guest role, port, extension connected, pending calls |
| `browser_tabs` | every open tab: tabId, title, url, active, windowId |
| `browser_open` | new tab, background by default; `newWindow: true` puts it in a fresh unfocused window |
| `browser_navigate` | navigate a tab without stealing focus |
| `browser_snapshot` | outline + `ref` for every interactive element (call before click/type) |
| `browser_find` | find text and get refs for matches (long pages) |
| `browser_click` | click by ref or viewport x/y; trusted CDP input |
| `browser_hover` | hover by ref or x/y (menus, tooltips) |
| `browser_type` | focus (optional ref) + insert text, optional Enter |
| `browser_press_key` | Enter, Tab, Escape, arrows… with modifiers |
| `browser_select_option` | pick a `<select>` option by value / label / index |
| `browser_scroll` | scroll to a ref, or wheel by deltaX/deltaY |
| `browser_back` / `browser_forward` / `browser_reload` | navigation history and reload |
| `browser_handle_dialog` | accept/dismiss alert, confirm, prompt, beforeunload |
| `browser_screenshot` | viewport or element-by-ref PNG; `fullPage` needs a visible tab |
| `browser_get_text` | element (ref) or page text |
| `browser_evaluate` | evaluate JS in the page |
| `browser_wait_for` | wait for text or a selector (`visible: true` also waits for rendering) |
| `browser_console` | buffered console messages / exceptions per tab |
| `browser_upload_file` | attach local files (needs `--upload-dir`) |
| `browser_network_start` / `browser_network_stop` | start/stop a bounded 500-entry network capture for one tab |
| `browser_network_requests` | filtered request summaries, newest first; URLs/header values are redacted |
| `browser_network_request` | request/response metadata plus optional transient text bodies |
| `browser_download` | start an HTTP(S) download in `Downloads/browser-mcp` (needs `--download-dir`) |
| `browser_downloads` | recent session/page downloads inside the configured directory |
| `browser_download_status` | progress/state; `wait: true` never cancels on timeout |
| `browser_download_cancel` | cancel an active download; never deletes completed files |
| `browser_tab_activate` | foreground a tab (human handoff: login, 2FA, captcha) |
| `browser_close` | close a tab |
| `browser_detach` | release one tab (`tabId`) or every attached tab; removes the debug banner |
| `browser_cdp` | escape hatch: raw CDP command on a tab |

Refs are only valid until the next snapshot or navigation; they embed the snapshot epoch so stale
refs fail with a clear error instead of clicking the wrong element.

## Action state

`browser_click`, `browser_type`, `browser_press_key`, `browser_select_option`, `browser_navigate`,
`browser_back`, `browser_forward`, and `browser_reload` accept optional post-action fields:

- `waitFor: { selector?, text?, url?, visible? }` waits in the latest committed document;
- `settle: "load" | "networkIdle" | "both"` waits for page/network lifecycle;
- `snapshot: true` returns a fresh snapshot in the same result;
- `timeoutMs` bounds the complete post-action workflow (default 30 seconds).

The result adds an `actionState` object without removing legacy fields. Calls without these options
retain the original fire-and-forget behavior. `browser_wait_for` also accepts `url`, `load`, and
`networkIdle` and uses event-driven DOM/CDP waits rather than a fixed sleep.

Network capture starts only after `browser_network_start`; it does not backfill earlier requests.
The extension stores at most 500 records per tab in memory, invalidates the buffer on detach/restart,
and redacts common URL/header secrets. Request/response bodies are omitted unless explicitly requested
and are limited to 32 KiB of transient text.

Downloads are opt-in. `--download-dir` must point to Chrome's current
`Downloads/browser-mcp` directory. Completed paths are canonicalized and rejected if they are symlinks,
non-files, or outside that exact directory. No tool reads, opens, executes, or deletes file contents.

## Why the user's session is not disturbed

- **Attach, never launch.** `chrome.debugger.attach` reuses the running profile — logins, SSO,
  2FA, extensions all keep working. No cookie export, no cloned profile.
- **Trusted input, silent by default.** Clicks/keys go through CDP `Input.*`, so pages and bot
  detection see genuine events. Chrome only delivers those events to a renderer it considers
  foreground/rendered, so the extension escalates in order:
  1. tab already active in the focused window → dispatch directly;
  2. otherwise try **focus emulation** (`Emulation.setFocusEmulationEnabled` +
     `Page.setWebLifecycleState("active")`) and **verify with an in-page probe** that the event
     actually arrived — this is fully silent, the user's tab never changes;
  3. only if nothing arrived, borrow focus for ~220 ms, re-dispatch and verify again;
  4. if it still did not land (e.g. an occluded or minimized window), fail loudly instead of
     pretending the action happened.

  Override per call with `focus: "auto" | "keep" | "never" | "emulate"` on click/type/press_key/
  hover/scroll. The debug banner ("… is debugging this browser") is deliberately not suppressed;
  `browser_detach` releases a tab on demand.
- **No DOM mutation for refs.** Element refs live in an in-page `Map` (`globalThis.__browserMcpRefs`)
  and are never written as attributes; snapshots leave the DOM byte-identical.
- **Background-first.** `browser_open` and `browser_navigate` do not activate tabs. Pass `tabId`
  explicitly when several agents share the browser.
- **Password redaction.** Password inputs are reported as `[redacted]` in snapshots.

## Connection behavior

The hub serves `GET /health` (JSON, token-protected when `--token` is set) which reports
`{ service, protocol, role, extensionConnected, guests, pending }`. Instead of hammering the
WebSocket port, the extension:

1. probes `/health` first — a failed probe means "server not running", so no
   `ERR_CONNECTION_REFUSED` WebSocket error is logged;
2. backs off 1s → 2s → 4s → 8s → 15s → 30s → then every 5 minutes while the server is down;
3. falls back to a direct WebSocket attempt when it was connected within the last 5 minutes (so
   reloading the extension while the server is running reconnects instantly).

The popup shows the current state (connected / waiting / off), the hub role, and lets you
force a connect or a full disconnect without touching files.

## Security

- Hub binds `127.0.0.1` only.
- `/extension` requires a `chrome-extension://` `Origin` header; `--extension-id` pins it to one
  extension. Browsers always set `Origin` on WebSocket handshakes, so a web page cannot forge it.
- `/client` (guest MCP processes) rejects requests that carry any `Origin`.
- `--token` is required on both paths; without it any local process could drive the browser. Set it.
- Anything an agent can do here, it does with **your** logged-in privileges. Do not run untrusted
  agents, and treat the token like a password.

## Limitations

- MV3 service workers are evicted after ~30 s idle. The extension keeps the socket alive with a
  20 s app-level ping plus a 1 min `chrome.alarms` backstop, but per-tab console/network buffers are
  lost after a worker restart; in-page refs are also lost when the page navigates.
- Network capture covers the tab's main CDP target and future requests only. Worker targets, request
  interception, and historical requests from before capture are not available.
- If DevTools is open on a tab, `chrome.debugger.attach` fails for that tab (clear error).
- `chrome.tabs` and `chrome.debugger` do not see `chrome://` pages or other extensions' pages.
- Full-page screenshots (`fullPage: true`) require the tab to be visible; use `browser_tab_activate`
  first, or capture the viewport or an element by ref (both work silently on background tabs).
- Windows can be occluded or minimized: focus emulation revives most cases, but if input still
  cannot be delivered the tool fails loudly (suggesting `focus: "keep"`) rather than doing nothing.
- One extension connection per hub: a second Chrome profile running the extension replaces the
  first connection on the same port (run a second server on another port + token for that profile).

## Development

```bash
npm run build        # tsc
npm test             # unit tests + fake-extension smoke tests
npm run smoke        # hub, schemas, host/guest routing, network/download/action-state
node test/live.mjs   # real-browser regression on throwaway tabs
node test/modes.mjs  # input-delivery modes: background tab vs focus emulation
```

`server/test/features.test.mjs` uses deterministic fake Chrome/CDP APIs to test network redaction,
ring bounds, body retrieval, network idle, download lifecycle/path containment, and action option
normalization. `server/test/live.mjs` drives the real extension on throwaway tabs.

## Reference implementations studied

Mechanisms were borrowed from (cloned under `../refs/` while building this):
`Parithosh-Varma/browser-mcp` (WS bridge + CDP), `ShalomObongo/chrome-bridge-mcp` (hub/guest,
Origin policy, in-page refs), `hangwin/mcp-chrome` (MV3 keepalive), `microsoft/playwright`
extension mode (CDP relay + consent), `BrowserMCP/mcp` (stdio ↔ WS envelope).
