/**
 * Global test setup — starts MongoMemoryServer, wires env vars, and provides
 * per-test database helpers.
 *
 * Import this file at the top of every test file (or via bunfig.toml preload).
 * It sets process.env BEFORE any server module is imported so that env.ts
 * Zod validation passes.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, type Db } from 'mongodb';

// ---------------------------------------------------------------------------
// Env must be set before any server module import.
// MONGODB_URI needs a placeholder so env.ts Zod validation passes on import.
// The real URI is set in startMongo() and patched into the env object.
// ---------------------------------------------------------------------------

process.env['NODE_ENV'] = 'test';
process.env['API_KEY'] = 'test-api-key-12345678';
process.env['MONGODB_DB'] = 'chika_test';
process.env['MONGODB_URI'] = 'mongodb://placeholder:27017/chika_test';

// ---------------------------------------------------------------------------
// Singleton in-memory server
// ---------------------------------------------------------------------------

let mongod: MongoMemoryServer | null = null;
let client: MongoClient | null = null;
let db: Db | null = null;

export async function startMongo(): Promise<void> {
  if (mongod) return;

  mongod = await MongoMemoryServer.create({
    instance: { dbName: 'chika_test' },
  });

  const uri = mongod.getUri();
  process.env['MONGODB_URI'] = uri;

  // Patch the already-parsed env object so connectDb() uses the real URI.
  const { env } = await import('../src/env');
  (env as Record<string, unknown>).MONGODB_URI = uri;

  client = new MongoClient(uri);
  await client.connect();
  db = client.db('chika_test');
}

export async function stopMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
  db = null;
}

export function getTestDb(): Db {
  if (!db) throw new Error('MongoDB not started. Call startMongo() first.');
  return db;
}

export function getMongoUri(): string {
  if (!mongod) throw new Error('MongoDB not started. Call startMongo() first.');
  return mongod.getUri();
}

/**
 * Fix the idempotency_key index for testing.
 *
 * The production code creates a sparse unique compound index on
 * `{ channel_id: 1, idempotency_key: 1 }`.  With a compound sparse index
 * MongoDB only skips documents missing ALL indexed fields — since channel_id
 * is always present, documents without idempotency_key are indexed with
 * `idempotency_key: null`, causing duplicate key errors.
 *
 * This replaces it with a partial filter expression that properly skips
 * documents without idempotency_key.
 */
export async function fixIdempotencyIndex(): Promise<void> {
  if (!db) throw new Error('MongoDB not started.');
  const col = db.collection('messages');
  await col.dropIndex('channel_id_1_idempotency_key_1').catch(() => {});
  await col.createIndex(
    { channel_id: 1, idempotency_key: 1 },
    {
      unique: true,
      partialFilterExpression: { idempotency_key: { $exists: true } },
    },
  );
}

/**
 * Drop all documents to provide a clean slate between tests.
 * Preserves collections and indexes.
 */
export async function cleanDatabase(): Promise<void> {
  if (!db) throw new Error('MongoDB not started.');
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db!.collection(c.name).deleteMany({})));
}

/**
 * Drop all collections AND indexes then recreate indexes.
 * Useful when you need a truly clean state (e.g. before all tests in a suite).
 */
export async function resetDatabase(): Promise<void> {
  if (!db) throw new Error('MongoDB not started.');
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db!.collection(c.name).drop().catch(() => {})));
}
