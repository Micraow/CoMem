import type { DatabaseSync } from 'node:sqlite';
import type { IndexRecord } from '../../domain/retrieval.js';
import { Uri } from '../../domain/uri.js';
import { isVersionFile } from '../../domain/node.js';
import { globPrefixPattern, placeholders } from './node-repository.js';
import { readablePredicateSql } from './permission-repository.js';
import { text } from './row.js';
import { decodeMemoryLink } from '../../domain/stored-memory-link.js';

export function replaceMemoryStructure(db: DatabaseSync, record: IndexRecord): void {
  if (record.level !== 'L2') return;
  db.prepare('DELETE FROM memory_alias WHERE uri = ?').run(record.uri);
  db.prepare('DELETE FROM memory_entity WHERE uri = ?').run(record.uri);
  db.prepare('DELETE FROM memory_entity_ref WHERE uri = ?').run(record.uri);
  if (isVersionFile(Uri.parse(record.uri))) return;
  db.prepare('DELETE FROM memory_link WHERE from_uri = ?').run(record.uri);
  const insertLink = db.prepare(`INSERT INTO memory_link
    (from_uri, to_uri, link_type, weight, match_text, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(from_uri,to_uri,match_text) DO UPDATE SET link_type=excluded.link_type, weight=excluded.weight, description=excluded.description`);
  for (const value of record.links ?? []) {
    const link = decodeMemoryLink(value);
    insertLink.run(record.uri, link.toUri, link.linkType, link.weight, link.matchText, link.description, record.updatedAt, record.updatedAt);
  }
  for (const source of new Set(record.sources ?? [])) {
    if (Uri.tryParse(source) !== null) insertLink.run(record.uri, source, 'derived_from', 1, '', '', record.updatedAt, record.updatedAt);
  }
  if (record.contextType !== 'memory') return;
  if (record.entityId !== undefined && record.memoryType === 'entities') {
    db.prepare('INSERT INTO memory_entity VALUES (?, ?, ?, ?)')
      .run(record.uri, record.entityId, record.entityName ?? '', record.entityKind ?? '');
    const insert = db.prepare('INSERT INTO memory_alias VALUES (?, ?)');
    for (const name of new Set([record.entityName ?? '', ...record.aliases ?? []].map((value) => value.trim().toLowerCase()).filter(Boolean))) {
      insert.run(record.uri, name);
    }
  }
  const insert = db.prepare('INSERT INTO memory_entity_ref VALUES (?, ?)');
  for (const id of new Set(record.entityRefs ?? [])) insert.run(record.uri, id);
}

export function deleteMemoryStructure(db: DatabaseSync, clause: string, params: readonly string[]): void {
  for (const table of ['memory_alias', 'memory_entity', 'memory_entity_ref']) db.prepare(`DELETE FROM ${table} WHERE ${clause}`).run(...params);
  db.prepare(`DELETE FROM memory_link WHERE ${clause.replaceAll('uri', 'from_uri')}`).run(...params);
}

export interface EntityNeighborhood {
  readonly entities: readonly string[];
  readonly memories: readonly string[];
  readonly names: readonly string[];
}

function mentions(query: string, name: string): boolean {
  return mentionIndex(query, name) >= 0;
}

function mentionIndex(query: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9_-])${escaped}(?![a-z0-9_-])`, 'iu').exec(query)?.index ?? -1;
}

export class MemoryStructureIndex {
  constructor(private readonly db: DatabaseSync) {}

  conflicts(): readonly { id: string; uris: readonly string[] }[] {
    return this.db.prepare('SELECT entity_id FROM memory_entity GROUP BY entity_id HAVING count(*) > 1').all().map((row) => ({
      id: text(row['entity_id']), uris: this.db.prepare('SELECT uri FROM memory_entity WHERE entity_id = ? ORDER BY uri').all(text(row['entity_id'])).map((entry) => text(entry['uri'])),
    }));
  }

  neighborhood(query: string, readable: readonly string[], limit: number): EntityNeighborhood {
    if (readable.length === 0) return { entities: [], memories: [], names: [] };
    const allowed = new Set(readable);
    const matches = this.db.prepare(`SELECT a.name, e.uri, e.entity_id FROM memory_alias a
      JOIN memory_entity e ON e.uri = a.uri
      WHERE instr(?, a.name) > 0 AND e.kind IN ('device','project','person','organization','environment')
      AND (SELECT count(*) FROM memory_entity other WHERE other.entity_id = e.entity_id) = 1
      ORDER BY length(a.name) DESC, e.uri`).all(query.toLowerCase());
    const byName = new Map<string, { uri: string; id: string }[]>();
    for (const row of matches) {
      const uri = text(row['uri']);
      const name = text(row['name']);
      if (!allowed.has(uri) || !mentions(query, name)) continue;
      const entries = byName.get(name) ?? [];
      entries.push({ uri, id: text(row['entity_id']) });
      byName.set(name, entries);
    }
    const selected: [string, { uri: string; id: string }[]][] = [];
    const spans: { start: number; end: number }[] = [];
    for (const entry of [...byName].sort(([left], [right]) => right.length - left.length)) {
      if (entry[1].length !== 1) continue;
      const start = mentionIndex(query, entry[0]);
      const end = start + entry[0].length;
      if (start < 0 || spans.some((span) => start < span.end && end > span.start)) continue;
      selected.push(entry);
      spans.push({ start, end });
      if (selected.length === limit) break;
    }
    const entities = new Set<string>();
    const memories = new Set<string>();
    for (const [, entries] of selected) {
      for (const entity of entries) {
        if (entities.has(entity.uri)) continue;
        entities.add(entity.uri);
        const rows = this.db.prepare('SELECT uri FROM memory_entity_ref WHERE entity_id = ? ORDER BY uri').all(entity.id);
        for (const row of rows) {
          const uri = text(row['uri']);
          if (allowed.has(uri)) memories.add(uri);
        }
      }
    }
    return { entities: [...entities], memories: [...memories], names: selected.map(([name]) => name) };
  }

  candidates(query: string, scope: string, principals: readonly string[], limit: number): readonly string[] {
    if (principals.length === 0) return [];
    const principalList = placeholders(principals.length);
    const readable = `EXISTS (SELECT 1 FROM node_permission p WHERE p.node_uri = e.uri
      AND p.principal IN (${principalList}) AND ${readablePredicateSql(principalList)})`;
    return this.db.prepare(`SELECT DISTINCT e.uri, a.name FROM memory_entity e JOIN memory_alias a ON e.uri = a.uri
      JOIN node n ON n.uri = e.uri AND n.level = 'L2'
      WHERE (e.uri = ? OR e.uri GLOB ?) AND instr(?, a.name) > 0 AND ${readable}
      AND (SELECT count(*) FROM memory_entity other WHERE other.entity_id = e.entity_id) = 1
      AND n.status = 'active' AND (n.valid_until IS NULL OR n.valid_until > ?)
      ORDER BY e.uri`).all(scope, globPrefixPattern(scope), query.toLowerCase(), ...principals, ...principals, new Date().toISOString())
      .filter((row) => mentions(query, text(row['name'])))
      .map((row) => text(row['uri'])).filter((uri, index, uris) => uris.indexOf(uri) === index).slice(0, limit);
  }
}
