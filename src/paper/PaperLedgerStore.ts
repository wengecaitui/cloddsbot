// Stage 3B4C8-R1: Paper Ledger Store — full identity binding, write safety, tmp cleanup.
import * as fs from 'fs/promises';
import * as path from 'path';
import type { PaperAccountConfig, PaperLedgerEntry, PaperLedgerDocumentV1 } from '../types/paper-account';
import { validatePaperAccountConfig, canonicalizePaperAccountConfig } from '../types/paper-account';
import { PaperAccountLedger } from './PaperAccountLedger';
import { roundUsd } from './PaperLedgerMath';
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
  tmpSuffix?: string;
}

export class PaperLedgerStore {
  private readonly baseDir: string;
  private readonly config: PaperAccountConfig;
  private readonly canonicalCash: number;

  constructor(config: PaperAccountConfig, opts: PaperLedgerStoreOptions = {}) {
    // R3: shared canonical config
    this.config = canonicalizePaperAccountConfig(config);
    this.canonicalCash = roundUsd(this.config.initialCashUsd);
    this.baseDir = opts.baseDir ?? DEFAULT_BASE_DIR;
    if (opts.tmpSuffix) this._tmpSuffix = opts.tmpSuffix;
  }

  private _tmpSuffix?: string;
  private tmpSuffix(): string {
    return this._tmpSuffix || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private filePath(): string {
    return path.join(this.baseDir, `account.${this.config.exchange}.${this.config.accountId}.json`);
  }

  private tempFilePath(): string {
    return `${this.filePath()}.${this.tmpSuffix()}.tmp`;
  }

  // R1: identity binding — save rejects mismatched ledger
  async save(ledger: PaperAccountLedger): Promise<void> {
    const lc = ledger.getConfig();
    if (lc.accountId !== this.config.accountId || lc.exchange !== this.config.exchange) {
      throw new PaperLedgerIdentityMismatchError(
        `save: ledger (${lc.accountId},${lc.exchange}) != store (${this.config.accountId},${this.config.exchange})`,
      );
    }
    if (roundUsd(lc.initialCashUsd) !== this.canonicalCash) {
      throw new PaperLedgerIdentityMismatchError(
        `save: initialCash mismatch ${roundUsd(lc.initialCashUsd)} vs ${this.canonicalCash}`,
      );
    }
    const entries = ledger.entries();
    const doc: PaperLedgerDocumentV1 = { version: 1, config: this.config, entries };
    const json = JSON.stringify(doc, null, 2);
    await fs.mkdir(this.baseDir, { recursive: true });
    const tmp = this.tempFilePath();
    try {
      await fs.writeFile(tmp, json, 'utf-8');
      await fs.rename(tmp, this.filePath());
    } catch (e) {
      // Clean up tmp on any failure
      try { await fs.unlink(tmp); } catch {}
      throw e;
    }
  }

  async load(): Promise<PaperAccountLedger | null> {
    try {
      const raw = await fs.readFile(this.filePath(), 'utf-8');
      let doc: any;
      try { doc = JSON.parse(raw); } catch {
        throw new PaperLedgerCorruptionError('Failed to parse ledger JSON');
      }
      // R1: strict doc validation
      if (!doc || typeof doc !== 'object' || Array.isArray(doc))
        throw new PaperLedgerCorruptionError('Document is not a plain object');
      if (doc.version !== 1) throw new UnsupportedPaperLedgerVersionError(`Version: ${doc?.version ?? 'missing'}`);
      const config = doc.config;
      if (!config || typeof config !== 'object') throw new PaperLedgerCorruptionError('Missing config');
      // Validate config — wrap any validation error as corruption
      try { validatePaperAccountConfig(config); } catch (e) {
        throw new PaperLedgerCorruptionError(`persisted config invalid: ${(e as Error).message}`);
      }
      if (config.exchange !== this.config.exchange) throw new PaperLedgerIdentityMismatchError('Exchange mismatch on load');
      if (config.accountId !== this.config.accountId) throw new PaperLedgerIdentityMismatchError('AccountId mismatch on load');
      if (roundUsd(config.initialCashUsd) !== this.canonicalCash) throw new PaperLedgerIdentityMismatchError('initialCash mismatch on load');
      // R1: entries must be an array
      if (!doc.entries || !Array.isArray(doc.entries)) throw new PaperLedgerCorruptionError('entries must be an array');
      const entries: PaperLedgerEntry[] = doc.entries;
      // R2: wrap replay errors as corruption
      try { return PaperAccountLedger.fromEntries(this.config, entries); } catch (e) {
        if (e instanceof PaperLedgerCorruptionError) throw e;
        throw new PaperLedgerCorruptionError(`load replay failed: ${(e as Error).message}`);
      }
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
}
