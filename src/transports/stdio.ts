import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Config } from "../config.js";
import type { JellyfinClient } from "../jellyfin/client.js";
import { log } from "../log.js";
import { createServer } from "../server.js";

export async function runStdio(jf: JellyfinClient, cfg: Config): Promise<void> {
  const server = createServer(jf, { readOnly: cfg.readOnly });
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(transport);
  log(`stdio transport ready (Jellyfin: ${cfg.jellyfin.url}${cfg.readOnly ? ", read-only" : ""})`);
}
