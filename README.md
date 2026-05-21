# Time-Off Microservice

## Overview

This project implements a backend microservice for managing employee time-off balances while synchronizing with an external Human Capital Management (HCM) system.

The system is designed to:
- Provide fast local balance reads.
- Prevent PTO overspending during concurrent requests.
- Reconcile balance drift from external HCM updates.
- Maintain an immutable ledger for comprehensive auditability.

The external HCM remains the authoritative source of truth, while this service maintains a locally synchronized cache to provide low-latency experiences for end-user employees.

---

## Tech Stack

- **Framework:** NestJS
- **Language:** TypeScript
- **ORM:** Prisma ORM
- **Database:** SQLite
- **Testing:** Jest & Supertest

---

## Key Features

### Time-Off Request Workflow
Employees can submit PTO requests through `POST /timeoff/request`. The service performs the following chain atomically inside a database transaction:
1. Validates available balance locally.
2. Prevents concurrent double-spending via version tracking.
3. Records local ledger entries for auditing.
4. Synchronizes with the external HCM platform.
5. **Self-Healing Compensation Rollback:** If the external HCM platform rejects the transaction, the service automatically updates the local status to `FAILED_SYNC`, calculates a balancing credit delta, refunds the employee's days, and writes an explicit `HCM_REJECTION_ROLLBACK` audit trace.

### HCM Synchronization & Batch Processing
The service supports single-record inbound HCM reconciliation updates as well as heavy batch-syncing capabilities to keep local systems synchronized with corporate event engines:
- Single updates simulate anniversary grants or manual balance adjustments.
- Batch payloads allow broad arrays of multi-employee reconciliation tasks to process cleanly over a unified transaction loop.

### Optimistic Concurrency Control
To prevent race conditions and double-spending of PTO balances during simultaneous rapid clicks, the system utilizes optimistic locking via a specialized version column (`Balance.version`). Concurrent balance deductions only succeed if the runtime engine matches the expected record version, cleanly neutralizing race conditions at the database layer.

### Ledger Tracking
Every single balance mutation writes a record to `balanceLedger` (encompassing user-initiated requests, HCM webhooks, batch adjustments, and system refunds). This creates a secure, immutable history trail for HR verification and synchronization tracking.

---

## API Endpoints

### Get Balance
```http
GET /balances/:employeeId/:locationId

```

**Example:**

```http
GET /balances/emp-happy/SF

```

---

### Submit Time-Off Request

```http
POST /timeoff/request

```

**Example Payload:**

```json
{
  "employeeId": "emp-happy",
  "locationId": "SF",
  "daysRequested": 2,
  "idempotencyKey": "happy-1"
}

```

---

### Inbound HCM Balance Reconciliation

```http
POST /webhooks/hcm/balance-update

```

**Example Payload:**

```json
{
  "employeeId": "emp-sync",
  "locationId": "SF",
  "balance": 15
}

```

---

### Inbound HCM Batch Synchronization

```http
POST /webhooks/hcm/batch-sync

```

**Example Payload:**

```json
{
  "balances": [
    { "employeeId": "emp-batch-1", "locationId": "SF", "balance": 12 },
    { "employeeId": "emp-batch-2", "locationId": "NY", "balance": 20 }
  ]
}

```

---

## Running the Project

### Install Dependencies

```bash
npm install

```

### Start Development Server

```bash
npm run start:dev

```

The server will run locally as a pure headless API background engine at: `http://localhost:3000`

Note: This service does not have a frontend graphical user interface (UI).

---

## Database Setup

### Run Prisma Migrations

```bash
npx prisma migrate dev --name init

```

---

## Running Tests

The end-to-end integration suite runs against an isolated SQLite testing boundary to validate transactional isolation, webhook reconciliation, and error handling.

### 1. End-to-End Integration Tests

```bash
npm run test:e2e

```

The E2E suite explicitly validates:

* **Happy Path Processing:** Sequential validation, balance deduction, and local ledger logging.
* **Defensive Balances:** Rejection of requests exceeding available capacity.
* **State Reconciliation:** Inbound single or batch synchronization adjustments from external HCM hooks.
* **Race Condition Mitigation:** Multi-request conflict resolution via parallel version matching.
* **Idempotency Protections:** Duplicate idempotency key retry processing.
* **Network/Business Compensation:** Local self-healing rollbacks and balance refunds during structural third-party API rejections.

### 2. Run with Coverage Metrics

```bash
npx jest --config ./test/jest-e2e.json --coverage

```

### Verified Test Suite Output

