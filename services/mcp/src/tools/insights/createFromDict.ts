import type { z } from 'zod'

import type { Insight } from '@/schema/insights'
import { InsightCreateFromDictSchema } from '@/schema/tool-inputs'
import type { Context, ToolBase } from '@/tools/types'

const schema = InsightCreateFromDictSchema

type Params = z.infer<typeof schema>

type Result = Insight & { url: string }

const handler: ToolBase<typeof schema, Result>['handler'] = async (context: Context, params: Params) => {
    const { data } = params
    const projectId = await context.stateManager.getProjectId()
    const insightResult = await context.api.insights({ projectId }).createFromDict({ data })
    if (!insightResult.success) {
        throw new Error(`Failed to create insight: ${insightResult.error.message}`)
    }

    return {
        ...insightResult.data,
        url: `${context.api.getProjectBaseUrl(projectId)}/insights/${insightResult.data.short_id}`,
    }
}

const tool = (): ToolBase<typeof schema, Result> => ({
    name: 'insights-create',
    schema,
    handler,
})

export default tool
