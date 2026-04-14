/**
 * Slack MCP Extension for Pi
 *
 * Bridges the Slack MCP HTTP server (https://mcp.slack.com/mcp) into Pi
 * as native Pi tools. Reads OAuth credentials from ~/.claude/.credentials.json
 * and auto-refreshes the token when it expires.
 *
 * Credentials source: Claude Code's stored Slack OAuth token (same app/scope).
 * Client ID matches the Slack app used by Claude Code's slack plugin.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

const MCP_URL = "https://mcp.slack.com/mcp";
const TOKEN_ENDPOINT = "https://slack.com/api/oauth.v2.user.access";
const CLIENT_ID = "1601185624273.8899143856786";

/** Key in ~/.claude/.credentials.json under mcpOAuth */
const CRED_KEY = "plugin:slack:slack|38801a7d845718b3";

const CREDS_FILE = path.join(os.homedir(), ".claude", ".credentials.json");

// Refresh 5 minutes before actual expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface SlackOAuthCredentials {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	scope?: string;
	discoveryState?: unknown;
}

interface ClaudeCredentials {
	mcpOAuth?: Record<string, SlackOAuthCredentials>;
}

interface McpTool {
	name: string;
	title?: string;
	description: string;
	inputSchema: {
		type: string;
		properties?: Record<string, unknown>;
		required?: string[];
	};
}

// ─── Credential Management ────────────────────────────────────────────────────

function readCredentials(): SlackOAuthCredentials | null {
	try {
		const raw = fs.readFileSync(CREDS_FILE, "utf8");
		const parsed: ClaudeCredentials = JSON.parse(raw);
		return parsed?.mcpOAuth?.[CRED_KEY] ?? null;
	} catch {
		return null;
	}
}

function writeCredentials(creds: SlackOAuthCredentials): void {
	try {
		const raw = fs.readFileSync(CREDS_FILE, "utf8");
		const parsed: ClaudeCredentials = JSON.parse(raw);
		if (!parsed.mcpOAuth) parsed.mcpOAuth = {};
		parsed.mcpOAuth[CRED_KEY] = creds;
		fs.writeFileSync(CREDS_FILE, JSON.stringify(parsed), "utf8");
	} catch (e) {
		console.error("[slack-mcp] Failed to persist refreshed token:", e);
	}
}

async function refreshToken(refreshToken: string): Promise<SlackOAuthCredentials> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: CLIENT_ID,
	});

	const resp = await fetch(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	if (!resp.ok) {
		throw new Error(`Token refresh HTTP error: ${resp.status}`);
	}

	const data = (await resp.json()) as {
		ok: boolean;
		error?: string;
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string;
	};

	if (!data.ok || !data.access_token) {
		throw new Error(`Token refresh failed: ${data.error ?? "unknown error"}`);
	}

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token ?? refreshToken,
		expiresAt: Date.now() + (data.expires_in ?? 43200) * 1000,
		scope: data.scope,
	};
}

// In-memory token cache
let tokenCache: SlackOAuthCredentials | null = null;
let refreshPromise: Promise<string> | null = null;

async function getAccessToken(): Promise<string> {
	// Deduplicate concurrent refresh calls
	if (refreshPromise) return refreshPromise;

	const now = Date.now();

	// Use in-memory cache if still valid
	if (tokenCache && tokenCache.expiresAt - REFRESH_BUFFER_MS > now) {
		return tokenCache.accessToken;
	}

	// Load from disk
	const diskCreds = readCredentials();
	if (!diskCreds) {
		throw new Error(
			"No Slack credentials found. Please ensure you've logged in to Slack in Claude Code first (slack plugin must be enabled and authenticated).",
		);
	}

	// Use disk token if still valid
	if (diskCreds.expiresAt - REFRESH_BUFFER_MS > now) {
		tokenCache = diskCreds;
		return tokenCache.accessToken;
	}

	// Need to refresh
	refreshPromise = (async () => {
		try {
			const newCreds = await refreshToken(diskCreds.refreshToken);
			writeCredentials(newCreds);
			tokenCache = newCreds;
			return newCreds.accessToken;
		} finally {
			refreshPromise = null;
		}
	})();

	return refreshPromise;
}

// ─── MCP Client ───────────────────────────────────────────────────────────────

interface McpSession {
	sessionId: string;
	accessToken: string;
	initializedAt: number;
}

