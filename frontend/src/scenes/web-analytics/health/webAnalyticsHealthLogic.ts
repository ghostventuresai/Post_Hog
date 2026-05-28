import { actions, afterMount, connect, kea, listeners, path, selectors } from 'kea'
import { loaders } from 'kea-loaders'

import api, { ApiError } from 'lib/api'
import { lemonToast } from 'lib/lemon-ui/LemonToast/LemonToast'
import { eventUsageLogic } from 'lib/utils/eventUsageLogic'
import { teamLogic } from 'scenes/teamLogic'
import { urls } from 'scenes/urls'

import {
    HealthCheck,
    HealthCheckAction,
    HealthCheckCategory,
    HealthCheckId,
    HealthCheckStatus,
    OverallHealthStatus,
} from './healthCheckTypes'
import type { webAnalyticsHealthLogicType } from './webAnalyticsHealthLogicType'

export interface HealthIssue {
    id: string
    kind: string
    severity: 'critical' | 'warning' | 'info'
    status: 'active' | 'resolved'
    dismissed: boolean
}

export interface HealthIssuesResponse {
    results: HealthIssue[]
    count: number
}

const REFRESH_POLL_INTERVAL_MS = 5000
const REFRESH_POLL_COUNT = 6

/**
 * Static presentational config for the web analytics checks. The pass/fail decision and the
 * underlying detection now live entirely in the backend Temporal health checks (one `kind` per
 * row in posthog_healthissue); this page only renders the result. Copy, actions, and docs links
 * are pure presentation and stay here.
 */
interface WebHealthCheckConfig {
    id: HealthCheckId
    kind: string
    category: HealthCheckCategory
    title: string
    passingDescription: string
    failingDescription: string
    passingAction?: HealthCheckAction
    failingAction?: HealthCheckAction
    docsUrl?: string
    urgent?: boolean
}

const INSTALL_GUIDE_ACTION: HealthCheckAction = {
    label: 'View installation guide',
    to: 'https://posthog.com/docs/libraries/js',
}

const WEB_HEALTH_CHECKS: WebHealthCheckConfig[] = [
    {
        id: HealthCheckId.PAGEVIEW_EVENTS,
        kind: 'no_live_events',
        category: 'events',
        title: '$pageview',
        passingDescription:
            'Events are flowing in as expected. Head over to the Web Analytics tab to start reviewing your analytics!',
        failingDescription: 'Complete the PostHog installation to start seeing events in your dashboard.',
        failingAction: INSTALL_GUIDE_ACTION,
        docsUrl: 'https://posthog.com/docs/product-analytics/capture-events',
        urgent: true,
    },
    {
        id: HealthCheckId.PAGELEAVE_EVENTS,
        kind: 'no_pageleave_events',
        category: 'events',
        title: '$pageleave',
        passingDescription: 'Bounce rate and session duration are accurate!',
        failingDescription: 'Without $pageleave events, bounce rate and session duration might be inaccurate.',
        failingAction: INSTALL_GUIDE_ACTION,
        docsUrl: 'https://posthog.com/docs/web-analytics/dashboard#bounce-rate',
    },
    {
        id: HealthCheckId.SCROLL_DEPTH,
        kind: 'scroll_depth',
        category: 'events',
        title: 'Scroll depth',
        passingDescription: 'Scroll tracking is enabled! Tracking how far users scroll on each page.',
        failingDescription: 'Enable scroll depth to see how far users read your content before leaving.',
        failingAction: INSTALL_GUIDE_ACTION,
        docsUrl: 'https://posthog.com/docs/web-analytics/scroll-depth',
    },
    {
        id: HealthCheckId.AUTHORIZED_URLS,
        kind: 'authorized_urls',
        category: 'configuration',
        title: 'Authorized URLs',
        passingDescription:
            'Authorized URLs configured. Your analytics are filtered to only include traffic from your domains.',
        failingDescription:
            "No authorized URLs configured. Some filters won't work correctly until you let us know what domains you are sending events from.",
        passingAction: { label: 'Manage domains', to: urls.settings('environment-web-analytics') },
        failingAction: { label: 'Add domains', to: urls.settings('environment-web-analytics') },
    },
    {
        id: HealthCheckId.REVERSE_PROXY,
        kind: 'reverse_proxy',
        category: 'configuration',
        title: 'Reverse proxy',
        passingDescription: 'Reverse proxy is configured! Your tracking requests are routed through your own domain.',
        failingDescription:
            'A reverse proxy routes PostHog requests through your own domain and helps prevent ad blockers from blocking tracking. Some metrics may not be accurate until this is configured.',
        failingAction: { label: 'Set up reverse proxy', to: urls.settings('organization-proxy') },
        docsUrl: 'https://posthog.com/docs/advanced/proxy',
        urgent: true,
    },
    {
        id: HealthCheckId.WEB_VITALS,
        kind: 'web_vitals',
        category: 'performance',
        title: '$web_vitals',
        passingDescription: 'LCP, INP, and CLS are being tracked. You can monitor your real user experience!',
        failingDescription:
            'Core Web Vitals (LCP, INP, CLS) measure real user experience. Google uses these metrics for search ranking.',
        passingAction: { label: 'View Web Vitals', to: '/web/web-vitals' },
        failingAction: {
            label: 'Enable Web Vitals',
            to: urls.settings('environment-web-analytics', 'web-vitals-autocapture'),
        },
        docsUrl: 'https://posthog.com/docs/web-analytics/web-vitals',
    },
]

