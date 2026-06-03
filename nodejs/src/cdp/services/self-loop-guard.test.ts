import { Team } from '../../types'
import { parseJSON } from '../../utils/json-parse'
import {
    EXECUTION_COUNT_PROPERTY,
    SELF_LOOP_MAX_DEPTH,
    SelfLoopGuardMode,
    evaluateSelfLoopGuard,
    extractEmittedEventNames,
    extractRequestApiKey,
    injectExecutionCount,
    isPostHogIngestUrl,
} from './self-loop-guard'

// Synthetic, non-production values. OWN_TOKEN is the project the destination runs in;
// OTHER_TOKEN is a different project (legitimate cross-project replication).
const OWN_TOKEN = 'phc_synthetic_own_0000000000000000'
const OWN_SECRET_TOKEN = 'phsx_synthetic_own_secret_00000000'
const OTHER_TOKEN = 'phc_synthetic_other_111111111111111'

const TEAM: Pick<Team, 'api_token' | 'secret_api_token'> = {
    api_token: OWN_TOKEN,
    secret_api_token: OWN_SECRET_TOKEN,
}

const INGEST_URL = 'https://us.i.posthog.com/capture/'
const BATCH_URL = 'https://eu.i.posthog.com/batch/'
const LOGS_URL = 'https://us.i.posthog.com/i/v1/logs'
const API_URL = 'https://us.posthog.com/api/projects/100/insights/'
const EXTERNAL_URL = 'https://external.example.com/webhook'

const captureBody = (event: string, properties: Record<string, unknown> = {}, apiKey = OWN_TOKEN): string =>
    JSON.stringify({ api_key: apiKey, event, distinct_id: 'synthetic_user_1', properties })

const batchBody = (events: string[], apiKey = OWN_TOKEN): string =>
    JSON.stringify({
        api_key: apiKey,
        batch: events.map((event) => ({ event, distinct_id: 'synthetic_user_1', properties: {} })),
    })

const guard = (overrides: {
    mode?: SelfLoopGuardMode
    url?: string
    body?: string | null
    team?: Pick<Team, 'api_token' | 'secret_api_token'> | null
    executionCount?: number
}) =>
    evaluateSelfLoopGuard({
        mode: overrides.mode ?? 'enforce',
        url: overrides.url ?? INGEST_URL,
        body: overrides.body ?? captureBody('replicated_event'),
        team: overrides.team === undefined ? TEAM : overrides.team,
        executionCount: overrides.executionCount ?? 0,
    })

