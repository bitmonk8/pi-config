/**
 * Slack Extension for Pi — Hybrid (MCP reads + Direct API writes)
 *
 * Read operations route through Slack's MCP server (mcp.slack.com) using
 * the Claude Code OAuth token — full access to search, DMs, private channels.
 *
 * Write operations use a bot token (direct Slack Web API) so messages
 * appear from the bot identity and arrive as unread notifications.
 * If no bot token is configured, writes fall back to MCP (user identity).
 *
 * Bot token setup: create ~/.pi/slack-config.json:
 *   { "botToken": "xoxb-your-bot-token-here" }
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { hasBotToken } from "./slack-client.js";
import { createTools } from "./tools.js";

export default function (pi: ExtensionAPI) {
	const tools = createTools();

	for (const tool of tools) {
		pi.registerTool({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			execute: tool.execute,
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		const bot = hasBotToken();
		const msg = bot
			? `Slack: ${tools.length} tools (bot writes ✓, MCP reads ✓)`
			: `Slack: ${tools.length} tools (MCP reads ✓, no bot token — writes as you)`;
		ctx.ui.notify(msg, bot ? "info" : "warn");
	});
}
