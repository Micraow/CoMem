/**
 * 事件去重（架构文档 §15.4 第 1 层：500ms 窗口）。
 *
 * 两条路径都要测：内存实现（单进程）与文件实现（跨进程，hook 真正走的路径）。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { EventDeduper, FileEventDeduper } from '../lib/dedup.mjs';

test('同一个 eventId 在窗口内只放行一次', () => {
  let now = 1_000;
  const deduper = new EventDeduper({ now: () => now });

  assert.equal(deduper.accept('evt_1'), true);
  assert.equal(deduper.accept('evt_1'), false);
  // 窗口内（499ms）仍然算重复。
  now += 499;
  assert.equal(deduper.accept('evt_1'), false);
});

test('窗口外放行', () => {
  let now = 1_000;
  const deduper = new EventDeduper({ now: () => now });

  assert.equal(deduper.accept('evt_1'), true);
  now += 500;
  assert.equal(deduper.accept('evt_1'), true);
});

test('不同 eventId 互不影响', () => {
  const deduper = new EventDeduper();
  assert.equal(deduper.accept('evt_1'), true);
  assert.equal(deduper.accept('evt_2'), true);
  assert.equal(deduper.accept('evt_1'), false);
});

test('没有 eventId 时永远放行（宿主不提供 ID 的事件不能去重）', () => {
  const deduper = new EventDeduper();
  assert.equal(deduper.accept(null), true);
  assert.equal(deduper.accept(undefined), true);
  assert.equal(deduper.accept(''), true);
});

test('文件实现跨进程生效：第二个实例看到第一个写的窗口', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comem-dedup-'));
  try {
    const file = join(dir, 'comem-events.json');

    // 模拟两个 hook 进程：各自 new 一个去重器。
    const first = new FileEventDeduper(file);
    assert.equal(await first.accept('tool:1'), true);

    const second = new FileEventDeduper(file);
    assert.equal(await second.accept('tool:1'), false);

    // 不同事件仍然放行。
    assert.equal(await second.accept('tool:2'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件实现：窗口外的旧记录不挡新事件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comem-dedup-'));
  try {
    const file = join(dir, 'comem-events.json');
    // 手工写一条 600ms 前的记录（超过 500ms 窗口）。
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify([{ eventId: 'tool:1', seenAt: Date.now() - 600 }]), 'utf8');

    const deduper = new FileEventDeduper(file);
    assert.equal(await deduper.accept('tool:1'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件实现：损坏的 JSON 不抛错（最坏是重复处理一次）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comem-dedup-'));
  try {
    const file = join(dir, 'comem-events.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{broken', 'utf8');

    const deduper = new FileEventDeduper(file);
    assert.equal(await deduper.accept('tool:1'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
