import type { JsonValue } from "./protocol.js";

type ParsedCommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "list"; command: string; path?: string }
  | { type: "search"; command: string; query?: string; path?: string }
  | { type: "unknown"; command: string };

type CommandPresentation = {
  command: string;
  commandActions: JsonValue[];
};

const EXPLORATION_TOOL_TOKENS = new Set([
  "explore",
  "find",
  "grep",
  "list",
  "ls",
  "read",
  "search",
]);

function tokenizeToolName(toolName: string): string[] {
  return toolName
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function inferCommandString(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (!input || typeof input !== "object") {
    return "";
  }
  const record = input as Record<string, unknown>;
  if (Array.isArray(record.command)) {
    return record.command.filter((value): value is string => typeof value === "string").join(" ");
  }
  if (typeof record.command === "string") {
    return record.command;
  }
  if (Array.isArray(record.cmd)) {
    return record.cmd.filter((value): value is string => typeof value === "string").join(" ");
  }
  if (typeof record.cmd === "string") {
    return record.cmd;
  }
  return "";
}

export function inferCommandPresentation(
  toolName: string,
  input: unknown,
  cwd: string
): CommandPresentation {
  const explicitCommand = inferCommandString(input).trim();
  if (explicitCommand.length > 0) {
    return {
      command: explicitCommand,
      commandActions: inferCommandActions(explicitCommand, cwd),
    };
  }

  const inferredAction = inferToolActionFromName(toolName, input, cwd);
  if (inferredAction) {
    return {
      command: describeCommandAction(inferredAction, toolName),
      commandActions: [inferredAction],
    };
  }

  return {
    command: toolName,
    commandActions: inferCommandActions(toolName, cwd),
  };
}

export function inferCommandActions(command: string, cwd: string): JsonValue[] {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const actions = parseCommandActions(trimmed, cwd);
  return actions.length > 0 ? actions : [{ type: "unknown", command: trimmed }];
}

function parseCommandActions(command: string, cwd: string): ParsedCommandAction[] {
  const tokens = normalizeTokens(shellSplit(command));
  if (tokens.length === 0) {
    return [];
  }

  const parts = splitOnConnectors(tokens);
  if (parts.length === 0) {
    return [];
  }

  const actions: ParsedCommandAction[] = [];
  let currentCwd = cwd;
  for (const part of parts) {
    if (part.length === 0) {
      continue;
    }
    if (part[0] === "cd") {
      const target = cdTarget(part.slice(1));
      if (target) {
        currentCwd = joinPaths(currentCwd, target);
      }
      continue;
    }

    const action = parseMainTokens(part, currentCwd);
    if (action) {
      actions.push(action);
    }
  }

  if (actions.length === 0) {
    return [{ type: "unknown", command }];
  }
  if (actions.some((action) => action.type === "unknown")) {
    return [{ type: "unknown", command }];
  }
  return dedupeActions(actions);
}

function inferToolActionFromName(
  toolName: string,
  input: unknown,
  cwd: string
): ParsedCommandAction | null {
  const tokens = tokenizeToolName(toolName);
  if (!tokens.some((token) => EXPLORATION_TOOL_TOKENS.has(token))) {
    return null;
  }

  const record = isRecord(input) ? input : {};
  const path = pathFromToolInput(record);
  const query = queryFromToolInput(record);

  if (tokens.includes("read")) {
    return path ? readAction(toolName, path, cwd) : { type: "unknown", command: toolName };
  }

  if (tokens.includes("search") || tokens.includes("find") || tokens.includes("grep")) {
    return {
      type: "search",
      command: toolName,
      ...(query ? { query } : {}),
      ...(path ? { path: shortDisplayPath(path) } : {}),
    };
  }

  if (tokens.includes("explore") || tokens.includes("list") || tokens.includes("ls")) {
    return {
      type: "list",
      command: toolName,
      ...(path ? { path: shortDisplayPath(path) } : {}),
    };
  }

  return null;
}

function describeCommandAction(action: ParsedCommandAction, toolName: string): string {
  switch (action.type) {
    case "read":
      return `Read ${action.name}`;
    case "search":
      if (action.path && action.query) {
        return `Search ${action.path} for ${action.query}`;
      }
      if (action.query) {
        return `Search for ${action.query}`;
      }
      if (action.path) {
        return `Search ${action.path}`;
      }
      return "Search workspace";
    case "list":
      if (action.path) {
        return `List ${action.path}`;
      }
      return tokenizeToolName(toolName).includes("explore")
        ? "Explore workspace"
        : "List workspace";
    case "unknown":
      return action.command;
  }
}

function pathFromToolInput(record: Record<string, unknown>): string | undefined {
  for (const key of [
    "path",
    "file",
    "filePath",
    "filepath",
    "filename",
    "relative_path",
    "relativePath",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function queryFromToolInput(record: Record<string, unknown>): string | undefined {
  for (const key of ["query", "pattern", "search", "needle", "text", "match"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function dedupeActions(actions: ParsedCommandAction[]): ParsedCommandAction[] {
  const deduped: ParsedCommandAction[] = [];
  for (const action of actions) {
    const previous = deduped[deduped.length - 1];
    if (previous && JSON.stringify(previous) === JSON.stringify(action)) {
      continue;
    }
    deduped.push(action);
  }
  return deduped;
}

function parseMainTokens(tokens: string[], cwd: string): ParsedCommandAction | null {
  const [head, ...tail] = tokens;
  if (!head) {
    return null;
  }

  const command = joinCommandTokens(tokens);

  if (
    head === "echo" ||
    head === "true" ||
    head === "printf" ||
    head === "wc" ||
    head === "tr" ||
    head === "cut" ||
    head === "sort" ||
    head === "uniq" ||
    head === "tee" ||
    head === "column" ||
    head === "yes"
  ) {
    return null;
  }

  if (head === "xargs") {
    return xargsIsMutatingSubcommand(tail) ? { type: "unknown", command } : null;
  }

  if (head === "ls" || head === "eza" || head === "exa") {
    const flagsWithValues =
      head === "ls"
        ? ["-I", "-w", "--block-size", "--format", "--time-style", "--color", "--quoting-style"]
        : ["-I", "--ignore-glob", "--color", "--sort", "--time-style", "--time"];
    const path = firstNonFlagOperand(tail, flagsWithValues);
    return { type: "list", command, ...(path ? { path: shortDisplayPath(path) } : {}) };
  }

  if (head === "tree") {
    const path = firstNonFlagOperand(tail, [
      "-L",
      "-P",
      "-I",
      "--charset",
      "--filelimit",
      "--sort",
    ]);
    return { type: "list", command, ...(path ? { path: shortDisplayPath(path) } : {}) };
  }

  if (head === "du") {
    const path = firstNonFlagOperand(tail, [
      "-d",
      "--max-depth",
      "-B",
      "--block-size",
      "--exclude",
      "--time-style",
    ]);
    return { type: "list", command, ...(path ? { path: shortDisplayPath(path) } : {}) };
  }

  if (head === "rg" || head === "rga" || head === "ripgrep-all") {
    const args = trimAtConnector(tail);
    const hasFilesFlag = args.includes("--files");
    const candidates = skipFlagValues(args, [
      "-g",
      "--glob",
      "--iglob",
      "-t",
      "--type",
      "--type-add",
      "--type-not",
      "-m",
      "--max-count",
      "-A",
      "-B",
      "-C",
      "--context",
      "--max-depth",
    ]);
    const nonFlags = candidates.filter((token) => !token.startsWith("-"));
    if (hasFilesFlag) {
      const path = nonFlags[0];
      return { type: "list", command, ...(path ? { path: shortDisplayPath(path) } : {}) };
    }
    return {
      type: "search",
      command,
      ...(nonFlags[0] ? { query: nonFlags[0] } : {}),
      ...(nonFlags[1] ? { path: shortDisplayPath(nonFlags[1]) } : {}),
    };
  }

  if (head === "git" && tail[0] === "grep") {
    return parseGrepLike(command, tail.slice(1));
  }

  if (head === "git" && tail[0] === "ls-files") {
    const path = firstNonFlagOperand(tail.slice(1), [
      "--exclude",
      "--exclude-from",
      "--pathspec-from-file",
    ]);
    return { type: "list", command, ...(path ? { path: shortDisplayPath(path) } : {}) };
  }

  if (head === "fd") {
    const [query, path] = parseFdQueryAndPath(tail);
    return query
      ? { type: "search", command, query, ...(path ? { path } : {}) }
      : { type: "list", command, ...(path ? { path } : {}) };
  }

  if (head === "find") {
    const [query, path] = parseFindQueryAndPath(tail);
    return query
      ? { type: "search", command, query, ...(path ? { path } : {}) }
      : { type: "list", command, ...(path ? { path } : {}) };
  }

  if (head === "grep" || head === "egrep" || head === "fgrep") {
    return parseGrepLike(command, tail);
  }

  if (head === "ag" || head === "ack" || head === "pt") {
    const args = trimAtConnector(tail);
    const candidates = skipFlagValues(args, [
      "-G",
      "-g",
      "--file-search-regex",
      "--ignore-dir",
      "--ignore-file",
      "--path-to-ignore",
    ]);
    const nonFlags = candidates.filter((token) => !token.startsWith("-"));
    return {
      type: "search",
      command,
      ...(nonFlags[0] ? { query: nonFlags[0] } : {}),
      ...(nonFlags[1] ? { path: shortDisplayPath(nonFlags[1]) } : {}),
    };
  }

  if (head === "cat") {
    const path = singleNonFlagOperand(tail, []);
    return path ? readAction(command, path, cwd) : { type: "unknown", command };
  }

  if (head === "bat" || head === "batcat") {
    const path = singleNonFlagOperand(tail, [
      "--theme",
      "--language",
      "--style",
      "--terminal-width",
      "--tabs",
      "--line-range",
      "--map-syntax",
    ]);
    return path ? readAction(command, path, cwd) : { type: "unknown", command };
  }

  if (head === "less" || head === "more") {
    const path = singleNonFlagOperand(tail, []);
    return path ? readAction(command, path, cwd) : { type: "unknown", command };
  }

  if (head === "head") {
    const path = readPathFromHeadTail(tail, "head");
    return path ? readAction(command, path, cwd) : null;
  }

  if (head === "tail") {
    const path = readPathFromHeadTail(tail, "tail");
    return path ? readAction(command, path, cwd) : null;
  }

  if (head === "awk") {
    const path = awkDataFileOperand(tail);
    return path ? readAction(command, path, cwd) : { type: "unknown", command };
  }

  if (head === "nl") {
    const candidates = skipFlagValues(tail, ["-s", "-w", "-v", "-i", "-b"]);
    const path = candidates.find((token) => !token.startsWith("-"));
    return path ? readAction(command, path, cwd) : null;
  }

  if (head === "sed") {
    const path = sedReadPath(tail);
    return path ? readAction(command, path, cwd) : null;
  }

  if (isPythonCommand(head)) {
    return pythonWalksFiles(tail) ? { type: "list", command } : { type: "unknown", command };
  }

  return { type: "unknown", command };
}

function parseGrepLike(command: string, tail: string[]): ParsedCommandAction {
  const args = trimAtConnector(tail);
  const operands: string[] = [];
  let pattern: string | undefined;
  let afterDoubleDash = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (afterDoubleDash) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (arg === "-e" || arg === "--regexp") {
      if (!pattern) {
        pattern = args[index + 1];
      }
      index += 1;
      continue;
    }
    if (arg === "-f" || arg === "--file") {
      if (!pattern) {
        pattern = args[index + 1];
      }
      index += 1;
      continue;
    }
    if (
      arg === "-m" ||
      arg === "--max-count" ||
      arg === "-C" ||
      arg === "--context" ||
      arg === "-A" ||
      arg === "--after-context" ||
      arg === "-B" ||
      arg === "--before-context"
    ) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    operands.push(arg);
  }

  const hasPattern = pattern !== undefined;
  const query = pattern ?? operands[0];
  const pathIndex = hasPattern ? 0 : 1;
  const path = operands[pathIndex] ? shortDisplayPath(operands[pathIndex]) : undefined;

  return {
    type: "search",
    command,
    ...(query ? { query } : {}),
    ...(path ? { path } : {}),
  };
}

function parseFdQueryAndPath(tail: string[]): [string | undefined, string | undefined] {
  const args = trimAtConnector(tail);
  const candidates = skipFlagValues(args, [
    "-t",
    "--type",
    "-e",
    "--extension",
    "-E",
    "--exclude",
    "--search-path",
  ]);
  const nonFlags = candidates.filter((token) => !token.startsWith("-"));
  if (nonFlags.length === 1) {
    return isPathish(nonFlags[0])
      ? [undefined, shortDisplayPath(nonFlags[0])]
      : [nonFlags[0], undefined];
  }
  if (nonFlags.length >= 2) {
    return [nonFlags[0], shortDisplayPath(nonFlags[1])];
  }
  return [undefined, undefined];
}

function parseFindQueryAndPath(tail: string[]): [string | undefined, string | undefined] {
  const args = trimAtConnector(tail);
  let path: string | undefined;
  for (const arg of args) {
    if (!arg.startsWith("-") && arg !== "!" && arg !== "(" && arg !== ")") {
      path = shortDisplayPath(arg);
      break;
    }
  }

  let query: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-name" || arg === "-iname" || arg === "-path" || arg === "-regex") {
      query = args[index + 1];
      break;
    }
  }

  return [query, path];
}

function readAction(command: string, path: string, cwd: string): ParsedCommandAction {
  const resolvedPath = isAbsoluteLike(path) ? path : joinPaths(cwd, path);
  return {
    type: "read",
    command,
    name: shortDisplayPath(path),
    path: resolvedPath,
  };
}

function readPathFromHeadTail(args: string[], tool: "head" | "tail"): string | undefined {
  if (args.length === 1 && !args[0].startsWith("-")) {
    return args[0];
  }

  const tokens = trimAtConnector(args);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) {
      break;
    }
    if (!token.startsWith("-")) {
      return token;
    }
    if ((token === "-n" || token === "-c") && index + 1 < tokens.length) {
      index += 2;
      continue;
    }
    if ((tool === "head" || tool === "tail") && /^-[nc].+/.test(token)) {
      index += 1;
      continue;
    }
    index += 1;
  }

  return undefined;
}

function sedReadPath(args: string[]): string | undefined {
  const tokens = trimAtConnector(args);
  if (!tokens.includes("-n")) {
    return undefined;
  }

  let hasRangeScript = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if ((token === "-e" || token === "--expression") && isValidSedRange(tokens[index + 1])) {
      hasRangeScript = true;
    }
    if (!token.startsWith("-") && isValidSedRange(token)) {
      hasRangeScript = true;
    }
  }
  if (!hasRangeScript) {
    return undefined;
  }

  const candidates = skipFlagValues(tokens, ["-e", "-f", "--expression", "--file"]);
  const nonFlags = candidates.filter((token) => !token.startsWith("-"));
  if (nonFlags.length === 0) {
    return undefined;
  }
  return isValidSedRange(nonFlags[0]) ? nonFlags[1] : nonFlags[0];
}

function isValidSedRange(value: string | undefined): boolean {
  if (!value || !value.endsWith("p")) {
    return false;
  }
  const core = value.slice(0, -1);
  const parts = core.split(",");
  return (
    parts.length >= 1 &&
    parts.length <= 2 &&
    parts.every((part) => part.length > 0 && /^\d+$/.test(part))
  );
}

function trimAtConnector(tokens: string[]): string[] {
  const index = tokens.findIndex(
    (token) => token === "|" || token === "&&" || token === "||" || token === ";"
  );
  return index === -1 ? [...tokens] : tokens.slice(0, index);
}

function skipFlagValues(args: string[], flagsWithValues: string[]): string[] {
  const out: string[] = [];
  let skipNext = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token === "--") {
      out.push(...args.slice(index + 1));
      break;
    }
    if (token.startsWith("--") && token.includes("=")) {
      continue;
    }
    if (flagsWithValues.includes(token)) {
      if (index + 1 < args.length) {
        skipNext = true;
      }
      continue;
    }
    out.push(token);
  }
  return out;
}

