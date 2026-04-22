/**
 * Freepik tool definitions.
 *
 * Two tools are exposed:
 *
 *   freepik_generate_image
 *     Submits a text-to-image task, polls until completion, downloads the
 *     result to a local path, and returns that path.
 *
 *   freepik_get_image_task
 *     Look up a previously submitted task by ID — useful when a generation
 *     outlives a single tool call (e.g. polling timed out) or for debugging.
 *
 * Five models are supported, selectable via the `model` parameter:
 *
 *   - nano-banana-pro       (default) Google Gemini 3. Best overall for
 *                           technical diagrams, infographics, complex
 *                           compositions, and accurate text/labels.
 *                           Supports Google Search grounding.
 *   - nano-banana-pro-flash Google Gemini 3.1 Flash ("Nano Banana 2" on
 *                           fal.ai). Faster/cheaper variant of the same.
 *   - seedream-v4-5         ByteDance Seedream 4.5. Strong typography,
 *                           good for posters and branded visuals.
 *   - flux-kontext-pro      Black Forest Labs Flux. General-purpose design
 *                           model with optional reference image.
 *   - mystic                Freepik's proprietary photorealistic model.
 *                           Use for photo-style imagery, not diagrams.
 *
 * Per-model parameter quirks (aspect ratio strings, resolution casing,
 * reference-image shape) are normalised in buildBody() so the LLM sees
 * a single uniform schema.
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

const DEFAULT_MODEL: FreepikModel = "nano-banana-pro";

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
	'Output aspect ratio. Use the underscore form: "square_1_1" (default), ' +
	'"widescreen_16_9", "social_story_9_16", "traditional_3_4", "classic_4_3", ' +
	'"standard_3_2", "portrait_2_3", "cinematic_21_9", "social_5_4", "social_post_4_5". ' +
	"The tool translates to each model's native form. Not every ratio is supported by " +
	"every model — the API will reject unsupported combinations with a clear error.";

const RESOLUTION_DESC =
	'Output resolution: "1k", "2k" (default), or "4k". Only honoured by ' +
	"nano-banana-pro, nano-banana-pro-flash, and mystic. Higher values take " +
	"significantly longer.";

const MODEL_DESC =
	"Image model to use. " +
	'"nano-banana-pro" (default) — Google Gemini 3, best overall for technical ' +
	"diagrams, infographics, complex compositions, and accurate text/labels. " +
	'"nano-banana-pro-flash" — Gemini 3.1 Flash ("Nano Banana 2" elsewhere); ' +
	"same feature set as the Pro, faster/cheaper. " +
	'"seedream-v4-5" — ByteDance Seedream 4.5, strong typography, good for ' +
	"posters and branded visuals. " +
	'"flux-kontext-pro" — Black Forest Labs Flux, general-purpose design with ' +
	"reference image input. " +
	'"mystic" — Freepik\'s photorealistic model; use only for photo-style images.';

// ─── Per-model request body builders ──────────────────────────────────────────

interface GenerateParams {
	prompt: string;
	model?: FreepikModel;
	aspect_ratio?: string;
	resolution?: "1k" | "2k" | "4k";
	seed?: number;
	reference_image_url?: string;
	use_google_search?: boolean;
}

/** Translate our canonical underscore aspect-ratio form to Nano Banana's colon form. */
const NANO_ASPECT: Record<string, string> = {
	square_1_1: "1:1",
	widescreen_16_9: "16:9",
	social_story_9_16: "9:16",
	traditional_3_4: "3:4",
	classic_4_3: "4:3",
	standard_3_2: "3:2",
	portrait_2_3: "2:3",
	cinematic_21_9: "21:9",
	social_5_4: "5:4",
	social_post_4_5: "4:5",
};

