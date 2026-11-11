/**
 * 跨轮召回账本（架构文档 §15.10、`lib/recall.mjs`）。
 *
 * 账本是**文件状态**，不是纯函数——hook 是短命进程，跨轮只能靠文件。用例都真的
 * 读写一个临时目录，不 mock `fs`：原子写（临时文件 + rename）与「文件不存在」两种
 * 路径只有真落盘才测得到。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  RECALL_LEDGER_MAX_ENTRIES,
  readDeliveredUris,
  recallLedgerPath,
  recordDeliveredUris,
} from '../lib/recall.mjs';

const dirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'comem-recall-'));
  dirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function uri(index) {
  return `comem://user/alice/memories/${index}.md`;
}

test('没有账本时返回空数组（第一次召回）', async () => {
  const dir = await tempDir();
  assert.deepEqual(await readDeliveredUris('cc-1', { dir }), []);
});

test('写入后下一轮读得到（跨进程语义：状态只在文件里）', async () => {
  const dir = await tempDir();
  await recordDeliveredUris('cc-1', [uri(1), uri(2)], { dir });
  assert.deepEqual(await readDeliveredUris('cc-1', { dir }), [uri(1), uri(2)]);
  // 文件形状是给排障用的，钉住键名。
  assert.deepEqual(JSON.parse(await readFile(recallLedgerPath(dir), 'utf8')), {
    sessionId: 'cc-1',
    uris: [uri(1), uri(2)],
  });
});

test('一条都没注入时不写文件（「没给过」不等于「给过了」）', async () => {
  const dir = await tempDir();
  assert.deepEqual(await recordDeliveredUris('cc-1', [], { dir }), []);
  await assert.rejects(() => readFile(recallLedgerPath(dir), 'utf8'), /ENOENT/);
});

test('会话切换 → 账本重置（旧会话的 URI 不会压制新会话）', async () => {
  const dir = await tempDir();
  await recordDeliveredUris('cc-1', [uri(1), uri(2)], { dir });
  // 新会话第一次召回：读不到东西。
  assert.deepEqual(await readDeliveredUris('cc-dsh-9', { dir }), []);
  // 新会话记账时整份替换，旧会话的条目消失。
  await recordDeliveredUris('cc-dsh-9', [uri(3)], { dir });
  assert.deepEqual(await readDeliveredUris('cc-dsh-9', { dir }), [uri(3)]);
  assert.deepEqual(await readDeliveredUris('cc-1', { dir }), []);
});

test('重复 URI 先删再追加（FIFO 淘汰的是最早投喂的）', async () => {
  const dir = await tempDir();
  await recordDeliveredUris('cc-1', [uri(1), uri(2)], { dir });
  await recordDeliveredUris('cc-1', [uri(2), uri(3)], { dir });
  assert.deepEqual(await readDeliveredUris('cc-1', { dir }), [uri(1), uri(2), uri(3)]);
});

test(`上限 ${RECALL_LEDGER_MAX_ENTRIES} 条，超出按 FIFO 淘汰`, async () => {
  const dir = await tempDir();
  const overflow = RECALL_LEDGER_MAX_ENTRIES + 5;
  await recordDeliveredUris(
    'cc-1',
    Array.from({ length: overflow }, (_, index) => uri(index)),
    { dir },
  );
  const uris = await readDeliveredUris('cc-1', { dir });
  assert.equal(uris.length, RECALL_LEDGER_MAX_ENTRIES);
  // 最早投喂的 5 条被淘汰，最新的一条还在。
  assert.equal(uris[0], uri(5));
  assert.equal(uris.at(-1), uri(overflow - 1));
});

test('账本被写坏（半截 JSON）时当作没有历史，而不是抛错', async () => {
  const dir = await tempDir();
  await writeFile(recallLedgerPath(dir), '{"sessionId":"cc-1","uris":[', 'utf8');
  assert.deepEqual(await readDeliveredUris('cc-1', { dir }), []);
  // 写回时整份替换，不会试图修复半截内容。
  await recordDeliveredUris('cc-1', [uri(1)], { dir });
  assert.deepEqual(await readDeliveredUris('cc-1', { dir }), [uri(1)]);
});

test('自定义 tmpDir 不存在时自己建目录（否则去重第一次就静默失效）', async () => {
  const parent = await tempDir();
  const dir = join(parent, 'nested', 'hook-tmp');
  await recordDeliveredUris('cc-1', [uri(1)], { dir });
  assert.deepEqual(await readDeliveredUris('cc-1', { dir }), [uri(1)]);
});
