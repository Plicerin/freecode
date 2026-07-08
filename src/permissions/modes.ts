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

export function createPermissionEngine(mode: PermissionMode, _prompt?: ApprovalCallback): PermissionEngine {
  const denied = new Set<string>();
  const allowedTools = new Set<string>(); // "allow always" grants — must live for the whole session

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
