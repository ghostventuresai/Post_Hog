import { useValues } from 'kea'

import { LemonModal, SpinnerOverlay } from '@posthog/lemon-ui'

import { LogInAsSuggestions } from 'lib/components/NotFound'
import { userLogic } from 'scenes/userLogic'

import { impersonationNoticeLogic } from './impersonationNoticeLogic'

export function SwitchImpersonationModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }): JSX.Element {
    const { user } = useValues(userLogic)
    const { orgMembers, orgMembersLoading } = useValues(impersonationNoticeLogic)

    const filteredMembers = orgMembers.filter((member) => member.user.id !== user?.id)

    return (
        <LemonModal
            isOpen={isOpen}
            onClose={onClose}
            title="Switch impersonated user"
            description="Select a user from this organization to switch to. You'll need to provide a reason for the switch."
            width={560}
        >
            {orgMembersLoading ? (
                <div className="min-h-32 relative">
                    <SpinnerOverlay className="text-3xl" />
                </div>
            ) : (
                <LogInAsSuggestions orgMembers={filteredMembers} isSwitching />
            )}
        </LemonModal>
    )
}
