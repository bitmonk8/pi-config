/**
 * Work Profile Extension
 *
 * Switches between work profiles (unity, unity-pilot, personal) by writing
 * a virtual "active" provider into models.json with tier aliases: fast,
 * balanced, smart.  Subagent .md files use `model: fast`, `model: balanced`,
 * or `model: smart` and the subprocess resolves them against the "active"
 * provider at launch time — no runtime provider injection needed.
 *
 * Config: profiles.json (sibling to this file, or ~/.pi/agent/profiles.json)
 *
 * Usage:
 *   /profile              — show selector
 *   /profile unity-pilot  — switch directly
 *   Ctrl+Shift+P          — cycle profiles
 *   --profile <name>      — CLI flag
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

// ── Types ───────────────────────────────────────────────────────────────

interface TierModel {
	id: string;
	name: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface Profile {
	description?: string;
	/** Source provider name in models.json to read baseUrl from */
	provider: string;
	/** API type for the active provider */
	api: string;
	/** API key env var name or literal */
	apiKey: string;
	/** Tier → model mapping */
	tiers: {
		fast: TierModel;
		balanced: TierModel;
		smart: TierModel;
	};
	/** Which tier to use as the main-session default */
	default?: "fast" | "balanced" | "smart";
}

interface ProfilesConfig {
	[name: string]: Profile;
}

// ── Helpers ─────────────────────────────────────────────────────────────

const ACTIVE_PROVIDER = "active";
const TIER_NAMES = ["fast", "balanced", "smart"] as const;

function getModelsJsonPath(): string {
	return join(getAgentDir(), "models.json");
}

function getSettingsJsonPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Load profiles.json from next to this extension, or from ~/.pi/agent/ */
function loadProfiles(): ProfilesConfig {
	const locations = [
		join(dirname(import.meta.url.replace("file:///", "").replace("file://", "")), "profiles.json"),
		join(getAgentDir(), "profiles.json"),
	];
	for (const loc of locations) {
		const p = loc.replace(/\\/g, "/");
		if (existsSync(p)) {
			try {
				return JSON.parse(readFileSync(p, "utf-8"));
			} catch (err) {
				console.error(`Failed to parse ${p}: ${err}`);
			}
		}
	}
	return {};
}

/** Read current models.json (or empty scaffold). */
function readModelsJson(): { providers: Record<string, any> } {
	const p = getModelsJsonPath();
	if (existsSync(p)) {
		try {
			return JSON.parse(readFileSync(p, "utf-8"));
		} catch {
			return { providers: {} };
		}
	}
	return { providers: {} };
}

/** Read settings.json */
function readSettings(): Record<string, any> {
	const p = getSettingsJsonPath();
	if (existsSync(p)) {
		try {
			return JSON.parse(readFileSync(p, "utf-8"));
		} catch {
			return {};
		}
	}
	return {};
}

/**
 * Write the "active" provider into models.json.
 *
 * Reads the source provider's baseUrl from models.json so the active
 * provider points at the same endpoint.  Writes tier models (fast,
 * balanced, smart) under the "active" provider.
 */
