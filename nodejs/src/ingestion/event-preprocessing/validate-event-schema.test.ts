import { EventSchemaEnforcement, PipelineEvent, Team } from '../../types'
import { EventSchemaEnforcementManager } from '../../utils/event-schema-enforcement-manager'
import { PipelineResultType, drop, ok } from '../pipelines/results'
import { createValidateEventSchemaStep, validateEventAgainstSchema } from './validate-event-schema'

/** Helper to create an EventSchemaEnforcement with sensible defaults */
function schema(
    eventName: string,
    requiredProperties: [string, string[]][],
    enforcementMode: 'reject' | 'enforce' = 'reject',
    schemaVersion: number = 1
): EventSchemaEnforcement {
    return {
        event_name: eventName,
        enforcement_mode: enforcementMode,
        schema_version: schemaVersion,
        required_properties: new Map(requiredProperties),
    }
}

/** Creates a mock EventSchemaEnforcementManager that returns the provided schemas for any team */
function createMockSchemaManager(schemas: EventSchemaEnforcement[]): EventSchemaEnforcementManager {
    // Convert array to Map keyed by event_name for O(1) lookups
    const schemaMap = new Map(schemas.map((s) => [s.event_name, s]))
    return {
        getSchemas: jest.fn().mockResolvedValue(schemaMap),
        getSchemasForTeams: jest.fn().mockResolvedValue({}),
    } as unknown as EventSchemaEnforcementManager
}

