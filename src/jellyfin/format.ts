/**
 * Turn raw Jellyfin DTOs into compact objects that are cheap for a model to read.
 * Jellyfin returns very large payloads; we keep only what is useful for reasoning.
 */

export const TICKS_PER_SECOND = 10_000_000;

export const secondsToTicks = (s: number) => Math.round(s * TICKS_PER_SECOND);
export const ticksToSeconds = (t?: number | null) => (t == null ? undefined : Math.round(t / TICKS_PER_SECOND));

function ticksToClock(t?: number | null): string | undefined {
  const s = ticksToSeconds(t);
  if (s === undefined) return undefined;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

function truncate(s: string | undefined | null, n: number): string | undefined {
  if (!s) return undefined;
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Remove undefined / null / empty-string / empty-array fields so output stays small. */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

// The Jellyfin DTOs are huge; type the subset we read loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Dto = Record<string, any>;

function userData(ud?: Dto) {
  if (!ud) return undefined;
  return compact({
    played: ud.Played || undefined,
    favorite: ud.IsFavorite || undefined,
    playCount: ud.PlayCount || undefined,
    progressPercent: ud.PlayedPercentage ? Math.round(ud.PlayedPercentage) : undefined,
    resumeAt: ud.PlaybackPositionTicks ? ticksToClock(ud.PlaybackPositionTicks) : undefined,
    unplayedCount: ud.UnplayedItemCount || undefined,
    lastPlayed: ud.LastPlayedDate,
  });
}

function episodeCode(i: Dto): string | undefined {
  if (i.Type !== "Episode") return undefined;
  const s = i.ParentIndexNumber != null ? `S${String(i.ParentIndexNumber).padStart(2, "0")}` : "";
  const e = i.IndexNumber != null ? `E${String(i.IndexNumber).padStart(2, "0")}` : "";
  return s + e || undefined;
}

/** Summary used in lists. */
export function summarizeItem(i: Dto, opts: { overviewChars?: number } = {}) {
  const ud = userData(i.UserData);
  return compact({
    id: i.Id as string,
    name: i.Name as string,
    type: i.Type as string,
    year: i.ProductionYear,
    series: i.SeriesName,
    seriesId: i.Type === "Episode" || i.Type === "Season" ? i.SeriesId : undefined,
    episode: episodeCode(i),
    album: i.Album,
    artists: i.Type === "Audio" || i.Type === "MusicAlbum" ? (i.AlbumArtist ?? i.Artists?.join(", ")) : undefined,
    // Series report RunTimeTicks = 0; treat that as unknown rather than "0:00".
    runtime: ticksToClock(i.RunTimeTicks || undefined),
    rating: i.CommunityRating ? Number(i.CommunityRating.toFixed(1)) : undefined,
    officialRating: i.OfficialRating,
    genres: i.Genres?.slice(0, 5),
    // Seasons come back with ChildCount = 0 but a correct RecursiveItemCount.
    childCount: i.IsFolder ? i.ChildCount || i.RecursiveItemCount || undefined : undefined,
    overview: opts.overviewChars ? truncate(i.Overview, opts.overviewChars) : undefined,
    userData: ud && Object.keys(ud).length ? ud : undefined,
  });
}

/** Detailed view used for a single item. */
export function detailItem(i: Dto) {
  const streams: Dto[] = i.MediaStreams ?? i.MediaSources?.[0]?.MediaStreams ?? [];
  const video = streams.find((s) => s.Type === "Video");
  return compact({
    ...summarizeItem(i),
    originalTitle: i.OriginalTitle !== i.Name ? i.OriginalTitle : undefined,
    overview: i.Overview,
    taglines: i.Taglines,
    premiereDate: i.PremiereDate?.slice(0, 10),
    endDate: i.EndDate?.slice(0, 10),
    status: i.Status,
    criticRating: i.CriticRating,
    genres: i.Genres,
    studios: i.Studios?.map((s: Dto) => s.Name),
    tags: i.Tags,
    people: i.People?.slice(0, 25).map((p: Dto) => compact({ name: p.Name, role: p.Role || undefined, type: p.Type, id: p.Id })),
    providerIds: i.ProviderIds && Object.keys(i.ProviderIds).length ? i.ProviderIds : undefined,
    path: i.Path,
    dateAdded: i.DateCreated?.slice(0, 10),
    parentId: i.ParentId,
    seasonId: i.SeasonId,
    video: video
      ? compact({ codec: video.Codec, resolution: video.Width && video.Height ? `${video.Width}x${video.Height}` : undefined, hdr: video.VideoRangeType !== "SDR" ? video.VideoRangeType : undefined })
      : undefined,
    audio: streams.filter((s) => s.Type === "Audio").map((s) => compact({ index: s.Index, lang: s.Language, codec: s.Codec, channels: s.Channels, title: s.DisplayTitle })),
    subtitles: streams.filter((s) => s.Type === "Subtitle").map((s) => compact({ index: s.Index, lang: s.Language, title: s.DisplayTitle, external: s.IsExternal || undefined })),
  });
}

export function summarizeSession(s: Dto) {
  const np = s.NowPlayingItem as Dto | undefined;
  const ps = (s.PlayState ?? {}) as Dto;
  return compact({
    sessionId: s.Id as string,
    user: s.UserName,
    client: s.Client,
    device: s.DeviceName,
    deviceId: s.DeviceId,
    remoteAddress: s.RemoteEndPoint,
    lastActivity: s.LastActivityDate,
    supportsRemoteControl: s.SupportsRemoteControl,
    nowPlaying: np
      ? compact({
          ...summarizeItem(np),
          position: ticksToClock(ps.PositionTicks),
          paused: ps.IsPaused || undefined,
          muted: ps.IsMuted || undefined,
          volume: ps.VolumeLevel,
          playMethod: ps.PlayMethod,
        })
      : undefined,
    transcoding: s.TranscodingInfo
      ? compact({
          video: s.TranscodingInfo.VideoCodec,
          audio: s.TranscodingInfo.AudioCodec,
          reasons: s.TranscodingInfo.TranscodeReasons,
          progress: s.TranscodingInfo.CompletionPercentage ? Math.round(s.TranscodingInfo.CompletionPercentage) : undefined,
        })
      : undefined,
  });
}

/** Standard fields to request so summaries have what they need. */
export const LIST_FIELDS = ["Overview", "Genres", "ChildCount", "RecursiveItemCount", "PrimaryImageAspectRatio"];
export const DETAIL_FIELDS = [
  "Overview",
  "Genres",
  "People",
  "Studios",
  "Tags",
  "Taglines",
  "ProviderIds",
  "Path",
  "DateCreated",
  "MediaStreams",
  "MediaSources",
  "ChildCount",
  "RecursiveItemCount",
  "OriginalTitle",
  "ParentId",
];
