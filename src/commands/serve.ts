import { createServer, type Server } from "node:http";
import { debug } from "../utils/debug";

export interface ServeOptions {
  port: number;
}

export interface GrpcLikeServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  port: number;
}

/**
 * Minimal headless server scaffold.
 * Full gRPC integration (proto loader, bidirectional stream, approval events) is
 * out of scope for the first pass — this is a running, log-emitting HTTP/2
 * placeholder that binds the port so `openclaude serve` is a real, observable
 * process. Replace with @grpc/grpc-js + proto-loader in the next pass.
 */
export async function startServer(opts: ServeOptions): Promise<GrpcLikeServer> {
  const httpServer: Server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "openclaude", status: "ok", grpc: true }));
  });
  await new Promise<void>((resolve) => httpServer.listen(opts.port, resolve));
  debug.log(`openclaude grpc placeholder listening on :${opts.port}`);
  console.error(`[openclaude] grpc placeholder listening on :${opts.port} (proto loader pending)`);
  return {
    port: opts.port,
    start: async () => {},
    stop: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
