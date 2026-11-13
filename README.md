# jellyfin-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Jellyfin](https://jellyfin.org), written in TypeScript.
It runs over **stdio** for local clients like Claude Desktop and Claude Code, or over **streamable HTTP** so you can host it on your network.

With it, an assistant can search and browse your library, see what's playing, control playback on your TVs and apps, fix and edit metadata and artwork, manage playlists and watch state, and run admin tasks.

## Setup

```bash
npm install
npm run build
```

Requires Node 20+. Built against the Jellyfin 10.11 API (`openapi.json` in this repo).

### Authentication

Use one of these:

| Option | Env vars | Notes |
|---|---|---|
| API key | `JELLYFIN_API_KEY` | Create in **Dashboard → API Keys**. Gives admin access. An API key isn't tied to a user, so set `JELLYFIN_USERNAME` or `JELLYFIN_USER_ID` to choose whose library, watch state and favorites to use. Otherwise the server uses the first admin. |
| User login | `JELLYFIN_USERNAME` + `JELLYFIN_PASSWORD` | Logs in on the first call and acts as that user. Admin tools only work if the user is an admin. |

Set `JELLYFIN_READ_ONLY=true` to hide every tool that changes state (playback control, played/favorite, playlists, scans).

## Running

### stdio (default)

```bash
JELLYFIN_URL=http://localhost:8096 JELLYFIN_API_KEY=... node dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "jellyfin": {
      "command": "node",
      "args": ["C:\\Users\\Dave\\Jellyfin-MCP\\dist\\index.js"],
      "env": {
        "JELLYFIN_URL": "http://localhost:8096",
        "JELLYFIN_API_KEY": "your-api-key",
        "JELLYFIN_USERNAME": "your-username"
      }
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add jellyfin -e JELLYFIN_URL=http://localhost:8096 -e JELLYFIN_API_KEY=your-api-key -- node C:/Users/Dave/Jellyfin-MCP/dist/index.js
```

### Streamable HTTP

```bash
MCP_AUTH_TOKEN=change-me JELLYFIN_URL=... JELLYFIN_API_KEY=... node dist/index.js --transport http --port 8787
```

- Endpoint: `http://127.0.0.1:8787/mcp` (POST, GET for the SSE stream, DELETE to end a session). Each client gets its own `Mcp-Session-Id`. Idle sessions are dropped after 30 minutes.
- Health check: `GET /healthz`
- With `MCP_AUTH_TOKEN` set, every request must send `Authorization: Bearer <token>`.
- By default the server binds to `127.0.0.1` and rejects requests whose `Host` header isn't a loopback name (DNS rebinding protection). To expose it on your LAN, set `MCP_HTTP_HOST=0.0.0.0`, `MCP_AUTH_TOKEN`, and `MCP_ALLOWED_HOSTS=<the hostname clients use>`. The server logs a warning if you bind to a non-loopback address without a token.

Claude Code over HTTP:

```bash
claude mcp add --transport http jellyfin http://127.0.0.1:8787/mcp --header "Authorization: Bearer change-me"
```

### Debugging

```bash
npm run inspect
```

This opens the MCP Inspector against the stdio build. Logs go to stderr, because stdout is reserved for the protocol.

## Tools

