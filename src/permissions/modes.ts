import type { PermissionMode } from "../config/schema";

export type ApprovalDecision = "allow" | "deny" | "allow-always";

export interface ApprovalRequest {
  tool: string;
  argsSummary: string;
  reason?: string;
}

export type ApprovalCallback = (req: ApprovalRequest) => Promise<ApprovalDecision> | ApprovalDecision;

export interface PermissionEngine {
  readonly mode: PermissionMode;
  /** Change the mode WITHOUT losing remembered grants/denials — so switching
   *  provider/model (which re-resolves config) never forgets your approvals. */
  setMode(mode: PermissionMode): void;
  decide(req: ApprovalRequest, prompt: ApprovalCallback): Promise<ApprovalDecision>;
  rememberDenied(req: ApprovalRequest): void;
  isDenied(req: ApprovalRequest): boolean;
}

/** Optional persistence for "allow always" grants so they survive a relaunch —
 *  in-memory grants reset every launch, which reads as "permissions don't stick".
 *  load() returns previously-persisted tool names for the current scope (e.g. this
 *  project folder); persist() is called when a new allow-always grant is made. The
 *  store decides which tools are eligible to persist (e.g. never Bash). */
export interface GrantStore {
  load(): string[];
  persist(tool: string): void;
}

const SAFE_TOOLS = new Set(["FileRead", "Glob", "Grep", "WebSearch", "WebFetch"]);

/** Map an approval keypress to a decision. Convention (matches other CLIs):
 *  y = yes (allow once), a = always (allow this tool from now on), n/d/esc = deny.
 *  Returns null for any other key so the handler ignores it. */
export function approvalDecisionForKey(input: string | undefined, escape: boolean): ApprovalDecision | null {
  const k = input?.trim().toLowerCase();
  if (k === "y") return "allow";
  if (k === "a") return "allow-always";
  if (k === "n" || k === "d" || escape) return "deny";
  return null;
}

export function createPermissionEngine(mode: PermissionMode, opts?: { grants?: GrantStore }): PermissionEngine {
  const denied = new Set<string>();
  const allowedTools = new Set<string>(); // "allow always" grants — live for the whole session
  const grants = opts?.grants;
  // Restore grants persisted in a prior session for this scope (per-project), so
  // "allow always" survives a relaunch instead of resetting every launch.
  if (grants) for (const t of grants.load()) allowedTools.add(t);

  const key = (r: ApprovalRequest) => `${r.tool}::${r.argsSummary}`;
  let currentMode = mode;

  return {
    get mode() {
      return currentMode;
    },
    setMode(m) {
      currentMode = m;
    },
    async decide(req, cb) {
      if (currentMode === "bypass") return "allow";
      if (denied.has(key(req))) return "deny";
      if (allowedTools.has(req.tool)) return "allow";
      if (currentMode === "auto" && SAFE_TOOLS.has(req.tool)) return "allow";
      // manual mode, or auto mode with a non-safe tool: ask the user.
      const decision = await cb(req);
      if (decision === "allow-always") {
        allowedTools.add(req.tool);
        grants?.persist(req.tool); // survive a relaunch (the store excludes e.g. Bash)
        return "allow";
      }
      return decision;
    },
    rememberDenied(req) {
      denied.add(key(req));
    },
    isDenied(req) {
      return denied.has(key(req));
    },
  };
}
