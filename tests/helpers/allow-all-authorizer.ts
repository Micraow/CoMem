/**
 * 测试替身：全部放行的 `Authorizer`。
 *
 * 只存在于 `tests/`：生产代码里没有一个「永远放行」的装配位（bootstrap 永远注入
 * `InheritingAuthorizer`），把替身留在 `src/` 只会让下一次误装配变成提权。需要
 * 「授权不是被测对象」的集成测试从这里取。
 *
 * 用它意味着这条用例**不验证权限**。凡是测权限的用例，注入真实的 `AclService`
 * 或 `InheritingAuthorizer`。
 */

import type { Authorizer } from '../../src/services/authorizer.js';
import type { Uri } from '../../src/domain/uri.js';

export class AllowAllAuthorizer implements Authorizer {
  async check(): Promise<boolean> {
    return true;
  }

  async filterReadable(uris: readonly Uri[]): Promise<ReadonlySet<string>> {
    return new Set(uris.map((uri) => uri.toString()));
  }

  async assert(): Promise<void> {
    // 全部放行，没有可抛的东西。
    return;
  }
}
