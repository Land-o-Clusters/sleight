type GuardInput = {
  tool: string;
  file_path?: unknown;
  notebook_path?: unknown;
  edits?: unknown;
  command?: unknown;
};
type GuardOptions = {
  stat: (path: string) => Promise<{ realPath?: string } | undefined>;
  home?: string;
  configDir?: string;
};
export const PROTECTED: Readonly<Record<'settings' | 'cache' | 'install' | 'aboveSleight' | 'aboveInstall' | 'launcher' | 'unresolved', string>>;
export const guardUnavailableReason: string;
export const guardPathReason: string;
export function preapprovedWriteTarget(input: GuardInput, options: GuardOptions): Promise<string | undefined>;
export function preapprovedWriteDenied(input: GuardInput, options: GuardOptions): Promise<boolean>;
export function preapprovedWriteReason(label: string): string;
export function loggingSwitchWriteDenied(input: unknown): boolean;
