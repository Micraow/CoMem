import type { GreetingPort } from './ports.js';

/** 通过端口调用 `greet`；`farewell` 另一端没人调。 */
export function usePort(port: GreetingPort): string {
  return port.greet('a');
}
