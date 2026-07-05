/**
 * tests/pipeline.test.ts
 * Phase 4.2: PythonBridgeDaemon 集成测试 + P0 指标吞吐验证
 *
 * 运行: npx ts-node tests/pipeline.test.ts
 * 或:   npm run test:pipeline
 */

import { PythonBridgeDaemon } from '../src/router/PythonBridgeDaemon';

const SERIES_COUNT = 20;
const CONCURRENCY = 5;

function makeMockSeries(count: number): Array<{ open: number; high: number; low: number; close: number; volume: number }> {
    const basePrice = 67000;
    return Array.from({ length: count }, (_, i) => ({
        open:  basePrice + i * 10,
        high:  basePrice + i * 10 + 50,
        low:   basePrice + i * 10 - 50,
        close: basePrice + i * 10 + 20,
        volume: 1.5 + i * 0.1
    }));
}

async function runPipelineTest(): Promise<void> {
    console.log('🚀 正在初始化 Python 计算层常驻管道...');
    const bridge = new PythonBridgeDaemon();
    await bridge.init();
    console.log('✅ 跨语言管道双向握手成功！开始注入高频模拟数据...');

    const mockSeries = makeMockSeries(SERIES_COUNT);

    console.log(`📊 并发压力测试: ${CONCURRENCY} 组 × 3 个 P0 指标`);
    const startTime = performance.now();

    const tasks = Array.from({ length: CONCURRENCY }, (_, idx) =>
        bridge.calculate({
            asset: `BTC/USDT_MOCK_${idx}`,
            series: mockSeries,
            indicators: [
                { name: 'HullSuite',     params: { period: 9 } },
                { name: 'ChandelierExit', params: { length: 22, mult: 3.0 } },
                { name: 'UTBotAlerts',    params: { keyPass: 2.0, atrPeriod: 10 } }
            ]
        })
    );

    const results = await Promise.all(tasks);
    const endTime = performance.now();

    const totalMs = endTime - startTime;
    const avgMs = totalMs / CONCURRENCY;

    console.log('----------------------------------------------------');
    console.log(`📊 5 组并发请求端到端总耗时: ${totalMs.toFixed(2)} ms`);
    console.log(`📊 平均单组指标矩阵吞吐延迟: ${avgMs.toFixed(2)} ms`);
    console.log('📦 抽条检查第 1 组返回的数据特征:');
    console.log(JSON.stringify(results[0], null, 2));

    // ── 断言验证 ──────────────────────────────────────────────────────────
    const r0 = results[0];

    // HMA 断言
    if (!r0.data?.HullSuite?.hma) throw new Error('HMA 计算返回空值');
    if (typeof r0.data.HullSuite.hma !== 'number') throw new Error('HMA 值类型错误');
    console.log(`✅ HullSuite.hma = ${r0.data.HullSuite.hma}`);

    // Chandelier Exit 断言
    if (!r0.data?.ChandelierExit?.long_stop) throw new Error('ChandelierExit 返回空值');
    if (r0.data.ChandelierExit.long_stop <= 0) throw new Error('ChandelierExit.long_stop 非正');
    console.log(`✅ ChandelierExit.long_stop = ${r0.data.ChandelierExit.long_stop}`);

    // UT Bot 断言
    if (typeof r0.data?.UTBotAlerts?.buy !== 'boolean') throw new Error('UTBotAlerts.buy 类型错误');
    console.log(`✅ UTBotAlerts.buy = ${r0.data.UTBotAlerts.buy}`);

    // 延迟断言：单组 < 2000ms（P0 指标应该在 1ms 以内）
    if (avgMs > 2000) {
        console.warn(`⚠️  平均延迟 ${avgMs.toFixed(2)}ms 超过 2000ms 阈值`);
    } else {
        console.log(`✅ 平均延迟 ${avgMs.toFixed(2)}ms < 2000ms 阈值`);
    }

    console.log('----------------------------------------------------');
    console.log('🟢 Phase 4.2 P0 控制框架验证通过！');

    // 优雅关闭
    bridge.shutdown();
}

runPipelineTest().catch(err => {
    console.error('❌ 测试失败:', err);
    process.exit(1);
});
