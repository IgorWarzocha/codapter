import { PassThrough, Readable } from "node:stream";
import * as codex from "@codapter/backend-codex";
import * as pi from "@codapter/backend-pi";
import { AppServerConnection } from "@codapter/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

function streams() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let errors = "";
  stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  return { stdin: Readable.from([]), stdout, stderr, errors: () => errors };
}

function mockPi() {
  const backend = pi.createPiBackend();
  const initialize = vi.spyOn(backend, "initialize").mockResolvedValue();
  const dispose = vi.spyOn(backend, "dispose").mockResolvedValue();
  const factory = vi.spyOn(pi, "createPiBackend").mockReturnValue(backend);
  return { initialize, dispose, factory };
}

function mockCodex() {
  const backend = codex.createCodexBackend();
  const initialize = vi.spyOn(backend, "initialize").mockResolvedValue();
  const dispose = vi.spyOn(backend, "dispose").mockResolvedValue();
  const factory = vi.spyOn(codex, "createCodexBackend").mockReturnValue(backend);
  return { initialize, dispose, factory };
}

describe("backend configuration", () => {
  it.each(["CODAPTER_PI_ARGS", "CODAPTER_CODEX_ARGS"])(
    "rejects malformed and non-string arrays in %s before any backend starts",
    async (name) => {
      const piBackend = mockPi();
      const codexBackend = mockCodex();
      for (const value of ["", "not json", "{}", "null", '["rpc",3]', '["rpc",null]']) {
        const io = streams();
        expect(await runCli(["app-server"], { ...io, env: { [name]: value } })).toEqual({
          exitCode: 1,
        });
        expect(io.errors()).toContain(`${name} must be a JSON array of strings`);
      }
      expect(piBackend.factory).not.toHaveBeenCalled();
      expect(codexBackend.factory).not.toHaveBeenCalled();
    }
  );

  it.each(["", " ", "nope", "NaN", "Infinity", "-1", "1.5", "2147483648"])(
    "rejects invalid timeout %j before starting Pi",
    async (value) => {
      const backend = mockPi();
      const io = streams();
      expect(
        await runCli(["app-server"], {
          ...io,
          env: { CODAPTER_PI_IDLE_TIMEOUT_MS: value, CODAPTER_CODEX_DISABLE: "1" },
        })
      ).toEqual({ exitCode: 1 });
      expect(io.errors()).toContain("CODAPTER_PI_IDLE_TIMEOUT_MS must be an integer");
      expect(backend.factory).not.toHaveBeenCalled();
    }
  );

  it.each(["0", "300000", "2147483647"])(
    "preserves valid timeout %s and empty launch arrays",
    async (value) => {
      const piBackend = mockPi();
      const codexBackend = mockCodex();
      expect(
        await runCli(["app-server"], {
          ...streams(),
          env: {
            CODAPTER_PI_IDLE_TIMEOUT_MS: value,
            CODAPTER_PI_ARGS: "[]",
            CODAPTER_CODEX_ARGS: "[]",
          },
        })
      ).toEqual({ exitCode: 0 });
      expect(piBackend.factory).toHaveBeenCalledWith({ idleTimeoutMs: Number(value), args: [] });
      expect(codexBackend.factory).toHaveBeenCalledWith(expect.objectContaining({ args: [] }));
    }
  );

  it.each([
    ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"],
    ["app-server", "-c", "features.code_mode_host=true", "--analytics-default-enabled"],
  ])("accepts real desktop invocation %j and forwards config only to Codex", async (...args) => {
    const piBackend = mockPi();
    const codexBackend = mockCodex();
    const io = streams();
    expect(await runCli(args, { ...io, env: {} })).toEqual({ exitCode: 0 });
    expect(piBackend.factory).toHaveBeenCalledWith({});
    expect(codexBackend.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["-c", "features.code_mode_host=true", "app-server"],
      })
    );
    expect(io.errors()).toContain(
      "Ignoring Codex config overrides for Pi: features.code_mode_host"
    );
  });

  it.each([
    "missing-separator",
    "=private-token",
    "features..code_mode_host=private-token",
    "features.code_mode_host=",
    "features.code_mode_host= ",
    "features.code_mode_host=private-token\0",
    "features\nsecret=private-token",
    "--config",
  ])("rejects malformed config %j visibly without leaking values", async (value) => {
    const backend = mockPi();
    const io = streams();
    expect(await runCli(["-c", value, "app-server"], { ...io, env: {} })).toEqual({
      exitCode: 1,
    });
    expect(io.errors()).toMatch(/Invalid Codex config override|Missing value for -c/);
    expect(io.errors()).not.toContain("private-token");
    expect(backend.factory).not.toHaveBeenCalled();
  });

  it("forwards per-connection Desktop plugin and MCP overrides intact, while logging only keys for Pi", async () => {
    const piBackend = mockPi();
    const codexBackend = mockCodex();
    const io = streams();
    const overrides = [
      "features.code_mode_host=true",
      "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true",
      "plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true",
      "features.secret_auth_storage=true",
      'chatgpt_base_url="http://127.0.0.1:9234/api?key=private-url-token"',
      'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.url="http://127.0.0.1:9235/mcp"',
      'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.http_headers={Authorization="Bearer private-header-token"}',
      'mcp_servers.codex_app.env={CODEX_APP_TOOLS_PIPE_PATH="/tmp/test-codex.pipe"}',
      'mcp_servers.codex_app.args=["--port","9235"]',
      'mcp_servers.codex_app.command=""',
    ];
    const args = [
      "-c",
      overrides[0],
      "app-server",
      "--analytics-default-enabled",
      ...overrides.slice(1).flatMap((value) => ["-c", value]),
    ];
    expect(
      await runCli(args, {
        ...io,
        env: { CODAPTER_CODEX_ARGS: '["app-server","--listen","stdio"]' },
      })
    ).toEqual({ exitCode: 0 });
    expect(piBackend.factory).toHaveBeenCalledWith({});
    expect(codexBackend.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [...overrides.flatMap((value) => ["-c", value]), "app-server", "--listen", "stdio"],
      })
    );
    for (const override of overrides) {
      expect(io.errors()).toContain(override.slice(0, override.indexOf("=")));
    }
    expect(io.errors()).toContain("Pi extensions remain authoritative");
    expect(io.errors()).not.toContain("private-url-token");
    expect(io.errors()).not.toContain("private-header-token");
    expect(io.errors()).not.toContain("9235");
    expect(io.errors()).not.toContain("/tmp/test-codex.pipe");
  });

  it.each([
    ["app-server", "--config", "model_reasoning_effort=low"],
    ["--config=features.future_native_feature=true", "app-server"],
  ])("accepts native --config forms without a feature whitelist", async (...args) => {
    const backend = mockCodex();
    const argument = args.find((arg) => arg.includes("="))?.replace(/^--config=/, "");
    expect(await runCli(args, { ...streams(), env: { CODAPTER_PI_DISABLE: "1" } })).toEqual({
      exitCode: 0,
    });
    expect(backend.factory).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["-c", argument, "app-server"] })
    );
  });
});

