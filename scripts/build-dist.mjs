import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const entryPoint = new URL("../packages/cli/src/bin.ts", import.meta.url);
const outfile = new URL("../dist/codapter.mjs", import.meta.url);
const extensionEntryPoint = new URL("../packages/collab-extension/src/index.ts", import.meta.url);
const extensionOutfile = new URL("../dist/collab-extension.mjs", import.meta.url);
const desktopExtensionEntryPoint = new URL(
  "../packages/backend-pi/src/desktop-extension/index.ts",
  import.meta.url
);
const desktopExtensionOutfile = new URL("../dist/desktop-extension.mjs", import.meta.url);
const desktopMcpProxyEntryPoint = new URL(
  "../packages/backend-pi/src/desktop-mcp-proxy.ts",
  import.meta.url
);
const desktopMcpProxyOutfile = new URL("../dist/desktop-mcp-proxy.mjs", import.meta.url);
const legacyOutfile = new URL("../dist/codapter.cjs", import.meta.url);
const legacySourceMapOutfile = new URL("../dist/codapter.cjs.map", import.meta.url);

await mkdir(dirname(fileURLToPath(outfile)), { recursive: true });
await rm(fileURLToPath(legacyOutfile), { force: true });
await rm(fileURLToPath(legacySourceMapOutfile), { force: true });

const buildOptions = {
  banner: {
    js: 'import { createRequire } from "node:module";const require = createRequire(import.meta.url);',
  },
  bundle: true,
  format: "esm",
  minify: true,
  platform: "node",
  sourcemap: true,
  target: "node22.22",
};

await Promise.all([
  esbuild.build({
    ...buildOptions,
    entryPoints: [fileURLToPath(entryPoint)],
    outfile: fileURLToPath(outfile),
  }),
  esbuild.build({
    ...buildOptions,
    entryPoints: [fileURLToPath(extensionEntryPoint)],
    outfile: fileURLToPath(extensionOutfile),
  }),
  esbuild.build({
    ...buildOptions,
    entryPoints: [fileURLToPath(desktopExtensionEntryPoint)],
    outfile: fileURLToPath(desktopExtensionOutfile),
  }),
  esbuild.build({
    ...buildOptions,
    entryPoints: [fileURLToPath(desktopMcpProxyEntryPoint)],
    outfile: fileURLToPath(desktopMcpProxyOutfile),
  }),
]);

await chmod(fileURLToPath(outfile), 0o755);
await chmod(fileURLToPath(desktopMcpProxyOutfile), 0o755);
