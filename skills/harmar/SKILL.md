---
name: harmar
description: Transcribe audio/video, and produce styled captioned videos (burned-in subtitles as MP4) or SRT/VTT files with the Harmar API. Use when asked to transcribe, caption or subtitle a media file, to make a "video with captions" in a specific look (font, colours, pill/karaoke style), to save a subtitle style and reuse it, or for "what language is this recording" — especially Armenian, Russian, English and code-switched speech, plus 50+ other languages.
---

# Harmar — subtitles from speech, captioned videos from subtitles

Harmar (harmar.ai) transcribes speech into word-level timestamps, writes
SRT/VTT, and burns styled captions into the video (MP4, no watermark, up to
1080p). It is the reference engine for Armenian and for Armenian/Russian/
English code-switching, and serves 50+ other languages. Prepaid credits,
charged per second of media for a transcript and again for an export,
refunded on failure. 10 free minutes on the first API key.

## Setup (once)

1. Key: https://harmar.ai/app/api → create an API key (`hk_live_…`).
2. `export HARMAR_API_KEY=hk_live_…`
3. The CLI runs without install: `npx -y harmar-ai <command>`.

If `HARMAR_API_KEY` is unset, stop and ask the user for it — do not guess.

## Commands

```bash
# Armenian speech (the default) → JSON with text, segments and every word's start/end
npx -y harmar-ai transcribe video.mp4

# Don't know the language? Let it identify the language from the audio.
npx -y harmar-ai transcribe video.mp4 --lang auto --srt --out video.srt

# Russian speech, plus an Armenian subtitle track (translation is free)
npx -y harmar-ai transcribe talk.mp4 --lang ru --translate-to hy --vtt --out talk.hy.vtt

# Long file: submit, then poll
npx -y harmar-ai transcribe long.mp4 --no-wait        # prints {"id": …}
npx -y harmar-ai status <id>                          # progress 0–100, then the transcript
npx -y harmar-ai srt <id> --out long.srt

npx -y harmar-ai languages     # what --lang / --translate-to accept, live
npx -y harmar-ai balance       # minutes left
```

`--lang` takes an ISO code (`hy`, `ru`, `en`, `kk`, `ka`, `uk`, …) or `auto`.
Output is JSON unless `--srt`, `--vtt` or `--text` is given. Progress goes to
stderr; the result goes to stdout or `--out`.

## Captioned video (styled export)

The video is only exportable if the transcript was made with `--keep-media`
(or `--export`, which implies it) — by default the source is deleted the
moment the transcript exists.

```bash
# 1. see what a style can be: presets, fonts + the languages each renders, fields
npx -y harmar-ai styles

# 2. save the look once, by name — then every export uses exactly it
npx -y harmar-ai save-style "Brand" --style '{"preset":"pill","font":"montserrat","accentColor":"#D4F25A","bgOpacity":0.6,"posY":78}'
#    → prints the preset id

# 3a. one shot: transcribe + export
npx -y harmar-ai transcribe reel.mp4 --lang auto --export --preset <preset id> --out reel-captioned.mp4

# 3b. or export an existing transcript (made with --keep-media)
npx -y harmar-ai export <id> --preset <preset id> --out reel-captioned.mp4
npx -y harmar-ai export <id> --style-file brand.json --track en --platform instagram --out out.mp4

npx -y harmar-ai presets            # saved styles
npx -y harmar-ai export-status <id> # queued / rendering N% / completed (download_url) / failed
```

Rules the agent should follow:
- **Ask the user for the look if none was given** (colours, font, pill vs
  karaoke, position), or use the platform defaults from `harmar styles --json`.
- **Check the font renders the language**: `fonts[].languages` in the
  catalog. A font without the track's language falls back to Noto.
- **Save the style as a preset** when the user will want the same look again,
  and export by `--preset <id>` — that is the reliable way to reproduce it.
- `--track` picks which subtitle track to burn: the source language
  (default) or the `--translate-to` language.
- One export runs at a time per account; a second request answers
  `too_many_exports` — wait, then retry.
- Exit 1 with `media_purged` means the transcript was made without
  `--keep-media`: transcribe the file again with `--keep-media` (or `--export`).

## Options that change the transcript

| Flag | Effect |
|---|---|
| `--timestamps word\|segment\|none` | granularity in the JSON (default word) |
| `--no-punctuation` | strip punctuation |
| `--no-speakers` | drop dialogue dashes and speaker ids |
| `--lyrics include` | keep sung lines (excluded by default) |
| `--script file.txt` | you already have the exact words — align them, no transcription |
| `--webhook https://…` | POST on completion, `Harmar-Signature` HMAC header |

## Limits and errors

- Formats: MP4, MOV, WebM, M4A, MP3, WAV. Up to 60 minutes per file, 5 GB.
- Exit 1 with `insufficient_credits` carries `seconds_needed` and
  `seconds_available` — tell the user how many minutes to buy at
  https://harmar.ai/app/api; do not retry.
- Exit 3 means the wait timed out; the job is still running — `harmar status <id>`
  (or `harmar export-status <id>` for an export).
- A failed job refunds its charge automatically.
- Transcripts and media are purged after the retention window; `harmar delete <id>` purges now.

## Raw HTTP (if the CLI can't be run)

Base `https://api.harmar.ai`, header `Authorization: Bearer $HARMAR_API_KEY`.

```bash
# 1. get a presigned upload
curl -s -X POST https://api.harmar.ai/v1/uploads -H "Authorization: Bearer $HARMAR_API_KEY" \
  -H 'Content-Type: application/json' -d '{"filename":"video.mp4","file_size":12345678}'
# → {"media_id":…,"upload_url":…,"content_type":"video/mp4"}

# 2. PUT the bytes (Content-Type must match)
curl -s -X PUT "$UPLOAD_URL" -H 'Content-Type: video/mp4' --data-binary @video.mp4

# 3. submit
curl -s -X POST https://api.harmar.ai/v1/transcripts -H "Authorization: Bearer $HARMAR_API_KEY" \
  -H 'Content-Type: application/json' -d '{"media_id":"…","source_lang":"auto"}'
# → 202 {"id":…,"status":"processing","seconds_charged":…}

# 4. poll, then fetch
curl -s https://api.harmar.ai/v1/transcripts/$ID -H "Authorization: Bearer $HARMAR_API_KEY"
curl -s https://api.harmar.ai/v1/transcripts/$ID/srt -H "Authorization: Bearer $HARMAR_API_KEY"

# 5. styled export (the transcript must have been submitted with "keep_media": true)
curl -s https://api.harmar.ai/v1/styles -H "Authorization: Bearer $HARMAR_API_KEY"
curl -s -X POST https://api.harmar.ai/v1/transcripts/$ID/export -H "Authorization: Bearer $HARMAR_API_KEY" \
  -H 'Content-Type: application/json' -d '{"style":{"preset":"pill","font":"montserrat","accentColor":"#D4F25A"}}'
curl -s https://api.harmar.ai/v1/transcripts/$ID/export -H "Authorization: Bearer $HARMAR_API_KEY"
# → {"status":"completed","download_url":"https://…"}  (signed, 1 hour)
```

Full reference: https://harmar.ai/developers
