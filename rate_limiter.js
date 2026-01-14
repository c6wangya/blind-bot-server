import Bottleneck from 'bottleneck';
import dotenv from 'dotenv';

dotenv.config();

// 检测 API Tier (通过环境变量配置)
// 默认使用 paid tier，可通过 GEMINI_TIER=free 切换到免费版限制
const GEMINI_TIER = process.env.GEMINI_TIER || 'paid';

// 速率限制配置
// Free tier: 15 RPM, Paid tier: 60 RPM
const RATE_LIMITS = {
    free: {
        maxConcurrent: 2,           // 最多2个并发请求
        minTime: 4000,              // 请求间隔至少4秒 (15 RPM = 每4秒1个)
        reservoir: 15,              // 令牌桶容量: 15个
        reservoirRefreshAmount: 15, // 每分钟补充15个令牌
        reservoirRefreshInterval: 60000 // 每60秒刷新一次
    },
    paid: {
        maxConcurrent: 5,           // 最多5个并发请求
        minTime: 1000,              // 请求间隔至少1秒 (60 RPM = 每秒1个)
        reservoir: 60,              // 令牌桶容量: 60个
        reservoirRefreshAmount: 60, // 每分钟补充60个令牌
        reservoirRefreshInterval: 60000 // 每60秒刷新一次
    }
};

const config = RATE_LIMITS[GEMINI_TIER];

// 创建主限制器 (用于后台 Workers)
export const limiter = new Bottleneck({
    maxConcurrent: config.maxConcurrent,
    minTime: config.minTime,
    reservoir: config.reservoir,
    reservoirRefreshAmount: config.reservoirRefreshAmount,
    reservoirRefreshInterval: config.reservoirRefreshInterval
});

// 创建高优先级限制器 (用于用户交互请求)
export const priorityLimiter = new Bottleneck({
    maxConcurrent: Math.min(config.maxConcurrent + 2, 10), // 稍微提高并发数
    minTime: Math.max(config.minTime - 200, 500),          // 稍微降低间隔
    reservoir: Math.floor(config.reservoir * 0.7),         // 分配70%的配额给用户
    reservoirRefreshAmount: Math.floor(config.reservoirRefreshAmount * 0.7),
    reservoirRefreshInterval: config.reservoirRefreshInterval
});

// 统计数据
let stats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    retriedRequests: 0,
    totalQueueTime: 0
};

/**
 * 包装 Gemini API 调用，自动处理速率限制
 * @param {Function} fn - 要执行的异步函数
 * @param {Boolean} priority - 是否使用高优先级队列 (用户交互请求)
 * @returns {Promise} API 调用结果
 */
export async function wrapGeminiCall(fn, priority = false) {
    const activeLimiter = priority ? priorityLimiter : limiter;
    const startTime = Date.now();

    stats.totalRequests++;

    return activeLimiter.schedule(async () => {
        const queueTime = Date.now() - startTime;
        stats.totalQueueTime += queueTime;

        if (queueTime > 1000) {
            console.log(`⏱️  Gemini API queued for ${(queueTime / 1000).toFixed(1)}s (${priority ? 'Priority' : 'Normal'})`);
        }

        try {
            const result = await fn();
            stats.successfulRequests++;
            return result;
        } catch (err) {
            // 检查是否是 429 错误
            if (err.message && (err.message.includes('429') || err.message.includes('RESOURCE_EXHAUSTED'))) {
                console.error('⚠️  Rate limit hit despite throttling. This should be rare.');
                stats.retriedRequests++;
                throw err; // Bottleneck 会自动重试
            }
            stats.failedRequests++;
            throw err;
        }
    });
}

// 监控钩子: 队列积压监控
limiter.on('queued', (info) => {
    if (info.queued > 10) {
        console.log(`🔄 Gemini API queue depth: ${info.queued} (Normal priority)`);
    }
});

priorityLimiter.on('queued', (info) => {
    if (info.queued > 5) {
        console.log(`🔄 Gemini API queue depth: ${info.queued} (High priority)`);
    }
});

// 监控钩子: 自动重试配置
limiter.on('failed', async (error, jobInfo) => {
    if (error.message && (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED'))) {
        const delay = jobInfo.retryCount < 3 ? 2000 * (jobInfo.retryCount + 1) : null;
        if (delay) {
            console.warn(`⚠️  429 Error. Retrying in ${delay / 1000}s... (Attempt ${jobInfo.retryCount + 1}/3)`);
        }
        return delay; // 返回延迟时间表示要重试，返回 null 表示放弃
    }
});

priorityLimiter.on('failed', async (error, jobInfo) => {
    if (error.message && (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED'))) {
        const delay = jobInfo.retryCount < 3 ? 2000 * (jobInfo.retryCount + 1) : null;
        if (delay) {
            console.warn(`⚠️  429 Error (Priority). Retrying in ${delay / 1000}s... (Attempt ${jobInfo.retryCount + 1}/3)`);
        }
        return delay;
    }
});

// 获取统计信息
export function getStats() {
    return {
        ...stats,
        averageQueueTime: stats.totalRequests > 0 ? (stats.totalQueueTime / stats.totalRequests).toFixed(0) : 0,
        successRate: stats.totalRequests > 0 ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(1) : 0
    };
}

// 重置统计信息
export function resetStats() {
    stats = {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        retriedRequests: 0,
        totalQueueTime: 0
    };
}

// 启动时输出配置信息
console.log(`✅ Rate Limiter initialized`);
console.log(`   Tier: ${GEMINI_TIER.toUpperCase()}`);
console.log(`   Normal: ${config.reservoir} RPM, ${config.maxConcurrent} concurrent`);
console.log(`   Priority: ${Math.floor(config.reservoir * 0.7)} RPM, ${Math.min(config.maxConcurrent + 2, 10)} concurrent`);
