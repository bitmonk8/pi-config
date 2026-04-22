/**
 * Freepik Extension for Pi
 *
 * Exposes Freepik's text-to-image generation API as pi tools so the LLM can
 * produce illustrative imagery (hero illustrations, branded visuals, posters,
 * design assets) directly from a conversation.
 *
 * Models supported:
 *   - seedream-v4-5    (default) Best for diagrams/posters/typography work
 *   - flux-kontext-pro Strong general-purpose design model with reference image
 *   - mystic           Photorealistic — for photo-style imagery, not diagrams
 *
 * Setup: set FREEPIK_API_KEY in the environment. Get a key from
 *   https://www.freepik.com/developers/dashboard
 *
 * Note on technical diagrams: Freepik's image models are not suited to
 * generating accurate boxes/arrows/labelled flowcharts. For those, prefer
 * Mermaid / Graphviz / PlantUML. This extension is for visually rich
 * illustrative content.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { hasApiKey } from "./freepik-client.js";
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
		if (hasApiKey()) {
			ctx.ui.notify(`Freepik: ${tools.length} tools (FREEPIK_API_KEY ✓)`, "info");
		} else {
			ctx.ui.notify(
				`Freepik: ${tools.length} tools registered, but FREEPIK_API_KEY is not set — ` +
					"tools will fail until the env var is configured.",
				"warn",
			);
		}
	});
}