let mcpSession: McpSession | null = null;
// Sessions are valid for ~24h; we recycle after 22h to be safe
const SESSION_TTL_MS = 22 * 60 * 60 * 1000;

async function getMcpSession(accessToken: string): Promise<McpSession> {
	const now = Date.now();

	// Reuse existing session if token matches and not too old
	if (
		mcpSession &&
		mcpSession.accessToken === accessToken &&
		now - mcpSession.initializedAt < SESSION_TTL_MS
	) {
		return mcpSession;
	}

	// Initialize a new MCP session
	const resp = await fetch(MCP_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "pi-coding-agent", version: "1.0" },
			},
		}),
	});

	if (!resp.ok) {
		throw new Error(`MCP initialize failed: ${resp.status}`);
	}

	const sessionId = resp.headers.get("mcp-session-id");
	if (!sessionId) {
		throw new Error("MCP server did not return a session ID");
	}

	mcpSession = { sessionId, accessToken, initializedAt: now };
	return mcpSession;
}

async function mcpCall<T>(method: string, params: unknown = {}): Promise<T> {
	const accessToken = await getAccessToken();
	const session = await getMcpSession(accessToken);

	const resp = await fetch(MCP_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
			"mcp-session-id": session.sessionId,
			Accept: "application/json",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: Math.floor(Math.random() * 100000),
			method,
			params,
		}),
	});

	if (!resp.ok) {
		// Session may have expired; clear it and retry once
		if (resp.status === 404 || resp.status === 401) {
			mcpSession = null;
			tokenCache = null;
			return mcpCall<T>(method, params);
		}
		throw new Error(`MCP call ${method} failed: ${resp.status}`);
	}

	const data = (await resp.json()) as { result?: T; error?: { message: string } };
	if (data.error) {
		throw new Error(`MCP error: ${data.error.message}`);
	}

	return data.result as T;
}

// ─── Tool Discovery and Registration ─────────────────────────────────────────

/**
 * Converts a JSON Schema properties object to a TypeBox-compatible schema.
 * We use Type.Any() for each property to avoid needing to recursively mirror
 * the full JSON Schema — the MCP server validates inputs anyway.
 */
function buildParameterSchema(inputSchema: McpTool["inputSchema"]) {
	const props: Record<string, unknown> = {};
	for (const [key, schemaDef] of Object.entries(inputSchema.properties ?? {})) {
		const def = schemaDef as Record<string, unknown>;
		const description = typeof def.description === "string" ? def.description : undefined;
		props[key] = description ? Type.Any({ description }) : Type.Any();
	}

	const required = inputSchema.required ?? [];

	// Make non-required fields optional
	const finalProps: Record<string, unknown> = {};
	for (const [key, schema] of Object.entries(props)) {
		if (required.includes(key)) {
			finalProps[key] = schema;
		} else {
			finalProps[key] = Type.Optional(schema as Parameters<typeof Type.Optional>[0]);
		}
	}

	return Type.Object(finalProps as Parameters<typeof Type.Object>[0]);
}

export default function (pi: ExtensionAPI) {
	// We register tools lazily after the first session_start so the MCP call
	// doesn't block startup. Tools are registered during session_start.
	pi.on("session_start", async (_event, ctx) => {
		try {
			const { tools } = await mcpCall<{ tools: McpTool[] }>("tools/list", {});

			for (const tool of tools) {
				const toolName = tool.name; // e.g. "slack_search_public"
				const schema = buildParameterSchema(tool.inputSchema);

				pi.registerTool({
					name: toolName,
					label: tool.title ?? toolName,
					description: tool.description,
					parameters: schema,

					async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
						try {
							const result = await mcpCall<{ content: Array<{ type: string; text?: string }> }>(
								"tools/call",
								{ name: toolName, arguments: params },
							);

							const text =
								result.content
									?.filter((c) => c.type === "text")
									.map((c) => c.text ?? "")
									.join("\n") ?? "(no result)";

							return {
								content: [{ type: "text" as const, text }],
								details: { raw: result },
							};
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							return {
								content: [{ type: "text" as const, text: `Slack MCP error: ${msg}` }],
								details: {},
								isError: true,
							};
						}
					},
				});
			}

			ctx.ui.notify(`Slack MCP: ${tools.length} tools registered`, "info");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Slack MCP failed to load: ${msg}`, "error");
		}
	});
}