export const webAnalyticsHealthLogic = kea<webAnalyticsHealthLogicType>([
    path(['scenes', 'web-analytics', 'health', 'webAnalyticsHealthLogic']),

    connect(() => ({
        values: [teamLogic, ['currentTeamId']],
        actions: [
            eventUsageLogic,
            [
                'reportWebAnalyticsHealthStatus',
                'reportWebAnalyticsHealthTabViewed',
                'reportWebAnalyticsHealthSectionToggled',
                'reportWebAnalyticsHealthActionClicked',
                'reportWebAnalyticsHealthRefreshed',
            ],
        ],
    })),

    actions({
        refreshHealthChecks: true,
        trackTabViewed: true,
        trackSectionToggled: (category: HealthCheckCategory, isExpanded: boolean) => ({ category, isExpanded }),
        trackActionClicked: (
            checkId: HealthCheckId,
            category: HealthCheckCategory,
            status: HealthCheckStatus,
            isUrgent: boolean
        ) => ({
            checkId,
            category,
            status,
            isUrgent,
        }),
    }),

    loaders(({ values }) => ({
        healthIssues: {
            __default: null as HealthIssuesResponse | null,
            loadHealthIssues: async (): Promise<HealthIssuesResponse> => {
                return await api.get<HealthIssuesResponse>(
                    `api/environments/${values.currentTeamId}/health_issues/?status=active&dismissed=false`
                )
            },
        },
    })),

    selectors({
        activeIssuesByKind: [
            (s) => [s.healthIssues],
            (healthIssues: HealthIssuesResponse | null): Record<string, HealthIssue> => {
                const byKind: Record<string, HealthIssue> = {}
                for (const issue of healthIssues?.results ?? []) {
                    byKind[issue.kind] = issue
                }
                return byKind
            },
        ],

        allChecks: [
            (s) => [s.activeIssuesByKind, s.healthIssuesLoading, s.healthIssues],
            (
                activeIssuesByKind: Record<string, HealthIssue>,
                loading: boolean,
                healthIssues: HealthIssuesResponse | null
            ): HealthCheck[] => {
                return WEB_HEALTH_CHECKS.map((config) => {
                    // Show loading only on the first load (no data yet), like the rest of the health UI.
                    if (loading && !healthIssues) {
                        return {
                            id: config.id,
                            category: config.category,
                            title: config.title,
                            description: 'Checking...',
                            status: 'loading' as HealthCheckStatus,
                        }
                    }

                    const issue = activeIssuesByKind[config.kind]
                    if (!issue) {
                        return {
                            id: config.id,
                            category: config.category,
                            title: config.title,
                            description: config.passingDescription,
                            status: 'success' as HealthCheckStatus,
                            action: config.passingAction,
                            docsUrl: config.docsUrl,
                            urgent: config.urgent,
                        }
                    }

                    // Critical backend severity surfaces as an error, everything else as a warning.
                    const status: HealthCheckStatus = issue.severity === 'critical' ? 'error' : 'warning'
                    return {
                        id: config.id,
                        category: config.category,
                        title: config.title,
                        description: config.failingDescription,
                        status,
                        action: config.failingAction,
                        docsUrl: config.docsUrl,
                        urgent: config.urgent,
                    }
                })
            },
        ],

        checksByCategory: [
            (s) => [s.allChecks],
            (allChecks: HealthCheck[]): Record<HealthCheckCategory, HealthCheck[]> => ({
                events: allChecks.filter((check) => check.category === 'events'),
                configuration: allChecks.filter((check) => check.category === 'configuration'),
                performance: allChecks.filter((check) => check.category === 'performance'),
            }),
        ],

        overallHealthStatus: [
            (s) => [s.allChecks],
            (allChecks: HealthCheck[]): OverallHealthStatus => {
                const passedCount = allChecks.filter((check) => check.status === 'success').length
                const warningCount = allChecks.filter((check) => check.status === 'warning').length
                const errorCount = allChecks.filter((check) => check.status === 'error').length
                const loadingCount = allChecks.filter((check) => check.status === 'loading').length
                const totalCount = allChecks.length

                let status: HealthCheckStatus
                let summary: string

                if (loadingCount > 0) {
                    status = 'loading'
                    summary = 'Checking your setup...'
                } else if (warningCount > 0 || errorCount > 0) {
                    status = 'warning'
                    const totalErrors = warningCount + errorCount
                    summary = `${totalErrors} recommendation${totalErrors > 1 ? 's' : ''} to improve your setup`
                } else {
                    status = 'success'
                    summary = 'Your web analytics setup looks great!'
                }

                return {
                    status,
                    summary,
                    passedCount,
                    warningCount,
                    errorCount,
                    totalCount,
                }
            },
        ],

        hasIssues: [
            (s) => [s.overallHealthStatus],
            (overallHealthStatus: OverallHealthStatus): boolean => {
                return overallHealthStatus.status === 'error' || overallHealthStatus.status === 'warning'
            },
        ],

        urgentFailedChecks: [
            (s) => [s.allChecks],
            (allChecks: HealthCheck[]): HealthCheck[] => {
                return allChecks.filter(
                    (check) => check.urgent && check.status !== 'success' && check.status !== 'loading'
                )
            },
        ],

        hasUrgentIssues: [
            (s) => [s.urgentFailedChecks],
            (urgentFailedChecks: HealthCheck[]): boolean => {
                return urgentFailedChecks.length > 0
            },
        ],
    }),

    listeners(({ actions, values }) => ({
        refreshHealthChecks: async (_, breakpoint) => {
            const { overallHealthStatus } = values
            actions.reportWebAnalyticsHealthRefreshed({
                overall_status: overallHealthStatus.status,
                passed_count: overallHealthStatus.passedCount,
            })

            try {
                await api.create(`api/environments/${values.currentTeamId}/health_issues/refresh/`)
                breakpoint()
                lemonToast.success('Refreshing health checks...', { autoClose: 2000 })
                for (let i = 0; i < REFRESH_POLL_COUNT; i++) {
                    await breakpoint(REFRESH_POLL_INTERVAL_MS)
                    actions.loadHealthIssues()
                }
            } catch (error: unknown) {
                if (error instanceof ApiError && error.status === 429) {
                    // A refresh ran recently; just reload the latest persisted results.
                    actions.loadHealthIssues()
                    return
                }
                actions.loadHealthIssues()
            }
        },
        loadHealthIssuesSuccess: () => {
            const { activeIssuesByKind, overallHealthStatus } = values
            if (overallHealthStatus.status !== 'loading') {
                actions.reportWebAnalyticsHealthStatus({
                    has_pageviews: !activeIssuesByKind['no_live_events'],
                    has_pageleaves: !activeIssuesByKind['no_pageleave_events'],
                    has_scroll_depth: !activeIssuesByKind['scroll_depth'],
                    has_web_vitals: !activeIssuesByKind['web_vitals'],
                    has_authorized_urls: !activeIssuesByKind['authorized_urls'],
                    has_reverse_proxy: !activeIssuesByKind['reverse_proxy'],
                    overall_status: overallHealthStatus.status,
                })
            }
        },
        trackTabViewed: () => {
            const { overallHealthStatus } = values
            actions.reportWebAnalyticsHealthTabViewed({
                overall_status: overallHealthStatus.status,
                passed_count: overallHealthStatus.passedCount,
                warning_count: overallHealthStatus.warningCount,
                error_count: overallHealthStatus.errorCount,
            })
        },
        trackSectionToggled: ({ category, isExpanded }) => {
            actions.reportWebAnalyticsHealthSectionToggled({
                category,
                is_expanded: isExpanded,
            })
        },
        trackActionClicked: ({ checkId, category, status, isUrgent }) => {
            actions.reportWebAnalyticsHealthActionClicked({
                check_id: checkId,
                category,
                status,
                is_urgent: isUrgent,
            })
        },
    })),

    afterMount(({ actions }) => {
        actions.loadHealthIssues()
    }),
])
