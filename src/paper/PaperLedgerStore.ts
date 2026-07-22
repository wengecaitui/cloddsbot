// Stage 3B4C8: Paper Ledger Store — atomic file persistence only.
// Does NOT perform accounting math, fix corruption, or trust cached snapshots.

import * as fs from 'fs/promises';
import * as path from 'path';
import type { PaperAccountConfig, PaperLedgerEntry, PaperLedgerDocumentV1 } from '../types/paper-account';
import { PaperAccountLedger } from './PaperAccountLedger';
import {
  PaperLedgerCorruptionError, UnsupportedPaperLedgerVersionError,
  PaperLedgerIdentityMismatchError,
} from './errors';

const DEFAULT_BASE_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? '.',
  '.clodds', 'paper-ledger',
);

export interface PaperLedgerStoreOptions {
  baseDir?: string;
  /** Injected for tests to isolate concurrent Store instances. */
  tmpSuffix?: string;
}

export class PaperLedgerStore {
  private readonly baseDir: string;
  private readonly tmpSuffix: string;

  constructor(private readonly config: PaperAccountConfig, opts: PaperLedgerStoreOptions = {}) {
    this.baseDir = opts.baseDir ?? DEFAULT_BASE_DIR;
    this.tmpSuffix = opts.tmpSuffix ?? '';
  }

  private filePath(): string {
    return path.join(this.baseDir, `account.${this.config.exchange}.${this.config.accountId}.json`);
  }

  private tempFilePath(): string {
    const base = this.filePath();
    const suffix = this.tmpSuffix || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return `${base}.${suffix}.tmp`;
  }

  async save(ledger: PaperAccountLedger): Promise<void> {
    const entries = ledger.entries();
    const doc: PaperLedgerDocumentV1 = {
      version: 1,
      config: this.config,
      entries,
    };
    const json = JSON.stringify(doc, null, 2);
    await fs.mkdir(this.baseDir, { recursive: true });
    const tmp = this.tempFilePath();
    await fs.writeFile(tmp, json, 'utf-8');
    try {
      await fs.rename(tmp, this.filePath());
    } catch (e) {
      // Clean up temp file on rename failure
      try { await fs.unlink(tmp); } catch {}
      throw e;
    }
  }

  async load(): Promise<PaperAccountLedger | null> {
    try {
      const raw = await fs.readFile(this.filePath(), 'utf-8');
      let doc: any;
      try {
        doc = JSON.parse(raw);
      } catch {
        throw new PaperLedgerCorruptionError('Failed to parse ledger JSON');
      }
      if (!doc || doc.version !== 1) {
        throw new UnsupportedPaperLedgerVersionError(
          `Unsupported version: ${doc?.version ?? 'missing'}`,
        );
      }
      const config = doc.config;
      if (!config || config.exchange !== this.config.exchange) {
        throw new PaperLedgerIdentityMismatchError(
          `Exchange mismatch: expected ${this.config.exchange}, got ${config?.exchange}`,
        );
      }
      if (!config || config.accountId !== this.config.accountId) {
        throw new PaperLedgerIdentityMismatchError(
          `AccountId mismatch: expected ${this.config.accountId}, got ${config?.accountId}`,
        );
      }
      const entries: PaperLedgerEntry[] = doc.entries ?? [];
      return PaperAccountLedger.fromEntries(this.config, entries);
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
}
