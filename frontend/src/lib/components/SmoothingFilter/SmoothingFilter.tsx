import { useActions, useValues } from 'kea'

import { IconPulse } from '@posthog/icons'
import { LemonSelect } from '@posthog/lemon-ui'

import { insightLogic } from 'scenes/insights/insightLogic'
import { insightVizDataLogic } from 'scenes/insights/insightVizDataLogic'
import { trendsDataLogic } from 'scenes/trends/trendsDataLogic'

import { TrendsFilter } from '~/queries/schema/schema-general'

import { smoothingOptions } from './smoothings'

type TrendsFilterWithTransforms = TrendsFilter & { showFirstDifferences?: boolean }

export function SmoothingFilter(): JSX.Element | null {
    const { insightProps, editingDisabledReason } = useValues(insightLogic)
    const { isTrends, interval, trendsFilter } = useValues(trendsDataLogic(insightProps))
    const { updateInsightFilter } = useActions(insightVizDataLogic(insightProps))

    if (!isTrends || !interval) {
        return null
    }

    const trendsFilterWithTransforms = (trendsFilter || {}) as TrendsFilterWithTransforms
    const { smoothingIntervals } = trendsFilterWithTransforms
    const showFirstDifferences = trendsFilterWithTransforms.showFirstDifferences === true

    const baseOptions = smoothingOptions[interval].map(({ value, label }) => ({
        value,
        label: value === 1 ? 'No transformations' : label,
    }))

    const optionsWithFallback =
        baseOptions.length > 0
            ? baseOptions
            : [
                  {
                      value: 1,
                      label: 'No transformations',
                  },
              ]

    const selectedValue = showFirstDifferences ? 'first_differences' : smoothingIntervals || 1

    const options = [
        ...optionsWithFallback,
        {
            value: 'first_differences' as const,
            label: 'First differences',
        },
    ].map(({ value, label }) => ({
        value,
        label:
            value === selectedValue ? (
                <>
                    <IconPulse className="mr-1.5 text-secondary" />
                    {label}
                </>
            ) : (
                label
            ),
        labelInMenu: label,
    }))

    return options.length ? (
        <LemonSelect
            key={interval}
            value={selectedValue}
            dropdownMatchSelectWidth={false}
            onChange={(key) => {
                if (key === 'first_differences') {
                    updateInsightFilter({
                        smoothingIntervals: 1,
                        showFirstDifferences: true,
                    } as Partial<TrendsFilterWithTransforms>)
                    return
                }

                updateInsightFilter({
                    smoothingIntervals: key,
                    showFirstDifferences: false,
                } as Partial<TrendsFilterWithTransforms>)
            }}
            data-attr="series-transform-filter"
            options={options}
            size="small"
            disabledReason={editingDisabledReason}
        />
    ) : (
        <></>
    )
}
