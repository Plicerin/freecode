// Translate the Unix commands weak/local models reflexively emit into PowerShell
// equivalents, so their muscle memory WORKS on Windows instead of erroring ("grep
// is not recognized") and burning turns on retries. This is a DETERMINISTIC rewrite
// (same spirit as the `2>/dev/null` → `$null` rewrite), not a heuristic nudge.
//
// Conservative by design: only well-understood command shapes are rewritten. Any
// flag or form we can't map faithfully makes the translator return the command
// UNCHANGED — a clear failure beats silently wrong output. Disable entirely with
// FREECODE_NO_CMD_TRANSLATE=1.
//
// Commands covered: grep → Select-String, head/tail → Get-Content -TotalCount/-Tail
// (or Select-Object in a pipe), which → Get-Command, ls → Get-ChildItem. Others
// (cat/rm/cp/mv/pwd/echo/sort/…) are already PowerShell aliases, so their common
// forms run as-is and we leave them alone.
import { getEnv } from "../utils/env";

/** Single-quote a value for PowerShell (literal — no $ interpolation, no globbing). */
function psq(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/** Quote a path arg only when it contains whitespace; otherwise leave it raw so
 *  wildcards (`*.ts`) still expand. */
function quotePath(s: string): string {
  return /\s/.test(s) ? '"' + s.replace(/"/g, '`"') + '"' : s;
}

/** Split a command line at TOP-LEVEL shell operators (| || && ;), preserving the
 *  operators, so we can translate each segment and rejoin exactly. Quote-aware. */
function splitTopLevel(cmd: string): Array<{ text: string; sep: string }> {
  const out: Array<{ text: string; sep: string }> = [];
  let buf = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) { buf += c; if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; buf += c; continue; }
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||") { out.push({ text: buf, sep: two }); buf = ""; i++; continue; }
    if (c === "|" || c === ";") { out.push({ text: buf, sep: c }); buf = ""; continue; }
    buf += c;
  }
  out.push({ text: buf, sep: "" });
  return out;
}

/** Peel a trailing redirection (`2>/dev/null`, `> out`, `<in`, `2>&1`, …) off the
 *  args so it isn't parsed as a command operand; it's re-appended after translation. */
function splitRedir(rest: string): { args: string; redir: string } {
  let quote: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "<" || c === ">") {
      let start = i;
      while (start > 0 && /\d/.test(rest[start - 1]!)) start--; // include leading fd digits (2>)
      if (start > 0 && rest[start - 1] === "&") start--;        // include &>
      return { args: rest.slice(0, start), redir: rest.slice(start) };
    }
  }
  return { args: rest, redir: "" };
}

/** Whitespace-split respecting simple quotes (quotes are stripped from the token). */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** grep [flags] PATTERN [paths…] → Select-String. Returns null (passthrough) on any
 *  flag/shape we can't map faithfully. */
function grepToSelectString(rest: string, piped: boolean): string | null {
  const { args, redir } = splitRedir(rest);
  const tokens = tokenize(args);
  let i = false, recursive = false, invert = false, word = false, fixed = false, list = false;
  let pattern: string | null = null;
  const paths: string[] = [];
  let expectPattern = false; // after -e
  let operandsOnly = false;
  for (const t of tokens) {
    if (expectPattern) { if (pattern === null) pattern = t; expectPattern = false; continue; }
    if (!operandsOnly && t === "--") { operandsOnly = true; continue; }
    if (!operandsOnly && t.startsWith("--")) {
      const [name, val] = t.slice(2).split("=", 2);
      switch (name) {
        case "ignore-case": i = true; break;
        case "recursive": recursive = true; break;
        case "invert-match": invert = true; break;
        case "word-regexp": word = true; break;
        case "fixed-strings": fixed = true; break;
        case "files-with-matches": list = true; break;
        case "regexp": if (val !== undefined) pattern = val; else expectPattern = true; break;
        case "extended-regexp": case "basic-regexp": case "line-number": case "no-filename":
        case "with-filename": case "color": case "colour": break; // harmless to ignore
        default: return null; // unknown long flag → don't risk a wrong rewrite
      }
    } else if (!operandsOnly && t.length > 1 && t[0] === "-") {
      for (const ch of t.slice(1)) {
        if (ch === "i") i = true;
        else if (ch === "r" || ch === "R") recursive = true;
        else if (ch === "v") invert = true;
        else if (ch === "w") word = true;
        else if (ch === "F") fixed = true;
        else if (ch === "l") list = true;
        else if (ch === "n" || ch === "H" || ch === "h" || ch === "E" || ch === "G" || ch === "s") { /* ignorable */ }
        else if (ch === "e") { expectPattern = true; break; }
        else return null; // unknown short flag (e.g. -c, -o, -A/-B/-C) → passthrough
      }
    } else {
      if (pattern === null) pattern = t;
      else paths.push(t);
    }
  }
  if (pattern === null) return null;

  const patText = word && !fixed ? `\\b${pattern}\\b` : pattern;
  let ss = `Select-String -Pattern ${psq(patText)}`;
  if (fixed) ss += " -SimpleMatch";
  if (!i) ss += " -CaseSensitive"; // grep is case-SENSITIVE by default; Select-String is not
  if (invert) ss += " -NotMatch";

  let cmd: string;
  if (recursive) {
    const scope = paths.length ? paths.map(quotePath).join(" ") : ".";
    cmd = `Get-ChildItem -Recurse -File ${scope} | ${ss}`;
  } else if (paths.length) {
    cmd = `${ss} -Path ${paths.map(quotePath).join(",")}`;
  } else if (piped) {
    cmd = ss; // reads pipeline input
  } else {
    return null; // grep with no file and no pipe would read stdin — can't map
  }
  if (list) cmd += " | Select-Object -ExpandProperty Path -Unique";
  return redir ? `${cmd} ${redir.trim()}` : cmd;
}

