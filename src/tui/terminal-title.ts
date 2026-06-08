// Set the terminal tab/window title via the OSC 0 escape sequence
// (ESC ] 0 ; <title> BEL). The control bytes are built with String.fromCharCode
// so this source file contains no literal control characters. The title is
// sanitised + length-capped (a stray control char or runaway name can't corrupt
// the tab); the build is pure (testable) and the write is TTY-guarded so piped
// output never receives escape codes.

const ESC = String.fromCharCode(27); // \x1b
const BEL = String.fromCharCode(7); // \x07
const DEL = String.fromCharCode(127); // \x7f

export function titleSequence(title: string): string {
  // Drop any control char (incl. an embedded ESC/BEL that could break the seq).
  const clean = [...title].filter((c) => c >= " " && c !== DEL).join("").slice(0, 60);
  return `${ESC}]0;${clean}${BEL}`;
}

export function setTerminalTitle(title: string, out: NodeJS.WriteStream = process.stdout): void {
  if (!out.isTTY) return;
  out.write(titleSequence(title));
}
