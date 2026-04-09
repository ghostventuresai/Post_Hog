import clsx from 'clsx'
import { useActions, useValues } from 'kea'

import { IconCheck, IconX } from '@posthog/icons'
import { LemonButton, LemonCheckbox, LemonInput, LemonSegmentedButton } from '@posthog/lemon-ui'

import { PropertyFilters } from 'lib/components/PropertyFilters/PropertyFilters'
import { TaxonomicFilterGroupType } from 'lib/components/TaxonomicFilter/types'
import { LemonField } from 'lib/lemon-ui/LemonField'
import { LemonRadio } from 'lib/lemon-ui/LemonRadio'
import { AddEventButton } from 'scenes/surveys/AddEventButton'

import {
    AnyPropertyFilter,
    SurveyAppearance,
    SurveyDisplayConditions,
    SurveyEventsWithProperties,
    SurveyPosition,
    SurveySchedule,
    SurveyTabPosition,
    SurveyType,
} from '~/types'

import {
    SUPPORTED_OPERATORS,
    convertArrayToPropertyFilters,
    convertPropertyFiltersToArray,
    getEventPropertyFilterCount,
    useExcludedObjectProperties,
} from '../../SurveyEventTrigger'
import { surveyLogic } from '../../surveyLogic'
import { surveyWizardLogic } from '../surveyWizardLogic'
import { WizardPanel, WizardSection, WizardStepLayout } from '../WizardLayout'

const FREQUENCY_OPTIONS: { value: string; days: number | undefined; label: string }[] = [
    { value: 'once', days: undefined, label: 'Once ever' },
    { value: 'yearly', days: 365, label: 'Every year' },
    { value: 'quarterly', days: 90, label: 'Every 3 months' },
    { value: 'monthly', days: 30, label: 'Every month' },
]

