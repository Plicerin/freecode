// `freecode probe [prompt] [--tools]` — send ONE real request to the configured
// provider and print the exact HTTP request body + the streamed response (no
// agent loop, no tool execution). The point: make provider behavior directly
// observable — does it connect, does it 400, does it emit a reasoning channel,
// does it actually produce tool_calls — instead of inferring from a full session.
import { loadConfig, type CliFlags } from "../config/loader";
import { buildProvider } from "../providers/registry";
import { buildToolRegistry, toolListToSystemPrompt } from "../tools/registry";
import { streamIdleMs } from "../providers/stall-timeout";
import type { ChatRequest, StreamEvent, ToolDefinition } from "../providers/types";

function mask(key?: string): string {
  if (!key) return "NONE";
  return key.length <= 10 ? "set" : `set (${key.slice(0, 6)}…${key.slice(-2)})`;
}

/** Pull `--flag value` out of argv (for the few overrides probe supports). */
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export async function runProbe(argv: string[]): Promise<void> {
  const withTools = argv.includes("--tools");
  const overrideNames = new Set(["--provider", "--model", "--base-url", "--api-key"]);
  // Positional args (the prompt) are everything that isn't a flag or a flag value.
  const prompt = argv
    .filter((a, i) => !a.startsWith("--") && !overrideNames.has(argv[i - 1] ?? ""))
    .join(" ").trim()
    || "Reply with exactly: PROBE OK";

  const flags: CliFlags = {
    provider: flagValue(argv, "--provider") as CliFlags["provider"],
    model: flagValue(argv, "--model"),
    baseUrl: flagValue(argv, "--base-url"),
    apiKey: flagValue(argv, "--api-key"),
  };
  const config = loadConfig({ flags }); // REPL resolution, with optional overrides
  const tools = buildToolRegistry();
  const toolDefs: ToolDefinition[] | undefined = withTools
    ? tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema as never, permission: t.permission, parameters: t.parameters }))
    : undefined;

  process.stdout.write(
    `── freecode probe ──\n` +
    `provider:  ${config.provider}\n` +
    `model:     ${config.model}\n` +
    `baseURL:   ${config.baseUrl ?? "(provider default)"}\n` +
    `api key:   ${mask(config.apiKey)}\n` +
    `thinking:  ${config.enableExtendedThinking ? "on" : "off"}\n` +
    `REASONING_EFFORT env: ${process.env.FREECODE_REASONING_EFFORT ?? "(unset)"}\n` +
    `tools:     ${withTools ? `${toolDefs!.length} sent` : "none (pass --tools to include them)"}\n` +
    `prompt:    ${JSON.stringify(prompt)}\n\n`,
  );

  const provider = buildProvider(config);
  const req: ChatRequest = {
    model: config.model,
    system: withTools ? toolListToSystemPrompt(tools) : undefined,
    messages: [{ role: "user", content: prompt }],
    tools: toolDefs,
    stream: true,
    maxTokens: 1024,
    enableExtendedThinking: config.enableExtendedThinking,
  };

  // Intercept fetch to print the EXACT outgoing HTTP body (reasoning_effort,
  // temperature, max_tokens, tools…) — the thing that's otherwise invisible.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.body) {
      process.stdout.write(`→ ${init.method ?? "POST"} ${url}\n`);
      try {
        const body = JSON.parse(init.body);
        // System prompt can be huge; summarize it.
        if (typeof body.system === "string") body.system = `<${body.system.length} chars>`;
        if (Array.isArray(body.messages)) for (const m of body.messages) if (typeof m?.content === "string" && m.content.length > 200) m.content = m.content.slice(0, 200) + "…";
        if (Array.isArray(body.tools)) body.tools = `<${body.tools.length} tool defs>`;
        process.stdout.write(JSON.stringify(body, null, 2) + "\n\n");
      } catch {
        process.stdout.write(init.body.slice(0, 2000) + "\n\n");
      }
    }
    return realFetch(url as never, init as never);
  }) as unknown as typeof fetch;

  const idleS = Math.round(streamIdleMs() / 1000);
  process.stdout.write(`── response ── (awaiting first byte; aborts after ~${idleS}s of silence)\n`);
  const t0 = Date.now();
  let text = "", reasoning = "", toolCalls = 0, errored = "", firstByteMs = -1;
  try {
    for await (const e of provider.stream(req) as AsyncIterable<StreamEvent>) {
      if (firstByteMs < 0) { firstByteMs = Date.now() - t0; process.stdout.write(`[first event after ${firstByteMs}ms]\n`); }
      switch (e.type) {
        case "thinking_delta": reasoning += e.delta; process.stdout.write(`\x1b[2m${e.delta}\x1b[0m`); break;
        case "text_delta": text += e.delta; process.stdout.write(e.delta); break;
        case "tool_call": toolCalls++; process.stdout.write(`\n🔧 tool_call: ${e.call.name}(${JSON.stringify(e.call.arguments)})\n`); break;
        case "usage": process.stdout.write(`\n[usage: in=${e.usage.input} out=${e.usage.output}]\n`); break;
        case "error": errored = e.error.message; process.stdout.write(`\n❌ error: ${e.error.message}\n`); break;
        case "end": process.stdout.write(`\n[end: ${e.reason}]\n`); break;
      }
    }
  } catch (err) {
    errored = err instanceof Error ? err.message : String(err);
    process.stdout.write(`\n❌ stream threw: ${errored}\n`);
  } finally {
    globalThis.fetch = realFetch;
  }

  process.stdout.write(
    `\n── summary (${Date.now() - t0}ms) ──\n` +
    `first event: ${firstByteMs < 0 ? "NEVER — no response received (model id wrong? endpoint stalled?)" : firstByteMs + "ms"}\n` +
    `reasoning: ${reasoning.length} chars\n` +
    `text:      ${text.length} chars\n` +
    `tool calls: ${toolCalls}\n` +
    `error:     ${errored || "none"}\n` +
    (withTools && toolCalls === 0 && !errored
      ? `\n⚠ Sent tools but the model emitted NO tool_call — it answered in prose. That's the agentic gap: the model isn't choosing to call tools.\n`
      : "") +
    (errored ? `\n⚠ The provider call failed. If it's a parameter error, that's a request-shape problem (see the body above).\n` : ""),
  );
}
