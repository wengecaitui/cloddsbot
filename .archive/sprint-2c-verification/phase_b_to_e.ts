/**
 * Phase B-E combined validation script
 * Covers: Timeout Recovery, Consecutive Recovery, Mixed Workload, Resource Recovery
 * Evidence-driven. No source code modification.
 */
import { PythonBridgeDaemon } from '../src/router/PythonBridgeDaemon';
import { execSync } from 'child_process';

const HANG = '.verify-sprint-2c/hang.py';
const FAST = '.verify-sprint-2c/phase_a_adapter.py';
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

async function main() {
    const baselinePids = listPids();
    console.log(`[${ts()}] Baseline python PIDs: ${baselinePids.length} (${JSON.stringify(baselinePids)})`);

    // ═══════════════════════════════════════════════════════════
    // Phase B — Timeout Recovery (single)
    // ═══════════════════════════════════════════════════════════
    console.log('\n=== Phase B — Timeout Recovery ===');
    const bB = new PythonBridgeDaemon(HANG);
    await bB.init();
    const pidB = (bB as any).pythonProcess?.pid;
    console.log(`[${ts()}] PID₁ (hang worker): ${pidB}`);

    const t0 = Date.now();
    try {
        await bB.calculate({ asset: 'X', series: [], indicators: [{ name: 'H', params: {} }] }, TIMEOUT_MS);
        console.error('FAIL: did not reject'); process.exit(1);
    } catch (e: any) {
        let ms = Date.now() - t0;
        console.log(`[${ts()}] reject at ${ms}ms: ${e.message.substr(0, 80)}`);
        if (!e.message.includes('管道通信超时')) { console.error('FAIL: wrong msg'); process.exit(1); }
        if (ms < 1900 || ms > 4000) { console.error(`FAIL: timing ${ms}ms`); process.exit(1); }
    }

    // wait for SIGTERM → exit
    await new Promise(r => setTimeout(r, 7000));
    
    const pidBDead = !listPids().includes(pidB);
    const refBCleared = (bB as any).pythonProcess === null;
    console.log(`[${ts()}] PID₁ ${pidB} dead: ${pidBDead}, ref cleared: ${refBCleared}`);
    
    if (!pidBDead || !refBCleared) {
        console.error('FAIL: process not reaped');
        process.exit(1);
    }
    
    bB.shutdown();
    console.log('Phase B: PASS ✅');

    // ═══════════════════════════════════════════════════════════
    // Phase C — Consecutive Recovery (3 rounds)
    // ═══════════════════════════════════════════════════════════
    console.log('\n=== Phase C — Consecutive Recovery (3 rounds) ===');
    const pids: number[] = [pidB];
    
    for (let r = 0; r < 3; r++) {
        const bC = new PythonBridgeDaemon(HANG);
        await bC.init();
        const pidC = (bC as any).pythonProcess?.pid;
        pids.push(pidC);
        console.log(`[${ts()}] Round ${r+1} PID: ${pidC}`);

        try {
            await bC.calculate({ asset: 'X', series: [], indicators: [] }, TIMEOUT_MS);
        } catch (e: any) {
            let ms = Date.now();
            console.log(`[${ts()}]   reject at ${Date.now()-t0}ms`);
        }
        
        await new Promise(r => setTimeout(r, 7000));
        
        const pidDead = !listPids().includes(pidC);
        const refCleared = (bC as any).pythonProcess === null;
        console.log(`[${ts()}]   PID dead: ${pidDead}, ref: ${refCleared}`);
        
        if (!pidDead || !refCleared) {
            console.error(`FAIL: round ${r+1} reaping`);
            process.exit(1);
        }
        bC.shutdown();
        await new Promise(r => setTimeout(r, 300));
    }
    
    const uniquePids = new Set(pids).size;
    console.log(`[${ts()}] PIDs timeline: ${JSON.stringify(pids)}`);
    console.log(`[${ts()}] All unique: ${uniquePids === pids.length}`);
    console.log('Phase C: PASS ✅');

    // ═══════════════════════════════════════════════════════════
    // Phase D — Mixed Workload
    // ═══════════════════════════════════════════════════════════
    console.log('\n=== Phase D — Mixed Workload ===');
    const bD = new PythonBridgeDaemon(FAST);
    await bD.init();
    
    const trials = [
        ['PING', {}], ['HEALTH', {}], ['PING', {}],
        ['ANALYZE', { symbol: 'BTC' }],
        ['PING', {}], ['VERSION', {}]
    ];
    
    for (const [t, payload] of trials) {
        const ms0 = Date.now();
        try {
            const resp: any = await (bD as any).sendPayload(t, payload, 3000);
            const elapsed = Date.now() - ms0;
            console.log(`[${ts()}] ${t}: ${resp?.success ? 'OK' : 'FAIL'} (${resp?.correlationId?.substr(0,12)} ${elapsed}ms)`);
            if (!resp?.success) {
                console.error(`FAIL: ${t} failed`);
                process.exit(1);
            }
        } catch (e: any) {
            console.error(`FAIL: ${t} rejected - ${e.message}`);
            process.exit(1);
        }
    }
    
    bD.shutdown();
    console.log('Phase D: PASS ✅');

    // ═══════════════════════════════════════════════════════════
    // Phase E — Resource Recovery check
    // ═══════════════════════════════════════════════════════════
    console.log('\n=== Phase E — Resource Recovery ===');
    await new Promise(r => setTimeout(r, 2000));
    const finalPids = listPids();
    const leaked = finalPids.filter(p => pids.includes(p));
    console.log(`[${ts()}] Final python PIDs: ${finalPids.length}`);
    console.log(`[${ts()}] Leaked process PIDs from test: ${JSON.stringify(leaked)}`);
    console.log(`[${ts()}] Resources returned to baseline: ${leaked.length === 0}`);

    if (leaked.length > 0) {
        console.error('FAIL: process leak detected');
        process.exit(1);
    }
    
    console.log('Phase E: PASS ✅');
    console.log('\nPhases B-E: ALL PASS ✅');
    process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
