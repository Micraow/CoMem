<script setup lang="ts">
/**
 * 卡片（shadcn-vue 的 Card）。
 *
 * 头 / 体 / 脚三段用命名插槽，标题是可选 prop：只有标题的卡片不用重复写 header。
 * `panel` 换成 22px 圆角，用于详情页的大块内容；`flush` 去掉内边距，用于整块表格。
 */
const props = withDefaults(
  defineProps<{
    title?: string
    panel?: boolean
    flush?: boolean
  }>(),
  {
    title: undefined,
    panel: false,
    flush: false,
  },
)
</script>

<template>
  <section class="card" :class="{ 'card--panel': props.panel }">
    <header v-if="props.title || $slots.head" class="card__head">
      <h2 v-if="props.title" class="card__title">{{ props.title }}</h2>
      <slot name="head" />
      <span class="spacer" />
      <slot name="actions" />
    </header>
    <div class="card__body" :class="{ 'card__body--flush': props.flush }">
      <slot />
    </div>
    <footer v-if="$slots.foot" class="card__foot">
      <slot name="foot" />
    </footer>
  </section>
</template>
