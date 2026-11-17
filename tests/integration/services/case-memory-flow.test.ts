import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createContainer } from '../../../src/bootstrap/container.js';
import { runIngest } from '../../../src/commands/ingest.js';
import { Uri } from '../../../src/domain/uri.js';
import { startFakeLlmHttp } from '../../helpers/fake-llm-http.js';

const SCOPE = 'comem://user/local';
const SUBJECT = 'user:local';
const PRINCIPALS = [SUBJECT, 'user:*'];
const CASE_URI = `${SCOPE}/memories/cases/mips-sll-datapath.md`;

const CASE_EXTRACTION = {
  operations: [{
    kind: 'upsert',
    pageId: 100,
    type: 'cases',
    identity: { case: 'mips-sll-datapath' },
    operations: [
      { kind: 'replace', field: 'case', value: 'mips-sll-datapath' },
      {
        kind: 'replace',
        field: 'content',
        value: [
          '为单周期 MIPS 添加 sll 时，通过 ALU 左移路径完成并验证。',
          '',
          '## 尝试',
          '',
          '设置 ALU 控制为左移，复用现有写回路径。',
          '',
          '## 结果',
          '',
          'sll 指令的仿真结果通过。',
          '',
          '## 证据',
          '',
          '本次仿真确认左移结果写回目标寄存器。',
        ].join('\n'),
      },
    ],
  }],
};

async function writeCodexSession(directory: string): Promise<void> {
  const sessionId = '01a036e1-6764-77e0-b613-54e99ba2a762';
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `rollout-2026-11-17T10-00-00-${sessionId}.jsonl`),
    [
      JSON.stringify({
        timestamp: '2026-11-17T02:00:00.000Z',
        type: 'session_meta',
        payload: { session_id: sessionId, cwd: '/work/mips' },
      }),
      JSON.stringify({
        timestamp: '2026-11-17T02:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '给单周期 MIPS 数据通路添加 sll。' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-11-17T02:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '复用 ALU 左移路径，仿真通过。' }],
        },
      }),
    ].join('\n'),
    'utf8',
  );
}

describe('cases 记忆链路', () => {
  it('从抽取、合并写盘到检索完整接线', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'comem-case-flow-'));
    const codexDir = await mkdtemp(join(tmpdir(), 'comem-case-codex-'));
    const llm = await startFakeLlmHttp((body) =>
      body.includes('经验归纳器')
        ? JSON.stringify({ experiences: [] })
        : JSON.stringify(CASE_EXTRACTION),
    );
    const configPath = join(dataDir, 'config.yaml');
    await writeCodexSession(codexDir);
    await writeFile(
      configPath,
      [
        `dataDir: ${dataDir}`,
        'providers:',
        '  llm:',
        '    default:',
        '      type: openai-compatible',
        `      baseUrl: ${llm.baseUrl}`,
        '      model: fake',
        '      apiKey: test',
        '      maxTokens: 4096',
        '      timeoutSeconds: 30',
        'summary:',
        '  generator: rule',
        'retrieval:',
        '  engine: fts5',
        'ingest:',
        '  enabled: true',
        '  extractionBatchSize: 20',
        '  paths:',
        '    codex:',
        `      - ${codexDir}`,
      ].join('\n'),
      'utf8',
    );

    let container: Awaited<ReturnType<typeof createContainer>> | undefined;
    try {
      await runIngest({ configPath, dataDir, source: 'codex' });
      container = await createContainer({
        configPath,
        env: {
          ...process.env,
          COMEM_DATA_DIR: dataDir,
          COMEM_LOGGING_LEVEL: 'error',
        },
      });

      const record = await container.services.memory.read(Uri.parse(CASE_URI));
      expect(record?.status).toBe('active');
      expect(record?.memoryType).toBe('cases');
      expect(record?.fields).not.toHaveProperty('task');
      expect(record?.fields).not.toHaveProperty('outcome');
      expect(record?.fields['content']).toContain('复用现有写回路径');

      const hits = await container.services.search.find('sll', {
        scopes: [`${SCOPE}/memories`],
        subject: SUBJECT,
        principals: PRINCIPALS,
      });
      expect(hits.map((hit) => hit.uri)).toContain(CASE_URI);
    } finally {
      await container?.close();
      await llm.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(codexDir, { recursive: true, force: true });
    }
  });
});
