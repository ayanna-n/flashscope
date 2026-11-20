import { Pool } from "pg";

const globalForDatabase = globalThis as unknown as {
  databasePool?: Pool;
};

export const database =
  globalForDatabase.databasePool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDatabase.databasePool = database;
}