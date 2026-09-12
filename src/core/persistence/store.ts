import { isAndroid } from '@nativescript/core';
import { MemoryStore } from './memory-store';
import { SqliteStore } from './sqlite-store';
import type { PersistenceApi } from './types';
import type { TelemetryRepository } from '../telemetry/types';

export type PersistenceStore = PersistenceApi & { readonly telemetry: TelemetryRepository };

let instance: PersistenceStore | null = null;

export function persistence(): PersistenceStore {
  if (!instance) {
    instance = isAndroid ? new SqliteStore() : new MemoryStore();
  }
  return instance;
}

export function resetPersistenceForTests(next?: PersistenceStore): PersistenceStore {
  instance = next ?? new MemoryStore();
  return instance;
}
