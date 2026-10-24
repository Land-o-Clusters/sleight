export type TurnCounters = {
  calls: number; reads: number; characters: number; errors: number; pending: number;
  omitted: number; unclassified: number; toolMs: number;
  text: { docs: number; tree: number; other: number };
  paths: Record<'native' | 'turbo' | 'engine', { actions: number; estimatedActions: number; estimatedCalls: number; actionMs: number; timedActions: number }>;
};
export type CostSnapshot = { startedAt: number; usd: number };
export type TurnSummary = {
  durationMs: number | null;
  interrupted: boolean;
  tokens: Record<'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens', number | null> | null;
  costUsd: number | null;
  costDeltaUsd: number | null;
  stats: TurnCounters | null;
};
export function statsFromReply(reply: unknown): TurnCounters | null;
export function costSnapshot(value: unknown): CostSnapshot | null;
export function turnSummary(event: unknown, ledger: CostSnapshot | null, baseline?: CostSnapshot | null): TurnSummary;
export function turnStatsText(summary: TurnSummary | null): string;
