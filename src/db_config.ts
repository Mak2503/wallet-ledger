import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';

export function databaseConfig(overrides: Partial<PoolConfig> = {}): PoolConfig {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL, ...overrides };
  }
  const passwordFile = process.env.DB_PASSWORD_FILE;
  const password = passwordFile ? readFileSync(passwordFile, 'utf8').trim() : process.env.DB_PASSWORD;
  return {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'wallet',
    user: process.env.DB_USER ?? 'wallet_app',
    password,
    ...overrides,
  };
}
