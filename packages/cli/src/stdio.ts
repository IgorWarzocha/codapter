import { createInterface } from "node:readline";
import { AppServerConnection, failure, parseNdjsonLine, serializeNdjsonLine } from "@codapter/core";
import type { ListenerHandle, ListenerOptions } from "./listeners.js";

export function startStdioListener(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  options: ListenerOptions
): ListenerHandle & { readonly done: Promise<void> } {
  let closing = false;
  const connection = new AppServerConnection({
    backendRouter: options.backendRouter,
    configStore: options.configStore,
    desktopPlugins: options.desktopPlugins,
    collabEnabled: options.collabEnabled,
    initialAuthState: options.initialAuthState ?? null,
    onMessage(message) {
      stdout.write(serializeNdjsonLine(message));
    },
  });
  const readline = createInterface({
    input: stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let disposal: Promise<void> | undefined;
  const dispose = () => {
    disposal ??= connection.dispose();
    return disposal;
  };

  const done = (async () => {
    try {
      await pumpStdioMessages(readline, connection, stdout, () => closing);
    } finally {
      readline.close();
      await dispose();
    }
  })();
  // A stdio listener may finish before the listener set is closed.
  void done.catch(() => {});

  return {
    address: "stdio",
    done,
    async close() {
      closing = true;
      readline.close();
      await dispose();
      await done;
    },
  };
}

async function pumpStdioMessages(
  readline: ReturnType<typeof createInterface>,
  connection: AppServerConnection,
  stdout: NodeJS.WritableStream,
  isClosing: () => boolean
): Promise<void> {
  const pending = new Set<Promise<void>>();

  const track = (work: Promise<void>) => {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work)
    );
  };

  for await (const line of readline) {
    if (isClosing()) {
      break;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    track(handleStdioMessage(trimmed, connection, stdout));
  }

  await Promise.allSettled([...pending]);
}

async function handleStdioMessage(
  line: string,
  connection: AppServerConnection,
  stdout: NodeJS.WritableStream
): Promise<void> {
  try {
    const message = parseNdjsonLine(line);
    const response = await connection.handleMessage(message);
    if (response) {
      stdout.write(serializeNdjsonLine(response));
    }
  } catch {
    stdout.write(serializeNdjsonLine(failure(null, -32700, "Parse error")));
  }
}
