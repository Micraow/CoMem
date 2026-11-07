<script setup lang="ts">
/**
 * 页面标题（架构文档 §16.1 的 title 级排版）。
 *
 * 标题 + 一句说明 + 右侧操作槽。说明是给用户的定位信息，不写实现细节；
 * 没有说明时整行不占位，避免出现一条空行。
 */
withDefaults(
  defineProps<{
    title: string
    description?: string
  }>(),
  { description: undefined },
)
</script>

<template>
  <header class="page-head">
    <div class="page-head__main">
      <h1 class="title">{{ title }}</h1>
      <p v-if="description" class="body-sm muted">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="page-head__actions">
      <slot name="actions" />
    </div>
  </header>
</template>
