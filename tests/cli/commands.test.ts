import { describe, test, expect } from "bun:test";
import {
  parseCommand,
  isParsedCommand,
  formatCommandError,
  SUBCOMMANDS,
} from "../../src/cli/commands.ts";

describe("parseCommand - valid subcommands", () => {
  test("parses 'connect' correctly", () => {
    const result = parseCommand("connect acme");
    expect(isParsedCommand(result)).toBe(true);
    if (isParsedCommand(result)) {
      expect(result.subcommand).toBe("connect");
      expect(result.args).toEqual(["acme"]);
    }
  });

  test("parses 'disconnect' correctly", () => {
    const result = parseCommand("disconnect");
    expect(isParsedCommand(result)).toBe(true);
    if (isParsedCommand(result)) {
      expect(result.subcommand).toBe("disconnect");
      expect(result.args).toEqual([]);
    }
  });

  test("parses 'ask' with target and question", () => {
    const result = parseCommand('ask backend "what does /users expect?"');
    expect(isParsedCommand(result)).toBe(true);
    if (isParsedCommand(result)) {
      expect(result.subcommand).toBe("ask");
      expect(result.args[0]).toBe("backend");
    }
  });

  test("parses 'sessions' correctly", () => {
    const result = parseCommand("sessions");
    expect(isParsedCommand(result)).toBe(true);
    if (isParsedCommand(result)) {
      expect(result.subcommand).toBe("sessions");
    }
  });

  test("parses 'status' correctly", () => {
    const result = parseCommand("status");
    expect(isParsedCommand(result)).toBe(true);
    if (isParsedCommand(result)) {
      expect(result.subcommand).toBe("status");
    }
  });

  test("parses 'shutdown' correctly", () => {
    const result = parseCommand("shutdown");
    expect(isParsedCommand(result)).toBe(true);
    if (isParsedCommand(result)) {
      expect(result.subcommand).toBe("shutdown");
    }
  });

  test("is case-insensitive", () => {
    const result = parseCommand("CONNECT acme");
    expect(isParsedCommand(result)).toBe(true);
    if (isParsedCommand(result)) {
      expect(result.subcommand).toBe("connect");
    }
  });

  test("handles extra whitespace", () => {
    const result = parseCommand("  ask   backend   question  ");
    expect(isParsedCommand(result)).toBe(true);
    if (isParsedCommand(result)) {
      expect(result.subcommand).toBe("ask");
      expect(result.args).toEqual(["backend", "question"]);
    }
  });
});

describe("parseCommand - typo correction", () => {
  test("suggests 'ask' for 'asc'", () => {
    const result = parseCommand("asc backend question");
    expect(isParsedCommand(result)).toBe(false);
    if (!isParsedCommand(result)) {
      expect(result.error).toContain('"asc"');
      expect(result.suggestion).toContain("ask");
    }
  });

  test("suggests 'connect' for 'conect'", () => {
    const result = parseCommand("conect acme");
    expect(isParsedCommand(result)).toBe(false);
    if (!isParsedCommand(result)) {
      expect(result.suggestion).toContain("connect");
    }
  });

  test("suggests 'shutdown' for 'shutdwn'", () => {
    const result = parseCommand("shutdwn");
    expect(isParsedCommand(result)).toBe(false);
    if (!isParsedCommand(result)) {
      expect(result.suggestion).toContain("shutdown");
    }
  });

  test("no suggestion for completely unrelated input", () => {
    const result = parseCommand("xyzxyzxyz");
    expect(isParsedCommand(result)).toBe(false);
    if (!isParsedCommand(result)) {
      expect(result.suggestion).toBeUndefined();
      expect(result.availableCommands).toEqual(SUBCOMMANDS);
    }
  });

  test("returns error for empty input", () => {
    const result = parseCommand("");
    expect(isParsedCommand(result)).toBe(false);
    if (!isParsedCommand(result)) {
      expect(result.error).toContain("No subcommand");
    }
  });

  test("returns error for whitespace-only input", () => {
    const result = parseCommand("   ");
    expect(isParsedCommand(result)).toBe(false);
    if (!isParsedCommand(result)) {
      expect(result.error).toContain("No subcommand");
    }
  });
});

describe("formatCommandError", () => {
  test("formats error with suggestion", () => {
    const msg = formatCommandError({
      error: 'Unknown command "asc".',
      suggestion: 'Did you mean "ask"?',
      availableCommands: SUBCOMMANDS,
    });
    expect(msg).toContain("asc");
    expect(msg).toContain("ask");
    expect(msg).toContain("Available commands:");
  });

  test("formats error without suggestion", () => {
    const msg = formatCommandError({
      error: 'Unknown command "xyz".',
      availableCommands: SUBCOMMANDS,
    });
    expect(msg).toContain("xyz");
    expect(msg).toContain("Available commands:");
    expect(msg).not.toContain("Did you mean");
  });
});
