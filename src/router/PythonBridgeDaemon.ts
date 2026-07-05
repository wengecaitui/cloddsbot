/**
 * PythonBridgeDaemon.ts
 * Phase 4.2: TS ↔ Python 跨语言管道桥接器
 *
 * 协议: JSON Lines over stdin/stdout
 * - TS → Python: spawn + stdin.write(JSON + '\n')
 * - Python → TS: readline → handleIncomingMessage
 * - 超时: 默认 2s，Fast Pipeline 守门
 */

import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';

interface CalcRequest {
    asset: string;
    series: Array<{ open: number; high: number; low: number; close: number; volume: number }>;
    indicators: Array<{ name: string; params: Record<string, any> }>;
}

interface PendingRequest {
    resolve: (val: any) => void;
    reject: (err: any) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class PythonBridgeDaemon {
    private pythonProcess: ChildProcess | null = null;
    private rl: readline.Interface | null = null;
    private scriptPath: string;

    // correlationId → Promise 寄存器
    private pendingRequests: Map<string, PendingRequest> = new Map();

    constructor(scriptPath: string = 'quant_engine/daemon.py') {
        this.scriptPath = scriptPath;
    }

    /**
     * 启动 Python 守护进程并绑定管道
     * 握手验证 PING/PONG 通过后才 resolve
     */
    public async init(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.pythonProcess = spawn('python', [this.scriptPath], {
                env: { ...process.env, PYTHONUNBUFFERED: '1' }
            });

            if (!this.pythonProcess.stdin || !this.pythonProcess.stdout) {
                return reject(new Error('无法开辟 Python stdio 管道通道'));
            }

            this.rl = readline.createInterface({
                input: this.pythonProcess.stdout,
                terminal: false
            });

            this.rl.on('line', (line: string) => this.handleIncomingMessage(line));

            // 进程故障 → 熔断
            this.pythonProcess.on('error', (err: Error) => {
                console.error('Python 守护进程物理异常:', err);
                this.panicMeltdown();
            });

            this.pythonProcess.on('close', (code: number | null) => {
                console.warn(`Python 守护进程断开，退出码: ${code}`);
                this.panicMeltdown();
            });

            // 握手验证
            this.ping()
                .then(() => resolve())
                .catch(reject);
        });
    }

    /**
     * 处理 Python 侧回吐的数据行
     */
    private handleIncomingMessage(line: string): void {
        try {
            const payload = JSON.parse(line);
            const cid: string | undefined = payload.correlationId;
            if (!cid) return;

            const pending = this.pendingRequests.get(cid);
            if (!pending) return;

            clearTimeout(pending.timer);
            this.pendingRequests.delete(cid);

            if (payload.type === 'ERROR' || payload.status === 'FAILED') {
                pending.reject(new Error(
                    `Python 计算层报错 [${payload.correlationId}]: ${payload.error}\n${payload.traceback || ''}`
                ));
            } else {
                pending.resolve(payload);
            }
        } catch (e) {
            console.error('解析管道 JSON 行失败:', e, 'raw:', line.slice(0, 100));
        }
    }

    /**
     * 发送 PING 握手请求
     */
    private async ping(timeoutMs: number = 1000): Promise<void> {
        return this.sendPayload('PING', {}, timeoutMs);
    }

    /**
     * 向 Python 发送计算请求（快路径核心调用）
     * @param timeoutMs 超时毫秒，默认 2000ms（2s 硬熔断）
     */
    public async calculate(req: CalcRequest, timeoutMs: number = 2000): Promise<any> {
        return this.sendPayload('CALC', req, timeoutMs);
    }

    /**
     * 通用 payload 发送器（带 correlationId 和超时控制）
     */
    private sendPayload(type: string, body: Record<string, any>, timeoutMs: number): Promise<any> {
        if (!this.pythonProcess || !this.pythonProcess.stdin) {
            return Promise.reject(new Error('Python 进程未就绪，拒绝派发计算任务'));
        }

        const cid = Math.random().toString(36).substring(2, 15);
        const payload = { type, correlationId: cid, ...body };

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(cid);
                reject(new Error(`管道通信超时 [${type}] - correlationId=${cid}，超过 ${timeoutMs}ms 未响应`));
            }, timeoutMs);

            this.pendingRequests.set(cid, { resolve, reject, timer });

            try {
                this.pythonProcess!.stdin!.write(JSON.stringify(payload) + '\n');
            } catch (err) {
                clearTimeout(timer);
                this.pendingRequests.delete(cid);
                reject(new Error(`写入管道失败: ${err}`));
            }
        });
    }

    /**
     * 紧急故障熔断
     * 清理所有悬挂请求，上报 KillSwitch（后续 Phase 3a 接入）
     */
    private panicMeltdown(): void {
        this.rl?.close();

        // 标记所有悬挂请求为失败
        for (const [cid, pending] of this.pendingRequests.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Python 计算层进程意外死亡，请求被迫中断'));
        }
        this.pendingRequests.clear();

        // TODO Phase 3a: 触发 KillSwitch 锁死后续交易面
        // this.killSwitch.trigger('PYTHON_DAEMON_DEAD');

        this.pythonProcess = null;
    }

    /**
     * 优雅关闭
     */
    public shutdown(): void {
        this.panicMeltdown();
        if (this.pythonProcess) {
            try {
                this.pythonProcess.kill('SIGTERM');
            } catch {
                // 忽略
            }
        }
    }
}
