// The localhost leg of the OAuth flow: after the user approves in the browser,
// OpenAI redirects to http://localhost:<port>/auth/callback?code=…&state=…. We
// run a one-shot HTTP server to catch that single request, validate the state
// (CSRF), hand back the code, and show the user a "you can close this tab" page.
//
// The query parsing + state check is pure (testable); the server/browser bits are
// thin runtime wrappers.
import { createServer } from "node:http";
import { spawn } from "node:child_process";

export interface CallbackResult {
  code?: string;
  error?: string;
}

/** Validate the redirect's query against the state we sent. Pure. */
export function parseCallbackQuery(rawUrl: string, expectedState: string): CallbackResult {
  let params: URLSearchParams;
  try {
    params = new URL(rawUrl, "http://localhost").searchParams;
  } catch {
    return { error: "malformed callback URL" };
  }
  const err = params.get("error");
  if (err) return { error: params.get("error_description") || err };
  const state = params.get("state");
  if (!state || state !== expectedState) return { error: "state mismatch — possible CSRF, aborting" };
  const code = params.get("code");
  if (!code) return { error: "no authorization code in callback" };
  return { code };
}

const SUCCESS_HTML =
  "<!doctype html><meta charset=utf-8><title>freecode</title>" +
  "<body style=\"font-family:system-ui;background:#0b0e14;color:#9ed0ff;display:grid;place-items:center;height:100vh;margin:0\">" +
  "<div style=\"text-align:center\"><h1>✓ Signed in</h1><p style=\"color:#5f7194\">You can close this tab and return to freecode.</p></div>";

/** Run a one-shot server on `port`, resolve with the validated code (or reject on
 *  error/timeout). Only the path `/auth/callback` is honoured. */
export function waitForCallback(opts: { port: number; expectedState: string; timeoutMs?: number }): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url || !req.url.startsWith("/auth/callback")) {
        res.writeHead(404).end();
        return;
      }
      const result = parseCallbackQuery(req.url, opts.expectedState);
      const ok = !!result.code;
      res.writeHead(ok ? 200 : 400, { "content-type": "text/html" });
      res.end(ok ? SUCCESS_HTML : `<!doctype html><p>Login failed: ${result.error}</p>`);
      server.close();
      clearTimeout(timer);
      if (ok) resolve(result.code!);
      else reject(new Error(result.error ?? "login failed"));
    });
    server.on("error", (e) => { clearTimeout(timer); reject(e); });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("login timed out — no browser redirect within the window"));
    }, opts.timeoutMs ?? 300_000);
    server.listen(opts.port, "127.0.0.1");
  });
}

/** The command to open a URL in the default browser, per platform. Pure so the
 *  Windows case is regression-tested: it must NOT route through `cmd`, whose
 *  `start` treats '&' as a command separator and truncates an OAuth URL at the
 *  first '&' (dropping client_id et al). rundll32 passes the URL verbatim. */
export function browserOpenCommand(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === "win32") return { cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { cmd: "open", args: [url] };
  return { cmd: "xdg-open", args: [url] };
}

/** Best-effort open the URL in the user's default browser, cross-platform. */
export function openBrowser(url: string): void {
  const { cmd, args } = browserOpenCommand(process.platform, url);
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* caller prints the URL as a fallback */
  }
}