| Area | Tool | What it does |
|---|---|---|
| Library | `jellyfin_list_libraries` | Libraries and their ids |
| | `jellyfin_search` | Title search across the library |
| | `jellyfin_browse` | Filter and sort by library, type, genre, year, person, studio, tags, watched, favorite, rating; paged |
| | `jellyfin_get_item` | Full details: cast, streams (audio and subtitle indexes), provider ids, image URL |
| | `jellyfin_get_seasons` / `jellyfin_get_episodes` | TV structure |
| | `jellyfin_get_similar` | Recommendations |
| | `jellyfin_list_genres` | Genres in the library or in one library |
| Discovery | `jellyfin_get_latest` | Recently added |
| | `jellyfin_continue_watching` | Items you can resume |
| | `jellyfin_next_up` | Next episode of each series you're watching |
| User data ✎ | `jellyfin_set_played`, `jellyfin_set_favorite` | Watched and favorite state |
| Playback | `jellyfin_list_sessions` | Connected clients, what's playing, position, transcode info |
| ✎ | `jellyfin_play` | Play now, queue next or last, shuffle, instant mix; optional start time and audio/subtitle track |
| ✎ | `jellyfin_playback_control` | Pause, unpause, stop, seek, next, previous |
| ✎ | `jellyfin_send_message` | Show a message on screen |
| Playlists | `jellyfin_list_playlists`, `jellyfin_get_playlist_items` | |
| ✎ | `jellyfin_create_playlist`, `jellyfin_add_to_playlist`, `jellyfin_remove_from_playlist` | |
| Metadata | `jellyfin_get_metadata` | Editable fields as stored, plus the valid parental ratings and external id types |
| ✎ | `jellyfin_update_metadata` | Edit title, sort title, overview, taglines, genres, tags, studios, cast and crew, dates, ratings, episode/season numbers, provider ids; returns a before/after diff |
| ✎ | `jellyfin_bulk_edit_tags` | Add or remove tags and genres across many items |
| | `jellyfin_identify_search` | Search TMDb, TVDb, MusicBrainz and other providers for the correct match |
| ✎ | `jellyfin_identify_apply` | Re-match the item and pull fresh metadata (Jellyfin's "Identify") |
| | `jellyfin_list_images`, `jellyfin_search_remote_images` | Current artwork, and candidate artwork from the providers |
| ✎ | `jellyfin_set_image`, `jellyfin_delete_image` | Set artwork from a URL, or remove it |
| Admin | `jellyfin_get_system_info`, `jellyfin_list_users`, `jellyfin_get_activity_log`, `jellyfin_list_scheduled_tasks` | |
| ✎ | `jellyfin_run_scheduled_task`, `jellyfin_refresh_library` | Run a scheduled task, start a library scan, or refresh one item's metadata |

✎ = changes state; hidden when `JELLYFIN_READ_ONLY=true`. Every tool sets MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).

### How metadata edits work

Jellyfin's update endpoint (`POST /Items/{id}`) overwrites every editable field with what it receives, so a request that leaves a field out clears it. `jellyfin_update_metadata` and `jellyfin_bulk_edit_tags` therefore read the full item, change only the fields you asked for, and send the complete item back. The smoke test enforces this: its fake server applies the same overwrite rule and checks that untouched fields survive.

By default, edited fields that Jellyfin can lock (name, overview, genres, tags, studios, cast, official rating) are locked. That way a "replace all metadata" refresh or a re-identify won't undo your edits. Pass `lockEditedFields: false` to skip locking. Most metadata calls need an admin token or an admin user.

Responses are compact JSON summaries rather than raw Jellyfin payloads, to keep token use down. Times are shown as `h:mm:ss`, and positions are passed in as seconds; the server converts to and from Jellyfin ticks.

## Project layout

```
src/
  index.ts              CLI entry: parses flags and picks a transport
  config.ts             env and flag configuration
  server.ts             builds the McpServer and registers tools
  jellyfin/client.ts    REST client: auth, user resolution, errors
  jellyfin/format.ts    trims DTOs into compact summaries
  tools/                library, playback, playlists, metadata, admin
  transports/stdio.ts
  transports/http.ts    Express + StreamableHTTPServerTransport, sessions, auth
test/smoke.mjs          end-to-end test against a fake Jellyfin, over both transports
```

To add a tool, call `defineTool(ctx, name, { title, description, input, mutating?, handler })` in a file under `src/tools/`. Errors thrown in a handler come back to the client as `isError` results.

## Tests

```bash
npm run build && npm test
```

The smoke test starts a fake Jellyfin API and runs the built server over stdio, in read-only mode, and over HTTP. For HTTP it also checks bearer auth, Host-header rejection, and session teardown.
