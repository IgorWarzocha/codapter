import { describe, expect, it } from "vitest";
import {
  configKeyPath,
  mergeConfigObjects,
  parseConfigOverride,
  parseConfigToml,
  stringifyConfigToml,
} from "../src/config-toml.js";
import type { JsonValue } from "../src/protocol.js";

describe("configuration TOML", () => {
  it("roundtrips quoted plugin IDs, nested MCP tables, and ordered inline-table arrays", () => {
    const source = `
[plugins."browser@openai-bundled"]
enabled = true
[mcp_servers.node_repl]
command = "node"
args = ["--experimental", "script.mjs"]
env = { NODE_REPL_HOME = "\u0024{HOME}/native", LABEL = "quote \\" and newline\\n" }
[mcp_servers.codex_apps]
url = "https://chatgpt.com/backend-api/ps/mcp"
http_headers = { Authorization = "Bearer controlled-fixture", "X-Product" = "codex" }
[skills]
config = [{ name = "browser", enabled = false }, { path = "/plugin/SKILL.md", enabled = true }]
`;
    const parsed = parseConfigToml(source);
    expect(parsed).toMatchObject({
      plugins: { "browser@openai-bundled": { enabled: true } },
      mcp_servers: {
        node_repl: {
          args: ["--experimental", "script.mjs"],
          env: { NODE_REPL_HOME: `\${HOME}/native`, LABEL: 'quote " and newline\n' },
        },
      },
      skills: {
        config: [
          { name: "browser", enabled: false },
          { path: "/plugin/SKILL.md", enabled: true },
        ],
      },
    });
    expect(parseConfigToml(stringifyConfigToml(parsed))).toEqual(parsed);
    const override = parseConfigOverride('plugins."browser@openai-bundled".enabled=false');
    expect(mergeConfigObjects(parsed, override).plugins).toEqual({
      "browser@openai-bundled": { enabled: false },
    });
    expect(configKeyPath('mcp_servers."a.b".\'http_headers\'."X-Product"')).toEqual([
      "mcp_servers",
      "a.b",
      "http_headers",
      "X-Product",
    ]);
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects %s keys in tables, inline tables, and array entries",
    (key) => {
      for (const source of [
        `"${key}" = { polluted = true }`,
        `[plugins."${key}"]\nenabled = true`,
        `skills = { config = [{ "${key}" = true }] }`,
      ])
        expect(() => parseConfigToml(source)).toThrow("Invalid configuration key");
      expect(() => configKeyPath(`plugins."${key}".enabled`)).toThrow();
      expect(() => parseConfigOverride(`plugins.options={ "${key}" = true }`)).toThrow();
      expect(() => stringifyConfigToml(JSON.parse(`{"plugins":{"${key}":true}}`))).toThrow();
      expect(() => mergeConfigObjects({}, JSON.parse(`{"plugins":{"${key}":true}}`))).toThrow();
      expect(() => mergeConfigObjects(JSON.parse(`{"plugins":{"${key}":true}}`), {})).toThrow();
      expect(Object.prototype).not.toHaveProperty("polluted");
    }
  );

  it("omits null object keys but refuses lossy or unsupported array serialization", () => {
    expect(
      parseConfigToml(stringifyConfigToml({ model: null, features: { omitted: null, apps: true } }))
    ).toEqual({ features: { apps: true } });
    for (const array of [
      [1, null, 2],
      [[null]],
      [Number.NaN],
      [Number.POSITIVE_INFINITY],
      new Array<JsonValue>(2),
    ]) {
      expect(() => stringifyConfigToml({ values: array })).toThrow();
    }
    const serialized = stringifyConfigToml({
      values: [1, false, "", [], { omitted: null, retained: true }],
    });
    expect(parseConfigToml(serialized).values).toEqual([1, false, "", [], { retained: true }]);
  });

  it("matches native CLI literal fallback while config files remain strict TOML", () => {
    for (const [argument, expected] of [
      ["mcp_servers.demo.command=node", { mcp_servers: { demo: { command: "node" } } }],
      ["apps_mcp_product_sku=codex", { apps_mcp_product_sku: "codex" }],
      [
        "mcp_servers.demo.command=  node --flag  ",
        { mcp_servers: { demo: { command: "node --flag" } } },
      ],
      [
        'mcp_servers.demo.command= "unterminated ',
        { mcp_servers: { demo: { command: "unterminated" } } },
      ],
      [
        "mcp_servers.demo.command= 'unterminated ",
        { mcp_servers: { demo: { command: "unterminated" } } },
      ],
    ] as const) {
      expect(parseConfigOverride(argument)).toEqual(expected);
      expect(() => parseConfigToml(argument)).toThrow("Invalid TOML configuration");
    }
    expect(parseConfigOverride('mcp_servers.demo.args=["--flag", "fixture"]')).toEqual({
      mcp_servers: { demo: { args: ["--flag", "fixture"] } },
    });
    expect(parseConfigOverride("features.apps=true")).toEqual({ features: { apps: true } });
  });

  it("never includes credential values or TOML source in invalid-input diagnostics", () => {
    const secret = "DO_NOT_EXPOSE_BEARER_FIXTURE";
    const operations = [
      () => parseConfigToml(`headers = { Authorization = "Bearer ${secret}" unexpected }`),
      () =>
        parseConfigOverride(
          `mcp_servers.apps.http_headers={Authorization="Bearer ${secret}", prototype=true}`
        ),
      () => configKeyPath(`plugins."${secret}\\x".enabled`),
    ];
    for (const operation of operations) {
      let thrown: unknown;
      try {
        operation();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      if (!(thrown instanceof Error)) throw new Error("Expected invalid TOML to fail");
      expect(thrown.message).not.toContain(secret);
      expect(thrown.stack).not.toContain(secret);
      expect(thrown.cause).toBeUndefined();
    }
  });
});
