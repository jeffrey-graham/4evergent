import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import {
  SQLiteActivityStore,
  SQLiteApprovalStore,
  InMemoryActivityStore,
  InMemoryApprovalStore,
  createActivity,
  createApproval,
  assertNoSecrets,
  validateApprovalTransition,
  type ActivityStore,
  type ApprovalStore,
  type ApprovalStatus,
} from "../src/index.js";
import type { AgentIntent, PolicyDecision } from "@4evergent/shared";

function makeIntent(amount: string, _agentId = "agent-a"): AgentIntent {
  return {
    type: "payment",
    asset: "XLM",
    destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount,
    reason: "test",
  };
}

function makeDecision(result: "allow" | "deny" | "requires_approval" = "allow"): PolicyDecision {
  return { result, reason: "test", rule: "test", intent: makeIntent("1") };
}

// ===== Interface-level tests: run against BOTH in-memory and SQLite =====

function runStoreTests(name: string, makeStores: () => { activity: ActivityStore; approval: ApprovalStore; cleanup?: () => void }) {
  test(`${name}: write/read activity round-trips`, async () => {
    const { activity, cleanup } = makeStores();
    try {
      const rec = createActivity("agent-a", "owner-a", makeIntent("5"), makeDecision());
      await activity.record(rec);
      const got = await activity.get(rec.id);
      // idempotencyKey is `string | null | undefined`. Stores may normalize an
      // omitted key to null (SQLite SQL NULL) or preserve undefined (InMemory
      // object reference). Both are valid representations of "no key" per the
      // ActivityRecord contract — normalize both sides before comparing so the
      // round-trip assertion covers every other field exactly.
      assert.deepEqual(
        { ...got, idempotencyKey: got?.idempotencyKey ?? null },
        { ...rec, idempotencyKey: rec.idempotencyKey ?? null }
      );
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: write/read approval round-trips`, async () => {
    const { activity, approval, cleanup } = makeStores();
    try {
      const act = createActivity("agent-a", "owner-a", makeIntent("5"), makeDecision());
      await activity.record(act);
      const appr = createApproval(act.id, "agent-a", "owner-a", makeIntent("5"), makeDecision(), null);
      await approval.record(appr);
      const got = await approval.get(appr.id);
      assert.deepEqual(got, appr);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByAgent filters by agent`, async () => {
    const { activity, cleanup } = makeStores();
    try {
      const a = createActivity("agent-a", "owner-a", makeIntent("1"), makeDecision());
      const b = createActivity("agent-b", "owner-b", makeIntent("1"), makeDecision());
      await activity.record(a);
      await activity.record(b);
      const list = await activity.listByAgent("agent-a");
      assert.equal(list.length, 1);
      assert.equal(list[0]!.agentId, "agent-a");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByStatus filters correctly`, async () => {
    const { activity, cleanup } = makeStores();
    try {
      const a = createActivity("agent-a", "owner-a", makeIntent("1"), makeDecision());
      a.status = "submitted";
      const b = createActivity("agent-a", "owner-a", makeIntent("1"), makeDecision());
      b.status = "rejected";
      await activity.record(a);
      await activity.record(b);
      const submitted = await activity.listByStatus("agent-a", "submitted");
      assert.equal(submitted.length, 1);
      assert.equal(submitted[0]!.status, "submitted");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: update mutates and returns record`, async () => {
    const { activity, cleanup } = makeStores();
    try {
      const rec = createActivity("agent-a", "owner-a", makeIntent("1"), makeDecision());
      await activity.record(rec);
      const updated = await activity.update(rec.id, { status: "submitted", txHash: "abc123" });
      assert.equal(updated!.status, "submitted");
      assert.equal(updated!.txHash, "abc123");
      const got = await activity.get(rec.id);
      assert.equal(got!.status, "submitted");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listAll returns all records across agents`, async () => {
    const { activity, cleanup } = makeStores();
    try {
      const a = createActivity("agent-a", "owner-a", makeIntent("1"), makeDecision());
      const b = createActivity("agent-b", "owner-b", makeIntent("2"), makeDecision());
      await activity.record(a);
      await activity.record(b);
      const all = await activity.listAll(50);
      assert.equal(all.length, 2);
      const ids = all.map((r) => r.id);
      assert.ok(ids.includes(a.id));
      assert.ok(ids.includes(b.id));
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listAll respects limit`, async () => {
    const { activity, cleanup } = makeStores();
    try {
      for (let i = 0; i < 5; i++) {
        await activity.record(createActivity("agent-a", "owner-a", makeIntent(String(i)), makeDecision()));
      }
      const all = await activity.listAll(3);
      assert.equal(all.length, 3);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listAll returns empty when no records`, async () => {
    const { activity, cleanup } = makeStores();
    try {
      const all = await activity.listAll(50);
      assert.deepEqual(all, []);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: get nonexistent returns null`, async () => {
    const { activity, approval, cleanup } = makeStores();
    try {
      assert.equal(await activity.get("nope"), null);
      assert.equal(await approval.get("nope"), null);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: assertNoSecrets rejects secret-bearing records`, () => {
    const rec = createActivity("agent-a", "owner-a", makeIntent("1"), makeDecision());
    rec.error = "failed because private_key was wrong";
    assert.throws(() => assertNoSecrets(rec), /forbidden key material/);
  });

  test(`${name}: approval record has no secret fields`, () => {
    const appr = createApproval("act-1", "agent-a", "owner-a", makeIntent("1"), makeDecision(), null);
    const keys = Object.keys(appr);
    assert.ok(!keys.some((k) => /secret|seed|private|mnemonic/i.test(k)));
  });
}

// In-memory
runStoreTests("InMemory", () => ({
  activity: new InMemoryActivityStore(),
  approval: new InMemoryApprovalStore(),
}));

// SQLite (persisted to a temp file)
runStoreTests("SQLite", () => {
  const dir = mkdtempSync(join(tmpdir(), "4evergent-test-"));
  const path = join(dir, "test.db");
  return {
    activity: new SQLiteActivityStore(path),
    approval: new SQLiteApprovalStore(path),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
});

for (const kind of ["InMemory", "SQLite"] as const) {
  test(`${kind}: retention sweep deletes old daily spending and preserves the current day`, async () => {
    let store: InMemoryActivityStore | SQLiteActivityStore;
    let dir: string | undefined;
    if (kind === "SQLite") {
      dir = mkdtempSync(join(tmpdir(), "4evergent-retention-"));
      store = new SQLiteActivityStore(join(dir, "retention.db"));
    } else {
      store = new InMemoryActivityStore();
    }
    try {
      const asDate = (day: string) => new Date(`${day}T12:00:00.000Z`);
      await store.reserveDailySpending("agent-a", "XLM", "1", "10", asDate("2025-01-01"));
      await store.reserveDailySpending("agent-a", "XLM", "2", "10", asDate("2025-01-02"));
      await store.reserveDailySpending("agent-a", "XLM", "3", "10", asDate("2025-01-03"));

      assert.equal(await store.sweepDailySpending("2025-01-03"), 2);
      assert.equal(await store.getDailySpending("agent-a", "XLM", asDate("2025-01-02")), null);
      assert.equal(await store.getDailySpending("agent-a", "XLM", asDate("2025-01-03")), 3);
      assert.equal(await store.sweepDailySpending("2025-01-03"), 0);
    } finally {
      if (store instanceof SQLiteActivityStore) store.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("SQLite: second pending approval for same activity is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "4evergent-dup-"));
  const path = join(dir, "dup.db");
  try {
    const actStore = new SQLiteActivityStore(path);
    const apprStore = new SQLiteApprovalStore(path);
    const act = createActivity("agent-a", "owner-a", makeIntent("5"), makeDecision());
    await actStore.record(act);

    const a1 = createApproval(act.id, "agent-a", "owner-a", makeIntent("5"), makeDecision(), null);
    await apprStore.record(a1);

    const a2 = createApproval(act.id, "agent-a", "owner-a", makeIntent("5"), makeDecision(), null);
    await assert.rejects(
      () => apprStore.record(a2),
      /already has a pending approval/
    );

    // Original record must still be intact (not silently replaced)
    const got = await apprStore.get(a1.id);
    assert.ok(got, "original approval must remain");
    assert.equal(got!.id, a1.id);
    actStore.close();
    apprStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite: update existing approval (status transition) still works", async () => {
  const dir = mkdtempSync(join(tmpdir(), "4evergent-upsert-"));
  const path = join(dir, "upsert.db");
  try {
    const actStore = new SQLiteActivityStore(path);
    const apprStore = new SQLiteApprovalStore(path);
    const act = createActivity("agent-a", "owner-a", makeIntent("5"), makeDecision());
    await actStore.record(act);

    const a1 = createApproval(act.id, "agent-a", "owner-a", makeIntent("5"), makeDecision(), null);
    await apprStore.record(a1);

    // Transition to approved — upsert path must succeed (same id)
    const updated = await apprStore.update(a1.id, { status: "approved", approvedAt: new Date().toISOString() });
    assert.ok(updated);
    assert.equal(updated!.status, "approved");

    // No pending approval exists now, so a new one may be created
    const a2 = createApproval(act.id, "agent-a", "owner-a", makeIntent("5"), makeDecision(), null);
    await apprStore.record(a2);
    const got = await apprStore.get(a2.id);
    assert.ok(got, "new pending after approval transition must succeed");
    actStore.close();
    apprStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite: activity survives store reopen (restart simulation)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "4evergent-restart-"));
  const path = join(dir, "restart.db");
  try {
    const id = "persist-test-id";
    const store1 = new SQLiteActivityStore(path);
    const rec = createActivity("agent-a", "owner-a", makeIntent("7"), makeDecision());
    rec.id = id;
    await store1.record(rec);
    store1.close();

    // Simulate process restart: open a NEW store instance on the same file
    const store2 = new SQLiteActivityStore(path);
    const got = await store2.get(id);
    assert.ok(got, "record must survive reopen");
    assert.equal(got!.agentId, "agent-a");
    assert.equal((got!.intent as { amount?: string }).amount, "7");
    store2.close();

    // File exists on disk
    assert.ok(existsSync(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite: approval survives store reopen (restart simulation)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "4evergent-restart-appr-"));
  const path = join(dir, "restart-appr.db");
  try {
    const id = "persist-approval-id";
    const store1 = new SQLiteApprovalStore(path);
    const act = createActivity("agent-a", "owner-a", makeIntent("7"), makeDecision());
    const appr = createApproval(act.id, "agent-a", "owner-a", makeIntent("7"), makeDecision(), null);
    appr.id = id;
    await store1.record(appr);
    store1.close();

    const store2 = new SQLiteApprovalStore(path);
    const got = await store2.get(id);
    assert.ok(got, "approval must survive reopen");
    assert.equal(got!.status, "pending_approval");
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite: schema is versioned in _meta", async () => {
  const dir = mkdtempSync(join(tmpdir(), "4evergent-meta-"));
  const path = join(dir, "meta.db");
  try {
    const store = new SQLiteActivityStore(path);
    store.close();
    // Reopen — initSchema must be idempotent and not fail
    const store2 = new SQLiteActivityStore(path);
    const rec = createActivity("agent-a", "owner-a", makeIntent("1"), makeDecision());
    await store2.record(rec);
    const got = await store2.get(rec.id);
    assert.ok(got);
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== Approval state machine =====

test("state machine: pending_approval -> approved is valid", () => {
  assert.equal(validateApprovalTransition("pending_approval", "approved"), null);
});

test("state machine: approved -> approved is INVALID", () => {
  assert.ok(validateApprovalTransition("approved", "approved") !== null);
});

test("state machine: rejected -> approved is INVALID", () => {
  assert.ok(validateApprovalTransition("rejected", "approved") !== null);
});

test("state machine: approved -> rejected is INVALID", () => {
  assert.ok(validateApprovalTransition("approved", "rejected") !== null);
});

test("state machine: submitted -> approved is INVALID (no resubmit)", () => {
  assert.ok(validateApprovalTransition("submitted", "approved") !== null);
});

test("state machine: executing -> submitted is valid", () => {
  assert.equal(validateApprovalTransition("executing", "submitted"), null);
});

// ===== Approval state machine — full 8×8 matrix (64 transitions) =====
//
// ALL_STATUSES is derived from the ApprovalStatus union so that adding a
// new status in the future causes this test to fail loudly rather than
// silently skip the new cells.
//
// MATRIX mirrors the allowed-transitions table in validateApprovalTransition
// (packages/database/src/index.ts:407-416). Legal = 12, illegal = 52.
//
// NOTE: The issue description stated 13 legal / 51 illegal. The source code
// has 12 (4+3+3+2). This test asserts the source, not the issue description,
// per the contributor notes: "If the test reveals the source matrix differs
// from this list, assert the source's behavior and flag the discrepancy."

const ALL_STATUSES: ApprovalStatus[] = [
  "pending_approval",
  "approved",
  "rejected",
  "expired",
  "executing",
  "submitted",
  "confirmed",
  "failed",
];

// Legal transitions derived from the source matrix.
const LEGAL_TRANSITIONS: [ApprovalStatus, ApprovalStatus][] = [
  // pending_approval (4)
  ["pending_approval", "approved"],
  ["pending_approval", "rejected"],
  ["pending_approval", "expired"],
  ["pending_approval", "executing"],
  // approved (3)
  ["approved", "executing"],
  ["approved", "submitted"],
  ["approved", "failed"],
  // executing (3)
  ["executing", "submitted"],
  ["executing", "confirmed"],
  ["executing", "failed"],
  // submitted (2)
  ["submitted", "confirmed"],
  ["submitted", "failed"],
];

// Build a Set for O(1) lookup when deciding which cells are illegal.
const LEGAL_SET = new Set(LEGAL_TRANSITIONS.map(([c, n]) => `${c}->${n}`));

test("state machine: all 12 legal transitions return null", () => {
  for (const [current, next] of LEGAL_TRANSITIONS) {
    const result = validateApprovalTransition(current, next);
    assert.equal(
      result,
      null,
      `Expected legal transition ${current} -> ${next} to return null, got: ${result}`
    );
  }
});

test("state machine: all 52 illegal transitions return a non-null error string", () => {
  for (const current of ALL_STATUSES) {
    for (const next of ALL_STATUSES) {
      if (LEGAL_SET.has(`${current}->${next}`)) continue; // skip legal cells
      const result = validateApprovalTransition(current, next);
      assert.ok(
        result !== null,
        `Expected illegal transition ${current} -> ${next} to return an error string, got null`
      );
    }
  }
});

test("state machine: error message format is 'Invalid transition: <current> -> <next>'", () => {
  // Verify the exact message format using one representative illegal transition.
  const msg = validateApprovalTransition("failed", "submitted");
  assert.equal(msg, "Invalid transition: failed -> submitted");
});

test("state machine: terminal states (rejected, expired, confirmed, failed) reject all 8 transitions each", () => {
  const terminals: ApprovalStatus[] = ["rejected", "expired", "confirmed", "failed"];
  for (const current of terminals) {
    for (const next of ALL_STATUSES) {
      const result = validateApprovalTransition(current, next);
      assert.ok(
        result !== null,
        `Terminal state ${current} must reject all transitions, but ${current} -> ${next} returned null`
      );
    }
  }
});

test("state machine: security-critical resurrection transitions are rejected", () => {
  // These transitions would bypass the pipeline and allow dead records to be
  // resurrected without going through retry — a data-integrity failure.
  const dangerous: [ApprovalStatus, ApprovalStatus][] = [
    ["failed", "submitted"],       // resurrection after failure
    ["failed", "executing"],       // resurrection after failure
    ["confirmed", "submitted"],    // resurrection of a confirmed record
    ["expired", "approved"],       // resurrection after expiry
    ["pending_approval", "confirmed"], // skip execution
    ["pending_approval", "submitted"], // skip execution
  ];
  for (const [current, next] of dangerous) {
    const result = validateApprovalTransition(current, next);
    assert.ok(
      result !== null,
      `Security-critical transition ${current} -> ${next} must be rejected, but got null`
    );
  }
});

test("state machine: full 8×8 matrix coverage — exactly 12 legal and 52 illegal cells", () => {
  // NOTE: The issue description stated 13 legal / 51 illegal, but the source
  // (packages/database/src/index.ts:407-416) defines exactly 12 legal
  // transitions (4+3+3+2). The implementation is authoritative; the test
  // asserts what the code actually does.
  let legalCount = 0;
  let illegalCount = 0;
  for (const current of ALL_STATUSES) {
    for (const next of ALL_STATUSES) {
      const result = validateApprovalTransition(current, next);
      if (result === null) {
        legalCount++;
      } else {
        illegalCount++;
      }
    }
  }
  assert.equal(legalCount, 12, `Expected exactly 12 legal transitions, got ${legalCount}`);
  assert.equal(illegalCount, 52, `Expected exactly 52 illegal transitions, got ${illegalCount}`);
});

for (const kind of ["InMemory", "SQLite"] as const) {
  test(`${kind}: Idempotency-Key expiry window — suppresses within window, expires after window while preserving audit record`, async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const clock = () => new Date(nowMs);
    let store: InMemoryActivityStore | SQLiteActivityStore;
    let dir: string | undefined;
    if (kind === "SQLite") {
      dir = mkdtempSync(join(tmpdir(), "4evergent-idem-expiry-"));
      store = new SQLiteActivityStore(join(dir, "idem.db"), { idempotencyTtlSeconds: 60, clock });
    } else {
      store = new InMemoryActivityStore({ idempotencyTtlSeconds: 60, clock });
    }

    try {
      const first = createActivity("agent-a", "owner-a", makeIntent("10"), makeDecision());
      first.createdAt = new Date(nowMs).toISOString();
      first.updatedAt = first.createdAt;

      const res1 = await store.recordIdempotent("idem-exp-1", first);
      assert.equal(res1.created, true);
      assert.equal(res1.record.id, first.id);

      // Inside the 60s window (t = +30s): lookup and recordIdempotent return the original activity
      nowMs += 30_000;
      const withinWindow = await store.getByIdempotencyKey("owner-a", "agent-a", "idem-exp-1");
      assert.ok(withinWindow, "key must still resolve inside the replay window");
      assert.equal(withinWindow?.id, first.id);

      const secondInside = createActivity("agent-a", "owner-a", makeIntent("10"), makeDecision());
      secondInside.createdAt = new Date(nowMs).toISOString();
      secondInside.updatedAt = secondInside.createdAt;
      const resInside = await store.recordIdempotent("idem-exp-1", secondInside);
      assert.equal(resInside.created, false);
      assert.equal(resInside.record.id, first.id);

      // After the 60s window (t = +61s): key suppression expires; new activity can be created with the same key
      nowMs += 31_000;
      const afterWindowLookup = await store.getByIdempotencyKey("owner-a", "agent-a", "idem-exp-1");
      assert.equal(afterWindowLookup, null);

      const postExpiry = createActivity("agent-a", "owner-a", makeIntent("25"), makeDecision());
      postExpiry.createdAt = new Date(nowMs).toISOString();
      postExpiry.updatedAt = postExpiry.createdAt;
      const resAfter = await store.recordIdempotent("idem-exp-1", postExpiry);
      assert.equal(resAfter.created, true);
      assert.equal(resAfter.record.id, postExpiry.id);

      // Both the original and the new activity audit records remain intact in the store
      const originalAudit = await store.get(first.id);
      assert.ok(originalAudit, "original activity audit record must never be deleted by key expiry");
      assert.equal(originalAudit?.intent.type === "payment" ? originalAudit.intent.amount : "", "10");

      const newAudit = await store.get(postExpiry.id);
      assert.ok(newAudit);
      assert.equal(newAudit?.idempotencyKey, "idem-exp-1");
    } finally {
      if (store instanceof SQLiteActivityStore) store.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
}
