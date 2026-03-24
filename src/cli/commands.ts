import { fuzzyMatch } from "../utils/fuzzy.ts";

export const SUBCOMMANDS = [
  "connect",
  "disconnect",
  "ask",
  "sessions",
  "status",
  "shutdown",
] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

export interface ParsedCommand {
  subcommand: Subcommand;
  args: string[];
}

export interface CommandError {
  error: string;
  suggestion?: string;
  availableCommands: readonly string[];
}

export function isParsedCommand(
  result: ParsedCommand | CommandError
): result is ParsedCommand {
  return "subcommand" in result;
}

export function parseCommand(input: string): ParsedCommand | CommandError {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const args = parts.slice(1);

  if (!cmd) {
    return {
      error: "No subcommand provided.",
      availableCommands: SUBCOMMANDS,
    };
  }

  if ((SUBCOMMANDS as readonly string[]).includes(cmd)) {
    return { subcommand: cmd as Subcommand, args };
  }

  const suggestion = fuzzyMatch(cmd, [...SUBCOMMANDS]);
  return {
    error: `Unknown command "${cmd}".`,
    suggestion: suggestion ? `Did you mean "${suggestion}"?` : undefined,
    availableCommands: SUBCOMMANDS,
  };
}

export function formatCommandError(err: CommandError): string {
  let msg = err.error;
  if (err.suggestion) {
    msg += ` ${err.suggestion}`;
  }
  msg += `\nAvailable commands: ${err.availableCommands.join(", ")}`;
  return msg;
}
