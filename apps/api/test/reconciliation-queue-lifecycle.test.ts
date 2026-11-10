/**
 * Integration tests driving `ExecutionQueue` and `TransactionStatusReconciler`
 * together across the full post-submission lifecycle on a single `createApiServer`
 * instance.
 *
 * State-transition ownership contract:
 *   - `ExecutionQueue` (`apps/api/src/execution-queue.ts`):
 *       * `queued -> executing`: atomic `updateIfStatus(id, "queued", { status: "executing" })`
 *       * `failed -> executing`: atomic `updateIfStatus(id, "failed", { status: "executing" })` when `nextRetryAt <= now`
 *       * `executing -> submitted`: when the pipeline submits to Stellar and returns a `txHash`
 *       * `executing -> failed`: when execution fails transiently and `attempt < maxRetries` (schedules `nextRetryAt`)
 *       * `executing -> dead_letter`: when `attempt >= maxRetries` or error is permanent / pre-check disallows retry
 *   - `TransactionStatusReconciler` (`packages/stellar/src/reconciler.ts`):
 *       * `submitted -> confirmed`: atomic `updateIfStatus(id, "submitted", { status: "confirmed" })` on provider `confirmed`
 *       * `submitted -> failed`: atomic `updateIfStatus(id, "submitted", { status: "failed" })` on provider `failed`
 *       * `submitted -> submitted` (no-op): on provider `not_found` or `network_error` (never blind-retries)
 *       * CAS guard: if the record leaves `submitted` between `listSubmitted()` and `updateIfStatus()`, the write is skipped
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { ExecutionQueue, type ExecutionResult, type PipelineExecutor } from "../src/execution-queue.js";
import { TransactionStatusReconciler, type TransactionStatus, type TransactionStatusProvider } from "@4evergent/stellar";
import { DevAuthProvider } from "@4evergent/shared";
import {
  InMemoryExecutionStore,
  InMemoryActivityStore,
  InMemoryApprovalStore,
  InMemoryScheduleStore,
  InMemoryAgentStore,
  type ExecutionRecord,
  type RetryPolicy,
} from "@4evergent/database";

const TEST_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
};

function makeQueuedExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: crypto.randomUUID(),
    ownerId: "owner-a",
    agentId: "agent-a",
    approvalId: "approval-1",
    activityId: null,
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "10",
      reason: "reconciler + queue lifecycle test",
    },
    status: "queued",
    policyDecision: null,
    simulationResult: null,
    txHash: null,
    submittedHash: null,
    error: null,
    attempt: 0,
    nextRetryAt: null,
    startedAt: null,
    completedAt: null,
    errorClass: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface HarnessOptions {
  pipelineExecutor: PipelineExecutor;
  statusProvider: TransactionStatusProvider;
  retryPolicy?: RetryPolicy;
  initialTimeIso?: string;
}

async function startLifecycleServer(opts: HarnessOptions) {
  let currentTimeMs = Date.parse(opts.initialTimeIso ?? "2026-01-01T00:00:00.000Z");
  const clock = () => new Date(currentTimeMs);
  const advanceTimeMs = (deltaMs: number) => {
    currentTimeMs += deltaMs;
  };

  const executionStore = new InMemoryExecutionStore();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();
  const scheduleStore = new InMemoryScheduleStore();
  const agentStore = new InMemoryAgentStore();

  const executionQueue = new ExecutionQueue(
    executionStore,
    opts.pipelineExecutor,
    async () => ({
      accountId: () => "GTEST",
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    }),
    {
      intervalMs: 60_000,
      concurrency: 1,
      clock,
      now: clock,
      retryPolicy: opts.retryPolicy ?? TEST_RETRY_POLICY,
    }
  );

  const reconciler = new TransactionStatusReconciler(executionStore, opts.statusProvider, {
    intervalMs: 60_000,
    clock,
  });

  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: {
      getAccountId: () => "GTEST",
      getNetworkPassphrase: () => "Test SDF Network ; September 2015",
      sign: async (tx: unknown) => tx as never,
    },
    activityStore,
    approvalStore,
    scheduleStore,
    executionStore,
    agentStore,
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    executionQueue: {
      enabled: true,
      intervalMs: 60_000,
      instance: executionQueue,
    },
    reconciliation: {
      enabled: true,
      intervalMs: 60_000,
      instance: reconciler,
    },
  });

  // Stop the periodic background timers immediately after server startup so all
  // queue and reconciler ticks in tests are driven deterministically.
  executionQueue.stop();
  reconciler.stop();

  await server.listen(0);
  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    executionStore,
    executionQueue,
    reconciler,
    clock,
    advanceTimeMs,
    close: () => server.close(),
  };
}

test("Lifecycle 1: queued -> executing -> submitted via queue, then submitted -> confirmed via reconciler", async () => {
  const observedStatuses: string[] = [];
  let storeRef: InMemoryExecutionStore | null = null;

  const pipelineExecutor: PipelineExecutor = async (record): Promise<ExecutionResult> => {
    const midFlight = await storeRef!.get(record.id);
    if (midFlight) observedStatuses.push(midFlight.status);
    return {
      record,
      success: true,
      status: "submitted",
      txHash: "tx-lifecycle-confirmed",
      submittedHash: "tx-lifecycle-confirmed",
    };
  };

  const statusProvider: TransactionStatusProvider = {
    getStatus: async (txHash: string): Promise<TransactionStatus> => {
      assert.equal(txHash, "tx-lifecycle-confirmed");
      return "confirmed";
    },
  };

  const { baseUrl, executionStore, executionQueue, reconciler, clock, close } =
    await startLifecycleServer({ pipelineExecutor, statusProvider });
  storeRef = executionStore;

  try {
    const execution = makeQueuedExecution();
    await executionQueue.enqueue(execution);
    observedStatuses.push((await executionStore.get(execution.id))!.status);

    // Step 1: Queue claims queued -> executing -> submitted
    const started = await executionQueue.processDue(clock().toISOString());
    assert.equal(started, 1);

    const afterSubmit = await executionStore.get(execution.id);
    assert.equal(afterSubmit?.status, "submitted");
    assert.equal(afterSubmit?.txHash, "tx-lifecycle-confirmed");
    observedStatuses.push(afterSubmit!.status);

    // Step 2: Reconciler polls statusProvider and transitions submitted -> confirmed
    const recResult = await reconciler.reconcile();
    assert.equal(recResult.checked, 1);
    assert.equal(recResult.confirmed, 1);
    assert.equal(recResult.failed, 0);

    const afterConfirm = await executionStore.get(execution.id);
    assert.equal(afterConfirm?.status, "confirmed");
    assert.equal(afterConfirm?.txHash, "tx-lifecycle-confirmed");
    assert.ok(afterConfirm?.completedAt, "completedAt must be set when confirmed");
    observedStatuses.push(afterConfirm!.status);

    assert.deepEqual(observedStatuses, ["queued", "executing", "submitted", "confirmed"]);

    // Verify HTTP endpoint reflects confirmed terminal state
    const res = await fetch(`${baseUrl}/executions/${execution.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.execution.status, "confirmed");
    assert.equal(body.execution.txHash, "tx-lifecycle-confirmed");
  } finally {
    await close();
  }
});

test("Lifecycle 2: submitted + provider failed -> reconciler marks failed -> queue retries with backoff -> dead_letter when attempts exhausted", async () => {
  let invocations = 0;

  const pipelineExecutor: PipelineExecutor = async (record): Promise<ExecutionResult> => {
    invocations++;
    if (invocations === 1) {
      return {
        record,
        success: true,
        status: "submitted",
        txHash: "tx-onchain-fail-1",
        submittedHash: null,
      };
    }
    return {
      record,
      success: false,
      status: "failed",
      error: "horizon timeout during retry submission",
      errorClass: "transient",
    };
  };

  const statusProvider: TransactionStatusProvider = {
    getStatus: async (): Promise<TransactionStatus> => "failed",
  };

  const { baseUrl, executionStore, executionQueue, reconciler, clock, advanceTimeMs, close } =
    await startLifecycleServer({
      pipelineExecutor,
      statusProvider,
      retryPolicy: {
        maxRetries: 2,
        baseDelayMs: 5_000,
        maxDelayMs: 30_000,
      },
    });

  try {
    const execution = makeQueuedExecution();
    await executionQueue.enqueue(execution);

    // 1. Initial queue pass submits transaction (queued -> executing -> submitted)
    assert.equal(await executionQueue.processDue(clock().toISOString()), 1);
    const submitted = await executionStore.get(execution.id);
    assert.equal(submitted?.status, "submitted");
    assert.equal(submitted?.txHash, "tx-onchain-fail-1");

    // 2. Reconciler observes on-chain failure (submitted -> failed)
    const recResult = await reconciler.reconcile();
    assert.equal(recResult.checked, 1);
    assert.equal(recResult.failed, 1);

    const afterReconcileFail = await executionStore.get(execution.id);
    assert.equal(afterReconcileFail?.status, "failed");
    assert.equal(afterReconcileFail?.error, "Transaction failed on-chain");
    assert.equal(afterReconcileFail?.attempt, 0);

    // 3. Queue picks up the failed record: attempt 0 -> 1 (< maxRetries=2), schedules backoff
    assert.equal(await executionQueue.processDue(clock().toISOString()), 1);
    const afterRetry1 = await executionStore.get(execution.id);
    assert.equal(afterRetry1?.status, "failed");
    assert.equal(afterRetry1?.attempt, 1);
    assert.ok(afterRetry1?.nextRetryAt, "nextRetryAt must be scheduled after first retry failure");

    // Before backoff window elapses, processDue must not claim the record
    advanceTimeMs(1_000);
    assert.equal(await executionQueue.processDue(clock().toISOString()), 0);

    // 4. Advance clock past backoff window: attempt 1 -> 2 (== maxRetries=2) -> dead_letter
    advanceTimeMs(10_000);
    assert.equal(await executionQueue.processDue(clock().toISOString()), 1);

    const deadLettered = await executionStore.get(execution.id);
    assert.equal(deadLettered?.status, "dead_letter");
    assert.equal(deadLettered?.attempt, 2);
    assert.equal(deadLettered?.nextRetryAt, null);
    assert.ok(deadLettered?.completedAt, "completedAt must be set on dead_letter");

    // Subsequent queue and reconciler passes leave dead_letter untouched
    assert.equal(await executionQueue.processDue(clock().toISOString()), 0);
    const secondRec = await reconciler.reconcile();
    assert.equal(secondRec.checked, 0);

    const res = await fetch(`${baseUrl}/executions/${execution.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.execution.status, "dead_letter");
    assert.equal(body.execution.attempt, 2);
  } finally {
    await close();
  }
});

test("Lifecycle 3: submitted + provider not_found -> stays submitted and is never blind-retried by queue", async () => {
  let submitCalls = 0;

  const pipelineExecutor: PipelineExecutor = async (record): Promise<ExecutionResult> => {
    submitCalls++;
    return {
      record,
      success: true,
      status: "submitted",
      txHash: "tx-not-found-hash",
      submittedHash: "tx-not-found-hash",
    };
  };

  const statusProvider: TransactionStatusProvider = {
    getStatus: async (): Promise<TransactionStatus> => "not_found",
  };

  const { executionStore, executionQueue, reconciler, clock, advanceTimeMs, close } =
    await startLifecycleServer({ pipelineExecutor, statusProvider });

  try {
    const execution = makeQueuedExecution();
    await executionQueue.enqueue(execution);

    // Queue submits once
    assert.equal(await executionQueue.processDue(clock().toISOString()), 1);
    assert.equal(submitCalls, 1);

    // Reconciler checks Horizon and gets not_found
    const recResult = await reconciler.reconcile();
    assert.equal(recResult.checked, 1);
    assert.equal(recResult.confirmed, 0);
    assert.equal(recResult.failed, 0);

    const stored = await executionStore.get(execution.id);
    assert.equal(stored?.status, "submitted");
    assert.equal(stored?.txHash, "tx-not-found-hash");

    // Advancing time and running queue again must NOT blind-retry a submitted record
    advanceTimeMs(60_000);
    assert.equal(await executionQueue.processDue(clock().toISOString()), 0);
    assert.equal(submitCalls, 1);
    assert.equal((await executionStore.get(execution.id))?.status, "submitted");
  } finally {
    await close();
  }
});

test("Lifecycle 4: submitted + provider network_error -> stays submitted and is never blind-retried by queue", async () => {
  let submitCalls = 0;

  const pipelineExecutor: PipelineExecutor = async (record): Promise<ExecutionResult> => {
    submitCalls++;
    return {
      record,
      success: true,
      status: "submitted",
      txHash: "tx-network-error-hash",
      submittedHash: "tx-network-error-hash",
    };
  };

  const statusProvider: TransactionStatusProvider = {
    getStatus: async (): Promise<TransactionStatus> => "network_error",
  };

  const { executionStore, executionQueue, reconciler, clock, advanceTimeMs, close } =
    await startLifecycleServer({ pipelineExecutor, statusProvider });

  try {
    const execution = makeQueuedExecution();
    await executionQueue.enqueue(execution);

    assert.equal(await executionQueue.processDue(clock().toISOString()), 1);
    assert.equal(submitCalls, 1);

    const recResult = await reconciler.reconcile();
    assert.equal(recResult.checked, 1);
    assert.equal(recResult.confirmed, 0);
    assert.equal(recResult.failed, 0);

    const stored = await executionStore.get(execution.id);
    assert.equal(stored?.status, "submitted");
    assert.equal(stored?.txHash, "tx-network-error-hash");

    advanceTimeMs(60_000);
    assert.equal(await executionQueue.processDue(clock().toISOString()), 0);
    assert.equal(submitCalls, 1);
    assert.equal((await executionStore.get(execution.id))?.status, "submitted");
  } finally {
    await close();
  }
});

test("Lifecycle 5: concurrent update between reconciler read and write -> conditional update prevents stale overwrite", async () => {
  let storeRef: InMemoryExecutionStore | null = null;
  let targetExecutionId = "";

  const pipelineExecutor: PipelineExecutor = async (record): Promise<ExecutionResult> => ({
    record,
    success: true,
    status: "submitted",
    txHash: "tx-concurrent-race",
    submittedHash: "tx-concurrent-race",
  });

  // When the reconciler has already read the `submitted` record via `listSubmitted()`
  // and invokes `statusProvider.getStatus(txHash)`, simulate a concurrent transition
  // to `confirmed` before `reconcile()` attempts `updateIfStatus(id, "submitted", { status: "failed" })`.
  const statusProvider: TransactionStatusProvider = {
    getStatus: async (txHash: string): Promise<TransactionStatus> => {
      assert.equal(txHash, "tx-concurrent-race");
      await storeRef!.updateIfStatus(targetExecutionId, "submitted", {
        status: "confirmed",
        completedAt: "2026-01-01T00:01:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
      });
      return "failed";
    },
  };

  const { executionStore, executionQueue, reconciler, clock, close } =
    await startLifecycleServer({ pipelineExecutor, statusProvider });
  storeRef = executionStore;

  try {
    const execution = makeQueuedExecution();
    targetExecutionId = execution.id;
    await executionQueue.enqueue(execution);

    // Queue moves record to submitted
    assert.equal(await executionQueue.processDue(clock().toISOString()), 1);
    assert.equal((await executionStore.get(execution.id))?.status, "submitted");

    // Reconciler reads `submitted`, concurrent update moves it to `confirmed` mid-flight,
    // and reconciler's `updateIfStatus(..., "submitted", { status: "failed" })` is rejected.
    const recResult = await reconciler.reconcile();
    assert.equal(recResult.checked, 1);
    assert.equal(recResult.failed, 0);
    assert.equal(recResult.confirmed, 0);

    const finalRecord = await executionStore.get(execution.id);
    assert.equal(finalRecord?.status, "confirmed");
    assert.equal(finalRecord?.txHash, "tx-concurrent-race");
    assert.equal(finalRecord?.error, null);
  } finally {
    await close();
  }
});
