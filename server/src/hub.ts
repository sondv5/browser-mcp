import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  DEFAULT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SERVICE_NAME,
  type CallMessage,
  type CommandMessage,
  type HelloAck,
  type HubStatus,
} from "./protocol.js";

export interface HubOptions {
  port: number;
  token?: string;
  extensionId?: string;
  log?: (message: string) => void;
}

export type ExecuteFn = (
  command: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

export interface Hub {
  role: "host" | "guest";
  port: number;
  execute: ExecuteFn;
  status(): Promise<HubStatus>;
  close(): Promise<void>;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  guest?: WebSocket;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function startHub(options: HubOptions): Promise<Hub> {
  const log = options.log ?? (() => {});
  const clientId = `client-${process.pid}-${randomUUID().slice(0, 8)}`;

  try {
    return await startHost(options, clientId, log);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    log(`port ${options.port} is already in use - attaching to the running hub as a guest`);
    return await startGuest(options, clientId, log);
  }
}

async function startHost(
  options: HubOptions,
  clientId: string,
  log: (message: string) => void,
): Promise<Hub> {
  const pending = new Map<string, PendingEntry>();
  const guests = new Set<WebSocket>();
  let extension: WebSocket | null = null;

  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const headers: Record<string, string> = { "content-type": "application/json" };
    const origin = request.headers.origin;
    if (origin && origin.startsWith("chrome-extension://")) {
      headers["access-control-allow-origin"] = origin;
      headers["vary"] = "Origin";
    }
    if (url.pathname !== "/health") {
      response.writeHead(404, headers);
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (options.token && url.searchParams.get("token") !== options.token) {
      response.writeHead(401, headers);
      response.end(JSON.stringify({ error: "invalid token" }));
      return;
    }
    response.writeHead(200, headers);
    response.end(
      JSON.stringify({ service: SERVICE_NAME, protocol: PROTOCOL_VERSION, ...hostStatus() }),
    );
  });

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info, done) => {
      const url = new URL(info.req.url ?? "/", "http://127.0.0.1");
      const origin = info.req.headers.origin;
      const token = url.searchParams.get("token");

      if (options.token && token !== options.token) {
        done(false, 401, "invalid token");
        return;
      }

      if (url.pathname === "/extension") {
        if (!origin || !origin.startsWith("chrome-extension://")) {
          done(false, 403, "extension connections must send a chrome-extension:// Origin");
          return;
        }
        if (options.extensionId && origin !== `chrome-extension://${options.extensionId}`) {
          done(false, 403, "unexpected extension id");
          return;
        }
        done(true);
        return;
      }

      if (url.pathname === "/client") {
        if (origin) {
          done(false, 403, "client connections must not send an Origin header");
          return;
        }
        done(true);
        return;
      }

      done(false, 404, "unknown path");
    },
  });

  wss.on("error", (error) => log(`websocket server error: ${String(error)}`));

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(options.port, "127.0.0.1");
  });

  function hostStatus(): HubStatus {
    return {
      role: "host",
      port: options.port,
      extensionConnected: extension !== null && extension.readyState === WebSocket.OPEN,
      guests: guests.size,
      pending: pending.size,
      pid: process.pid,
    };
  }

  function rejectPending(reason: string): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error(reason));
    }
  }

  function rejectPendingForGuest(guest: WebSocket, reason: string): void {
    for (const [id, entry] of pending) {
      if (entry.guest !== guest) continue;
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error(reason));
    }
  }

  function settle(id: string, ok: boolean, result: unknown, errorMessage?: string): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.guest && entry.guest.readyState === WebSocket.OPEN) {
      const reply = ok
        ? { kind: "reply", id, ok: true, result }
        : { kind: "reply", id, ok: false, error: { message: errorMessage ?? "unknown error" } };
      entry.guest.send(JSON.stringify(reply));
    }
    if (ok) entry.resolve(result);
    else entry.reject(new Error(errorMessage ?? "unknown error"));
  }

  function route(
    command: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
    guest?: WebSocket,
    requestId?: string,
  ): Promise<unknown> {
    const socket = extension;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error(
          "browser extension is not connected - load/reload the Browser MCP Bridge extension and check its popup",
        ),
      );
    }
    const id = requestId ?? randomUUID();
    const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`command "${command}" timed out after ${timeout} ms`));
      }, timeout);
      timer.unref();
      pending.set(id, { resolve, reject, timer, guest });
      const message: CommandMessage = {
        kind: "command",
        id,
        command,
        params,
        timeoutMs: timeout,
        clientId,
      };
      socket.send(JSON.stringify(message));
    });
  }

  function handleExtension(socket: WebSocket): void {
    if (extension && extension.readyState === WebSocket.OPEN) {
      log("replacing the previous extension connection");
      extension.close(4000, "replaced");
    }
    extension = socket;
    log("extension connected");

    socket.on("message", (data) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.kind === "hello") {
        log(
          `extension hello (protocol ${String(message.protocol)}, version ${String(message.extensionVersion ?? "?")})`,
        );
        return;
      }
      if (message.kind === "ping") {
        socket.send(JSON.stringify({ kind: "pong" }));
        return;
      }
      if (message.kind === "reply" && typeof message.id === "string") {
        const error = message.error as { message?: string } | undefined;
        settle(message.id, message.ok === true, message.result, error?.message);
      }
    });

    socket.on("close", () => {
      if (extension === socket) {
        extension = null;
        log("extension disconnected");
        rejectPending("browser extension disconnected while a command was in flight");
      }
    });

    socket.on("error", (error) => log(`extension socket error: ${String(error)}`));
  }

  function handleGuest(socket: WebSocket): void {
    guests.add(socket);
    log("guest MCP client connected");

    socket.on("message", (data) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.kind === "hello") {
        const ack: HelloAck = {
          kind: "hello_ack",
          service: SERVICE_NAME,
          protocol: PROTOCOL_VERSION,
          role: "host",
        };
        socket.send(JSON.stringify(ack));
        return;
      }
      if (message.kind === "ping") {
        socket.send(JSON.stringify({ kind: "pong" }));
        return;
      }
      if (message.kind === "call" && typeof message.id === "string") {
        const call = message as unknown as CallMessage;
        if (call.command === "__status") {
          socket.send(JSON.stringify({ kind: "reply", id: call.id, ok: true, result: hostStatus() }));
          return;
        }
        route(call.command, call.params ?? {}, call.timeoutMs, socket, call.id).catch((error: Error) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({
                kind: "reply",
                id: call.id,
                ok: false,
                error: { message: error.message },
              }),
            );
          }
        });
      }
    });

    socket.on("close", () => {
      guests.delete(socket);
      rejectPendingForGuest(socket, "MCP client disconnected while a command was in flight");
    });
    socket.on("error", () => {
      guests.delete(socket);
      rejectPendingForGuest(socket, "MCP client socket error while a command was in flight");
    });
  }

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/extension") handleExtension(socket);
    else handleGuest(socket);
  });

  return {
    role: "host",
    port: options.port,
    execute: (command, params = {}, timeoutMs) => route(command, params, timeoutMs),
    status: async () => hostStatus(),
    close: async () => {
      for (const guest of guests) {
        try {
          guest.close();
        } catch {
          // ignore
        }
      }
      guests.clear();
      if (extension) {
        try {
          extension.close();
        } catch {
          // ignore
        }
      }
      rejectPending("hub shutting down");
      wss.close();
      httpServer.close();
    },
  };
}

