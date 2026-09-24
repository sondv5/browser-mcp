const $ = (id) => document.getElementById(id);

const BADGE = {
  connected: { text: "Connected", dot: "ok" },
  connecting: { text: "Checking", dot: "warn" },
  retrying: { text: "Offline", dot: "warn" },
  stopped: { text: "Off", dot: "idle" },
  idle: { text: "Idle", dot: "idle" },
};

async function load() {
  const config = await chrome.storage.local.get({ port: 8787, token: "", autoConnect: true });
  $("port").value = config.port;
  $("token").value = config.token;
  $("autoConnect").checked = config.autoConnect;
  $("metaVersion").textContent = `v${chrome.runtime.getManifest().version}`;
}

function render(status) {
  if (!status) {
    return;
  }
  const badge = BADGE[status.state] || BADGE.idle;
  $("badgeText").textContent = badge.text;
  $("badgeDot").className = `dot ${badge.dot}`;
  $("statusDot").className = `dot big ${badge.dot}`;
  $("statusTitle").textContent =
    status.state === "connected" ? "Connected" : status.state === "retrying" ? "Waiting for the MCP server" : badge.text;
  $("statusMessage").textContent = status.message || "";
  $("metaPort").textContent = `port ${status.port}`;
  $("metaRole").textContent = status.hubRole ? `hub ${status.hubRole}` : "hub —";
  $("connect").textContent = status.state === "connected" ? "Reconnect" : "Save & connect";
  $("disconnect").disabled = status.state === "stopped";
}

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (status) => {
    if (chrome.runtime.lastError) {
      render({
        state: "idle",
        port: Number($("port").value) || 8787,
        message: "Background worker is not responding.",
      });
      return;
    }
    render(status);
  });
}

function apply(autoConnect) {
  $("autoConnect").checked = autoConnect;
  const payload = {
    type: "apply",
    config: {
      port: Number($("port").value) || 8787,
      token: $("token").value.trim(),
      autoConnect,
    },
  };
  chrome.runtime.sendMessage(payload, () => refresh());
}

function disconnect() {
  chrome.runtime.sendMessage({ type: "disconnect" }, () => refresh());
}

$("toggleToken").addEventListener("click", () => {
  const input = $("token");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("toggleToken").textContent = show ? "Hide" : "Show";
});

$("connect").addEventListener("click", () => apply(true));
$("disconnect").addEventListener("click", disconnect);

load();
refresh();
setInterval(refresh, 1000);
