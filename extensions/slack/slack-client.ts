/**
 * Slack Web API client with split token support.
 *
 * - User token (xoxp-...): from Claude Code's OAuth credentials, for read operations.
 * - Bot token (xoxb-...): from ~/.pi/slack-config.json, for write operations.
 *
 * If no bot token is configured, write operations fall back to the user token.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

const SLACK_API_BASE = "https://slack.com/api";
const TOKEN_ENDPOINT = "https://slack.com/api/oauth.v2.user.access";
const CLIENT_ID = "1601185624273.8899143856786";

/** Key in ~/.claude/.credentials.json under mcpOAuth */
const CRED_KEY = "plugin:slack:slack|38801a7d845718b3";
const CREDS_FILE = path.join(os.homedir(), ".claude", ".credentials.json");
const BOT_CONFIG_FILE = path.join(os.homedir(), ".pi", "slack-config.json");

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

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

// ─── Token Management ─────────────────────────────────────────────────────────

let userTokenCache: SlackOAuthCredentials | null = null;
let refreshPromise: Promise<string> | null = null;
let botTokenCache: string | null = null;
let botTokenMtime: number = 0;

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

function getBotToken(): string | null {
	try {
		const stat = fs.statSync(BOT_CONFIG_FILE);
		if (stat.mtimeMs !== botTokenMtime) {
			const raw = fs.readFileSync(BOT_CONFIG_FILE, "utf8");
			const config: SlackConfig = JSON.parse(raw);
			botTokenCache = config.botToken ?? null;
			botTokenMtime = stat.mtimeMs;
		}
	} catch {
		botTokenCache = null;
	}
	return botTokenCache;
}

// ─── API Client ───────────────────────────────────────────────────────────────

export type TokenMode = "read" | "write";

export async function getToken(mode: TokenMode): Promise<string> {
	if (mode === "write") {
		const bot = getBotToken();
		if (bot) return bot;
	}
	return getUserToken();
}

export function hasBotToken(): boolean {
	return getBotToken() !== null;
}

/**
 * Call a Slack Web API method.
 *
 * @param method - API method name (e.g. "chat.postMessage")
 * @param params - Request parameters (sent as JSON body)
 * @param mode   - "read" (user token) or "write" (bot token, falling back to user)
 * @returns The parsed JSON response.
 * @throws On HTTP errors or Slack API errors ({ok: false}).
 */
export async function callSlackApi(
	method: string,
	params: Record<string, unknown>,
	mode: TokenMode = "read",
): Promise<SlackApiResponse> {
	const token = await getToken(mode);

	const resp = await fetch(`${SLACK_API_BASE}/${method}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json; charset=utf-8",
		},
		body: JSON.stringify(params),
	});

	if (!resp.ok) {
		throw new Error(`Slack API ${method} HTTP error: ${resp.status}`);
	}

	const data = (await resp.json()) as SlackApiResponse;
	if (!data.ok) {
		throw new Error(`Slack API ${method} error: ${data.error ?? "unknown"}`);
	}

	return data;
}

// ─── Formatting Helpers ───────────────────────────────────────────────────────

export function tsToDate(ts: string): string {
	const date = new Date(Number.parseFloat(ts) * 1000);
	return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export function formatMessage(msg: Record<string, unknown>): string {
	const ts = msg.ts as string;
	const user = msg.user as string | undefined;
	const botId = msg.bot_id as string | undefined;
	const text = msg.text as string | undefined;
	const sender = user ?? botId ?? "unknown";
	const threadInfo =
		msg.reply_count ? ` [${msg.reply_count} replies]` : "";
	return `[${tsToDate(ts)}] <@${sender}>${threadInfo}: ${text ?? "(no text)"}`;
}
