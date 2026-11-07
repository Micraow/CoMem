<script setup lang="ts">
/**
 * 表格（shadcn-vue 的 Table 的语义外壳）。
 *
 * 列定义留在页面里：控制台每张表的列宽与对齐方式都不同，抽成配置只会多一层
 * 转接。这里只统一 `table` 语义、横向滚动容器与表头/表体的样式。
 */
withDefaults(defineProps<{ caption?: string }>(), { caption: undefined })
</script>

<template>
  <div class="table-wrap">
    <table class="table">
      <caption v-if="caption" class="sr-only">{{ caption }}</caption>
      <slot />
    </table>
  </div>
</template>