describe("CLI cleanup", () => {
  it("disposes a partially initialized required backend and removes signal handlers", async () => {
    const backend = mockPi();
    backend.initialize.mockRejectedValue(new Error("Pi startup failed"));
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const io = streams();
    expect(await runCli(["app-server"], { ...io, env: { CODAPTER_CODEX_DISABLE: "1" } })).toEqual({
      exitCode: 1,
    });
    expect(io.errors()).toContain("Pi startup failed");
    expect(backend.dispose).toHaveBeenCalledOnce();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });

  it("disposes initialized Pi if creating the next backend fails", async () => {
    const backend = mockPi();
    vi.spyOn(codex, "createCodexBackend").mockImplementation(() => {
      throw new Error("Codex construction failed");
    });
    expect(await runCli(["app-server"], { ...streams(), env: {} })).toEqual({ exitCode: 1 });
    expect(backend.initialize).toHaveBeenCalledOnce();
    expect(backend.dispose).toHaveBeenCalledOnce();
  });

  it("still serves stdio and disposes optional Codex after initialization fails", async () => {
    const backend = mockCodex();
    backend.initialize.mockRejectedValue(new Error("Codex startup failed"));
    const io = streams();
    expect(await runCli(["app-server"], { ...io, env: { CODAPTER_PI_DISABLE: "1" } })).toEqual({
      exitCode: 0,
    });
    expect(io.errors()).toContain("Codex backend unavailable: Codex startup failed");
    expect(backend.dispose).toHaveBeenCalledOnce();
  });

  it("does not accumulate process handlers across stdio EOF runs", async () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    for (let run = 0; run < 3; run += 1) {
      expect(
        await runCli(["app-server"], {
          ...streams(),
          env: { CODAPTER_PI_DISABLE: "1", CODAPTER_CODEX_DISABLE: "1" },
        })
      ).toEqual({ exitCode: 0 });
      expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    }
  });

  it.each(["abort", "SIGINT", "SIGTERM"])(
    "cleans default stdio before returning on %s, without process.exit",
    async (event) => {
      const backend = mockPi();
      const connectionDispose = vi.spyOn(AppServerConnection.prototype, "dispose");
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("unexpected process.exit");
      });
      const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
      const io = streams();
      const stdin = new PassThrough();
      const controller = new AbortController();
      const initialized = new Promise<void>((resolve) => io.stdout.once("data", () => resolve()));
      const running = runCli(["app-server"], {
        ...io,
        stdin,
        env: { CODAPTER_CODEX_DISABLE: "1" },
        shutdownSignal: controller.signal,
      });
      stdin.write(
        `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "lifecycle", version: "0.0.4" } } })}\n`
      );
      try {
        await initialized;
        if (event === "abort") {
          controller.abort();
        } else {
          process.emit(event);
        }
        expect(await running).toEqual({
          exitCode: event === "SIGINT" ? 130 : event === "SIGTERM" ? 143 : 0,
        });
        expect(connectionDispose).toHaveBeenCalledOnce();
        expect(backend.dispose).toHaveBeenCalledOnce();
        expect(connectionDispose.mock.invocationCallOrder[0]).toBeLessThan(
          backend.dispose.mock.invocationCallOrder[0]
        );
        expect(exit).not.toHaveBeenCalled();
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
      } finally {
        controller.abort();
        stdin.end();
        await running;
      }
    }
  );

  it("skips resource startup for an already aborted run", async () => {
    const piBackend = mockPi();
    const codexBackend = mockCodex();
    const controller = new AbortController();
    controller.abort();
    expect(
      await runCli(["app-server"], { ...streams(), env: {}, shutdownSignal: controller.signal })
    ).toEqual({ exitCode: 0 });
    expect(piBackend.factory).not.toHaveBeenCalled();
    expect(codexBackend.factory).not.toHaveBeenCalled();
  });

  it("aborts a stalled backend initialization and disposes the partially started backend", async () => {
    const backend = mockCodex();
    let started: () => void = () => {};
    const initializing = new Promise<void>((resolve) => {
      started = resolve;
    });
    backend.initialize.mockImplementation(() => {
      started();
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const running = runCli(["app-server"], {
      ...streams(),
      env: { CODAPTER_PI_DISABLE: "1" },
      shutdownSignal: controller.signal,
    });
    await initializing;
    controller.abort();
    expect(await running).toEqual({ exitCode: 0 });
    expect(backend.dispose).toHaveBeenCalledOnce();
  });

  it("aborts default stdio while command/exec is running without waiting for natural exit", async () => {
    const io = streams();
    const stdin = new PassThrough();
    const controller = new AbortController();
    const commandStarted = new Promise<void>((resolve) => {
      io.stdout.on("data", (chunk) => {
        if (chunk.toString().includes('"method":"command/exec/outputDelta"')) {
          resolve();
        }
      });
    });
    const running = runCli(["app-server"], {
      ...io,
      stdin,
      env: { CODAPTER_PI_DISABLE: "1", CODAPTER_CODEX_DISABLE: "1" },
      shutdownSignal: controller.signal,
    });
    stdin.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "lifecycle", version: "0.0.4" } } })}\n`
    );
    stdin.write(
      `${JSON.stringify({
        id: 2,
        method: "command/exec",
        params: {
          command: [
            process.execPath,
            "-e",
            "process.stdout.write('started'); setInterval(() => {}, 1000)",
          ],
          processId: "lifecycle-command",
          streamStdoutStderr: true,
          disableTimeout: true,
        },
      })}\n`
    );
    try {
      await commandStarted;
      controller.abort();
      expect(await running).toEqual({ exitCode: 0 });
    } finally {
      controller.abort();
      stdin.end();
      await running;
    }
  });

  it("still disposes backends and removes handlers when connection cleanup fails", async () => {
    const backend = mockPi();
    vi.spyOn(AppServerConnection.prototype, "dispose").mockRejectedValue(
      new Error("connection cleanup failed")
    );
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const io = streams();
    expect(await runCli(["app-server"], { ...io, env: { CODAPTER_CODEX_DISABLE: "1" } })).toEqual({
      exitCode: 1,
    });
    expect(io.errors()).toContain("connection cleanup failed");
    expect(backend.dispose).toHaveBeenCalledOnce();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });
});
