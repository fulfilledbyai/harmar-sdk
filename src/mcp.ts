// `harmar mcp` — Model Context Protocol server over stdio.
//
// Gives any MCP host (Claude Code, Claude Desktop, Cursor, Windsurf, …)
// the Harmar subtitle API as tools. One process per host, authenticated
// by HARMAR_API_KEY in its environment:
//
//   claude mcp add harmar -e HARMAR_API_KEY=hk_live_… -- npx -y harmar-ai mcp
//
// Every tool is a thin wrapper over HarmarClient — the MCP layer adds
// schemas and text rendering, never logic.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HarmarClient, HarmarError, type Transcript } from "./client.js";

const server = new McpServer({ name: "harmar", version: "0.1.0" });

let clientInstance: HarmarClient | null = null;
function client(): HarmarClient {
  if (!clientInstance) clientInstance = new HarmarClient();
  return clientInstance;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2));

// Errors go back as tool results, not protocol errors, so the model can
// read the code (insufficient_credits carries seconds_needed) and act.
async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HarmarError) {
      return {
        isError: true,
        ...json({ error: { code: e.code, message: e.message, status: e.status, ...e.params } }),
      };
    }
    return { isError: true, ...text(`Error: ${(e as Error)?.message ?? String(e)}`) };
  }
}

// A completed transcript can be tens of thousands of words. The status
// tool returns the compact form by default; words come on request.
function compact(t: Transcript, includeWords: boolean): Record<string, unknown> {
  if (t.status !== "completed") return t;
  const { words, translation, ...rest } = t;
  const out: Record<string, unknown> = {
    ...rest,
    word_count: words?.length,
    ...(includeWords ? { words } : {}),
  };
  if (translation) {
    out.translation = includeWords
      ? translation
      : { text: translation.text, segments: translation.segments, word_count: translation.words?.length };
  }
  return out;
}

const OPTIONS_SHAPE = {
  timestamps: z.enum(["word", "segment", "none"]).optional().describe("Timing granularity in the result (default word)."),
  punctuation: z.boolean().optional().describe("Keep punctuation (default true)."),
  speakers: z.boolean().optional().describe("Keep dialogue dashes and speaker ids (default true)."),
  lyrics: z.enum(["exclude", "include"]).optional().describe("Whether sung lines appear (default exclude)."),
};

server.registerTool(
  "harmar_transcribe",
  {
    title: "Transcribe a media file",
    description:
      "Upload a local audio/video file (MP4, MOV, WebM, M4A, MP3, WAV; ≤60 min) to Harmar and get a word-timed transcript. " +
      "Best for Armenian and mixed Armenian/Russian/English speech; 50+ other languages supported (see harmar_languages). " +
      "Charged per second of media from a prepaid balance, refunded if the job fails. " +
      "Waits for completion by default; if it times out the job keeps running — poll with harmar_get_transcript.",
    inputSchema: {
      file_path: z.string().describe("Absolute path to the media file on this machine."),
      source_lang: z
        .string()
        .optional()
        .describe('Language of the speech, e.g. "hy", "ru", "en", "kk". "auto" identifies it from the audio. Default "hy".'),
      translate_to: z.string().optional().describe("Also produce a translated subtitle track in this language (no surcharge)."),
      script_text: z.string().optional().describe("If you already have the exact spoken text, align it instead of transcribing."),
      webhook_url: z.string().optional().describe("HTTPS URL to notify on completion (Harmar-Signature HMAC header)."),
      options: z.object(OPTIONS_SHAPE).optional(),
      keep_media: z
        .boolean()
        .optional()
        .describe("Keep the source video after transcription so harmar_export can burn styled captions into it. Set true whenever a video export is wanted. Default false (media deleted right after the transcript)."),
      wait: z.boolean().optional().describe("Wait for the result (default true)."),
      timeout_seconds: z.number().optional().describe("Max seconds to wait (default 900). The job continues server-side after."),
      include_words: z.boolean().optional().describe("Include the per-word array in the result (default false — text and segments only)."),
    },
  },
  async (a) =>
    guarded(async () => {
      const result = await client().transcribe(a.file_path, {
        sourceLang: a.source_lang,
        translateTo: a.translate_to,
        scriptText: a.script_text,
        webhookUrl: a.webhook_url,
        keepMedia: a.keep_media,
        options: a.options,
        wait: a.wait ?? true,
        timeoutMs: (a.timeout_seconds ?? 900) * 1000,
      });
      return json(compact(result, a.include_words ?? false));
    }),
);

