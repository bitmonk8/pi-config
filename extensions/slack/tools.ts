/**
 * Slack tool definitions — schemas, descriptions, and execute functions.
 *
 * Each tool calls the Slack Web API directly via slack-client.ts.
 * Read tools use the user token; write tools use the bot token (if configured).
 */

import { Type } from "@sinclair/typebox";
import { callSlackApi, formatMessage, tsToDate, type SlackApiResponse } from "./slack-client.js";

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
		return err(`Slack API error: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// ─── Canvas Formatting Guidelines (shared by create + update) ─────────────────

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
		// ── Messages ──────────────────────────────────────────────────────────

		{
			name: "slack_send_message",
			label: "Send Slack Message",
			description: `Send a message to a Slack channel or user. To DM a user, use their user_id as channel_id. Message uses standard Slack markdown (**bold**, _italic_, \`code\`, ~~strikethrough~~, >blockquotes, lists, links, code blocks). Limited to ~4000 chars. Thread replies: set thread_ts to parent message timestamp, reply_broadcast=true to also post to channel. Use slack_search_channels to find channel IDs, slack_search_users to find user IDs.`,
			parameters: Type.Object({
				channel_id: Type.String({ description: "Channel or user ID to send to" }),
				message: Type.String({ description: "Message text (Slack markdown)" }),
				thread_ts: Type.Optional(Type.String({ description: "Parent message ts for thread reply" })),
				reply_broadcast: Type.Optional(
					Type.Boolean({ description: "Also post thread reply to channel" }),
				),
			}),
			execute: (_id, params) =>
				safecall(async () => {
					const body: Record<string, unknown> = {
						channel: params.channel_id,
						text: params.message,
					};
					if (params.thread_ts) body.thread_ts = params.thread_ts;
					if (params.reply_broadcast) body.reply_broadcast = true;

					const data = await callSlackApi("chat.postMessage", body, "write");
					const ch = data.channel as string;
					const ts = (data.ts as string).replace(".", "");
					return ok(
						`Message sent. Link: https://slack.com/archives/${ch}/p${ts}`,
						data,
					);
				}),
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
				thread_ts: Type.Optional(Type.String({ description: "Parent message ts for thread reply" })),
				reply_broadcast: Type.Optional(Type.Boolean({ description: "Broadcast thread reply" })),
			}),
			execute: (_id, params) =>
				safecall(async () => {
					const body: Record<string, unknown> = {
						channel: params.channel_id,
						text: params.message,
						post_at: params.post_at,
					};
					if (params.thread_ts) body.thread_ts = params.thread_ts;
					if (params.reply_broadcast) body.reply_broadcast = true;

					const data = await callSlackApi("chat.scheduleMessage", body, "write");
					const postAt = new Date((params.post_at as number) * 1000).toISOString();
					return ok(
						`Message scheduled for ${postAt}. ID: ${data.scheduled_message_id}`,
						data,
					);
				}),
		},

		// ── Search ────────────────────────────────────────────────────────────

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
					Type.String({ description: '"score" (relevance) or "timestamp". Default: score' }),
				),
				sort_dir: Type.Optional(
					Type.String({ description: '"asc" or "desc". Default: desc' }),
				),
				limit: Type.Optional(Type.Number({ description: "Results to return, max 20. Default: 20" })),
				cursor: Type.Optional(Type.String({ description: "Pagination cursor from previous result" })),
			}),
			execute: (_id, params) =>
				safecall(async () => {
					return await doSearch(params, false);
				}),
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
				sort: Type.Optional(Type.String({ description: '"score" or "timestamp". Default: score' })),
				sort_dir: Type.Optional(Type.String({ description: '"asc" or "desc". Default: desc' })),
				limit: Type.Optional(Type.Number({ description: "Results to return, max 20. Default: 20" })),
				cursor: Type.Optional(Type.String({ description: "Pagination cursor" })),
			}),
			execute: (_id, params) =>
				safecall(async () => {
					return await doSearch(params, true);
				}),
		},

		{
			name: "slack_search_channels",
			label: "Search Slack Channels",
			description: `Search for Slack channels by name or topic/purpose. Returns channel names, IDs, topics, purposes, and archive status. Query terms match against channel name, topic, and purpose. Use slack_read_channel to read messages from a found channel.`,
			parameters: Type.Object({
				query: Type.String({ description: "Search terms matching channel name/topic/purpose" }),
				channel_types: Type.Optional(
					Type.String({
						description:
							'Comma-separated: "public_channel", "private_channel". Default: public_channel',
					}),
				),
				limit: Type.Optional(Type.Number({ description: "Max results, up to 20. Default: 20" })),
				include_archived: Type.Optional(Type.Boolean({ description: "Include archived channels" })),
				cursor: Type.Optional(Type.String({ description: "Pagination cursor" })),
			}),
			execute: (_id, params) =>
				safecall(async () => {
					const query = (params.query as string).toLowerCase();
					const types = (params.channel_types as string) ?? "public_channel";
					const limit = Math.min((params.limit as number) ?? 20, 20);
					const includeArchived = params.include_archived ?? false;

					const matches: Record<string, unknown>[] = [];
					let cursor = params.cursor as string | undefined;
					let pages = 0;
					const maxPages = 10;

					while (matches.length < limit && pages < maxPages) {
						const body: Record<string, unknown> = {
							types,
							limit: 200,
							exclude_archived: !includeArchived,
						};
						if (cursor) body.cursor = cursor;

						const data = await callSlackApi("conversations.list", body, "read");
						const channels = data.channels as Record<string, unknown>[];
						if (!channels?.length) break;

						for (const ch of channels) {
							const name = ((ch.name as string) ?? "").toLowerCase();
							const topic = ((ch.topic as Record<string, unknown>)?.value as string ?? "").toLowerCase();
							const purpose = ((ch.purpose as Record<string, unknown>)?.value as string ?? "").toLowerCase();
							if (name.includes(query) || topic.includes(query) || purpose.includes(query)) {
								matches.push(ch);
								if (matches.length >= limit) break;
							}
						}

						const nextCursor =
							(data.response_metadata as Record<string, unknown>)?.next_cursor as string;
						if (!nextCursor) break;
						cursor = nextCursor;
						pages++;
					}

					if (matches.length === 0) return ok("No channels found matching the query.");

					const lines = matches.map((ch) => {
						const id = ch.id as string;
						const name = ch.name as string;
						const archived = ch.is_archived ? " [archived]" : "";
						const topic = (ch.topic as Record<string, unknown>)?.value as string;
						const purpose = (ch.purpose as Record<string, unknown>)?.value as string;
						const members = ch.num_members as number;
						let line = `**${name}** (${id})${archived} — ${members ?? "?"} members`;
						if (topic) line += `\n  Topic: ${topic}`;
						if (purpose) line += `\n  Purpose: ${purpose}`;
						return line;
					});

					return ok(
						`Found ${matches.length} channel(s):\n\n${lines.join("\n\n")}`,
						matches,
					);
				}),
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
				limit: Type.Optional(Type.Number({ description: "Max results, up to 20. Default: 20" })),
				cursor: Type.Optional(Type.String({ description: "Pagination cursor" })),
			}),
			execute: (_id, params) =>
				safecall(async () => {
					const query = (params.query as string).toLowerCase();
					const limit = Math.min((params.limit as number) ?? 20, 20);
					const queryTerms = query.split(/\s+/).filter(Boolean);

					// Check if query looks like an email
					if (query.includes("@") && !query.startsWith("@")) {
						try {
							const data = await callSlackApi(
								"users.lookupByEmail",
								{ email: params.query },
								"read",
							);
							const user = data.user as Record<string, unknown>;
							return ok(formatUserResult(user), [user]);
						} catch {
							// Fall through to list search
						}
					}

					const matches: Record<string, unknown>[] = [];
					let cursor = params.cursor as string | undefined;
					let pages = 0;
					const maxPages = 10;

					while (matches.length < limit && pages < maxPages) {
						const body: Record<string, unknown> = { limit: 200 };
						if (cursor) body.cursor = cursor;

						const data = await callSlackApi("users.list", body, "read");
						const members = data.members as Record<string, unknown>[];
						if (!members?.length) break;

						for (const u of members) {
							if (u.deleted || u.is_bot) continue;
							const profile = u.profile as Record<string, unknown>;
							const searchable = [
								u.name,
								u.real_name,
								profile?.email,
								profile?.title,
								profile?.display_name,
								profile?.real_name_normalized,
							]
								.filter(Boolean)
								.join(" ")
								.toLowerCase();

							if (queryTerms.every((t) => searchable.includes(t))) {
								matches.push(u);
								if (matches.length >= limit) break;
							}
						}

						const nextCursor =
							(data.response_metadata as Record<string, unknown>)?.next_cursor as string;
						if (!nextCursor) break;
						cursor = nextCursor;
						pages++;
					}

					if (matches.length === 0) return ok("No users found matching the query.");

					const lines = matches.map(formatUserResult);
					return ok(
						`Found ${matches.length} user(s):\n\n${lines.join("\n\n")}`,
						matches,
					);
				}),
		},

		// ── Read ──────────────────────────────────────────────────────────────

		{
			name: "slack_read_channel",
			label: "Read Slack Channel",
			description: `Read messages from a Slack channel (newest first). To read DM history, use a user_id as channel_id. Use slack_read_thread with a message's ts to read thread replies. Use slack_search_channels to find a channel ID by name.`,
			parameters: Type.Object({
				channel_id: Type.String({ description: "Channel, group, or DM ID" }),
				limit: Type.Optional(
					Type.Number({ description: "Messages to return, 1-100. Default: 100" }),
				),
				oldest: Type.Optional(Type.String({ description: "Start of time range (timestamp)" })),
				latest: Type.Optional(Type.String({ description: "End of time range (timestamp)" })),
				cursor: Type.Optional(Type.String({ description: "Pagination cursor" })),
			}),
			execute: (_id, params) =>
				safecall(async () => {
					const body: Record<string, unknown> = {
						channel: params.channel_id,
						limit: Math.min((params.limit as number) ?? 100, 100),
					};
					if (params.oldest) body.oldest = params.oldest;
					if (params.latest) body.latest = params.latest;
					if (params.cursor) body.cursor = params.cursor;

					const data = await callSlackApi("conversations.history", body, "read");
					const messages = data.messages as Record<string, unknown>[];
					const hasMore = data.has_more as boolean;
					const nextCursor =
						(data.response_metadata as Record<string, unknown>)?.next_cursor as string;

					if (!messages?.length) return ok("No messages found.");

					const lines = messages.map(formatMessage);
					let result = `${messages.length} message(s):\n\n${lines.join("\n")}`;
					if (hasMore && nextCursor) {
						result += `\n\nMore messages available. cursor: ${nextCursor}`;
					}
					return ok(result, data);
				}),
		},

		{
			name: "slack_read_thread",
			label: "Read Slack Thread",
			description: `Read messages from a specific Slack thread (parent message + all replies). Requires channel_id and message_ts of the parent message. Use slack_search_public or slack_read_channel to find these values.`,
			parameters: Type.Object({
				channel_id: Type.String({ description: "Channel containing the thread" }),
				message_ts: Type.String({ description: "Timestamp of the parent message" }),
				limit: Type.Optional(
					Type.Number({ description: "Messages to return, 1-1000. Default: 100" }),
				),
				oldest: Type.Optional(Type.String({ description: "Start of time range" })),
				latest: Type.Optional(Type.String({ description: "End of time range" })),
				cursor: Type.Optional(Type.String({ description: "Pagination cursor" })),
			}),
			execute: (_id, params) =>
				safecall(async () => {
					const body: Record<string, unknown> = {
						channel: params.channel_id,
						ts: params.message_ts,
						limit: Math.min((params.limit as number) ?? 100, 1000),
					};
					if (params.oldest) body.oldest = params.oldest;
					if (params.latest) body.latest = params.latest;
					if (params.cursor) body.cursor = params.cursor;

					const data = await callSlackApi("conversations.replies", body, "read");
					const messages = data.messages as Record<string, unknown>[];
					const hasMore = data.has_more as boolean;
					const nextCursor =
						(data.response_metadata as Record<string, unknown>)?.next_cursor as string;

					if (!messages?.length) return ok("No thread messages found.");

					const lines = messages.map(formatMessage);
					let result = `Thread (${messages.length} message(s)):\n\n${lines.join("\n")}`;
					if (hasMore && nextCursor) {
						result += `\n\nMore replies available. cursor: ${nextCursor}`;
					}
					return ok(result, data);
				}),
		},

		{
			name: "slack_read_user_profile",
			label: "Read Slack User Profile",
			description: `Read detailed profile information for a Slack user: name, email, title, status, timezone, phone. Defaults to current user if user_id not provided. Use slack_search_users to find a user ID.`,
			parameters: Type.Object({
				user_id: Type.Optional(
					Type.String({ description: "Slack user ID (e.g. U0ABC12345). Omit for current user." }),
				),
			}),
			execute: (_id, params) =>
				safecall(async () => {
					const body: Record<string, unknown> = {};
					if (params.user_id) body.user = params.user_id;

					// users.info gives us more than users.profile.get
					const data = await callSlackApi("users.info", body, "read");
					const user = data.user as Record<string, unknown>;
					const profile = user.profile as Record<string, unknown>;

					const lines: string[] = [];
					lines.push(`**${user.real_name ?? user.name}** (<@${user.id}>)`);
					if (profile.title) lines.push(`Title: ${profile.title}`);
					if (profile.email) lines.push(`Email: ${profile.email}`);
					if (profile.phone) lines.push(`Phone: ${profile.phone}`);
					if (profile.status_text)
						lines.push(
							`Status: ${profile.status_emoji ?? ""} ${profile.status_text}`.trim(),
						);
					if (user.tz_label) lines.push(`Timezone: ${user.tz_label} (${user.tz})`);
					if (user.is_admin) lines.push("Role: Workspace Admin");
					if (user.is_owner) lines.push("Role: Workspace Owner");

					return ok(lines.join("\n"), data);
				}),
		},

		{
			name: "slack_read_canvas",
			label: "Read Slack Canvas",
			description: `Read the content and section IDs of a Slack Canvas document. Returns markdown content and section_id_mapping for use with slack_update_canvas. Use slack_search_public to find canvases by name.`,
			parameters: Type.Object({
				canvas_id: Type.String({ description: "Canvas file ID (e.g. F1234567890)" }),
			}),
			execute: (_id, params) =>
				safecall(async () => {
					const data = await callSlackApi(
						"canvases.sections.lookup",
						{ canvas_id: params.canvas_id },
						"read",
					);

					const sections = data.sections as Record<string, unknown>[];
					if (!sections?.length) return ok("Canvas is empty or not found.");

					const lines: string[] = [];
					const sectionMap: Record<string, string> = {};

					for (const section of sections) {
						const id = section.id as string;
						const content = section.markdown as string ?? section.content as string ?? "";
						sectionMap[id] = content;
						lines.push(`[section: ${id}]\n${content}`);
					}

					return ok(
						`Canvas ${params.canvas_id}:\n\n${lines.join("\n\n")}` +
							`\n\nsection_id_mapping: ${JSON.stringify(sectionMap)}`,
						data,
					);
				}),
		},

		// ── Canvas Write ──────────────────────────────────────────────────────

		{
			name: "slack_create_canvas",
			label: "Create Slack Canvas",
			description: `Create a Slack Canvas document from Canvas-flavored Markdown content. Returns the canvas ID and link.
${CANVAS_FORMAT_GUIDELINES}`,
			parameters: Type.Object({
				title: Type.String({ description: "Canvas title (do not repeat in content)" }),
				content: Type.String({ description: "Canvas content as Canvas-flavored Markdown" }),
			}),
			execute: (_id, params) =>
				safecall(async () => {
					const data = await callSlackApi(
						"canvases.create",
						{
							title: params.title,
							document_content: {
								type: "markdown",
								markdown: params.content,
							},
						},
						"write",
					);

					const canvasId = data.canvas_id as string;
					return ok(
						`Canvas created: ${canvasId}\nLink: https://slack.com/docs/${canvasId}`,
						data,
					);
				}),
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
				content: Type.String({ description: "Canvas-flavored Markdown content" }),
				section_id: Type.Optional(
					Type.String({ description: "Section ID from slack_read_canvas. STRONGLY recommended for replace." }),
				),
			}),
			execute: (_id, params) =>
				safecall(async () => {
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

					const data = await callSlackApi(
						"canvases.edit",
						{
							canvas_id: params.canvas_id,
							changes: [change],
						},
						"write",
					);

					// Re-read to return updated section mapping
					try {
						const readData = await callSlackApi(
							"canvases.sections.lookup",
							{ canvas_id: params.canvas_id },
							"read",
						);
						const sections = readData.sections as Record<string, unknown>[];
						const sectionMap: Record<string, string> = {};
						if (sections) {
							for (const s of sections) {
								sectionMap[s.id as string] = (s.markdown as string) ?? (s.content as string) ?? "";
							}
						}
						return ok(
							`Canvas updated: ${params.canvas_id}\n` +
								`Link: https://slack.com/docs/${params.canvas_id}\n` +
								`section_id_mapping: ${JSON.stringify(sectionMap)}`,
							{ ...data, section_id_mapping: sectionMap },
						);
					} catch {
						return ok(`Canvas updated: ${params.canvas_id}`, data);
					}
				}),
		},
	];
}

