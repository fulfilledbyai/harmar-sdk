# harmar

Command line, MCP server and typed client for the [Harmar](https://harmar.ai)
subtitle API: word-timed transcripts, SRT/VTT, and **captioned videos** —
styled subtitles burned into the MP4, no watermark. Built for Armenian and
for speech that switches between Armenian, Russian and English
mid-sentence; 50+ other languages served through the same endpoint.

```bash
export HARMAR_API_KEY=hk_live_…          # https://harmar.ai/app/api — 10 free minutes
npx -y harmar transcribe video.mp4 --lang auto --srt --out video.srt
# (straight from GitHub: npx -y github:fulfilledbyai/harmar-sdk transcribe …)

# a captioned video in a saved style
npx -y harmar save-style "Brand" --style '{"preset":"pill","font":"montserrat","accentColor":"#D4F25A"}'
npx -y harmar transcribe reel.mp4 --lang auto --export --preset <id> --out reel-captioned.mp4
```

## CLI

```
harmar transcribe <file> [--lang auto|hy|ru|en|…] [--translate-to xx]
                         [--srt|--vtt|--text] [--out path] [--no-wait]
harmar transcribe <file> --export (--preset <id> | --style-file s.json) --out captioned.mp4
harmar export <id> (--preset <id> | --style '{…}' | --style-file s.json) [--track xx] [--platform x] [--out f.mp4]
harmar export-status <id> · styles · presets · save-style <name> · delete-style <id>
harmar status <id> · srt <id> · vtt <id> · delete <id>
harmar languages · balance · usage · pricing
harmar mcp
```

An export needs the transcript to have been made with `--keep-media`
(`--export` implies it); by default the source is deleted once the
transcript exists. Exports are charged per second of media at the
transcription rate and refunded if the render fails. One export at a time
per account; up to 60 minutes; 1080p.

`harmar --help` lists every flag. Progress goes to stderr, the result to
stdout (or `--out`). Exit codes: `0` ok, `1` API error (with the API's
error code — `insufficient_credits` carries `seconds_needed`), `2` usage,
`3` timed out waiting (the job keeps running; `harmar status <id>`).

## MCP server — Claude Code, Claude Desktop, Cursor, Windsurf

```bash
claude mcp add harmar -e HARMAR_API_KEY=hk_live_… -- npx -y harmar mcp
```

or in any `mcp.json`:

```json
{
  "mcpServers": {
    "harmar": {
      "command": "npx",
      "args": ["-y", "harmar", "mcp"],
      "env": { "HARMAR_API_KEY": "hk_live_…" }
    }
  }
}
```

Tools: `harmar_transcribe` (with `keep_media`), `harmar_get_transcript`,
`harmar_get_subtitles`, `harmar_list_styles`, `harmar_save_style`,
`harmar_list_style_presets`, `harmar_delete_style_preset`, `harmar_export`
(with `save_to` for a local MP4), `harmar_get_export`, `harmar_languages`,
`harmar_balance`, `harmar_usage`, `harmar_pricing`,
`harmar_delete_transcript`. Errors come back as tool results with the API's
code so the model can act on them.

## Skill — Claude Code and other skill-aware agents

`skills/harmar/SKILL.md` teaches an agent the whole flow (CLI first, raw
HTTP fallback). Copy it into your project's `.claude/skills/harmar/` or
your agent's skills directory.

## Library

```ts
import { HarmarClient } from "harmar";

const harmar = new HarmarClient(); // reads HARMAR_API_KEY
const t = await harmar.transcribe("talk.mp4", { sourceLang: "auto", translateTo: "en", keepMedia: true });
t.words;                                   // [{ text, start, end, speaker? }, …]
await harmar.subtitles(t.id, "srt", "en"); // the translated track

const preset = await harmar.saveStylePreset("Brand", { preset: "pill", font: "montserrat", accentColor: "#D4F25A" });
await harmar.exportVideo(t.id, { stylePresetId: preset.id, lang: "en", outPath: "talk-en.mp4" });
```

`transcribe()` = `upload()` + `submit()` + `wait()`; each is public.
`HarmarError` carries `status`, `code` and `params`.

## API

Fifteen routes, documented at https://harmar.ai/developers. Base URL
`https://api.harmar.ai`, `Authorization: Bearer hk_live_…`. Prepaid credits
charged per second of media, refunded on failure. Files up to 60 minutes.

## Development

```bash
npm install && npm run build
HARMAR_API_URL=http://localhost:3901 HARMAR_API_KEY=… node dist/cli.js languages
```

MIT.
