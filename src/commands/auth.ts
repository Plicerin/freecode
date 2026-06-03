import { Vault } from "../config/vault";

function fail(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// Pure input reducer for the hidden key prompt (unit-tested). Given the buffer
// so far and a raw stdin chunk, returns the new buffer, whether Enter ended the
// line, and the bytes to echo (asterisks for accepted chars, "\b \b" to rub out
// a backspaced one). Strips bracketed-paste wrappers (␛[200~ … ␛[201~) and other
// escape/control sequences so a pasted key isn't stored with terminal cruft.
export function applyHiddenInput(buf: string, chunk: string): { buf: string; submit: boolean; echo: string } {
  let part = chunk;
  let submit = false;
  const nl = part.search(/[\r\n]/);
  if (nl >= 0) {
    part = part.slice(0, nl);
    submit = true;
  }
  const cleaned = part
    .replace(/\x1b\[[0-9;]*[~A-Za-z]/g, "") // CSI sequences: paste markers, arrows, etc.
    .replace(/\[20[01]~/g, "") // bracketed-paste wrappers if the ESC was already swallowed
    .replace(/\x1b/g, ""); // stray ESC
  let out = buf;
  let echo = "";
  for (const ch of cleaned) {
    if (ch === "\x7f" || ch === "\x08") {
      if (out.length) {
        out = out.slice(0, -1);
        echo += "\b \b";
      }
    } else if (ch >= " ") {
      out += ch;
      echo += "*";
    }
  }
  return { buf: out, submit, echo };
}

/** Read a key from stdin, masking it with asterisks (for keys / passphrases). */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void };
    stdin.setRawMode?.(true);
    stdin.resume();
    let buf = "";
    const onData = (chunk: Buffer): void => {
      const raw = chunk.toString("utf8");
      if (raw.includes("\x03")) {
        process.stdout.write("\n");
        process.exit(130); // Ctrl-C
      }
      const res = applyHiddenInput(buf, raw);
      buf = res.buf;
      if (res.echo) process.stdout.write(res.echo);
      if (res.submit) {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.off("data", onData);
        process.stdout.write("\n");
        resolve(buf);
      }
    };
    stdin.on("data", onData);
  });
}

function open(): Vault {
  try {
    return Vault.load();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/** `freecode auth <set|list|remove> [provider]` */
export async function runAuth(args: string[]): Promise<void> {
  const [action, provider] = args;
  switch (action) {
    case "set":
    case "add": {
      if (!provider) fail("Usage: freecode auth set <provider>");
      const vault = open();
      const key = await promptHidden(`Paste the API key for ${provider}: `);
      if (!key.trim()) fail("No key entered.");
      vault.set(provider, key.trim());
      process.stdout.write(`✓ Stored ${provider} key in the vault. You won't need to enter it again.\n`);
      break;
    }
    case "list":
    case "ls": {
      const vault = open();
      const list = vault.list();
      process.stdout.write(list.length ? `Stored providers:\n${list.map((p) => `  ${p}`).join("\n")}\n` : "Vault is empty.\n");
      break;
    }
    case "remove":
    case "rm": {
      if (!provider) fail("Usage: freecode auth remove <provider>");
      const vault = open();
      process.stdout.write(vault.remove(provider) ? `✓ Removed ${provider}.\n` : `No ${provider} key stored.\n`);
      break;
    }
    case "onboard":
    case "setup": {
      const { runOnboarding } = await import("./onboarding");
      await runOnboarding();
      break;
    }
    default:
      process.stdout.write("Usage: freecode auth <set|list|remove|onboard> [provider]\nKeys are stored encrypted in ~/.freecode/vault.json (auto-unlocks via ~/.freecode/vault.key).\n");
  }
}
