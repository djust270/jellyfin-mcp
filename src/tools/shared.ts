import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { JellyfinClient } from "../jellyfin/client.js";

export interface ToolContext {
  server: McpServer;
  jf: JellyfinClient;
  readOnly: boolean;
}

export function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function text(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
}

type Shape = z.ZodRawShape;

interface ToolDef<S extends Shape> {
  title: string;
  description: string;
  input: S;
  /** Changes server or client state. Not registered when JELLYFIN_READ_ONLY is set. */
  mutating?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>;
}

/** Register a tool with consistent annotations and error handling. */
export function defineTool<S extends Shape>(ctx: ToolContext, name: string, def: ToolDef<S>): void {
  if (def.mutating && ctx.readOnly) return;

  const annotations: ToolAnnotations = {
    title: def.title,
    readOnlyHint: !def.mutating,
    destructiveHint: def.mutating ? Boolean(def.destructive) : undefined,
    idempotentHint: def.mutating ? Boolean(def.idempotent) : undefined,
    openWorldHint: false,
  };

  // The SDK's generic signature is hard to satisfy with a generic wrapper; the
  // handler is still fully typed through ToolDef above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cb: any = async (args: z.infer<z.ZodObject<S>>) => {
    try {
      return await def.handler(args);
    } catch (err) {
      return errorResult(err);
    }
  };

  ctx.server.registerTool(name, { title: def.title, description: def.description, inputSchema: def.input, annotations }, cb);
}

// ---- Common schema pieces -------------------------------------------------

export const ITEM_TYPES = [
  "Movie",
  "Series",
  "Season",
  "Episode",
  "BoxSet",
  "MusicAlbum",
  "MusicArtist",
  "Audio",
  "MusicVideo",
  "Video",
  "Trailer",
  "Playlist",
  "Book",
  "AudioBook",
  "Photo",
  "PhotoAlbum",
  "Folder",
  "CollectionFolder",
  "LiveTvChannel",
  "LiveTvProgram",
  "Recording",
] as const;

export const SORT_BY = [
  "SortName",
  "Name",
  "DateCreated",
  "PremiereDate",
  "ProductionYear",
  "CommunityRating",
  "CriticRating",
  "DatePlayed",
  "PlayCount",
  "Runtime",
  "Random",
  "SeriesSortName",
  "Album",
  "AlbumArtist",
  "Artist",
  "IndexNumber",
  "ParentIndexNumber",
] as const;

export const itemId = z.string().min(1).describe("Jellyfin item id (GUID)");
export const itemTypes = z.array(z.enum(ITEM_TYPES)).optional().describe("Restrict to these item types");
export const limit = (def: number, max = 200) =>
  z.number().int().min(1).max(max).default(def).describe(`Max results (default ${def}, max ${max})`);
export const startIndex = z.number().int().min(0).default(0).describe("Offset for paging");
