/**
 * 检查器 fixture：零引用 / 只被测试引用 / 被 api 调用 / 只有同类内部引用。
 *
 * 这个目录不参与仓库运行，只给 `tests/unit/scripts/check-orphans.test.ts` 用。
 */
export class ZeroService {
  /** 只有 `tests/usage.ts` 调用。 */
  onlyTested(): string {
    return this.#tag();
  }

  /** `src/` 里没有任何调用。 */
  noOneUses(): string {
    return this.privateHelper();
  }

  /** `src/api/uses.ts` 调用：这是生产链路，不算孤儿。 */
  fromApi(): string {
    return this.internalOnly();
  }

  /** 只有同类内部调用（`fromApi`），外部没人调。 */
  internalOnly(): string {
    return 'internal';
  }

  private privateHelper(): string {
    return 'private';
  }

  #tag(): string {
    return 'hash';
  }
}
