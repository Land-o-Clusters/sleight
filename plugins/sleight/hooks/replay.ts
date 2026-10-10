import type { LogEntry } from '../types'

export type ReplayScript = { sleightReplay: 1; steps: { tool: string; args: { code?: string; title?: string }; positions?: string[] }[] }
export type ReplayOutcome = {
  ok: boolean
  steps?: number
  step?: number
  error?: string
  waits: { step: number; waitedMs: number }[]
  remaining?: ReplayScript['steps']
  window?: string | null
  windowError?: string
}

// A filename is the whole argument, optionally quoted. No shell is involved.
export function fileArgument(text: string) {
  const path = text.trim()
  if (!path) throw new Error('Choose a JSON file.')
  if (path[0] === '"' || path[0] === "'") {
    if (path.at(-1) !== path[0] || path.length < 3) throw new Error('Close the filename quote.')
    return path.slice(1, -1)
  }
  return path
}

export function outcomeOf(result: { content?: { text?: string }[]; isError?: boolean }): ReplayOutcome {
  const text = (result.content ?? []).map(block => block.text ?? '').join('\n')
  if (result.isError) throw new Error(text)
  const outcome = JSON.parse(text)
  if (typeof outcome.ok !== 'boolean' || !Array.isArray(outcome.waits)) throw new Error('No replay outcome in the tool result.')
  return outcome
}

export function resultEntries(script: ReplayScript, outcome: ReplayOutcome, id: string, at: string): LogEntry[] {
  return outcome.waits.map(wait => {
    const step = script.steps[wait.step - 1]
    const failed = !outcome.ok && wait.step === outcome.step
    return {
      id: `${id}-${wait.step}`, at, status: failed ? 'error' : 'done',
      title: `Replay step ${wait.step}/${script.steps.length} ${step?.args.title ?? step?.tool ?? ''}: ${failed ? 'failed' : 'ok'} (waited ${wait.waitedMs} ms)${failed ? `: ${outcome.error}` : ''}`,
    }
  })
}
