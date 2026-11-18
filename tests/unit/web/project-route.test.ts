import { describe, expect, it } from 'vitest'

import { projectRouteOf } from '../../../web/utils/projectRoute.js'

describe('项目目录路由', () => {
  it('从当前个人根进入绑定的项目', () => {
    expect(projectRouteOf('comem', 'comem://user/alice')).toBe(
      '/files/user/alice/projects/comem',
    )
  })

  it('项目名中的空格只编码一次', () => {
    expect(projectRouteOf('space name', 'comem://user/alice/')).toBe(
      '/files/user/alice/projects/space%20name',
    )
  })

  it('未绑定项目的会话没有项目路由', () => {
    expect(projectRouteOf(undefined, 'comem://user/alice')).toBeNull()
  })
})
