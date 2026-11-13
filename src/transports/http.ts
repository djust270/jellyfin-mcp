import { randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import { SERVER_VERSION } from "../config.js";
import type { JellyfinClient } from "../jellyfin/client.js";
import { log } from "../log.js";
import { createServer } from "../server.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}

const SESSION_IDLE_MS = 30 * 60_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function jsonRpcError(res: Response, status: number, code: number, message: string) {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function bearerAuth(token: string) {
  const expected = Buffer.from(token);
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="jellyfin-mcp"');
      return jsonRpcError(res, 401, -32001, "Unauthorized");
    }
    next();
  };
}

/**
 * Streamable HTTP transport (MCP spec 2025-03-26+). Stateful: each client gets
 * an Mcp-Session-Id and its own McpServer/transport pair.
 */
export async function runHttp(jf: JellyfinClient, cfg: Config): Promise<void> {
  const { host, port, path, authToken, allowedHosts, allowedOrigins } = cfg.http;

  if (!authToken && !LOOPBACK.has(host)) {
    log(`WARNING: listening on ${host} without MCP_AUTH_TOKEN; anyone who can reach this port can control Jellyfin.`);
  }

  // Adds JSON body parsing and Host-header (DNS rebinding) protection for loopback binds.
  const app = createMcpExpressApp({ host, allowedHosts });
  const sessions = new Map<string, Session>();

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", version: SERVER_VERSION, sessions: sessions.size });
  });

  if (allowedOrigins?.length) {
    app.use(path, (req, res, next) => {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) return jsonRpcError(res, 403, -32000, "Origin not allowed");
      next();
    });
  }
  if (authToken) app.use(path, bearerAuth(authToken));

  app.post(path, async (req, res) => {
    const sid = req.headers["mcp-session-id"];
    try {
      if (typeof sid === "string") {
        const s = sessions.get(sid);
        if (!s) return jsonRpcError(res, 404, -32001, "Session not found");
        s.lastSeen = Date.now();
        return await s.transport.handleRequest(req, res, req.body);
      }

      if (!isInitializeRequest(req.body)) {
        return jsonRpcError(res, 400, -32000, "Bad Request: missing Mcp-Session-Id header (send initialize first)");
      }

      const server = createServer(jf, { readOnly: cfg.readOnly });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, lastSeen: Date.now() });
          log(`session ${id} opened (${sessions.size} active)`);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          log(`session ${id} closed (${sessions.size} active)`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("error handling POST:", err);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  // GET opens the server->client SSE stream; DELETE ends the session.
  const handleSessionRequest = async (req: Request, res: Response) => {
    const sid = req.headers["mcp-session-id"];
    const s = typeof sid === "string" ? sessions.get(sid) : undefined;
    if (!s) return jsonRpcError(res, typeof sid === "string" ? 404 : 400, -32001, "Invalid or missing Mcp-Session-Id");
    s.lastSeen = Date.now();
    try {
      await s.transport.handleRequest(req, res);
    } catch (err) {
      log(`error handling ${req.method}:`, err);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
    }
  };
  app.get(path, handleSessionRequest);
  app.delete(path, handleSessionRequest);

  // Drop sessions whose clients went away without sending DELETE.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of sessions) {
      if (s.lastSeen < cutoff) {
        sessions.delete(id);
        void s.transport.close().catch(() => {});
        void s.server.close().catch(() => {});
        log(`session ${id} expired`);
      }
    }
  }, 60_000);
  sweeper.unref();

  const httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const srv = app.listen(port, host, (err?: Error) => (err ? reject(err) : resolve(srv)));
  });
  const addr = httpServer.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  log(`streamable HTTP transport listening on http://${host.includes(":") ? `[${host}]` : host}:${actualPort}${path}` +
    `${authToken ? " (bearer auth on)" : ""}${cfg.readOnly ? " (read-only)" : ""}`);

  const shutdown = async () => {
    log("shutting down");
    clearInterval(sweeper);
    await Promise.allSettled([...sessions.values()].flatMap((s) => [s.transport.close(), s.server.close()]));
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
