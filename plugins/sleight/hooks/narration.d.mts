export function narrationLine(raw: unknown, input?: unknown): string | undefined;
export function assistantNarration(messages: unknown, toolId: unknown, input?: unknown): string | undefined;
export function createNarrationCache(): {
  configure(mode: unknown): void;
  reset(): void;
  observe(event: { agentId?: string; uuid?: string; door?: string; origin?: { kind?: string }; message?: unknown }): void;
  take(event: { agentId?: string; tool_use_id?: string; code?: unknown }): string | undefined;
};
export function boundedNarration(raw: string): string;
