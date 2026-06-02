import { expectLogic } from 'kea-test-utils'

import api from 'lib/api'

import { initKeaTests } from '~/test/init'
import type { OrganizationMemberType } from '~/types'

import { accountRelatedUsersLogic } from './accountRelatedUsersLogic'

const buildMember = (overrides: Partial<OrganizationMemberType> = {}): OrganizationMemberType =>
    ({
        id: 'membership-1',
        level: 1,
        user: {
            uuid: 'user-uuid-1',
            distinct_id: 'distinct-1',
            first_name: 'Alex',
            last_name: 'Mercer',
            email: 'alex@example.com',
        },
        ...overrides,
    }) as OrganizationMemberType

describe('accountRelatedUsersLogic', () => {
    let logic: ReturnType<typeof accountRelatedUsersLogic.build>

    beforeEach(() => {
        initKeaTests()
        jest.restoreAllMocks()
    })

    afterEach(() => {
        logic?.unmount()
    })

    it('loads the organization members for the account external id', async () => {
        const members = [buildMember()]
        const listAllForOrg = jest.spyOn(api.organizationMembers, 'listAllForOrg').mockResolvedValue(members)

        logic = accountRelatedUsersLogic({ externalId: 'org-uuid' })
        logic.mount()

        await expectLogic(logic).toFinishAllListeners().toMatchValues({ members })
        expect(listAllForOrg).toHaveBeenCalledWith('org-uuid')
    })

    it('does not load when the account has no external id', async () => {
        const listAllForOrg = jest.spyOn(api.organizationMembers, 'listAllForOrg')

        logic = accountRelatedUsersLogic({ externalId: '' })
        logic.mount()

        await expectLogic(logic).toMatchValues({ members: null })
        expect(listAllForOrg).not.toHaveBeenCalled()
    })
})