async function startGuest(
  options: HubOptions,
  clientId: string,
  log: (message: string) => void,
): Promise<Hub> {
  const socket = await connectToHost(options, clientId, log);
  const pending = new Map<string, Omit<PendingEntry, "guest">>();

  socket.on("message", (data) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.kind !== "reply" || typeof message.id !== "string") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    const error = message.error as { message?: string } | undefined;
    if (message.ok === true) entry.resolve(message.result);
    else entry.reject(new Error(error?.message ?? "host reported an error"));
  });

  socket.on("close", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("hub connection closed"));
    }
    pending.clear();
  });

  const execute: ExecuteFn = (command, params = {}, timeoutMs) =>
    new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`command "${command}" timed out after ${timeout} ms`));
      }, timeout);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      const call: CallMessage = {
        kind: "call",
        id,
        command,
        params,
        timeoutMs: timeout,
        clientId,
      };
      socket.send(JSON.stringify(call));
    });

  return {
    role: "guest",
    port: options.port,
    execute,
    status: async () => (await execute("__status", {}, 5000)) as HubStatus,
    close: async () => {
      socket.close();
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("hub shutting down"));
      }
      pending.clear();
    },
  };
}

async function connectToHost(
  options: HubOptions,
  clientId: string,
  log: (message: string) => void,
): Promise<WebSocket> {
  const query = options.token ? `?token=${encodeURIComponent(options.token)}` : "";
  const url = `ws://127.0.0.1:${options.port}/client${query}`;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const socket = new WebSocket(url);
      const ack = await new Promise<HelloAck>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("host did not acknowledge in time")), 2000);
        socket.once("open", () => {
          socket.send(JSON.stringify({ kind: "hello", protocol: PROTOCOL_VERSION, role: "client", clientId }));
        });
        const onMessage = (data: unknown) => {
          try {
            const message = JSON.parse(String(data)) as Record<string, unknown>;
            if (message.kind === "hello_ack") {
              clearTimeout(timer);
              socket.off("message", onMessage);
              resolve(message as unknown as HelloAck);
            }
          } catch {
            // ignore malformed frames during handshake
          }
        };
        socket.on("message", onMessage);
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(new Error(error instanceof Error ? error.message : String(error)));
        });
      });

      if (ack.service !== SERVICE_NAME || ack.protocol !== PROTOCOL_VERSION) {
        socket.close();
        throw new Error(`port ${options.port} is used by a different service (or protocol version)`);
      }

      log(`attached to the existing hub on port ${options.port}`);
      return socket;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await sleep(300);
    }
  }

  throw new Error(
    `could not attach to the hub on port ${options.port}: ${lastError?.message ?? "unknown error"}`,
  );
}
