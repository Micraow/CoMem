import { GreetingPortImpl } from '../src/services/ports.js';
import { ZeroService } from '../src/services/zero.js';

/** 只存在于 `tests/` 的调用：`onlyTested` / `farewell` 因此是「只被测试引用」。 */
export function run(): string {
  const service = new ZeroService();
  const greeting = new GreetingPortImpl();
  return `${service.onlyTested()} ${greeting.farewell('x')}`;
}
