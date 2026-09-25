# Privacy Policy — Browser MCP Bridge

Last updated: September 26, 2026.

Browser MCP Bridge ("the extension") connects a locally running MCP server
(opencode, Claude Code, Cursor) to the Chrome browser you already use, so your
own AI agent can automate tabs on your behalf.

## Data collection and use

The extension does **not** collect, transmit, sell, or share any user data.
All processing happens locally on your machine, between the extension and the
MCP server you run yourself over `http://127.0.0.1` / `ws://127.0.0.1`
(localhost only). No data is sent to the developer or any third party, and the
extension includes no analytics or tracking.

## Why the requested permissions are needed

- `debugger` — attach Chrome DevTools Protocol to your tabs to dispatch
  trusted input (click, type, scroll) and capture screenshots, including on
  background tabs.
- `tabs` — list, open, navigate, and close your tabs as instructed by you.
- `storage` — store the hub port and token you enter in the popup, on your
  device only.
- `downloads` — save agent-initiated downloads into `Downloads/browser-mcp`.
  File contents are never read, opened, executed, or deleted.
- `alarms` and `offscreen` — keep the local WebSocket connection alive
  (MV3 service-worker keepalive).
- Host permissions for `http://127.0.0.1/*` and `ws://127.0.0.1/*` — talk
  only to your local MCP server. The server additionally requires a
  `chrome-extension://` Origin, so websites cannot forge a connection.

## Contact

Issues: https://github.com/sondv5/browser-mcp/issues
