/**
 * CLI agent discovery — mirrors Open Design's startup probe pipeline:
 * extended PATH scan → binary resolve → --version probe → optional help/capability
 * flags → model listing. Resolved agents are stored for later spawn/dispatch.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

// How stdout is parsed when an agent is spawned (used later by dispatch).
export type StreamFormat =
  | "claude-stream-json"
  | "acp-json-rpc"
  | "json-event-stream"
  | "pi-rpc"
  | "copilot-stream-json"
  | "plain";

export type ModelOption = { id: string; label: string };

export type AgentDef = {
  id: string;
  label: string;
  bin: string;
  fallbackBins?: string[];
  versionArgs?: string[];
  helpArgs?: string[];
  capabilityFlags?: string[];
  streamFormat: StreamFormat;
  promptViaStdin?: boolean;
  fallbackModels?: ModelOption[];
  listModels?: { args: string[] };
  /** Subcommand that starts ACP JSON-RPC mode (Devin, Kimi, etc.). */
  acpSubcommand?: string;
};

export type ResolvedAgent = {
  id: string;
  label: string;
  available: boolean;
  bin: string | null;
  resolvedPath: string | null;
  version: string | null;
  streamFormat: StreamFormat;
  promptViaStdin: boolean;
  models: ModelOption[];
  capabilities: Record<string, boolean>;
  acpSubcommand?: string;
};

