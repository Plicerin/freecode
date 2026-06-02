import { Vault } from "../config/vault";

function fail(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

/** Read a line from stdin without echoing it (for passphrases / keys). */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void };
    stdin.setRawMode?.(true);
    stdin.resume();
    let buf = "";
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(buf);
          return;
        } else if (ch === "\x7f" || ch === "\x08") {
          buf = buf.slice(0, -1);
        } else if (ch === "\x03") {
          process.stdout.write("\n");
          process.exit(130); // Ctrl-C
        } else if (ch >= " ") {
          buf += ch;
        }
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
