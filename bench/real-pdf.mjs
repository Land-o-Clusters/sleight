import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOwned } from './preapproved-process.mjs';

const source = fileURLToPath(new URL('./real-pdf.swift', import.meta.url));
export function createPDFTool({ run = runOwned, temporaryRoot = tmpdir() } = {}) {
  let bank, executable, compilation, uncollected = false;
  process.once('exit', () => { if (bank && !uncollected) rmSync(bank, { recursive: true, force: true }); });
  async function execute(command, args, signal, timeoutMs) {
    const result = await run(command, args, { signal, timeoutMs });
    if (!result.groupClean) {
      uncollected = true;
      throw Object.assign(new Error('Owned PDF process group cleanup unconfirmed'), { groupClean: false });
    }
    if (result.timedOut || result.cancelled || result.spawnError || result.exit.code !== 0) {
      throw new Error(result.timedOut ? 'PDF helper timed out' : result.cancelled ? 'PDF helper cancelled' :
        result.spawnError ?? `PDF helper exited ${result.exit.code}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }
  async function pdfTool(args, signal) {
    signal?.throwIfAborted();
    if (uncollected) throw Object.assign(new Error('Owned PDF process group cleanup unconfirmed'), { groupClean: false });
    if (!executable) {
      compilation ??= (async () => {
        bank = mkdtempSync(join(temporaryRoot, 'real-pdf-cache-'));
        const path = join(bank, 'pdf-fixture');
        try {
          // Match the existing native fixtures' bounded allowance on a loaded host.
          await execute('/usr/bin/xcrun', ['swiftc', '-module-cache-path', bank, source, '-o', path], signal, 180000);
          executable = path;
        } catch (error) {
          if (!uncollected) { rmSync(bank, { recursive: true, force: true }); bank = undefined; }
          throw error;
        }
      })();
      try { await compilation; } finally { compilation = undefined; }
    }
    return JSON.parse(await execute(executable, args, signal, 15000));
  }
  return {
    async writeTestPDF(path, rotations = [0, 0], signal) { await pdfTool(['create', path, rotations.join(',')], signal); },
    async checkPDF(ctx) {
      try {
        const { rotations, texts } = await pdfTool(['read', ctx.pdf], ctx.signal);
        return rotations.length === 2 && rotations[0] === 0 && rotations[1] === 90 &&
          texts[0]?.includes('Page 1') && texts[1]?.includes('Page 2') || 'saved PDF must retain both pages, with only page 2 rotated clockwise 90 degrees';
      } catch (error) {
        if (error.groupClean === false) { ctx.pendingAcquisitions ??= new Set(); ctx.pendingAcquisitions.add('pdfProcess'); }
        return 'saved PDF is missing or unreadable';
      }
    },
  };
}
export const { writeTestPDF, checkPDF } = createPDFTool();