function positionalOperands(args: string[], flagsWithValues: string[]): string[] {
  const out: string[] = [];
  let afterDoubleDash = false;
  let skipNext = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (afterDoubleDash) {
      out.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (arg.startsWith("--") && arg.includes("=")) {
      continue;
    }
    if (flagsWithValues.includes(arg)) {
      if (index + 1 < args.length) {
        skipNext = true;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    out.push(arg);
  }
  return out;
}

function firstNonFlagOperand(args: string[], flagsWithValues: string[]): string | undefined {
  return positionalOperands(args, flagsWithValues)[0];
}

function singleNonFlagOperand(args: string[], flagsWithValues: string[]): string | undefined {
  const operands = positionalOperands(args, flagsWithValues);
  return operands.length === 1 ? operands[0] : undefined;
}

function awkDataFileOperand(args: string[]): string | undefined {
  if (args.length === 0) {
    return undefined;
  }
  const tokens = trimAtConnector(args);
  const hasScriptFile = tokens.some((arg) => arg === "-f" || arg === "--file");
  const candidates = skipFlagValues(tokens, [
    "-F",
    "-v",
    "-f",
    "--field-separator",
    "--assign",
    "--file",
  ]);
  const nonFlags = candidates.filter((arg) => !arg.startsWith("-"));
  if (hasScriptFile) {
    return nonFlags[0];
  }
  return nonFlags.length >= 2 ? nonFlags[1] : undefined;
}

function pythonWalksFiles(args: string[]): boolean {
  const tokens = trimAtConnector(args);
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] !== "-c") {
      continue;
    }
    const script = tokens[index + 1];
    if (!script) {
      continue;
    }
    return (
      script.includes("os.walk") ||
      script.includes("os.listdir") ||
      script.includes("os.scandir") ||
      script.includes("glob.glob") ||
      script.includes("glob.iglob") ||
      script.includes("pathlib.Path") ||
      script.includes(".rglob(")
    );
  }
  return false;
}

