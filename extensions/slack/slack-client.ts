/**
 * Hybrid Slack client.
 *
 * - Reads: routed through Slack's MCP server (mcp.slack.com) using the
 *   Claude Code OAuth token. Full access to search, conversations, DMs, etc.
 * - Writes: direct Slack Web API using bot token from ~/.pi/slack-config.json.
 *   Messages appear from the bot (unread notifications). Falls back to MCP
 *   if no bot token is configured.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

const SLACK_API_BASE = "https://slack.com/api";
const MCP_URL = "https://mcp.slack.com/mcp";
const TOKEN_ENDPOINT = "https://slack.com/api/oauth.v2.user.access";
const CLIENT_ID = "1601185624273.8899143856786";

const CRED_KEY = "plugin:slack:slack|38801a7d845718b3";
const CREDS_FILE = path.join(os.homedir(), ".claude", ".credentials.json");
const BOT_CONFIG_FILE = path.join(os.homedir(), ".pi", "slack-config.json");

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 22 * 60 * 60 * 1000;
const MAX_RETRIES = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

interface SlackOAuthCredentials {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	scope?: string;
}

interface ClaudeCredentials {
	mcpOAuth?: Record<string, SlackOAuthCredentials>;
}

interface SlackConfig {
	botToken?: string;
}

export interface SlackApiResponse {
	ok: boolean;
	error?: string;
	[key: string]: unknown;
}

interface McpSession {
	sessionId: string;
	accessToken: string;
	initializedAt: number;
}

// ─── OAuth Token Management ───────────────────────────────────────────────────

let userTokenCache: SlackOAuthCredentials | null = null;
let refreshPromise: Promise<string> | null = null;

function readClaudeCredentials(): SlackOAuthCredentials | null {
	try {
		const raw = fs.readFileSync(CREDS_FILE, "utf8");
		const parsed: ClaudeCredentials = JSON.parse(raw);
		return parsed?.mcpOAuth?.[CRED_KEY] ?? null;
	} catch {
		return null;
	}
}

function writeClaudeCredentials(creds: SlackOAuthCredentials): void {
	try {
		const raw = fs.readFileSync(CREDS_FILE, "utf8");
		const parsed: ClaudeCredentials = JSON.parse(raw);
		if (!parsed.mcpOAuth) parsed.mcpOAuth = {};
		parsed.mcpOAuth[CRED_KEY] = creds;
		fs.writeFileSync(CREDS_FILE, JSON.stringify(parsed), "utf8");
	} catch (e) {
		console.error("[slack] Failed to persist refreshed token:", e);
	}
}

async function refreshOAuthToken(refreshToken: string): Promise<SlackOAuthCredentials> {
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
	if (!resp.ok) throw new Error(`Token refresh HTTP error: ${resp.status}`);
	const data = (await resp.json()) as {
		ok: boolean;
		error?: string;
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string;
	};
	if (!data.ok || !data.access_token) {
		throw new Error(`Token refresh failed: ${data.error ?? "unknown"}`);
	}
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token ?? refreshToken,
		expiresAt: Date.now() + (data.expires_in ?? 43200) * 1000,
		scope: data.scope,
	};
}

async function getUserToken(): Promise<string> {
	if (refreshPromise) return refreshPromise;
	const now = Date.now();
	if (userTokenCache && userTokenCache.expiresAt - REFRESH_BUFFER_MS > now) {
		return userTokenCache.accessToken;
	}
	const diskCreds = readClaudeCredentials();
	if (!diskCreds) {
		throw new Error(
			"No Slack user credentials found. Ensure you've authenticated Slack in Claude Code first.",
		);
	}
	if (diskCreds.expiresAt - REFRESH_BUFFER_MS > now) {
		userTokenCache = diskCreds;
		return diskCreds.accessToken;
	}
	refreshPromise = (async () => {
		try {
			const newCreds = await refreshOAuthToken(diskCreds.refreshToken);
			writeClaudeCredentials(newCreds);
			userTokenCache = newCreds;
			return newCreds.accessToken;
		} finally {
			refreshPromise = null;
		}
	})();
	return refreshPromise;
}

// ─── Bot Token Management ─────────────────────────────────────────────────────

let configCache: SlackConfig | null = null;
let configMtime: number = 0;

function readConfig(): SlackConfig {
	try {
		const stat = fs.statSync(BOT_CONFIG_FILE);
		if (stat.mtimeMs !== configMtime) {
			const raw = fs.readFileSync(BOT_CONFIG_FILE, "utf8");
			configCache = JSON.parse(raw);
			configMtime = stat.mtimeMs;
		}
	} catch {
		configCache = {};
	}
	return configCache ?? {};
}

export function hasBotToken(): boolean {
	return !!readConfig().botToken;
}

// ─── MCP Client (for reads) ──────────────────────────────────────────────────

let mcpSession: McpSession | null = null;

async function getMcpSession(accessToken: string): Promise<McpSession> {
	const now = Date.now();
	if (
		mcpSession &&
		mcpSession.accessToken === accessToken &&
		now - mcpSession.initializedAt < SESSION_TTL_MS
	) {
		return mcpSession;
	}

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

	if (!resp.ok) throw new Error(`MCP initialize failed: ${resp.status}`);
	const sessionId = resp.headers.get("mcp-session-id");
	if (!sessionId) throw new Error("MCP server did not return a session ID");

	mcpSession = { sessionId, accessToken, initializedAt: now };
	return mcpSession;
}

/**
 * Call a tool on the Slack MCP server. Used for all read operations.
 * Returns the text content from the MCP response.
 */
