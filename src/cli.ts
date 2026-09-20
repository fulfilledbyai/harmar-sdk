#!/usr/bin/env node
// harmar — command-line client for the Harmar subtitle API.
//
//   harmar transcribe video.mp4                     # Armenian, JSON to stdout
//   harmar transcribe video.mp4 --lang auto --srt   # identify language, SRT out
//   harmar transcribe talk.mp4 --lang ru --translate-to hy --vtt --out talk.vtt
//   harmar transcribe reel.mp4 --lang auto --export --preset <id> --out reel.mp4
//   harmar status <id> | srt <id> | vtt <id> | delete <id>
//   harmar styles | presets | save-style <name> --style-file s.json | delete-style <id>
//   harmar export <id> --preset <id> --out captioned.mp4 | export-status <id>
//   harmar languages | balance | usage | pricing
//   harmar mcp                                      # MCP server on stdio
//
// Auth: HARMAR_API_KEY (or --api-key). Base URL: HARMAR_API_URL (or --api-url).
// Exit codes: 0 ok · 1 API error · 2 usage error · 3 timed out (job still running).

import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { HarmarClient, HarmarError, type ProgressEvent, type Transcript } from "./client.js";

const USAGE = `harmar — Harmar subtitle API (https://harmar.ai/developers)

Usage
  harmar transcribe <file> [options]   upload, transcribe, print the result
  harmar status <id>                   job status / full transcript as JSON
  harmar srt <id> [--lang xx]          SRT for a finished job
  harmar vtt <id> [--lang xx]          VTT for a finished job
  harmar delete <id>                   purge transcript + media
  harmar export <id> [style options]   burn a styled MP4 (needs --keep-media at transcribe)
  harmar export-status <id>            export state; prints the download URL when done
  harmar styles                        the style catalog: presets, fonts per language, fields
  harmar presets                       this account's saved styles
  harmar save-style <name> --style-file f.json | --style '{…}'
  harmar delete-style <id>
  harmar languages                     languages source_lang / translate_to accept
  harmar balance                       prepaid seconds left
  harmar usage                         last 100 ledger entries
  harmar pricing                       live per-minute rates and packs
  harmar mcp                           run the MCP server on stdio (for Claude Code, Cursor, …)

transcribe options
  --lang <code|auto>      language of the speech (default hy; "auto" identifies it)
  --translate-to <code>   add a translated track, no surcharge
  --script <file>         align this exact text instead of transcribing
  --webhook <https url>   notify on completion
  --timestamps word|segment|none   (default word)
  --no-punctuation        strip punctuation
  --no-speakers           drop dialogue dashes and speaker ids
  --lyrics include        keep sung lines (default exclude)
  --srt | --vtt | --text  output format (default: JSON)
  --out <path>            write the output to a file instead of stdout
  --keep-media            keep the source so the job can be exported later
  --export                after transcribing, export a styled MP4 (implies --keep-media;
                          needs --preset or --style/--style-file; --out names the MP4)
  --no-wait               submit and print the id; poll with "harmar status"
  --timeout <seconds>     stop waiting after this long (default 1800)
  --quiet                 no progress on stderr

style options (export, transcribe --export)
  --preset <id>           a saved style (harmar presets)
  --style '<json>'        an inline style object (see harmar styles)
  --style-file <path>     the same, from a file
  --track <code>          which track to burn: the source language (default) or translate-to's
  --platform instagram|youtube|tiktok
  --out <path>            where to save the MP4 (default: <id>.mp4)

global
  --api-key <hk_live_…>   or HARMAR_API_KEY
  --api-url <url>         or HARMAR_API_URL (default https://api.harmar.ai)
  --json                  machine-readable errors on stderr
`;

