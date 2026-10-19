import type { LogEntry } from "../stage/ConversationLog";
import type { ChatMessage } from "./LlmProvider";

export interface AgentCharacter {
  id: string;
  name: string;
  persona: string;
}

/**
 * Chat messages for `self` from the shared conversation log, so a character
 * remembers everything said on stage, whoever said it:
 * - its own lines → `assistant`
 * - other characters' lines → `user`, prefixed with `Name: `
 * - the user's lines → `user`
 * - stage directions → `user`, as `[Stage direction] ...`
 *
 * Stage directions are not `system` messages because many chat templates only
 * accept a system message at the start. Consecutive messages of the same
 * role are merged, since one reply is logged as several sentences and some
 * templates require roles to alternate. `maxEntries` keeps the most recent
 * log entries (0 keeps none).
 */
export function buildContext(
  entries: LogEntry[],
  self: AgentCharacter,
  nameOf: (characterId: string) => string,
  maxEntries: number,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const system = [
    self.persona.trim(),
    `You are ${self.name}. Lines from other characters start with their name and a colon; answer without one.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  messages.push({ role: "system", content: system });

  const recent = maxEntries > 0 ? entries.slice(-maxEntries) : [];
  for (const entry of recent) {
    const message: ChatMessage = entry.direction
      ? { role: "user", content: `[Stage direction] ${entry.text}` }
      : entry.user
        ? { role: "user", content: entry.text }
        : entry.character === self.id
          ? { role: "assistant", content: entry.text }
          : { role: "user", content: `${nameOf(entry.character)}: ${entry.text}` };
    const last = messages[messages.length - 1];
    if (messages.length > 1 && last.role === message.role) last.content += `\n${message.content}`;
    else messages.push(message);
  }
  return messages;
}

/** Drops a leading `Name:` the model may copy from the context's other speakers. */
export function stripOwnName(text: string, name: string): string {
  for (const colon of [":", "："]) {
    const prefix = `${name}${colon}`;
    if (text.startsWith(prefix)) return text.slice(prefix.length).trimStart();
  }
  return text;
}