function buildBody(model: FreepikModel, p: GenerateParams): Record<string, unknown> {
	const body: Record<string, unknown> = { prompt: p.prompt };
	if (typeof p.seed === "number") body.seed = p.seed;

	switch (model) {
		case "nano-banana-pro":
		case "nano-banana-pro-flash": {
			// Nano Banana uses colon-form aspect ratios and uppercase resolutions.
			if (p.aspect_ratio) {
				const translated = NANO_ASPECT[p.aspect_ratio];
				if (!translated) {
					throw new Error(
						`aspect_ratio "${p.aspect_ratio}" is not supported by ${model}. ` +
							`Valid values: ${Object.keys(NANO_ASPECT).join(", ")}.`,
					);
				}
				body.aspect_ratio = translated;
			}
			if (p.resolution) body.resolution = p.resolution.toUpperCase();
			if (p.reference_image_url) {
				body.reference_images = [
					{
						image: p.reference_image_url,
						mime_type: guessMimeFromUrl(p.reference_image_url),
					},
				];
			}
			if (p.use_google_search) body.use_google_search_tool = true;
			return body;
		}

		case "seedream-v4-5":
			// Seedream takes prompt, aspect_ratio (underscore form), seed,
			// enable_safety_checker. No reference image, no resolution control.
			if (p.aspect_ratio) body.aspect_ratio = p.aspect_ratio;
			return body;

		case "flux-kontext-pro":
			if (p.aspect_ratio) body.aspect_ratio = p.aspect_ratio;
			if (p.reference_image_url) body.input_image = p.reference_image_url;
			return body;

		case "mystic":
			// Default to the "flexible" Mystic submodel: per Freepik's docs it
			// gives the best prompt adherence and is "especially good with
			// illustrations [and] fantastical prompts" — closer to a design-y
			// aesthetic than the default "realism" submodel. The other Mystic
			// submodels are tuned for portraits / photographs.
			body.model = "flexible";
			if (p.aspect_ratio) body.aspect_ratio = p.aspect_ratio;
			body.resolution = p.resolution ?? "2k";
			// Mystic uses different reference param names and prefers base64.
			// We accept a URL for symmetry and pass it through as
			// `style_reference`; the API will accept URLs in practice even
			// though the schema documents base64.
			if (p.reference_image_url) body.style_reference = p.reference_image_url;
			return body;
	}
}

function guessMimeFromUrl(url: string): string {
	const lower = url.toLowerCase().split("?")[0] ?? "";
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".webp")) return "image/webp";
	return "image/jpeg"; // safe default
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
	const model = ((params.model as FreepikModel) ?? DEFAULT_MODEL) as FreepikModel;
	const aspectRatio = params.aspect_ratio as string | undefined;
	const resolution = params.resolution as "1k" | "2k" | "4k" | undefined;
	const seed = params.seed as number | undefined;
	const referenceImageUrl = params.reference_image_url as string | undefined;
	const useGoogleSearch = params.use_google_search as boolean | undefined;
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
		resolution,
		seed,
		reference_image_url: referenceImageUrl,
		use_google_search: useGoogleSearch,
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
				"Best uses: technical diagrams, infographics, hero illustrations, branded " +
				"visuals, posters, decorative imagery for documentation.\n\n" +
				"Default model is **nano-banana-pro** (Google Gemini 3), which is currently " +
				"the strongest model on Freepik for technical diagrams, accurate text/labels, " +
				"and complex compositions. Enable `use_google_search=true` when the diagram " +
				"references real-world entities or technical concepts — it improves label " +
				"accuracy substantially.\n\n" +
				"For purely structural diagrams (UML, sequence diagrams, dependency graphs) " +
				"a code-rendered tool like Mermaid / Graphviz / PlantUML is still more reliable. " +
				"Use this tool when you want visually polished, illustrated diagrams or design " +
				"work the LLM can describe in prose.",
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
						examples: [
							"nano-banana-pro",
							"nano-banana-pro-flash",
							"seedream-v4-5",
							"flux-kontext-pro",
							"mystic",
						],
					}),
				),
				aspect_ratio: Type.Optional(Type.String({ description: ASPECT_RATIO_DESC })),
				resolution: Type.Optional(
					Type.String({
						description: RESOLUTION_DESC,
						examples: ["1k", "2k", "4k"],
					}),
				),
				reference_image_url: Type.Optional(
					Type.String({
						description:
							"Optional HTTPS URL of a reference image to guide generation. " +
							"Used as reference_images[0] (nano-banana-pro/flash), input_image " +
							"(flux-kontext-pro), or style_reference (mystic). Ignored by " +
							"seedream-v4-5.",
					}),
				),
				use_google_search: Type.Optional(
					Type.Boolean({
						description:
							"Nano Banana models only: enable Google Search grounding for prompts " +
							"that reference real-world entities (places, brands, public figures, " +
							"current events, technical concepts). Improves factual accuracy of " +
							"labels and references in the generated image. Ignored by other models.",
					}),
				),
				seed: Type.Optional(
					Type.Number({
						description:
							"Random seed for reproducible generation. Omit for random output.",
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
