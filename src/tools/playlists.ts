import { z } from "zod";
import { compact, summarizeItem, type Dto } from "../jellyfin/format.js";
import { defineTool, json, limit, startIndex, type ToolContext } from "./shared.js";

interface ItemsResult {
  Items: Dto[];
  TotalRecordCount?: number;
}

const playlistId = z.string().min(1).describe("Playlist item id");

export function registerPlaylistTools(ctx: ToolContext): void {
  const { jf } = ctx;

  defineTool(ctx, "jellyfin_list_playlists", {
    title: "List playlists",
    description: "List the user's playlists.",
    input: { limit: limit(50) },
    handler: async ({ limit }) => {
      const userId = await jf.currentUserId();
      const res = await jf.get<ItemsResult>("/Items", { userId, includeItemTypes: ["Playlist"], recursive: true, sortBy: ["SortName"], limit, fields: ["ChildCount"], enableImages: false });
      return json(
        res.Items.map((p) => compact({ id: p.Id, name: p.Name, mediaType: p.MediaType !== "Unknown" ? p.MediaType : undefined, itemCount: p.ChildCount })),
      );
    },
  });

  defineTool(ctx, "jellyfin_get_playlist_items", {
    title: "Get playlist items",
    description: "List the entries of a playlist. Each entry has a playlistItemId used for removal.",
    input: { playlistId, limit: limit(100, 500), startIndex },
    handler: async ({ playlistId, limit, startIndex }) => {
      const userId = await jf.currentUserId();
      const res = await jf.get<ItemsResult>(`/Playlists/${encodeURIComponent(playlistId)}/Items`, { userId, limit, startIndex, enableImages: false, enableUserData: true });
      return json({ total: res.TotalRecordCount, items: res.Items.map((i) => ({ ...summarizeItem(i), playlistItemId: i.PlaylistItemId })) });
    },
  });

  defineTool(ctx, "jellyfin_create_playlist", {
    title: "Create playlist",
    description: "Create a new playlist, optionally seeded with items.",
    input: {
      name: z.string().min(1),
      itemIds: z.array(z.string()).optional(),
      mediaType: z.enum(["Video", "Audio", "Book", "Photo"]).optional(),
      isPublic: z.boolean().optional(),
    },
    mutating: true,
    handler: async ({ name, itemIds, mediaType, isPublic }) => {
      const userId = await jf.currentUserId();
      const res = await jf.request<{ Id: string }>("POST", "/Playlists", {
        body: { Name: name, Ids: itemIds ?? [], UserId: userId, MediaType: mediaType, IsPublic: isPublic },
      });
      return json({ playlistId: res.Id, name });
    },
  });

  defineTool(ctx, "jellyfin_add_to_playlist", {
    title: "Add to playlist",
    description: "Append items to a playlist.",
    input: { playlistId, itemIds: z.array(z.string().min(1)).min(1) },
    mutating: true,
    handler: async ({ playlistId, itemIds }) => {
      const userId = await jf.currentUserId();
      await jf.post(`/Playlists/${encodeURIComponent(playlistId)}/Items`, { ids: itemIds, userId });
      return json({ playlistId, added: itemIds.length });
    },
  });

  defineTool(ctx, "jellyfin_remove_from_playlist", {
    title: "Remove from playlist",
    description: "Remove entries from a playlist by playlistItemId (from jellyfin_get_playlist_items, not the media item id).",
    input: { playlistId, playlistItemIds: z.array(z.string().min(1)).min(1) },
    mutating: true,
    destructive: true,
    handler: async ({ playlistId, playlistItemIds }) => {
      await jf.delete(`/Playlists/${encodeURIComponent(playlistId)}/Items`, { entryIds: playlistItemIds });
      return json({ playlistId, removed: playlistItemIds.length });
    },
  });
}
