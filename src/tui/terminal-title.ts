// Set the terminal tab/window title via the OSC 0 escape sequence
// (ESC ] 0 ; <title> BEL). The control bytes are built with String.fromCharCode
// so this source file contains no literal control characters. The title is
// sanitised + length-capped (a stray control char or runaway name can't corrupt
// the tab); the build is pure (testable) and the write is TTY-guarded so piped
// output never receives escape codes.

const ESC = String.fromCharCode(27); // \x1b
const BEL = String.fromCharCode(7); // \x07
const DEL = String.fromCharCode(127); // \x7f

/** Clean a title: drop control chars (incl. an ESC/BEL that could break out), cap. */
function clean(title: string): string {
  return [...title].filter((c) => c >= " " && c !== DEL).join("").slice(0, 60);
}

/** OSC 0 sets both the icon name and the window/tab title. */
export function titleSequence(title: string): string {
  return `${ESC}]0;${clean(title)}${BEL}`;
}

export function setTerminalTitle(title: string, out: NodeJS.WriteStream = process.stdout): void {
  if (out.isTTY === false) return; // skip only when definitely piped; undefined → still try
  const c = clean(title);
  // Emit OSC 2 (window title) AND OSC 0 — some terminals/tabs honour one not the other.
  out.write(`${ESC}]2;${c}${BEL}${ESC}]0;${c}${BEL}`);
}
