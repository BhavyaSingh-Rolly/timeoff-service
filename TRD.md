# Technical Requirements Document (TRD)

## 1. Problem Statement

ReadyOn requires a backend microservice that manages employee time-off balances while synchronizing with an external Human Capital Management (HCM) platform such as Workday or SAP.

The HCM system remains the authoritative source of truth for employee balances, but ReadyOn must still provide:

* fast balance reads
* low-latency request validation
* protection against PTO overspending
* resilience against external synchronization drift

The system must support:

* employee time-off requests
* manager validation workflows
* inbound single-record and multi-employee batch HCM reconciliation updates
* concurrent request protection

Balances are scoped per employee per location.

---

## 2. Goals

### Functional Goals

* Allow employees to request PTO.
* Maintain locally queryable balances.
* Synchronize balances with reactive single-record and bulk batch HCM updates.
* Prevent overspending under rapid concurrent requests.
* Support transactional reconciliation after external HCM modifications.

### Non-Functional Goals

* Low-latency balance reads (avoiding real-time external network hops).
* Defensive consistency handling.
* Transactional, all-or-nothing balance updates.
* Simple operational footprint.
* Maintainable and testable architecture.

---

## 3. Architecture Overview

The system follows a lightweight, event-driven hybrid synchronization model. The microservice operates as an authoritative read/write local cache to shield clients from third-party network latency, while inbound webhook loops ingest master updates from corporate engines.

```text
       ┌────────────────────────┐
       │     Employee UI /      │
       │  HCM Webhook Sources   │
       └───────────┬────────────┘
                   │ (HTTP Requests)
                   ▼
       ┌────────────────────────┐
       │ NestJS Time-Off Engine │
       └───────────┬────────────┘
                   │
         ┌─────────┴─────────┐
         ▼ (ORM Queries)     ▼ (REST API Calls)
   ┌───────────┐       ┌──────────────┐
   │ SQLite DB │       │ External HCM │
   │ (Ledger)  │       │ (Auth Truth) │
   └───────────┘       └──────────────┘

```

---

## 4. High-Level Design Decisions

### Chosen Strategy: Local Cached Balance + Reconciliation

The service maintains local balances to:

* Provide fast reads (under 10 milliseconds).
* Reduce HCM runtime dependencies for every request.
* Improve user experience by keeping validation entirely local.

The HCM periodically reconciles balances through:

* Real-time single-record webhook updates (triggered instantly by HR admin actions).
* High-volume batch synchronization arrays (triggered by automated calendar milestones).

### Why Not Query HCM Directly Every Time?

Direct HCM lookups were rejected because:

* **High Latency:** Every user action would wait on a multi-second remote internet hop.
* **Cascading Downtime:** If the HCM platform undergoes maintenance, ReadyOn would completely freeze.
* **Rate Limiting:** Heavy parallel employee traffic would trigger rate blocks from corporate APIs.

### Why Not Fully Trust Local State?

A purely local system was rejected because:

* Corporate HR may independently modify balances on the core platform.
* Anniversary grants, global balance resets, and offboarding occur upstream.
* External manual corrections could silently invalidate local system assumptions.

> **Architecture Core:** The HCM remains the absolute master truth, but ReadyOn maintains an isolated, synchronized local relational cache.

---

## 5. Data Model

### Balance

Represents the latest locally known balance snapshot.

* `employeeId` (String)
* `locationId` (String)
* `balance` (Int)
* `version` (Int) — *Supports optimistic concurrency control.*
* `lastSyncedAt` (DateTime)

### TimeOffRequest

Represents employee PTO requests.

* `employeeId` (String)
* `locationId` (String)
* `daysRequested` (Int)
* `status` (String)
* `idempotencyKey` (String)
* `createdAt` (DateTime)

### BalanceLedger

An append-only, immutable transaction ledger tracking mutations for comprehensive auditability. State destruction (`DELETE` or un-tracked `UPDATE` actions) is strictly prohibited.

* `employeeId` (String)
* `locationId` (String)
* `delta` (Int)
* `eventType` (String) — *e.g., `PTO_DEDUCTION`, `HCM_SINGLE_SYNC`, `HCM_BATCH_SYNC`, `HCM_REJECTION_ROLLBACK*`
* `requestId` (String, Optional)
* `createdAt` (DateTime)

---

## 6. API Endpoints

### GET /balances/:employeeId/:locationId

Returns the current locally cached balance snapshot directly from SQLite.

### POST /timeoff/request

Creates a PTO request using local validation loops.

1. Fetch current cached balance and store its transaction `version`.
2. Validate available PTO days against requested days.
3. Atomically deduct balance using a version-matched database constraint.
4. Create a `TimeOffRequest` record.
5. Append an entry to the `BalanceLedger`.

### POST /webhooks/hcm/balance-update

Processes real-time inbound individual updates from HR actions.

1. Upsert the latest authoritative HCM balance.
2. Increment the balance `version` tracking state.
3. Create a single reconciliation log entry in `BalanceLedger`.