server.registerTool(
  "harmar_get_transcript",
  {
    title: "Get a transcript / job status",
    description:
      "Status of a Harmar job by id. While processing: progress 0–100 and, for auto jobs, the detected language. " +
      "When completed: text, sentence segments, and optionally every word with start/end seconds.",
    inputSchema: {
      id: z.string().describe("Transcript id returned by harmar_transcribe."),
      include_words: z.boolean().optional().describe("Include the per-word array (default false)."),
    },
  },
  async (a) => guarded(async () => json(compact(await client().get(a.id), a.include_words ?? false))),
);

server.registerTool(
  "harmar_get_subtitles",
  {
    title: "Get SRT or VTT",
    description:
      "Subtitle file text for a completed job, one cue per sentence. `lang` picks the track: omit for the source language, " +
      "or name the translate_to language for the translated track.",
    inputSchema: {
      id: z.string(),
      format: z.enum(["srt", "vtt"]),
      lang: z.string().optional().describe("Track language; omit for the source track."),
    },
  },
  async (a) => guarded(async () => text(await client().subtitles(a.id, a.format, a.lang))),
);

server.registerTool(
  "harmar_languages",
  {
    title: "List supported languages",
    description:
      "Languages accepted for source_lang and translate_to, live from the API. `auto_detectable: false` means the language works but must be named explicitly.",
    inputSchema: {},
  },
  async () => guarded(async () => json({ auto: "identify from the audio", languages: await client().languages() })),
);

server.registerTool(
  "harmar_balance",
  { title: "Prepaid balance", description: "Seconds and minutes of media the account can still transcribe.", inputSchema: {} },
  async () => guarded(async () => json(await client().balance())),
);

server.registerTool(
  "harmar_usage",
  { title: "Usage ledger", description: "The last 100 credit ledger entries (grants, charges, refunds).", inputSchema: {} },
  async () => guarded(async () => json(await client().usage())),
);

server.registerTool(
  "harmar_pricing",
  { title: "Pricing", description: "Live per-minute rates and credit packs, so a margin can be computed without hard-coding a number.", inputSchema: {} },
  async () => guarded(async () => json(await client().pricing())),
);

server.registerTool(
  "harmar_delete_transcript",
  {
    title: "Delete a transcript",
    description: "Purge a finished job's transcript and media now instead of waiting for retention. Idempotent; 409 while still processing.",
    inputSchema: { id: z.string() },
  },
  async (a) => guarded(async () => json(await client().delete(a.id))),
);

// ── styles & export ────────────────────────────────────────────────────

const STYLE_SHAPE = z
  .object({
    preset: z.enum(["karaoke", "pill", "popin", "classic", "reveal", "stack", "carousel"]).optional(),
    font: z.string().optional().describe("A font key from harmar_list_styles — check it renders the track's language."),
    fontByLang: z.record(z.string(), z.string()).optional(),
    fontSizePct: z.number().optional().describe("Font size as % of video width (0.5–30)."),
    color: z.string().optional(),
    accentColor: z.string().optional(),
    bgColor: z.string().optional(),
    bgOpacity: z.number().optional(),
    position: z.enum(["top", "center", "bottom"]).optional(),
    posX: z.number().optional(),
    posY: z.number().optional(),
    subtitleWidth: z.number().optional(),
  })
  .passthrough()
  .describe("A style object. Any field from harmar_list_styles is accepted; unknown fields are rejected by the API with the field list.");

