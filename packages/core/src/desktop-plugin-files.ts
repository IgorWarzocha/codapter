import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ConfigObject, configObject } from "./config-toml.js";

export interface DesktopPluginSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly pluginId: string;
}

export interface DesktopPluginPackage {
  readonly root: string;
  readonly manifest: ConfigObject;
  readonly skills: readonly DesktopPluginSkill[];
  readonly mcpServers: ConfigObject;
  readonly apps: readonly ConfigObject[];
}

export async function optionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function jsonObjectFile(path: string): Promise<ConfigObject | null> {
  const text = await optionalText(path);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON file: ${path}`);
  }
  if (!configObject(value)) throw new Error(`Expected JSON object: ${path}`);
  return value;
}

export function pluginSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`Invalid plugin identifier: ${value}`);
  return value;
}

async function containedPath(root: string, path: string): Promise<string> {
  const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(path)]);
  const offset = relative(canonicalRoot, canonicalPath);
  if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new Error(`Plugin declaration escapes package root: ${path}`);
  }
  return canonicalPath;
}

export async function declaredPath(root: string, path: string): Promise<string> {
  return containedPath(root, resolve(root, path));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function frontmatterValue(frontmatter: string, key: string): string | null {
  const lines = frontmatter.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index < 0) return null;
  const scalar = lines[index].slice(key.length + 1).trim();
  if (/^[|>][-+]?$/.test(scalar) || scalar === "") {
    const content: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (line && !/^\s/.test(line)) break;
      content.push(line.trim());
    }
    return content.join(scalar.startsWith("|") ? "\n" : " ").trim();
  }
  if (scalar.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(scalar);
      return typeof value === "string" ? value : null;
    } catch {
      throw new Error(`Invalid skill ${key} quoted value`);
    }
  }
  return scalar.startsWith("'") && scalar.endsWith("'")
    ? scalar.slice(1, -1).replaceAll("''", "'")
    : scalar;
}

async function skillFile(
  root: string,
  path: string,
  pluginId: string
): Promise<DesktopPluginSkill> {
  const canonical = await containedPath(root, path);
  const contents = await readFile(canonical, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
  if (!match) throw new Error(`Missing skill frontmatter: ${canonical}`);
  const name = frontmatterValue(match[1], "name");
  const description = frontmatterValue(match[1], "description");
  if (!name || !description) throw new Error(`Missing skill name or description: ${canonical}`);
  return { name, description, path: canonical, pluginId };
}

async function collectSkills(
  root: string,
  path: string,
  pluginId: string
): Promise<DesktopPluginSkill[]> {
  const canonical = await containedPath(root, path);
  const info = await stat(canonical);
  if (info.isFile()) {
    if (basename(canonical) !== "SKILL.md")
      throw new Error(`Skill declaration must name SKILL.md: ${canonical}`);
    return [await skillFile(root, canonical, pluginId)];
  }
  if (!info.isDirectory()) throw new Error(`Invalid skill directory: ${canonical}`);
  const direct = join(canonical, "SKILL.md");
  if (await exists(direct)) return [await skillFile(root, direct, pluginId)];
  const result: DesktopPluginSkill[] = [];
  for (const child of (await readdir(canonical, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (!child.isDirectory() && !child.isSymbolicLink()) continue;
    const skill = join(canonical, child.name, "SKILL.md");
    if (await exists(skill)) result.push(await skillFile(root, skill, pluginId));
  }
  return result;
}

function paths(value: unknown, fallback: string): string[] {
  if (value === undefined) return [fallback];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  throw new Error("Plugin paths must be strings or arrays of strings");
}

export async function loadPluginPackage(
  root: string,
  pluginId: string
): Promise<DesktopPluginPackage | null> {
  const manifestPath = join(root, ".codex-plugin", "plugin.json");
  if (!(await exists(manifestPath))) return null;
  const manifest = await jsonObjectFile(await containedPath(root, manifestPath));
  if (!manifest) return null;
  if (manifest.version !== undefined && typeof manifest.version !== "string")
    throw new Error(`Invalid plugin version: ${pluginId}`);
  if (
    typeof manifest.name !== "string" ||
    `${manifest.name}@` !== pluginId.slice(0, pluginId.indexOf("@") + 1)
  ) {
    throw new Error(`Plugin manifest name does not match ${pluginId}`);
  }
  const skills: DesktopPluginSkill[] = [];
  for (const path of paths(manifest.skills, "skills")) {
    const absolute = resolve(root, path);
    try {
      skills.push(...(await collectSkills(root, absolute, pluginId)));
    } catch (error) {
      if (manifest.skills === undefined && (error as NodeJS.ErrnoException).code === "ENOENT")
        continue;
      throw error;
    }
  }
  let mcpServers: ConfigObject = {};
  if (configObject(manifest.mcpServers)) mcpServers = manifest.mcpServers;
  else {
    for (const path of paths(manifest.mcpServers, ".mcp.json")) {
      if (!(await exists(resolve(root, path))) && manifest.mcpServers === undefined) continue;
      const descriptor = await jsonObjectFile(await declaredPath(root, path));
      if (!descriptor || !configObject(descriptor.mcpServers))
        throw new Error(`Invalid MCP descriptor for ${pluginId}`);
      mcpServers = { ...mcpServers, ...descriptor.mcpServers };
    }
  }
  const apps: ConfigObject[] = [];
  for (const path of paths(manifest.apps, ".app.json")) {
    if (!(await exists(resolve(root, path))) && manifest.apps === undefined) continue;
    const descriptor = await jsonObjectFile(await declaredPath(root, path));
    if (!descriptor || !configObject(descriptor.apps))
      throw new Error(`Invalid app descriptor for ${pluginId}`);
    for (const [name, app] of Object.entries(descriptor.apps)) {
      if (!configObject(app) || typeof app.id !== "string")
        throw new Error(`Invalid app declaration for ${pluginId}`);
      apps.push({ ...app, name: typeof app.name === "string" ? app.name : name });
    }
  }
  return { root: await realpath(root), manifest, skills, mcpServers, apps };
}

export async function cachedPluginRoot(
  codexHome: string,
  marketplace: string,
  plugin: string
): Promise<string | null> {
  const root = join(
    codexHome,
    "plugins",
    "cache",
    pluginSegment(marketplace),
    pluginSegment(plugin)
  );
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const versions: string[] = [];
  for (const version of entries) {
    if (!/^[a-zA-Z0-9_.+-]+$/.test(version) || version === "." || version === "..") continue;
    if ((await stat(join(root, version))).isDirectory()) versions.push(version);
  }
  versions.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const version = versions.includes("local") ? "local" : versions.at(-1);
  return version ? join(root, version) : null;
}
