<script setup lang="ts">
/**
 * 工具（架构文档 §13.2、§16）。
 *
 * 16 个 MCP 工具的只读清单。**名字与说明都从服务端读**（`GET /mcp/tools`），不在
 * 界面里重写一份：模型读到的文本与这里展示的必须是同一份，否则「界面说这个工具
 * 能做什么」与「模型以为它能做什么」会漂移，而漂移的症状是模型调用方式不对。
 *
 * 工具数是硬约束（16 个，不多不少，AGENTS.md）。这一页只是展示，不是第 17 个
 * 工具——它不执行任何工具，也不接收参数。
 */
import { AlertTriangle, RefreshCw, Terminal } from 'lucide-vue-next'

import {
  errorMessageOf,
  useApi,
  type McpToolPayload,
  type McpToolsPayload,
} from '~/composables/useApi'
import { mcpToolKindLabel, mcpToolKindRank, type McpToolKind } from '~/utils/toolLabels'

useHead({ title: '工具 · CoMem 控制台' })

const api = useApi()

const tools = ref<readonly McpToolPayload[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

interface ToolGroup {
  readonly kind: string
  readonly label: string
  readonly tools: readonly McpToolPayload[]
}

const groups = computed<readonly ToolGroup[]>(() => {
  const ordered = [...tools.value].sort(
    (left, right) => mcpToolKindRank(left.kind) - mcpToolKindRank(right.kind),
  )

  const byKind = new Map<McpToolKind, McpToolPayload[]>()
  for (const tool of ordered) {
    const bucket = byKind.get(tool.kind)
    if (bucket === undefined) {
      byKind.set(tool.kind, [tool])
    } else {
      bucket.push(tool)
    }
  }

  return [...byKind].map(([kind, items]) => ({
    kind,
    label: mcpToolKindLabel(kind),
    tools: items,
  }))
})

interface ToolParameter {
  readonly name: string
  readonly required: boolean
}

/**
 * 参数名来自 JSON Schema 的 `properties` 键。
 *
 * 只取键名与 `required`：完整 schema 是给调用方校验用的，界面列出来只会让人以为
 * 「界面能发请求」。参数说明本来就在工具说明里。
 */
function parametersOf(tool: McpToolPayload): readonly ToolParameter[] {
  const properties = tool.inputSchema['properties']
  if (typeof properties !== 'object' || properties === null) {
    return []
  }
  const required = tool.inputSchema['required']
  const requiredNames = new Set(
    Array.isArray(required)
      ? required.filter((item): item is string => typeof item === 'string')
      : [],
  )
  return Object.keys(properties).map((name) => ({ name, required: requiredNames.has(name) }))
}

function parameterText(tool: McpToolPayload): string {
  const parameters = parametersOf(tool)
  if (parameters.length === 0) {
    return '无参数'
  }
  return parameters
    .map((parameter) => (parameter.required ? `${parameter.name}*` : parameter.name))
    .join(' · ')
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const payload = await api.get<McpToolsPayload>('/mcp/tools')
    tools.value = payload.tools
  } catch (caught) {
    error.value = errorMessageOf(caught)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="content">
    <div class="page">
      <DomainPageHeader title="工具">
        <template #actions>
          <span v-if="tools.length > 0" class="caption">共 {{ tools.length }} 个</span>
          <button
            type="button"
            class="iconbtn"
            aria-label="重新拉取工具清单"
            :disabled="loading"
            @click="load"
          >
            <RefreshCw :size="15" :stroke-width="1.5" />
          </button>
        </template>
      </DomainPageHeader>

      <div v-if="error !== null" class="callout callout--danger">
        <AlertTriangle :size="15" :stroke-width="1.4" />
        <div>{{ error }}</div>
      </div>

      <div v-else-if="loading && tools.length === 0" class="stack-16" aria-busy="true">
        <div v-for="index in 4" :key="index" class="tool-skeleton">
          <UiSkeleton :width="`${18 + (index % 4) * 6}%`" height="13px" />
          <UiSkeleton width="86%" height="11px" />
        </div>
      </div>

      <div v-else class="stack-24">
        <section v-for="group in groups" :key="group.kind" class="toolgroup">
          <h2 class="toolgroup__label">
            <Terminal :size="13" :stroke-width="1.5" aria-hidden="true" />
            {{ group.label }}
            <span class="tnum">{{ group.tools.length }}</span>
          </h2>

          <UiCard flush>
            <ul class="toollist">
              <li v-for="tool in group.tools" :key="tool.name" class="tool">
                <div class="tool__head">
                  <code class="tool__name mono">{{ tool.name }}</code>
                  <span class="spacer" />
                  <span class="tool__params tnum mono">{{ parameterText(tool) }}</span>
                </div>
                <p class="tool__desc body-sm">{{ tool.description }}</p>
              </li>
            </ul>
          </UiCard>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-skeleton {
  display: grid;
  gap: 10px;
  padding: 14px 16px;
  border-radius: var(--r-control);
  background: var(--bg-2);
}

.toolgroup {
  display: grid;
  gap: 10px;
}

.toolgroup__label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--label-3);
  text-transform: uppercase;
}

.toollist {
  margin: 0;
  padding: 0;
  list-style: none;
}

.tool {
  display: grid;
  gap: 5px;
  padding: 12px 16px;
}

.tool + .tool {
  box-shadow: 0 -0.5px 0 var(--hairline);
}

.tool__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.tool__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--label);
}

.tool__params {
  flex: none;
  font-size: 11px;
  color: var(--label-4);
}

.tool__desc {
  margin: 0;
  color: var(--label-2);
}
</style>
