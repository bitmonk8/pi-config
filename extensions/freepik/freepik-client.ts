/**
 * Freepik API client.
 *
 * Provides:
 * - submitTask()      submit a generation request to a model endpoint
 * - getTask()         fetch task status / generated URLs
 * - waitForTask()     poll until COMPLETED / FAILED / timeout
 * - downloadImage()   stream a generated image URL to disk
 *
 * API key is read from the FREEPIK_API_KEY environment variable.
 *
 * Docs: https://docs.freepik.com/llms.txt
 */

import * as fs from "node:fs";
import * as path from "node:path";

const FREEPIK_API_BASE = "https://api.freepik.com";

// Per Freepik docs: 1K Mystic ~10–20s, 2K ~20–40s, 4K ~40–90s.
// Other models are typically faster but we keep a generous default.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 2_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type FreepikModel = "seedream-v4-5" | "flux-kontext-pro" | "mystic";

export type TaskStatus = "CREATED" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

export interface TaskDetail {
	task_id: string;
	status: TaskStatus;
	/** URLs of generated images. Populated once status === "COMPLETED". */
	generated: string[];
}

interface TaskResponse {
	data: TaskDetail;
}

// ─── Endpoint routing ─────────────────────────────────────────────────────────

/**
 * Map a model name to its REST sub-path under FREEPIK_API_BASE.
 * The same path is used for POST (submit) and GET /{task-id} (status).
 */
export function endpointForModel(model: FreepikModel): string {
	switch (model) {
		case "mystic":
			return "/v1/ai/mystic";
		case "seedream-v4-5":
			return "/v1/ai/text-to-image/seedream-v4-5";
		case "flux-kontext-pro":
			return "/v1/ai/text-to-image/flux-kontext-pro";
	}
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function apiKey(): string {
	const key = process.env.FREEPIK_API_KEY;
	if (!key || !key.trim()) {
		throw new Error(
			"FREEPIK_API_KEY environment variable is not set. " +
				"Get a key from https://www.freepik.com/developers/dashboard.",
		);
	}
	return key.trim();
}

function headers(extra?: Record<string, string>): Record<string, string> {
	return {
		"x-freepik-api-key": apiKey(),
		"Content-Type": "application/json",
		Accept: "application/json",
		...(extra ?? {}),
	};
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function request<T>(
	method: "GET" | "POST",
	urlPath: string,
	body?: unknown,
	signal?: AbortSignal,
): Promise<T> {
	const url = `${FREEPIK_API_BASE}${urlPath}`;
	const resp = await fetch(url, {
		method,
		headers: headers(),
		body: body === undefined ? undefined : JSON.stringify(body),
		signal,
	});

	const text = await resp.text();
	if (!resp.ok) {
		// Surface the API's structured error message when present.
		let detail = text;
		try {
			const parsed = JSON.parse(text) as Record<string, unknown>;
			if (typeof parsed.message === "string") detail = parsed.message;
			else detail = JSON.stringify(parsed);
		} catch {
			/* keep raw text */
		}
		throw new Error(`Freepik API ${method} ${urlPath} failed: ${resp.status} ${detail}`);
	}

	if (!text) return {} as T;
	try {
		return JSON.parse(text) as T;
	} catch (e) {
		throw new Error(`Freepik API ${method} ${urlPath} returned non-JSON: ${(e as Error).message}`);
	}
}

// ─── Task lifecycle ───────────────────────────────────────────────────────────

/**
 * Submit a generation request. Returns the initial TaskDetail (typically
 * status=CREATED with empty `generated`).
 */
export async function submitTask(
	model: FreepikModel,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<TaskDetail> {
	const resp = await request<TaskResponse>("POST", endpointForModel(model), body, signal);
	if (!resp?.data?.task_id) {
		throw new Error(`Freepik response missing task_id: ${JSON.stringify(resp)}`);
	}
	return resp.data;
}

/** Get the current status of a task. */
export async function getTask(
	model: FreepikModel,
	taskId: string,
	signal?: AbortSignal,
): Promise<TaskDetail> {
	const resp = await request<TaskResponse>(
		"GET",
		`${endpointForModel(model)}/${encodeURIComponent(taskId)}`,
		undefined,
		signal,
	);
	if (!resp?.data) {
		throw new Error(`Freepik task response missing data: ${JSON.stringify(resp)}`);
	}
	return resp.data;
}

/**
 * Poll a task until it completes, fails, or the timeout elapses.
 *
 * onProgress is invoked once per poll with the latest TaskDetail so the
 * caller can stream status updates back to the LLM.
 */
export async function waitForTask(
	model: FreepikModel,
	taskId: string,
	options: {
		timeoutMs?: number;
		pollIntervalMs?: number;
		signal?: AbortSignal;
		onProgress?: (detail: TaskDetail, elapsedMs: number) => void;
	} = {},
): Promise<TaskDetail> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const start = Date.now();

	while (true) {
		if (options.signal?.aborted) {
			throw new Error("Freepik task wait aborted");
		}

		const detail = await getTask(model, taskId, options.signal);
		const elapsed = Date.now() - start;
		options.onProgress?.(detail, elapsed);

		if (detail.status === "COMPLETED") return detail;
		if (detail.status === "FAILED") {
			throw new Error(`Freepik task ${taskId} reported FAILED status`);
		}

		if (elapsed > timeoutMs) {
			throw new Error(
				`Freepik task ${taskId} did not complete within ${Math.round(timeoutMs / 1000)}s ` +
					`(last status: ${detail.status}). Use freepik_get_image_task to check later.`,
			);
		}

		await sleep(interval, options.signal);
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ─── Image download ───────────────────────────────────────────────────────────

/**
 * Download a generated image URL to `outputPath`. Creates parent directories
 * if they don't already exist. Returns the absolute path written.
 *
 * If `outputPath` has no extension, one is appended based on the response's
 * Content-Type header (Freepik's CDN may return JPEG even from "PNG" models).
 */
export async function downloadImage(
	url: string,
	outputPath: string,
	signal?: AbortSignal,
): Promise<string> {
	const resp = await fetch(url, { signal });
	if (!resp.ok) {
		throw new Error(`Image download failed: ${resp.status} ${resp.statusText} for ${url}`);
	}

	let abs = path.resolve(outputPath);
	if (!path.extname(abs)) {
		const ct = resp.headers.get("content-type") ?? "";
		abs += extensionForContentType(ct);
	}

	fs.mkdirSync(path.dirname(abs), { recursive: true });
	const buf = Buffer.from(await resp.arrayBuffer());
	fs.writeFileSync(abs, buf);
	return abs;
}

function extensionForContentType(ct: string): string {
	const lower = ct.toLowerCase();
	if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
	if (lower.includes("png")) return ".png";
	if (lower.includes("webp")) return ".webp";
	if (lower.includes("svg")) return ".svg";
	return ".png"; // safe default
}

/** True iff FREEPIK_API_KEY is set in the environment. */
export function hasApiKey(): boolean {
	const key = process.env.FREEPIK_API_KEY;
	return typeof key === "string" && key.trim().length > 0;
}
