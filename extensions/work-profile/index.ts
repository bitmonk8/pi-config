/**
 * Work Profile Extension
 *
 * Switches between work profiles (unity, unity-pilot, personal) by writing
 * a virtual "active" provider into models.json with tier aliases: fast,
 * balanced, smart.  Subagent .md files use `model: active/fast` etc. and
 * the subprocess resolves them via models.json at launch time.
 *
 * Also provides /refresh-models to rediscover available models from the
 * Unity LiteLLM proxy (replaces configure_pi_models.nu).
 *
 * Config: profiles.json (package root or ~/.pi/agent/profiles.json)
 *
 * Usage:
 *   /profile              — show selector
 *   /profile unity-pilot  — switch directly
 *   Ctrl+Shift+P          — cycle profiles
 *   --profile <name>      — CLI flag
 *   /tier                 — show tier selector
 *   /tier fast            — switch directly
 *   Ctrl+Shift+T          — cycle tiers
 *   /refresh-models       — rediscover models from Unity LiteLLM and OpenRouter
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

// ── Types ───────────────────────────────────────────────────────────────

interface TierModel {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface Profile {
	description?: string;
	/** Source provider name in models.json — also the authoritative source of baseUrl, api, and apiKey */
	provider: string;
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

/** Load profiles.json — personal override (~/.pi/agent/) takes precedence over package default */
function loadProfiles(): ProfilesConfig {
	const locations = [
		join(getAgentDir(), "profiles.json"),
		join(getPackageRoot(), "profiles.json"),
	];
	for (const loc of locations) {
		if (existsSync(loc)) {
			try {
				const loaded = JSON.parse(readFileSync(loc, "utf-8")) as ProfilesConfig;
				for (const [profileName, profile] of Object.entries(loaded)) {
					const raw = profile as Record<string, unknown>;
					if ("api" in raw || "apiKey" in raw) {
						console.warn(
							`[work-profile] profiles.json entry "${profileName}" contains deprecated ` +
							`fields "api" and/or "apiKey". These are now read from models.json. ` +
							`Please remove them from profiles.json.`,
						);
					}
				}
				return loaded;
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

	// All transport config comes from models.json — profiles.json is not authoritative.
	const baseUrl: string = sourceProvider?.baseUrl ?? `https://missing-baseUrl-for-${profile.provider}`;
	const api:     string = sourceProvider?.api     ?? "openai-completions";
	const apiKey:  string = sourceProvider?.apiKey  ?? "";

	// Look up each tier's full model metadata from the source provider so
	// capabilities (context window, cost, etc.) stay in sync with models.json.
	const sourceModels: ModelEntry[] = Array.isArray(sourceProvider?.models)
		? (sourceProvider.models as ModelEntry[])
		: [];

	// Build tier model entries. Agent .md files reference these as
	// "active/fast", "active/balanced", "active/smart" — the provider
	// qualifier avoids name collisions with built-in models.
	const models = TIER_NAMES.map((tier) => {
		const tierDef = profile.tiers[tier];
		const sourceModel = sourceModels.find((m) => m.id === tierDef.id);
		return sourceModel
			? { ...sourceModel, name: tier }
			: {
				id: tierDef.id,
				name: tier,
				reasoning: false,
				input: ["text"] as string[],
				contextWindow: 200_000,
				maxTokens: 16_384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
	});

	modelsJson.providers[ACTIVE_PROVIDER] = {
		baseUrl,
		api,
		apiKey,
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

// ── Model refresh (replaces configure_pi_models.nu) ──────────────────────

const UNITY_BASE_URL = "https://uai-litellm.internal.unity.com";

interface LiteLLMModelInfo {
	model_name: string;
	model_info: {
		mode?: string;
		supports_vision?: boolean;
		supports_reasoning?: boolean;
		max_input_tokens?: number;
		max_output_tokens?: number;
		input_cost_per_token?: number;
		output_cost_per_token?: number;
		cache_read_input_token_cost?: number;
		cache_creation_input_token_cost?: number;
	};
}

interface ModelEntry {
	id: string;
	name: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

async function fetchModelIds(key: string): Promise<string[]> {
	const resp = await fetch(`${UNITY_BASE_URL}/v1/models`, {
		headers: { Authorization: `Bearer ${key}` },
	});
	if (!resp.ok) throw new Error(`/v1/models: ${resp.status} ${resp.statusText}`);
	const data = await resp.json() as { data: { id: string }[] };
	return data.data.map((m) => m.id);
}

async function fetchModelInfo(key: string): Promise<Map<string, LiteLLMModelInfo>> {
	const resp = await fetch(`${UNITY_BASE_URL}/model/info`, {
		headers: { Authorization: `Bearer ${key}` },
	});
	if (!resp.ok) throw new Error(`/model/info: ${resp.status} ${resp.statusText}`);
	const data = await resp.json() as { data: LiteLLMModelInfo[] };
	const map = new Map<string, LiteLLMModelInfo>();
	for (const entry of data.data) {
		if (!map.has(entry.model_name)) map.set(entry.model_name, entry);
	}
	return map;
}

function toLookupName(id: string): string {
	if (id.startsWith("anthropic.")) {
		return id
			.replace(/^anthropic\./, "")
			.replace("-engine-eng", "")
			.replace(/-v\d+(?::\d+)?$/, "");
	}
	return id;
}

function isDuplicate(id: string): boolean {
	return id.endsWith("-ent-ai") || id.endsWith("-qa");
}

function hasCleanTwin(id: string, allIds: Set<string>): boolean {
	if (!id.endsWith("-engine-eng")) return false;
	return allIds.has(id.replace("-engine-eng", ""));
}

function isClaudeModel(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.includes("claude") || lower.includes("anthropic");
}

function buildModels(
	allIds: string[],
	modelInfo: Map<string, LiteLLMModelInfo>,
	mode: string,
): ModelEntry[] {
	const idSet = new Set(allIds);
	return allIds
		.filter((id) => !isDuplicate(id))
		.filter((id) => !hasCleanTwin(id, idSet))
		.flatMap((id) => {
			const info = modelInfo.get(toLookupName(id));
			if (!info || info.model_info.mode !== mode) return [];
			const mi = info.model_info;
			return [{
				id,
				name: toLookupName(id),
				reasoning: mi.supports_reasoning ?? false,
				input: (mi.supports_vision ?? false) ? ["text", "image"] : ["text"],
				contextWindow: mi.max_input_tokens ?? 128_000,
				maxTokens: mi.max_output_tokens ?? 16_384,
				cost: {
					input: (mi.input_cost_per_token ?? 0) * 1_000_000,
					output: (mi.output_cost_per_token ?? 0) * 1_000_000,
					cacheRead: (mi.cache_read_input_token_cost ?? 0) * 1_000_000,
					cacheWrite: (mi.cache_creation_input_token_cost ?? 0) * 1_000_000,
				},
			}];
		});
}

function selectDefaultOpus(models: ModelEntry[]): ModelEntry | undefined {
	const candidates = models.filter(
		(m) => m.name.includes("opus") && m.contextWindow >= 1_000_000,
	);
	if (candidates.length === 0) return undefined;
	return candidates.sort((a, b) => {
		const score = (name: string) => {
			const m = name.match(/opus-(\d+)-(\d+)/);
			return m ? parseInt(m[1]) * 100 + parseInt(m[2]) : 0;
		};
		return score(b.name) - score(a.name);
	})[0];
}

function selectDefaultSonnet(models: ModelEntry[]): ModelEntry | undefined {
	const candidates = models.filter(
		(m) => m.name.toLowerCase().includes("sonnet") && m.contextWindow >= 200_000,
	);
	if (candidates.length === 0) return undefined;
	return candidates.sort((a, b) => {
		const score = (name: string) => {
			const m = name.match(/sonnet-(\d+)-(\d+)/);
			return m ? parseInt(m[1]) * 100 + parseInt(m[2]) : 0;
		};
		return score(b.name) - score(a.name);
	})[0];
}

// ── OpenRouter model discovery ──────────────────────────────────────────

const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/** Only these modalities are valid in pi's models.json schema. */
const VALID_INPUT_MODALITIES = new Set(["text", "image"]);

interface OpenRouterModel {
	id: string;
	name: string;
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	context_length?: number;
	top_provider?: {
		max_completion_tokens?: number | null;
	};
	pricing?: {
		prompt?: string;
		completion?: string;
	};
	supported_parameters?: string[];
}

async function fetchOpenRouterModels(key: string): Promise<OpenRouterModel[]> {
	const resp = await fetch(`${OPENROUTER_BASE_URL}/v1/models`, {
		headers: { Authorization: `Bearer ${key}` },
	});
	if (!resp.ok) throw new Error(`OpenRouter /v1/models: ${resp.status} ${resp.statusText}`);
	const data = await resp.json() as { data: OpenRouterModel[] };
	return data.data;
}

/**
 * Convert OpenRouter model list to pi ModelEntry[].  Only text-output
 * models are included; input modalities are clamped to text|image (the
 * only values pi's schema allows).
 */
function buildOpenRouterModels(raws: OpenRouterModel[]): ModelEntry[] {
	return raws
		.filter((m) => {
			const out = m.architecture?.output_modalities ?? ["text"];
			return out.includes("text");
		})
		.map((m) => {
			// Clamp to text|image only — drop audio, video, file etc.
			const inp = (m.architecture?.input_modalities ?? ["text"])
				.map((mod) => (mod === "file" ? "text" : mod))
				.filter((mod) => VALID_INPUT_MODALITIES.has(mod))
				.filter((v, i, a) => a.indexOf(v) === i);

			const inputCost = parseFloat(m.pricing?.prompt ?? "0") * 1_000_000;
			const outputCost = parseFloat(m.pricing?.completion ?? "0") * 1_000_000;

			const reasoning =
				(m.supported_parameters ?? []).includes("reasoning") ||
				(m.supported_parameters ?? []).includes("thinking");

			return {
				id: m.id,
				name: m.id,
				reasoning,
				input: inp.length > 0 ? inp : ["text"],
				contextWindow: m.context_length ?? 128_000,
				maxTokens: m.top_provider?.max_completion_tokens ?? 16_384,
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: 0,
					cacheWrite: 0,
				},
			};
		});
}

// ── Refresh orchestration ───────────────────────────────────────────────

interface RefreshResult {
	unityCount: number;
	unityMessagesCount: number;
	unityResponsesCount: number;
	pilotCount: number;
	openrouterCount: number;
	defaultModel: string | undefined;
}

async function doRefreshModels(signal?: AbortSignal): Promise<RefreshResult> {
	const key1 = process.env["UNITY_LITELLM_KEY1"];
	const key2 = process.env["UNITY_LITELLM_KEY2"];
	const orKey = process.env["PERSONAL_OPENROUTER_KEY"];

	if (!key1) throw new Error("UNITY_LITELLM_KEY1 environment variable is not set");
	if (!key2) throw new Error("UNITY_LITELLM_KEY2 environment variable is not set");

	// Fetch LiteLLM (required) and OpenRouter (optional) in parallel
	const liteLLMFetch = Promise.all([
		fetchModelInfo(key1),
		fetchModelIds(key1),
		fetchModelIds(key2),
	]);

	const orFetch = orKey
		? fetchOpenRouterModels(orKey).catch((err) => {
			console.warn(`OpenRouter fetch failed (skipping): ${err?.message ?? err}`);
			return [] as OpenRouterModel[];
		})
		: Promise.resolve([] as OpenRouterModel[]);

	const [[modelInfo, key1Ids, key2Ids], orRaw] = await Promise.all([liteLLMFetch, orFetch]);
	if (signal?.aborted) throw new Error("aborted");

	const allKey1ChatModels = buildModels(key1Ids, modelInfo, "chat");
	const unityModels = allKey1ChatModels.filter((m) => !isClaudeModel(m.name));
	const unityMessagesModels = allKey1ChatModels.filter((m) => isClaudeModel(m.name));
	const unityResponsesModels = buildModels(key1Ids, modelInfo, "responses");
	const pilotModels = buildModels(key2Ids, modelInfo, "chat");
	const orModels = buildOpenRouterModels(orRaw);

	// Preserve the existing "active" provider so the current profile
	// survives the refresh.
	const existing = readModelsJson();
	const activeProvider = existing.providers[ACTIVE_PROVIDER];

	// Preserve api/apiKey from models.json so manual edits survive a refresh.
	const ep = existing.providers;
	const providers: Record<string, any> = {
		unity: {
			baseUrl: `${UNITY_BASE_URL}/v1`,
			api:    ep["unity"]?.api    ?? "openai-completions",
			apiKey: ep["unity"]?.apiKey ?? "UNITY_LITELLM_KEY1",
			models: unityModels,
		},
		"unity-messages": {
			baseUrl: `${UNITY_BASE_URL}/v1`,
			api:    ep["unity-messages"]?.api    ?? "anthropic-messages",
			apiKey: ep["unity-messages"]?.apiKey ?? "UNITY_LITELLM_KEY1",
			models: unityMessagesModels,
		},
		"unity-responses": {
			baseUrl: `${UNITY_BASE_URL}/v1`,
			api:    ep["unity-responses"]?.api    ?? "openai-responses",
			apiKey: ep["unity-responses"]?.apiKey ?? "UNITY_LITELLM_KEY1",
			models: unityResponsesModels,
		},
		"unity-pilot": {
			baseUrl: `${UNITY_BASE_URL}/v1`,
			api:    ep["unity-pilot"]?.api    ?? "anthropic-messages",
			apiKey: ep["unity-pilot"]?.apiKey ?? "UNITY_LITELLM_KEY2",
			models: pilotModels,
		},
	};

	// Only add OpenRouter provider when we got data
	if (orModels.length > 0) {
		providers["openrouter"] = {
			baseUrl: `${OPENROUTER_BASE_URL}/v1`,
			api: "openai-completions",
			apiKey: "PERSONAL_OPENROUTER_KEY",
			models: orModels,
		};
	} else if (existing.providers["openrouter"]) {
		// Preserve previous data so existing sessions aren't broken
		providers["openrouter"] = existing.providers["openrouter"];
	}

	if (activeProvider) providers[ACTIVE_PROVIDER] = activeProvider;

	writeFileSync(getModelsJsonPath(), JSON.stringify({ providers }, null, 2), "utf-8");

	const defaultModel = selectDefaultSonnet(unityMessagesModels);
	if (defaultModel) {
		const settings = readSettings();
		settings.defaultProvider = "unity-messages";
		settings.defaultModel = defaultModel.id;
		writeFileSync(getSettingsJsonPath(), JSON.stringify(settings, null, 2), "utf-8");
	}

	return {
		unityCount: unityModels.length,
		unityMessagesCount: unityMessagesModels.length,
		unityResponsesCount: unityResponsesModels.length,
		pilotCount: pilotModels.length,
		openrouterCount: orModels.length,
		defaultModel: defaultModel?.name,
	};
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

		// 3. Reload in-memory model registry so newly-written providers are visible
		ctx.modelRegistry.refresh();

		// 4. Switch the current session's model to the profile default
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
				const label = m.name ?? m.id;
				return isActive ? `${tier} (active) — ${label}` : `${tier} — ${label}`;
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

	// ── Model refresh command ────────────────────────────────────────

	pi.registerCommand("refresh-models", {
		description: "Rediscover available models from Unity LiteLLM proxy",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Fetching models from Unity LiteLLM and OpenRouter...", "info");
			try {
				const result = await doRefreshModels(ctx.signal);
				// Reload in-memory registry so new providers are immediately usable
				ctx.modelRegistry.refresh();
				const msg = [
					`unity: ${result.unityCount} chat`,
					`unity-messages: ${result.unityMessagesCount} chat`,
					`unity-responses: ${result.unityResponsesCount}`,
					`unity-pilot: ${result.pilotCount} chat`,
					result.openrouterCount > 0 ? `openrouter: ${result.openrouterCount}` : "",
					!process.env["PERSONAL_OPENROUTER_KEY"] ? "openrouter: skipped (no key)" : "",
					result.defaultModel ? `default: ${result.defaultModel}` : "",
				].filter(Boolean).join("  |  ");
				ctx.ui.notify(msg, "success");
				// Re-apply the active profile so the updated provider
				// baseUrl is picked up.
				if (activeProfileName && profiles[activeProfileName]) {
					writeActiveProvider(profiles[activeProfileName]);
				}
			} catch (err: any) {
				ctx.ui.notify(`refresh-models failed: ${err?.message ?? err}`, "error");
			}
		},
	});
}
