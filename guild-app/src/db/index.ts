import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema"

function createDb() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is not set")
  }

  const client = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  })

  return drizzle(client, { schema })
}

let _db: ReturnType<typeof createDb> | undefined

export const db = new Proxy({} as ReturnType<typeof createDb>, {
  get(_target, prop) {
    if (!_db) _db = createDb()
    return (_db as unknown as Record<string | symbol, unknown>)[prop]
  },
})

export type Database = ReturnType<typeof createDb>

// An open drizzle transaction handle, as passed to db.transaction(async (tx) => ...).
export type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0]

// Anything a query function can run on: the root db or an enclosing transaction.
// Lets multi-write API flows compose query helpers into one atomic unit.
export type DbExecutor = Database | DbTransaction