function isPythonCommand(command: string): boolean {
  return (
    command === "python" ||
    command === "python2" ||
    command === "python3" ||
    command.startsWith("python2.") ||
    command.startsWith("python3.")
  );
}

function isPathish(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function xargsIsMutatingSubcommand(tokens: string[]): boolean {
  const subcommand = xargsSubcommand(tokens);
  if (!subcommand || subcommand.length === 0) {
    return false;
  }
  const [head, ...tail] = subcommand;
  if (head === "perl" || head === "ruby") {
    return xargsHasInPlaceFlag(tail);
  }
  if (head === "sed") {
    return xargsHasInPlaceFlag(tail) || tail.includes("--in-place");
  }
  return head === "rg" && tail.includes("--replace");
}

function xargsSubcommand(tokens: string[]): string[] | undefined {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") {
      return tokens.slice(index + 1);
    }
    if (!token.startsWith("-")) {
      return tokens.slice(index);
    }
    const takesValue =
      token === "-E" ||
      token === "-e" ||
      token === "-I" ||
      token === "-L" ||
      token === "-n" ||
      token === "-P" ||
      token === "-s";
    index += takesValue && token.length === 2 ? 2 : 1;
  }
  return undefined;
}

function xargsHasInPlaceFlag(tokens: string[]): boolean {
  return tokens.some(
    (token) =>
      token === "-i" || token.startsWith("-i") || token === "-pi" || token.startsWith("-pi")
  );
}

