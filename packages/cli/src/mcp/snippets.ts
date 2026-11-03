/**
 * `align mcp --print-config <agent>` (docs/14 §Local MCP server): the snippet for an agent `init` does not register
 * itself. Each runs the shim with `mcp`; nothing secret is in any of them (the token stays in the credential record).
 */
import { CLI_BIN } from "@align/core/brand";

export const PRINT_CONFIG_AGENTS = ["gemini", "hermes", "openclaw", "generic"] as const;

const json = (shim: string) =>
  `${JSON.stringify({ mcpServers: { [CLI_BIN]: { command: shim, args: ["mcp"] } } }, null, 2)}\n`;

/** YAML double-quoted scalar (JSON's escaping is valid YAML). */
const yq = (s: string) => JSON.stringify(s);

export function printConfig(agent: string, shim: string): string | null {
  switch (agent) {
    case "gemini":
      return `# Gemini CLI: merge into ~/.gemini/settings.json (or run: gemini mcp add ${CLI_BIN} ${shim} mcp)\n${json(shim)}`;
    case "hermes":
      return `# Hermes Agent: add to ~/.hermes/config.yaml\nmcp_servers:\n  ${CLI_BIN}:\n    command: ${yq(shim)}\n    args: ["mcp"]\n`;
    case "openclaw":
      return `# OpenClaw: add to the MCP servers in its configuration\n${json(shim)}`;
    case "generic":
      return `# Any MCP client that starts stdio servers: command and arguments\n${json(shim)}`;
    default:
      return null;
  }
}
