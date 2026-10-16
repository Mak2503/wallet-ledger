# Milestone 2 — Isolation levels lab

This lab uses two psql sessions against a fresh local database. Start the stack, wait until `db` is healthy, then open two terminals:

```sh
docker compose up --build -d
docker compose exec db psql -U wallet_admin -d wallet
```

Migration 008 creates the two system accounts first, so in a fresh database the demo user's ID is `1` and the wallet's ID is `3`. If you use an existing database, substitute the IDs returned here in every command below.

Run this setup once in either session (called Session B below):

```sql
INSERT INTO users(name,email,phone)
VALUES ('Isolation demo','iso@example.test','+15550000001') RETURNING id;
-- id
-- 1
INSERT INTO accounts(owner_user_id,kind,name,balance_paise)
VALUES (1,'wallet','isolation wallet',50000) RETURNING id;
-- id
-- 3
```

Use `UPDATE accounts SET balance_paise=50000 WHERE id=3;` in Session B to reset the starting balance before each case. Psql should print `UPDATE 1`.

## 1. Read Committed

Session A:

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SELECT balance_paise FROM accounts WHERE id=3;
-- balance_paise
-- 50000
```

Session B:

```sql
UPDATE accounts SET balance_paise=40000 WHERE id=3;
-- UPDATE 1
COMMIT;
-- COMMIT
```

Session A:

```sql
SELECT balance_paise FROM accounts WHERE id=3;
-- balance_paise
-- 40000
COMMIT;
-- COMMIT
```

Session A sees the newly committed value because each statement gets a fresh snapshot.

## 2. Repeatable Read

Reset to 50000 in Session B. Session A:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT balance_paise FROM accounts WHERE id=3;
-- 50000
```

Session B:

```sql
UPDATE accounts SET balance_paise=40000 WHERE id=3;
-- UPDATE 1
COMMIT;
-- COMMIT
```

Session A:

```sql
SELECT balance_paise FROM accounts WHERE id=3;
-- 50000
COMMIT;
-- COMMIT
```

Session A keeps the snapshot established by its first query.

## 3. Serializable

Reset to 50000 in Session B. Start both transactions and read before either writes.

Session A:

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT balance_paise FROM accounts WHERE id=3;
-- 50000
```

Session B:

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT balance_paise FROM accounts WHERE id=3;
-- 50000
```

Session A:

```sql
UPDATE accounts SET balance_paise=40000 WHERE id=3;
-- UPDATE 1
COMMIT;
-- COMMIT
```

Session B:

```sql
UPDATE accounts SET balance_paise=30000 WHERE id=3;
-- ERROR: could not serialize access due to concurrent update
-- SQLSTATE: 40001
ROLLBACK;
-- ROLLBACK
```

One transaction must be retried from the beginning after SQLSTATE `40001`.

## 4. Repeatable Read with a join

Reset to 50000 in Session B. Session A:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT a.balance_paise,u.name
FROM accounts a JOIN users u ON u.id=a.owner_user_id
WHERE a.id=3;
-- balance_paise | name
-- 50000         | Isolation demo
```

Session B:

```sql
UPDATE accounts SET balance_paise=40000 WHERE id=3;
-- UPDATE 1
COMMIT;
-- COMMIT
```

Session A:

```sql
SELECT a.balance_paise,u.name
FROM accounts a JOIN users u ON u.id=a.owner_user_id
WHERE a.id=3;
-- balance_paise | name
-- 50000         | Isolation demo
COMMIT;
-- COMMIT
```

The same transaction snapshot covers both tables in the join and later statements.

## Why the transfer uses Read Committed plus row locks

The API sets `READ COMMITTED` explicitly. It locks both account rows with `SELECT ... WHERE id = ANY(...) ORDER BY id FOR UPDATE`, so concurrent transfers touching either wallet wait. It checks the source balance only after acquiring the locks, updates both cached balances, and inserts transfer and ledger rows in the same transaction. The fixed ascending order avoids the common A→B/B→A deadlock cycle. PostgreSQL's row locks provide the needed serialization for this invariant without Serializable's broader predicate tracking and higher serialization-failure/retry rate. Serializable can reduce throughput under contention and requires retrying the whole transaction on SQLSTATE `40001`; it is not needed for this two-row invariant.

The deliberately unsafe stale-read example is `scripts/broken_transfer.ts`; run it only against a disposable database. It demonstrates a lost update: two requests read 500 paise, both approve a 400 paise send, both write 100, while ledger debits total 800. The guarded implementation is `app/services/transfer_service.ts`; see the 20-run acceptance check in `scripts/stampede.ts`.
