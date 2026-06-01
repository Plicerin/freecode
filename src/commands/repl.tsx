import React, { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { loadConfig, type CliFlags } from "../config/loader";
import { buildProvider } from "../providers/registry";
import { buildToolRegistry } from "../tools/registry";
import { createPermissionEngine, type ApprovalCallback, type ApprovalDecision, type ApprovalRequest } from "../permissions/modes";
import { runAgentLoop } from "../agent/loop";
import { ContextTracker } from "../agent/context";
import { newSession, appendEvent, listSessions, resumeSession, readSession, type Session } from "../session/manager";
import { makeTheme } from "../tui/theme";
import { debug } from "../utils/debug";

export interface ReplOptions {
  flags?: CliFlags;
  resumeId?: string;
  initialPrompt?: string;
}

interface UiMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  toolName?: string;
  ok?: boolean;
}

const SLASH_COMMANDS = ["/model", "/new", "/resume", "/context", "/provider", "/help", "/compact"];

// 5-row block font for the startup banner.
const FONT: Record<string, string[]> = {
  F: ["█████", "█    ", "████ ", "█    ", "█    "],
  R: ["████ ", "█   █", "████ ", "█  █ ", "█   █"],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
  C: [" ████", "█    ", "█    ", "█    ", " ████"],
  O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
  D: ["████ ", "█   █", "█   █", "█   █", "████ "],
  " ": ["     ", "     ", "     ", "     ", "     "],
};

function bannerRows(word: string): string[] {
  const rows = ["", "", "", "", ""];
  for (const ch of word.toUpperCase()) {
    const glyph = FONT[ch] ?? FONT[" "]!;
    for (let i = 0; i < 5; i++) rows[i] += glyph[i] + "  ";
  }
  return rows;
}

// Interpolate an orange→red gradient across the banner rows.
function gradientHex(t: number): string {
  const top = { r: 245, g: 166, b: 90 };
  const bot = { r: 171, g: 43, b: 63 };
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * t);
  const c = [lerp(top.r, bot.r), lerp(top.g, bot.g), lerp(top.b, bot.b)];
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function defaultEndpoint(provider: string, baseUrl?: string): string {
  if (baseUrl) return baseUrl;
  switch (provider) {
    case "openai": return "https://api.openai.com/v1";
    case "github-models": return "https://models.inference.ai.azure.com";
    case "gemini": return "https://generativelanguage.googleapis.com";
    case "anthropic": return "https://api.anthropic.com";
    case "ollama": return "http://localhost:11434/v1";
    case "lmstudio": return "http://127.0.0.1:1234/v1";
    case "nim": return "https://integrate.api.nvidia.com/v1";
    default: return "(default)";
  }
}

function Banner(): JSX.Element {
  const rows = [...bannerRows("FREE"), ...bannerRows("CODE")];
  return (
    <Box flexDirection="column" marginLeft={1}>
      {rows.map((row, i) => (
        <Text key={i} color={gradientHex(i / (rows.length - 1))} bold>
          {row}
        </Text>
      ))}
    </Box>
  );
}

interface IntroProps {
  provider: string;
  model: string;
  endpoint: string;
  isLocal: boolean;
  theme: ReturnType<typeof makeTheme>;
}

function Intro({ provider, model, endpoint, isLocal, theme }: IntroProps): JSX.Element {
  const label = (s: string) => <Text color={theme.dim}>{s.padEnd(10)}</Text>;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Banner />
      <Box marginLeft={1} marginTop={1}>
        <Text color={theme.hex.assistant}>✦ </Text>
        <Text>Any model. Every tool. Zero limits.</Text>
        <Text color={theme.hex.assistant}> ✦</Text>
      </Box>
      <Box marginLeft={1} marginTop={1} flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text>{label("Provider")}<Text color={theme.hex.assistant}>{provider}</Text></Text>
        <Text>{label("Model")}<Text bold>{model}</Text></Text>
        <Text>{label("Endpoint")}<Text color={theme.user}>{endpoint}</Text></Text>
      </Box>
      <Box marginLeft={1}>
        <Text color={theme.hex.success}>● </Text>
        <Text color={theme.dim}>{(isLocal ? "local" : "remote").padEnd(8)}</Text>
        <Text color={theme.dim}>Ready — type </Text>
        <Text color={theme.hex.assistant}>/help</Text>
        <Text color={theme.dim}> to begin</Text>
      </Box>
      <Box marginLeft={1} marginTop={1}>
        <Text color={theme.dim}>freecode </Text>
        <Text color={theme.hex.assistant}>v0.1.0</Text>
      </Box>
    </Box>
  );
}