describe('validateEventAgainstSchema', () => {
    describe('missing required fields', () => {
        it.each([
            ['undefined', undefined],
            ['null', null],
        ])('should reject when required property is %s', (_, value) => {
            const s = schema('test_event', [['required_prop', ['String']]])

            const result = validateEventAgainstSchema({ required_prop: value }, s)

            expect(result.valid).toBe(false)
            expect(result.errors).toHaveLength(1)
            expect(result.errors[0]).toEqual({
                propertyName: 'required_prop',
                reason: 'missing_required',
            })
        })

        it('should reject when required property is missing from properties object', () => {
            const s = schema('test_event', [['required_prop', ['String']]])

            const result = validateEventAgainstSchema({}, s)

            expect(result.valid).toBe(false)
            expect(result.errors[0].reason).toBe('missing_required')
        })

        it('should reject when properties object is undefined', () => {
            const s = schema('test_event', [['required_prop', ['String']]])

            const result = validateEventAgainstSchema(undefined, s)

            expect(result.valid).toBe(false)
            expect(result.errors[0].reason).toBe('missing_required')
        })

        it('should report multiple missing required fields', () => {
            const s = schema('test_event', [
                ['field1', ['String']],
                ['field2', ['Numeric']],
                ['field3', ['Boolean']],
            ])

            const result = validateEventAgainstSchema({}, s)

            expect(result.valid).toBe(false)
            expect(result.errors).toHaveLength(3)
        })
    })

    describe('String type coercion', () => {
        it.each([
            ['string', 'hello'],
            ['number', 42],
            ['boolean', true],
            ['object', { foo: 'bar' }],
            ['array', [1, 2, 3]],
        ])('should accept %s as String', (_, value) => {
            const s = schema('test_event', [['prop', ['String']]])

            const result = validateEventAgainstSchema({ prop: value }, s)

            expect(result.valid).toBe(true)
        })
    })

    describe('Numeric type coercion', () => {
        it.each([
            ['integer', 42],
            ['float', 3.14],
            ['negative number', -10],
            ['zero', 0],
            ['numeric string', '42'],
            ['negative numeric string', '-10'],
            ['float string', '3.14'],
        ])('should accept %s as Numeric', (_, value) => {
            const s = schema('test_event', [['prop', ['Numeric']]])

            const result = validateEventAgainstSchema({ prop: value }, s)

            expect(result.valid).toBe(true)
        })

        it.each([
            ['non-numeric string', 'hello'],
            ['empty string', ''],
            ['whitespace string', '   '],
            ['object', { foo: 'bar' }],
            ['array', [1, 2, 3]],
            ['boolean true', true],
            ['boolean false', false],
            ['Infinity', Infinity],
            ['-Infinity', -Infinity],
            ['NaN', NaN],
            ['string "Infinity"', 'Infinity'],
            ['string "-Infinity"', '-Infinity'],
            ['string "NaN"', 'NaN'],
        ])('should reject %s as Numeric', (_, value) => {
            const s = schema('test_event', [['prop', ['Numeric']]])

            const result = validateEventAgainstSchema({ prop: value }, s)

            expect(result.valid).toBe(false)
            expect(result.errors[0].reason).toBe('type_mismatch')
        })
    })

    describe('Boolean type coercion', () => {
        it.each([
            ['true', true],
            ['false', false],
            ['string "true"', 'true'],
            ['string "false"', 'false'],
        ])('should accept %s as Boolean', (_, value) => {
            const s = schema('test_event', [['prop', ['Boolean']]])

            const result = validateEventAgainstSchema({ prop: value }, s)

            expect(result.valid).toBe(true)
        })

        it.each([
            ['number 1', 1],
            ['number 0', 0],
            ['string "yes"', 'yes'],
            ['string "no"', 'no'],
            ['string "TRUE"', 'TRUE'],
            ['string "FALSE"', 'FALSE'],
            ['string "True"', 'True'],
            ['string "False"', 'False'],
            ['object', {}],
            ['array', []],
        ])('should reject %s as Boolean', (_, value) => {
            const s = schema('test_event', [['prop', ['Boolean']]])

            const result = validateEventAgainstSchema({ prop: value }, s)

            expect(result.valid).toBe(false)
            expect(result.errors[0].reason).toBe('type_mismatch')
        })
    })

    describe('DateTime type coercion', () => {
        it.each([
            ['unix timestamp', 1609459200],
            ['ISO string', '2021-01-01T00:00:00Z'],
            ['ISO string with offset', '2021-01-01T00:00:00+00:00'],
            ['date string', '2021-01-01'],
        ])('should accept %s as DateTime', (_, value) => {
            const s = schema('test_event', [['prop', ['DateTime']]])

            const result = validateEventAgainstSchema({ prop: value }, s)

            expect(result.valid).toBe(true)
        })

        it.each([
            ['invalid date string', 'not-a-date'],
            ['object', {}],
            ['array', []],
            ['boolean', true],
        ])('should reject %s as DateTime', (_, value) => {
            const s = schema('test_event', [['prop', ['DateTime']]])

            const result = validateEventAgainstSchema({ prop: value }, s)

            expect(result.valid).toBe(false)
            expect(result.errors[0].reason).toBe('type_mismatch')
        })
    })

    describe('Object type coercion', () => {
        it.each([
            ['plain object', { foo: 'bar' }],
            ['empty object', {}],
            ['array', [1, 2, 3]],
            ['empty array', []],
        ])('should accept %s as Object', (_, value) => {
            const s = schema('test_event', [['prop', ['Object']]])

            const result = validateEventAgainstSchema({ prop: value }, s)

            expect(result.valid).toBe(true)
        })

        it.each([
            ['string', 'hello'],
            ['number', 42],
            ['boolean', true],
        ])('should reject %s as Object', (_, value) => {
            const s = schema('test_event', [['prop', ['Object']]])

            const result = validateEventAgainstSchema({ prop: value }, s)

            expect(result.valid).toBe(false)
            expect(result.errors[0].reason).toBe('type_mismatch')
        })
    })

    describe('multiple required properties', () => {
        it('should accept when all required properties pass validation', () => {
            const s = schema('test_event', [
                ['name', ['String']],
                ['age', ['Numeric']],
            ])

            const result = validateEventAgainstSchema({ name: 'alice', age: 30 }, s)

            expect(result.valid).toBe(true)
        })

        it('should reject when one of multiple required properties fails', () => {
            const s = schema('test_event', [
                ['name', ['String']],
                ['age', ['Numeric']],
            ])

            const result = validateEventAgainstSchema({ name: 'alice', age: 'not-a-number' }, s)

            expect(result.valid).toBe(false)
            expect(result.errors).toHaveLength(1)
            expect(result.errors[0].propertyName).toBe('age')
        })
    })

    describe('multi-type properties', () => {
        it('should accept value matching any of the listed types', () => {
            const s = schema('test_event', [['prop', ['String', 'Numeric']]])

            expect(validateEventAgainstSchema({ prop: 'hello' }, s).valid).toBe(true)
            expect(validateEventAgainstSchema({ prop: 42 }, s).valid).toBe(true)
        })

        it('should reject value matching none of the listed types', () => {
            const s = schema('test_event', [['prop', ['Numeric', 'Boolean']]])

            const result = validateEventAgainstSchema({ prop: { nested: true } }, s)

            expect(result.valid).toBe(false)
            expect(result.errors[0].expectedTypes).toEqual(['Numeric', 'Boolean'])
        })
    })

    describe('unknown types', () => {
        it('should allow values for unknown property types', () => {
            const s = schema('test_event', [['prop', ['UnknownType']]])

            const result = validateEventAgainstSchema({ prop: 'anything' }, s)

            expect(result.valid).toBe(true)
        })
    })
})