```text
PASS  test/app.e2e-spec.ts
  TimeOff E2E Suite
    ✓ happy path: request time off successfully (28 ms)
    ✓ rejects insufficient balance early (7 ms)
    ✓ updates balance via HCM webhook sync (5 ms)
    ✓ prevents concurrent overspending on parallel clicks (12 ms)
    ✓ does not double deduct on duplicate idempotency key retries (9 ms)
    ✓ processes HCM batch sync for multiple balances (8 ms)
    ✓ rejects request for unknown employee/location balance configurations (3 ms)
    ✓ rejects invalid inputs using Global ValidationPipes (2 ms)
    ✓ rolls back local balance and writes a compensating ledger when HCM rejects request (9 ms)

Test Suites: 1 passed, 1 total
Tests:       9 passed, 9 total
Snapshots:   0 total
Time:        2.111 s
```

### Proof Of Coverage 
```text
npx jest --config ./test/jest-e2e.json --coverage
 PASS  test/app.e2e-spec.ts
  TimeOff E2E Suite
    ✓ happy path: request time off successfully (36 ms)
    ✓ rejects insufficient balance early (7 ms)
    ✓ updates balance via HCM webhook sync (6 ms)
    ✓ prevents concurrent overspending on parallel clicks (17 ms)
    ✓ does not double deduct on duplicate idempotency key retries (10 ms)
    ✓ processes HCM batch sync for multiple balances (35 ms)
    ✓ rejects request for unknown employee/location balance configurations (5 ms)
    ✓ rejects invalid inputs using Global ValidationPipes (2 ms)
    ✓ rolls back local balance and writes a compensating ledger when HCM rejects request (9 ms)

-------------------------|---------|----------|---------|---------|-------------------
File                     | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
-------------------------|---------|----------|---------|---------|-------------------
All files                |    96.9 |    88.88 |   89.47 |   96.38 |                   
 src                     |   84.61 |      100 |   33.33 |   77.77 |                   
  app.controller.ts      |    87.5 |      100 |      50 |   83.33 | 10                
  app.service.ts         |      80 |      100 |       0 |   66.66 | 6                 
 src/balance             |     100 |      100 |     100 |     100 |                   
  balance.controller.ts  |     100 |      100 |     100 |     100 |                   
  balance.service.ts     |     100 |      100 |     100 |     100 |                   
 src/prisma              |     100 |      100 |     100 |     100 |                   
  prisma.service.ts      |     100 |      100 |     100 |     100 |                   
 src/timeoff             |   98.24 |    88.88 |     100 |   98.11 |                   
  timeoff.controller.ts  |     100 |      100 |     100 |     100 |                   
  timeoff.service.ts     |   97.72 |    88.88 |     100 |   97.61 | 68                
 src/timeoff/dto         |     100 |      100 |     100 |     100 |                   
  request-timeoff.dto.ts |     100 |      100 |     100 |     100 |                   
-------------------------|---------|----------|---------|---------|-------------------
Test Suites: 1 passed, 1 total
Tests:       9 passed, 9 total
Snapshots:   0 total
Time:        2.066 s
Ran all test suites.

```

---

## Architecture Summary

```text
─── PHASE 1: INBOUND BALANCE RECONCILIATION (Happens beforehand/regularly) ───
 
    ┌──────────────┐
    │ External HCM │  ───► [Webhooks: Single / Batch Sync] ───┐
    └──────────────┘                                         │
                                                             ▼
                                                 ┌───────────────────────┐
                                                 │       NestJS UI       │
                                                 │   Time-Off Engine     │
                                                 └───────────────────────┘
                                                             │
                                                             ▼ (Writes Initial Cache)
                                                 ┌───────────────────────┐
                                                 │  SQLite Local DB      │
                                                 └───────────────────────┘

 ─── PHASE 2: OUTBOUND TIME-OFF REQUESTS (Happens when user interacts) ─────────

    ┌──────────────┐
    │ Employee UI  │  ───► [POST /timeoff/request] ──────────┐
    └──────────────┘                                         │
                                                             ▼
                                                 ┌───────────────────────┐
                                                 │ NestJS Time-Off Engine│
                                                 └───────────┬───────────┘
                                                             │
                                           ┌─────────────────┴─────────────────┐
                                           ▼ (Check & Mutate)                  ▼ (Final Sync)
                                   ┌──────────────┐                    ┌──────────────┐
                                   │  SQLite DB   │                    │ External HCM │
                                   │ (Local Cache)│                    │ (Auth Truth) │
                                   └──────────────┘                    └──────────────┘

```

---

## Assumptions

* The external HCM system is the global authoritative source of truth.
* Authentication and role-based authorization are out of scope for this microservice iteration.
* Balances are strictly scoped per unique employee per location combination.
* SQLite is acceptable for structural simplicity and local demonstration.

---

## Future Improvements

Potential production enhancements:

* **Asynchronous Message Queues:** Decouple external API latency by shifting the sync sequence over a background worker framework.
* **Distributed Locking:** Implement Redis distributed locks (`Redlock`) to secure scale-out architectures across multi-node server clusters.
* **Enterprise Storage:** Transition from localized SQLite instances to distributed systems like PostgreSQL.
* **Event-Driven Audits:** Transition transactional updates onto event streams (e.g., Apache Kafka) to allow asynchronous telemetry processing.
