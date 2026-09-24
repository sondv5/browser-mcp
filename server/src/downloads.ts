import {
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function prepareDownloadDir(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const resolved = path.resolve(value);
  mkdirSync(resolved, { recursive: true });
  const canonical = realpathSync.native(resolved);
  if (!statSync(canonical).isDirectory()) throw new Error(`download directory is not a directory: ${canonical}`);
  return canonical;
}

export function requireDownloadDir(downloadDir: string | undefined): string {
  if (!downloadDir) {
    throw new Error(
      "downloads are disabled - start the MCP server with --download-dir <directory> to allow them",
    );
  }
  return downloadDir;
}

export function validateDownloadUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("download url is required");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("download url must be an absolute HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("download url must use http: or https:");
  }
  if (parsed.username || parsed.password) throw new Error("download url must not contain embedded credentials");
  return parsed.toString();
}

export function validateDownloadFilename(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("download filename must be a string");
  const name = value.trim();
  if (!name || name.length > 180) throw new Error("download filename must contain 1-180 characters");
  if (name === "." || name === ".." || /[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name)) {
    throw new Error("download filename must be a leaf name without path separators or control characters");
  }
  if (/[<>:"|?*]/.test(name) || /[. ]$/.test(name)) {
    throw new Error("download filename contains characters that are unsafe on Windows");
  }
  return name;
}

export function validateDownloadRequestId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error("download requestId must contain 1-128 letters, digits, dots, underscores, colons, or hyphens");
  }
  return value;
}

export function sanitizeDownloadSnapshot(value: unknown, downloadDir: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const snapshot = { ...(value as Record<string, unknown>) };
  const originalPath = snapshot.path;
  delete snapshot.path;
  snapshot.file = null;
  if (snapshot.state !== "complete" || typeof originalPath !== "string") return snapshot;
  try {
    const file = validateDownloadedFile(originalPath, downloadDir);
    snapshot.file = {
      name: path.basename(file),
      path: file,
      fileUrl: pathToFileURL(file).href,
    };
  } catch (error) {
    const code = error instanceof Error && error.message.startsWith("download file: ")
      ? error.message.slice("download file: ".length)
      : "unavailable";
    snapshot.fileError = code;
  }
  return snapshot;
}

export function validateDownloadedFile(filePath: string, downloadDir: string): string {
  if (!path.isAbsolute(filePath)) throw new Error("download file: not-absolute");
  const lexical = path.resolve(filePath);
  if (path.dirname(lexical).toLowerCase() !== path.resolve(downloadDir).toLowerCase()) {
    throw new Error("download file: outside_allowed_directory");
  }
  let stats;
  try {
    stats = lstatSync(lexical);
  } catch {
    throw new Error("download file: missing");
  }
  if (stats.isSymbolicLink()) throw new Error("download file: symlink_or_indirect_target");
  if (!stats.isFile()) throw new Error("download file: not_regular_file");
  const canonical = realpathSync.native(lexical);
  const relative = path.relative(path.resolve(downloadDir), canonical);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("download file: outside_allowed_directory");
  }
  return canonical;
}
