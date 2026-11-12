'use strict';

const { uuid } = require('../../utils/random');

/**
 * Colección en memoria genérica usada por todos los repositorios del driver
 * `memory`. Guarda objetos planos clonados para que ningún consumidor pueda
 * mutar el estado interno por referencia, y los rehidrata como entidades.
 */
class MemoryCollection {
  constructor(EntityClass) {
    this.Entity = EntityClass;
    this.rows = new Map();
  }

  toEntity(row) {
    return row ? new this.Entity(structuredClone(row)) : null;
  }

  insert(data) {
    const now = new Date().toISOString();
    const row = { createdAt: now, ...plain(data), id: data.id || uuid() };
    const entity = new this.Entity(row);
    this.rows.set(entity.id, plain(entity));
    return this.toEntity(this.rows.get(entity.id));
  }

  get(id) {
    return this.toEntity(this.rows.get(id));
  }

  patch(id, changes) {
    const current = this.rows.get(id);
    if (!current) return null;
    const merged = new this.Entity({ ...current, ...plain(changes), id, updatedAt: new Date().toISOString() });
    this.rows.set(id, plain(merged));
    return this.toEntity(this.rows.get(id));
  }

  all() {
    return [...this.rows.values()].map((r) => this.toEntity(r));
  }

  where(predicate) {
    return this.all().filter(predicate);
  }

  find(predicate) {
    return this.all().find(predicate) || null;
  }

  get size() {
    return this.rows.size;
  }
}

/** Copia profunda de las propiedades propias (sin getters del prototipo). */
function plain(obj) {
  return structuredClone({ ...obj });
}

module.exports = MemoryCollection;
