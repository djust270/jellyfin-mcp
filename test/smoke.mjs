// End-to-end smoke test: starts a fake Jellyfin API, then drives the built
// server (dist/) over both stdio and streamable HTTP with the real MCP client.
// Run: npm run build && npm test
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const API_KEY = "test-api-key";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const calls = [];

const movie = {
  Id: "aaaa", Name: "Blade Runner", Type: "Movie", ProductionYear: 1982, RunTimeTicks: 117 * 60 * 10_000_000,
  CommunityRating: 7.9, Genres: ["Science Fiction"], Overview: "A blade runner must pursue replicants.",
  UserData: { Played: false, IsFavorite: true, PlaybackPositionTicks: 0 }, ImageTags: { Primary: "x" },
  MediaStreams: [
    { Type: "Video", Codec: "hevc", Width: 3840, Height: 2160, VideoRangeType: "HDR10" },
    { Type: "Audio", Index: 1, Language: "eng", Codec: "truehd", Channels: 8 },
    { Type: "Subtitle", Index: 3, Language: "eng", DisplayTitle: "English" },
  ],
};

const routes = {
  "GET /Users": () => [{ Id: USER_ID, Name: "admin", Policy: { IsAdministrator: true } }],
  "GET /Users/Me": () => ({ __status: 400 }),
  "GET /UserViews": () => ({ Items: [{ Id: "lib1", Name: "Movies", CollectionType: "movies" }] }),
  "GET /Items": () => ({ Items: [movie], TotalRecordCount: 1, StartIndex: 0 }),
  "GET /Items/aaaa": () => movie,
  "GET /System/Info": () => ({ ServerName: "mock", Version: "10.11.0", Id: "srv" }),
  "GET /Sessions": () => [{ Id: "sess1", UserName: "admin", Client: "Jellyfin Web", DeviceName: "TV", SupportsRemoteControl: true,
    NowPlayingItem: movie, PlayState: { PositionTicks: 600 * 10_000_000, IsPaused: true } }],
  "POST /Sessions/sess1/Playing": () => undefined,
  "POST /Sessions/sess1/Playing/Seek": () => undefined,
};

const jellyfin = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
  if (!req.headers.authorization?.includes(`Token="${API_KEY}"`)) {
    res.writeHead(401).end();
    return;
  }
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) {
    res.writeHead(404).end("not mocked");
    return;
  }
  const body = route();
  if (body?.__status) {
    res.writeHead(body.__status).end();
    return;
  }
  if (body === undefined) {
    res.writeHead(204).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
});
await new Promise((r) => jellyfin.listen(0, "127.0.0.1", r));
const JELLYFIN_URL = `http://127.0.0.1:${jellyfin.address().port}`;
const baseEnv = { ...process.env, JELLYFIN_URL, JELLYFIN_API_KEY: API_KEY };

const parse = (result) => JSON.parse(result.content[0].text);

async function exercise(client, label) {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["jellyfin_search", "jellyfin_browse", "jellyfin_get_item", "jellyfin_play", "jellyfin_list_sessions"]) {
    assert.ok(names.includes(n), `${label}: missing tool ${n}`);
  }

  const libs = parse(await client.callTool({ name: "jellyfin_list_libraries", arguments: {} }));
  assert.deepEqual(libs, [{ id: "lib1", name: "Movies", collectionType: "movies" }]);

  const search = parse(await client.callTool({ name: "jellyfin_search", arguments: { query: "blade", types: ["Movie"] } }));
  assert.equal(search.items[0].name, "Blade Runner");
  assert.equal(search.items[0].runtime, "1:57:00");
  const q = calls.findLast((c) => c.path === "/Items").query;
  assert.equal(q.searchTerm, "blade");
  assert.equal(q.includeItemTypes, "Movie");
  assert.equal(q.userId, USER_ID, "user id should resolve to first admin");

  const item = parse(await client.callTool({ name: "jellyfin_get_item", arguments: { itemId: "aaaa" } }));
  assert.equal(item.video.resolution, "3840x2160");
  assert.equal(item.subtitles[0].index, 3);
  assert.equal(item.imageUrl, `${JELLYFIN_URL}/Items/aaaa/Images/Primary`);

  const sessions = parse(await client.callTool({ name: "jellyfin_list_sessions", arguments: {} }));
  assert.equal(sessions[0].nowPlaying.position, "10:00");

  await client.callTool({ name: "jellyfin_play", arguments: { sessionId: "sess1", itemIds: ["aaaa"], startAtSeconds: 90 } });
  const play = calls.findLast((c) => c.path === "/Sessions/sess1/Playing").query;
  assert.equal(play.playCommand, "PlayNow");
  assert.equal(play.startPositionTicks, String(90 * 10_000_000));

  const badSeek = await client.callTool({ name: "jellyfin_playback_control", arguments: { sessionId: "sess1", command: "Seek" } });
  assert.equal(badSeek.isError, true);

  const notFound = await client.callTool({ name: "jellyfin_get_item", arguments: { itemId: "nope" } });
  assert.equal(notFound.isError, true);
  assert.match(notFound.content[0].text, /404/);

  console.log(`ok - ${label}: ${tools.length} tools, calls succeeded`);
}

// ---- stdio ----
{
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: baseEnv, stderr: "pipe" }));
  await exercise(client, "stdio");
  await client.close();
}

// ---- stdio read-only ----
{
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...baseEnv, JELLYFIN_READ_ONLY: "true" }, stderr: "pipe" }));
  const { tools } = await client.listTools();
  assert.ok(!tools.some((t) => t.name === "jellyfin_play"), "read-only should hide mutating tools");
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  console.log(`ok - read-only: ${tools.length} tools, none mutating`);
  await client.close();
}

// ---- streamable HTTP ----
{
  const PORT = 18000 + Math.floor(Math.random() * 1000);
  const TOKEN = "s3cret";
  const child = spawn(process.execPath, ["dist/index.js", "--transport", "http", "--port", String(PORT)], {
    env: { ...baseEnv, MCP_AUTH_TOKEN: TOKEN },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.stderr.on("data", (d) => String(d).includes("listening") && resolve());
    child.on("exit", (code) => reject(new Error(`http server exited ${code}`)));
  });
  const endpoint = new URL(`http://127.0.0.1:${PORT}/mcp`);

  try {
    const health = await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.json());
    assert.equal(health.status, "ok");

    const unauth = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(unauth.status, 401, "missing bearer token must be rejected");

    // fetch() won't let us override Host, so use node:http directly.
    const badHostStatus = await new Promise((resolve, reject) => {
      http
        .request(endpoint, { method: "POST", headers: { Host: "evil.example", Authorization: `Bearer ${TOKEN}` } }, (r) => {
          r.resume();
          resolve(r.statusCode);
        })
        .on("error", reject)
        .end();
    });
    assert.equal(badHostStatus, 403, "foreign Host header must be rejected");

    const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
    const client = new Client({ name: "smoke", version: "0" });
    await client.connect(transport);
    assert.ok(transport.sessionId, "session id issued");
    await exercise(client, "streamable HTTP");
    await transport.terminateSession();
    await client.close();

    const after = await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.json());
    assert.equal(after.sessions, 0, "DELETE should end the session");
    console.log("ok - HTTP auth, host check, session lifecycle");
  } finally {
    child.kill();
  }
}

jellyfin.close();
console.log("all smoke tests passed");
