export const shellGuardReason: string;
export function shellLaunchDenied(event: { tool: string; command?: unknown; platform?: 'win32' | 'darwin' | 'linux'; cwd?: string; home?: string }): boolean;
