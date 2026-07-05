/**
 * quick_ping_test.ts — 快速验证 daemon.py 是否可启动
 */
import { PythonBridgeDaemon } from './src/router/PythonBridgeDaemon';

async function main() {
  console.log('🚀 启动 Python 守护进程...');
  const bridge = new PythonBridgeDaemon();
  await bridge.init();
  console.log('✅ 握手成功，关闭');
  bridge.shutdown();
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
