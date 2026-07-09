/**
 * verify_recovery.ts — Sprint 2C Phase 1 Timeout Recovery E2E (修过 orphan scan 时序 bug)
 *
 * 验证 PythonBridgeDaemon 分级终止 + 自动重生。
 * 不修改源码，纯黑盒。
 */
import { PythonBridgeDaemon } from '../src/router/PythonBridgeDaemon';
import { execSync } from 'child_process';

const ADAPTER = '.verify-sprint-2c/hang.py';
const TIMEOUT_MS = 2000;

function ts() { return new Date().toISOString().substr(11, 12); }

function listPids(): number[] {
    try {
        const out = execSync('tasklist /FI "IMAGENAME eq python.exe" /FO CSV /NH', { encoding: 'utf-8' });
        return out.split('\n')
            .filter(l => l.startsWith('"python.exe"'))
            .map(l => parseInt(l.split('","')[1].replace(/"/g, '')))
            .filter(n => !isNaN(n));
    } catch { return []; }
}

/** 轮询 tasklist 直到 PID 消失或超时，返回 true 表示已退出 */
async function waitForPidExit(pid: number, maxMs = 8000): Promise<boolean> {
    for (let i = 0; i < maxMs / 500; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (!listPids().includes(pid)) return true;
    }
    return false;
}

async function main() {
    console.log('=== Sprint 2C Phase 1 — Timeout Recovery Validation ===');
    console.log(`[${ts()}] start`);

    // 1. spawn hang adapter, record PID₁
    const b1 = new PythonBridgeDaemon(ADAPTER);
    await b1.init();
    const pid1 = (b1 as any).pythonProcess?.pid;
    console.log(`[${ts()}] PID₁: ${pid1}`);
    if (!pid1) { console.error('FAIL: no PID₁'); process.exit(1); }

    // 2. send CALC that hangs → expect reject in ~2s
    const t0 = Date.now();
    let rejectMs: number | null = null, rejectMsg = '';
    try {
        await b1.calculate({ asset: 'X', series: [], indicators: [{ name: 'HANG', params: {} }] }, TIMEOUT_MS);
    } catch (e: any) { rejectMs = Date.now() - t0; rejectMsg = e.message; }

    if (!rejectMs) { console.error('FAIL: no reject'); process.exit(1); }
    console.log(`[${ts()}] reject after ${rejectMs}ms: ${rejectMsg}`);

    // 3. wait for SIGTERM → exit (轮询 tasklist)
    const exitOk = await waitForPidExit(pid1);
    const refClear = (b1 as any).pythonProcess === null;
    console.log(`[${ts()}] PID₁ exited: ${exitOk}, ref cleared: ${refClear}`);
    if (!exitOk || !refClear) { console.error('FAIL: PID₁ not reaped'); process.exit(1); }

    // 4. respawn 新 worker
    b1.shutdown();
    await new Promise(r => setTimeout(r, 300));
    const b2 = new PythonBridgeDaemon(ADAPTER);
    await b2.init();
    const pid2 = (b2 as any).pythonProcess?.pid;
    console.log(`[${ts()}] PID₂: ${pid2} ≠ ${pid1}: ${pid2 !== pid1}`);
    if (!pid2 || pid2 === pid1) { console.error('FAIL: PID₂ not fresh'); process.exit(1); }

    // 5. PING via init()
    console.log(`[${ts()}] PING via init(): SUCCESS`);

    // 6. cleanup + orphan scan (修复: 显式轮询等 PID₂ 完全退出)
    b2.shutdown();
    const pid2Exited = await waitForPidExit(pid2, 8000);
    console.log(`[${ts()}] PID₂ exited after shutdown: ${pid2Exited}`);

    const finalPids = listPids();
    const orphaned = finalPids.includes(pid1) || finalPids.includes(pid2);
    console.log(`[${ts()}] orphaned: ${orphaned ? 'YES ❌' : 'NONE ✅'}`);

    if (orphaned) { console.error('FAIL: orphaned PIDs'); process.exit(1); }
    console.log(`[${ts()}] FINAL: PASS ✅`);
    process.exit(0);
}
main().catch(e => { console.error('FATAL:', e); process.exit(2); });
