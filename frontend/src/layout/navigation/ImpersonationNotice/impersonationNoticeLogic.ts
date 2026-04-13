import { actions, connect, kea, listeners, path, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'

import api from 'lib/api'
import { userLogic } from 'scenes/userLogic'

import { OrganizationMemberType, UserType } from '~/types'

import type { impersonationNoticeLogicType } from './impersonationNoticeLogicType'

export const impersonationNoticeLogic = kea<impersonationNoticeLogicType>([
    path(['layout', 'navigation', 'ImpersonationNotice', 'impersonationNoticeLogic']),

    connect(() => ({
        values: [userLogic, ['user', 'isImpersonationUpgradeInProgress']],
        actions: [userLogic, ['upgradeImpersonation', 'upgradeImpersonationSuccess']],
    })),

    actions({
        minimize: true,
        maximize: true,
        openUpgradeModal: true,
        closeUpgradeModal: true,
        openSwitchUserModal: true,
        closeSwitchUserModal: true,
        setPageVisible: (visible: boolean) => ({ visible }),
        clearPageHiddenAt: true,
    }),

    loaders({
        orgMembers: [
            [] as OrganizationMemberType[],
            {
                loadOrgMembers: async () => {
                    const members = await api.organizationMembers.listAll()
                    return members.sort((a, b) => b.level - a.level)
                },
            },
        ],
    }),

    reducers({
        isMinimized: [
            false,
            {
                minimize: () => true,
                maximize: () => false,
            },
        ],
        isUpgradeModalOpen: [
            false,
            {
                openUpgradeModal: () => true,
                closeUpgradeModal: () => false,
            },
        ],
        isSwitchUserModalOpen: [
            false,
            {
                openSwitchUserModal: () => true,
                closeSwitchUserModal: () => false,
            },
        ],
        pageHiddenAt: [
            null as number | null,
            {
                // Store timestamp when page becomes hidden - used to work out if we
                // should auto expand when page regains focus
                setPageVisible: (state, { visible }) => (visible ? state : Date.now()),
                clearPageHiddenAt: () => null,
            },
        ],
    }),

    selectors({
        isReadOnly: [(s) => [s.user], (user: UserType | null): boolean => user?.is_impersonated_read_only ?? true],
        isImpersonated: [(s) => [s.user], (user: UserType | null): boolean => user?.is_impersonated ?? false],
    }),

    listeners(({ actions, values }) => ({
        upgradeImpersonationSuccess: () => {
            if (values.isUpgradeModalOpen && !values.isReadOnly) {
                actions.closeUpgradeModal()
            }
        },
        openSwitchUserModal: () => {
            actions.loadOrgMembers()
        },
        setPageVisible: ({ visible }) => {
            if (!visible) {
                return
            }
            const { pageHiddenAt } = values
            actions.clearPageHiddenAt()
            // Auto-maximize when window regains focus to ensure staff
            // users are reminded they are impersonating a customer
            // Only trigger if away for more than 30 seconds though to
            // avoid being annoying if quickly switching between windows
            if (values.isMinimized && pageHiddenAt) {
                const secondsAway = (Date.now() - pageHiddenAt) / 1000
                if (secondsAway > 30) {
                    actions.maximize()
                }
            }
        },
    })),
])
