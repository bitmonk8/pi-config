/**
 * Slack tool definitions — hybrid routing.
 *
 * Read tools  → MCP server (full access via Claude Code OAuth token)
 * Write tools → Direct Slack Web API with bot token (messages from bot identity)
 *               Falls back to MCP if no bot token configured.
 */

import { Type } from "@sinclair/typebox";
import { mcpToolCall, callSlackApi, hasBotToken, tsToDate } from "./slack-client.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

interface ToolDef {
	name: string;
	label: string;
	description: string;
	parameters: ReturnType<typeof Type.Object>;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: (update: unknown) => void,
		ctx: unknown,
	) => Promise<ToolResult>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(text: string, raw?: unknown): ToolResult {
	return { content: [{ type: "text", text }], details: { raw } };
}

function err(text: string): ToolResult {
	return { content: [{ type: "text", text }], details: {}, isError: true };
}

async function safecall(fn: () => Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await fn();
	} catch (e) {
		return err(`Slack error: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Execute a read tool via the MCP server. */
function mcpRead(toolName: string): ToolDef["execute"] {
	return (_id, params) =>
		safecall(async () => {
			// Strip undefined values — MCP doesn't want them
			const clean: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(params)) {
				if (v !== undefined) clean[k] = v;
			}
			const text = await mcpToolCall(toolName, clean);
			return ok(text);
		});
}

/**
 * Execute a write tool. Uses bot token (direct API) if available,
 * otherwise falls back to MCP (messages will appear as "from you").
 */
function botWrite(
	directFn: (params: Record<string, unknown>) => Promise<ToolResult>,
	mcpToolName: string,
): ToolDef["execute"] {
	return (_id, params) =>
		safecall(async () => {
			if (hasBotToken()) {
				return await directFn(params);
			}
			// Fallback: MCP (user token — no bot identity)
			const clean: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(params)) {
				if (v !== undefined) clean[k] = v;
			}
			const text = await mcpToolCall(mcpToolName, clean);
			return ok(text);
		});
}

// ─── Canvas Formatting Guidelines ─────────────────────────────────────────────

const CANVAS_FORMAT_GUIDELINES = `
## Canvas Formatting Guidelines

Content is Canvas-flavored Markdown (different from Slack message formatting):
- Standard Markdown: headers, lists, links, checklists, bold, italic, code, etc.
- User references: \`![](@U15CTCJ83)\` (renders as profile card if standalone, inline text if in paragraph)
- Channel references: \`![](#C15CTCJ83)\` — always use the channel ID, never the name
- NEVER use \`<#C1234>\` or \`<@U1234>\` syntax
- Links: \`[text](https://example.com)\` — only http/https/mailto/tel/ftp/slack schemes
- Images: \`![alt](url)\` — must be standalone on their own line
- Quotes: \`> text\` — only on their own line, only plain text with inline formatting inside
- Emojis: Slack-style \`:tada:\` \`:wave:\` etc.
- Headings: only \`#\`, \`##\`, \`###\` (no deeper)
- No headings inside list items
- In list items: only plain text with inline formatting (bold, italic, inline code, links)
- No code blocks inside list items or block quotes
- Don't mix list types when nesting (bulleted only nests bulleted, numbered only nests numbered)
- Tables: standard markdown tables, \`<br>\` for multi-line cell content
- Layouts: \`::: {.layout}\` / \`::: {.column}\` / \`:::\` — max 3 columns, no tables/callouts inside
- Callouts: \`::: {.callout}\` / \`:::\` — no tables inside, cannot nest
- Thematic breaks (---, ***, ___): only at top level
- Dates: \`![](slack_date:YYYY-MM-DD)\` — never append day names or text after
- Slack files (*.slack.com/files/*): embed as \`![](file_url)\`
- Citations: use \`[[N]](url)\` inline format

Do NOT include the title in the content — use the title parameter.`;

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export function createTools(): ToolDef[] {
	return [
		// ── Write Tools (bot token → direct API) ──────────────────────────────

		{
			name: "slack_send_message",
			label: "Send Slack Message",
			description: `Send a message to a Slack channel or user. To DM a user, use their user_id as channel_id. Message uses standard Slack markdown (**bold**, _italic_, \`code\`, ~~strikethrough~~, >blockquotes, lists, links, code blocks). Limited to ~4000 chars. Thread replies: set thread_ts to parent message timestamp, reply_broadcast=true to also post to channel. Use slack_search_channels to find channel IDs, slack_search_users to find user IDs.`,
			parameters: Type.Object({
				channel_id: Type.String({ description: "Channel or user ID to send to" }),
				message: Type.String({ description: "Message text (Slack markdown)" }),
				thread_ts: Type.Optional(
					Type.String({ description: "Parent message ts for thread reply" }),
				),
				reply_broadcast: Type.Optional(
					Type.Boolean({ description: "Also post thread reply to channel" }),
				),
			}),
			execute: botWrite(async (params) => {
				const body: Record<string, unknown> = {
					channel: params.channel_id,
					text: params.message,
				};
				if (params.thread_ts) body.thread_ts = params.thread_ts;
				if (params.reply_broadcast) body.reply_broadcast = true;

				const data = await callSlackApi("chat.postMessage", body);
				const ch = data.channel as string;
				const ts = (data.ts as string).replace(".", "");
				return ok(`Message sent. Link: https://slack.com/archives/${ch}/p${ts}`, data);
			}, "slack_send_message"),
		},

		{
			name: "slack_schedule_message",
			label: "Schedule Slack Message",
			description: `Schedule a message for future delivery. post_at must be a Unix timestamp at least 2 minutes in the future, max 120 days out. Supports thread replies via thread_ts. Use slack_search_channels/slack_search_users to find IDs.`,
			parameters: Type.Object({
				channel_id: Type.String({ description: "Channel to schedule message in" }),
				message: Type.String({ description: "Message content (Slack markdown)" }),
				post_at: Type.Number({
					description: "Unix timestamp when message should be sent",
				}),
				thread_ts: Type.Optional(
					Type.String({ description: "Parent message ts for thread reply" }),
				),
				reply_broadcast: Type.Optional(
					Type.Boolean({ description: "Broadcast thread reply" }),
				),
			}),
			execute: botWrite(async (params) => {
				const body: Record<string, unknown> = {
					channel: params.channel_id,
					text: params.message,
					post_at: params.post_at,
				};
				if (params.thread_ts) body.thread_ts = params.thread_ts;
				if (params.reply_broadcast) body.reply_broadcast = true;

				const data = await callSlackApi("chat.scheduleMessage", body);
				const postAt = new Date((params.post_at as number) * 1000).toISOString();
				return ok(`Message scheduled for ${postAt}. ID: ${data.scheduled_message_id}`, data);
			}, "slack_schedule_message"),
		},

		{
			name: "slack_create_canvas",
			label: "Create Slack Canvas",
			description: `Create a Slack Canvas document from Canvas-flavored Markdown content. Returns the canvas ID and link.
${CANVAS_FORMAT_GUIDELINES}`,
			parameters: Type.Object({
				title: Type.String({ description: "Canvas title (do not repeat in content)" }),
				content: Type.String({
					description: "Canvas content as Canvas-flavored Markdown",
				}),
			}),
			execute: botWrite(async (params) => {
				const data = await callSlackApi("canvases.create", {
					title: params.title,
					document_content: {
						type: "markdown",
						markdown: params.content,
					},
				});
				const canvasId = data.canvas_id as string;
				return ok(`Canvas created: ${canvasId}`, data);
			}, "slack_create_canvas"),
		},

		{
			name: "slack_update_canvas",
			label: "Update Slack Canvas",
			description: `Update an existing Slack Canvas document. Supports append, prepend, or replace.

**WARNING:** action=replace WITHOUT section_id will OVERWRITE THE ENTIRE CANVAS.

With section_id:
- append: adds content at the END of the section
- prepend: inserts content AFTER the targeted element
- replace: replaces ONLY the specified section (safe)

Without section_id:
- append: adds to END of canvas
- prepend: inserts after title
- replace: ⚠️ REPLACES ENTIRE CANVAS

Use slack_read_canvas first to get section IDs.
${CANVAS_FORMAT_GUIDELINES}`,
			parameters: Type.Object({
				canvas_id: Type.String({ description: "Canvas ID to update" }),
				action: Type.String({ description: '"append", "prepend", or "replace"' }),
				content: Type.String({
					description: "Canvas-flavored Markdown content",
				}),
				section_id: Type.Optional(
					Type.String({
						description:
							"Section ID from slack_read_canvas. STRONGLY recommended for replace.",
					}),
				),
			}),
			execute: botWrite(async (params) => {
				const actionMap: Record<string, string> = {
					append: "insert_after",
					prepend: "insert_before",
					replace: "replace",
				};
				const operation = actionMap[params.action as string] ?? "insert_after";

				const change: Record<string, unknown> = {
					operation,
					document_content: {
						type: "markdown",
						markdown: params.content,
					},
				};
				if (params.section_id) change.section_id = params.section_id;

				const data = await callSlackApi("canvases.edit", {
					canvas_id: params.canvas_id,
					changes: [change],
				});
				return ok(`Canvas updated: ${params.canvas_id}`, data);
			}, "slack_update_canvas"),
		},

		// ── Read Tools (MCP server passthrough) ───────────────────────────────

		{
			name: "slack_search_public",
			label: "Search Slack (Public)",
			description: `Search messages and files in public Slack channels.

Query syntax: keywords or natural language with search modifiers.
Modifiers:
  in:channel-name / in:<#C123>    Channel filter
  from:<@U123> / from:username    Author filter
  to:<@U123> / to:me              Recipient filter
  has:pin / has:link / has:file   Content filters
  has::emoji:                     Reaction filter
  before:YYYY-MM-DD / after:YYYY-MM-DD / on:YYYY-MM-DD  Date filters
  "exact phrase" / -word          Text matching
  is:thread                       Thread filter

For file search: set content_types="files" with type: filter (images, documents, pdfs, spreadsheets, etc.).

Strategy: break complex searches into multiple small ones, use modifiers to narrow scope.`,
			parameters: Type.Object({
				query: Type.String({ description: "Search query with optional modifiers" }),
				content_types: Type.Optional(
					Type.String({
						description:
							'Comma-separated: "messages", "files", or "messages,files". Default: messages',
					}),
				),
				sort: Type.Optional(
					Type.String({
						description: '"score" (relevance) or "timestamp". Default: score',
					}),
				),
				sort_dir: Type.Optional(
					Type.String({ description: '"asc" or "desc". Default: desc' }),
				),
				limit: Type.Optional(
					Type.Number({ description: "Results to return, max 20. Default: 20" }),
				),
				cursor: Type.Optional(
					Type.String({ description: "Pagination cursor from previous result" }),
				),
			}),
			execute: mcpRead("slack_search_public"),
		},

		{
			name: "slack_search_public_and_private",
			label: "Search Slack (All)",
			description: `Search messages and files in ALL Slack channels including private channels, DMs, and group DMs. Same query syntax as slack_search_public. Requires user consent before use.`,
			parameters: Type.Object({
				query: Type.String({ description: "Search query with optional modifiers" }),
				content_types: Type.Optional(
					Type.String({
						description:
							'Comma-separated: "messages", "files", or "messages,files". Default: messages',
					}),
				),
				sort: Type.Optional(
					Type.String({ description: '"score" or "timestamp". Default: score' }),
				),
				sort_dir: Type.Optional(
					Type.String({ description: '"asc" or "desc". Default: desc' }),
				),
				limit: Type.Optional(
					Type.Number({ description: "Results to return, max 20. Default: 20" }),
				),
				cursor: Type.Optional(Type.String({ description: "Pagination cursor" })),
			}),
			execute: mcpRead("slack_search_public_and_private"),
		},

		{
			name: "slack_search_channels",
			label: "Search Slack Channels",
			description: `Search for Slack channels by name or topic/purpose. Returns channel names, IDs, topics, purposes, and archive status. Query terms match against channel name, topic, and purpose. Use slack_read_channel to read messages from a found channel.`,
			parameters: Type.Object({
				query: Type.String({
					description: "Search terms matching channel name/topic/purpose",
				}),
				channel_types: Type.Optional(
					Type.String({
						description:
							'Comma-separated: "public_channel", "private_channel". Default: public_channel',
					}),
				),
				limit: Type.Optional(
					Type.Number({ description: "Max results, up to 20. Default: 20" }),
				),
				include_archived: Type.Optional(
					Type.Boolean({ description: "Include archived channels" }),
				),
				cursor: Type.Optional(Type.String({ description: "Pagination cursor" })),
			}),
			execute: mcpRead("slack_search_channels"),
		},

		{
			name: "slack_search_users",
			label: "Search Slack Users",
			description: `Search for Slack users by name, email, or profile attributes (department, title). Returns user IDs, names, emails, titles. Use slack_read_user_profile for full details on a known user ID.`,
			parameters: Type.Object({
				query: Type.String({
					description:
						'Search terms: names ("John Smith"), emails ("john@company.com"), titles ("engineering")',
				}),
				limit: Type.Optional(
					Type.Number({ description: "Max results, up to 20. Default: 20" }),
				),
				cursor: Type.Optional(Type.String({ description: "Pagination cursor" })),
			}),
			execute: mcpRead("slack_search_users"),
		},

		{
			name: "slack_read_channel",
			label: "Read Slack Channel",
			description: `Read messages from a Slack channel (newest first). To read DM history, use a user_id as channel_id. Use slack_read_thread with a message's ts to read thread replies. Use slack_search_channels to find a channel ID by name.`,
			parameters: Type.Object({
				channel_id: Type.String({ description: "Channel, group, or DM ID" }),
				limit: Type.Optional(
					Type.Number({ description: "Messages to return, 1-100. Default: 100" }),
				),
				oldest: Type.Optional(
					Type.String({ description: "Start of time range (timestamp)" }),
				),
				latest: Type.Optional(
					Type.String({ description: "End of time range (timestamp)" }),
				),
				cursor: Type.Optional(Type.String({ description: "Pagination cursor" })),
			}),
			execute: mcpRead("slack_read_channel"),
		},

		{
			name: "slack_read_thread",
			label: "Read Slack Thread",
			description: `Read messages from a specific Slack thread (parent message + all replies). Requires channel_id and message_ts of the parent message. Use slack_search_public or slack_read_channel to find these values.`,
			parameters: Type.Object({
				channel_id: Type.String({ description: "Channel containing the thread" }),
				message_ts: Type.String({
					description: "Timestamp of the parent message",
				}),
				limit: Type.Optional(
					Type.Number({ description: "Messages to return, 1-1000. Default: 100" }),
				),
				oldest: Type.Optional(Type.String({ description: "Start of time range" })),
				latest: Type.Optional(Type.String({ description: "End of time range" })),
				cursor: Type.Optional(Type.String({ description: "Pagination cursor" })),
			}),
			execute: mcpRead("slack_read_thread"),
		},

		{
			name: "slack_read_user_profile",
			label: "Read Slack User Profile",
			description: `Read detailed profile information for a Slack user: name, email, title, status, timezone, phone. Defaults to current user if user_id not provided. Use slack_search_users to find a user ID.`,
			parameters: Type.Object({
				user_id: Type.Optional(
					Type.String({
						description:
							"Slack user ID (e.g. U0ABC12345). Omit for current user.",
					}),
				),
			}),
			execute: mcpRead("slack_read_user_profile"),
		},

		{
			name: "slack_read_canvas",
			label: "Read Slack Canvas",
			description: `Read the content and section IDs of a Slack Canvas document. Returns markdown content and section_id_mapping for use with slack_update_canvas. Use slack_search_public to find canvases by name.`,
			parameters: Type.Object({
				canvas_id: Type.String({
					description: "Canvas file ID (e.g. F1234567890)",
				}),
			}),
			execute: mcpRead("slack_read_canvas"),
		},
	];
}