// ─── Search Implementation ────────────────────────────────────────────────────

async function doSearch(
	params: Record<string, unknown>,
	includePrivate: boolean,
): Promise<ToolResult> {
	const query = params.query as string;
	const contentTypes = ((params.content_types as string) ?? "messages").split(",").map((s) => s.trim());
	const sort = (params.sort as string) ?? "score";
	const sortDir = (params.sort_dir as string) ?? "desc";
	const limit = Math.min((params.limit as number) ?? 20, 20);

	const results: string[] = [];

	if (contentTypes.includes("messages")) {
		const body: Record<string, unknown> = {
			query,
			sort,
			sort_dir: sortDir,
			count: limit,
		};
		if (params.cursor) body.cursor = params.cursor;

		const data = await callSlackApi("search.messages", body, "read");
		const messages = data.messages as Record<string, unknown>;
		const matches = messages?.matches as Record<string, unknown>[];
		const total = messages?.total as number;

		if (matches?.length) {
			results.push(`**Messages** (${total} total, showing ${matches.length}):\n`);
			for (const m of matches) {
				const ts = m.ts as string;
				const user = m.username as string ?? m.user as string ?? "unknown";
				const text = m.text as string ?? "";
				const channel = m.channel as Record<string, unknown>;
				const chName = channel?.name as string ?? "?";
				const permalink = m.permalink as string ?? "";
				const truncated = text.length > 300 ? text.slice(0, 300) + "…" : text;
				results.push(
					`[${tsToDate(ts)}] @${user} in #${chName}: ${truncated}` +
						(permalink ? `\n  ${permalink}` : ""),
				);
			}

			const paging = messages?.paging as Record<string, unknown>;
			if (paging) {
				const totalPages = paging.pages as number;
				const currentPage = paging.page as number;
				if (currentPage < totalPages) {
					results.push(`\nMore results available (page ${currentPage}/${totalPages})`);
				}
			}
		} else {
			results.push("**Messages**: No matches found.");
		}
	}

	if (contentTypes.includes("files")) {
		const body: Record<string, unknown> = {
			query,
			sort,
			sort_dir: sortDir,
			count: limit,
		};

		const data = await callSlackApi("search.files", body, "read");
		const files = data.files as Record<string, unknown>;
		const matches = files?.matches as Record<string, unknown>[];
		const total = files?.total as number;

		if (matches?.length) {
			results.push(`\n**Files** (${total} total, showing ${matches.length}):\n`);
			for (const f of matches) {
				const name = f.name as string ?? "untitled";
				const filetype = f.filetype as string ?? "?";
				const user = f.user as string ?? "unknown";
				const permalink = f.permalink as string ?? "";
				results.push(`${name} (${filetype}) by <@${user}> — ${permalink}`);
			}
		} else if (contentTypes.includes("files")) {
			results.push("\n**Files**: No matches found.");
		}
	}

	return ok(results.join("\n"), null);
}

// ─── User Formatting ──────────────────────────────────────────────────────────

function formatUserResult(user: Record<string, unknown>): string {
	const profile = user.profile as Record<string, unknown>;
	const lines: string[] = [];
	lines.push(
		`**${user.real_name ?? user.name}** (${user.id}) — @${user.name}`,
	);
	if (profile?.title) lines.push(`  Title: ${profile.title}`);
	if (profile?.email) lines.push(`  Email: ${profile.email}`);
	if (profile?.display_name) lines.push(`  Display: ${profile.display_name}`);
	return lines.join("\n");
}
