/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	/** Nearest `.pi/agents/` walking up from cwd. Kept for renderers / debug output. */
	projectAgentsDir: string | null;
	/** All project-agent directories actually loaded this invocation (cwd walk-up + targetPaths walk-ups). */
	projectAgentsDirs: string[];
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function findGitRoot(startDir: string): string | null {
	let cur = path.resolve(startDir);
	while (true) {
		if (isDirectory(path.join(cur, ".git"))) return cur;
		const parent = path.dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

/**
 * For each path in `paths`, walk up from the path's directory to the git root
 * (or filesystem root if no git root) collecting every `.pi/agents/` along the
 * way. Returns a deduplicated list.
 *
 * Enables path-driven project-local agent discovery: when a review command
 * runs against files under A/B/C/, lenses in A/.pi/agents/, A/B/.pi/agents/,
 * and A/B/C/.pi/agents/ are all picked up automatically.
 */
function findProjectAgentsDirsForPaths(paths: string[]): string[] {
	const dirs = new Set<string>();
	for (const p of paths) {
		if (!p) continue;
		const resolved = path.resolve(p);
		let startDir: string;
		try {
			startDir =
				fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
					? resolved
					: path.dirname(resolved);
		} catch {
			startDir = path.dirname(resolved);
		}
		const gitRoot = findGitRoot(startDir);
		let cur = startDir;
		while (true) {
			const candidate = path.join(cur, ".pi", "agents");
			if (isDirectory(candidate)) dirs.add(candidate);
			if (gitRoot && cur === gitRoot) break;
			const parent = path.dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
	}
	return [...dirs];
}

// Resolve the bundled agents directory relative to this file
const BUNDLED_AGENTS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "agents");

export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	targetPaths?: string[],
): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const nearest = findNearestProjectAgentsDir(cwd);

	// Existing behaviour: nearest `.pi/agents/` walking up from cwd.
	const projectDirsSet = new Set<string>();
	if (nearest) projectDirsSet.add(nearest);

	// New behaviour: walk up from each target path collecting every `.pi/agents/`
	// along the ancestry. Enables project-local and sub-project-local lenses to
	// activate automatically when the review target lives inside their tree.
	if (targetPaths && targetPaths.length > 0) {
		for (const d of findProjectAgentsDirsForPaths(targetPaths)) {
			projectDirsSet.add(d);
		}
	}
	const projectAgentsDirs = [...projectDirsSet];

	// Load bundled agents first (lowest priority), then user, then project.
	const bundledAgents = loadAgentsFromDir(BUNDLED_AGENTS_DIR, "user");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents =
		scope === "user" ? [] : projectAgentsDirs.flatMap((d) => loadAgentsFromDir(d, "project"));

	const agentMap = new Map<string, AgentConfig>();

	// Bundled agents are always loaded as baseline (can be overridden by user/project).
	for (const agent of bundledAgents) agentMap.set(agent.name, agent);

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return {
		agents: Array.from(agentMap.values()),
		projectAgentsDir: nearest,
		projectAgentsDirs,
	};
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