// User-level install dirs GUI apps often omit from PATH.
const STATIC_TOOLCHAIN_DIRS = [
  "~/.local/bin",
  "~/.bun/bin",
  "~/.volta/bin",
  "~/.asdf/shims",
  "~/Library/pnpm",
  "~/.cargo/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

const TOOLCHAIN_CACHE_TTL_MS = 5_000;
const VERSION_PROBE_TIMEOUT_MS = 3_000;
const HELP_PROBE_TIMEOUT_MS = 5_000;
const MODEL_LIST_TIMEOUT_MS = 8_000;

const DEFAULT_MODEL: ModelOption = {
  id: "default",
  label: "Default (CLI config)",
};

// Populated by discoverAgents(); read via getDiscoveredAgents().
let discoveredAgents: ResolvedAgent[] = [];

let toolchainCache: { dirs: string[]; at: number } | null = null;

/** Expand ~ and glob-like node version manager bin trees. */
function expandToolchainDirs(): string[] {
  const home = homedir();
  const dirs = new Set<string>();

  for (const entry of STATIC_TOOLCHAIN_DIRS) {
    const path = entry.startsWith("~/") ? join(home, entry.slice(2)) : entry;
    if (existsSync(path)) dirs.add(path);
  }

  // Optional override: extra search roots (same env name as Open Design).
  const agentHome = process.env.OD_AGENT_HOME ?? process.env.TBLANG_AGENT_HOME;
  if (agentHome) {
    const expanded = agentHome.startsWith("~/")
      ? join(home, agentHome.slice(2))
      : agentHome;
    if (existsSync(expanded)) dirs.add(expanded);
  }

  const globDirs = [
    join(home, ".nvm/versions/node"),
    join(home, ".fnm/node-versions"),
    join(home, ".local/share/mise/installs/node"),
  ];

  for (const root of globDirs) {
    if (!existsSync(root)) continue;
    try {
      for (const entry of readdirSync(root)) {
        const binCandidates = [
          join(root, entry, "bin"),
          join(root, entry, "installation", "bin"),
        ];
        for (const binDir of binCandidates) {
          if (existsSync(binDir)) dirs.add(binDir);
        }
      }
    } catch {
      // Ignore unreadable version-manager trees.
    }
  }

  return [...dirs];
}

/** Deduplicated PATH segments: process PATH + common user CLI install locations. */
function getToolchainDirs(): string[] {
  const now = Date.now();
  if (toolchainCache && now - toolchainCache.at < TOOLCHAIN_CACHE_TTL_MS) {
    return toolchainCache.dirs;
  }

  const segments = new Set<string>();
  const pathEnv = process.env.PATH ?? "";
  for (const part of pathEnv.split(":")) {
    if (part) segments.add(part);
  }
  for (const dir of expandToolchainDirs()) {
    segments.add(dir);
  }

  const dirs = [...segments];
  toolchainCache = { dirs, at: now };
  return dirs;
}

/** Find the first executable file named `bin` on the extended PATH. */
function resolveOnPath(bin: string): string | null {
  const isWindows = process.platform === "win32";
  const pathext = isWindows
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const dir of getToolchainDirs()) {
    for (const ext of pathext) {
      const candidate = join(dir, bin + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve primary bin, then fallbackBins in order. */
function resolveAgentExecutable(def: AgentDef): string | null {
  const names = [def.bin, ...(def.fallbackBins ?? [])];
  for (const name of names) {
    const resolved = resolveOnPath(name);
    if (resolved) return resolved;
  }
  return null;
}

type ProbeRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

/** Run a CLI with a timeout; used for --version, --help, and model listing. */
async function runProbe(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<ProbeRunResult> {
  const proc = Bun.spawn([executable, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      ok: !timedOut && exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch {
    return { ok: false, stdout: "", stderr: "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Scan --help output for optional flags the installed binary supports. */
async function probeCapabilities(
  executable: string,
  def: AgentDef,
): Promise<Record<string, boolean>> {
  const caps: Record<string, boolean> = {};
  if (!def.helpArgs?.length || !def.capabilityFlags?.length) return caps;

  const result = await runProbe(executable, def.helpArgs, HELP_PROBE_TIMEOUT_MS);
  const helpText = `${result.stdout}\n${result.stderr}`;

  for (const flag of def.capabilityFlags) {
    caps[flag] = helpText.includes(flag);
  }
  return caps;
}

/** Parse `provider/model` lines from models subcommands (OpenCode, Cursor Agent). */
function parseProviderModelLines(text: string): ModelOption[] {
  const models: ModelOption[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Skip header-ish lines.
    if (/^(model|id|name)s?$/i.test(trimmed)) continue;
    const id = trimmed.split(/\s+/)[0] ?? trimmed;
    if (!id.includes("/") && !id.includes(":")) continue;
    models.push({ id, label: id });
  }
  return models;
}

/** List models via subcommand or fall back to static hints. */
async function resolveModels(
  executable: string,
  def: AgentDef,
): Promise<ModelOption[]> {
  if (executable && def.listModels) {
    const result = await runProbe(
      executable,
      def.listModels.args,
      MODEL_LIST_TIMEOUT_MS,
    );
    const text = result.stdout || result.stderr;
    const parsed = parseProviderModelLines(text);
    if (parsed.length > 0) {
      return [DEFAULT_MODEL, ...parsed];
    }
  }

  const fallback = def.fallbackModels ?? [];
  return fallback.length > 0 ? [DEFAULT_MODEL, ...fallback] : [DEFAULT_MODEL];
}

/** Probe one AGENT_DEF: PATH → version → capabilities → models. */
async function probe(def: AgentDef): Promise<ResolvedAgent> {
  const base: ResolvedAgent = {
    id: def.id,
    label: def.label,
    available: false,
    bin: def.bin,
    resolvedPath: null,
    version: null,
    streamFormat: def.streamFormat,
    promptViaStdin: def.promptViaStdin ?? false,
    models: [DEFAULT_MODEL],
    capabilities: {},
    acpSubcommand: def.acpSubcommand,
  };

  const resolvedPath = resolveAgentExecutable(def);
  if (!resolvedPath) {
    base.models = await resolveModels("", def);
    return base;
  }

  base.resolvedPath = resolvedPath;

  const versionArgs = def.versionArgs ?? ["--version"];
  const versionResult = await runProbe(
    resolvedPath,
    versionArgs,
    VERSION_PROBE_TIMEOUT_MS,
  );

  if (!versionResult.ok) {
    return base;
  }

  const versionLine =
    versionResult.stdout.split("\n")[0] ||
    versionResult.stderr.split("\n")[0] ||
    null;
  base.version = versionLine;
  base.available = true;
  base.capabilities = await probeCapabilities(resolvedPath, def);
  base.models = await resolveModels(resolvedPath, def);

  return base;
}

/**
 * Static registry of supported CLI agents. Spawn/buildArgs wiring comes later;
 * detection fields align with Open Design's AGENT_DEFS shape.
 */
export const AGENT_DEFS: AgentDef[] = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    fallbackBins: ["openclaude"],
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    capabilityFlags: ["--add-dir", "--include-partial-messages"],
    streamFormat: "claude-stream-json",
    promptViaStdin: true,
    fallbackModels: [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    versionArgs: ["--version"],
    streamFormat: "json-event-stream",
    promptViaStdin: true,
    fallbackModels: [
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "o3", label: "o3" },
    ],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    versionArgs: ["--version"],
    streamFormat: "json-event-stream",
    promptViaStdin: true,
    fallbackModels: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }],
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    versionArgs: ["--version"],
    streamFormat: "json-event-stream",
    promptViaStdin: true,
    listModels: { args: ["models"] },
    fallbackModels: [{ id: "default", label: "OpenCode default" }],
  },
  {
    id: "cursor-agent",
    label: "Cursor Agent",
    bin: "cursor-agent",
    fallbackBins: ["agent", "cursor"],
    versionArgs: ["--version"],
    streamFormat: "json-event-stream",
    promptViaStdin: true,
    listModels: { args: ["models"] },
    fallbackModels: [{ id: "composer-2.5", label: "Composer 2.5" }],
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    bin: "copilot",
    fallbackBins: ["github-copilot-cli"],
    versionArgs: ["--version"],
    streamFormat: "copilot-stream-json",
    promptViaStdin: false,
    fallbackModels: [{ id: "gpt-4.1", label: "GPT-4.1" }],
  },
  {
    id: "pi",
    label: "Pi",
    bin: "pi",
    versionArgs: ["--version"],
    streamFormat: "pi-rpc",
    fallbackModels: [{ id: "default", label: "Pi default" }],
  },
  {
    id: "qwen",
    label: "Qwen Code",
    bin: "qwen",
    versionArgs: ["--version"],
    streamFormat: "plain",
    fallbackModels: [{ id: "qwen-max", label: "Qwen Max" }],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    bin: "deepseek",
    fallbackBins: ["deepseek-cli"],
    versionArgs: ["--version"],
    streamFormat: "plain",
    promptViaStdin: false,
    fallbackModels: [{ id: "deepseek-chat", label: "DeepSeek Chat" }],
  },
  // ACP-backed agents — full JSON-RPC session comes later; we only detect the binary.
  {
    id: "devin",
    label: "Devin",
    bin: "devin",
    versionArgs: ["--version"],
    streamFormat: "acp-json-rpc",
    acpSubcommand: "acp",
    fallbackModels: [{ id: "devin-default", label: "Devin default" }],
  },
  {
    id: "hermes",
    label: "Hermes",
    bin: "hermes",
    versionArgs: ["--version"],
    streamFormat: "acp-json-rpc",
    acpSubcommand: "acp",
    fallbackModels: [{ id: "hermes-default", label: "Hermes default" }],
  },
  {
    id: "kimi",
    label: "Kimi",
    bin: "kimi",
    fallbackBins: ["kimi-cli"],
    versionArgs: ["--version"],
    streamFormat: "acp-json-rpc",
    acpSubcommand: "acp",
    fallbackModels: [{ id: "kimi-default", label: "Kimi default" }],
  },
  {
    id: "kiro",
    label: "Kiro",
    bin: "kiro",
    versionArgs: ["--version"],
    streamFormat: "acp-json-rpc",
    acpSubcommand: "acp",
    fallbackModels: [{ id: "kiro-default", label: "Kiro default" }],
  },
  {
    id: "kilo",
    label: "Kilo",
    bin: "kilo",
    versionArgs: ["--version"],
    streamFormat: "acp-json-rpc",
    acpSubcommand: "acp",
    fallbackModels: [{ id: "kilo-default", label: "Kilo default" }],
  },
  {
    id: "mistral-vibe",
    label: "Mistral Vibe",
    bin: "vibe",
    fallbackBins: ["mistral-vibe"],
    versionArgs: ["--version"],
    streamFormat: "acp-json-rpc",
    acpSubcommand: "acp",
    fallbackModels: [{ id: "mistral-large", label: "Mistral Large" }],
  },
];

/** Agents found at last discoverAgents() run (available and unavailable). */
export function getDiscoveredAgents(): readonly ResolvedAgent[] {
  return discoveredAgents;
}

/** Only agents that passed PATH + version probe. */
export function getAvailableAgents(): ResolvedAgent[] {
  return discoveredAgents.filter((a) => a.available);
}

/**
 * Run parallel probes for every AGENT_DEF and store results module-wide.
 * Call once at program startup before using agents.
 */
export async function discoverAgents(): Promise<ResolvedAgent[]> {
  discoveredAgents = await Promise.all(AGENT_DEFS.map((def) => probe(def)));
  return discoveredAgents;
}
