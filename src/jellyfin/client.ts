import type { Config } from "../config.js";
import { SERVER_VERSION } from "../config.js";
import { log } from "../log.js";

export type QueryValue = string | number | boolean | Array<string | number> | null | undefined;
export type Query = Record<string, QueryValue>;

export class JellyfinError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "JellyfinError";
  }
}

interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Skip the lazy login / user resolution step (used by the auth calls themselves). */
  raw?: boolean;
}

/**
 * Minimal Jellyfin REST client. Authenticates with an API key or with
 * username/password, and resolves the user id that user-scoped endpoints need.
 */
export class JellyfinClient {
  private token?: string;
  private userId?: string;
  private ready?: Promise<void>;

  constructor(private readonly cfg: Config["jellyfin"]) {
    this.token = cfg.apiKey;
    this.userId = cfg.userId;
  }

  get baseUrl(): string {
    return this.cfg.url;
  }

  /** The user id that user-scoped calls run as. */
  async currentUserId(): Promise<string> {
    await this.init();
    return this.userId!;
  }

  private authHeader(): string {
    const parts = [
      `Client="Jellyfin MCP"`,
      `Device="${this.cfg.deviceName.replace(/"/g, "")}"`,
      `DeviceId="${this.cfg.deviceId.replace(/"/g, "")}"`,
      `Version="${SERVER_VERSION}"`,
    ];
    if (this.token) parts.push(`Token="${this.token}"`);
    return `MediaBrowser ${parts.join(", ")}`;
  }

  private init(): Promise<void> {
    this.ready ??= this.doInit().catch((err) => {
      this.ready = undefined; // allow a retry on the next call
      throw err;
    });
    return this.ready;
  }

  private async doInit(): Promise<void> {
    if (!this.token) {
      if (!this.cfg.username) throw new JellyfinError("No Jellyfin credentials configured");
      const res = await this.request<{ AccessToken: string; User: { Id: string } }>(
        "POST",
        "/Users/AuthenticateByName",
        { body: { Username: this.cfg.username, Pw: this.cfg.password ?? "" }, raw: true },
      );
      this.token = res.AccessToken;
      this.userId ??= res.User.Id;
      log(`Authenticated to Jellyfin as ${this.cfg.username}`);
      return;
    }

    if (this.userId) return;

    // Prefer the user that matches JELLYFIN_USERNAME, then the token owner
    // (works for user access tokens), then the first administrator (API keys).
    const users = await this.request<Array<{ Id: string; Name: string; Policy?: { IsAdministrator?: boolean } }>>(
      "GET",
      "/Users",
      { raw: true },
    ).catch(() => undefined);

    if (this.cfg.username && users) {
      const match = users.find((u) => u.Name.toLowerCase() === this.cfg.username!.toLowerCase());
      if (!match) throw new JellyfinError(`Jellyfin user "${this.cfg.username}" not found`);
      this.userId = match.Id;
      return;
    }

    const me = await this.request<{ Id: string }>("GET", "/Users/Me", { raw: true }).catch(() => undefined);
    if (me?.Id) {
      this.userId = me.Id;
      return;
    }

    const admin = users?.find((u) => u.Policy?.IsAdministrator) ?? users?.[0];
    if (!admin) throw new JellyfinError("Could not determine a Jellyfin user; set JELLYFIN_USER_ID or JELLYFIN_USERNAME");
    this.userId = admin.Id;
    log(`No user configured; acting as "${admin.Name}". Set JELLYFIN_USER_ID or JELLYFIN_USERNAME to choose.`);
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    if (!opts.raw) await this.init();

    const url = new URL(this.cfg.url + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        if (v.length) url.searchParams.set(k, v.join(","));
      } else {
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: "application/json",
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    } catch (err) {
      throw new JellyfinError(`Could not reach Jellyfin at ${this.cfg.url}: ${(err as Error).message}`);
    }

    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 ? " (check JELLYFIN_API_KEY / credentials)" : "";
      throw new JellyfinError(
        `Jellyfin ${method} ${path} failed: ${res.status} ${res.statusText}${hint}${text ? ` - ${text.slice(0, 300)}` : ""}`,
        res.status,
        text,
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  get<T = unknown>(path: string, query?: Query) {
    return this.request<T>("GET", path, { query });
  }

  post<T = unknown>(path: string, query?: Query, body?: unknown) {
    return this.request<T>("POST", path, { query, body });
  }

  delete<T = unknown>(path: string, query?: Query) {
    return this.request<T>("DELETE", path, { query });
  }
}
