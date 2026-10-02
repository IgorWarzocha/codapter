import { resolve } from "node:path";
import { createCodexBackend } from "@codapter/backend-codex";
import { createPiBackend } from "@codapter/backend-pi";
import {
  ADAPTER_VERSION,
  BackendRouter,
  DesktopPluginCatalog,
  type IBackend,
  InMemoryConfigStore,
  readStoredAuthState,
  resolveCodexHome,
} from "@codapter/core";
import {
  extractCodexConfig,
  isDesktopConfigOverride,
  parseBackendOptions,
  parseListenTargets,
  writeHelp,
} from "./config.js";
import { type ListenerHandle, type ListenerSet, startAppServerListeners } from "./listeners.js";
import { startStdioListener } from "./stdio.js";

export interface CliEnvironment {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly shutdownSignal?: AbortSignal;
}

export interface CliRunResult {
  readonly exitCode: number;
}

export async function runCli(
  args: readonly string[],
  environment: CliEnvironment = {}
): Promise<CliRunResult> {
  const stdin = environment.stdin ?? process.stdin;
  const stdout = environment.stdout ?? process.stdout;
  const stderr = environment.stderr ?? process.stderr;
  const env = environment.env ?? process.env;

  if (args.includes("--version")) {
    stdout.write(`${ADAPTER_VERSION}\n`);
    return { exitCode: 0 };
  }
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    writeHelp(stdout);
    return { exitCode: 0 };
  }
  let invocation: ReturnType<typeof extractCodexConfig>;
  try {
    invocation = extractCodexConfig(args);
  } catch (error) {
    stderr.write(`${errorMessage(error)}\n`);
    return { exitCode: 1 };
  }
  const [command, ...commandArgs] = invocation.args;
  if (command !== "app-server") {
    stderr.write(`Unknown command: ${command}\n`);
    return { exitCode: 1 };
  }

  const backends: IBackend[] = [];
  let listeners: ListenerHandle | ListenerSet | null = null;
  const shutdown = new AbortController();
  let exitCode = 0;
  const onSigint = () => {
    exitCode = 130;
    shutdown.abort();
  };
  const onSigterm = () => {
    exitCode = 143;
    shutdown.abort();
  };
  const onAbort = () => shutdown.abort();
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  environment.shutdownSignal?.addEventListener("abort", onAbort, { once: true });
  if (environment.shutdownSignal?.aborted) {
    shutdown.abort();
  }

  try {
    const parsed = parseListenTargets(commandArgs, env);
    // Validate all enabled backend config before starting any resources.
    const options = parseBackendOptions(env, parsed.collabEnabled, stderr, invocation.overrides);
    const configStore = new InMemoryConfigStore(env.CODAPTER_CONFIG_FILE);
    const desktopPlugins = new DesktopPluginCatalog({
      codexHome: env.CODEX_HOME ? resolve(env.CODEX_HOME) : resolveCodexHome(),
      configStore,
      overrides: invocation.overrides
        .filter(isDesktopConfigOverride)
        .map(({ argument }) => argument),
    });
    const ignoredOverrides = invocation.overrides.filter(
      (override) => !isDesktopConfigOverride(override)
    );
    if (options.pi && ignoredOverrides.length > 0) {
      stderr.write(
        `[codapter] Ignoring Codex config overrides for Pi: ${[...new Set(ignoredOverrides.map(({ key }) => key))].join(", ")}. Pi extensions remain authoritative.\n`
      );
    }
    if (options.pi && !shutdown.signal.aborted) {
      const backend = createPiBackend(options.pi);
      backends.push(backend);
      await Promise.race([backend.initialize(), waitForShutdown(shutdown.signal)]);
    }
    if (options.codex && !shutdown.signal.aborted) {
      const backend = createCodexBackend(options.codex);
      backends.push(backend);
      try {
        await Promise.race([backend.initialize(), waitForShutdown(shutdown.signal)]);
      } catch (error) {
        stderr.write(`[codapter] Codex backend unavailable: ${errorMessage(error)}\n`);
      }
    }
    if (!shutdown.signal.aborted) {
      const backendRouter = new BackendRouter(backends);
      const listenerOptions = {
        backendRouter,
        configStore,
        desktopPlugins,
        stdin,
        stdout,
        collabEnabled: parsed.collabEnabled,
        initialAuthState: backendRouter.getBackend("codex") ? readStoredAuthState() : null,
      };
      if (parsed.listenTargets.length === 0) {
        const stdio = startStdioListener(stdin, stdout, listenerOptions);
        listeners = stdio;
        await Promise.race([stdio.done, waitForShutdown(shutdown.signal)]);
      } else {
        listeners = await startAppServerListeners(parsed.listenTargets, listenerOptions);
        stderr.write(`Listening on ${listeners.addresses.join(", ")}\n`);
        await waitForShutdown(shutdown.signal);
      }
    }
  } catch (error) {
    stderr.write(`${errorMessage(error)}\n`);
    exitCode = 1;
  } finally {
    // Wake the stdio shutdown waiter on ordinary EOF as well.
    shutdown.abort();
    try {
      await listeners?.close();
    } catch (error) {
      stderr.write(`[codapter] Listener cleanup failed: ${errorMessage(error)}\n`);
      exitCode = 1;
    }
    await Promise.all(
      backends.map(async (backend) => {
        try {
          await backend.dispose();
        } catch (error) {
          stderr.write(`[codapter] Backend cleanup failed: ${errorMessage(error)}\n`);
          exitCode = 1;
        }
      })
    );
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    environment.shutdownSignal?.removeEventListener("abort", onAbort);
  }
  return { exitCode };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForShutdown(signal: AbortSignal): Promise<void> {
  if (!signal.aborted) {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}
