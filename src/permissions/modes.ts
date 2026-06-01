import type { PermissionMode } from "../config/schema";

export type ApprovalDecision = "allow" | "deny" | "allow-always";

export interface ApprovalRequest {
  tool: string;
  argsSummary: string;
  reason?: string;
}

export type ApprovalCallback = (req: ApprovalRequest) => Promise<ApprovalDecision> | ApprovalDecision;

export interface PermissionEngine {
  mode: PermissionMode;
  decide(req: ApprovalRequest, prompt: ApprovalCallback): Promise<ApprovalDecision>;
  rememberDenied(req: ApprovalRequest): void;
  isDenied(req: ApprovalRequest): boolean;
}

const SAFE_TOOLS = new Set(["FileRead", "Glob", "Grep", "WebSearch", "WebFetch"]);

export function createPermissionEngine(mode: PermissionMode, prompt: ApprovalCallback): PermissionEngine {
  const denied = new Set<string>();
  const allowedTools = new Set<string>();

  const key = (r: ApprovalRequest) => `${r.tool}::${r.argsSummary}`;

  return {
    mode,
    async decide(req, cb) {
      if (mode === "bypass") return "allow";
      if (denied.has(key(req))) return "deny";
      if (allowedTools.has(req.tool)) return "allow";
      if (mode === "auto" && SAFE_TOOLS.has(req.tool)) return "allow";
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
