import { expect, it } from 'vitest';
import { environmentObservations } from '../../../src/domain/environment-observation.js';
import type { SessionMessage } from '../../../src/domain/session.js';
import { extractionMaterial } from '../../../src/services/commit/steps/extract-material.js';

function observation(command: string, output: string, name = 'Bash', isError = false): SessionMessage {
  return { id: 'tool-one', role: 'tool', createdAt: '2026-11-14T00:00:00Z', turn: 1,
    source: { host: 'dsh', machineId: 'machine-a', cwd: '/repo' }, parts: [
      { kind: 'tool_use', toolUseId: 'call-one', name, input: { command } },
      { kind: 'tool_result', toolUseId: 'call-one', output, isError },
    ] };
}

it('只从限定命令提取有界环境事实，不传完整系统配置或任意工具结果', () => {
  const message = observation('cat /etc/os-release', 'ID=arch\nPRETTY_NAME="Arch Linux"\nUNRELATED=private-value');
  expect(environmentObservations(message)).toEqual(['os: ID=arch; PRETTY_NAME=Arch Linux']);
  const material = extractionMaterial([message]);
  expect(material[0]?.content).toContain('machine-a');
  expect(material[0]?.content).toContain('未证明属于用户主力设备');
  expect(material[0]?.content).not.toContain('private-value');
  expect(environmentObservations(observation('uname -m', JSON.stringify({ stdout: 'x86_64\n' })))).toEqual(['architecture: x86_64']);
  expect(environmentObservations(observation('cat /sys/class/dmi/id/product_name', 'Output:\nThinkBook 14'))).toEqual([]);
});

it('复合命令、错误结果、非 shell 工具、秘密输出与不匹配的调用不会形成观察', () => {
  for (const message of [
    observation('cat /etc/os-release; env', 'ID=arch'), observation('env', 'SECRET=private'),
    observation('uname -m', 'x86_64', 'read'), observation('uname -m', 'x86_64', 'Bash', true),
    observation('uname -m', 'token=private\nx86_64'),
  ]) expect(extractionMaterial([message])).toEqual([]);
});

it('助手例子保留助手角色，系统文本和任意工具文本不作为用户事实', () => {
  const base = observation('env', 'SECRET=private');
  const material = extractionMaterial([
    { ...base, role: 'system', parts: [{ kind: 'text', text: 'system-only' }] },
    { ...base, role: 'assistant', parts: [{ kind: 'text', text: '假设你用 Ubuntu' }] },
    { ...base, role: 'user', parts: [{ kind: 'text', text: '我用 Arch' }] },
    base,
  ]);
  expect(material.map((message) => message.role)).toEqual(['assistant', 'user']);
  expect(JSON.stringify(material)).not.toContain('SECRET');
});
