/**
 * verify_shutdown_idempotent.ts — verifies multiple shutdown() calls are safe
 *
 * Steps:
 *   1. spawn fake_hang adapter via bridge.init()
 *   2. call shutdown() 3x in a row
 *   3. ensure no exception thrown
 *   4. ensure PID gone from tasklist
 */
import { PythonBridgeDaemon } from '../../src/router/PythonBridgeDaemon';
import { execSync } from 'child_process';

const ADAPTER = 'tests/recovery/fixtures/hang.py';

function listPids(): number[] {
    try {
        const out = execSync('tasklist /FI "IMAGENAME eq python.exe" /FO CSV /NH', { encoding: 'utf-8' });
        return out.split('\n')
            .filter(l => l.startsWith('"python.exe"'))
            .map(l => parseInt(l.split('","')[1].replace(/"/g, '')))
            .filter(n => !isNaN(n));
    } catch { return []; }
}

async function waitForExit(pid: number, maxMs = 8000): Promise<boolean> {
    for (let i = 0; i < maxMs / 500; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (!listPids().includes(pid)) return true;
    }
    return false;
}

async function main() {
    console.log('=== verify_shutdown_idempotent ===');

    const b = new PythonBridgeDaemon(ADAPTER);
    await b.init();
    const pid = (b as any).pythonProcess?.pid;
    console.log(`PID=${pid}`);

    if (!pid) {
        console.error('FAIL: no PID');
        process.exit(1);
    }

    let ok = true;
    try { b.shutdown(); } catch { ok = false; }
    try { b.shutdown(); } catch { ok = false; }
    try { b.shutdown(); } catch { ok = false; }
    console.log(`shutdown x3 exceptions: ${ok ? 'none' : 'thrown'}`);

    const exited = await waitForExit(pid);
    console.log(`PID exited after shutdown x3: ${exited}`);

    const pass = ok && exited;
    console.log(`FINAL: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
    process.exit(pass ? 0 : 1);
}
main().catch(e => { console.error('FATAL:', e); process.exit(2); });
