import { hostname } from "node:os";

export type TransportKind = "stdio" | "http";

export interface Config {
  jellyfin: {
    url: string;
    apiKey?: string;
    username?: string;
    password?: string;
    /** Explicit user to act as. If unset it is resolved from username, the token's owner, or the first admin. */
    userId?: string;
    deviceId: string;
    deviceName: string;
    timeoutMs: number;
  };
  readOnly: boolean;
  transport: TransportKind;
  http: {
    host: string;
    port: number;
    path: string;
    /** Bearer token required on every HTTP request when set. */
    authToken?: string;
    allowedHosts?: string[];
    allowedOrigins?: string[];
  };
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function bool(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function list(name: string): string[] | undefined {
  const v = env(name);
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (i === -1) return undefined;
  const a = argv[i]!;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const url = argValue(argv, "--jellyfin-url") ?? env("JELLYFIN_URL");
  if (!url) throw new Error("JELLYFIN_URL is required (e.g. http://localhost:8096)");

  const apiKey = env("JELLYFIN_API_KEY");
  const username = env("JELLYFIN_USERNAME");
  const password = env("JELLYFIN_PASSWORD");
  if (!apiKey && !username) {
    throw new Error("Set JELLYFIN_API_KEY, or JELLYFIN_USERNAME (+ JELLYFIN_PASSWORD) to authenticate");
  }

  const transportArg = (argValue(argv, "--transport") ?? env("MCP_TRANSPORT") ?? (argv.includes("--http") ? "http" : "stdio")).toLowerCase();
  if (transportArg !== "stdio" && transportArg !== "http") {
    throw new Error(`Unknown transport "${transportArg}" (expected stdio or http)`);
  }

  const port = Number(argValue(argv, "--port") ?? env("MCP_HTTP_PORT") ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${port}`);

  return {
    jellyfin: {
      url: url.replace(/\/+$/, ""),
      apiKey,
      username,
      password,
      userId: env("JELLYFIN_USER_ID"),
      deviceId: env("JELLYFIN_DEVICE_ID") ?? `jellyfin-mcp-${hostname()}`,
      deviceName: env("JELLYFIN_DEVICE_NAME") ?? "Jellyfin MCP",
      timeoutMs: Number(env("JELLYFIN_TIMEOUT_MS") ?? 30000),
    },
    readOnly: bool("JELLYFIN_READ_ONLY", false),
    transport: transportArg,
    http: {
      host: argValue(argv, "--host") ?? env("MCP_HTTP_HOST") ?? "127.0.0.1",
      port,
      path: env("MCP_HTTP_PATH") ?? "/mcp",
      authToken: env("MCP_AUTH_TOKEN"),
      allowedHosts: list("MCP_ALLOWED_HOSTS"),
      allowedOrigins: list("MCP_ALLOWED_ORIGINS"),
    },
  };
}

export const SERVER_NAME = "jellyfin-mcp";
export const SERVER_VERSION = "0.1.0";
