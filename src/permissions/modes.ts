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

  const key = (r: ApprovalRequest) => `${r.tool}::${r.argsSummary}`;

  return {
    mode,
    async decide(req, cb) {
      if (mode === "bypass") return "allow";
      if (denied.has(key(req))) return "deny";
      if (mode === "auto") {
        if (SAFE_TOOLS.has(req.tool)) return "allow";
        return await cb(req);
      }
      // manual
      return await cb(req);
    },
    rememberDenied(req) {
      denied.add(key(req));
    },
    isDenied(req) {
      return denied.has(key(req));
    },
  };
}