/** head/tail → Get-Content -TotalCount/-Tail (files) or Select-Object (in a pipe). */
function headTail(kind: "head" | "tail", rest: string, piped: boolean): string | null {
  const { args, redir } = splitRedir(rest);
  const tokens = tokenize(args);
  let n = 10;
  const files: string[] = [];
  let expectN = false;
  for (const t of tokens) {
    if (expectN) { const v = Number.parseInt(t, 10); if (Number.isFinite(v)) n = v; expectN = false; continue; }
    if (t === "-n") { expectN = true; continue; }
    const m = /^-(\d+)$/.exec(t) ?? /^-n(\d+)$/.exec(t);
    if (m) { n = Number.parseInt(m[1]!, 10); continue; }
    if (t.startsWith("-")) return null; // -f (follow), -c (bytes), … → passthrough
    files.push(t);
  }
  let cmd: string;
  if (files.length) {
    const flag = kind === "head" ? `-TotalCount ${n}` : `-Tail ${n}`;
    cmd = `Get-Content ${files.map(quotePath).join(",")} ${flag}`;
  } else if (piped) {
    cmd = kind === "head" ? `Select-Object -First ${n}` : `Select-Object -Last ${n}`;
  } else {
    return null;
  }
  return redir ? `${cmd} ${redir.trim()}` : cmd;
}

/** which NAME… → Get-Command …, printing the resolved path (Unix `which` semantics). */
function whichToGetCommand(rest: string): string | null {
  const { args, redir } = splitRedir(rest);
  const names = tokenize(args).filter((t) => !t.startsWith("-"));
  if (!names.length) return null;
  const cmd = `Get-Command ${names.map(quotePath).join(",")} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source`;
  return redir ? `${cmd} ${redir.trim()}` : cmd;
}

/** ls [flags] [paths] → Get-ChildItem (maps -a→-Force, -R→-Recurse; ignores -l/-h/…). */
function lsToGetChildItem(rest: string): string | null {
  const { args, redir } = splitRedir(rest);
  const tokens = tokenize(args);
  let force = false, recurse = false;
  const paths: string[] = [];
  for (const t of tokens) {
    if (t.startsWith("--")) {
      const name = t.slice(2);
      if (name === "all") force = true;
      else if (name === "recursive") recurse = true;
      else if (name === "color" || name === "colour" || name.startsWith("color=") || name.startsWith("colour=")) { /* ignore */ }
      else return null;
    } else if (t.length > 1 && t[0] === "-") {
      for (const ch of t.slice(1)) {
        if (ch === "a" || ch === "A") force = true;
        else if (ch === "R") recurse = true;
        else if ("lhtrSFG1cd".includes(ch)) { /* ignorable listing flags */ }
        else return null;
      }
    } else paths.push(t);
  }
  let cmd = "Get-ChildItem";
  if (force) cmd += " -Force";
  if (recurse) cmd += " -Recurse";
  if (paths.length) cmd += " " + paths.map(quotePath).join(",");
  return redir ? `${cmd} ${redir.trim()}` : cmd;
}

/** Translate one segment's leading command; null = leave the segment unchanged. */
function translateSegment(text: string, piped: boolean): string | null {
  const m = /^(\s*)(\S+)(.*)$/.exec(text);
  if (!m) return null;
  const [, indent, cmd, rawRest] = m;
  const rest = (rawRest ?? "").trim();
  // Preserve the segment's own trailing whitespace so the join around a shell
  // operator (`ls | head`, `a && b`) keeps its spacing.
  const trail = /\s*$/.exec(text)![0];
  let translated: string | null = null;
  switch (cmd) {
    case "grep": translated = grepToSelectString(rest, piped); break;
    case "egrep": translated = grepToSelectString("-E " + rest, piped); break;
    case "fgrep": translated = grepToSelectString("-F " + rest, piped); break;
    case "head": translated = headTail("head", rest, piped); break;
    case "tail": translated = headTail("tail", rest, piped); break;
    case "which": translated = whichToGetCommand(rest); break;
    case "ls": translated = lsToGetChildItem(rest); break;
    default: return null;
  }
  return translated === null ? null : `${indent ?? ""}${translated}${trail}`;
}

/** Rewrite the Unix commands in a shell command line to PowerShell equivalents,
 *  segment by segment. Untouched when FREECODE_NO_CMD_TRANSLATE is set. */
export function translateUnixCommand(command: string): string {
  if (!command || getEnv("FREECODE_NO_CMD_TRANSLATE")) return command;
  const segs = splitTopLevel(command);
  let prevSep = "";
  let out = "";
  for (const s of segs) {
    const piped = prevSep === "|";
    const t = translateSegment(s.text, piped);
    out += (t ?? s.text) + s.sep;
    prevSep = s.sep;
  }
  return out;
}
