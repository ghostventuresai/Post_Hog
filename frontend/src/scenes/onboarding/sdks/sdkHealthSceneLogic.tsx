import { kea, path, selectors } from 'kea'

import { tabAwareScene } from 'lib/logic/scenes/tabAwareScene'
import { sceneConfigurations } from 'scenes/scenes'
import { Scene } from 'scenes/sceneTypes'
import { urls } from 'scenes/urls'

import { Breadcrumb } from '~/types'

import type { sdkHealthSceneLogicType } from './sdkHealthSceneLogicType'

export const sdkHealthSceneLogic = kea<sdkHealthSceneLogicType>([
    path(['scenes', 'onboarding', 'sdks', 'sdkHealthSceneLogic']),
    tabAwareScene(),
    selectors({
        breadcrumbs: [
            () => [],
            (): Breadcrumb[] => [
                {
                    key: Scene.Health,
                    name: sceneConfigurations[Scene.Health].name,
                    path: urls.health(),
                },
                {
                    key: Scene.SdkHealth,
                    name: sceneConfigurations[Scene.SdkHealth].name,
                    iconType: sceneConfigurations[Scene.SdkHealth].iconType || 'default_icon_type',
                },
            ],
        ],
    }),
])
