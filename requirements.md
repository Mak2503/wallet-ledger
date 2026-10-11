## Requirements
These are the agreed requirements for your wallet. Treat them like requirements clarified with an interviewer: design for exactly these, and write down any assumption you make in your README.

1. The platform has many users. For each user we store name, email, phone and KYC status.
2. A user can have many wallets, for example a main wallet and a savings wallet. Each wallet has one currency (INR only).
3. The platform also has system accounts that belong to no user: a cash-in account for top-ups, a cash-out account for withdrawals, and a fee revenue account.
4. Money moves only through a transfer. A transfer has a type (top-up, peer transfer, withdrawal, fee, reversal), a status, an amount and a created time.
5. Every transfer writes two or more ledger entries. Each entry is a debit or a credit on exactly one account. The debits and credits of one transfer must sum to the same amount.
6. A ledger entry is never updated or deleted. A mistake is fixed with a new reversal transfer that points to the original.
7. A user wallet’s balance can never go below zero. System accounts may go negative.
8. Every write request carries an idempotency key chosen by the client. The same key with the same body returns the first response. The same key with a different body is rejected.
9. A user can fetch their balance and a paginated statement of entries, newest first.
10. Every night, a job checks that the books balance and that each stored balance matches its entries. It saves a report of every mismatch.
11. Every transfer is checked against fraud rules. Flagged transfers are held for review or allowed with a flag, depending on the rule.
12. A user can ask a plain-English question about their own statement, such as “How much did I send to Rahul last month?”, and get an answer backed by real ledger rows.
13. Every change to a transfer’s status is kept in an audit log with who changed it and when.