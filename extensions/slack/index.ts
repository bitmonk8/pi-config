/**
 * Slack Extension for Pi — Direct Web API
 *
 * Replaces the MCP-based slack extension with direct Slack Web API calls.
 *
 * Token setup:
 * - User token: automatically read from Claude Code's OAuth credentials
 *   (~/.claude/.credentials.json). Used for all read operations.
 * - Bot token (optional): read from ~/.pi/slack-config.json. Used for write
 *   operations so messages appear from the bot (unread notifications).
 *   If not configured, writes fall back to the user token.
 *
 * To configure the bot token, create ~/.pi/slack-config.json:
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
		const botConfigured = hasBotToken();
		const mode = botConfigured
			? "bot token for writes, user token for reads"
			: "user token only (configure ~/.pi/slack-config.json for bot writes)";
		ctx.ui.notify(`Slack: ${tools.length} tools registered (${mode})`, "info");
	});
}
