// 预热与缓存的时间与容量参数（D16）。
/** 锁的超龄阈值 = 总预算 + 余量：超龄只意味着可以按接管规则处理，不意味着可以直接回收。 */
export const STALE_MARGIN_MS = 10_000
export const staleMs = (timeoutMs: number) => timeoutMs + STALE_MARGIN_MS
/** 失败冷却：后台在冷却期内不重试同一 key；前台把 failed 当作 absent。 */
export const FAILED_COOLDOWN_MS = 10 * 60_000
/** 每个 worktree 的缓存容量与保留期（条目约 1KB）。 */
export const CACHE_MAX_ENTRIES = 200
export const CACHE_MAX_AGE_MS = 30 * 24 * 3600_000
/** 等待其他任务时轮询锁与缓存的间隔。 */
export const POLL_MS = 100
