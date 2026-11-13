/**
 * Log to stderr. stdout is reserved for JSON-RPC when running over stdio,
 * so nothing in this server may write to it.
 */
export function log(...args: unknown[]): void {
  console.error("[jellyfin-mcp]", ...args);
}
