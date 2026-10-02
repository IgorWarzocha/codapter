#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] !== "sandbox") throw new Error("Only the sandbox subcommand may reach this binary");
process.stdout.write(`${JSON.stringify({ argv, envKeys: Object.keys(process.env) })}\n`);
