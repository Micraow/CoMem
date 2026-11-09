import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyzeOrphans } from '../../../scripts/check-orphans.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../fixtures/orphans/', import.meta.url));

function orphanCategories(): Map<string, string> {
  const { orphans } = analyzeOrphans(FIXTURE_ROOT);
  return new Map(orphans.map((orphan) => [orphan.id, orphan.category]));
}

describe('check-orphans fixture', () => {
  const categories = orphanCategories();

  it('零引用的 public 方法会被报出来', () => {
    expect(categories.get('ZeroService.noOneUses')).toBe('no-reference');
  });

  it('只被 tests/ 调用的方法会被报出来', () => {
    expect(categories.get('ZeroService.onlyTested')).toBe('test-only');
  });

  it('被 api/ 调用的方法不算孤儿', () => {
    expect(categories.has('ZeroService.fromApi')).toBe(false);
  });

  it('同类内部调用不算调用方', () => {
    expect(categories.get('ZeroService.internalOnly')).toBe('internal-only');
  });

  it('private 与 #private 方法不在目标集合里', () => {
    const { targets } = analyzeOrphans(FIXTURE_ROOT);
    const ids = new Set(targets.map((target) => target.id));
    expect(ids.has('ZeroService.privateHelper')).toBe(false);
    expect(ids.has('ZeroService.#tag')).toBe(false);
  });

  it('端口实现按接口另一端的调用判定', () => {
    expect(categories.has('GreetingPortImpl.greet')).toBe(false);
    expect(categories.get('GreetingPortImpl.farewell')).toBe('test-only');
  });

  it('类型位置的引用不算调用方', () => {
    expect(categories.get('TypeOnlyService.typeOnly')).toBe('no-reference');
  });
});
