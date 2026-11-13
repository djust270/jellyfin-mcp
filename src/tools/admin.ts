import { z } from "zod";
import { compact, type Dto } from "../jellyfin/format.js";
import { defineTool, json, limit, text, type ToolContext } from "./shared.js";

export function registerAdminTools(ctx: ToolContext): void {
  const { jf } = ctx;

  defineTool(ctx, "jellyfin_get_system_info", {
    title: "Server info",
    description: "Jellyfin server name, version, OS and status (pending restart, update available). Full details need an admin token.",
    input: {},
    handler: async () => {
      const info = await jf.get<Dto>("/System/Info").catch(() => jf.get<Dto>("/System/Info/Public"));
      return json(
        compact({
          serverName: info.ServerName,
          version: info.Version,
          id: info.Id,
          // OperatingSystem* are blank on Jellyfin 10.11+; architecture is still reported.
          os: info.OperatingSystemDisplayName || info.OperatingSystem || undefined,
          architecture: info.SystemArchitecture,
          localAddress: info.LocalAddress,
          hasPendingRestart: info.HasPendingRestart,
          hasUpdateAvailable: info.HasUpdateAvailable,
          isShuttingDown: info.IsShuttingDown || undefined,
          transcodingTempPath: info.TranscodingTempPath,
          actingAsUserId: await jf.currentUserId(),
        }),
      );
    },
  });

  defineTool(ctx, "jellyfin_list_users", {
    title: "List users",
    description: "List Jellyfin users with admin/disabled flags and last activity (admin only).",
    input: {},
    handler: async () => {
      const users = await jf.get<Dto[]>("/Users");
      return json(
        users.map((u) =>
          compact({
            id: u.Id,
            name: u.Name,
            admin: u.Policy?.IsAdministrator || undefined,
            disabled: u.Policy?.IsDisabled || undefined,
            lastActivity: u.LastActivityDate,
            lastLogin: u.LastLoginDate,
          }),
        ),
      );
    },
  });

  defineTool(ctx, "jellyfin_get_activity_log", {
    title: "Activity log",
    description: "Recent server activity: logins, playback started/stopped, library changes, errors (admin only).",
    input: {
      limit: limit(30, 200),
      sinceHours: z.number().min(0).optional().describe("Only entries from the last N hours"),
      userActivityOnly: z.boolean().optional().describe("true = only user-triggered entries, false = only system entries"),
    },
    handler: async ({ limit, sinceHours, userActivityOnly }) => {
      const res = await jf.get<{ Items: Dto[]; TotalRecordCount: number }>("/System/ActivityLog/Entries", {
        limit,
        minDate: sinceHours !== undefined ? new Date(Date.now() - sinceHours * 3_600_000).toISOString() : undefined,
        hasUserId: userActivityOnly,
      });
      return json(res.Items.map((e) => compact({ date: e.Date, severity: e.Severity, type: e.Type, name: e.Name, detail: e.ShortOverview ?? e.Overview })));
    },
  });

  defineTool(ctx, "jellyfin_list_scheduled_tasks", {
    title: "Scheduled tasks",
    description: "List scheduled tasks (library scan, metadata refresh, cleanup ...) with state and last result (admin only).",
    input: {},
    handler: async () => {
      const tasks = await jf.get<Dto[]>("/ScheduledTasks", { isHidden: false });
      return json(
        tasks.map((t) =>
          compact({
            id: t.Id,
            key: t.Key,
            name: t.Name,
            category: t.Category,
            state: t.State,
            progress: t.CurrentProgressPercentage != null ? Math.round(t.CurrentProgressPercentage) : undefined,
            lastResult: t.LastExecutionResult ? compact({ status: t.LastExecutionResult.Status, ended: t.LastExecutionResult.EndTimeUtc, error: t.LastExecutionResult.ErrorMessage }) : undefined,
          }),
        ),
      );
    },
  });

  defineTool(ctx, "jellyfin_run_scheduled_task", {
    title: "Run scheduled task",
    description: "Start a scheduled task now by id (from jellyfin_list_scheduled_tasks). Admin only.",
    input: { taskId: z.string().min(1) },
    mutating: true,
    handler: async ({ taskId }) => {
      await jf.post(`/ScheduledTasks/Running/${encodeURIComponent(taskId)}`);
      return text(`Started task ${taskId}.`);
    },
  });

  defineTool(ctx, "jellyfin_refresh_library", {
    title: "Scan library / refresh metadata",
    description:
      "Without itemId: start a full library scan for new/removed media. With itemId: refresh metadata for that item " +
      "(and its children), optionally replacing existing metadata/images. Admin only.",
    input: {
      itemId: z.string().optional(),
      replaceAllMetadata: z.boolean().default(false),
      replaceAllImages: z.boolean().default(false),
    },
    mutating: true,
    handler: async ({ itemId, replaceAllMetadata, replaceAllImages }) => {
      if (!itemId) {
        await jf.post("/Library/Refresh");
        return text("Library scan started.");
      }
      const full = replaceAllMetadata || replaceAllImages;
      await jf.post(`/Items/${encodeURIComponent(itemId)}/Refresh`, {
        metadataRefreshMode: full ? "FullRefresh" : "Default",
        imageRefreshMode: full ? "FullRefresh" : "Default",
        replaceAllMetadata,
        replaceAllImages,
      });
      return text(`Metadata refresh queued for ${itemId}.`);
    },
  });
}
