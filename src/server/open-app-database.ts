import 'server-only';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { initializeAppDatabase } from './initialize-app-database';
export function openAppDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'app.sqlite'));
  initializeAppDatabase(db);
  return db;
}
