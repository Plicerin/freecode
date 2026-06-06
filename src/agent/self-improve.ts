// Self-improvement (ROADMAP Tier I — freecode's identity feature). The model is
// frozen; what compounds is the HARNESS. freecode watches its own work — this
// session's transcript plus the recent activity log — and proposes DURABLE,
// inspectable artifacts that make the next run faster/cheaper/more correct:
//   • a "rule"  → a standing instruction appended to FREECODE.md (loaded into the
//                 system prompt every session),
//   • a "skill" → a reusable procedure written to .freecode/skills/<name>.md.
//
// Phase 1 (this file) = the analyzer + propose-and-confirm. Nothing is ever
// written without the user accepting it, and every proposal carries the evidence
// (quoted transcript/log lines) that justifies it. Phase 2 adds the measurement
// loop (did the artifact actually help — turns/corrections/verify-first-try).
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "../providers/types";
import type { ChatMessage } from "../providers/types";

export const ProposalSchema = z.object({
  kind: z.enum(["rule", "skill"]),
  name: z.string().min(1), // kebab id — skill filename or short rule slug
  description: z.string().min(1), // skill trigger, or the rule's one-line summary
  body: z.string().min(1), // skill instructions, or the rule text
  evidence: z.array(z.string().min(1)).min(1), // quoted transcript/log lines
  rationale: z.string().min(1), // why this will help next time
});
export type Proposal = z.infer<typeof ProposalSchema>;

const ProposalsSchema = z.object({ proposals: z.array(ProposalSchema) });

/** Pull the first JSON object out of a model reply (tolerates ``` fences + prose). */
function extractJsonObject(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Render a conversation into a compact transcript for the analyzer. */
export function transcriptFromMessages(messages: ChatMessage[], maxChars = 12_000): string {
  const lines = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role.toUpperCase()}: ${m.content.replace(/\s+/g, " ").trim()}`)
    .filter((l) => l.length > 6);
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(out.length - maxChars); // keep the most recent
  return out;
}

/** A kebab, traversal-safe filename from a model-supplied name. */
export function safeSkillName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "skill";
}

const SYSTEM = [
  "You are freecode's self-improvement analyzer. Read the session transcript (and any recent activity-log excerpt) and propose DURABLE improvements that would make the NEXT session better. Output JSON only — no prose, no fences.",
  "",
  "Shape: { \"proposals\": [ { \"kind\": \"rule\"|\"skill\", \"name\": string, \"description\": string, \"body\": string, \"evidence\": string[], \"rationale\": string } ] }",
  "",
  "Two kinds:",
  "- \"rule\": a standing instruction the user corrected you into, or that would have prevented a mistake this session. It will be appended to FREECODE.md and loaded every session. Keep it a single imperative sentence in `body`.",
  "- \"skill\": a reusable multi-step PROCEDURE worth saving (e.g. a release flow, a project-specific build/debug recipe). `body` is the step-by-step instructions; `description` is the trigger (when to use it).",
  "",
  "Hard rules:",
  "- Propose ONLY with concrete evidence: a user correction, a repeated procedure, or a recurring failure. Put the exact quoted transcript/log line(s) in `evidence`.",
  "- Prefer ZERO proposals to weak or generic ones. Never propose vague advice (\"write clean code\"), one-off facts, or anything already obvious from the codebase.",
  "- `name` is a short kebab-case id. At most 3 proposals.",
  "- If nothing is worth saving, return { \"proposals\": [] }.",
].join("\n");

export interface AnalyzeInput {
  transcript: string;
  activityTail?: string;
  signal?: AbortSignal;
}

/** Ask the model to propose durable improvements from this session. Returns []
 *  when the model declines (no JSON / empty); throws only on malformed JSON that
 *  fails the schema, so a junk reply is surfaced rather than silently dropped. */
export async function analyzeSession(provider: Provider, model: string, input: AnalyzeInput): Promise<Proposal[]> {
  const user = [
    "Session transcript:",
    input.transcript || "(empty)",
    input.activityTail ? `\n\nRecent activity log:\n${input.activityTail}` : "",
    "\n\nPropose durable improvements (or none).",
  ].join("\n");

  let text = "";
  for await (const e of provider.stream({
    model,
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
    stream: true,
    maxTokens: 2048,
    signal: input.signal,
  })) {
    if (e.type === "text_delta") text += e.delta;
  }

  const json = extractJsonObject(text);
  if (json === null) return []; // the model declined / returned prose
  const parsed = ProposalsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`self-improvement analysis was malformed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data.proposals;
}

/** Drop proposals that would duplicate an existing skill, and any obvious repeats. */
export function dedupeProposals(proposals: Proposal[], existingSkillNames: string[]): Proposal[] {
  const have = new Set(existingSkillNames.map((n) => n.toLowerCase()));
  const seen = new Set<string>();
  const out: Proposal[] = [];
  for (const p of proposals) {
    const key = `${p.kind}:${safeSkillName(p.name)}`;
    if (seen.has(key)) continue;
    if (p.kind === "skill" && have.has(safeSkillName(p.name))) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export interface AppliedArtifact {
  kind: Proposal["kind"];
  path: string;
}

const RULES_HEADING = "## Learned rules (freecode self-improvement)";

/** Write an accepted proposal to disk: a skill file, or a rule appended to
 *  FREECODE.md. Returns where it landed. Throws if a skill of that name exists. */
export function applyProposal(p: Proposal, cwd: string): AppliedArtifact {
  if (p.kind === "skill") {
    const dir = join(cwd, ".freecode", "skills");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${safeSkillName(p.name)}.md`);
    if (existsSync(file)) throw new Error(`a skill named "${safeSkillName(p.name)}" already exists`);
    writeFileSync(file, `---\ndescription: ${p.description}\n---\n${p.body.trim()}\n`);
    return { kind: "skill", path: file };
  }
  // rule → append to FREECODE.md under a stable heading (create the file/heading if needed)
  const file = join(cwd, "FREECODE.md");
  let content = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!content.includes(RULES_HEADING)) {
    content = content.trimEnd() + (content.trim() ? "\n\n" : "") + RULES_HEADING + "\n";
  }
  content = content.trimEnd() + `\n- ${p.body.trim()}  <!-- ${p.description} -->\n`;
  writeFileSync(file, content);
  return { kind: "rule", path: file };
}
