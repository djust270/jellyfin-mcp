import { z } from "zod";
import { secondsToTicks, summarizeSession, type Dto } from "../jellyfin/format.js";
import { defineTool, json, text, type ToolContext } from "./shared.js";

const sessionId = z.string().min(1).describe("Session id from jellyfin_list_sessions");

export function registerPlaybackTools(ctx: ToolContext): void {
  const { jf } = ctx;

  defineTool(ctx, "jellyfin_list_sessions", {
    title: "Active sessions / now playing",
    description:
      "List connected client sessions with what each is playing, position, pause state and transcoding info. " +
      "Session ids are needed to remote-control a client.",
    input: {
      activeWithinSeconds: z.number().int().min(1).default(900).describe("Only sessions active within this many seconds"),
      nowPlayingOnly: z.boolean().default(false).describe("Only sessions that are currently playing something"),
      controllableOnly: z.boolean().default(false).describe("Only sessions this user can remote-control"),
    },
    handler: async ({ activeWithinSeconds, nowPlayingOnly, controllableOnly }) => {
      const userId = controllableOnly ? await jf.currentUserId() : undefined;
      let sessions = await jf.get<Dto[]>("/Sessions", { activeWithinSeconds, controllableByUserId: userId });
      if (nowPlayingOnly) sessions = sessions.filter((s) => s.NowPlayingItem);
      return json(sessions.map(summarizeSession));
    },
  });

  defineTool(ctx, "jellyfin_play", {
    title: "Play on a client",
    description:
      "Tell a client session to play one or more items (movie, episode, album, playlist ...). " +
      "Use PlayNext/PlayLast to queue, PlayShuffle to shuffle, PlayInstantMix for a music mix.",
    input: {
      sessionId,
      itemIds: z.array(z.string().min(1)).min(1).describe("Item ids to play, in order"),
      command: z.enum(["PlayNow", "PlayNext", "PlayLast", "PlayShuffle", "PlayInstantMix"]).default("PlayNow"),
      startAtSeconds: z.number().min(0).optional().describe("Start position in seconds (first item)"),
      audioStreamIndex: z.number().int().optional().describe("Audio stream index from jellyfin_get_item"),
      subtitleStreamIndex: z.number().int().optional().describe("Subtitle stream index from jellyfin_get_item (-1 = off)"),
    },
    mutating: true,
    handler: async (a) => {
      await jf.post(`/Sessions/${encodeURIComponent(a.sessionId)}/Playing`, {
        playCommand: a.command,
        itemIds: a.itemIds,
        startPositionTicks: a.startAtSeconds !== undefined ? secondsToTicks(a.startAtSeconds) : undefined,
        audioStreamIndex: a.audioStreamIndex,
        subtitleStreamIndex: a.subtitleStreamIndex,
      });
      return text(`Sent ${a.command} for ${a.itemIds.length} item(s) to session ${a.sessionId}.`);
    },
  });

  defineTool(ctx, "jellyfin_playback_control", {
    title: "Pause / resume / stop / seek",
    description: "Send a playback command to a client session.",
    input: {
      sessionId,
      command: z.enum(["PlayPause", "Pause", "Unpause", "Stop", "NextTrack", "PreviousTrack", "Seek", "Rewind", "FastForward"]),
      seekSeconds: z.number().min(0).optional().describe("Absolute position in seconds (required for Seek)"),
    },
    mutating: true,
    handler: async ({ sessionId, command, seekSeconds }) => {
      if (command === "Seek" && seekSeconds === undefined) throw new Error("seekSeconds is required for Seek");
      const userId = await jf.currentUserId();
      await jf.post(`/Sessions/${encodeURIComponent(sessionId)}/Playing/${command}`, {
        seekPositionTicks: seekSeconds !== undefined ? secondsToTicks(seekSeconds) : undefined,
        controllingUserId: userId,
      });
      return text(`Sent ${command} to session ${sessionId}.`);
    },
  });

  defineTool(ctx, "jellyfin_send_message", {
    title: "Show message on client",
    description: "Display a text message on a client's screen.",
    input: {
      sessionId,
      text: z.string().min(1).max(500),
      header: z.string().max(100).optional(),
      timeoutSeconds: z.number().int().min(1).max(300).optional().describe("Auto-dismiss after N seconds"),
    },
    mutating: true,
    handler: async ({ sessionId, text: msg, header, timeoutSeconds }) => {
      await jf.request("POST", `/Sessions/${encodeURIComponent(sessionId)}/Message`, {
        body: { Header: header ?? "Message", Text: msg, TimeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined },
      });
      return text(`Message sent to session ${sessionId}.`);
    },
  });
}
