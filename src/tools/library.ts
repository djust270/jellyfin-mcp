import { z } from "zod";
import { DETAIL_FIELDS, LIST_FIELDS, detailItem, summarizeItem, type Dto } from "../jellyfin/format.js";
import { defineTool, itemId, itemTypes, json, limit, SORT_BY, startIndex, type ToolContext } from "./shared.js";

interface ItemsResult {
  Items: Dto[];
  TotalRecordCount?: number;
  StartIndex?: number;
}

const DEFAULT_SEARCH_TYPES = ["Movie", "Series", "Episode", "BoxSet", "MusicAlbum", "MusicArtist", "Audio", "MusicVideo", "Playlist", "Book", "AudioBook"];

export function registerLibraryTools(ctx: ToolContext): void {
  const { jf } = ctx;

  defineTool(ctx, "jellyfin_list_libraries", {
    title: "List libraries",
    description: "List the user's Jellyfin libraries (Movies, Shows, Music, ...) with their ids. Use a library id as parentId in jellyfin_browse.",
    input: {},
    handler: async () => {
      const userId = await jf.currentUserId();
      const res = await jf.get<ItemsResult>("/UserViews", { userId });
      return json(res.Items.map((v) => ({ id: v.Id, name: v.Name, collectionType: v.CollectionType ?? "mixed" })));
    },
  });

  defineTool(ctx, "jellyfin_search", {
    title: "Search library",
    description: "Full-text search across the library by title. Returns compact item summaries with ids for follow-up calls.",
    input: {
      query: z.string().min(1).describe("Text to search for"),
      types: itemTypes,
      limit: limit(20, 100),
    },
    handler: async ({ query, types, limit }) => {
      const userId = await jf.currentUserId();
      const res = await jf.get<ItemsResult>("/Items", {
        userId,
        searchTerm: query,
        recursive: true,
        includeItemTypes: types?.length ? types : DEFAULT_SEARCH_TYPES,
        limit,
        fields: LIST_FIELDS,
        enableUserData: true,
        enableImages: false,
      });
      return json({ total: res.TotalRecordCount, items: res.Items.map((i) => summarizeItem(i, { overviewChars: 160 })) });
    },
  });

  defineTool(ctx, "jellyfin_browse", {
    title: "Browse / filter items",
    description:
      "Query library items with filters and sorting. Use parentId (a library, folder, box set, album ...) to scope; " +
      "set recursive=false to list only direct children. Good for 'unwatched sci-fi movies from the 90s', 'recently added', 'top rated', etc.",
    input: {
      parentId: z.string().optional().describe("Library/folder/collection id to search within"),
      types: itemTypes,
      recursive: z.boolean().default(true).describe("Include all descendants (default true)"),
      genres: z.array(z.string()).optional().describe("Match any of these genre names"),
      years: z.array(z.number().int()).optional().describe("Production years"),
      person: z.string().optional().describe("Actor/director name"),
      studios: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      nameStartsWith: z.string().optional(),
      isPlayed: z.boolean().optional().describe("true = watched only, false = unwatched only"),
      isFavorite: z.boolean().optional(),
      isResumable: z.boolean().optional().describe("Only partially played items"),
      minCommunityRating: z.number().min(0).max(10).optional(),
      sortBy: z.array(z.enum(SORT_BY)).optional().describe("Sort keys (default SortName)"),
      sortOrder: z.enum(["Ascending", "Descending"]).default("Ascending"),
      includeOverview: z.boolean().default(false).describe("Include a short plot overview per item"),
      limit: limit(25),
      startIndex,
    },
    handler: async (a) => {
      const userId = await jf.currentUserId();
      const filters = a.isResumable ? ["IsResumable"] : undefined;
      const res = await jf.get<ItemsResult>("/Items", {
        userId,
        parentId: a.parentId,
        includeItemTypes: a.types,
        recursive: a.recursive,
        genres: a.genres,
        years: a.years,
        person: a.person,
        studios: a.studios,
        tags: a.tags,
        nameStartsWith: a.nameStartsWith,
        isPlayed: a.isPlayed,
        isFavorite: a.isFavorite,
        filters,
        minCommunityRating: a.minCommunityRating,
        sortBy: a.sortBy?.length ? a.sortBy : ["SortName"],
        sortOrder: a.sortOrder,
        limit: a.limit,
        startIndex: a.startIndex,
        fields: LIST_FIELDS,
        enableUserData: true,
        enableImages: false,
      });
      return json({
        total: res.TotalRecordCount,
        startIndex: res.StartIndex ?? a.startIndex,
        returned: res.Items.length,
        items: res.Items.map((i) => summarizeItem(i, { overviewChars: a.includeOverview ? 200 : undefined })),
      });
    },
  });

  defineTool(ctx, "jellyfin_get_item", {
    title: "Get item details",
    description: "Full details for one item: overview, cast, genres, studios, provider ids, media streams (audio/subtitle indexes), watch state and an image URL.",
    input: { itemId },
    handler: async ({ itemId }) => {
      const userId = await jf.currentUserId();
      const item = await jf.get<Dto>(`/Items/${encodeURIComponent(itemId)}`, { userId, fields: DETAIL_FIELDS });
      return json({ ...detailItem(item), imageUrl: item.ImageTags?.Primary ? `${jf.baseUrl}/Items/${item.Id}/Images/Primary` : undefined });
    },
  });

  defineTool(ctx, "jellyfin_get_seasons", {
    title: "List seasons of a series",
    description: "List the seasons of a TV series.",
    input: { seriesId: z.string().min(1).describe("Series item id") },
    handler: async ({ seriesId }) => {
      const userId = await jf.currentUserId();
      const res = await jf.get<ItemsResult>(`/Shows/${encodeURIComponent(seriesId)}/Seasons`, { userId, enableUserData: true, fields: ["ChildCount", "RecursiveItemCount"] });
      return json(res.Items.map((i) => summarizeItem(i)));
    },
  });

  defineTool(ctx, "jellyfin_get_episodes", {
    title: "List episodes of a series",
    description: "List episodes of a TV series, optionally for a single season (by number or seasonId).",
    input: {
      seriesId: z.string().min(1).describe("Series item id"),
      season: z.number().int().min(0).optional().describe("Season number (0 = specials)"),
      seasonId: z.string().optional(),
      includeOverview: z.boolean().default(false),
      limit: limit(100, 500),
      startIndex,
    },
    handler: async (a) => {
      const userId = await jf.currentUserId();
      const res = await jf.get<ItemsResult>(`/Shows/${encodeURIComponent(a.seriesId)}/Episodes`, {
        userId,
        season: a.season,
        seasonId: a.seasonId,
        limit: a.limit,
        startIndex: a.startIndex,
        fields: a.includeOverview ? ["Overview"] : undefined,
        enableUserData: true,
        enableImages: false,
      });
      return json({
        total: res.TotalRecordCount,
        items: res.Items.map((i) => summarizeItem(i, { overviewChars: a.includeOverview ? 200 : undefined })),
      });
    },
  });

  defineTool(ctx, "jellyfin_get_similar", {
    title: "Find similar items",
    description: "Items similar to the given movie, series, album or artist.",
    input: { itemId, limit: limit(12, 50) },
    handler: async ({ itemId, limit }) => {
      const userId = await jf.currentUserId();
      const res = await jf.get<ItemsResult>(`/Items/${encodeURIComponent(itemId)}/Similar`, { userId, limit, fields: LIST_FIELDS });
      return json(res.Items.map((i) => summarizeItem(i, { overviewChars: 140 })));
    },
  });

  defineTool(ctx, "jellyfin_list_genres", {
    title: "List genres",
    description: "List genres present in the library (optionally within a library/folder or for certain item types).",
    input: { parentId: z.string().optional(), types: itemTypes, limit: limit(100, 500) },
    handler: async ({ parentId, types, limit }) => {
      const userId = await jf.currentUserId();
      const res = await jf.get<ItemsResult>("/Genres", { userId, parentId, includeItemTypes: types, limit, enableImages: false, sortBy: ["SortName"] });
      return json(res.Items.map((g) => g.Name));
    },
  });

  // ---- "Home screen" style discovery ----

  defineTool(ctx, "jellyfin_get_latest", {
    title: "Recently added",
    description: "Most recently added items, optionally within one library. Episodes are grouped by series by default.",
    input: {
      parentId: z.string().optional().describe("Library id"),
      types: itemTypes,
      groupItems: z.boolean().default(true).describe("Group new episodes/tracks under their series/album"),
      limit: limit(20, 100),
    },
    handler: async ({ parentId, types, groupItems, limit }) => {
      const userId = await jf.currentUserId();
      const items = await jf.get<Dto[]>("/Items/Latest", { userId, parentId, includeItemTypes: types, groupItems, limit, fields: LIST_FIELDS, enableImages: false });
      return json(items.map((i) => summarizeItem(i)));
    },
  });

  defineTool(ctx, "jellyfin_continue_watching", {
    title: "Continue watching",
    description: "Partially played items the user can resume, most recent first.",
    input: { mediaType: z.enum(["Video", "Audio", "Book"]).optional(), limit: limit(20, 100) },
    handler: async ({ mediaType, limit }) => {
      const userId = await jf.currentUserId();
      const res = await jf.get<ItemsResult>("/UserItems/Resume", { userId, mediaTypes: mediaType ? [mediaType] : undefined, limit, enableImages: false, enableUserData: true });
      return json(res.Items.map((i) => summarizeItem(i)));
    },
  });

  defineTool(ctx, "jellyfin_next_up", {
    title: "Next up episodes",
    description: "Next unwatched episode for each series the user is watching (or for one series).",
    input: { seriesId: z.string().optional(), limit: limit(20, 100) },
    handler: async ({ seriesId, limit }) => {
      const userId = await jf.currentUserId();
      const res = await jf.get<ItemsResult>("/Shows/NextUp", { userId, seriesId, limit, enableImages: false, enableUserData: true });
      return json(res.Items.map((i) => summarizeItem(i)));
    },
  });

  // ---- User data ----

  defineTool(ctx, "jellyfin_set_played", {
    title: "Mark played / unplayed",
    description: "Mark an item (movie, episode, whole season or series) as watched or unwatched for the user.",
    input: { itemId, played: z.boolean().describe("true = mark watched, false = mark unwatched") },
    mutating: true,
    idempotent: true,
    handler: async ({ itemId, played }) => {
      const userId = await jf.currentUserId();
      const path = `/UserPlayedItems/${encodeURIComponent(itemId)}`;
      const ud = played ? await jf.post<Dto>(path, { userId }) : await jf.delete<Dto>(path, { userId });
      return json({ itemId, played: ud?.Played ?? played });
    },
  });

  defineTool(ctx, "jellyfin_set_favorite", {
    title: "Favorite / unfavorite",
    description: "Add or remove an item from the user's favorites.",
    input: { itemId, favorite: z.boolean() },
    mutating: true,
    idempotent: true,
    handler: async ({ itemId, favorite }) => {
      const userId = await jf.currentUserId();
      const path = `/UserFavoriteItems/${encodeURIComponent(itemId)}`;
      const ud = favorite ? await jf.post<Dto>(path, { userId }) : await jf.delete<Dto>(path, { userId });
      return json({ itemId, favorite: ud?.IsFavorite ?? favorite });
    },
  });
}
