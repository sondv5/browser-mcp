// Keeps the MV3 service worker alive: this offscreen document is not subject to
// the worker idle timeout, and the periodic traffic on the runtime port resets
// the worker's idle timer, so the WebSocket bridge stays connected.
let port = null;

function connect() {
  try {
    port = chrome.runtime.connect({ name: "browser-mcp-keepalive" });
    port.onDisconnect.addListener(() => {
      port = null;
    });
  } catch {
    port = null;
  }
}

connect();
setInterval(() => {
  if (!port) connect();
  if (!port) return;
  try {
    port.postMessage({ at: Date.now() });
  } catch {
    port = null;
  }
}, 20000);
