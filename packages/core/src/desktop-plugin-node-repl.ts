import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { type ConfigObject, configObject } from "./config-toml.js";
import { declaredPath } from "./desktop-plugin-files.js";

interface BrowserPackage {
  readonly enabled: boolean;
  readonly root: string | null;
}

// Desktop derives this service from its installed Browser cache, while the
// catalogue may intentionally resolve the current declared source instead.
export async function adaptNodeReplBrowserService(
  raw: ConfigObject,
  codexHome: string,
  browser: BrowserPackage | undefined
): Promise<ConfigObject> {
  if (!configObject(raw.env) || raw.env.NODE_REPL_TRUSTED_SERVICES === undefined) return raw;
  if (typeof raw.env.NODE_REPL_TRUSTED_SERVICES !== "string")
    throw new Error("Invalid NodeRepl trusted services JSON");
  let services: unknown;
  try {
    services = JSON.parse(raw.env.NODE_REPL_TRUSTED_SERVICES);
  } catch {
    throw new Error("Invalid NodeRepl trusted services JSON");
  }
  if (!configObject(services)) throw new Error("Invalid NodeRepl trusted services JSON");
  if (typeof services.browser !== "string" || !isAbsolute(services.browser)) return raw;
  const cache = join(codexHome, "plugins", "cache", "openai-bundled", "browser");
  const parts = relative(cache, services.browser).split(sep);
  const cached =
    parts.length === 3 &&
    /^[a-zA-Z0-9_.+-]+$/.test(parts[0]) &&
    parts[0] !== "." &&
    parts[0] !== ".." &&
    parts[1] === "scripts" &&
    parts[2] === "browser-service.mjs";
  const selected =
    browser?.root && services.browser === join(browser.root, "scripts", "browser-service.mjs");
  if (!cached && !selected) return raw;
  const updated = { ...services };
  if (!browser?.enabled) delete updated.browser;
  else {
    if (!browser.root)
      throw new Error("Enabled Browser plugin package is unavailable for NodeRepl");
    try {
      const service = await declaredPath(browser.root, "scripts/browser-service.mjs");
      if (!(await stat(service)).isFile()) throw new Error("Not a file");
      updated.browser = service;
    } catch {
      throw new Error(
        "Enabled Browser plugin requires a contained scripts/browser-service.mjs file for NodeRepl"
      );
    }
  }
  return { ...raw, env: { ...raw.env, NODE_REPL_TRUSTED_SERVICES: JSON.stringify(updated) } };
}
