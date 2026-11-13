import { z } from "zod";
import type { JellyfinClient } from "../jellyfin/client.js";
import { compact, type Dto } from "../jellyfin/format.js";
import { defineTool, itemId, json, limit, text, type ToolContext } from "./shared.js";

const IMAGE_TYPES = ["Primary", "Backdrop", "Logo", "Thumb", "Banner", "Art", "Disc", "Box", "BoxRear", "Screenshot", "Menu"] as const;
const PERSON_KINDS = [
  "Actor", "Director", "Writer", "Producer", "GuestStar", "Composer", "Creator", "Artist", "AlbumArtist",
  "Author", "Narrator", "Conductor", "Lyricist", "Arranger", "Engineer", "Mixer", "Remixer", "Editor",
  "Translator", "Illustrator", "Penciller", "Inker", "Colorist", "Letterer", "CoverArtist", "Unknown",
] as const;

/** Fields Jellyfin can lock against being overwritten by a metadata refresh. */
type LockableField = "Name" | "Overview" | "Genres" | "Tags" | "Studios" | "Cast" | "OfficialRating" | "ProductionLocations" | "Runtime";

/** Item types that support Jellyfin's "Identify" remote search. */
const IDENTIFY_TYPES: Record<string, string> = {
  Movie: "Movie",
  Series: "Series",
  BoxSet: "BoxSet",
  MusicAlbum: "MusicAlbum",
  MusicArtist: "MusicArtist",
  MusicVideo: "MusicVideo",
  Book: "Book",
  AudioBook: "Book",
  Person: "Person",
  Trailer: "Trailer",
};

const nullableText = z.string().nullable().optional();
const nullableNumber = (d: string) => z.number().nullable().optional().describe(`${d} (null clears)`);

/**
 * GET /Items/{id} returns the full DTO, which is exactly what POST /Items/{id}
 * expects back. Jellyfin's update replaces every editable field with what is
 * sent, so we always round-trip the complete object and only change the fields
 * the caller asked for.
 */
async function getFullItem(jf: JellyfinClient, id: string): Promise<Dto> {
  const userId = await jf.currentUserId();
  return jf.get<Dto>(`/Items/${encodeURIComponent(id)}`, { userId });
}

function metadataView(i: Dto) {
  return compact({
    id: i.Id,
    type: i.Type,
    name: i.Name,
    originalTitle: i.OriginalTitle,
    sortName: i.ForcedSortName,
    overview: i.Overview,
    taglines: i.Taglines,
    genres: i.Genres,
    tags: i.Tags,
    studios: i.Studios?.map((s: Dto) => s.Name),
    people: i.People?.map((p: Dto) => compact({ name: p.Name, type: p.Type, role: p.Role || undefined })),
    productionYear: i.ProductionYear,
    premiereDate: i.PremiereDate?.slice(0, 10),
    endDate: i.EndDate?.slice(0, 10),
    status: i.Status,
    officialRating: i.OfficialRating,
    customRating: i.CustomRating,
    communityRating: i.CommunityRating,
    criticRating: i.CriticRating,
    series: i.SeriesName,
    seasonNumber: i.Type === "Episode" ? i.ParentIndexNumber : undefined,
    indexNumber: i.IndexNumber,
    album: i.Album,
    albumArtist: i.AlbumArtist,
    artists: i.Artists,
    providerIds: i.ProviderIds && Object.keys(i.ProviderIds).length ? i.ProviderIds : undefined,
    preferredMetadataLanguage: i.PreferredMetadataLanguage,
    preferredMetadataCountryCode: i.PreferredMetadataCountryCode,
    lockAllMetadata: i.LockData || undefined,
    lockedFields: i.LockedFields,
    path: i.Path,
  });
}

/** Shallow diff of two metadata views, for reporting what an update changed. */
function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changes[k] = { from: before[k], to: after[k] };
  }
  return changes;
}

function mergeList(current: string[] | undefined, replace?: string[], add?: string[], remove?: string[]): string[] | undefined {
  if (replace === undefined && !add?.length && !remove?.length) return undefined;
  let next = replace ?? [...(current ?? [])];
  if (add?.length) for (const v of add) if (!next.some((x) => x.toLowerCase() === v.toLowerCase())) next.push(v);
  if (remove?.length) {
    const drop = new Set(remove.map((v) => v.toLowerCase()));
    next = next.filter((x) => !drop.has(x.toLowerCase()));
  }
  return next;
}

