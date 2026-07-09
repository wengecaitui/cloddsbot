/**
 * ReportStore — MarketBiasReport 原子写入存储
 *
 * 解决 I/O Race Condition：
 *  fs.writeFile → bias.json.tmp → fs.renameSync → bias.json
 *  renameSync 在操作系统底层是原子操作，无耗时，完美避免读写冲突
 *
 * Phase 3b: 可无缝切换到 Redis SET/GET
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ReportStoreConfig {
  /** 存储目录，默认 ~/.clodds/market-bias */
  dir?: string;
  /** 主文件名 */
  filename?: string;
  /** 临时文件后缀 */
  tmpSuffix?: string;
}

export class ReportStore {
  private dir: string;
  private mainPath: string;
  private tmpPath: string;

  constructor(config: ReportStoreConfig = {}) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    this.dir = config.dir ?? path.join(home, '.clodds', 'market-bias');
    this.mainPath = path.join(this.dir, config.filename ?? 'bias.json');
    this.tmpPath = path.join(this.dir, `${config.filename ?? 'bias.json'}${config.tmpSuffix ?? '.tmp'}`);
  }

  /**
   * 原子写入：先写 .tmp，再 renameSync 覆盖原文件
   */
  async write(report: unknown): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const content = JSON.stringify(report, null, 2);
    await fs.promises.writeFile(this.tmpPath, content, 'utf-8');
    // renameSync 在 POSIX 和 Windows (MoveFileEx) 上均为原子覆盖操作，无需先 rmSync
    fs.renameSync(this.tmpPath, this.mainPath);
  }

  /**
   * 读取报告
   */
  async read<T>(): Promise<T | null> {
    try {
      const content = await fs.promises.readFile(this.mainPath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  /**
   * 检查主文件是否存在
   */
  exists(): boolean {
    return fs.existsSync(this.mainPath);
  }

  /**
   * 删除报告
   */
  async delete(): Promise<void> {
    try {
      await fs.promises.unlink(this.mainPath);
    } catch {
      // ignore
    }
  }
}
