import { ZeroService } from '../services/zero.js';

/** `api/` 是生产链路：调用 `ZeroService.fromApi`。 */
export function callFromApi(): string {
  return new ZeroService().fromApi();
}
