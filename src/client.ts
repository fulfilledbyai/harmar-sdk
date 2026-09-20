// Typed client for the Harmar developer API — https://harmar.ai/developers
//
// The API is fifteen routes (docs/api.md §75.3, §137's GET /v1/languages,
// §186.4's styles, presets and export), and this file is the one place the
// SDK describes them. The CLI and the MCP
// server both call through here, so a route added to the backend is
// added here once and reaches both.
//
// No dependencies: Node 20's fetch, openAsBlob for the upload PUT (a Blob
// carries its size, so fetch sends Content-Length — a stream body would go
// chunked and R2's presigned PUT rejects chunked bodies).

import { openAsBlob, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_BASE_URL = "https://api.harmar.ai";

export type Timestamps = "word" | "segment" | "none";
export type Lyrics = "exclude" | "include";

export type TranscriptOptions = {
  timestamps?: Timestamps;
  punctuation?: boolean;
  speakers?: boolean;
  lyrics?: Lyrics;
};

export type SubmitOptions = {
  /** Language of the speech. "auto" identifies it from the audio. Default "hy". */
  sourceLang?: string;
  /** Second subtitle track in this language, no surcharge. */
  translateTo?: string;
  /** Align a known script instead of transcribing (no Gemini call). */
  scriptText?: string;
  /** HTTPS URL that receives transcript.completed / transcript.failed (and export.*). */
  webhookUrl?: string;
  /** Keep the source media after transcription so the job can be exported as a styled video. Default false. */
  keepMedia?: boolean;
  options?: TranscriptOptions;
};

export type Word = {
  text: string;
  start: number;
  end: number;
  speaker?: number;
  is_lyric?: boolean;
};
export type Segment = Word;

export type TranscriptTrack = {
  text: string;
  words?: Word[];
  segments?: Segment[];
};

export type JobStatus = "awaiting_upload" | "processing" | "completed" | "failed";

export type Transcript = {
  id: string;
  status: JobStatus;
  duration_seconds: number | null;
  created_at: string;
  completed_at: string | null;
  /** 0–100 while processing. */
  progress?: number;
  /** Echoed when a non-default source language was requested. */
  source_lang?: string;
  /** What "auto" resolved to — present from the first seconds of processing. */
  detected_lang?: string;
  translate_to?: string;
  seconds_charged?: number;
  quality?: "ok" | "degraded";
  /** Stable public reason on a failed job. */
  error?: string;
  text?: string;
  words?: Word[];
  segments?: Segment[];
  translation?: TranscriptTrack;
  translation_status?: "failed";
  srt_url?: string;
  vtt_url?: string;
  /** True while the source media is still stored (keep_media jobs) — an export is possible. */
  media_retained?: boolean;
  /** Present once an export has been requested. Full state: getExport(). */
  export?: { status: ExportStatus };
};

// ── styles & export ────────────────────────────────────────────────────

/** A subtitle style. Every field is optional; GET /v1/styles lists them with ranges and defaults. */
export type Style = Record<string, unknown> & {
  preset?: "karaoke" | "pill" | "popin" | "classic" | "reveal" | "stack" | "carousel";
  font?: string;
  fontByLang?: Record<string, string>;
  fontSizePct?: number;
  color?: string;
  accentColor?: string;
  bgColor?: string;
  bgOpacity?: number;
  position?: "top" | "center" | "bottom";
  posX?: number;
  posY?: number;
  subtitleWidth?: number;
};

export type StylesCatalog = {
  presets: { id: string; description: string }[];
  fonts: { key: string; label: string; category: string; languages: string[] }[];
  fields: Record<string, { type: string; range?: string; description: string }>;
  defaults: Record<"vertical" | "horizontal" | "square", Style>;
  platforms: readonly string[];
  export: { max_media_minutes: number; max_resolution: string; watermark: boolean; requires: string };
};

export type StylePreset = { id: string; name: string; style: Style; created_at: string };

export type ExportStatus = "queued" | "rendering" | "completed" | "failed";

export type ExportOptions = {
  /** A saved preset's id — exactly one of stylePresetId / style. */
  stylePresetId?: string;
  /** An inline style object. */
  style?: Style;
  /** Which track to burn: the source language (default) or translate_to's. */
  lang?: string;
  platform?: "instagram" | "youtube" | "tiktok";
};

export type ExportState = {
  id: string;
  status: ExportStatus;
  requested_at: string;
  completed_at?: string;
  lang: string;
  style_preset_id?: string;
  seconds_charged: number;
  seconds_refunded?: number;
  /** 0–100 while rendering. */
  progress?: number;
  queue_position?: number;
  error?: string;
  size_bytes?: number | null;
  /** Signed URL, valid download_expires_in_seconds. Present when completed. */
  download_url?: string;
  download_expires_in_seconds?: number;
};

export type UploadTicket = {
  media_id: string;
  upload_url: string;
  content_type: string;
  expires_in_seconds: number;
};

export type SubmitResult = {
  id: string;
  status: JobStatus;
  duration_seconds: number | null;
  seconds_charged?: number;
  idempotent?: boolean;
};

export type Language = {
  code: string;
  name: string;
  native_name: string;
  script: string;
  auto_detectable: boolean;
};

export type Balance = { seconds_remaining: number; minutes_remaining: number };

export type UsageEntry = {
  kind: string;
  delta_seconds: number;
  transcript_id: string | null;
  created_at: string;
};
export type Usage = {
  entries: UsageEntry[];
  window: string;
  credited_seconds: number;
  debited_seconds: number;
};

export type DeleteResult = { id: string; deleted: true; already_deleted: boolean };

/** The API's error envelope: `{ error: { code, message, ...params } }`. */
export class HarmarError extends Error {
  readonly status: number;
  readonly code: string;
  readonly params: Record<string, unknown>;
  constructor(status: number, code: string, message: string, params: Record<string, unknown> = {}) {
    super(message);
    this.name = "HarmarError";
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

export type ClientConfig = {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
};

export type ProgressEvent =
  | { phase: "uploading"; bytes: number }
  | { phase: "submitted"; id: string; seconds_charged?: number; duration_seconds: number | null }
  | { phase: "processing"; id: string; progress?: number; detected_lang?: string }
  | { phase: "completed"; id: string }
  | { phase: "export_submitted"; id: string; seconds_charged: number }
  | { phase: "export_rendering"; id: string; status: ExportStatus; progress?: number; queue_position?: number }
  | { phase: "export_completed"; id: string; size_bytes?: number | null }
  | { phase: "downloading"; id: string; bytes?: number | null };

const EXT_TO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export class HarmarClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ClientConfig = {}) {
    const key = config.apiKey ?? process.env.HARMAR_API_KEY;
    if (!key) {
      throw new HarmarError(
        0,
        "missing_api_key",
        "No API key. Set HARMAR_API_KEY (create one at https://harmar.ai/app/api).",
      );
    }
    this.apiKey = key;
    this.baseUrl = (config.baseUrl ?? process.env.HARMAR_API_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = config.fetch ?? fetch;
  }

  // ── raw routes ──────────────────────────────────────────────────────

  createUpload(filename: string, fileSize: number): Promise<UploadTicket> {
    return this.request("POST", "/v1/uploads", { filename, file_size: fileSize });
  }

  submit(mediaId: string, opts: SubmitOptions = {}): Promise<SubmitResult> {
    return this.request("POST", "/v1/transcripts", {
      media_id: mediaId,
      ...(opts.sourceLang ? { source_lang: opts.sourceLang } : {}),
      ...(opts.translateTo ? { translate_to: opts.translateTo } : {}),
      ...(opts.scriptText ? { script_text: opts.scriptText } : {}),
      ...(opts.webhookUrl ? { webhook_url: opts.webhookUrl } : {}),
      ...(opts.keepMedia ? { keep_media: true } : {}),
      ...(opts.options ? { options: opts.options } : {}),
    });
  }

  // ── styles & export ──────────────────────────────────────────────────

  styles(): Promise<StylesCatalog> {
    return this.request("GET", "/v1/styles");
  }

  async stylePresets(): Promise<StylePreset[]> {
    const r = await this.request<{ presets: StylePreset[] }>("GET", "/v1/style-presets");
    return r.presets;
  }

  async saveStylePreset(name: string, style: Style): Promise<StylePreset> {
    const r = await this.request<{ preset: StylePreset }>("POST", "/v1/style-presets", { name, style });
    return r.preset;
  }

  deleteStylePreset(id: string): Promise<{ id: string; deleted: true }> {
    return this.request("DELETE", `/v1/style-presets/${encodeURIComponent(id)}`);
  }

  /** Start a burned-in export. The transcript must have been submitted with keepMedia. */
  startExport(id: string, opts: ExportOptions): Promise<{ id: string; export: { status: ExportStatus; seconds_charged: number; lang: string } }> {
    return this.request("POST", `/v1/transcripts/${encodeURIComponent(id)}/export`, {
      ...(opts.stylePresetId ? { style_preset_id: opts.stylePresetId } : {}),
      ...(opts.style ? { style: opts.style } : {}),
      ...(opts.lang ? { lang: opts.lang } : {}),
      ...(opts.platform ? { platform: opts.platform } : {}),
    });
  }

  getExport(id: string): Promise<ExportState> {
    return this.request("GET", `/v1/transcripts/${encodeURIComponent(id)}/export`);
  }

  /** Poll until the export is completed or failed (or timeoutMs elapses — it keeps rendering server-side). */
  async waitExport(
    id: string,
    { intervalMs = 5000, timeoutMs = 60 * 60 * 1000, onProgress }: {
      intervalMs?: number;
      timeoutMs?: number;
      onProgress?: (e: ProgressEvent) => void;
    } = {},
  ): Promise<ExportState> {
    const deadline = Date.now() + timeoutMs;
    let last = await this.getExport(id);
    while ((last.status === "queued" || last.status === "rendering") && Date.now() < deadline) {
      onProgress?.({ phase: "export_rendering", id, status: last.status, progress: last.progress, queue_position: last.queue_position });
      await new Promise((r) => setTimeout(r, intervalMs));
      last = await this.getExport(id);
    }
    if (last.status === "completed") onProgress?.({ phase: "export_completed", id, size_bytes: last.size_bytes });
    return last;
  }

  /** Save a completed export's MP4 to a local path. */
  async downloadExport(state: ExportState, outPath: string, onProgress?: (e: ProgressEvent) => void): Promise<void> {
    if (state.status !== "completed" || !state.download_url) {
      throw new HarmarError(0, "export_not_ready", `Export ${state.id} is ${state.status}; nothing to download.`);
    }
    onProgress?.({ phase: "downloading", id: state.id, bytes: state.size_bytes });
    const res = await this.fetchImpl(state.download_url);
    if (!res.ok || !res.body) {
      throw new HarmarError(res.status, "download_failed", `Download answered ${res.status}.`);
    }
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(outPath));
  }

  /** startExport + waitExport, and downloadExport when outPath is given. */
  async exportVideo(
    id: string,
    opts: ExportOptions & { wait?: boolean; timeoutMs?: number; outPath?: string; onProgress?: (e: ProgressEvent) => void },
  ): Promise<ExportState> {
    const { wait = true, timeoutMs, outPath, onProgress, ...exportOpts } = opts;
    const started = await this.startExport(id, exportOpts);
    onProgress?.({ phase: "export_submitted", id, seconds_charged: started.export.seconds_charged });
    if (!wait) return this.getExport(id);
    const state = await this.waitExport(id, { timeoutMs, onProgress });
    if (outPath && state.status === "completed") await this.downloadExport(state, outPath, onProgress);
    return state;
  }

  get(id: string): Promise<Transcript> {
    return this.request("GET", `/v1/transcripts/${encodeURIComponent(id)}`);
  }

  /** SRT or VTT text. `lang` picks the track: omit for the source, name translate_to's language for the translation. */
  subtitles(id: string, format: "srt" | "vtt", lang?: string): Promise<string> {
    const q = lang ? `?lang=${encodeURIComponent(lang)}` : "";
    return this.requestText("GET", `/v1/transcripts/${encodeURIComponent(id)}/${format}${q}`);
  }

  delete(id: string): Promise<DeleteResult> {
    return this.request("DELETE", `/v1/transcripts/${encodeURIComponent(id)}`);
  }

  async languages(): Promise<Language[]> {
    const r = await this.request<{ languages: Language[] }>("GET", "/v1/languages");
    return r.languages;
  }

  pricing(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/pricing");
  }

  balance(): Promise<Balance> {
    return this.request("GET", "/v1/balance");
  }

  usage(): Promise<Usage> {
    return this.request("GET", "/v1/usage");
  }

  // ── conveniences ────────────────────────────────────────────────────

  /** Upload a local file and return its media_id. Does not submit. */
  async upload(filePath: string, onProgress?: (e: ProgressEvent) => void): Promise<UploadTicket> {
    const info = await stat(filePath);
    const ticket = await this.createUpload(basename(filePath), info.size);
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const body = await openAsBlob(filePath, { type: ticket.content_type || EXT_TO_MIME[ext] });
    onProgress?.({ phase: "uploading", bytes: info.size });
    const res = await this.fetchImpl(ticket.upload_url, {
      method: "PUT",
      headers: { "Content-Type": ticket.content_type },
      body,
    });
    if (!res.ok) {
      throw new HarmarError(res.status, "upload_failed", `Storage PUT answered ${res.status}.`);
    }
    return ticket;
  }

  /**
   * Poll until the job leaves "processing". Resolves with the final
   * transcript, or with the last status seen if `timeoutMs` elapses —
   * the job keeps running server-side; call get(id) later.
   */
  async wait(
    id: string,
    { intervalMs = 5000, timeoutMs = 30 * 60 * 1000, onProgress }: {
      intervalMs?: number;
      timeoutMs?: number;
      onProgress?: (e: ProgressEvent) => void;
    } = {},
  ): Promise<Transcript> {
    const deadline = Date.now() + timeoutMs;
    let last = await this.get(id);
    while ((last.status === "processing" || last.status === "awaiting_upload") && Date.now() < deadline) {
      onProgress?.({ phase: "processing", id, progress: last.progress, detected_lang: last.detected_lang });
      await new Promise((r) => setTimeout(r, intervalMs));
      last = await this.get(id);
    }
    if (last.status === "completed") onProgress?.({ phase: "completed", id });
    return last;
  }

  /** Upload, submit and (by default) wait. The whole flow in one call. */
  async transcribe(
    filePath: string,
    opts: SubmitOptions & { wait?: boolean; timeoutMs?: number; onProgress?: (e: ProgressEvent) => void } = {},
  ): Promise<Transcript> {
    const { wait = true, timeoutMs, onProgress, ...submitOpts } = opts;
    const ticket = await this.upload(filePath, onProgress);
    const submitted = await this.submit(ticket.media_id, submitOpts);
    onProgress?.({
      phase: "submitted",
      id: submitted.id,
      seconds_charged: submitted.seconds_charged,
      duration_seconds: submitted.duration_seconds,
    });
    if (!wait) return this.get(submitted.id);
    return this.wait(submitted.id, { timeoutMs, onProgress });
  }

  // ── transport ───────────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body handled below */
    }
    if (!res.ok) throw errorFrom(res.status, json, text);
    return json as T;
  }

  private async requestText(method: string, path: string): Promise<string> {
    const res = await this.send(method, path);
    const text = await res.text();
    if (!res.ok) {
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* plain text error */
      }
      throw errorFrom(res.status, json, text);
    }
    return text;
  }

  private send(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "User-Agent": "harmar-sdk/0.1.0",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
}

function errorFrom(status: number, json: unknown, text: string): HarmarError {
  const env = (json as { error?: unknown } | null)?.error;
  if (env && typeof env === "object") {
    const { code, message, ...params } = env as Record<string, unknown>;
    return new HarmarError(
      status,
      typeof code === "string" ? code : "http_error",
      typeof message === "string" ? message : `HTTP ${status}`,
      params,
    );
  }
  return new HarmarError(status, "http_error", text.slice(0, 200) || `HTTP ${status}`);
}
