#!/usr/bin/env node
import { loadConfig, SERVER_VERSION } from "./config.js";
import { JellyfinClient } from "./jellyfin/client.js";
import { log } from "./log.js";
import { runHttp } from "./transports/http.js";
import { runStdio } from "./transports/stdio.js";

const HELP = `jellyfin-mcp ${SERVER_VERSION}

Usage: jellyfin-mcp [--transport stdio|http] [--http] [--host H] [--port P] [--jellyfin-url URL]

Environment:
  JELLYFIN_URL          Jellyfin base URL (required), e.g. http://localhost:8096
  JELLYFIN_API_KEY      API key (Dashboard > API Keys) or a user access token
  JELLYFIN_USERNAME     Username (with JELLYFIN_PASSWORD to log in, or to pick the user for an API key)
  JELLYFIN_PASSWORD     Password for JELLYFIN_USERNAME
  JELLYFIN_USER_ID      User id to act as (overrides username lookup)
  JELLYFIN_READ_ONLY    true to disable tools that change state
  MCP_TRANSPORT         stdio (default) or http
  MCP_HTTP_HOST         HTTP bind address (default 127.0.0.1)
  MCP_HTTP_PORT         HTTP port (default 8787)
  MCP_HTTP_PATH         HTTP endpoint path (default /mcp)
  MCP_AUTH_TOKEN        Require "Authorization: Bearer <token>" on HTTP requests
  MCP_ALLOWED_HOSTS     Comma-separated Host header allowlist (DNS rebinding protection)
  MCP_ALLOWED_ORIGINS   Comma-separated Origin allowlist
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(HELP);
    return;
  }
  if (argv.includes("--version")) {
    process.stderr.write(`${SERVER_VERSION}\n`);
    return;
  }

  const cfg = loadConfig(argv);
  const jf = new JellyfinClient(cfg.jellyfin);

  if (cfg.transport === "http") await runHttp(jf, cfg);
  else await runStdio(jf, cfg);
}

main().catch((err) => {
  log("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
