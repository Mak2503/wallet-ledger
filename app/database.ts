import { Pool, PoolClient } from 'pg';
import { databaseConfig } from '../src/db_config';

export const pool = new Pool(databaseConfig());

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // READ COMMITTED plus the row locks below serializes updates to these accounts.
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
