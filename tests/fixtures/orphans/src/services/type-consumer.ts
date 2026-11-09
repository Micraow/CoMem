import type { TypeOnlyService } from './type-only.js';

/** 类型位置引用不算调用方。 */
export type TypeOnlyMember = TypeOnlyService['typeOnly'];