async function saveItem(jf: JellyfinClient, item: Dto, edited: LockableField[], lock: boolean): Promise<void> {
  if (lock && edited.length) {
    const locked = new Set<string>(item.LockedFields ?? []);
    for (const f of edited) locked.add(f);
    item.LockedFields = [...locked];
  }
  await jf.request("POST", `/Items/${encodeURIComponent(item.Id)}`, { body: item });
}

const LOCK_DESCRIPTION =
  "Lock the edited fields so a 'replace all metadata' refresh or re-identify won't overwrite them (default true). " +
  "Lockable: name, overview, genres, tags, studios, people, officialRating.";

export function registerMetadataTools(ctx: ToolContext): void {
  const { jf } = ctx;

  defineTool(ctx, "jellyfin_get_metadata", {
    title: "Get editable metadata",
    description:
      "The editable metadata of an item exactly as Jellyfin stores it (title, sort title, overview, genres, tags, studios, people, " +
      "dates, ratings, provider ids, locked fields), plus the valid parental ratings and external id types for this item. " +
      "Read this before jellyfin_update_metadata.",
    input: { itemId },
    handler: async ({ itemId }) => {
      const [item, editor] = await Promise.all([
        getFullItem(jf, itemId),
        jf.get<Dto>(`/Items/${encodeURIComponent(itemId)}/MetadataEditor`).catch(() => undefined),
      ]);
      return json({
        metadata: metadataView(item),
        options: editor
          ? compact({
              parentalRatings: [...new Set<string>((editor.ParentalRatingOptions ?? []).map((r: Dto) => r.Name))],
              externalIds: (editor.ExternalIdInfos ?? []).map((e: Dto) => compact({ key: e.Key, name: e.Name, type: e.Type })),
            })
          : undefined,
      });
    },
  });

  defineTool(ctx, "jellyfin_update_metadata", {
    title: "Edit metadata",
    description:
      "Edit an item's metadata. Only the fields you pass change; everything else is preserved. Lists (genres, tags, studios) " +
      "can be replaced outright or edited with add*/remove*. Pass an empty string or null to clear a text/number field. " +
      "providerIds are merged (set a key to an empty string to remove it). Returns the before/after of every changed field.",
    input: {
      itemId,
      name: z.string().min(1).optional(),
      originalTitle: nullableText,
      sortName: nullableText.describe("Forced sort title, e.g. 'Matrix, The'"),
      overview: nullableText,
      taglines: z.array(z.string()).optional(),
      genres: z.array(z.string()).optional().describe("Replace all genres"),
      addGenres: z.array(z.string()).optional(),
      removeGenres: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional().describe("Replace all tags"),
      addTags: z.array(z.string()).optional(),
      removeTags: z.array(z.string()).optional(),
      studios: z.array(z.string()).optional().describe("Replace all studios"),
      people: z
        .array(z.object({ name: z.string().min(1), type: z.enum(PERSON_KINDS).default("Actor"), role: z.string().optional() }))
        .optional()
        .describe("Replace the full cast & crew list"),
      productionYear: nullableNumber("Year"),
      premiereDate: nullableText.describe("YYYY-MM-DD (null clears)"),
      endDate: nullableText.describe("YYYY-MM-DD (null clears)"),
      officialRating: nullableText.describe("Parental rating, e.g. PG-13 / TV-MA (see jellyfin_get_metadata options)"),
      customRating: nullableText,
      communityRating: nullableNumber("0-10"),
      criticRating: nullableNumber("0-100"),
      indexNumber: nullableNumber("Episode/track number"),
      parentIndexNumber: nullableNumber("Season/disc number"),
      providerIds: z.record(z.string(), z.string()).optional().describe("e.g. {\"Tmdb\": \"603\", \"Imdb\": \"tt0133093\"}"),
      lockAllMetadata: z.boolean().optional().describe("Lock the whole item so refreshes never change it"),
      lockEditedFields: z.boolean().default(true).describe(LOCK_DESCRIPTION),
    },
    mutating: true,
    destructive: true,
    handler: async (a) => {
      const item = await getFullItem(jf, a.itemId);
      const before = metadataView(item);
      const edited: LockableField[] = [];
      const blankToNull = <T>(v: T | null | undefined) => (v === "" ? null : v);

      const setText = (key: string, value: string | null | undefined, lockAs?: LockableField) => {
        if (value === undefined) return;
        item[key] = blankToNull(value);
        if (lockAs) edited.push(lockAs);
      };
      setText("Name", a.name, "Name");
      setText("OriginalTitle", a.originalTitle);
      setText("ForcedSortName", a.sortName);
      setText("Overview", a.overview, "Overview");
      setText("OfficialRating", a.officialRating, "OfficialRating");
      setText("CustomRating", a.customRating);
      if (a.premiereDate !== undefined) item.PremiereDate = a.premiereDate ? new Date(a.premiereDate).toISOString() : null;
      if (a.endDate !== undefined) item.EndDate = a.endDate ? new Date(a.endDate).toISOString() : null;
      if (a.taglines !== undefined) item.Taglines = a.taglines;

      for (const [key, value] of [
        ["ProductionYear", a.productionYear],
        ["CommunityRating", a.communityRating],
        ["CriticRating", a.criticRating],
        ["IndexNumber", a.indexNumber],
        ["ParentIndexNumber", a.parentIndexNumber],
      ] as const) {
        if (value !== undefined) item[key] = value;
      }

      const genres = mergeList(item.Genres, a.genres, a.addGenres, a.removeGenres);
      if (genres) {
        item.Genres = genres;
        edited.push("Genres");
      }
      const tags = mergeList(item.Tags, a.tags, a.addTags, a.removeTags);
      if (tags) {
        item.Tags = tags;
        edited.push("Tags");
      }
      if (a.studios) {
        item.Studios = a.studios.map((Name) => ({ Name }));
        edited.push("Studios");
      }
      if (a.people) {
        item.People = a.people.map((p) => ({ Name: p.name, Type: p.type, Role: p.role ?? "" }));
        edited.push("Cast");
      }
      if (a.providerIds) {
        const ids: Record<string, string> = { ...(item.ProviderIds ?? {}) };
        for (const [k, v] of Object.entries(a.providerIds)) {
          if (v === "") delete ids[k];
          else ids[k] = v;
        }
        item.ProviderIds = ids;
      }
      if (a.lockAllMetadata !== undefined) item.LockData = a.lockAllMetadata;

      await saveItem(jf, item, edited, a.lockEditedFields);
      const after = metadataView(await getFullItem(jf, a.itemId));
      const changes = diff(before, after);
      return json({ itemId: a.itemId, name: after.name, changed: Object.keys(changes).length ? changes : "nothing changed" });
    },
  });

  defineTool(ctx, "jellyfin_bulk_edit_tags", {
    title: "Bulk add/remove tags & genres",
    description:
      "Add or remove tags and/or genres on many items at once (e.g. tag every Christmas movie 'holiday'). " +
      "Get item ids from jellyfin_search or jellyfin_browse. Other metadata is untouched.",
    input: {
      itemIds: z.array(z.string().min(1)).min(1).max(500),
      addTags: z.array(z.string()).optional(),
      removeTags: z.array(z.string()).optional(),
      addGenres: z.array(z.string()).optional(),
      removeGenres: z.array(z.string()).optional(),
      lockEditedFields: z.boolean().default(true).describe(LOCK_DESCRIPTION),
    },
    mutating: true,
    destructive: true,
    handler: async (a) => {
      if (!a.addTags?.length && !a.removeTags?.length && !a.addGenres?.length && !a.removeGenres?.length) {
        throw new Error("Nothing to do: pass at least one of addTags, removeTags, addGenres, removeGenres");
      }
      const results: Array<Record<string, unknown>> = [];
      for (const id of a.itemIds) {
        try {
          const item = await getFullItem(jf, id);
          const edited: LockableField[] = [];
          const tags = mergeList(item.Tags, undefined, a.addTags, a.removeTags);
          const genres = mergeList(item.Genres, undefined, a.addGenres, a.removeGenres);
          const tagsChanged = tags && JSON.stringify(tags) !== JSON.stringify(item.Tags ?? []);
          const genresChanged = genres && JSON.stringify(genres) !== JSON.stringify(item.Genres ?? []);
          if (!tagsChanged && !genresChanged) {
            results.push({ id, name: item.Name, status: "unchanged" });
            continue;
          }
          if (tagsChanged) {
            item.Tags = tags;
            edited.push("Tags");
          }
          if (genresChanged) {
            item.Genres = genres;
            edited.push("Genres");
          }
          await saveItem(jf, item, edited, a.lockEditedFields);
          results.push(compact({ id, name: item.Name, status: "updated", tags: tagsChanged ? tags : undefined, genres: genresChanged ? genres : undefined }));
        } catch (err) {
          results.push({ id, status: "error", error: (err as Error).message });
        }
      }
      const count = (s: string) => results.filter((r) => r.status === s).length;
      return json({ updated: count("updated"), unchanged: count("unchanged"), errors: count("error"), results });
    },
  });

  // ---- Identify: re-match an item against TMDb / TVDb / MusicBrainz ... ----

  defineTool(ctx, "jellyfin_identify_search", {
    title: "Find metadata matches",
    description:
      "Search online metadata providers (TMDb, TVDb, OMDb, MusicBrainz ...) for matches for a movie, series, box set, album, " +
      "artist, music video, book or person, e.g. to fix a wrong match. Defaults to the item's current name, year and ids. " +
      "Pass a result's providerIds to jellyfin_identify_apply.",
    input: {
      itemId,
      name: z.string().optional().describe("Title to search for (default: current name)"),
      year: z.number().int().optional(),
      providerIds: z.record(z.string(), z.string()).optional().describe("Search by id instead, e.g. {\"Tmdb\": \"603\"} or {\"Imdb\": \"tt0133093\"}"),
      provider: z.string().optional().describe("Limit to one provider, e.g. 'TheMovieDb'"),
      limit: limit(10, 50),
    },
    handler: async (a) => {
      const item = await getFullItem(jf, a.itemId);
      const kind = IDENTIFY_TYPES[item.Type];
      if (!kind) throw new Error(`Identify isn't supported for ${item.Type} items (supported: ${Object.keys(IDENTIFY_TYPES).join(", ")})`);

      const byId = a.providerIds && Object.keys(a.providerIds).length > 0;
      const results = await jf.request<Dto[]>("POST", `/Items/RemoteSearch/${kind}`, {
        body: {
          ItemId: item.Id,
          SearchProviderName: a.provider,
          SearchInfo: {
            Name: byId ? undefined : (a.name ?? item.Name),
            Year: byId ? undefined : (a.year ?? (a.name ? undefined : item.ProductionYear)),
            ProviderIds: byId ? a.providerIds : {},
            MetadataLanguage: item.PreferredMetadataLanguage,
            MetadataCountryCode: item.PreferredMetadataCountryCode,
          },
        },
        timeoutMs: 60_000,
      });
      return json({
        item: compact({ id: item.Id, type: item.Type, name: item.Name, year: item.ProductionYear, currentProviderIds: item.ProviderIds }),
        matches: results.slice(0, a.limit).map((r) =>
          compact({
            name: r.Name,
            year: r.ProductionYear,
            premiereDate: r.PremiereDate?.slice(0, 10),
            provider: r.SearchProviderName,
            providerIds: r.ProviderIds,
            overview: r.Overview ? (r.Overview.length > 200 ? `${r.Overview.slice(0, 199)}…` : r.Overview) : undefined,
            imageUrl: r.ImageUrl,
          }),
        ),
      });
    },
  });

  defineTool(ctx, "jellyfin_identify_apply", {
    title: "Apply metadata match",
    description:
      "Re-identify an item as the given match (providerIds from jellyfin_identify_search) and fully refresh its metadata from " +
      "the providers. This replaces the item's existing metadata (except locked fields) and, by default, its images.",
    input: {
      itemId,
      providerIds: z.record(z.string(), z.string()).refine((o) => Object.keys(o).length > 0, "at least one provider id").describe("e.g. {\"Tmdb\": \"603\"}"),
      name: z.string().optional().describe("Match name (informational)"),
      year: z.number().int().optional(),
      replaceAllImages: z.boolean().default(true),
    },
    mutating: true,
    destructive: true,
    handler: async (a) => {
      const before = await getFullItem(jf, a.itemId);
      await jf.request("POST", `/Items/RemoteSearch/Apply/${encodeURIComponent(a.itemId)}`, {
        query: { replaceAllImages: a.replaceAllImages },
        body: { Name: a.name, ProductionYear: a.year, ProviderIds: a.providerIds },
        timeoutMs: 180_000,
      });
      const after = await getFullItem(jf, a.itemId);
      return json({
        itemId: a.itemId,
        before: compact({ name: before.Name, year: before.ProductionYear, providerIds: before.ProviderIds }),
        after: compact({ name: after.Name, year: after.ProductionYear, providerIds: after.ProviderIds }),
        note: after.Name === before.Name ? "Refresh may still be finishing in the background; check again in a few seconds." : undefined,
      });
    },
  });

  // ---- Artwork ----

  defineTool(ctx, "jellyfin_list_images", {
    title: "List item images",
    description: "Artwork currently set on an item (poster/Primary, backdrops, logo, thumb, banner ...) with sizes and URLs.",
    input: { itemId },
    handler: async ({ itemId }) => {
      const images = await jf.get<Dto[]>(`/Items/${encodeURIComponent(itemId)}/Images`);
      return json(
        images.map((i) =>
          compact({
            type: i.ImageType,
            index: i.ImageIndex ?? undefined,
            size: i.Width && i.Height ? `${i.Width}x${i.Height}` : undefined,
            bytes: i.Size,
            url: `${jf.baseUrl}/Items/${itemId}/Images/${i.ImageType}${i.ImageIndex != null ? `/${i.ImageIndex}` : ""}`,
          }),
        ),
      );
    },
  });

  defineTool(ctx, "jellyfin_search_remote_images", {
    title: "Find artwork online",
    description: "Find candidate artwork for an item from the metadata providers (TMDb, Fanart.tv ...), best rated first.",
    input: {
      itemId,
      type: z.enum(IMAGE_TYPES).default("Primary").describe("Image type (Primary = poster/cover)"),
      provider: z.string().optional(),
      includeAllLanguages: z.boolean().default(false),
      limit: limit(10, 50),
    },
    handler: async (a) => {
      const res = await jf.get<Dto>(`/Items/${encodeURIComponent(a.itemId)}/RemoteImages`, {
        type: a.type,
        providerName: a.provider,
        includeAllLanguages: a.includeAllLanguages,
        limit: a.limit,
      });
      return json({
        total: res.TotalRecordCount,
        providers: res.Providers,
        images: (res.Images ?? []).map((i: Dto) =>
          compact({
            provider: i.ProviderName,
            url: i.Url,
            thumbnailUrl: i.ThumbnailUrl,
            size: i.Width && i.Height ? `${i.Width}x${i.Height}` : undefined,
            language: i.Language,
            rating: i.CommunityRating ? Number(i.CommunityRating.toFixed(1)) : undefined,
            votes: i.VoteCount || undefined,
          }),
        ),
      });
    },
  });

  defineTool(ctx, "jellyfin_set_image", {
    title: "Set artwork from URL",
    description:
      "Have Jellyfin download an image from a URL (usually one from jellyfin_search_remote_images) and set it as the item's " +
      "artwork of that type. Replaces the current Primary/Logo/etc.; Backdrops are added.",
    input: { itemId, type: z.enum(IMAGE_TYPES).default("Primary"), imageUrl: z.string().url() },
    mutating: true,
    destructive: true,
    handler: async ({ itemId, type, imageUrl }) => {
      await jf.post(`/Items/${encodeURIComponent(itemId)}/RemoteImages/Download`, { type, imageUrl });
      return text(`Set ${type} image for ${itemId}.`);
    },
  });

  defineTool(ctx, "jellyfin_delete_image", {
    title: "Delete artwork",
    description: "Remove an image from an item. For Backdrops/Screenshots pass the index from jellyfin_list_images.",
    input: { itemId, type: z.enum(IMAGE_TYPES), index: z.number().int().min(0).optional() },
    mutating: true,
    destructive: true,
    handler: async ({ itemId, type, index }) => {
      await jf.delete(`/Items/${encodeURIComponent(itemId)}/Images/${type}`, { imageIndex: index });
      return text(`Deleted ${type}${index != null ? ` #${index}` : ""} image from ${itemId}.`);
    },
  });
}
