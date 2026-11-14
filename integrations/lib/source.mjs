import { createHash } from 'node:crypto';
import { hostname, homedir } from 'node:os';

export function captureSource(event) {
  return {
    host: event.host ?? 'unknown',
    machineId: createHash('sha256').update(`${hostname()}\0${homedir()}`).digest('hex').slice(0, 16),
    cwd: event.cwd ?? '',
  };
}
