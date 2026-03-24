import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SummaryEntry, GenerateFn, QueryFn, EnrichFn } from "./types.ts";

const GENERATE_PROMPT = `Summarize everything you know about this codebase from your current session context.
For each piece of knowledge, provide:
- TOPIC: A short descriptive label
- FACTS: Key information in 1-3 sentences

Cover all areas you've explored:
- Project structure and key files/directories
- Architecture and design patterns
- Functions, classes, modules, and their responsibilities
- Data models, schemas, types, or database tables
- API endpoints, routes, or interfaces (if any)
- Configuration, environment setup, dependencies
- Build, test, and deployment details
- Any important business logic or domain concepts

Be thorough. Include everything you've learned, regardless of the technology or language.
Format each entry as:
TOPIC: <label>
FACTS: <facts>

Separate entries with a blank line.`;

const QUERY_SYSTEM_PROMPT = `Answer ONLY using the facts provided in the context below.
Do NOT use any external knowledge or make assumptions.
If the provided context does not contain enough information to answer
the question confidently, you MUST respond with exactly one word:
INSUFFICIENT_CONTEXT
Do not attempt to guess, infer, or provide partial answers.`;

const ENRICH_SYSTEM_PROMPT = `Extract the key factual information from this Q&A into a concise knowledge entry.
Output exactly in this format:
TOPIC: <a short descriptive label>
FACTS: <key facts in 1-3 sentences>`;

function parseEntries(text: string): SummaryEntry[] {
  const entries: SummaryEntry[] = [];
  const blocks = text.split(/\n\s*\n/);

  for (const block of blocks) {
    const topicMatch = block.match(/TOPIC:\s*(.+)/i);
    const factsMatch = block.match(/FACTS:\s*([\s\S]+)/i);

    if (topicMatch && factsMatch) {
      entries.push({
        topic: topicMatch[1]!.trim(),
        content: factsMatch[1]!.trim(),
        addedAt: Date.now(),
      });
    }
  }

  return entries;
}

async function collectResult(stream: AsyncGenerator<SDKMessage, void>): Promise<string> {
  let result = "";
  for await (const message of stream) {
    if (message.type === "result" && message.subtype === "success") {
      result = message.result;
    }
  }
  return result;
}

export const defaultGenerateFn: GenerateFn = async (claudeSessionId, cwd?) => {
  const stream = query({
    prompt: GENERATE_PROMPT,
    options: {
      resume: claudeSessionId,
      forkSession: true,
      cwd,
      allowedTools: ["Read", "Glob", "Grep"],
      persistSession: false,
      maxTurns: 3,
      effort: "medium",
    },
  });

  const text = await collectResult(stream);
  return parseEntries(text);
};

export const defaultQueryFn: QueryFn = async (entries, question) => {
  const context = entries
    .map((e) => `[${e.topic}]: ${e.content}`)
    .join("\n\n");

  const stream = query({
    prompt: `Context:\n${context}\n\nQuestion: ${question}`,
    options: {
      systemPrompt: QUERY_SYSTEM_PROMPT,
      tools: [],
      persistSession: false,
      maxTurns: 1,
      effort: "low",
    },
  });

  return await collectResult(stream);
};

export const defaultEnrichFn: EnrichFn = async (question, answer) => {
  const stream = query({
    prompt: `Question: ${question}\nAnswer: ${answer}`,
    options: {
      systemPrompt: ENRICH_SYSTEM_PROMPT,
      tools: [],
      persistSession: false,
      maxTurns: 1,
      effort: "low",
    },
  });

  const text = await collectResult(stream);
  const entries = parseEntries(text);

  if (entries.length > 0) {
    return entries[0]!;
  }

  // Fallback: use question as topic, answer as content
  return {
    topic: question.slice(0, 100),
    content: answer.slice(0, 2000),
    addedAt: Date.now(),
  };
};

// Exported for testing
export { parseEntries };
