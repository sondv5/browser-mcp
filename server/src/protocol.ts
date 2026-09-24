export const PROTOCOL_VERSION = 1;
export const SERVICE_NAME = "browser-mcp";
export const DEFAULT_PORT = 8787;
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface HelloMessage {
  kind: "hello";
  protocol: number;
  role?: "extension" | "client";
  extensionVersion?: string;
  clientId?: string;
}

export interface HelloAck {
  kind: "hello_ack";
  service: typeof SERVICE_NAME;
  protocol: number;
  role: "host";
}

export interface CommandMessage {
  kind: "command";
  id: string;
  command: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
  clientId: string;
}

export interface CallMessage {
  kind: "call";
  id: string;
  command: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
  clientId: string;
}

export interface ReplyMessage {
  kind: "reply";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { message: string };
}

export interface PingMessage {
  kind: "ping";
}

export interface PongMessage {
  kind: "pong";
}

export type ExtensionToServer = HelloMessage | ReplyMessage | PingMessage;
export type ServerToExtension = CommandMessage | PongMessage;
export type GuestToHost = HelloMessage | CallMessage | PingMessage;
export type HostToGuest = HelloAck | ReplyMessage | PongMessage;

export interface HubStatus {
  role: "host" | "guest";
  port: number;
  extensionConnected: boolean;
  guests: number;
  pending: number;
  pid?: number;
  hostPid?: number;
}
