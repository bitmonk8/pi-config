/**
 * Freepik tool definitions.
 *
 * Two tools are exposed:
 *
 *   freepik_generate_image
 *     Submits a text-to-image task, polls until completion, downloads the
 *     resulting PNG to a local path, and returns that path.
 *
 *   freepik_get_image_task
 *     Look up a previously submitted task by ID — useful when a generation
 *     outlives a single tool call (e.g. polling timed out) or for debugging.
 *
 * Three models are supported, selectable via the `model` parameter:
 *
 *   - seedream-v4-5    (default) Best for diagrams, posters, branded visuals
 *                      with crisp typography. Closest analog to DALL-E 3.
 *   - flux-kontext-pro Strong general-purpose design model with optional
 *                      reference image input.
 *   - mystic           Photorealistic. Use for hero photography-style images,
 *                      not for structured diagrams.
 */

import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import {
	type FreepikModel,
	type TaskDetail,
	downloadImage,
	endpointForModel,
	getTask,
	submitTask,
	waitForTask,
} from "./freepik-client.js";

// ─── Tool plumbing ────────────────────────────────────────────────────────────

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

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

function err(text: string): ToolResult {
	return { content: [{ type: "text", text }], details: {}, isError: true };
}

async function safe(fn: () => Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await fn();
	} catch (e) {
		return err(`Freepik error: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// ─── Shared parameter shapes ──────────────────────────────────────────────────

const ASPECT_RATIO_DESC =
	'Output aspect ratio. Common values: "square_1_1" (default), "widescreen_16_9", ' +
	'"social_story_9_16", "traditional_3_4", "classic_4_3", "standard_3_2", "portrait_2_3". ' +
	"Available values vary slightly per model; the API will reject unsupported combinations.";

const MODEL_DESC =
	"Image model to use. " +
	'"seedream-v4-5" (default) — best for diagrams, posters, and branded visuals with ' +
	"crisp typography (closest analog to DALL-E 3). " +
	'"flux-kontext-pro" — strong general-purpose design model, supports a reference image. ' +
	'"mystic" — photorealistic; use only for photo-style images, not structured diagrams.';

// ─── Per-model request body builders ──────────────────────────────────────────

interface GenerateParams {
	prompt: string;
	model?: FreepikModel;
	aspect_ratio?: string;
	seed?: number;
	reference_image_url?: string;
	mystic_resolution?: "1k" | "2k" | "4k";
}

function buildBody(model: FreepikModel, p: GenerateParams): Record<string, unknown> {
	const body: Record<string, unknown> = { prompt: p.prompt };
	if (p.aspect_ratio) body.aspect_ratio = p.aspect_ratio;
	if (typeof p.seed === "number") body.seed = p.seed;

	switch (model) {
		case "seedream-v4-5":
			// Seedream takes prompt, aspect_ratio, seed, enable_safety_checker.
			// reference_image_url is not part of its schema — silently ignored.
			return body;

		case "flux-kontext-pro":
			if (p.reference_image_url) body.input_image = p.reference_image_url;
			return body;

		case "mystic":
			// Default to the "flexible" Mystic submodel: per Freepik's docs it
			// gives the best prompt adherence and is "especially good with
			// illustrations [and] fantastical prompts" — closer to a design-y
			// aesthetic than the default "realism" submodel. The other Mystic
			// submodels are tuned for portraits / photographs.
			body.model = "flexible";
			body.resolution = p.mystic_resolution ?? "2k";
			// Mystic uses different reference param names and prefers base64.
			// We accept a URL for symmetry with flux-kontext-pro and pass it
			// through as `style_reference`; the API will accept URLs in
			// practice even though the schema documents base64.
			if (p.reference_image_url) body.style_reference = p.reference_image_url;
			return body;
	}
}

/**
 * If the output path already has an extension, honour it. Otherwise leave
 * it alone — downloadImage() will append the correct extension based on the
 * Content-Type header of the CDN response (Freepik may return JPEG, PNG,
 * or WebP depending on the model and routing).
 */
function normalisedOutputPath(outputPath: string): string {
	return outputPath;
}

// ─── Tool implementations ─────────────────────────────────────────────────────

async function generateImage(
	params: Record<string, unknown>,
	signal: AbortSignal,
	onUpdate: (u: unknown) => void,
): Promise<ToolResult> {
	const prompt = params.prompt as string;
	const outputPath = params.output_path as string;
	const model = ((params.model as FreepikModel) ?? "seedream-v4-5") as FreepikModel;
	const aspectRatio = params.aspect_ratio as string | undefined;
	const seed = params.seed as number | undefined;
	const referenceImageUrl = params.reference_image_url as string | undefined;
	const mysticResolution = params.mystic_resolution as "1k" | "2k" | "4k" | undefined;
	const timeoutSeconds = (params.timeout_seconds as number | undefined) ?? 300;
	const downloadOutput = (params.download as boolean | undefined) ?? true;

	if (!prompt?.trim()) return err("`prompt` is required and cannot be empty.");
	if (downloadOutput && !outputPath?.trim()) {
		return err("`output_path` is required when download=true (the default).");
	}

	const body = buildBody(model, {
		prompt,
		model,
		aspect_ratio: aspectRatio,
		seed,
		reference_image_url: referenceImageUrl,
		mystic_resolution: mysticResolution,
	});

	const initial = await submitTask(model, body, signal);
	onUpdate({
		content: [
			{ type: "text", text: `Submitted ${model} task ${initial.task_id} (status: ${initial.status})…` },
		],
	});

	const finalDetail = await waitForTask(model, initial.task_id, {
		timeoutMs: timeoutSeconds * 1000,
		signal,
		onProgress: (d, elapsed) => {
			onUpdate({
				content: [
					{
						type: "text",
						text: `[${Math.round(elapsed / 1000)}s] task ${d.task_id} status=${d.status}`,
					},
				],
			});
		},
	});

	const urls = finalDetail.generated ?? [];
	if (urls.length === 0) {
		return err(
			`Task ${finalDetail.task_id} completed but returned no image URLs. ` +
				"This usually means the prompt was filtered (NSFW or policy).",
		);
	}

	const details: Record<string, unknown> = {
		task_id: finalDetail.task_id,
		status: finalDetail.status,
		model,
		image_urls: urls,
	};

	if (!downloadOutput) {
		return ok(
			`Generated ${urls.length} image(s) with ${model}. URLs:\n${urls.join("\n")}\n` +
				`(download=false; not saved locally). Task id: ${finalDetail.task_id}`,
			details,
		);
	}

	const targetPath = normalisedOutputPath(outputPath);
	const writtenPaths: string[] = [];
	for (let i = 0; i < urls.length; i++) {
		const dest = urls.length === 1
			? targetPath
			: addSuffix(targetPath, `-${i + 1}`);
		const written = await downloadImage(urls[i]!, dest, signal);
		writtenPaths.push(written);
	}
	details.saved_paths = writtenPaths;

	const summary = writtenPaths.length === 1
		? `Generated image with ${model} and saved to: ${writtenPaths[0]}`
		: `Generated ${writtenPaths.length} images with ${model}:\n${writtenPaths.join("\n")}`;
	return ok(`${summary}\nTask id: ${finalDetail.task_id}`, details);
}

function addSuffix(p: string, suffix: string): string {
	const ext = path.extname(p);
	const base = ext ? p.slice(0, -ext.length) : p;
	return `${base}${suffix}${ext}`;
}

async function getImageTask(
	params: Record<string, unknown>,
	signal: AbortSignal,
): Promise<ToolResult> {
	const model = params.model as FreepikModel;
	const taskId = params.task_id as string;
	const outputPath = params.output_path as string | undefined;

	if (!model) return err("`model` is required (seedream-v4-5 | flux-kontext-pro | mystic).");
	if (!taskId?.trim()) return err("`task_id` is required.");

	const detail = await getTask(model, taskId, signal);
	const urls = detail.generated ?? [];

	const details: Record<string, unknown> = {
		task_id: detail.task_id,
		status: detail.status,
		model,
		image_urls: urls,
		endpoint: endpointForModel(model),
	};

	if (detail.status !== "COMPLETED") {
		return ok(
			`Task ${taskId} (${model}) status: ${detail.status}. No images yet.`,
			details,
		);
	}

	if (!outputPath || urls.length === 0) {
		return ok(
			`Task ${taskId} COMPLETED. ${urls.length} image URL(s):\n${urls.join("\n")}`,
			details,
		);
	}

	const target = normalisedOutputPath(outputPath);
	const writtenPaths: string[] = [];
	for (let i = 0; i < urls.length; i++) {
		const dest = urls.length === 1 ? target : addSuffix(target, `-${i + 1}`);
		writtenPaths.push(await downloadImage(urls[i]!, dest, signal));
	}
	details.saved_paths = writtenPaths;

	return ok(
		`Task ${taskId} COMPLETED. Saved ${writtenPaths.length} image(s):\n${writtenPaths.join("\n")}`,
		details,
	);
}

// ─── Tool registry ────────────────────────────────────────────────────────────

export function createTools(): ToolDef[] {
	return [
		{
			name: "freepik_generate_image",
			label: "Freepik: Generate Image",
			description:
				"Generate an image from a text prompt using a Freepik AI model and save it " +
				"to a local file. Submits an async task to the Freepik API and polls until " +
				"the image is ready (typically 10–60s).\n\n" +
				"Best uses: hero illustrations, branded visuals, posters, design assets, " +
				"decorative imagery for documentation.\n\n" +
				"Note: Freepik's image models do **not** generate accurate structured " +
				"technical diagrams (boxes, arrows, labelled flowcharts). For those, " +
				"prefer Mermaid / Graphviz / PlantUML rendered to image. Use this tool " +
				"for visually rich illustrative content.",
			parameters: Type.Object({
				prompt: Type.String({
					description:
						"Text description of the image to generate. Be specific about subject, " +
						"style, composition, lighting, and any text that should appear.",
				}),
				output_path: Type.String({
					description:
						"Local file path where the image should be saved (relative to cwd or " +
						"absolute). If no extension is provided, the correct one (.png, .jpg, " +
						".webp) is appended automatically based on what the CDN returns. " +
						"Parent directories are created if missing. Required when download=true.",
				}),
				model: Type.Optional(
					Type.String({
						description: MODEL_DESC,
						examples: ["seedream-v4-5", "flux-kontext-pro", "mystic"],
					}),
				),
				aspect_ratio: Type.Optional(Type.String({ description: ASPECT_RATIO_DESC })),
				reference_image_url: Type.Optional(
					Type.String({
						description:
							"Optional HTTPS URL of a reference image to guide generation. " +
							"Used as input_image (flux-kontext-pro) or style_reference (mystic). " +
							"Ignored by seedream-v4-5.",
					}),
				),
				seed: Type.Optional(
					Type.Number({
						description:
							"Random seed for reproducible generation. Omit for random output.",
					}),
				),
				mystic_resolution: Type.Optional(
					Type.String({
						description:
							'Output resolution when model="mystic": "1k", "2k" (default), or "4k". ' +
							"Higher values take significantly longer.",
						examples: ["1k", "2k", "4k"],
					}),
				),
				timeout_seconds: Type.Optional(
					Type.Number({
						description:
							"How long to wait for the task to complete before giving up. " +
							"Default 300 (5 min). On timeout, the task continues server-side and " +
							"can be polled later with freepik_get_image_task.",
					}),
				),
				download: Type.Optional(
					Type.Boolean({
						description:
							"If false, return the generated URL(s) without downloading. " +
							"Default true.",
					}),
				),
			}),
			execute: (_id, params, signal, onUpdate) =>
				safe(() => generateImage(params, signal, onUpdate)),
		},

		{
			name: "freepik_get_image_task",
			label: "Freepik: Get Image Task",
			description:
				"Get the status of a previously submitted Freepik image-generation task. " +
				"Useful when a generation outlived a freepik_generate_image call (e.g. it " +
				"timed out) or for debugging. If the task is COMPLETED and output_path is " +
				"provided, the result is downloaded to disk.",
			parameters: Type.Object({
				model: Type.String({
					description:
						"The model the task was submitted to. Must match the original submission: " +
						"seedream-v4-5, flux-kontext-pro, or mystic.",
				}),
				task_id: Type.String({ description: "Task ID returned by freepik_generate_image." }),
				output_path: Type.Optional(
					Type.String({
						description:
							"Optional local path to save the image to if the task is COMPLETED. " +
							"If no extension is given, the correct one is appended automatically.",
					}),
				),
			}),
			execute: (_id, params, signal) => safe(() => getImageTask(params, signal)),
		},
	];
}

export type { TaskDetail };
