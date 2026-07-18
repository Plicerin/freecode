import { spawn } from "node:child_process";
import { VERSION } from "../version";
import { isSourceRun, PACKAGE_NAME } from "../agent/update-check";

/**
 * `freecode update` — upgrade the global npm install in place. For a source
 * checkout it's a no-op with guidance (those update with `git pull`, and running
 * `npm i -g` there would install a SECOND freecode that shadows the clone — the
 * exact confusion this whole change removes).
 */
export async function runUpdate(): Promise<number> {
  if (isSourceRun()) {
    console.log(`freecode ${VERSION} is running from a source checkout, not the npm package.`);
    console.log(`Update it with:   git pull        (in the freecode repo dir)`);
    console.log(`Or switch to the published package: npm i -g ${PACKAGE_NAME}@latest`);
    return 0;
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  console.log(`Updating ${PACKAGE_NAME} to the latest published version…`);
  return await new Promise<number>((resolve) => {
    const child = spawn(npm, ["install", "-g", `${PACKAGE_NAME}@latest`], { stdio: "inherit" });
    child.on("error", (e) => {
      console.error(`Could not run npm (${e.message}). Try manually:  npm i -g ${PACKAGE_NAME}@latest`);
      resolve(1);
    });
    child.on("close", (code) => {
      if (code === 0) console.log(`Done — restart freecode to load the new version.`);
      else console.error(`npm exited with code ${code}. Try:  npm i -g ${PACKAGE_NAME}@latest`);
      resolve(code ?? 1);
    });
  });
}
