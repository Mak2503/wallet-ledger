#!/bin/sh
set -eu

node dist/scripts/seed_demo.js
node dist/scripts/reconciliation_acceptance.js
node dist/scripts/stampede.js
node dist/scripts/idempotency_acceptance.js
node dist/scripts/risk_rules_acceptance.js
node dist/scripts/statement_qa_acceptance.js

echo 'PASS: complete wallet-ledger acceptance suite'
