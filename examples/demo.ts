#!/usr/bin/env bun
// Demo: run the agent loop directly with the mock provider, then with a real
// tool. This is the same code path the REPL uses, just without Ink.

import { loadConfig } from "../src/config/loader";
import { buildProvider } from "../src/providers/registry";
import { buildToolRegistry } from "../src/tools/registry";
import { createPermissionEngine, type ApprovalCallback } from "../src/permissions/modes";
import { runAgentLoop } from "../src/agent/loop";

async function main() {
  const config = loadConfig({ flags: { provider: "ollama", model: "llama3.2" } });
  const provider = buildProvider(config);
  const tools = buildToolRegistry();
  const permission = createPermissionEngine("bypass", (async () => "allow") as ApprovalCallback);

  const prompt = process.argv[2] ?? "say hi in 5 words";
  console.log(`[openclaude] provider=${config.provider} model=${config.model} tools=${tools.map(t => t.name).join(",")}`);
  console.log(`[openclaude] prompt: ${prompt}\n`);

  const result = await runAgentLoop({
    provider,
    tools,
    model: config.model,
    maxTurns: 5,
    prompt,
    permission,
    promptUser: (async () => "allow") as ApprovalCallback,
    onEvent: (e) => {
      if (e.type === "text_delta" && e.text) process.stdout.write(e.text);
      else if (e.type === "tool_call" && e.call) console.log(`\n[tool_call] ${e.call.name} ${JSON.stringify(e.call.arguments)}`);
      else if (e.type === "tool_result" && e.result) console.log(`[tool_result] ok=${e.result.ok} bytes=${e.result.output.length}`);
      else if (e.type === "error") console.log(`\n[error] ${e.error}`);
    },
  });

  console.log(`\n\n[done] turns=${result.turns} in=${result.usage.input} out=${result.usage.output}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