export function WhenStep({ onOpenFullEditor }: { onOpenFullEditor: () => void }): JSX.Element {
    const { survey } = useValues(surveyLogic)
    const { setSurveyValue } = useActions(surveyLogic)
    const { recommendedFrequency } = useValues(surveyWizardLogic({ id: survey.id || 'new' }))

    const conditions: Partial<SurveyDisplayConditions> = survey.conditions || {}
    const appearance: Partial<SurveyAppearance> = survey.appearance || {}
    const triggerEvents = conditions.events?.values || []
    // Check if events object exists (even if empty) to determine mode
    const triggerMode = conditions.events !== null && conditions.events !== undefined ? 'event' : 'pageview'
    const repeatedActivation = conditions.events?.repeatedActivation ?? false
    const delaySeconds = appearance.surveyPopupDelaySeconds ?? 0
    const isWidget = survey.type === SurveyType.Widget
    const excludedObjectProperties = useExcludedObjectProperties()

    const daysToFrequency = (days: number | undefined): string => {
        const option = FREQUENCY_OPTIONS.find((opt) => opt.days === days)
        return option?.value || 'monthly'
    }
    const frequency = daysToFrequency(conditions.seenSurveyWaitPeriodInDays)

    const onAppearanceChange = (updates: Partial<SurveyAppearance>): void => {
        setSurveyValue('appearance', { ...appearance, ...updates })
    }

    const setTriggerMode = (mode: 'pageview' | 'event'): void => {
        if (mode === 'pageview') {
            setSurveyValue('conditions', { ...conditions, events: null })
        } else {
            setSurveyValue('conditions', { ...conditions, events: { values: [], repeatedActivation: false } })
        }
    }

    const setDelaySeconds = (seconds: number): void => {
        onAppearanceChange({ surveyPopupDelaySeconds: seconds })
    }

    const setFrequency = (value: string): void => {
        const option = FREQUENCY_OPTIONS.find((opt) => opt.value === value)
        const isOnce = value === 'once'
        setSurveyValue('schedule', isOnce ? SurveySchedule.Once : SurveySchedule.Always)
        setSurveyValue('conditions', { ...conditions, seenSurveyWaitPeriodInDays: option?.days })
    }

    const setRepeatedActivation = (enabled: boolean): void => {
        setSurveyValue('conditions', {
            ...conditions,
            events: { ...conditions.events, values: conditions.events?.values || [], repeatedActivation: enabled },
        })
    }

    const addTriggerEvent = (eventName: string): void => {
        const currentEvents = conditions.events?.values || []
        if (!currentEvents.some((e) => e.name === eventName)) {
            setSurveyValue('conditions', {
                ...conditions,
                events: {
                    ...conditions.events,
                    values: [...currentEvents, { name: eventName }],
                },
            })
        }
    }

    const removeTriggerEvent = (eventName: string): void => {
        const currentEvents = conditions.events?.values || []
        const newEvents = currentEvents.filter((e) => e.name !== eventName)
        setSurveyValue('conditions', {
            ...conditions,
            events: newEvents.length > 0 ? { ...conditions.events, values: newEvents } : null,
        })
    }

    const updateTriggerEvent = (eventName: string, updatedEvent: SurveyEventsWithProperties): void => {
        const currentEvents = conditions.events?.values || []
        const newEvents = currentEvents.map((event) => (event.name === eventName ? updatedEvent : event))
        setSurveyValue('conditions', {
            ...conditions,
            events: {
                ...conditions.events,
                values: newEvents,
            },
        })
    }

    const updateTriggerEventFilters = (event: SurveyEventsWithProperties, filters: AnyPropertyFilter[]): void => {
        updateTriggerEvent(event.name, {
            ...event,
            propertyFilters: convertArrayToPropertyFilters(filters),
        })
    }

    const showFrequency = !isWidget && (triggerMode === 'pageview' || (triggerMode === 'event' && !repeatedActivation))

    return (
        <WizardStepLayout>
            <WizardSection
                title="How should this survey appear?"
                description={
                    <>
                        Looking for hosted surveys?{' '}
                        <button type="button" onClick={onOpenFullEditor} className="text-link hover:underline">
                            Open full editor
                        </button>
                    </>
                }
                descriptionClassName="text-sm"
            >
                <div className="grid grid-cols-2 gap-3">
                    <PresentationCard
                        selected={!isWidget}
                        onClick={() => {
                            setSurveyValue('type', SurveyType.Popover)
                            setSurveyValue('schedule', SurveySchedule.Once)
                            onAppearanceChange({ position: SurveyPosition.Right })
                        }}
                        title="Pop-up"
                        description="Appears in a corner of the page"
                        illustration={<PopupIllustration />}
                    />
                    <PresentationCard
                        selected={isWidget}
                        onClick={() => {
                            setSurveyValue('type', SurveyType.Widget)
                            setSurveyValue('schedule', SurveySchedule.Always)
                            setSurveyValue('conditions', {
                                ...conditions,
                                events: null,
                                seenSurveyWaitPeriodInDays: undefined,
                            })
                            onAppearanceChange({
                                position: SurveyPosition.NextToTrigger,
                                tabPosition: SurveyTabPosition.Right,
                                surveyPopupDelaySeconds: 0,
                            })
                        }}
                        title="Feedback button"
                        description="Persistent tab on the edge of the page"
                        illustration={<WidgetIllustration />}
                    />
                </div>
            </WizardSection>

            {isWidget && (
                <div className="space-y-2">
                    <LemonField.Pure label="Button label" className="gap-1">
                        <LemonInput
                            value={appearance.widgetLabel}
                            onChange={(widgetLabel) => onAppearanceChange({ widgetLabel })}
                            placeholder="Feedback"
                        />
                    </LemonField.Pure>
                </div>
            )}

            {!isWidget && (
                <>
                    <WizardSection
                        title="When should this appear?"
                        description="Choose when to show this survey to your users"
                        descriptionClassName="text-sm"
                    >
                        <LemonRadio
                            value={triggerMode}
                            onChange={setTriggerMode}
                            options={[
                                {
                                    value: 'pageview',
                                    label: 'On page load',
                                    description: 'Shows when the user visits the page',
                                },
                                {
                                    value: 'event',
                                    label: 'When an event is captured',
                                    description: 'Trigger the survey after specific events occur',
                                },
                            ]}
                        />

                        {triggerMode === 'event' && (
                            <div className="ml-6 space-y-2.5 mt-2">
                                {triggerEvents.length > 0 && (
                                    <div className="space-y-2.5">
                                        <div className="text-xs text-muted">
                                            Each event can be narrowed with optional property filters right below it.
                                        </div>
                                        {triggerEvents.map((event) => {
                                            const propertyFilterCount = getEventPropertyFilterCount(
                                                event.propertyFilters
                                            )

                                            return (
                                                <WizardPanel key={event.name} className="bg-bg-light">
                                                    <div className="flex items-start justify-between gap-3 mb-3">
                                                        <div className="space-y-1">
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <code className="text-sm font-mono">{event.name}</code>
                                                                <span className="text-xs text-muted bg-border px-1.5 py-0.5 rounded">
                                                                    {propertyFilterCount > 0
                                                                        ? `${propertyFilterCount} filter${propertyFilterCount !== 1 ? 's' : ''}`
                                                                        : 'No filters yet'}
                                                                </span>
                                                            </div>
                                                            <div className="text-xs text-muted">
                                                                Show the survey only when this event matches the
                                                                properties below.
                                                            </div>
                                                        </div>
                                                        <LemonButton
                                                            size="xsmall"
                                                            icon={<IconX />}
                                                            onClick={() => removeTriggerEvent(event.name)}
                                                            type="tertiary"
                                                        />
                                                    </div>
                                                    <PropertyFilters
                                                        propertyFilters={convertPropertyFiltersToArray(
                                                            event.propertyFilters
                                                        )}
                                                        onChange={(filters: AnyPropertyFilter[]) =>
                                                            updateTriggerEventFilters(event, filters)
                                                        }
                                                        pageKey={`survey-wizard-event-${event.name}`}
                                                        taxonomicGroupTypes={[
                                                            TaxonomicFilterGroupType.EventProperties,
                                                        ]}
                                                        excludedProperties={excludedObjectProperties}
                                                        eventNames={[event.name]}
                                                        buttonText="Add property filter"
                                                        buttonSize="small"
                                                        operatorAllowlist={SUPPORTED_OPERATORS}
                                                    />
                                                    <div className="text-xs text-muted mt-2">
                                                        Only primitive types are supported here. Array and object
                                                        properties are excluded.
                                                    </div>
                                                </WizardPanel>
                                            )
                                        })}
                                    </div>
                                )}
                                <AddEventButton onEventSelect={addTriggerEvent} addButtonText="Add event" />
                                <div className="pt-1">
                                    <LemonCheckbox
                                        checked={repeatedActivation}
                                        onChange={setRepeatedActivation}
                                        label="Show every time the event is captured"
                                    />
                                </div>
                            </div>
                        )}
                    </WizardSection>

                    {showFrequency && (
                        <WizardSection
                            title="How often can the same person see this?"
                            description="Control how frequently the same person can be shown this survey again."
                            descriptionClassName="text-sm"
                        >
                            <LemonSegmentedButton
                                value={frequency}
                                onChange={setFrequency}
                                options={FREQUENCY_OPTIONS.map((opt) => ({
                                    ...opt,
                                    tooltip:
                                        opt.value === recommendedFrequency.value
                                            ? `Recommended for this survey type`
                                            : undefined,
                                }))}
                                fullWidth
                            />

                            {recommendedFrequency.value === frequency && (
                                <p className="text-sm text-success mt-3">{recommendedFrequency.reason}</p>
                            )}
                        </WizardSection>
                    )}

                    <section className="space-y-2 border-t border-border pt-5">
                        <label className="text-sm font-medium">Delay before showing</label>
                        <div className="flex items-center gap-2">
                            <LemonInput
                                type="number"
                                min={0}
                                value={delaySeconds}
                                onChange={(val) => setDelaySeconds(Number(val) || 0)}
                                className="w-20"
                            />
                            <span className="text-secondary text-sm">seconds after conditions are met</span>
                        </div>
                        <p className="text-muted text-xs">
                            Once a user matches the targeting conditions, wait this long before displaying the survey
                        </p>
                    </section>
                </>
            )}

            <section className="space-y-2">
                <label className="text-sm font-medium">Response limit</label>
                <div className="flex items-center gap-2">
                    <LemonCheckbox
                        checked={survey.responses_limit != null}
                        onChange={(checked) => setSurveyValue('responses_limit', checked ? 100 : null)}
                        label="Stop the survey after"
                    />
                    <LemonInput
                        type="number"
                        min={1}
                        value={survey.responses_limit ?? undefined}
                        onChange={(val) => setSurveyValue('responses_limit', val && val > 0 ? val : null)}
                        className="w-20"
                    />
                    <span className="text-secondary text-sm">completed responses</span>
                </div>
                <p className="text-muted text-xs">
                    Automatically stop showing the survey once you've collected enough responses
                </p>
            </section>
        </WizardStepLayout>
    )
}

