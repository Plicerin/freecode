// Defense-in-depth secret scrubbing. Tool output (a `Get-ChildItem Env:`, a
// `cat .env`, a stray echo) can contain live API keys. We must never let those
// flow into the transcript, the session log on disk, or — worst of all — the
// request we send to the model provider. This redacts well-known key formats
// from any text before it leaves the tool layer.

const PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, label: "anthropic-key" },
  { re: /sk-proj-[A-Za-z0-9_-]{20,}/g, label: "openai-key" },
  { re: /sk-[A-Za-z0-9]{32,}/g, label: "openai-key" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, label: "github-pat" },
  { re: /gh[pousr]_[A-Za-z0-9]{30,}/g, label: "github-token" },
  { re: /AIza[A-Za-z0-9_-]{30,}/g, label: "google-key" },
  { re: /AKIA[A-Z0-9]{16}/g, label: "aws-key-id" },
  { re: /hf_[A-Za-z0-9]{20,}/g, label: "hf-token" },
  { re: /nvapi-[A-Za-z0-9_-]{20,}/g, label: "nvidia-key" },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, label: "slack-token" },
];

export function redactSecrets(text: string): { text: string; count: number } {
  if (!text) return { text, count: 0 };
  let out = text;
  let count = 0;
  for (const { re, label } of PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return `[REDACTED:${label}]`;
    });
  }
  return { text: out, count };
}
