import { InsightShortId } from '~/types'

// One-shot cross-scene signal. A scene that mutates an insight's query (e.g. the SQL
// editor) marks it stale before navigating away; the insight view then forces a fresh
// recompute on its next load instead of serving the server's pre-edit cached result.
const staleInsights = new Set<InsightShortId>()

export function markInsightStale(shortId: InsightShortId): void {
    staleInsights.add(shortId)
}

// Returns true (and clears the flag) if the insight was marked stale since the last check.
export function consumeInsightStale(shortId: InsightShortId): boolean {
    return staleInsights.delete(shortId)
}