function PresentationCard({
    selected,
    onClick,
    title,
    description,
    illustration,
}: {
    selected: boolean
    onClick: () => void
    title: string
    description: string
    illustration: JSX.Element
}): JSX.Element {
    return (
        <button
            type="button"
            onClick={onClick}
            className={clsx(
                'group relative flex flex-col items-center gap-2 rounded-lg border-2 p-3 text-center transition-all duration-200',
                'hover:scale-[1.02] active:scale-[0.98]',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-3000 focus-visible:ring-offset-2',
                selected
                    ? 'border-primary-3000 bg-fill-primary-highlight shadow-md'
                    : 'border-border bg-bg-light hover:border-primary-3000 hover:shadow-sm'
            )}
        >
            <div
                className={clsx(
                    'absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full transition-all duration-200 shadow-sm',
                    selected ? 'scale-100 bg-primary-3000' : 'scale-0 bg-transparent'
                )}
            >
                <IconCheck className="h-3.5 w-3.5 text-primary-inverse" />
            </div>
            {illustration}
            <div>
                <div className="text-sm font-medium">{title}</div>
                <div className="text-xs text-muted">{description}</div>
            </div>
        </button>
    )
}

function PopupIllustration(): JSX.Element {
    return (
        <svg width="80" height="52" viewBox="0 0 80 52" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect
                x="0.5"
                y="0.5"
                width="79"
                height="51"
                rx="4"
                fill="currentColor"
                fillOpacity={0.03}
                stroke="currentColor"
                strokeOpacity={0.15}
            />
            <rect
                x="0.5"
                y="0.5"
                width="79"
                height="8"
                rx="4"
                fill="currentColor"
                fillOpacity={0.05}
                stroke="currentColor"
                strokeOpacity={0.15}
            />
            <circle cx="7" cy="5" r="1.5" fill="currentColor" fillOpacity={0.2} />
            <circle cx="12" cy="5" r="1.5" fill="currentColor" fillOpacity={0.2} />
            <circle cx="17" cy="5" r="1.5" fill="currentColor" fillOpacity={0.2} />
            <rect x="6" y="14" width="30" height="2" rx="1" fill="currentColor" fillOpacity={0.08} />
            <rect x="6" y="19" width="22" height="2" rx="1" fill="currentColor" fillOpacity={0.06} />
            <rect
                x="44"
                y="22"
                width="30"
                height="25"
                rx="3"
                fill="var(--primary-3000)"
                fillOpacity={0.12}
                stroke="var(--primary-3000)"
                strokeOpacity={0.4}
            />
            <rect x="48" y="26" width="16" height="1.5" rx="0.75" fill="var(--primary-3000)" fillOpacity={0.5} />
            <rect x="48" y="30" width="22" height="1.5" rx="0.75" fill="var(--primary-3000)" fillOpacity={0.3} />
            <rect x="48" y="33" width="18" height="1.5" rx="0.75" fill="var(--primary-3000)" fillOpacity={0.3} />
            <rect x="48" y="39" width="22" height="5" rx="2" fill="var(--primary-3000)" fillOpacity={0.35} />
        </svg>
    )
}

