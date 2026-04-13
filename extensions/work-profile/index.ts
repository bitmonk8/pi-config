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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Resolve the package root (directory containing package.json). */
function getPackageRoot(): string {
	const extensionDir = dirname(fileURLToPath(import.meta.url));
	// Walk up until we find package.json
	let dir = extensionDir;
	for (let i = 0; i < 10; i++) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return extensionDir;
}

/** Load profiles.json from the package root, or from ~/.pi/agent/ */
function loadProfiles(): ProfilesConfig {
	const locations = [
		join(getPackageRoot(), "profiles.json"),
		join(getAgentDir(), "profiles.json"),
	];
	for (const loc of locations) {
		if (existsSync(loc)) {
			try {
				return JSON.parse(readFileSync(loc, "utf-8"));
			} catch (err) {
				console.error(`Failed to parse ${loc}: ${err}`);
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
	let activeTier: typeof TIER_NAMES[number] | undefined;

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
		activeTier = defaultTier;
		updateStatus(ctx);
		return true;
	}

	// ── Status ────────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext) {
		const parts: string[] = [];
		if (activeProfileName) parts.push(activeProfileName);
		if (activeTier) parts.push(activeTier);
		if (parts.length > 0) {
			ctx.ui.setStatus("profile", ctx.ui.theme.fg("accent", parts.join("/")));
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

			const displayNames = names.map((name) => {
				const p = profiles[name];
				const isActive = name === activeProfileName;
				const desc = p.description ?? p.provider;
				return isActive ? `${name} (active) — ${desc}` : `${name} — ${desc}`;
			});

			const choice = await ctx.ui.select("Select work profile:", displayNames);
			if (!choice) return;

			// Extract profile name from display string
			const profileName = choice.split(" ")[0];
			const ok = await applyProfile(profileName, ctx);
			if (ok) ctx.ui.notify(`Profile "${choice}" activated`, "info");
		},
	});

	// ── Tier switching ────────────────────────────────────────────────

	async function applyTier(tier: typeof TIER_NAMES[number], ctx: ExtensionContext): Promise<boolean> {
		if (!activeProfileName) {
			ctx.ui.notify("No active profile. Use /profile first.", "warning");
			return false;
		}
		const profile = profiles[activeProfileName];
		if (!profile) return false;

		const tierModel = profile.tiers[tier];
		const model = ctx.modelRegistry.find(profile.provider, tierModel.id);
		if (model) {
			const ok = await pi.setModel(model);
			if (!ok) {
				ctx.ui.notify(`No API key for ${profile.provider}/${tierModel.id}`, "warning");
				return false;
			}
		} else {
			ctx.ui.notify(`Model ${profile.provider}/${tierModel.id} not found`, "warning");
			return false;
		}

		activeTier = tier;
		updateStatus(ctx);
		return true;
	}

	pi.registerCommand("tier", {
		description: "Switch model tier (fast, balanced, smart)",
		getArgumentCompletions: (prefix: string) => {
			const filtered = TIER_NAMES.filter((t) => t.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((t) => ({ value: t, label: t })) : null;
		},
		handler: async (args, ctx) => {
			if (args?.trim()) {
				const tier = args.trim() as typeof TIER_NAMES[number];
				if (!TIER_NAMES.includes(tier)) {
					ctx.ui.notify(`Unknown tier "${tier}". Available: ${TIER_NAMES.join(", ")}`, "error");
					return;
				}
				const ok = await applyTier(tier, ctx);
				if (ok) ctx.ui.notify(`Tier: ${tier}`, "info");
				return;
			}

			// Interactive selector
			if (!activeProfileName) {
				ctx.ui.notify("No active profile. Use /profile first.", "warning");
				return;
			}
			const profile = profiles[activeProfileName];
			if (!profile) return;

			const displayNames = TIER_NAMES.map((tier) => {
				const m = profile.tiers[tier];
				const isActive = tier === activeTier;
				return isActive ? `${tier} (active) — ${m.name}` : `${tier} — ${m.name}`;
			});

			const choice = await ctx.ui.select("Select model tier:", displayNames);
			if (!choice) return;

			const tierName = choice.split(" ")[0] as typeof TIER_NAMES[number];
			const ok = await applyTier(tierName, ctx);
			if (ok) ctx.ui.notify(`Tier: ${tierName}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlShift("t"), {
		description: "Cycle model tiers (fast → balanced → smart)",
		handler: async (ctx) => {
			if (!activeProfileName) {
				ctx.ui.notify("No active profile. Use /profile first.", "warning");
				return;
			}

			const currentIdx = activeTier ? TIER_NAMES.indexOf(activeTier) : -1;
			const nextIdx = (currentIdx + 1) % TIER_NAMES.length;
			const nextTier = TIER_NAMES[nextIdx];

			const ok = await applyTier(nextTier, ctx);
			if (ok) ctx.ui.notify(`Tier: ${nextTier}`, "info");
		},
	});

	// ── Profile shortcut ─────────────────────────────────────────────

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
