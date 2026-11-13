type GuardInput = {
  tool: string;
  file_path?: unknown;
  notebook_path?: unknown;
  edits?: unknown;
  command?: unknown;
};
type GuardOptions = {
  stat: (path: string) => Promise<{ realPath?: string } | undefined>;
  cwd?: string;
  after?: (ms: number, fn: () => void) => { cancel: () => void };
  home?: string;
  configDir?: string;
  platform?: NodeJS.Platform;
};
export const PROTECTED: Readonly<Record<'settings' | 'cache' | 'windowsCache' | 'install' | 'aboveSleight' | 'aboveInstall' | 'launcher' | 'shim' | 'unknownDirectory' | 'unresolved' | 'oversized', string>>;
export const MAX_PROTECTED_COMMAND: number;
export const guardUnavailableReason: string;
export const guardPathReason: string;
export function preapprovedWriteTarget(input: GuardInput, options: GuardOptions): Promise<string | undefined>;
export function preapprovedWriteDenied(input: GuardInput, options: GuardOptions): Promise<boolean>;
export function preapprovedWriteReason(label: string): string;
export function loggingSwitchWriteDenied(input: unknown): boolean;
