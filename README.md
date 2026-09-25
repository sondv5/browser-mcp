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

## Quickstart (simplest setup, no clone needed)

1. Install the extension from the Chrome Web Store:
   https://chromewebstore.google.com/detail/browser-mcp-bridge/ieijpbldkdjgncbbjndoolkkgaamlocl
   (If you previously used **Load unpacked**, remove that version first to avoid
   two copies fighting over the connection.)

2. Pick a token (any random string) and enter port `8787` + token in the
   extension popup, then hit **Save & reconnect**. Badge `ON` = connected.

3. Register the MCP server with the same values — no local clone needed:

   opencode (`opencode.json`):

   ```json
   {
     "mcp": {
       "browser": {
         "type": "local",
         "command": [
           "npx", "-y", "@sondv5/browser-mcp@latest",
           "--port", "8787",
           "--token", "PASTE_RANDOM_TOKEN",
           "--extension-id", "ieijpbldkdjgncbbjndoolkkgaamlocl"
         ],
         "enabled": true
       }
     }
   }
   ```

   Claude Code:

   ```bash
   claude mcp add browser -- npx -y @sondv5/browser-mcp@latest \
     --port 8787 --token TOKEN \
     --extension-id ieijpbldkdjgncbbjndoolkkgaamlocl
   ```

4. Restart your agent so it picks up the MCP server. Done — the agent works in
   background tabs while you keep browsing.

### Build from source (for development)

```bash
npm install
npm run build
```

Then point your MCP config at the local build instead of npx:

```json
"command": ["node", "/abs/path/browser-mcp/server/dist/index.js", "--port", "8787", "--token", "TOKEN"]
```

And load the unpacked extension from `extension/` via `chrome://extensions` →
Developer mode → **Load unpacked** (only needed if you hack on the extension).

### Install as a Claude Code / Cowork plugin

```bash
claude plugin marketplace add sondv5/browser-mcp
claude plugin install browser@browser-mcp
```

This registers the MCP server for you (via `npx -y @sondv5/browser-mcp@latest`, no local clone or
build needed). You still need to install the extension from the Web Store (step 1 above) and set
`BROWSER_MCP_TOKEN` / `BROWSER_MCP_PORT` / `BROWSER_MCP_EXTENSION_ID` env vars if you want the
optional token/port/extension pinning.

### Install as a Cursor plugin

- **Test locally**: copy (or symlink) this repo into `~/.cursor/plugins/local/browser-mcp`, then
  reload the Cursor window.
- **Share with your team**: Cursor Dashboard → **Plugins & MCPs** → **Import from Repo**, pointing
  at `https://github.com/sondv5/browser-mcp`.
- **Publish publicly** (open-source repos): submit it at
  [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish).

CLI flags: `--port` (default 8787), `--token`, `--extension-id`, `--upload-dir <dir>` (repeatable,
enables `browser_act { action: 'upload' }` for files inside those directories), `--download-dir <dir>` (enables
`browser_download` tools for Chrome's `Downloads/browser-mcp` directory), `--verbose`.
Env fallbacks: `BROWSER_MCP_PORT`, `BROWSER_MCP_TOKEN`, `BROWSER_MCP_EXTENSION_ID`,
`BROWSER_MCP_UPLOAD_DIRS` (path-separator separated), `BROWSER_MCP_DOWNLOAD_DIR`.

## Tools (7 compact tools, `action` selects the operation)

| Tool | `action` values |
| --- | --- |
| `browser_tab` | `list` (every tab), `open` (background by default, `newWindow: true` = fresh unfocused window), `close`, `activate` (foreground for login/2FA/captcha, use sparingly), `navigate` (requires `url`, no focus steal), `back` / `forward` / `reload`, `detach` (release tab + remove debug banner) |
| `browser_act` | `click` (ref or x/y), `type` (requires `text`, optional ref + `submit`), `press_key` (requires `key` + modifiers), `hover`, `scroll` (ref or deltaX/deltaY), `select` (native `<select>` by value/label/index), `upload` (needs `--upload-dir`), `dialog` (accept/dismiss alert/confirm/prompt) |
| `browser_read` | `snapshot` (outline + `ref`, call before click/type), `find` (requires `query`), `get_text`, `evaluate` (requires `expression`), `wait` (text/selector/url/load/networkIdle), `console`, `screenshot` (viewport or ref PNG; `fullPage` needs a visible tab) |
| `browser_network` | `start` / `stop` (bounded 500-entry capture), `list` (filtered summaries, redacted), `get` (metadata + optional transient text bodies) |
| `browser_download` | `start` (needs `--download-dir`), `list`, `status` (`wait: true` never cancels on timeout), `cancel` (never deletes completed files) |
| `browser_server_status` | host/guest role, port, extension connected, pending calls |
| `browser_cdp` | escape hatch: raw CDP command on a tab |

Refs are only valid until the next snapshot or navigation; they embed the snapshot epoch so stale
refs fail with a clear error instead of clicking the wrong element.

## Action state

`browser_act` (click/type/press_key/select) and `browser_tab` (navigate/back/forward/reload) accept optional post-action fields:

- `waitFor: { selector?, text?, url?, visible? }` waits in the latest committed document;
- `settle: "load" | "networkIdle" | "both"` waits for page/network lifecycle;
- `snapshot: true` returns a fresh snapshot in the same result;
- `timeoutMs` bounds the complete post-action workflow (default 30 seconds).

The result adds an `actionState` object without removing legacy fields. Calls without these options
retain the original fire-and-forget behavior. `browser_read { action: 'wait' }` also accepts `url`, `load`, and
`networkIdle` and uses event-driven DOM/CDP waits rather than a fixed sleep.

Network capture starts only after `browser_network { action: 'start' }`; it does not backfill earlier requests.
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
   `browser_tab { action: 'detach' }` releases a tab on demand.
- **No DOM mutation for refs.** Element refs live in an in-page `Map` (`globalThis.__browserMcpRefs`)
  and are never written as attributes; snapshots leave the DOM byte-identical.
- **Background-first.** `browser_tab { action: 'open' }` and `{ action: 'navigate' }` do not activate tabs. Pass `tabId`
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
- Full-page screenshots (`fullPage: true`) require the tab to be visible; use `browser_tab { action: 'activate' }`
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
