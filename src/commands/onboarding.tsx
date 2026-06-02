import React, { useState } from "react";
import type { JSX } from "react";
import { Box, Text, useInput } from "ink";
import { Vault } from "../config/vault";
import { makeTheme } from "../tui/theme";

interface ProviderOption {
  id: string;
  label: string;
  hint: string;
}

const PROVIDERS: ProviderOption[] = [
  { id: "anthropic", label: "Anthropic (Claude)", hint: "sk-ant-…" },
  { id: "openai", label: "OpenAI (GPT)", hint: "sk-…" },
  { id: "gemini", label: "Google Gemini", hint: "AIza…" },
  { id: "github-models", label: "GitHub Models", hint: "ghp_… / GITHUB_TOKEN" },
  { id: "nim", label: "NVIDIA NIM", hint: "nvapi-…" },
];

const theme = makeTheme("dark");

/** A masked single-line input: shows '*' per character + a live count, so you
 * can see the key landed (and that paste worked) without revealing it. */
function MaskedKeyInput({ onSubmit }: { onSubmit: (value: string) => void }): JSX.Element {
  const [val, setVal] = useState("");
  useInput((input, key) => {
    if (key.return) { onSubmit(val); return; }
    if (key.backspace || key.delete) { setVal((v) => v.slice(0, -1)); return; }
    if (key.ctrl || key.meta) return;
    const clean = (input || "").replace(/[\x00-\x1F\x7F]/g, ""); // paste-safe; drop control bytes
    if (clean) setVal((v) => v + clean);
  });
  return (
    <Text>
      <Text color={theme.user}>› </Text>
      <Text>{"*".repeat(val.length)}</Text>
      <Text inverse> </Text>
      {val.length > 0 && <Text dimColor>  ({val.length} chars)</Text>}
    </Text>
  );
}

export function Onboarding({ onComplete }: { onComplete: () => void }): JSX.Element {
  const [step, setStep] = useState<"select" | "enter" | "done">("select");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [queue, setQueue] = useState<string[]>([]);
  const [qIdx, setQIdx] = useState(0);
  const [savedCount, setSavedCount] = useState(0);
  const storedRef = useState<Record<string, string>>({})[0];

  function finish(keys: Record<string, string>): void {
    const n = Object.keys(keys).length;
    if (n > 0) {
      try { Vault.load().setMany(keys); } catch { /* leave keys unset on failure */ }
    }
    setSavedCount(n);
    setStep("done");
    setTimeout(onComplete, 700);
  }

  useInput((input, key) => {
    if (step !== "select") return;
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(PROVIDERS.length - 1, c + 1));
    else if (input === " ") {
      setChecked((prev) => {
        const next = new Set(prev);
        const id = PROVIDERS[cursor]!.id;
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    } else if (key.return) {
      const sel = PROVIDERS.filter((p) => checked.has(p.id)).map((p) => p.id);
      if (sel.length === 0) { finish({}); return; }
      setQueue(sel);
      setQIdx(0);
      setStep("enter");
    } else if (key.escape) {
      finish({}); // skip
    }
  });

  function submitKey(value: string): void {
    const id = queue[qIdx]!;
    if (value.trim()) storedRef[id] = value.trim();
    if (qIdx + 1 < queue.length) setQIdx((i) => i + 1);
    else finish(storedRef);
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text>
        <Text color={theme.hex.assistant} bold>Welcome to freecode. </Text>
        <Text dimColor>Let's set up your API keys (stored encrypted, just once).</Text>
      </Text>

      {step === "select" && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Which providers do you have keys for? (↑/↓ move · space toggle · enter continue · esc skip)</Text>
          <Box flexDirection="column" marginTop={1}>
            {PROVIDERS.map((p, i) => (
              <Text key={p.id} color={i === cursor ? theme.user : undefined}>
                {i === cursor ? "❯ " : "  "}
                <Text color={checked.has(p.id) ? theme.hex.success : theme.dim}>{checked.has(p.id) ? "[x]" : "[ ]"}</Text>
                {" "}{p.label}
                <Text dimColor>  {p.hint}</Text>
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {step === "enter" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text dimColor>({qIdx + 1}/{queue.length}) </Text>
            Paste your <Text bold>{PROVIDERS.find((p) => p.id === queue[qIdx])?.label ?? queue[qIdx]}</Text> key
            <Text dimColor> (enter to skip):</Text>
          </Text>
          <Box marginTop={1}>
            <MaskedKeyInput key={qIdx} onSubmit={submitKey} />
          </Box>
        </Box>
      )}

      {step === "done" && (
        <Box marginTop={1}>
          <Text color={theme.hex.success}>
            ✓ {savedCount > 0 ? `Saved ${savedCount} key${savedCount === 1 ? "" : "s"} to the encrypted vault.` : "Skipped — no keys saved."}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** Render the onboarding wizard and resolve when the user finishes. */
export async function runOnboarding(): Promise<void> {
  const { render } = await import("ink");
  await new Promise<void>((resolve) => {
    let unmount = (): void => {};
    const instance = render(<Onboarding onComplete={() => { unmount(); resolve(); }} />);
    unmount = instance.unmount;
  });
}