describe('createValidateEventSchemaStep', () => {
    const createInput = (
        eventName: string,
        properties: Record<string, unknown> | undefined,
        teamOverrides?: Partial<Team>
    ) => ({
        event: {
            event: eventName,
            distinct_id: 'user123',
            team_id: 1,
            uuid: '123e4567-e89b-12d3-a456-426614174000',
            ip: '127.0.0.1',
            site_url: 'https://example.com',
            now: '2021-01-01T00:00:00Z',
            properties,
        } as PipelineEvent,
        team: {
            id: 1,
            name: 'Test Team',
            schema_validation_disabled: null,
            ...teamOverrides,
        } as unknown as Team,
    })

    it('should pass events when team has no enforced schemas', async () => {
        const mockManager = createMockSchemaManager([])
        const step = createValidateEventSchemaStep(mockManager)
        const input = createInput('test_event', { prop: 'value' })

        const result = await step(input)

        expect(result).toEqual(ok(input))
    })

    it('should pass events that have no matching schema', async () => {
        const mockManager = createMockSchemaManager([schema('other_event', [['required_prop', ['String']]])])
        const step = createValidateEventSchemaStep(mockManager)
        const input = createInput('test_event', {})

        const result = await step(input)

        expect(result).toEqual(ok(input))
    })

    it('should pass events that match schema requirements', async () => {
        const mockManager = createMockSchemaManager([schema('test_event', [['required_prop', ['String']]])])
        const step = createValidateEventSchemaStep(mockManager)
        const input = createInput('test_event', { required_prop: 'hello' })

        const result = await step(input)

        expect(result).toEqual(ok(input))
    })

    it('should drop events missing required properties', async () => {
        const mockManager = createMockSchemaManager([schema('test_event', [['required_prop', ['String']]])])
        const step = createValidateEventSchemaStep(mockManager)
        const input = createInput('test_event', {})

        const result = await step(input)

        expect(result).toEqual(
            drop(
                'schema_validation_failed',
                [],
                [
                    {
                        type: 'schema_validation_failed',
                        details: {
                            eventUuid: '123e4567-e89b-12d3-a456-426614174000',
                            eventName: 'test_event',
                            distinctId: 'user123',
                            errors: [
                                {
                                    property: 'required_prop',
                                    reason: 'missing_required',
                                    expectedTypes: undefined,
                                    actualValue: undefined,
                                },
                            ],
                        },
                    },
                ]
            )
        )
    })

    it('should drop events with type mismatch on required properties', async () => {
        const mockManager = createMockSchemaManager([schema('test_event', [['numeric_prop', ['Numeric']]])])
        const step = createValidateEventSchemaStep(mockManager)
        const input = createInput('test_event', { numeric_prop: 'not-a-number' })

        const result = await step(input)

        expect(result).toEqual(
            drop(
                'schema_validation_failed',
                [],
                [
                    {
                        type: 'schema_validation_failed',
                        details: {
                            eventUuid: '123e4567-e89b-12d3-a456-426614174000',
                            eventName: 'test_event',
                            distinctId: 'user123',
                            errors: [
                                {
                                    property: 'numeric_prop',
                                    reason: 'type_mismatch',
                                    expectedTypes: ['Numeric'],
                                    actualValue: 'not-a-number',
                                },
                            ],
                        },
                    },
                ]
            )
        )
    })

    it('should include multiple errors in warning details', async () => {
        const mockManager = createMockSchemaManager([
            schema('test_event', [
                ['field1', ['String']],
                ['field2', ['Numeric']],
            ]),
        ])
        const step = createValidateEventSchemaStep(mockManager)
        const input = createInput('test_event', { field2: 'not-numeric' })

        const result = await step(input)

        expect(result.type).toBe(PipelineResultType.DROP)
        if (result.type === PipelineResultType.DROP) {
            expect(result.warnings[0].details.errors).toHaveLength(2)
        }
    })

    it('should stringify object values in error details', async () => {
        const mockManager = createMockSchemaManager([schema('test_event', [['prop', ['Boolean']]])])
        const step = createValidateEventSchemaStep(mockManager)
        const input = createInput('test_event', { prop: { nested: 'object' } })

        const result = await step(input)

        expect(result.type).toBe(PipelineResultType.DROP)
        if (result.type === PipelineResultType.DROP) {
            expect(result.warnings[0].details.errors[0].actualValue).toBe('{"nested":"object"}')
        }
    })

    describe('version stamping', () => {
        it('should stamp +version on successful reject mode validation', async () => {
            const mockManager = createMockSchemaManager([schema('test_event', [['prop', ['String']]], 'reject', 3)])
            const step = createValidateEventSchemaStep(mockManager)
            const input = createInput('test_event', { prop: 'hello' })

            await step(input)

            expect(input.event.validated_schema_version).toBe(3)
        })

        it('should stamp +version on successful enforce mode validation', async () => {
            const mockManager = createMockSchemaManager([schema('test_event', [['prop', ['String']]], 'enforce', 5)])
            const step = createValidateEventSchemaStep(mockManager)
            const input = createInput('test_event', { prop: 'hello' })

            await step(input)

            expect(input.event.validated_schema_version).toBe(5)
        })

        it('should stamp -version on failed enforce mode validation', async () => {
            const mockManager = createMockSchemaManager([schema('test_event', [['prop', ['Numeric']]], 'enforce', 7)])
            const step = createValidateEventSchemaStep(mockManager)
            const input = createInput('test_event', { prop: 'not-a-number' })

            const result = await step(input)

            expect(result.type).toBe(PipelineResultType.OK)
            expect(input.event.validated_schema_version).toBe(-7)
        })

        it('should include warnings on failed enforce mode validation', async () => {
            const mockManager = createMockSchemaManager([schema('test_event', [['prop', ['Numeric']]], 'enforce', 1)])
            const step = createValidateEventSchemaStep(mockManager)
            const input = createInput('test_event', { prop: 'not-a-number' })

            const result = await step(input)

            expect(result.type).toBe(PipelineResultType.OK)
            if (result.type === PipelineResultType.OK) {
                expect(result.warnings).toHaveLength(1)
                expect(result.warnings[0].type).toBe('schema_validation_failed')
            }
        })

        it('should not stamp version when no schema matches', async () => {
            const mockManager = createMockSchemaManager([schema('other_event', [['prop', ['String']]], 'enforce', 1)])
            const step = createValidateEventSchemaStep(mockManager)
            const input = createInput('test_event', { prop: 'hello' })

            await step(input)

            expect(input.event.validated_schema_version).toBeUndefined()
        })
    })

    describe('kill switch', () => {
        it('should skip validation when schema_validation_disabled is true', async () => {
            const mockManager = createMockSchemaManager([schema('test_event', [['prop', ['String']]], 'reject', 1)])
            const step = createValidateEventSchemaStep(mockManager)
            const input = createInput('test_event', {}, { schema_validation_disabled: true })

            const result = await step(input)

            expect(result.type).toBe(PipelineResultType.OK)
            expect(input.event.validated_schema_version).toBeUndefined()
            expect(mockManager.getSchemas).not.toHaveBeenCalled()
        })

        it('should validate normally when schema_validation_disabled is false', async () => {
            const mockManager = createMockSchemaManager([schema('test_event', [['prop', ['String']]], 'reject', 1)])
            const step = createValidateEventSchemaStep(mockManager)
            const input = createInput('test_event', {})

            const result = await step(input)

            expect(result.type).toBe(PipelineResultType.DROP)
        })

        it('should validate normally when schema_validation_disabled is null', async () => {
            const mockManager = createMockSchemaManager([schema('test_event', [['prop', ['String']]], 'reject', 1)])
            const step = createValidateEventSchemaStep(mockManager)
            const input = createInput('test_event', {}, { schema_validation_disabled: null })

            const result = await step(input)

            expect(result.type).toBe(PipelineResultType.DROP)
        })
    })
})
