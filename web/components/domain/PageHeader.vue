<script setup lang="ts">
/**
 * 页面标题（架构文档 §16.1 的 title 级排版）。
 *
 * 标题 + 右侧操作槽。不写「这个页面是做什么的」这类说明：定位信息属于文档，
 * 页面上只留标题。
 */
defineProps<{ title: string }>()
</script>

<template>
  <header class="page-head">
    <div class="page-head__main">
      <h1 class="title">{{ title }}</h1>
    </div>
    <div v-if="$slots.actions" class="page-head__actions">
      <slot name="actions" />
    </div>
  </header>
</template>
