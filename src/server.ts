import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import type { JellyfinClient } from "./jellyfin/client.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerLibraryTools } from "./tools/library.js";
import { registerPlaybackTools } from "./tools/playback.js";
import { registerPlaylistTools } from "./tools/playlists.js";

export interface ServerOptions {
  readOnly: boolean;
}

/**
 * Build an MCP server instance. Over HTTP a new instance is created per
 * session; all instances share the same Jellyfin client.
 */
export function createServer(jf: JellyfinClient, opts: ServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "Jellyfin" },
    {
      capabilities: { tools: {} },
      instructions:
        "Tools for a Jellyfin media server. Find things with jellyfin_search or jellyfin_browse (use ids from " +
        "jellyfin_list_libraries as parentId), then use item ids with the other tools. To play something on a TV/app, " +
        "get a sessionId from jellyfin_list_sessions first." +
        (opts.readOnly ? " This server is read-only: tools that change state are disabled." : ""),
    },
  );

  const ctx = { server, jf, readOnly: opts.readOnly };
  registerLibraryTools(ctx);
  registerPlaybackTools(ctx);
  registerPlaylistTools(ctx);
  registerAdminTools(ctx);
  return server;
}