type Flags = {
  lang?: string;
  "translate-to"?: string;
  script?: string;
  webhook?: string;
  timestamps?: string;
  punctuation?: boolean;
  speakers?: boolean;
  lyrics?: string;
  srt?: boolean;
  vtt?: boolean;
  text?: boolean;
  out?: string;
  wait?: boolean;
  timeout?: string;
  quiet?: boolean;
  "api-key"?: string;
  "api-url"?: string;
  json?: boolean;
  help?: boolean;
  "keep-media"?: boolean;
  export?: boolean;
  preset?: string;
  style?: string;
  "style-file"?: string;
  track?: string;
  platform?: string;
};

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: Record<string, { type: "string" | "boolean" }>; allowPositionals: true }>>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        lang: { type: "string" },
        "translate-to": { type: "string" },
        script: { type: "string" },
        webhook: { type: "string" },
        timestamps: { type: "string" },
        punctuation: { type: "boolean" },
        speakers: { type: "boolean" },
        lyrics: { type: "string" },
        srt: { type: "boolean" },
        vtt: { type: "boolean" },
        text: { type: "boolean" },
        out: { type: "string" },
        wait: { type: "boolean" },
        timeout: { type: "string" },
        quiet: { type: "boolean" },
        "api-key": { type: "string" },
        "api-url": { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
        "keep-media": { type: "boolean" },
        export: { type: "boolean" },
        preset: { type: "string" },
        style: { type: "string" },
        "style-file": { type: "string" },
        track: { type: "string" },
        platform: { type: "string" },
      },
    });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const flags = parsed.values as Flags;
  const [cmd, arg] = parsed.positionals;

  if (flags.help || !cmd) {
    process.stdout.write(USAGE);
    return cmd ? 0 : 2;
  }

  if (cmd === "mcp") {
    // The MCP host owns stdio from here; the API key is read lazily on
    // the first tool call so a missing key is a tool error, not a crash.
    if (flags["api-key"]) process.env.HARMAR_API_KEY = flags["api-key"];
    if (flags["api-url"]) process.env.HARMAR_API_URL = flags["api-url"];
    const { runMcp } = await import("./mcp.js");
    await runMcp();
    return await new Promise<number>(() => {});
  }

  const client = new HarmarClient({ apiKey: flags["api-key"], baseUrl: flags["api-url"] });
  const log = flags.quiet ? () => {} : (s: string) => process.stderr.write(s + "\n");

  switch (cmd) {
    case "transcribe": {
      if (!arg) return usageError("transcribe needs a file path");
      const format = flags.srt ? "srt" : flags.vtt ? "vtt" : flags.text ? "text" : "json";
      const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : undefined;
      if (flags.timeout && !(Number(flags.timeout) > 0)) return usageError("--timeout must be a positive number of seconds");
      if (flags.timestamps && !["word", "segment", "none"].includes(flags.timestamps)) {
        return usageError("--timestamps must be word, segment or none");
      }
      if (flags.lyrics && !["exclude", "include"].includes(flags.lyrics)) {
        return usageError("--lyrics must be exclude or include");
      }
      const scriptText = flags.script ? await readScript(flags.script) : undefined;
      // --export: validate the style BEFORE paying for the transcript.
      const exportOpts = flags.export ? await exportOptionsFrom(flags) : null;
      if (flags.export && !exportOpts) return 2;
      if (flags.export && flags.wait === false) return usageError("--export needs to wait for the transcript; drop --no-wait");

      const result = await client.transcribe(arg, {
        sourceLang: flags.lang,
        translateTo: flags["translate-to"],
        scriptText,
        webhookUrl: flags.webhook,
        keepMedia: flags["keep-media"] === true || flags.export === true,
        options: {
          ...(flags.timestamps ? { timestamps: flags.timestamps as "word" | "segment" | "none" } : {}),
          ...(flags.punctuation === false ? { punctuation: false } : {}),
          ...(flags.speakers === false ? { speakers: false } : {}),
          ...(flags.lyrics ? { lyrics: flags.lyrics as "exclude" | "include" } : {}),
        },
        wait: flags.wait !== false,
        timeoutMs,
        onProgress: progressLogger(log),
      });

      if (result.status === "processing" || result.status === "awaiting_upload") {
        // --no-wait, or the timeout hit. The job is still running.
        process.stdout.write(JSON.stringify({ id: result.id, status: result.status, progress: result.progress }, null, 2) + "\n");
        log(`still ${result.status} — poll with: harmar status ${result.id}`);
        return flags.wait === false ? 0 : 3;
      }
      if (result.status === "failed") {
        return fail(flags, new HarmarError(0, result.error ?? "processing_failed", `Job ${result.id} failed: ${result.error ?? "processing_failed"} (credits refunded).`));
      }

      if (exportOpts) {
        // The transcript is done; --out names the MP4, and the transcript
        // itself goes to stdout as JSON so nothing is lost.
        const outPath = flags.out ?? `${result.id}.mp4`;
        const state = await client.exportVideo(result.id, {
          ...exportOpts,
          lang: flags.track,
          timeoutMs,
          outPath,
          onProgress: progressLogger(log),
        });
        if (state.status !== "completed") return exportNotDone(flags, state, log);
        log(`wrote ${outPath}`);
        process.stdout.write(JSON.stringify({ ...result, export: state, file: outPath }, null, 2) + "\n");
        return 0;
      }

      let output: string;
      if (format === "srt" || format === "vtt") {
        output = await client.subtitles(result.id, format, subtitleTrack(flags, result));
      } else if (format === "text") {
        output = (result.text ?? "") + "\n";
      } else {
        output = JSON.stringify(result, null, 2) + "\n";
      }
      await emit(output, flags.out);
      return 0;
    }

    case "export": {
      if (!arg) return usageError("export needs a transcript id");
      const exportOpts = await exportOptionsFrom(flags);
      if (!exportOpts) return 2;
      const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : undefined;
      const outPath = flags.out ?? `${arg}.mp4`;
      const state = await client.exportVideo(arg, {
        ...exportOpts,
        lang: flags.track,
        wait: flags.wait !== false,
        timeoutMs,
        outPath: flags.wait === false ? undefined : outPath,
        onProgress: progressLogger(log),
      });
      if (flags.wait === false) {
        process.stdout.write(JSON.stringify(state, null, 2) + "\n");
        log(`poll with: harmar export-status ${arg}`);
        return 0;
      }
      if (state.status !== "completed") return exportNotDone(flags, state, log);
      log(`wrote ${outPath}`);
      process.stdout.write(JSON.stringify({ ...state, file: outPath }, null, 2) + "\n");
      return 0;
    }

    case "export-status": {
      if (!arg) return usageError("export-status needs a transcript id");
      const state = await client.getExport(arg);
      if (flags.out && state.status === "completed") {
        await client.downloadExport(state, flags.out, progressLogger(log));
        log(`wrote ${flags.out}`);
      }
      process.stdout.write(JSON.stringify(state, null, 2) + "\n");
      return state.status === "failed" ? 1 : 0;
    }

    case "styles": {
      const cat = await client.styles();
      if (flags.json) {
        process.stdout.write(JSON.stringify(cat, null, 2) + "\n");
        return 0;
      }
      process.stdout.write("presets\n");
      for (const p of cat.presets) process.stdout.write(`  ${p.id.padEnd(9)} ${p.description}\n`);
      process.stdout.write("\nfonts (key · label · languages it renders)\n");
      for (const f of cat.fonts) {
        const langs = f.languages.length > 12 ? `${f.languages.slice(0, 12).join(",")},… (${f.languages.length})` : f.languages.join(",");
        process.stdout.write(`  ${f.key.padEnd(22)} ${f.label.padEnd(22)} ${langs}\n`);
      }
      process.stdout.write("\nfields\n");
      for (const [k, v] of Object.entries(cat.fields)) {
        process.stdout.write(`  ${k.padEnd(16)} ${v.type.padEnd(8)} ${(v.range ?? "").padEnd(34)} ${v.description}\n`);
      }
      process.stdout.write(`\nexport: up to ${cat.export.max_media_minutes} min, ${cat.export.max_resolution}, watermark: ${cat.export.watermark}. Use --json for the defaults per orientation.\n`);
      return 0;
    }

    case "presets": {
      const presets = await client.stylePresets();
      if (flags.json) process.stdout.write(JSON.stringify(presets, null, 2) + "\n");
      else if (!presets.length) process.stdout.write("no saved styles — harmar save-style <name> --style-file s.json\n");
      else for (const p of presets) process.stdout.write(`${p.id}  ${p.name}  (${p.style.preset ?? "preset?"} · ${p.style.font ?? "font?"})\n`);
      return 0;
    }

    case "save-style": {
      if (!arg) return usageError("save-style needs a name");
      const style = await inlineStyleFrom(flags);
      if (!style) return usageError("save-style needs --style '<json>' or --style-file <path>");
      const preset = await client.saveStylePreset(arg, style);
      process.stdout.write(JSON.stringify(preset, null, 2) + "\n");
      log(`saved — export with: harmar export <transcript id> --preset ${preset.id}`);
      return 0;
    }

    case "delete-style": {
      if (!arg) return usageError("delete-style needs a preset id");
      process.stdout.write(JSON.stringify(await client.deleteStylePreset(arg), null, 2) + "\n");
      return 0;
    }

    case "status": {
      if (!arg) return usageError("status needs a transcript id");
      await emit(JSON.stringify(await client.get(arg), null, 2) + "\n", flags.out);
      return 0;
    }

    case "srt":
    case "vtt": {
      if (!arg) return usageError(`${cmd} needs a transcript id`);
      await emit(await client.subtitles(arg, cmd, flags.lang), flags.out);
      return 0;
    }

    case "delete": {
      if (!arg) return usageError("delete needs a transcript id");
      process.stdout.write(JSON.stringify(await client.delete(arg), null, 2) + "\n");
      return 0;
    }

    case "languages": {
      const langs = await client.languages();
      if (flags.json) {
        process.stdout.write(JSON.stringify(langs, null, 2) + "\n");
      } else {
        process.stdout.write("auto  (identify from the audio)\n");
        for (const l of langs) {
          process.stdout.write(`${l.code.padEnd(5)} ${l.name.padEnd(14)} ${l.native_name}${l.auto_detectable ? "" : "   (name it explicitly — not auto-detectable)"}\n`);
        }
      }
      return 0;
    }

    case "balance": {
      const b = await client.balance();
      process.stdout.write(flags.json ? JSON.stringify(b) + "\n" : `${b.minutes_remaining} min (${b.seconds_remaining} s) remaining\n`);
      return 0;
    }

    case "usage":
      process.stdout.write(JSON.stringify(await client.usage(), null, 2) + "\n");
      return 0;

    case "pricing":
      process.stdout.write(JSON.stringify(await client.pricing(), null, 2) + "\n");
      return 0;

    default:
      return usageError(`unknown command "${cmd}"`);
  }
}