describe('self-loop-guard', () => {
    describe('isPostHogIngestUrl', () => {
        it.each([
            ['https://us.i.posthog.com/capture/', true],
            ['https://us.i.posthog.com/capture', true],
            ['https://eu.i.posthog.com/batch/', true],
            ['https://us.i.posthog.com/e/', true],
            ['https://us.i.posthog.com/track/', true],
            ['https://us.i.posthog.com/i/v0/e/', true],
            ['https://us.i.posthog.com/capture/?api_key=abc', true],
            ['https://posthog.com/capture', true],
            // observability + REST endpoints are NOT ingestion - cannot form a loop
            ['https://us.i.posthog.com/i/v1/logs', false],
            ['https://us.posthog.com/api/projects/100/insights/', false],
            ['https://us.i.posthog.com/decide', false],
            // non-posthog hosts
            ['https://external.example.com/capture', false],
            ['https://posthog.com.evil.com/capture', false],
            ['https://notposthog.com/capture', false],
            ['not a url', false],
        ])('classifies %s as ingest=%s', (url, expected) => {
            expect(isPostHogIngestUrl(url)).toBe(expected)
        })
    })

    describe('extractRequestApiKey', () => {
        it('reads the top-level api_key field', () => {
            expect(extractRequestApiKey(captureBody('e'), INGEST_URL)).toBe(OWN_TOKEN)
        })

        it.each(['token', 'api_token'])('reads the top-level %s field', (field) => {
            expect(extractRequestApiKey(JSON.stringify({ [field]: OWN_TOKEN }), INGEST_URL)).toBe(OWN_TOKEN)
        })

        it('reads the api_key query parameter when body has none', () => {
            expect(extractRequestApiKey('', `${INGEST_URL}?api_key=${OWN_TOKEN}`)).toBe(OWN_TOKEN)
        })

        it('does NOT treat $lib_token in event properties as the request credential', () => {
            // The SDK auto-attaches the team token as $lib_token on event properties. That
            // is metadata, not an intent to ingest as the project - it must not be matched.
            const body = JSON.stringify({ event: 'ticket_updated', properties: { $lib_token: OWN_TOKEN } })
            expect(extractRequestApiKey(body, API_URL)).toBeNull()
        })

        it('returns null for an unparseable body and no query token', () => {
            expect(extractRequestApiKey('not-json{{', INGEST_URL)).toBeNull()
        })
    })

    describe('extractEmittedEventNames', () => {
        it('returns the single event name', () => {
            expect(extractEmittedEventNames(captureBody('alpha'))).toEqual(['alpha'])
        })

        it('returns all event names from a batch', () => {
            expect(extractEmittedEventNames(batchBody(['alpha', 'beta']))).toEqual(['alpha', 'beta'])
        })

        it.each([null, undefined, '', 'null'])('returns null for empty-ish body %s', (body) => {
            expect(extractEmittedEventNames(body)).toBeNull()
        })

        it('returns null for malformed JSON without throwing', () => {
            expect(extractEmittedEventNames('{broken')).toBeNull()
        })

        it('filters out non-string event fields in a batch', () => {
            const body = JSON.stringify({ batch: [{ event: 'alpha' }, { event: 123 }, { event: 'gamma' }] })
            expect(extractEmittedEventNames(body)).toEqual(['alpha', 'gamma'])
        })
    })

    describe('injectExecutionCount', () => {
        it('sets the counter on a single-event body', () => {
            const out = injectExecutionCount(captureBody('alpha'), 3)
            expect(parseJSON(out as string).properties[EXECUTION_COUNT_PROPERTY]).toBe(3)
        })

        it('sets the counter on every entry of a batch body', () => {
            const out = injectExecutionCount(batchBody(['alpha', 'beta']), 5)
            const parsed = parseJSON(out as string)
            expect(parsed.batch.map((e: any) => e.properties[EXECUTION_COUNT_PROPERTY])).toEqual([5, 5])
        })

        it('preserves existing properties while adding the counter', () => {
            const out = injectExecutionCount(captureBody('alpha', { foo: 'bar' }), 1)
            const props = parseJSON(out as string).properties
            expect(props).toMatchObject({ foo: 'bar', [EXECUTION_COUNT_PROPERTY]: 1 })
        })

        it('returns the body unchanged when it is not parseable', () => {
            expect(injectExecutionCount('not-json', 1)).toBe('not-json')
        })
    })

    describe('evaluateSelfLoopGuard - passes through non-loops', () => {
        it('passes when disabled even for a true self-loop', () => {
            expect(guard({ mode: 'disabled' })).toEqual({ action: 'pass' })
        })

        it('passes when the team cannot be resolved', () => {
            expect(guard({ team: null })).toEqual({ action: 'pass' })
        })

        it('passes for an external (non-PostHog) fetch', () => {
            expect(guard({ url: EXTERNAL_URL })).toEqual({ action: 'pass' })
        })

        it('passes for the observability logs endpoint with a Bearer-style payload', () => {
            // Mirrors a destination that uploads a conversion to an external API, then ships
            // an observability log to PostHog. The log endpoint is not ingestion -> no loop.
            expect(guard({ url: LOGS_URL })).toEqual({ action: 'pass' })
        })

        it('passes for a workflow step that posts to a PostHog REST API endpoint', () => {
            // A workflow "update ticket" step calls a PostHog API endpoint and the SDK has
            // auto-attached $lib_token into the body. Neither is an ingestion self-capture.
            const body = JSON.stringify({ status: 'open', properties: { $lib_token: OWN_TOKEN } })
            expect(guard({ url: API_URL, body })).toEqual({ action: 'pass' })
        })

        it('passes for cross-project replication (different project token)', () => {
            // Replicator forwarding to a *different* project - the request authenticates with
            // another project's token, so it is not a self-loop.
            expect(guard({ body: captureBody('any_event', {}, OTHER_TOKEN) })).toEqual({ action: 'pass' })
        })

        it('passes when the team token only appears as $lib_token, not as the api_key', () => {
            const body = JSON.stringify({ event: 'alpha', properties: { $lib_token: OWN_TOKEN } })
            expect(guard({ body })).toEqual({ action: 'pass' })
        })

        it('passes when the team token is a substring of an unrelated field', () => {
            const body = JSON.stringify({ event: 'alpha', properties: { ref: `${OWN_TOKEN}_extra` } })
            expect(guard({ body })).toEqual({ action: 'pass' })
        })

        it('passes for an ingest fetch with no credential at all', () => {
            expect(guard({ body: JSON.stringify({ event: 'alpha' }) })).toEqual({ action: 'pass' })
        })
    })

    describe('evaluateSelfLoopGuard - warn mode observes without changing behavior', () => {
        it('warns on a self-capture but does not block or rewrite', () => {
            expect(guard({ mode: 'warn', executionCount: 2 })).toEqual({ action: 'warn', depth: 2 })
        })

        it('does not warn on a non-loop in warn mode', () => {
            expect(guard({ mode: 'warn', body: captureBody('e', {}, OTHER_TOKEN) })).toEqual({ action: 'pass' })
        })
    })

    describe('evaluateSelfLoopGuard - enforce mode caps the chain via the depth counter', () => {
        it('allows the first hop and injects the incremented counter', () => {
            const decision = guard({ mode: 'enforce', executionCount: 0 })
            expect(decision.action).toBe('allow_with_counter')
            if (decision.action === 'allow_with_counter') {
                expect(parseJSON(decision.body as string).properties[EXECUTION_COUNT_PROPERTY]).toBe(1)
            }
        })

        it('keeps allowing while the chain is under the cap', () => {
            const decision = guard({ mode: 'enforce', executionCount: SELF_LOOP_MAX_DEPTH - 1 })
            expect(decision.action).toBe('allow_with_counter')
            if (decision.action === 'allow_with_counter') {
                expect(parseJSON(decision.body as string).properties[EXECUTION_COUNT_PROPERTY]).toBe(
                    SELF_LOOP_MAX_DEPTH
                )
            }
        })

        it('blocks once the chain reaches the cap', () => {
            expect(guard({ mode: 'enforce', executionCount: SELF_LOOP_MAX_DEPTH })).toEqual({
                action: 'block',
                depth: SELF_LOOP_MAX_DEPTH,
            })
        })

        it('blocks a self-loop authenticated with the secret token', () => {
            const decision = guard({
                mode: 'enforce',
                body: captureBody('e', {}, OWN_SECRET_TOKEN),
                executionCount: SELF_LOOP_MAX_DEPTH,
            })
            expect(decision.action).toBe('block')
        })

        it('treats a token passed via the URL query string as a self-capture', () => {
            const decision = guard({
                mode: 'enforce',
                url: `${INGEST_URL}?api_key=${OWN_TOKEN}`,
                body: '',
                executionCount: SELF_LOOP_MAX_DEPTH,
            })
            expect(decision.action).toBe('block')
        })

        it('caps a batched self-capture and stamps every entry', () => {
            const decision = guard({ mode: 'enforce', url: BATCH_URL, body: batchBody(['a', 'b']), executionCount: 4 })
            expect(decision.action).toBe('allow_with_counter')
            if (decision.action === 'allow_with_counter') {
                const stamped = parseJSON(decision.body as string).batch.map(
                    (e: any) => e.properties[EXECUTION_COUNT_PROPERTY]
                )
                expect(stamped).toEqual([5, 5])
            }
        })
    })

    describe('evaluateSelfLoopGuard - terminating self-update patterns are never blocked', () => {
        // Reproduces the pattern where a destination captures a hardcoded event back into its
        // own project to flip a person property that its own trigger filter excludes on. The
        // chain self-terminates after one bounce, so the depth counter never reaches the cap.
        it('keeps allowing a one-bounce self-update across repeated runs', () => {
            // First bounce: count starts at 0, allowed, stamped to 1.
            const first = guard({
                mode: 'enforce',
                body: captureBody('$identify', { $set: { onboarding_email_sent: true } }),
                executionCount: 0,
            })
            expect(first.action).toBe('allow_with_counter')
            // In production the flipped property stops the filter from matching, so the chain
            // ends here. Even if a later unrelated run occurs it is still far under the cap.
            const laterUnrelatedRun = guard({
                mode: 'enforce',
                body: captureBody('$identify', { $set: { onboarding_email_sent: true } }),
                executionCount: 1,
            })
            expect(laterUnrelatedRun.action).toBe('allow_with_counter')
        })
    })
})