function WidgetIllustration(): JSX.Element {
    return (
        <svg width="80" height="52" viewBox="0 0 80 52" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect
                x="0.5"
                y="0.5"
                width="79"
                height="51"
                rx="4"
                fill="currentColor"
                fillOpacity={0.03}
                stroke="currentColor"
                strokeOpacity={0.15}
            />
            <rect
                x="0.5"
                y="0.5"
                width="79"
                height="8"
                rx="4"
                fill="currentColor"
                fillOpacity={0.05}
                stroke="currentColor"
                strokeOpacity={0.15}
            />
            <circle cx="7" cy="5" r="1.5" fill="currentColor" fillOpacity={0.2} />
            <circle cx="12" cy="5" r="1.5" fill="currentColor" fillOpacity={0.2} />
            <circle cx="17" cy="5" r="1.5" fill="currentColor" fillOpacity={0.2} />
            <rect x="6" y="14" width="30" height="2" rx="1" fill="currentColor" fillOpacity={0.08} />
            <rect x="6" y="19" width="22" height="2" rx="1" fill="currentColor" fillOpacity={0.06} />
            <rect
                x="64"
                y="20"
                width="16"
                height="24"
                rx="3"
                fill="var(--primary-3000)"
                fillOpacity={0.12}
                stroke="var(--primary-3000)"
                strokeOpacity={0.4}
            />
            <rect x="68" y="28" width="2" height="8" rx="1" fill="var(--primary-3000)" fillOpacity={0.5} />
        </svg>
    )
}
