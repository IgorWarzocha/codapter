import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [backend, ...args] = process.argv.slice(2);
if (backend !== "codapter" && backend !== "codex") {
  throw new Error("Usage: launch-desktop.mjs <codapter|codex> [desktop arguments]");
}

const root = fileURLToPath(new URL("../", import.meta.url));
const target =
  backend === "codapter"
    ? join(root, "dist", "codapter.mjs")
    : process.env.CODAPTER_CODEX_COMMAND || "codex";
if (backend === "codapter") {
  try {
    await access(target, constants.X_OK);
  } catch {
    throw new Error("Build Codapter first with npm run build:dist");
  }
}

let desktop = process.env.CODAPTER_DESKTOP_COMMAND;
if (!desktop && process.platform === "darwin") {
  for (const candidate of [
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    "/Applications/Codex.app/Contents/MacOS/Codex",
  ]) {
    try {
      await access(candidate, constants.X_OK);
      desktop = candidate;
      break;
    } catch {
      /* Try the other supported desktop bundle. */
    }
  }
}
desktop ??= "chatgpt";

const logDir = join(
  process.env.XDG_RUNTIME_DIR || tmpdir(),
  `codapter-${process.getuid?.() ?? "user"}`
);
await mkdir(logDir, { recursive: true, mode: 0o700 });
const logPath = process.env.TAP_LOG || join(logDir, `${backend}-stdio.log`);
const child = spawn(desktop, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    CODEX_CLI_PATH: join(root, "scripts", "stdio-tap.mjs"),
    CODEX_APP_SERVER_FORCE_CLI: "1",
    TAP_TARGET: target,
    TAP_LOG: logPath,
  },
});
console.error(`[codapter] ${desktop} using ${target}. Traffic log: ${logPath}`);
child.on("error", (error) => {
  console.error(`[codapter] Could not launch ${desktop}: ${error.message}`);
  process.exitCode = 1;
});
const interrupt = () => child.kill("SIGINT");
const terminate = () => child.kill("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
child.on("close", (code, signal) => {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
});