### POST /webhooks/hcm/batch-sync

Processes high-volume multi-employee array arrays (e.g., yearly resets).

1. Open a unified database transaction block (`prisma.$transaction`).
2. Run an internal loop over the multi-employee array.
3. Execute localized balance cache updates and write paired `BalanceLedger` rows inside the sandbox context (`tx`).
4. Commit the changes only if **all records evaluate successfully**. Any corrupt payload entry triggers an immediate database `ROLLBACK`, neutralizing partial writes.

---

## 7. Concurrency Strategy

The primary consistency risk is concurrent PTO requests overspending a single user balance. For instance, an employee with a balance of 7 days could rapidly double-click a form to fire simultaneous requests trying to deduct 5 days each.

The service blocks this condition via application-level **Optimistic Locking**, completely avoiding heavy database row locks.

```text
  [Request 1 (Wants 5 Days)] ──► Reads Version 1 ──► Updates WHERE Version = 1 ──► SUCCESS (Version becomes 2)
  [Request 2 (Wants 5 Days)] ──► Reads Version 1 ──► Updates WHERE Version = 1 ──► FAILS (Version is already 2)

```

The database executes updates using a version match condition:

```sql
UPDATE "Balance"
SET "balance" = "balance" - 5,
    "version" = "version" + 1
WHERE "employeeId" = 'emp-123'
  AND "locationId" = 'SF'
  AND "version" = 1;

```

If Request 1 updates the database first, the version field increments to `2`. When Request 2 attempts its write, the `WHERE version = 1` condition matches zero rows, forcing the application to reject the transaction and protect the ledger from overspending.

---

## 8. Reconciliation Strategy

Because the HCM platform is the authoritative master, the microservice relies on a reactive ingestion loop rather than active polling.

* Scheduled Interval: Upstream Core Event
The corporate HCM executes milestone grants, bulk adjustments, or nightly corrections on the parent network.


* Immediate Action: Inbound Webhook Delivery
The HCM streams data down to `/webhooks/hcm/balance-update` or `/batch-sync`.


* Atomic Execution: Ledger-Backed Cache Commit
The local NestJS service processes the update inside an isolated transaction block, syncing SQLite with zero partial leakage.


---

## 9. Failure Handling

### Insufficient Balance

Requests that exceed the local balance are short-circuited immediately and rejected with an `HTTP 422 Unprocessable Entity` code.

### Concurrent Update Failure

Conflicting writes where the expected version stamp has changed fail the version match query, triggering an automated database abort and returning an `HTTP 409 Conflict` response.

### Duplicate Request Protection

Clients must provide a unique `idempotencyKey` per transaction. The system evaluates this string on submission to neutralize double-processing risks caused by browser retries or network line stutters.

### External Drift & Downstream Rejections

If a local transaction successfully writes to SQLite but is subsequently rejected by an asynchronous HCM verification check downstream, the engine executes a **compensating transaction**—appending a manual adjustment entry (`+delta`) to restore the ledger balance without altering history.

---

## 10. Testing Strategy

The microservice emphasizes rigorous integration testing. The automated end-to-end (E2E) test suite validates the following runtime conditions:

* **Happy Path Integration:** Validates that standard requests successfully check local records, perform balance adjustments, write ledger lines, and return clean `201` responses.
* **Insufficient Balance Rejection:** Assures that requests exceeding current limits terminate early and preserve original data parameters.
* **HCM Webhook Synchronization:** Emulates single-record adjustments and tracks immediate local data mutations.
* **Atomic Multi-Employee Batch Sync:** Fires complex nested JSON arrays to `/webhooks/hcm/batch-sync` to prove that multi-row transactions execute atomically or roll back fully if an invalid row is processed.
* **Optimistic Lock Race Conditions:** Simulates parallel high-frequency executions against identical employee rows to confirm that only one deduction succeeds while competing transactions are safely dropped with a `409` code.

---

## 11. Assumptions

* The external HCM platform remains the permanent, master authoritative system.
* Balances are strictly isolated and scoped per employee, per physical location.
* Security, user authentication, and Role-Based Access Control (RBAC) layers are handled upstream or are out of scope for this microservice iteration.
* SQLite satisfies assignment deployment footprints and local file simplicity.
* Heavy message-broker infrastructure (asynchronous queues) is intentionally omitted from the initial minimum viable product.

---

## 12. Future Improvements

As the platform scales into a global enterprise deployment, the following architecture upgrades are proposed:

* **Enterprise Storage:** Transition from localized SQLite file storage to a distributed, highly concurrent database engine like PostgreSQL to leverage true row-level locking.
* **Distributed Locking Layer:** Implement central Redis distributed locks (`Redlock`) to safely secure multi-node server clusters across modern containerized architectures (Kubernetes).
* **Event-Driven Telemetry:** Offload audit trails from the primary transactional database onto high-throughput event streams like Apache Kafka to allow asynchronous auditing and telemetry.
---