function writeActiveProvider(profile: Profile): void {
	const modelsJson = readModelsJson();
	const sourceProvider = modelsJson.providers[profile.provider];

	const baseUrl: string = sourceProvider?.baseUrl ?? `https://missing-baseUrl-for-${profile.provider}`;

	// Build tier model entries. Agent .md files reference these as
	// "active/fast", "active/balanced", "active/smart" — the provider
	// qualifier avoids name collisions with built-in models.
	const models = TIER_NAMES.map((tier) => {
		const src = profile.tiers[tier];
		return {
			id: src.id,
			name: tier,
			reasoning: src.reasoning ?? false,
			input: src.input ?? ["text"],
			contextWindow: src.contextWindow ?? 200_000,
			maxTokens: src.maxTokens ?? 16384,
			cost: src.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
	});

	modelsJson.providers[ACTIVE_PROVIDER] = {
		baseUrl,
		api: profile.api,
		apiKey: profile.apiKey,
		models,
	};

	writeFileSync(getModelsJsonPath(), JSON.stringify(modelsJson, null, 2), "utf-8");
}

/** Update settings.json default provider + model. */
function writeSettings(profile: Profile, profileName: string): void {
	const settings = readSettings();
	const defaultTier = profile.default ?? "smart";
	const defaultModel = profile.tiers[defaultTier];

	// Set main session to use the source provider's smart model directly
	// (the main session should use the real provider, not "active")
	settings.defaultProvider = profile.provider;
	settings.defaultModel = defaultModel.id;

	// Persist which profile is active for session_start restore
	settings._activeProfile = profileName;

	writeFileSync(getSettingsJsonPath(), JSON.stringify(settings, null, 2), "utf-8");
}

// ── Extension ───────────────────────────────────────────────────────────

export default function workProfile(pi: ExtensionAPI) {
	let profiles: ProfilesConfig = {};
	let activeProfileName: string | undefined;

	pi.registerFlag("profile", {
		description: "Work profile to activate (e.g. unity, unity-pilot, personal)",
		type: "string",
	});

	// ── Apply ─────────────────────────────────────────────────────────

	async function applyProfile(name: string, ctx: ExtensionContext): Promise<boolean> {
		const profile = profiles[name];
		if (!profile) {
			ctx.ui.notify(`Unknown profile "${name}". Available: ${Object.keys(profiles).join(", ")}`, "error");
			return false;
		}

		// 1. Write "active" provider with tier aliases into models.json
		writeActiveProvider(profile);

		// 2. Update settings.json defaults
		writeSettings(profile, name);

		// 3. Switch the current session's model to the profile default
		const defaultTier = profile.default ?? "smart";
		const defaultModel = profile.tiers[defaultTier];
		const model = ctx.modelRegistry.find(profile.provider, defaultModel.id);
		if (model) {
			const ok = await pi.setModel(model);
			if (!ok) {
				ctx.ui.notify(`Profile "${name}": no API key for ${profile.provider}/${defaultModel.id}`, "warning");
			}
		} else {
			ctx.ui.notify(`Profile "${name}": model ${profile.provider}/${defaultModel.id} not found`, "warning");
		}

		activeProfileName = name;
		updateStatus(ctx);
		return true;
	}

	// ── Status ────────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext) {
		if (activeProfileName) {
			ctx.ui.setStatus("profile", ctx.ui.theme.fg("accent", `profile:${activeProfileName}`));
		} else {
			ctx.ui.setStatus("profile", undefined);
		}
	}

	// ── Command ───────────────────────────────────────────────────────

	pi.registerCommand("profile", {
		description: "Switch work profile (billing context)",
		getArgumentCompletions: (prefix: string) => {
			const names = Object.keys(profiles);
			const filtered = names.filter((n) => n.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((n) => ({ value: n, label: n })) : null;
		},
		handler: async (args, ctx) => {
			profiles = loadProfiles();

			if (args?.trim()) {
				const name = args.trim();
				const ok = await applyProfile(name, ctx);
				if (ok) ctx.ui.notify(`Profile "${name}" activated`, "info");
				return;
			}

			// Interactive selector
			const names = Object.keys(profiles);
			if (names.length === 0) {
				ctx.ui.notify("No profiles defined. Create profiles.json in your pi-config package.", "warning");
				return;
			}

			const items = names.map((name) => {
				const p = profiles[name];
				const isActive = name === activeProfileName;
				const desc = p.description ?? `${p.provider} (${Object.values(p.tiers).map((t) => t.name).join(", ")})`;
				return {
					value: name,
					label: isActive ? `${name} (active)` : name,
					description: desc,
				};
			});

			const choice = await ctx.ui.select("Select work profile:", items);
			if (!choice) return;

			const ok = await applyProfile(choice, ctx);
			if (ok) ctx.ui.notify(`Profile "${choice}" activated`, "info");
		},
	});

	// ── Shortcut ──────────────────────────────────────────────────────

	pi.registerShortcut(Key.ctrlShift("p"), {
		description: "Cycle work profiles",
		handler: async (ctx) => {
			profiles = loadProfiles();
			const names = Object.keys(profiles);
			if (names.length === 0) return;

			const currentIdx = activeProfileName ? names.indexOf(activeProfileName) : -1;
			const nextIdx = (currentIdx + 1) % names.length;
			const nextName = names[nextIdx];

			const ok = await applyProfile(nextName, ctx);
			if (ok) ctx.ui.notify(`Profile "${nextName}" activated`, "info");
		},
	});

	// ── Init ──────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		profiles = loadProfiles();

		// CLI flag takes precedence
		const flagValue = pi.getFlag("profile");
		if (typeof flagValue === "string" && flagValue) {
			await applyProfile(flagValue, ctx);
			return;
		}

		// Restore from settings.json (persisted across sessions)
		const settings = readSettings();
		const saved = settings._activeProfile as string | undefined;
		if (saved && profiles[saved]) {
			activeProfileName = saved;
			// Don't re-apply model on restore — just track the name
		}

		updateStatus(ctx);
	});
}
