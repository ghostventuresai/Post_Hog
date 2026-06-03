import { Properties } from '~/plugin-scaffold'
import { forSnapshot } from '~/tests/helpers/snapshots'

import {
    createTeam,
    getFirstTeam,
    resetTestDatabase,
    updateOrganizationAvailableFeatures,
} from '../../tests/helpers/sql'
import { defaultConfig } from '../config/config'
import { Hub, Team } from '../types'
import { closeHub, createHub } from './db/hub'
import { PostgresRouter, PostgresUse } from './db/postgres'
import { captureTeamEvent } from './posthog'
import { TeamManager } from './team-manager'

jest.mock('./posthog', () => ({
    ...jest.requireActual('./posthog'),
    captureTeamEvent: jest.fn(),
}))

describe('TeamManager()', () => {
    let hub: Hub
    let teamManager: TeamManager
    let postgres: PostgresRouter
    let teamId: Team['id']
    let teamToken: Team['api_token']
    let organizationId: Team['organization_id']
    let fetchTeamsSpy: jest.SpyInstance

    beforeEach(async () => {
        const now = Date.now()
        jest.spyOn(Date, 'now').mockImplementation(() => now)

        hub = await createHub()
        await resetTestDatabase()

        postgres = new PostgresRouter(defaultConfig)
        teamManager = new TeamManager(postgres)
        const team = await getFirstTeam(hub.postgres)
        teamId = team.id
        teamToken = team.api_token
        organizationId = team.organization_id
        fetchTeamsSpy = jest.spyOn(teamManager as any, 'fetchTeams')
    })

    afterEach(async () => {
        await closeHub(hub)
    })

    describe('getTeam()', () => {
        it('returns the team', async () => {
            const result = await teamManager.getTeam(teamId)
            // This one test is a snapshot to ensure the team object is stable
            expect(forSnapshot(result)).toMatchInlineSnapshot(`
                {
                  "anonymize_ips": false,
                  "api_token": "THIS IS NOT A TOKEN FOR TEAM 2",
                  "available_features": [
                    "data_pipelines",
                  ],
                  "cookieless_server_hash_mode": 2,
                  "drop_events_older_than_seconds": null,
                  "extra_settings": null,
                  "heatmaps_opt_in": null,
                  "id": 2,
                  "ingested_event": true,
                  "ingested_production_event": false,
                  "logs_settings": null,
                  "name": "TEST PROJECT",
                  "organization_id": "<REPLACED-UUID-1>",
                  "person_display_name_properties": [],
                  "person_processing_opt_out": null,
                  "project_id": 2,
                  "secret_api_token": null,
                  "session_recording_opt_in": true,
                  "timezone": "UTC",
                  "uuid": "<REPLACED-UUID-0>",
                }
            `)
        })

        it('returns null if the team does not exist', async () => {
            const result = await teamManager.getTeam(9999)
            expect(result).toBeNull()
        })

        it('returns null if the team ID is larger than 32-bit integer and could overflow DB col type', async () => {
            const result = await teamManager.getTeam(12345678901234)
            expect(result).toBeNull()
        })

        it('caches the team for second lookup whether on token or id', async () => {
            const result = await teamManager.getTeam(teamId)
            expect(result?.id).toEqual(teamId)
            expect(fetchTeamsSpy).toHaveBeenCalledTimes(1)

            const result2 = await teamManager.getTeam(teamId)
            expect(result2?.id).toEqual(teamId)
            expect(fetchTeamsSpy).toHaveBeenCalledTimes(1)

            const result3 = await teamManager.getTeamByToken(result!.api_token)
            expect(result3?.id).toEqual(teamId)
            expect(fetchTeamsSpy).toHaveBeenCalledTimes(1)
        })

        it('efficiently loads multiple teams', async () => {
            const promises = [
                teamManager.getTeam(teamId),
                teamManager.getTeamByToken(teamToken),
                teamManager.getTeam(teamId),
                teamManager.getTeamByToken(teamToken),
                teamManager.getTeamByToken('missing'),
            ]
            const results = await Promise.all(promises)
            expect(fetchTeamsSpy).toHaveBeenCalledTimes(1)
            expect(results.map((r) => r?.id)).toEqual([teamId, teamId, teamId, teamId, undefined])
        })

        it('caches null results for non-existing tokens', async () => {
            const nonExistentToken = 'non-existent-token'
            const result1 = await teamManager.getTeamByToken(nonExistentToken)
            expect(result1).toBeNull()
            expect(fetchTeamsSpy).toHaveBeenCalledTimes(1)

            const result2 = await teamManager.getTeamByToken(nonExistentToken)
            expect(result2).toBeNull()
            expect(fetchTeamsSpy).toHaveBeenCalledTimes(1)
        })

        it('correctly handles mix of existing and non-existing teams', async () => {
            const nonExistentId = 9999
            const [existingTeam, nonExistingTeam] = await Promise.all([
                teamManager.getTeam(teamId),
                teamManager.getTeam(nonExistentId),
            ])

            expect(existingTeam?.id).toEqual(teamId)
            expect(nonExistingTeam).toBeNull()
            expect(fetchTeamsSpy).toHaveBeenCalledTimes(1)

            // Second fetch should use cache for both
            const [existingTeam2, nonExistingTeam2] = await Promise.all([
                teamManager.getTeam(teamId),
                teamManager.getTeam(nonExistentId),
            ])
            expect(existingTeam2?.id).toEqual(teamId)
            expect(nonExistingTeam2).toBeNull()
            expect(fetchTeamsSpy).toHaveBeenCalledTimes(1)
        })

        it('correctly fetches drop_events_older_than setting', async () => {
            // Get the organization ID from the first team
            const firstTeam = await teamManager.getTeam(teamId)
            const organizationId = firstTeam!.organization_id

            // Create a new team with drop_events_older_than set
            const newTeamId = await createTeam(postgres, organizationId, undefined, {
                drop_events_older_than: 86400, // 24 hours in seconds
            })

            // Fetch the new team
            const newTeam = await teamManager.getTeam(newTeamId)
            expect(newTeam).not.toBeNull()
            expect(newTeam!.drop_events_older_than_seconds).toBe(86400)

            // Verify the setting is also accessible via token
            const newTeamByToken = await teamManager.getTeamByToken(newTeam!.api_token)
            expect(newTeamByToken).not.toBeNull()
            expect(newTeamByToken!.drop_events_older_than_seconds).toBe(86400)
        })

        it('correctly fetches drop_events_older_than setting when set to 0', async () => {
            // Get the organization ID from the first team
            const firstTeam = await teamManager.getTeam(teamId)
            const organizationId = firstTeam!.organization_id

            // Create a new team with drop_events_older_than set to 0
            const newTeamId = await createTeam(postgres, organizationId, undefined, {
                drop_events_older_than: 0, // 0 seconds
            })

            // Fetch the new team
            const newTeam = await teamManager.getTeam(newTeamId)
            expect(newTeam).not.toBeNull()
            expect(newTeam!.drop_events_older_than_seconds).toBe(0)

            // Verify the setting is also accessible via token
            const newTeamByToken = await teamManager.getTeamByToken(newTeam!.api_token)
            expect(newTeamByToken).not.toBeNull()
            expect(newTeamByToken!.drop_events_older_than_seconds).toBe(0)
        })

        it('correctly fetches drop_events_older_than setting when set to null', async () => {
            // Get the organization ID from the first team
            const firstTeam = await teamManager.getTeam(teamId)
            const organizationId = firstTeam!.organization_id

            // Create a new team with drop_events_older_than set to null
            const newTeamId = await createTeam(postgres, organizationId, undefined, {
                drop_events_older_than: null,
            })

            // Fetch the new team
            const newTeam = await teamManager.getTeam(newTeamId)
            expect(newTeam).not.toBeNull()
            expect(newTeam!.drop_events_older_than_seconds).toBeNull()

            // Verify the setting is also accessible via token
            const newTeamByToken = await teamManager.getTeamByToken(newTeam!.api_token)
            expect(newTeamByToken).not.toBeNull()
            expect(newTeamByToken!.drop_events_older_than_seconds).toBeNull()
        })
    })

    describe('hasAvailableFeature()', () => {
        it('returns false by default', async () => {
            await updateOrganizationAvailableFeatures(postgres, organizationId, [])
            const result = await teamManager.hasAvailableFeature(teamId, 'data_pipelines')
            expect(result).toBe(false)
        })

        it('returns false if the available features does not exist', async () => {
            await updateOrganizationAvailableFeatures(postgres, organizationId, [
                { key: 'not_data_pipelines', name: 'Feature 1' },
            ])
            const result = await teamManager.hasAvailableFeature(teamId, 'data_pipelines')
            expect(result).toBe(false)
        })

        it('returns true if the available features exists', async () => {
            await updateOrganizationAvailableFeatures(postgres, organizationId, [
                { key: 'data_pipelines', name: 'Feature 1' },
            ])
            const result = await teamManager.hasAvailableFeature(teamId, 'data_pipelines')
            expect(result).toBe(true)
        })
    })

    describe('setTeamIngestedEvent()', () => {
        const PRODUCTION_PROPERTIES: Properties = { $host: 'app.posthog.com', $lib: 'web', realm: 'cloud' }
        const LOCALHOST_PROPERTIES: Properties = { $host: 'localhost:3000', $lib: 'web', realm: 'cloud' }
        const SERVER_SIDE_PROPERTIES: Properties = { $lib: 'posthog-python', realm: 'hosted' } // no $host

        const fetchFlags = async (
            id: number
        ): Promise<{ ingested_event: boolean; ingested_production_event: boolean }> => {
            const result = await postgres.query<{ ingested_event: boolean; ingested_production_event: boolean }>(
                PostgresUse.COMMON_READ,
                'SELECT ingested_event, ingested_production_event FROM posthog_team WHERE id = $1',
                [id],
                'test-fetch-ingestion-flags'
            )
            return result.rows[0]
        }

        const teamWithFlags = async (flags: {
            ingested_event: boolean
            ingested_production_event: boolean
        }): Promise<Team> => {
            const newTeamId = await createTeam(postgres, organizationId, undefined, flags)
            return (await teamManager.getTeam(newTeamId))!
        }

        beforeEach(() => {
            jest.mocked(captureTeamEvent).mockClear()
        })

        it('fires both flags when a fresh team ingests a production event', async () => {
            const team = await teamWithFlags({ ingested_event: false, ingested_production_event: false })

            await teamManager.setTeamIngestedEvent(team, PRODUCTION_PROPERTIES)

            expect(await fetchFlags(team.id)).toEqual({ ingested_event: true, ingested_production_event: true })
            expect(captureTeamEvent).toHaveBeenCalledTimes(2)
            expect(captureTeamEvent).toHaveBeenCalledWith(
                expect.objectContaining({ id: team.id }),
                'first team event ingested',
                { sdk: 'web', realm: 'cloud', host: 'app.posthog.com' },
                expect.any(String)
            )
            expect(captureTeamEvent).toHaveBeenCalledWith(
                expect.objectContaining({ id: team.id }),
                'first team production event ingested',
                { sdk: 'web', realm: 'cloud', host: 'app.posthog.com' },
                expect.any(String)
            )
        })

        it('fires only the first-event flag for a localhost (dev) event', async () => {
            const team = await teamWithFlags({ ingested_event: false, ingested_production_event: false })

            await teamManager.setTeamIngestedEvent(team, LOCALHOST_PROPERTIES)

            expect(await fetchFlags(team.id)).toEqual({ ingested_event: true, ingested_production_event: false })
            expect(captureTeamEvent).toHaveBeenCalledTimes(1)
            expect(captureTeamEvent).toHaveBeenCalledWith(
                expect.objectContaining({ id: team.id }),
                'first team event ingested',
                expect.any(Object),
                expect.any(String)
            )
        })

        it('fires only the first-event flag for a server-side event with no host signal', async () => {
            const team = await teamWithFlags({ ingested_event: false, ingested_production_event: false })

            await teamManager.setTeamIngestedEvent(team, SERVER_SIDE_PROPERTIES)

            expect(await fetchFlags(team.id)).toEqual({ ingested_event: true, ingested_production_event: false })
            expect(captureTeamEvent).toHaveBeenCalledTimes(1)
            expect(captureTeamEvent).toHaveBeenCalledWith(
                expect.objectContaining({ id: team.id }),
                'first team event ingested',
                expect.any(Object),
                expect.any(String)
            )
        })

        it('fires the production flag late, for a team that already ingested its first (dev) event', async () => {
            const team = await teamWithFlags({ ingested_event: true, ingested_production_event: false })

            await teamManager.setTeamIngestedEvent(team, PRODUCTION_PROPERTIES)

            expect(await fetchFlags(team.id)).toEqual({ ingested_event: true, ingested_production_event: true })
            expect(captureTeamEvent).toHaveBeenCalledTimes(1)
            expect(captureTeamEvent).toHaveBeenCalledWith(
                expect.objectContaining({ id: team.id }),
                'first team production event ingested',
                expect.any(Object),
                expect.any(String)
            )
        })

        it('is a no-op when both flags are already set', async () => {
            const team = await teamWithFlags({ ingested_event: true, ingested_production_event: true })

            await teamManager.setTeamIngestedEvent(team, PRODUCTION_PROPERTIES)

            expect(await fetchFlags(team.id)).toEqual({ ingested_event: true, ingested_production_event: true })
            expect(captureTeamEvent).not.toHaveBeenCalled()
        })
    })
})
