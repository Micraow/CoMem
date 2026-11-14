import { isRecord } from './guards.js';
import type { SessionMessage } from './session.js';

const ENVIRONMENT_COMMANDS: Readonly<Record<string, string>> = {
  'cat /etc/os-release': 'os',
  'uname -s': 'kernel',
  'uname -m': 'architecture',
  'cat /sys/class/dmi/id/product_name': 'deviceModel',
};

export function environmentObservations(message: SessionMessage): readonly string[] {
  const observations: string[] = [];
  for (const part of message.parts) {
    if (part.kind !== 'tool_use' || !['Bash', 'exec_command', 'functions.exec_command', 'bash'].includes(part.name) || !isRecord(part.input)) continue;
    const command = part.input['cmd'] ?? part.input['command'];
    if (typeof command !== 'string') continue;
    const property = ENVIRONMENT_COMMANDS[command.trim()];
    if (property === undefined) continue;
    const result = message.parts.find((candidate) => candidate.kind === 'tool_result' && candidate.toolUseId === part.toolUseId);
    if (result?.kind !== 'tool_result' || result.isError) continue;
    let output = result.output;
    try {
      const parsed: unknown = JSON.parse(output);
      if (isRecord(parsed)) {
        const text = parsed['stdout'] ?? parsed['output'];
        if (typeof text === 'string') output = text;
      }
    } catch {
      output = result.output;
    }
    output = output.split(/\n(?:Final output|Output):\n/).at(-1)?.trim() ?? '';
    if (property === 'os') {
      const fields = output.split('\n').flatMap((line) => {
        const match = /^(ID|VERSION_ID|PRETTY_NAME)="?([A-Za-z0-9 ._()+/-]{1,100})"?$/.exec(line.trim());
        return match === null ? [] : [`${match[1]}=${match[2]}`];
      });
      if (fields.length > 0) observations.push(`os: ${fields.join('; ')}`);
    } else if (/^[A-Za-z0-9 ._()+/-]{1,100}$/.test(output)) {
      observations.push(`${property}: ${output}`);
    }
  }
  return observations;
}