function cdTarget(args: string[]): string | undefined {
  if (args.length === 0) {
    return undefined;
  }
  let target: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      return args[index + 1];
    }
    if (arg === "-L" || arg === "-P" || arg.startsWith("-")) {
      continue;
    }
    target = arg;
  }
  return target;
}

function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const next = input[index + 1];

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      if (!quote) {
        escaping = true;
        continue;
      }
      if (quote === '"') {
        if (next && (next === "\\" || next === '"' || next === "$" || next === "`")) {
          escaping = true;
          continue;
        }
        current += char;
        continue;
      }
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "&" && next === "&") {
      pushCurrent();
      tokens.push("&&");
      index += 1;
      continue;
    }
    if (char === "|" && next === "|") {
      pushCurrent();
      tokens.push("||");
      index += 1;
      continue;
    }
    if (char === "|" || char === ";") {
      pushCurrent();
      tokens.push(char);
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    current += char;
  }

  pushCurrent();
  return tokens;
}

function shellQuote(token: string): string {
  if (token.length === 0) {
    return "''";
  }
  if (canEmitUnquoted(token)) {
    return token;
  }
  return `'${token.replace(/'/g, `'"'"'`)}'`;
}

function canEmitUnquoted(token: string): boolean {
  for (const char of token) {
    if (!isUnquotedOk(char)) {
      return false;
    }
  }
  return true;
}

