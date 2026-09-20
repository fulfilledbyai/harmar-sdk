// The MCP server over a real stdio transport, driven by the SDK's own
// client. Offline half: the server starts, lists its tools, refuses a
// tool call without a key as a TOOL error (not a crash), and rejects a
// bad enum at the schema. Online half (HARMAR_API_KEY + HARMAR_API_URL
// set): balance, a transcript, subtitles, and a 404 as a tool error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI = new URL("../cli.js", import.meta.url).pathname;

async function connect(env: Record<string, string | undefined>) {
  const c = new Client({ name: "harmar-test", version: "0" });
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env: clean }));
  return c;
}
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

test("lists the fourteen tools", async () => {
  const c = await connect({ PATH: process.env.PATH });
  const { tools } = await c.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "harmar_balance",
      "harmar_delete_style_preset",
      "harmar_delete_transcript",
      "harmar_export",
      "harmar_get_export",
      "harmar_get_subtitles",
      "harmar_get_transcript",
      "harmar_languages",
      "harmar_list_style_presets",
      "harmar_list_styles",
      "harmar_pricing",
      "harmar_save_style",
      "harmar_transcribe",
      "harmar_usage",
    ],
  );
  await c.close();
});

test("a missing key is a tool error, not a crash", async () => {
  const c = await connect({ PATH: process.env.PATH, HARMAR_API_KEY: undefined });
  const r = await c.callTool({ name: "harmar_balance", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /missing_api_key/);
  // The server is still alive after the error.
  const { tools } = await c.listTools();
  assert.equal(tools.length, 14);
  await c.close();
});

test("a bad enum is rejected by the schema", async () => {
  const c = await connect({ PATH: process.env.PATH, HARMAR_API_KEY: "hk_live_x" });
  const r = await c
    .callTool({ name: "harmar_get_subtitles", arguments: { id: "x", format: "pdf" } })
    .catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
  assert.equal(r.isError, true);
  assert.match(textOf(r), /format|invalid|enum/i);
  await c.close();
});

const online = Boolean(process.env.HARMAR_API_KEY && process.env.HARMAR_API_URL);
test("online: balance, transcript, subtitles, 404", { skip: !online && "set HARMAR_API_KEY + HARMAR_API_URL" }, async () => {
  const c = await connect(process.env);
  const bal = JSON.parse(textOf(await c.callTool({ name: "harmar_balance", arguments: {} })));
  assert.equal(typeof bal.seconds_remaining, "number");

  const notFound = await c.callTool({
    name: "harmar_get_transcript",
    arguments: { id: "00000000-0000-0000-0000-000000000000" },
  });
  assert.equal(notFound.isError, true);
  assert.match(textOf(notFound), /not_found/);

  const styles = JSON.parse(textOf(await c.callTool({ name: "harmar_list_styles", arguments: {} })));
  assert.equal(styles.presets.length, 7);
  assert.ok(styles.fonts.some((f: { key: string; languages: string[] }) => f.key === "noto" && f.languages.includes("hy")));
  assert.ok("accentColor" in styles.fields);
  const presets = JSON.parse(textOf(await c.callTool({ name: "harmar_list_style_presets", arguments: {} })));
  assert.ok(Array.isArray(presets));
  const rejected = await c.callTool({ name: "harmar_save_style", arguments: { name: "x", style: { preset: "pill", accent_color: "#fff" } } });
  assert.equal(rejected.isError, true, "unknown style field must be a tool error");
  assert.match(textOf(rejected), /invalid_style/);

  // A real export through the MCP tool, saved to disk. Needs a transcript
  // that was submitted with keep_media (HARMAR_TEST_EXPORT_ID).
  const exportId = process.env.HARMAR_TEST_EXPORT_ID;
  if (exportId) {
    const { mkdtempSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const out = join(mkdtempSync(join(tmpdir(), "harmar-sdk-")), "captioned.mp4");
    const r = await c.callTool({
      name: "harmar_export",
      arguments: { id: exportId, style: { preset: "popin", font: "noto", accentColor: "#D4F25A" }, save_to: out, timeout_seconds: 600 },
    });
    assert.notEqual(r.isError, true, textOf(r));
    const state = JSON.parse(textOf(r));
    assert.equal(state.status, "completed");
    assert.equal(state.file, out);
    assert.ok(statSync(out).size > 10_000, "mp4 written");
  }

  const id = process.env.HARMAR_TEST_TRANSCRIPT_ID;
  if (id) {
    const tr = JSON.parse(textOf(await c.callTool({ name: "harmar_get_transcript", arguments: { id } })));
    assert.equal(tr.status, "completed");
    assert.ok(!("words" in tr), "words omitted by default");
    assert.equal(typeof tr.word_count, "number");
    const full = JSON.parse(textOf(await c.callTool({ name: "harmar_get_transcript", arguments: { id, include_words: true } })));
    assert.equal(full.words.length, tr.word_count);
    const srt = textOf(await c.callTool({ name: "harmar_get_subtitles", arguments: { id, format: "srt" } }));
    assert.match(srt, /^1\r?\n\d\d:\d\d:\d\d,\d\d\d --> /);
  }
  await c.close();
});
