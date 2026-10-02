import { parse, stringify, type TomlTable } from "smol-toml";
import type { JsonValue } from "./protocol.js";

export type ConfigObject = { [key: string]: JsonValue | undefined };

export function configObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertConfigKey(key: string): void {
  if (["__proto__", "prototype", "constructor"].includes(key))
    throw new Error("Invalid configuration key");
}

function jsonValue(value: unknown): JsonValue {
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (configObject(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        assertConfigKey(key);
        return [key, child === undefined ? undefined : jsonValue(child)];
      })
    );
  }
  throw new Error("Unsupported TOML value in configuration");
}

export function parseConfigToml(source: string): ConfigObject {
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch {
    // smol-toml errors include source excerpts, which may contain credentials.
    throw new Error("Invalid TOML configuration");
  }
  const result = jsonValue(parsed);
  if (!configObject(result)) throw new Error("Configuration must be a TOML table");
  return result;
}

export function configKeyPath(keyPath: string): string[] {
  const token = /(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_@-]+)/y;
  const keys: string[] = [];
  let offset = 0;
  while (offset < keyPath.length) {
    token.lastIndex = offset;
    const match = token.exec(keyPath);
    if (!match) throw new Error("Invalid configuration key path");
    const raw = match[0];
    let key: unknown = raw;
    try {
      if (raw.startsWith('"') || raw.startsWith("'")) key = parse(`key = ${raw}`).key;
    } catch {
      throw new Error("Invalid configuration key path");
    }
    if (typeof key !== "string") {
      throw new Error("Invalid configuration key path");
    }
    assertConfigKey(key);
    keys.push(key);
    offset = token.lastIndex;
    if (offset === keyPath.length) break;
    if (keyPath[offset] !== ".") throw new Error("Invalid configuration key path");
    offset += 1;
    if (offset === keyPath.length) throw new Error("Invalid configuration key path");
  }
  if (!keys.length) throw new Error("Invalid configuration key path");
  return keys;
}

export function parseConfigOverride(argument: string): ConfigObject {
  const separator = argument.indexOf("=");
  if (separator < 1) throw new Error("Invalid configuration override");
  const keys = configKeyPath(argument.slice(0, separator).trim());
  const literal = argument.slice(separator + 1).trim();
  let value: unknown;
  try {
    value = parse(`value = ${literal}`).value;
  } catch {
    // Native CLI accepts bare strings and strips edge quotes after a TOML syntax failure.
    // Config files stay strict. Keep JSON/prototype validation outside this fallback.
    value = literal.replace(/^["']+|["']+$/g, "");
  }
  return configPathValue(keys, jsonValue(value));
}

export function configValueOverride(keyPath: string, value: JsonValue): ConfigObject {
  return configPathValue(configKeyPath(keyPath), value);
}

function configPathValue(keys: string[], value: JsonValue): ConfigObject {
  const root: ConfigObject = {};
  let node = root;
  for (const key of keys.slice(0, -1)) {
    const child: ConfigObject = {};
    node[key] = child;
    node = child;
  }
  node[keys[keys.length - 1]] = jsonValue(value);
  return root;
}

export function mergeConfigObjects(base: ConfigObject, overlay: ConfigObject): ConfigObject {
  const result = jsonValue(base);
  if (!configObject(result)) throw new Error("Configuration must be a table");
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    assertConfigKey(key);
    result[key] =
      configObject(result[key]) && configObject(value)
        ? mergeConfigObjects(result[key], value)
        : jsonValue(value);
  }
  return result;
}

// Thread RPC config accepts both nested tables and TOML paths. Explicit paths
// take precedence regardless of their insertion order in the request object.
export function configOverridesForRoots(
  value: ConfigObject,
  roots: readonly string[]
): ConfigObject {
  let result = mergeConfigObjects(
    {},
    Object.fromEntries(
      roots.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]]))
    )
  );
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined && roots.some((root) => key.startsWith(`${root}.`)))
      result = mergeConfigObjects(result, configValueOverride(key, child));
  }
  return result;
}

export function stringifyConfigToml(config: ConfigObject): string {
  const table = (source: ConfigObject): TomlTable =>
    Object.fromEntries(
      Object.entries(source).flatMap(([key, value]) => {
        assertConfigKey(key);
        if (value === null || value === undefined) return [];
        return [[key, convert(value)]];
      })
    );
  const convert = (value: Exclude<JsonValue, null>): TomlTable[string] => {
    if (Array.isArray(value)) {
      return Array.from(value, (entry) => {
        if (entry === null || entry === undefined)
          throw new Error("TOML configuration arrays cannot contain null or undefined values");
        return convert(entry);
      });
    }
    if (configObject(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
      return table(value);
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    throw new Error("Unsupported TOML value in configuration");
  };
  const converted = table(config);
  try {
    return stringify(converted);
  } catch {
    throw new Error("Configuration cannot be represented as TOML");
  }
}
