import { Counter } from 'prom-client'

import { Team } from '../../types'
import { parseJSON } from '../../utils/json-parse'

// A destination that fetches one of PostHog's own ingestion endpoints, authenticating
// as its own project, re-enters the event pipeline. If that re-ingested event then
// re-triggers the same destination, the chain forms an event-forwarding loop that
// doubles traffic on every hop. This guard caps such chains using the same depth
// counter that already protects the `postHogCapture` helper.

// Modes are deliberately separate so the guard can be re-introduced as observe-only
// and flipped to enforcing per-environment once production traffic has been validated.
export type SelfLoopGuardMode = 'disabled' | 'warn' | 'enforce'

// The event property that carries how many times the current chain has already
// re-entered the pipeline. Shared with `postHogCapture` so a chain that mixes both
// paths is still bounded by a single counter.
export const EXECUTION_COUNT_PROPERTY = '$hog_function_execution_count'

// Maximum number of self-capture hops before the chain is broken. Matches the
// `postHogCapture` limit so both loop paths behave identically.
export const SELF_LOOP_MAX_DEPTH = 10

// Only these paths re-enter the event pipeline. Observability (`/i/v1/logs`) and the
// REST API (`/api/...`, `/decide`) do NOT re-trigger event processing, so a fetch to
// them - even with the project's own token - cannot form an event-forwarding loop.
const INGEST_PATHS = new Set(['/capture', '/batch', '/e', '/track', '/i/v0/e'])

// Top-level body fields that carry the credential a capture request authenticates with.
const API_KEY_FIELDS = ['api_key', 'token', 'api_token'] as const

const guardCounter = new Counter({
    name: 'cdp_self_loop_guard_total',
    help: 'Count of fetches the self-loop guard inspected, by mode and action',
    labelNames: ['mode', 'action'],
})

export const isPostHogIngestUrl = (urlString: string): boolean => {
    try {
        const url = new URL(urlString)
        const host = url.hostname.toLowerCase()
        if (host !== 'posthog.com' && !host.endsWith('.posthog.com')) {
            return false
        }
        const path = url.pathname.replace(/\/+$/, '') || '/'
        return INGEST_PATHS.has(path)
    } catch {
        return false
    }
}

// The credential a capture request authenticates with - either a top-level body field
// or an `api_key`/`token` query parameter. Deliberately does NOT look at `$lib_token`
// (SDK metadata auto-attached to event properties) or `Authorization` headers, both of
// which carry a token without expressing intent to ingest as that project.
export const extractRequestApiKey = (body: string | null | undefined, urlString: string): string | null => {
    if (body) {
        try {
            const parsed = parseJSON(body)
            if (parsed && typeof parsed === 'object') {
                const obj = parsed as Record<string, unknown>
                for (const field of API_KEY_FIELDS) {
                    if (typeof obj[field] === 'string') {
                        return obj[field] as string
                    }
                }
            }
        } catch {
            // Not JSON - fall through to the query string.
        }
    }
    try {
        const params = new URL(urlString).searchParams
        return params.get('api_key') ?? params.get('token')
    } catch {
        return null
    }
}

// The event name(s) a capture body emits. Returns null when the body is unparseable or
// carries no event names, so callers can conservatively allow. Kept for classifying
// warn-mode detections, not for the enforce decision (the depth counter handles that).
export const extractEmittedEventNames = (body: string | null | undefined): string[] | null => {
    if (!body) {
        return null
    }
    let parsed: unknown
    try {
        parsed = parseJSON(body)
    } catch {
        return null
    }
    if (!parsed || typeof parsed !== 'object') {
        return null
    }
    const obj = parsed as Record<string, unknown>
    if (typeof obj.event === 'string') {
        return [obj.event]
    }
    if (Array.isArray(obj.batch)) {
        const names = obj.batch
            .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>).event : undefined))
            .filter((name): name is string => typeof name === 'string')
        return names.length > 0 ? names : null
    }
    return null
}

const ownsToken = (team: Pick<Team, 'api_token' | 'secret_api_token'>, token: string): boolean => {
    return token === team.api_token || (team.secret_api_token !== null && token === team.secret_api_token)
}

// Write the incremented hop counter into the outgoing capture body so the re-ingested
// event carries it forward. Handles both single-event and batch shapes. Returns the
// body unchanged if it can't be parsed as a capture payload.
export const injectExecutionCount = (body: string | null | undefined, count: number): string | null | undefined => {
    if (!body) {
        return body
    }
    let parsed: unknown
    try {
        parsed = parseJSON(body)
    } catch {
        return body
    }
    if (!parsed || typeof parsed !== 'object') {
        return body
    }
    const setOn = (event: Record<string, unknown>): void => {
        const properties = (event.properties && typeof event.properties === 'object' ? event.properties : {}) as Record<
            string,
            unknown
        >
        properties[EXECUTION_COUNT_PROPERTY] = count
        event.properties = properties
    }
    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj.batch)) {
        for (const entry of obj.batch) {
            if (entry && typeof entry === 'object') {
                setOn(entry as Record<string, unknown>)
            }
        }
    } else {
        setOn(obj)
    }
    return JSON.stringify(parsed)
}

export type SelfLoopGuardDecision =
    // Not a self-capture, or guard disabled - leave the fetch untouched.
    | { action: 'pass' }
    // Self-capture under the cap in enforce mode - rewrite the body to carry the next hop.
    | { action: 'allow_with_counter'; body: string | null | undefined; depth: number }
    // Self-capture that has reached the cap in enforce mode - break the chain.
    | { action: 'block'; depth: number }
    // Self-capture detected in warn mode - observe only, fetch proceeds unchanged.
    | { action: 'warn'; depth: number }

export type SelfLoopGuardInput = {
    mode: SelfLoopGuardMode
    url: string
    body: string | null | undefined
    team: Pick<Team, 'api_token' | 'secret_api_token'> | null
    // Hop counter carried on the triggering event (0 for a fresh, externally-sourced event).
    executionCount: number
}

export const evaluateSelfLoopGuard = (input: SelfLoopGuardInput): SelfLoopGuardDecision => {
    const { mode, url, body, team, executionCount } = input

    if (mode === 'disabled' || !team) {
        return { action: 'pass' }
    }

    if (!isPostHogIngestUrl(url)) {
        return { action: 'pass' }
    }

    const requestToken = extractRequestApiKey(body, url)
    if (!requestToken || !ownsToken(team, requestToken)) {
        // Either no project credential on the request, or a different project's token
        // (legitimate cross-project replication) - not a self-loop.
        return { action: 'pass' }
    }

    if (mode === 'warn') {
        guardCounter.inc({ mode, action: 'detected' })
        return { action: 'warn', depth: executionCount }
    }

    // enforce
    if (executionCount >= SELF_LOOP_MAX_DEPTH) {
        guardCounter.inc({ mode, action: 'blocked' })
        return { action: 'block', depth: executionCount }
    }

    guardCounter.inc({ mode, action: 'allowed_with_counter' })
    return {
        action: 'allow_with_counter',
        body: injectExecutionCount(body, executionCount + 1),
        depth: executionCount,
    }
}
