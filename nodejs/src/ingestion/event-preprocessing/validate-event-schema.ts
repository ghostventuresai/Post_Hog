import { EventSchemaEnforcement, PipelineEvent, Team } from '../../types'
import { EventSchemaEnforcementManager } from '../../utils/event-schema-enforcement-manager'
import { PipelineWarning } from '../pipelines/pipeline.interface'
import { drop, ok } from '../pipelines/results'
import { ProcessingStep } from '../pipelines/steps'
import { isValidClickHouseDateTime } from './clickhouse-datetime-parser'

/**
 * Checks if a value can be coerced to the given PostHog property type.
 * See: PropertySwapper._field_type_to_property_call in posthog/hogql/transforms/property_types.py
 */
function canCoerceToType(value: unknown, propertyType: string): boolean {
    if (value === null || value === undefined) {
        return false
    }

    switch (propertyType) {
        case 'String':
            // Everything can be coerced to string
            return true

        case 'Numeric':
            // Accepts: numbers, numeric strings
            // Rejects: Infinity, -Infinity, NaN, booleans (these become null in ClickHouse)
            if (typeof value === 'number') {
                return Number.isFinite(value)
            }
            if (typeof value === 'string') {
                const trimmed = value.trim()
                const num = Number(trimmed)
                return trimmed !== '' && Number.isFinite(num)
            }
            return false

        case 'Boolean':
            // Accepts: booleans, "true"/"false" strings (case sensitive - ClickHouse transform only matches lowercase)
            if (typeof value === 'boolean') {
                return true
            }
            if (typeof value === 'string') {
                return value === 'true' || value === 'false'
            }
            return false

        case 'DateTime':
            return isValidClickHouseDateTime(value)

        case 'Object':
            return typeof value === 'object'

        default:
            // Unknown type - allow by default
            return true
    }
}

export interface SchemaValidationError {
    propertyName: string
    reason: 'missing_required' | 'type_mismatch'
    expectedTypes?: string[]
    actualValue?: unknown
}

export interface SchemaValidationResult {
    valid: boolean
    errors: SchemaValidationError[]
}

/**
 * Validates an event's properties against an enforced schema.
 * Only required properties are validated - optional properties are not included in the schema.
 */
export function validateEventAgainstSchema(
    eventProperties: Record<string, unknown> | undefined,
    schema: EventSchemaEnforcement
): SchemaValidationResult {
    const errors: SchemaValidationError[] = []

    for (const [propertyName, propertyTypes] of schema.required_properties) {
        const value = eventProperties?.[propertyName]

        if (value === null || value === undefined) {
            errors.push({
                propertyName,
                reason: 'missing_required',
            })
            continue
        }

        if (!propertyTypes.some((type) => canCoerceToType(value, type))) {
            errors.push({
                propertyName,
                reason: 'type_mismatch',
                expectedTypes: propertyTypes,
                actualValue: value,
            })
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

function buildSchemaValidationWarning(event: PipelineEvent, validationResult: SchemaValidationResult): PipelineWarning {
    return {
        type: 'schema_validation_failed',
        details: {
            eventUuid: event.uuid,
            eventName: event.event,
            distinctId: event.distinct_id,
            errors: validationResult.errors.map((err) => ({
                property: err.propertyName,
                reason: err.reason,
                expectedTypes: err.expectedTypes,
                actualValue:
                    err.actualValue !== undefined
                        ? typeof err.actualValue === 'object'
                            ? JSON.stringify(err.actualValue)
                            : String(err.actualValue)
                        : undefined,
            })),
        },
    }
}

/**
 * Creates a processing step that validates events against enforced schemas.
 *
 * Behavior depends on the enforcement mode:
 * - `reject`: events that fail validation are dropped with an ingestion warning
 * - `enforce`: events are always passed through, but stamped with +version (pass) or -version (fail)
 *
 * The kill switch `team.schema_validation_disabled` bypasses all validation.
 *
 * @param schemaManager - Manager for fetching enforced schemas (uses caching internally)
 */
export function createValidateEventSchemaStep<T extends { event: PipelineEvent; team: Team }>(
    schemaManager: EventSchemaEnforcementManager
): ProcessingStep<T, T> {
    return async function validateEventSchemaStep(input) {
        const { event, team } = input

        if (team.schema_validation_disabled) {
            return ok(input)
        }

        const enforcedSchemas = await schemaManager.getSchemas(team.id)
        if (enforcedSchemas.size === 0) {
            return ok(input)
        }

        const schema = enforcedSchemas.get(event.event)
        if (!schema) {
            return ok(input)
        }

        const validationResult = validateEventAgainstSchema(event.properties, schema)

        if (schema.enforcement_mode === 'enforce') {
            // Enforce mode: stamp version and always pass through
            if (validationResult.valid) {
                event.validated_schema_version = schema.schema_version
            } else {
                event.validated_schema_version = -schema.schema_version
            }
            const warnings = validationResult.valid ? [] : [buildSchemaValidationWarning(event, validationResult)]
            return ok(input, [], warnings)
        }

        // Reject mode: drop on failure, stamp on success
        if (!validationResult.valid) {
            return drop('schema_validation_failed', [], [buildSchemaValidationWarning(event, validationResult)])
        }

        event.validated_schema_version = schema.schema_version
        return ok(input)
    }
}
