import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  analyzeReachability,
  compareBaseline,
  type ReachabilityResult,
} from '../../../scripts/check-reachability.js';

/**
 * 临时目录 fixture：入口、桶文件、仅类型模块、不可达调用链、测试引用各一份。
 *
 * 结果不依赖真实仓库（那里随时在变），只断言口径本身。
 */
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'comem-reachability-'));

/**
 * `describe` 回调在收集阶段执行，早于 `beforeAll`，所以分析结果必须在钩子里算，
 * 模块级只能先声明。
 */
let result: ReachabilityResult;

function write(relativePath: string, content: string): void {
  const fullPath = join(FIXTURE_ROOT, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}

beforeAll(() => {
  write(
    'src/entry.ts',
    `import { pathToFileURL } from 'node:url';

import { viaBarrel } from './barrel.js';
import { usedFromEntry } from './lib.js';
import { MemoryLinkService, MemoryLinkServiceChild } from './memory-link.js';
import { helperObject } from './objects.js';
import { GreetingImpl, useGreeting } from './ports.js';
import type { TypeUsed } from './types.js';

export function main(): string {
  const value: TypeUsed = { name: \`\${usedFromEntry()}:\${viaBarrel()}\` };
  const service = new MemoryLinkService();
  const child = new MemoryLinkServiceChild();
  const label = 'writeLinks';
  return [
    value.name,
    service.calledFromEntry(),
    helperObject.used(),
    useGreeting(new GreetingImpl()),
    child.harness,
    label,
  ].join(':');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
`,
  );
  write(
    'src/lib.ts',
    `export function usedFromEntry(): string {
  return 'used';
}

export function testOnly(): string {
  return 'test';
}

export function sameFileOnly(): string {
  return 'same';
}

export function unused(): string {
  return 'unused';
}

export function unreachableCallee(): string {
  return 'callee';
}

void sameFileOnly;
`,
  );
  write(
    'src/memory-link.ts',
    `/**
 * 成员方法 fixture：覆盖「类可达、方法没人调」与 protected / private / getter。
 */
export class MemoryLinkService {
  /** 只被 tests/ 调用：addLinks 那一格，方法级必须抓得到。 */
  addLinks(): string {
    return 'links';
  }

  /** 生产零调用，方法名只在 entry 的字符串里出现过。 */
  writeLinks(): string {
    return 'write';
  }

  /** entry 直接调用。 */
  calledFromEntry(): string {
    return 'entry';
  }

  /** 只在不可达模块里被调用：调用点存在，但那条链不在入口上。 */
  deadModuleOnly(): string {
    return 'dead';
  }

  /** 只有 this 递归调用：不算外部调用。 */
  internalOnly(): string {
    return this.internalOnly();
  }

  /** 同类内部调用（run → usedInternally）：不算外部调用。 */
  usedInternally(): string {
    return 'internal';
  }

  run(): string {
    return this.usedInternally();
  }

  /** getter 不是方法目标。 */
  get value(): string {
    return 'value';
  }

  private privateHelper(): string {
    return 'private';
  }

  #secret(): string {
    return 'secret';
  }

  /** protected，所属类有子类：不报。 */
  protected inherited(): string {
    return 'inherited';
  }
}

export class MemoryLinkServiceChild extends MemoryLinkService {
  readonly harness = 'child';
}

/** protected 但没有子类：按普通方法判定。 */
export class LonelyService {
  protected lonely(): string {
    return 'lonely';
  }
}
`,
  );
  write(
    'src/objects.ts',
    `export const helperObject = {
  used(): string {
    return 'used';
  },

  unused(): string {
    return 'unused';
  },

  selfLoop(): string {
    return this.selfLoop();
  },
};
`,
  );
  write(
    'src/ports.ts',
    `export interface GreetingPort {
  greet(name: string): string;
  farewell(name: string): string;
}

export class GreetingImpl implements GreetingPort {
  greet(name: string): string {
    return \`hi \${name}\`;
  }

  farewell(name: string): string {
    return \`bye \${name}\`;
  }
}

export function useGreeting(port: GreetingPort): string {
  return port.greet('caller');
}
`,
  );
  write(
    'src/dead-service.ts',
    `import { MemoryLinkService } from './memory-link.js';

export function deadEntry(): string {
  return new MemoryLinkService().deadModuleOnly();
}
`,
  );
  write(
    'src/deep.ts',
    `export function viaBarrel(): string {
  return 'barrel';
}
`,
  );
  write('src/barrel.ts', "export { viaBarrel } from './deep.js';\n");
  write(
    'src/dead.ts',
    `import { unreachableCallee } from './lib.js';

export function deadEntry(): string {
  return unreachableCallee();
}
`,
  );
  write(
    'src/types.ts',
    'export interface TypeUsed {\n  readonly name: string;\n}\n\nexport const TYPE_MARKER = 1;\n',
  );
  write(
    'tests/usage.test.ts',
    `import { testOnly } from '../src/lib.js';
import { MemoryLinkService } from '../src/memory-link.js';
import { GreetingImpl } from '../src/ports.js';

export function run(): string {
  const service = new MemoryLinkService();
  return [testOnly(), service.addLinks(), new GreetingImpl().farewell('x')].join(':');
}
`,
  );
  result = analyzeReachability(FIXTURE_ROOT);
});

afterAll(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

describe('check-reachability 口径', () => {
  const categoryOf = (id: string): string | undefined =>
    result.symbols.find((symbol) => symbol.id === id)?.category;

  it('入口按 `import.meta.url === pathToFileURL(...)` 判断', () => {
    expect(result.entries.map((entry) => entry.file)).toEqual(['src/entry.ts']);
  });

  it('入口 import 的符号可达', () => {
    expect(categoryOf('src/lib.ts#usedFromEntry')).toBe('reachable');
  });

  it('经由桶文件重导出的符号同样可达', () => {
    expect(categoryOf('src/deep.ts#viaBarrel')).toBe('reachable');
    expect(result.modules.find((module) => module.file === 'src/barrel.ts')?.reachable).toBe(
      true,
    );
  });

  it('只在 tests/ 出现的符号算 test-only（进基线，不进 failures）', () => {
    expect(categoryOf('src/lib.ts#testOnly')).toBe('test-only');
    expect(result.issues.map((issue) => issue.id)).not.toContain('src/lib.ts#testOnly');
  });

  it('只被同文件引用的导出算不可达', () => {
    expect(categoryOf('src/lib.ts#sameFileOnly')).toBe('same-file-only');
  });

  it('引用方不可达时，被引用符号算「调用链不在入口上」', () => {
    expect(categoryOf('src/lib.ts#unreachableCallee')).toBe('unreachable-callers');
    expect(categoryOf('src/dead.ts#deadEntry')).toBe('no-reference');
    expect(result.modules.find((module) => module.file === 'src/dead.ts')?.reason).toBe(
      'never-imported',
    );
  });

  it('import type 不让模块或符号变成值可达', () => {
    expect(
      result.modules.find((module) => module.file === 'src/types.ts')?.reason,
    ).toBe('type-only');
  });

  it('入口模块自身的导出不是目标', () => {
    expect(result.symbols.some((symbol) => symbol.id === 'src/entry.ts#main')).toBe(false);
  });

  it('issues 只包含失败的两类：test-only 进基线，不再是硬失败', () => {
    const categories = new Set(result.issues.map((issue) => issue.category));
    expect([...categories].sort()).toEqual(['same-file-only', 'unreachable-callers']);
    expect(result.symbols.some((symbol) => symbol.category === 'test-only')).toBe(true);
  });
});

describe('check-reachability 成员方法口径', () => {
  const methodCategory = (id: string): string | undefined =>
    result.methods.find((method) => method.id === id)?.category;

  it('抓得到 addLinks 那一格：只被 tests/ 调用的成员方法', () => {
    expect(methodCategory('src/memory-link.ts#MemoryLinkService.addLinks')).toBe(
      'method-test-only',
    );
    expect(result.methodIssues.map((method) => method.id)).not.toContain(
      'src/memory-link.ts#MemoryLinkService.addLinks',
    );
  });

  it('生产零调用的成员方法是 method-no-caller', () => {
    expect(methodCategory('src/memory-link.ts#MemoryLinkService.writeLinks')).toBe(
      'method-no-caller',
    );
    expect(result.methodIssues.map((method) => method.id)).toContain(
      'src/memory-link.ts#MemoryLinkService.writeLinks',
    );
  });

  it('方法名只出现在字符串里不算调用点', () => {
    // entry.ts 有 `const label = 'writeLinks'`，但 writeLinks 仍然零调用。
    const method = result.methods.find(
      (candidate) => candidate.id === 'src/memory-link.ts#MemoryLinkService.writeLinks',
    );
    expect(method?.reachableCalls).toBe(0);
    expect(method?.testCalls).toBe(0);
  });

  it('跨文件的生产调用让方法可达', () => {
    expect(methodCategory('src/memory-link.ts#MemoryLinkService.calledFromEntry')).toBe(
      'reachable',
    );
  });

  it('只在不可达模块里有调用点时仍然是 method-no-caller，证据点明原因', () => {
    const method = result.methods.find(
      (candidate) => candidate.id === 'src/memory-link.ts#MemoryLinkService.deadModuleOnly',
    );
    expect(method?.category).toBe('method-no-caller');
    expect(method?.unreachableCalls).toBe(1);
    expect(method?.evidence).toContain('不可达');
  });

  it('this 递归与同类内部调用都不算外部调用', () => {
    expect(methodCategory('src/memory-link.ts#MemoryLinkService.internalOnly')).toBe(
      'method-no-caller',
    );
    expect(methodCategory('src/memory-link.ts#MemoryLinkService.usedInternally')).toBe(
      'method-no-caller',
    );
  });

  it('getter / private / #private 不是目标', () => {
    const ids = new Set(result.methods.map((method) => method.id));
    expect(ids.has('src/memory-link.ts#MemoryLinkService.value')).toBe(false);
    expect(ids.has('src/memory-link.ts#MemoryLinkService.privateHelper')).toBe(false);
    expect(ids.has('src/memory-link.ts#MemoryLinkService.#secret')).toBe(false);
  });

  it('protected 有子类时不报，没有子类时照常判定', () => {
    expect(methodCategory('src/memory-link.ts#MemoryLinkService.inherited')).toBe(
      'protected-inherited',
    );
    expect(methodCategory('src/memory-link.ts#LonelyService.lonely')).toBe(
      'method-no-caller',
    );
  });

  it('对象字面量里的方法同样区分调用 / 零调用 / 自调用', () => {
    expect(methodCategory('src/objects.ts#helperObject.used')).toBe('reachable');
    expect(methodCategory('src/objects.ts#helperObject.unused')).toBe('method-no-caller');
    expect(methodCategory('src/objects.ts#helperObject.selfLoop')).toBe('method-no-caller');
  });

  it('接口方法被调用时实现方算可达，只声明没人调的实现仍然报出来', () => {
    expect(methodCategory('src/ports.ts#GreetingImpl.greet')).toBe('contract');
    expect(methodCategory('src/ports.ts#GreetingImpl.farewell')).toBe('method-test-only');
  });

  it('methodIssues 只包含 method-no-caller', () => {
    const categories = new Set(result.methodIssues.map((method) => method.category));
    expect([...categories]).toEqual(['method-no-caller']);
  });
});

describe('check-reachability 基线 ratchet', () => {
  it('数量持平时既不报超限也不收紧', () => {
    const evaluation = compareBaseline(
      { testOnly: 5, methodTestOnly: 3 },
      { testOnly: 5, methodTestOnly: 3 },
    );
    expect(evaluation.exceeded).toEqual([]);
    expect(evaluation.tightened).toEqual([]);
    expect(evaluation.next).toEqual({ testOnly: 5, methodTestOnly: 3 });
  });

  it('数量上升时报超限，且不产生收紧后的基线', () => {
    const evaluation = compareBaseline(
      { testOnly: 6, methodTestOnly: 4 },
      { testOnly: 5, methodTestOnly: 3 },
    );
    expect(evaluation.exceeded.map((item) => item.key)).toEqual([
      'testOnly',
      'methodTestOnly',
    ]);
    expect(evaluation.next).toEqual({ testOnly: 5, methodTestOnly: 3 });
  });

  it('数量下降时产出行之有效的收紧基线', () => {
    const evaluation = compareBaseline(
      { testOnly: 4, methodTestOnly: 3 },
      { testOnly: 5, methodTestOnly: 3 },
    );
    expect(evaluation.exceeded).toEqual([]);
    expect(evaluation.tightened).toEqual([{ key: 'testOnly', from: 5, to: 4 }]);
    expect(evaluation.next).toEqual({ testOnly: 4, methodTestOnly: 3 });
  });
});
