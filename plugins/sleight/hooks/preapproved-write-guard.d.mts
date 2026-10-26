export function preapprovedWriteDenied(input: {
  tool: string;
  file_path?: unknown;
  notebook_path?: unknown;
  edits?: unknown;
  command?: unknown;
}, options: {
  stat: (path: string) => Promise<{ realPath?: string } | undefined>;
  home?: string;
  configDir?: string;
}): Promise<boolean>;
