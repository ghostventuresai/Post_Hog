import { afterMount, isBreakpoint, kea, key, path, props } from 'kea'
import { loaders } from 'kea-loaders'
import posthog from 'posthog-js'

import api from 'lib/api'
import { lemonToast } from 'lib/lemon-ui/LemonToast/LemonToast'

import { OrganizationMemberType } from '~/types'

import type { accountRelatedUsersLogicType } from './accountRelatedUsersLogicType'

export interface AccountRelatedUsersLogicProps {
    externalId: string
}

export const accountRelatedUsersLogic = kea<accountRelatedUsersLogicType>([
    path((key) => ['scenes', 'customerAnalytics', 'accounts', 'accountRelatedUsersLogic', key]),
    props({} as AccountRelatedUsersLogicProps),
    key((props) => props.externalId),
    loaders(({ props }) => ({
        members: [
            null as OrganizationMemberType[] | null,
            {
                loadMembers: async (_ = null, breakpoint) => {
                    try {
                        const members = await api.organizationMembers.listAllForOrg(props.externalId)
                        breakpoint()
                        return members
                    } catch (error) {
                        if (!isBreakpoint(error as Error)) {
                            posthog.captureException(error as Error, {
                                scope: 'accountRelatedUsersLogic.loadMembers',
                            })
                            lemonToast.error('Failed to load related users')
                        }
                        throw error
                    }
                },
            },
        ],
    })),
    afterMount(({ actions, props }) => {
        if (props.externalId) {
            actions.loadMembers()
        }
    }),
])