// --preset XOR (--style | --style-file), plus --platform. Returns null after
// printing the usage error, so callers can `return 2`.
async function exportOptionsFrom(flags: Flags): Promise<{ stylePresetId?: string; style?: Record<string, unknown>; platform?: "instagram" | "youtube" | "tiktok" } | null> {
  const style = await inlineStyleFrom(flags);
  if (!!flags.preset === !!style) {
    usageError("an export needs exactly one of --preset <id> or --style/--style-file");
    return null;
  }
  if (flags.platform && !["instagram", "youtube", "tiktok"].includes(flags.platform)) {
    usageError("--platform must be instagram, youtube or tiktok");
    return null;
  }
  return {
    ...(flags.preset ? { stylePresetId: flags.preset } : {}),
    ...(style ? { style } : {}),
    ...(flags.platform ? { platform: flags.platform as "instagram" | "youtube" | "tiktok" } : {}),
  };
}

async function inlineStyleFrom(flags: Flags): Promise<Record<string, unknown> | null> {
  let raw = flags.style;
  if (flags["style-file"]) {
    const { readFile } = await import("node:fs/promises");
    raw = await readFile(flags["style-file"], "utf8");
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch (e) {
    usageError(`--style is not a JSON object: ${(e as Error).message}`);
    return null;
  }
}

function exportNotDone(flags: Flags, state: { id: string; status: string; error?: string; seconds_refunded?: number }, log: (s: string) => void): number {
  if (state.status === "failed") {
    return fail(flags, new HarmarError(0, state.error ?? "render_failed", `Export ${state.id} failed: ${state.error ?? "render_failed"} (${state.seconds_refunded ?? 0} s refunded).`));
  }
  process.stdout.write(JSON.stringify(state, null, 2) + "\n");
  log(`still ${state.status} — poll with: harmar export-status ${state.id}`);
  return 3;
}

// Which track the --srt/--vtt output names: the translation when one was
// requested and landed, otherwise the source (omitted → the API's default).
function subtitleTrack(flags: Flags, result: Transcript): string | undefined {
  if (flags["translate-to"] && result.translation) return flags["translate-to"];
  return undefined;
}

function progressLogger(log: (s: string) => void): (e: ProgressEvent) => void {
  let lastLine = "";
  return (e) => {
    let line: string;
    switch (e.phase) {
      case "uploading":
        line = `uploading ${(e.bytes / 1e6).toFixed(1)} MB…`;
        break;
      case "submitted":
        line = `submitted ${e.id} — ${e.duration_seconds ?? "?"} s of media, ${e.seconds_charged ?? "?"} s charged`;
        break;
      case "processing":
        line = `processing${e.progress !== undefined ? ` ${e.progress}%` : ""}${e.detected_lang ? ` · language: ${e.detected_lang}` : ""}`;
        break;
      case "completed":
        line = "completed";
        break;
      case "export_submitted":
        line = `export submitted — ${e.seconds_charged} s charged`;
        break;
      case "export_rendering":
        line = e.status === "queued"
          ? `export queued${e.queue_position ? ` (position ${e.queue_position})` : ""}`
          : `rendering${e.progress !== undefined ? ` ${e.progress}%` : ""}`;
        break;
      case "export_completed":
        line = `export completed${e.size_bytes ? ` (${(e.size_bytes / 1e6).toFixed(1)} MB)` : ""}`;
        break;
      case "downloading":
        line = "downloading…";
        break;
    }
    if (line !== lastLine) log(line);
    lastLine = line;
  };
}

async function readScript(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

async function emit(output: string, out?: string): Promise<void> {
  if (out) {
    await writeFile(out, output);
    process.stderr.write(`wrote ${out}\n`);
  } else {
    process.stdout.write(output);
  }
}

function usageError(msg: string): number {
  process.stderr.write(`harmar: ${msg}\n\n${USAGE}`);
  return 2;
}

function fail(flags: Flags, e: unknown): number {
  if (e instanceof HarmarError) {
    if (flags.json) {
      process.stderr.write(JSON.stringify({ error: { code: e.code, message: e.message, status: e.status, ...e.params } }) + "\n");
    } else {
      const extra = Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : "";
      process.stderr.write(`harmar: ${e.code}: ${e.message}${extra}\n`);
    }
    return 1;
  }
  process.stderr.write(`harmar: ${(e as Error)?.message ?? String(e)}\n`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => process.exit(fail({ json: process.argv.includes("--json") }, e)),
);
