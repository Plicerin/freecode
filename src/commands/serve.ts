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
 * placeholder that binds the port so `freecode serve` is a real, observable
 * process. Replace with @grpc/grpc-js + proto-loader in the next pass.
 */
export async function startServer(opts: ServeOptions): Promise<GrpcLikeServer> {
  const httpServer: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "freecode", status: "ok", transport: "http", grpc: false }));
  });
  await new Promise<void>((resolve) => httpServer.listen(opts.port, resolve));
  debug.log(`freecode HTTP placeholder listening on :${opts.port}`);
  console.error(`[freecode] experimental HTTP health placeholder listening on :${opts.port} (gRPC not implemented)`);
  return {
    port: opts.port,
    start: async () => {},
    stop: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
