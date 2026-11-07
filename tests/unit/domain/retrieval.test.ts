import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import {
  validateGlobQuery,
  validateGrepQuery,
  validateSearchQuery,
  type GlobQuery,
  type GrepQuery,
  type SearchQuery,
} from '../../../src/domain/retrieval.js';

function expectInvalidArgument(run: () => void): ComemError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ComemError);
  const error = caught as ComemError;
  expect(error.code).toBe('INVALID_ARGUMENT');
  return error;
}

const SEARCH: SearchQuery = {
  text: 'TypeScript 严格模式',
  scopes: ['comem://user/alice'],
  principals: ['user:alice', 'group:eng'],
  contextTypes: ['memory'],
  levels: ['L0', 'L1'],
  limit: 10,
  scoreThreshold: 0.5,
};

const GREP: GrepQuery = {
  pattern: 'strict',
  scopes: ['comem://user/alice'],
  principals: ['user:alice'],
  limit: 10,
  contextLines: 2,
};

const GLOB: GlobQuery = {
  pattern: '**/*.md',
  scopes: ['comem://user/alice'],
  principals: ['user:alice'],
  limit: 100,
};

describe('validateSearchQuery', () => {
  it('合法查询通过', () => {
    expect(() => {
      validateSearchQuery(SEARCH);
    }).not.toThrow();
  });

  it('limit 必须是正整数', () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expectInvalidArgument(() => {
        validateSearchQuery({ ...SEARCH, limit });
      });
    }
  });

  it('scopes 不能为空，也不能有空字符串', () => {
    expectInvalidArgument(() => {
      validateSearchQuery({ ...SEARCH, scopes: [] });
    });
    expectInvalidArgument(() => {
      validateSearchQuery({ ...SEARCH, scopes: ['comem://user/alice', ''] });
    });
  });

  it('principals 不能为空，也不能有空字符串', () => {
    expectInvalidArgument(() => {
      validateSearchQuery({ ...SEARCH, principals: [] });
    });
    expectInvalidArgument(() => {
      validateSearchQuery({ ...SEARCH, principals: [''] });
    });
  });

  it('text 不能为空', () => {
    expectInvalidArgument(() => {
      validateSearchQuery({ ...SEARCH, text: '' });
    });
  });
});

describe('validateGrepQuery', () => {
  it('合法查询通过', () => {
    expect(() => {
      validateGrepQuery(GREP);
    }).not.toThrow();
  });

  it('pattern 不能为空', () => {
    expectInvalidArgument(() => {
      validateGrepQuery({ ...GREP, pattern: '' });
    });
  });

  it('pattern 必须能编译成正则', () => {
    expectInvalidArgument(() => {
      validateGrepQuery({ ...GREP, pattern: '(' });
    });
  });

  it('contextLines 必须是非负整数', () => {
    for (const contextLines of [-1, 1.5, Number.NaN]) {
      expectInvalidArgument(() => {
        validateGrepQuery({ ...GREP, contextLines });
      });
    }
  });

  it('共享的 scope / principal / limit 校验同样生效', () => {
    expectInvalidArgument(() => {
      validateGrepQuery({ ...GREP, limit: 0 });
    });
    expectInvalidArgument(() => {
      validateGrepQuery({ ...GREP, scopes: [] });
    });
    expectInvalidArgument(() => {
      validateGrepQuery({ ...GREP, principals: [] });
    });
  });
});

describe('validateGlobQuery', () => {
  it('合法查询通过', () => {
    expect(() => {
      validateGlobQuery(GLOB);
    }).not.toThrow();
  });

  it('pattern 不能为空', () => {
    expectInvalidArgument(() => {
      validateGlobQuery({ ...GLOB, pattern: '' });
    });
  });

  it('limit 必须为正整数', () => {
    expectInvalidArgument(() => {
      validateGlobQuery({ ...GLOB, limit: 0 });
    });
  });
});