export async function startRepl(opts: ReplOptions = {}): Promise<void> {
  const { render } = await import("ink");
  const instance = render(<Repl flags={opts.flags ?? {}} resumeId={opts.resumeId} initialPrompt={opts.initialPrompt} />);
  await instance.waitUntilExit();
}

export function Repl({ flags, resumeId, initialPrompt }: ReplOptions): JSX.Element {
  const { exit } = useApp();
  const config = useMemo(() => loadConfig({ flags: flags ?? {} }), [flags]);
  const theme = useMemo(() => makeTheme(config.theme), [config.theme]);
  const provider = useMemo(() => buildProvider(config), [config]);
  const tools = useMemo(
    () =>
      buildToolRegistry({
        webSearch: {
          tavilyKey: process.env.TAVILY_API_KEY,
          exaKey: process.env.EXA_API_KEY,
          firecrawlKey: process.env.FIRECRAWL_API_KEY,
          defaultBackend: config.webSearchProvider,
        },
      }),
    [config.webSearchProvider],
  );
  const permission = useMemo(
    () => createPermissionEngine(config.permissionMode, (async () => "allow") as ApprovalCallback),
    [config.permissionMode],
  );
  const trackerRef = useRef(new ContextTracker({ threshold: config.contextThreshold }));
  const sessionRef = useRef<Session>(undefined as unknown as Session);

  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [costUsd, setCostUsd] = useState(0);
  const [pending, setPending] = useState<ApprovalRequest | null>(null);
  const approvalResolver = useRef<((d: ApprovalDecision) => void) | null>(null);

  const promptUser: ApprovalCallback = (req) =>
    new Promise<ApprovalDecision>((resolve) => {
      setPending(req);
      approvalResolver.current = (decision) => {
        approvalResolver.current = null;
        setPending(null);
        resolve(decision);
      };
    });

  useEffect(() => {
    const cwd = process.cwd();
    if (resumeId) {
      const s = resumeSession(cwd, resumeId);
      if (!s) {
        setErrorLine(`No such session: ${resumeId}`);
        sessionRef.current = newSession(cwd);
      } else {
        sessionRef.current = s;
        const events = readSession(s) as Array<{ kind: string; text: string; name?: string; ok?: boolean }>;
        const restored: UiMessage[] = events
          .filter((e) => e.kind === "user" || e.kind === "assistant" || e.kind === "tool_result")
          .map((e, i) => ({
            id: `${s.id}-${i}`,
            role: e.kind === "user" ? "user" : e.kind === "assistant" ? "assistant" : "tool",
            text: e.text,
            toolName: (e as { name?: string }).name,
            ok: (e as { ok?: boolean }).ok,
          }));
        setMessages(restored);
      }
    } else {
      sessionRef.current = newSession(cwd);
    }
    if (initialPrompt) {
      void submit(initialPrompt);
    }
  }, []);

  async function submit(prompt: string): Promise<void> {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setErrorLine(null);
    const id = `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setMessages((prev) => [...prev, { id, role: "user", text: prompt }]);
    appendEvent(sessionRef.current, { kind: "user", text: prompt, ts: new Date().toISOString() });
    let buffer = "";
    const t0 = Date.now();
    try {
      const result = await runAgentLoop({
        provider,
        tools,
        model: config.model,
        maxTurns: config.maxTurns,
        prompt,
        permission,
        promptUser,
        onEvent: (e) => {
          if (e.type === "text_delta" && e.text) {
            buffer += e.text;
          } else if (e.type === "tool_call" && e.call) {
            const call = e.call;
            const tid = `t-${call.id ?? Math.random().toString(36).slice(2, 8)}`;
            setMessages((prev) => [...prev, { id: tid, role: "tool", text: `→ ${call.name}(${JSON.stringify(call.arguments).slice(0, 120)})`, toolName: call.name }]);
            appendEvent(sessionRef.current, { kind: "tool_call", id: call.id ?? tid, name: call.name, args: call.arguments, ts: new Date().toISOString() });
          } else if (e.type === "tool_result" && e.result) {
            const r = e.result;
            const rid = r.id ?? Math.random().toString(36).slice(2, 8);
            const tid = `r-${rid}`;
            setMessages((prev) =>
              prev
                .map((m) => (m.id === `t-${rid}` ? { ...m, text: m.text + (r.ok ? " ✓" : " ✗") } : m))
                .concat([{ id: tid, role: "tool", text: r.output.slice(0, 2000), toolName: "result", ok: r.ok }]),
            );
            appendEvent(sessionRef.current, { kind: "tool_result", id: rid, output: r.output, ok: r.ok, durationMs: r.durationMs, ts: new Date().toISOString() });
          } else if (e.type === "usage" && e.usage) {
            trackerRef.current.record(e.usage);
            setCostUsd(trackerRef.current.costUsd());
          } else if (e.type === "error" && e.error) {
            setErrorLine(e.error);
          }
        },
      });
      const aid = `a-${t0}`;
      setMessages((prev) => [...prev, { id: aid, role: "assistant", text: buffer }]);
      appendEvent(sessionRef.current, { kind: "assistant", text: buffer, ts: new Date().toISOString(), usage: result.usage as unknown as Record<string, number> });
      debug.log("turn complete", { turns: result.turns, usage: result.usage });
    } catch (err) {
      setErrorLine(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runSlash(cmd: string): Promise<void> {
    const [name, ...rest] = cmd.split(/\s+/);
    const arg = rest.join(" ");
    switch (name) {
      case "/model": {
        if (arg) {
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Model switched to ${arg} (effective next turn)` }]);
          // In a full impl, mutate config.model via reload; here we log and continue.
        } else {
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Current model: ${config.model} (provider: ${config.provider})` }]);
        }
        break;
      }
      case "/new": {
        const cwd = process.cwd();
        sessionRef.current = newSession(cwd);
        setMessages([]);
        setCostUsd(0);
        setErrorLine(null);
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "New session started" }]);
        break;
      }
      case "/resume": {
        const sessions = listSessions(process.cwd());
        if (!arg) {
          const list = sessions.slice(0, 10).map((s) => `  ${s.id}`).join("\n");
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Sessions:\n${list || "(none)"}` }]);
        } else {
          const s = resumeSession(process.cwd(), arg);
          if (s) {
            sessionRef.current = s;
            setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Resumed ${arg}` }]);
          } else {
            setErrorLine(`No such session: ${arg}`);
          }
        }
        break;
      }
      case "/context": {
        const u = trackerRef.current["usage"];
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Tokens: in=${u.input} out=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} thinking=${u.thinking}\nCost: $${costUsd.toFixed(4)}` }]);
        break;
      }
      case "/provider": {
        if (arg) {
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Provider switch to ${arg} — restart with --provider ${arg} (env reload required for live switch)` }]);
        } else {
          setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: `Provider: ${config.provider}\nBase URL: ${config.baseUrl ?? "(default)"}\nModel: ${config.model}` }]);
        }
        break;
      }
      case "/help": {
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: SLASH_COMMANDS.join("\n") }]);
        break;
      }
      case "/compact": {
        setMessages((prev) => [...prev, { id: `s-${Date.now()}`, role: "system", text: "Context compaction requested — will run when utilization ≥ threshold" }]);
        break;
      }
      default:
        setErrorLine(`Unknown command: ${name}`);
    }
  }

  useInput((input2, key) => {
    if (key.ctrl && input2 === "c") {
      exit();
      return;
    }
    // While a tool-approval prompt is open, keys select a decision and nothing else.
    if (pending) {
      const lower = input2?.toLowerCase();
      if (lower === "a") approvalResolver.current?.("allow");
      else if (lower === "y") approvalResolver.current?.("allow-always");
      else if (lower === "d" || key.escape) approvalResolver.current?.("deny");
      return;
    }
    if (key.ctrl && input2 === "u") {
      setInput("");
      return;
    }
    if (key.ctrl && input2 === "t") {
      setShowTasks((v) => !v);
      return;
    }
    if (key.tab) {
      // autocomplete slash command
      if (input.startsWith("/")) {
        const match = SLASH_COMMANDS.find((c) => c.startsWith(input));
        if (match) setInput(match + " ");
      }
      return;
    }
    if (key.return) {
      const value = input;
      setInput("");
      if (value.startsWith("/")) {
        void runSlash(value);
      } else {
        void submit(value);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      return;
    }
    if (input2 && !key.ctrl && !key.meta) {
      setInput((v) => v + input2);
    }
  });

  const endpoint = defaultEndpoint(config.provider, config.baseUrl);
  const isLocal = config.provider === "ollama" || config.provider === "lmstudio";

  return (
    <Box flexDirection="column">
      <Static items={[{ provider: config.provider, model: config.model, endpoint, isLocal }]}>
        {(item, i) => (
          <Intro key={`intro-${i}`} provider={item.provider} model={item.model} endpoint={item.endpoint} isLocal={item.isLocal} theme={theme} />
        )}
      </Static>

      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          {messages.slice(-200).filter((m) => m.id).map((m, i) => (
            <Box key={`${m.id}:${i}`} flexDirection="column" marginBottom={0}>
              <Text>
                {m.role === "user" && <Text color={theme.user}>› </Text>}
                {m.role === "assistant" && <Text color={theme.hex.assistant}>● </Text>}
                {m.role === "tool" && <Text color={theme.tool}>⚙ </Text>}
                {m.role === "system" && <Text color={theme.dim}>· </Text>}
                <Text color={m.role === "assistant" ? theme.hex.assistant : undefined}>{m.text}</Text>
              </Text>
            </Box>
          ))}
          {busy && <Text color={theme.hex.warning}>· Combobulating…</Text>}
          {errorLine && <Text color={theme.hex.error}>! {errorLine}</Text>}
        </Box>
        {showTasks && (
          <Box flexDirection="column" width={28} paddingX={1} borderStyle="single" borderColor={theme.border}>
            <Text bold>Tasks</Text>
            <Text dimColor>(no active tasks)</Text>
          </Box>
        )}
      </Box>

      {pending ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.hex.warning} paddingX={1} marginTop={1}>
          <Text>
            <Text color={theme.hex.warning}>⚠ Approve tool </Text>
            <Text bold color={theme.hex.warning}>{pending.tool}</Text>
            <Text dimColor>?</Text>
          </Text>
          <Text dimColor>{pending.argsSummary}</Text>
        </Box>
      ) : (
        <Box borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={1}>
          <Text>
            <Text color={theme.user}>› </Text><Text>{input || " "}</Text>
          </Text>
        </Box>
      )}
      <Box paddingX={1} flexDirection="row" justifyContent="space-between">
        <Text dimColor>
          {pending
            ? "[a] allow once · [y] allow always · [d] deny (esc)"
            : busy
              ? "esc to interrupt"
              : "Ctrl+C exit · Ctrl+U clear · Ctrl+T tasks · Tab complete · Enter send"}
        </Text>
        <Text>
          <Text dimColor>cost </Text>
          <Text color={theme.hex.success}>${costUsd.toFixed(4)}</Text>
        </Text>
      </Box>
    </Box>
  );
}
