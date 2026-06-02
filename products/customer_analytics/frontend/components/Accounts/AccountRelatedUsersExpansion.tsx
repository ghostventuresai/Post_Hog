import { useValues } from 'kea'

import { LemonTable, LemonTableColumns, Link } from '@posthog/lemon-ui'

import { fullName } from 'lib/utils'
import { urls } from 'scenes/urls'

import { OrganizationMemberType } from '~/types'

import { accountRelatedUsersLogic } from './accountRelatedUsersLogic'

export function AccountRelatedUsersExpansion({ externalId }: { externalId: string }): JSX.Element {
    const logic = accountRelatedUsersLogic({ externalId })
    const { members, membersLoading } = useValues(logic)

    const columns: LemonTableColumns<OrganizationMemberType> = [
        {
            title: 'User',
            key: 'user',
            render: (_, member) => {
                const name = fullName(member.user) || member.user.email
                return member.user.distinct_id ? (
                    <Link to={urls.personByDistinctId(member.user.distinct_id)} className="font-medium">
                        {name}
                    </Link>
                ) : (
                    <span className="font-medium">{name}</span>
                )
            },
        },
        {
            title: 'Email',
            key: 'email',
            render: (_, member) => <span className="text-sm text-muted">{member.user.email}</span>,
        },
    ]

    return (
        <LemonTable<OrganizationMemberType>
            size="small"
            embedded
            dataSource={members ?? []}
            rowKey="id"
            loading={membersLoading}
            columns={columns}
            pagination={{ pageSize: 5, hideOnSinglePage: true }}
            emptyState={
                !externalId
                    ? 'This account has no linked organization.'
                    : members === null
                      ? 'Failed to load related users.'
                      : 'No users related to this account yet.'
            }
        />
    )
}
