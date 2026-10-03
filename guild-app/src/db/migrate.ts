import { migrate } from "drizzle-orm/postgres-js/migrator"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error("DATABASE_URL is not set")
    process.exit(1)
  }

  const client = postgres(connectionString, { max: 1 })
  const db = drizzle(client)

  console.log("Running migrations...")
  await migrate(db, { migrationsFolder: "./drizzle" })
  console.log("Migrations complete.")

  await client.end()
  process.exit(0)
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err)
  process.exit(1)
})
