import { rm } from 'node:fs/promises'
import path from 'node:path'
import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import type { DatabaseAdapterObj, Payload } from 'payload'

// Which database the integration tests run on (doc 2.11: CI covers SQLite and MongoDB).
//   WP2P_TEST_DB=sqlite   (default) a throwaway SQLite file inside the instance's temp dir
//   WP2P_TEST_DB=mongodb  a database named after the instance on WP2P_TEST_MONGO_URL,
//                         dropped on close. Use a replica set URL so transactions run too.
export type TestDbKind = 'sqlite' | 'mongodb'

function kind(): TestDbKind {
  const value = (process.env.WP2P_TEST_DB ?? 'sqlite').trim().toLowerCase()
  if (value === 'sqlite' || value === 'mongodb') return value
  throw new Error(`WP2P_TEST_DB must be "sqlite" or "mongodb", got "${value}"`)
}

export const TEST_DB: TestDbKind = kind()

/**
 * A well-formed ID that matches no document, as a state file left over from a wiped database
 * would hold: a number on SQLite, a 24-hex ObjectId on MongoDB (Payload's default ID types).
 */
export const MISSING_ID: string | number = TEST_DB === 'mongodb' ? 'ffffffffffffffffffffff01' : 999_999

/** `mongodb://host:port/?opts` with the database path replaced by `name`. */
export function mongoUrl(base: string, name: string): string {
  const m = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/.exec(base.trim())
  if (!m) throw new Error('WP2P_TEST_MONGO_URL must be a mongodb:// or mongodb+srv:// URL')
  return `${m[1]}/${name}${m[2] ?? ''}`
}

/** A database adapter for one test instance; `dir` is its own fresh temp dir (mkdtemp). */
export function testDatabase(dir: string): DatabaseAdapterObj {
  if (TEST_DB === 'sqlite') {
    return sqliteAdapter({ client: { url: `file:${path.join(dir, 'test.db').replace(/\\/g, '/')}` }, push: true })
  }
  const base = process.env.WP2P_TEST_MONGO_URL
  if (!base) throw new Error('WP2P_TEST_DB=mongodb needs WP2P_TEST_MONGO_URL, e.g. mongodb://127.0.0.1:27017/?replicaSet=rs0')
  // mkdtemp names are unique, so every instance (and so every test file) gets its own database.
  const name = `wp2p_${path.basename(dir).replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 60)
  return mongooseAdapter({ url: mongoUrl(base, name) })
}

/** Shut an instance down: drop its MongoDB database, close the connection, remove `dir`. */
export async function closeTestPayload(payload: Payload, dir: string): Promise<void> {
  const mongo = (payload.db as { connection?: { dropDatabase?: () => Promise<unknown> } }).connection
  if (TEST_DB === 'mongodb') await mongo?.dropDatabase?.()
  await payload.db.destroy?.()
  ;(payload.db as { client?: { close?: () => void } }).client?.close?.()
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    // Windows can hold the SQLite file briefly after close; the OS temp cleaner removes it.
    if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error
  }
}
