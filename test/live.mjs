// Live check against a real Jellyfin server. Reads settings from .env.
// Forces JELLYFIN_READ_ONLY so nothing on the server or your clients changes.
// Run: npm run build && npm run test:live
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.JELLYFIN_URL) {
  console.error("Set JELLYFIN_URL and credentials in .env (see .env.example)");
  process.exit(1);
}
const env = { ...process.env, JELLYFIN_READ_ONLY: "true" };

let failures = 0;
const parse = (r) => {
  try {
    return JSON.parse(r.content[0].text);
  } catch {
    return r.content[0].text;
  }
};
const preview = (v) => {
  const s = JSON.stringify(v);
  return s.length > 220 ? `${s.slice(0, 220)}…` : s;
};

async function call(client, name, args = {}) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const ms = Date.now() - t;
  const data = parse(r);
  if (r.isError) {
    failures++;
    console.log(`  FAIL ${name} (${ms}ms): ${data}`);
  } else {
    console.log(`  ok   ${name} (${ms}ms, ${r.content[0].text.length} chars): ${preview(data)}`);
  }
  return r.isError ? undefined : data;
}

async function exercise(client, label) {
  console.log(`\n== ${label} ==`);
  const { tools } = await client.listTools();
  console.log(`  ${tools.length} tools listed`);

  await call(client, "jellyfin_get_system_info");
  const libs = await call(client, "jellyfin_list_libraries");
  const search = await call(client, "jellyfin_search", { query: "the", limit: 5 });
  const movies = await call(client, "jellyfin_browse", { types: ["Movie"], sortBy: ["DateCreated"], sortOrder: "Descending", limit: 5 });
  const movie = movies?.items?.[0];
  if (movie) {
    const detail = await call(client, "jellyfin_get_item", { itemId: movie.id });
    if (detail && !detail.audio?.length) console.log("  note: movie detail has no audio streams listed");
  }
  if (libs?.[0]) await call(client, "jellyfin_browse", { parentId: libs[0].id, recursive: false, limit: 5 });
  await call(client, "jellyfin_browse", { types: ["Movie"], isPlayed: false, minCommunityRating: 7, includeOverview: true, limit: 3 });

  const first = search?.items?.[0];
  if (first) {
    await call(client, "jellyfin_get_item", { itemId: first.id });
    await call(client, "jellyfin_get_similar", { itemId: first.id, limit: 3 });
  }

  const series = await call(client, "jellyfin_browse", { types: ["Series"], limit: 1 });
  const s = series?.items?.[0];
  if (s) {
    await call(client, "jellyfin_get_seasons", { seriesId: s.id });
    await call(client, "jellyfin_get_episodes", { seriesId: s.id, season: 1, limit: 3 });
    await call(client, "jellyfin_next_up", { seriesId: s.id });
  }

  await call(client, "jellyfin_list_genres", { types: ["Movie"], limit: 10 });
  await call(client, "jellyfin_get_latest", { limit: 5 });
  await call(client, "jellyfin_continue_watching", { limit: 5 });
  await call(client, "jellyfin_next_up", { limit: 5 });
  await call(client, "jellyfin_list_sessions");
  await call(client, "jellyfin_list_playlists");
  await call(client, "jellyfin_list_users");
  await call(client, "jellyfin_get_activity_log", { limit: 5 });
  await call(client, "jellyfin_list_scheduled_tasks");
}

{
  const client = new Client({ name: "live", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env }));
  await exercise(client, "stdio");
  await client.close();
}

{
  const PORT = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["dist/index.js", "--transport", "http", "--port", String(PORT)], {
    env: { ...env, MCP_AUTH_TOKEN: "live-test" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.stderr.on("data", (d) => String(d).includes("listening") && resolve());
    child.on("exit", (code) => reject(new Error(`http server exited ${code}`)));
  });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer live-test" } },
    });
    const client = new Client({ name: "live", version: "0" });
    await client.connect(transport);
    await exercise(client, "streamable HTTP");
    await transport.terminateSession();
    await client.close();
  } finally {
    child.kill();
  }
}

console.log(failures ? `\n${failures} tool call(s) failed` : "\nall live calls succeeded");
process.exit(failures ? 1 : 0);