server.registerTool(
  "harmar_list_styles",
  {
    title: "Style catalog",
    description:
      "Everything a subtitle style can be: the caption presets (pill, karaoke, popin, …), every font with the languages it actually renders, " +
      "each style field with its range, and the default style per video orientation. Read this before composing a style.",
    inputSchema: {},
  },
  async () => guarded(async () => json(await client().styles())),
);

server.registerTool(
  "harmar_list_style_presets",
  { title: "Saved styles", description: "The account's saved style presets — pass a preset's id to harmar_export as style_preset_id.", inputSchema: {} },
  async () => guarded(async () => json(await client().stylePresets())),
);

server.registerTool(
  "harmar_save_style",
  {
    title: "Save a style preset",
    description:
      "Save a style under a name so every later export uses exactly it (harmar_export with style_preset_id). Up to 10 per account. " +
      "Compose the style from harmar_list_styles; the API validates it and names any field it rejects.",
    inputSchema: { name: z.string().min(1).max(60), style: STYLE_SHAPE },
  },
  async (a) => guarded(async () => json(await client().saveStylePreset(a.name, a.style))),
);

server.registerTool(
  "harmar_delete_style_preset",
  { title: "Delete a style preset", description: "Remove a saved style by id.", inputSchema: { id: z.string() } },
  async (a) => guarded(async () => json(await client().deleteStylePreset(a.id))),
);

server.registerTool(
  "harmar_export",
  {
    title: "Export a captioned video",
    description:
      "Burn styled subtitles into the video of a completed transcript and get an MP4 (no watermark, up to 1080p). " +
      "Pass exactly one of style_preset_id (a saved style — the reliable way to reuse a specific look) or style (inline). " +
      "The transcript must have been created with keep_media: true; otherwise the API answers media_purged and the file must be transcribed again with keep_media. " +
      "Charged per second of media at the transcription rate, refunded if the render fails. Waits by default; pass save_to to download the MP4 to a local path.",
    inputSchema: {
      id: z.string().describe("Transcript id."),
      style_preset_id: z.string().optional(),
      style: STYLE_SHAPE.optional(),
      lang: z.string().optional().describe("Track to burn: the source language (default) or the translate_to language."),
      platform: z.enum(["instagram", "youtube", "tiktok"]).optional(),
      save_to: z.string().optional().describe("Absolute local path for the MP4. Without it the result carries a signed download_url valid for an hour."),
      wait: z.boolean().optional().describe("Wait for the render (default true)."),
      timeout_seconds: z.number().optional().describe("Max seconds to wait (default 1800). The render continues server-side after."),
    },
  },
  async (a) =>
    guarded(async () => {
      const state = await client().exportVideo(a.id, {
        stylePresetId: a.style_preset_id,
        style: a.style,
        lang: a.lang,
        platform: a.platform,
        wait: a.wait ?? true,
        timeoutMs: (a.timeout_seconds ?? 1800) * 1000,
        outPath: a.save_to,
      });
      return json(a.save_to && state.status === "completed" ? { ...state, file: a.save_to } : state);
    }),
);

server.registerTool(
  "harmar_get_export",
  {
    title: "Export status",
    description: "State of a transcript's export: queued / rendering (with progress) / completed (with a signed download_url) / failed (with the reason and the refund).",
    inputSchema: { id: z.string(), save_to: z.string().optional().describe("If completed, download the MP4 to this local path.") },
  },
  async (a) =>
    guarded(async () => {
      const state = await client().getExport(a.id);
      if (a.save_to && state.status === "completed") {
        await client().downloadExport(state, a.save_to);
        return json({ ...state, file: a.save_to });
      }
      return json(state);
    }),
);

export async function runMcp(): Promise<void> {
  await server.connect(new StdioServerTransport());
}
