CREATE TABLE memory_entity (
  uri TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL
);
CREATE INDEX memory_entity_id ON memory_entity(entity_id);
CREATE TABLE memory_alias (
  uri TEXT NOT NULL REFERENCES memory_entity(uri) ON DELETE CASCADE,
  name TEXT NOT NULL,
  PRIMARY KEY(uri, name)
);
CREATE INDEX memory_alias_name ON memory_alias(name);
CREATE TABLE memory_entity_ref (
  uri TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY(uri, entity_id)
);
CREATE INDEX memory_entity_ref_id ON memory_entity_ref(entity_id);
CREATE TABLE memory_structure_migration (id INTEGER PRIMARY KEY CHECK(id = 1), completed_at TEXT NOT NULL);
CREATE TABLE memory_link_migrated (uri TEXT PRIMARY KEY);