export async function mcpToolCall(
	toolName: string,
	params: Record<string, unknown>,
): Promise<string> {
	const accessToken = await getUserToken();
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
			method: "tools/call",
			params: { name: toolName, arguments: params },
		}),
	});

	if (!resp.ok) {
		// Session may have expired; clear and retry once
		if (resp.status === 404 || resp.status === 401) {
			mcpSession = null;
			userTokenCache = null;
			return mcpToolCall(toolName, params);
		}
		throw new Error(`MCP call ${toolName} failed: ${resp.status}`);
	}

	const data = (await resp.json()) as {
		result?: { content: Array<{ type: string; text?: string }> };
		error?: { message: string };
	};
	if (data.error) throw new Error(`MCP error: ${data.error.message}`);

	return (
		data.result?.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n") ?? "(no result)"
	);
}

// ─── Direct Slack API (for writes with bot token) ─────────────────────────────

/**
 * Call the Slack Web API directly. Used for write operations with the bot token.
 */
export async function callSlackApi(
	method: string,
	params: Record<string, unknown>,
): Promise<SlackApiResponse> {
	const token = readConfig().botToken;
	if (!token) throw new Error("No bot token configured");

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const resp = await fetch(`${SLACK_API_BASE}/${method}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify(params),
		});

		if (resp.status === 429) {
			const retryAfter = Number(resp.headers.get("Retry-After") ?? "3");
			if (attempt < MAX_RETRIES) {
				await new Promise((r) => setTimeout(r, retryAfter * 1000));
				continue;
			}
			throw new Error(`Slack API ${method}: rate limited after ${MAX_RETRIES} retries`);
		}

		if (!resp.ok) {
			throw new Error(`Slack API ${method} HTTP error: ${resp.status}`);
		}

		const data = (await resp.json()) as SlackApiResponse;
		if (!data.ok) {
			throw new Error(`Slack API ${method} error: ${data.error ?? "unknown"}`);
		}

		return data;
	}

	throw new Error(`Slack API ${method}: exhausted retries`);
}

// ─── Formatting Helpers ───────────────────────────────────────────────────────

export function tsToDate(ts: string): string {
	const date = new Date(Number.parseFloat(ts) * 1000);
	return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}