function isUnquotedOk(char: string): boolean {
  return /^[+\-./:@\]_0-9A-Za-z]$/.test(char);
}

function joinCommandTokens(tokens: string[]): string {
  return tokens
    .map((token) =>
      token === "&&" || token === "||" || token === "|" || token === ";" ? token : shellQuote(token)
    )
    .join(" ");
}

function normalizeTokens(tokens: string[]): string[] {
  if (
    tokens.length >= 3 &&
    (tokens[0] === "yes" || tokens[0] === "y" || tokens[0] === "no" || tokens[0] === "n") &&
    tokens[1] === "|"
  ) {
    return normalizeTokens(tokens.slice(2));
  }
  const shell = tokens[0]?.replace(/\\/g, "/").split("/").pop();
  if (
    tokens.length === 3 &&
    (shell === "bash" || shell === "zsh" || shell === "sh") &&
    (tokens[1] === "-c" || tokens[1] === "-lc")
  ) {
    return normalizeTokens(shellSplit(tokens[2]));
  }
  return tokens;
}

function splitOnConnectors(tokens: string[]): string[][] {
  const parts: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (token === "&&" || token === "||" || token === "|" || token === ";") {
      if (current.length > 0) {
        parts.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

function shortDisplayPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  const parts = normalized
    .split("/")
    .filter(
      (part) =>
        part.length > 0 &&
        part !== "src" &&
        part !== "dist" &&
        part !== "build" &&
        part !== "node_modules"
    );
  return parts[parts.length - 1] ?? normalized;
}

function joinPaths(base: string, extra: string): string {
  if (isAbsoluteLike(extra)) {
    return extra;
  }
  const left = base.replace(/\\/g, "/").replace(/\/$/, "");
  const right = extra.replace(/\\/g, "/").replace(/^\.\//, "");
  return `${left}/${right}`;
}

function isAbsoluteLike(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}
