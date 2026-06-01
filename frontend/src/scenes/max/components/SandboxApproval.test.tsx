import '@testing-library/jest-dom'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useActions, useValues } from 'kea'

import type { PermissionRequestRecord, ToolInvocation } from '../types/sandboxStreamTypes'
import { SandboxModeBadge, SandboxPermissionInput } from './InputFormArea'

jest.mock('kea', () => ({
    ...jest.requireActual('kea'),
    useActions: jest.fn(),
    useValues: jest.fn(),
}))

jest.mock('use-resize-observer', () => () => ({
    height: 160,
    ref: { current: null },
}))

jest.mock('../maxThreadLogic', () => ({
    maxThreadLogic: { __mock: 'maxThreadLogic' },
}))

jest.mock('../sandboxStreamLogic', () => ({
    sandboxStreamLogic: { __mock: 'sandboxStreamLogic' },
}))

jest.mock('../MarkdownMessage', () => ({
    MarkdownMessage: ({ content }: { content: string }) => <div data-attr="markdown">{content}</div>,
}))

const rawToolCall: ToolInvocation = {
    toolCallId: 'tc-1',
    rawServerName: 'posthog',
    rawToolName: 'exec',
    resolvedKey: 'insight-create',
    input: {},
    status: 'pending',
    contentBlocks: [],
}

function makeRequest(overrides: Partial<PermissionRequestRecord> = {}): PermissionRequestRecord {
    return {
        requestId: 'req-1',
        toolCallId: 'tc-1',
        title: 'Create insight',
        description: 'The agent wants to create an insight.',
        options: [
            { optionId: 'opt-allow', name: 'Approve', kind: 'allow_once' },
            { optionId: 'opt-reject', name: 'Decline', kind: 'reject' },
            { optionId: 'opt-feedback', name: 'Decline with feedback', kind: 'reject_with_feedback' },
        ],
        rawToolCall,
        ...overrides,
    }
}

describe('Sandbox approval input area', () => {
    const respondToPermission = jest.fn()

    beforeEach(() => {
        jest.clearAllMocks()
        ;(useActions as jest.Mock).mockReturnValue({ respondToPermission })
    })

    afterEach(() => {
        cleanup()
    })

    describe('SandboxPermissionInput', () => {
        it('renders one button per non-feedback option plus the feedback custom input', () => {
            render(<SandboxPermissionInput conversationId="conv-1" request={makeRequest()} />)

            expect(screen.getByText('Approval required')).toBeInTheDocument()
            expect(screen.getByText('Approve')).toBeInTheDocument()
            expect(screen.getByText('Decline')).toBeInTheDocument()
            // reject_with_feedback rides the OptionSelector custom input, not a plain button.
            expect(screen.getByText("Explain what you'd like instead..")).toBeInTheDocument()
        })

        it('posts the chosen optionId on click and enters a loading state', () => {
            render(<SandboxPermissionInput conversationId="conv-1" request={makeRequest()} />)

            fireEvent.click(screen.getByText('Approve'))

            expect(respondToPermission).toHaveBeenCalledWith({
                conversationId: 'conv-1',
                requestId: 'req-1',
                optionId: 'opt-allow',
            })
            // Loading state replaces the option list, guarding against double-submit.
            expect(screen.getByText('Sending response...')).toBeInTheDocument()
        })

        it('guards against double-submit — a second click after submitting does not re-post', () => {
            render(<SandboxPermissionInput conversationId="conv-1" request={makeRequest()} />)

            fireEvent.click(screen.getByText('Decline'))
            expect(respondToPermission).toHaveBeenCalledTimes(1)

            // The buttons are gone (loading message shown), so nothing else can be clicked.
            expect(screen.queryByText('Decline')).not.toBeInTheDocument()
            expect(respondToPermission).toHaveBeenCalledTimes(1)
        })

        it('sends feedback text through the reject_with_feedback option', () => {
            render(<SandboxPermissionInput conversationId="conv-1" request={makeRequest()} />)

            // Open the custom feedback input.
            fireEvent.click(screen.getByText("Explain what you'd like instead.."))
            const input = screen.getByPlaceholderText("Explain what you'd like instead...")
            fireEvent.change(input, { target: { value: 'Use a funnel instead' } })
            fireEvent.click(screen.getByRole('button', { name: 'Send' }))

            expect(respondToPermission).toHaveBeenCalledWith({
                conversationId: 'conv-1',
                requestId: 'req-1',
                optionId: 'opt-feedback',
                customInput: 'Use a funnel instead',
            })
        })

        it('shows plan copy when the request is a plan approval', () => {
            render(
                <SandboxPermissionInput
                    conversationId="conv-1"
                    request={makeRequest({ title: 'Approve the plan', rawToolCall: { ...rawToolCall, kind: 'plan' } })}
                />
            )

            expect(screen.getByText('Approve this plan?')).toBeInTheDocument()
        })
    })

    describe('SandboxModeBadge', () => {
        it('reflects plan mode for a sandbox conversation', () => {
            ;(useValues as jest.Mock).mockReturnValue({
                conversation: { agent_runtime: 'sandbox' },
                currentMode: 'plan',
            })

            render(<SandboxModeBadge />)

            expect(screen.getByText('Plan mode')).toBeInTheDocument()
        })

        it('reflects default mode for a sandbox conversation', () => {
            ;(useValues as jest.Mock).mockReturnValue({
                conversation: { agent_runtime: 'sandbox' },
                currentMode: 'default',
            })

            render(<SandboxModeBadge />)

            expect(screen.getByText('Default mode')).toBeInTheDocument()
        })

        it('renders nothing when there is no current mode', () => {
            ;(useValues as jest.Mock).mockReturnValue({
                conversation: { agent_runtime: 'sandbox' },
                currentMode: null,
            })

            const { container } = render(<SandboxModeBadge />)
            expect(container).toBeEmptyDOMElement()
        })

        it('renders nothing for a non-sandbox conversation', () => {
            ;(useValues as jest.Mock).mockReturnValue({
                conversation: { agent_runtime: 'langgraph' },
                currentMode: 'plan',
            })

            const { container } = render(<SandboxModeBadge />)
            expect(container).toBeEmptyDOMElement()
        })
    })
})
