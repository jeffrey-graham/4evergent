import { DatabaseSync } from "node:sqlite";
import type {
  ActivityRecord,
  AgentIntent,
  AuthorizationStatus,
  PolicyDecision,
  SimulationResult,
} from "@4evergent/shared";
import { getSharedConnection } from "./shared-connection.js";
import { clampOffset, clampLimit } from "./pagination.js";
import {
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  type ActivityStore,
  type ActivityStoreOptions,
  type ApprovalStore,
  type ApprovalRecord,
  type ApprovalStatus,
} from "./index.js";

/**
 * SQLiteActivityStore — persistent ActivityStore backed by SQLite.
 *
 * Uses Node.js built-in node:sqlite (Node 22+, stable in Node 26). No external
 * database server required. Data persists across process restarts in a file
 * at the path provided to the constructor.
 *
 * Schema is versioned in _meta (schema_version = 3). initSchema() is
 * idempotent and safe to call on every construction.
 */
export class SQLiteActivityStore implements ActivityStore {
  private db: DatabaseSync;
  private idempotencyTtlMs: number;
  private clock: () => Date;

  constructor(dbPath: string, options: ActivityStoreOptions = {}) {
    this.db = getSharedConnection(dbPath);
    const ttlSeconds =
      options.idempotencyTtlSeconds !== undefined &&
      Number.isFinite(options.idempotencyTtlSeconds) &&
      options.idempotencyTtlSeconds > 0
        ? options.idempotencyTtlSeconds
        : DEFAULT_IDEMPOTENCY_TTL_SECONDS;
    this.idempotencyTtlMs = Math.round(ttlSeconds * 1000);
    this.clock = options.clock ?? (() => new Date());
    this.initSchema();
  }

  private getIdempotencyCutoffIso(now = this.clock()): string {
    return new Date(now.getTime() - this.idempotencyTtlMs).toISOString();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        idempotency_key TEXT,
        intent_json TEXT NOT NULL,
        policy_decision_json TEXT NOT NULL,
        authorization_status TEXT,
        simulation_result_json TEXT,
        tx_hash TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_activities_agent ON activities(agent_id);
      CREATE INDEX IF NOT EXISTS idx_activities_status ON activities(status);
      CREATE INDEX IF NOT EXISTS idx_activities_owner ON activities(owner_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_idempotency
        ON activities(owner_id, agent_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
    // Phase 23: daily_spending table for atomic spending reservation
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS daily_spending (
          agent_id TEXT NOT NULL,
          asset TEXT NOT NULL,
          day TEXT NOT NULL,
          total REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (agent_id, asset, day)
        );
      CREATE INDEX IF NOT EXISTS idx_daily_spending_day ON daily_spending(day);
      `);
    } catch {
      // Table already exists.
    }
  }

  async record(record: ActivityRecord): Promise<void> {
    if (record.idempotencyKey) {
      const cutoffIso = this.getIdempotencyCutoffIso();
      this.db
        .prepare(
          `UPDATE activities SET idempotency_key = NULL
           WHERE owner_id = ? AND agent_id = ? AND idempotency_key = ? AND id != ? AND created_at <= ?`
        )
        .run(record.ownerId, record.agentId, record.idempotencyKey, record.id, cutoffIso);
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO activities
         (id, agent_id, owner_id, idempotency_key, intent_json, policy_decision_json, authorization_status,
          simulation_result_json, tx_hash, status, error, created_at, updated_at)
         VALUES (@id, @agent_id, @owner_id, @idempotency_key, @intent_json, @policy_decision_json, @authorization_status,
                 @simulation_result_json, @tx_hash, @status, @error, @created_at, @updated_at)`
      )
      .run({
        id: record.id,
        agent_id: record.agentId,
        owner_id: record.ownerId,
        idempotency_key: record.idempotencyKey ?? null,
        intent_json: JSON.stringify(record.intent),
        policy_decision_json: JSON.stringify(record.policyDecision),
        authorization_status: record.authorizationStatus,
        simulation_result_json: record.simulationResult
          ? JSON.stringify(record.simulationResult)
          : null,
        tx_hash: record.txHash,
        status: record.status,
        error: record.error,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      });
  }

  async get(id: string): Promise<ActivityRecord | null> {
    const row = this.db.prepare("SELECT * FROM activities WHERE id = ?").get(id);
    return row ? rowToActivityRecord(row as unknown as ActivityRow) : null;
  }

  async listByAgent(agentId: string, limit = 50, offset = 0): Promise<ActivityRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM activities WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(agentId, clampLimit(limit), clampOffset(offset));
    return rows.map((r) => rowToActivityRecord(r as unknown as ActivityRow));
  }

  async listByStatus(agentId: string, status: string, limit = 50, offset = 0): Promise<ActivityRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM activities WHERE agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(agentId, status, clampLimit(limit), clampOffset(offset));
    return rows.map((r) => rowToActivityRecord(r as unknown as ActivityRow));
  }

  async listAll(limit = 50, offset = 0): Promise<ActivityRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM activities ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(clampLimit(limit), clampOffset(offset));
    return rows.map((r) => rowToActivityRecord(r as unknown as ActivityRow));
  }

  async listByOwner(ownerId: string, limit = 50, offset = 0): Promise<ActivityRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM activities WHERE owner_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(ownerId, clampLimit(limit), clampOffset(offset));
    return rows.map((r) => rowToActivityRecord(r as unknown as ActivityRow));
  }

  async getForOwner(id: string, ownerId: string): Promise<ActivityRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM activities WHERE id = ? AND owner_id = ?")
      .get(id, ownerId);
    return row ? rowToActivityRecord(row as unknown as ActivityRow) : null;
  }

  async getByIdempotencyKey(ownerId: string, agentId: string, key: string): Promise<ActivityRecord | null> {
    const cutoffIso = this.getIdempotencyCutoffIso();
    // Clear expired idempotency_key binding without deleting the activity audit record
    this.db
      .prepare(
        `UPDATE activities SET idempotency_key = NULL
         WHERE owner_id = ? AND agent_id = ? AND idempotency_key = ? AND created_at <= ?`
      )
      .run(ownerId, agentId, key, cutoffIso);
    const row = this.db
      .prepare(
        `SELECT * FROM activities
         WHERE owner_id = ? AND agent_id = ? AND idempotency_key = ? AND created_at > ?`
      )
      .get(ownerId, agentId, key, cutoffIso);
    return row ? rowToActivityRecord(row as unknown as ActivityRow) : null;
  }

  async sweepExpiredIdempotencyKeys(now = this.clock(), limit = 500): Promise<number> {
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    const cutoffIso = this.getIdempotencyCutoffIso(now);
    const result = this.db
      .prepare(
        `UPDATE activities SET idempotency_key = NULL
         WHERE id IN (
           SELECT id FROM activities
           WHERE idempotency_key IS NOT NULL AND created_at <= ?
           ORDER BY created_at ASC
           LIMIT ?
         )`
      )
      .run(cutoffIso, limit);
    return Number(result.changes ?? 0);
  }

  /**
   * Atomic idempotency reservation.
   *
   * Phase 23: Uses INSERT to leverage the UNIQUE INDEX
   * idx_activities_idempotency. The database guarantees only one record per
   * (owner_id, agent_id, idempotency_key). Concurrent inserts result in exactly
   * one winner; losers catch the UNIQUE violation and read back the winner.
   */
  async recordIdempotent(key: string, record: ActivityRecord): Promise<{ record: ActivityRecord; created: boolean }> {
    // Fast path: check if already exists (avoids INSERT overhead)
    const existing = await this.getByIdempotencyKey(record.ownerId, record.agentId, key);
    if (existing) return { record: existing, created: false };

    // Atomic INSERT — UNIQUE INDEX enforces single winner
    record.idempotencyKey = key;
    try {
      this.db
        .prepare(
          `INSERT INTO activities
           (id, agent_id, owner_id, idempotency_key, intent_json, policy_decision_json, authorization_status,
            simulation_result_json, tx_hash, status, error, created_at, updated_at)
           VALUES (@id, @agent_id, @owner_id, @idempotency_key, @intent_json, @policy_decision_json, @authorization_status,
                   @simulation_result_json, @tx_hash, @status, @error, @created_at, @updated_at)`
        )
        .run({
          id: record.id,
          agent_id: record.agentId,
          owner_id: record.ownerId,
          idempotency_key: record.idempotencyKey ?? null,
          intent_json: JSON.stringify(record.intent),
          policy_decision_json: JSON.stringify(record.policyDecision),
          authorization_status: record.authorizationStatus,
          simulation_result_json: record.simulationResult
            ? JSON.stringify(record.simulationResult)
            : null,
          tx_hash: record.txHash,
          status: record.status,
          error: record.error,
          created_at: record.createdAt,
          updated_at: record.updatedAt,
        });
      return { record, created: true };
    } catch (e: any) {
      // UNIQUE constraint violation — another caller won the race; return their record
      if (e?.message?.includes("UNIQUE") || e?.code === "ERR_SQLITE_CONSTRAINT") {
        const winner = await this.getByIdempotencyKey(record.ownerId, record.agentId, key);
        if (winner) return { record: winner, created: false };
      }
      throw e;
    }
  }

  /**
   * Atomically reserve daily spending using conditional UPDATE.
   *
   * Phase 23: Uses a single SQL UPDATE with WHERE clause checking the limit:
   * - UPDATE ... WHERE agent_id = ? AND asset = ? AND day = ? AND total + amount <= limit
   * - If changes === 1: reservation succeeded
   * - If changes === 0: row doesn't exist OR limit would be exceeded
   *
   * Concurrent calls are serialized by SQLite's row-level locking. The PRIMARY KEY
   * (agent_id, asset, day) ensures one row per asset per day.
   */
  async reserveDailySpending(agentId: string, asset: string, amount: string, limit: string, now = new Date()): Promise<boolean> {
    const amountNum = parseFloat(amount);
    const limitNum = parseFloat(limit);
    if (isNaN(amountNum) || isNaN(limitNum)) return false;

    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      .toISOString()
      .slice(0, 10); // YYYY-MM-DD

    // Conditional UPDATE: only succeeds if current total + amount <= limit
    const updateResult = this.db
      .prepare(
        `UPDATE daily_spending SET total = total + ?
         WHERE agent_id = ? AND asset = ? AND day = ? AND total + ? <= ?`
      )
      .run(amountNum, agentId, asset, day, amountNum, limitNum);

    if (updateResult.changes === 1) {
      return true; // Reservation succeeded
    }

    // UPDATE affected 0 rows — either row doesn't exist or limit exceeded
    // Try INSERT (row doesn't exist yet — first spend of the day)
    try {
      this.db
        .prepare(
          `INSERT INTO daily_spending (agent_id, asset, day, total) VALUES (?, ?, ?, ?)`
        )
        .run(agentId, asset, day, amountNum);
      // INSERT succeeded — verify amount doesn't exceed limit
      return amountNum <= limitNum;
    } catch (_e: any) {
      // PRIMARY KEY conflict — row was created by concurrent caller between our UPDATE and INSERT
      // Retry the UPDATE once (the concurrent caller's INSERT committed first)
      const retryResult = this.db
        .prepare(
          `UPDATE daily_spending SET total = total + ?
           WHERE agent_id = ? AND asset = ? AND day = ? AND total + ? <= ?`
        )
        .run(amountNum, agentId, asset, day, amountNum, limitNum);
      return retryResult.changes === 1;
    }
  }

  async getDailySpending(agentId: string, asset: string, now = new Date()): Promise<number | null> {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      .toISOString().slice(0, 10);
    const row = this.db
      .prepare(`SELECT total FROM daily_spending WHERE agent_id = ? AND asset = ? AND day = ?`)
      .get(agentId, asset, day) as { total: number } | undefined;
    return row ? row.total : null;
  }

  async sweepDailySpending(cutoffDay: string, limit = 500): Promise<number> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDay) || !Number.isInteger(limit) || limit <= 0) return 0;
    const result = this.db.prepare(`
      DELETE FROM daily_spending
      WHERE rowid IN (
        SELECT rowid FROM daily_spending WHERE day < ? ORDER BY day ASC LIMIT ?
      )
    `).run(cutoffDay, limit);
    return Number(result.changes);
  }

  async update(id: string, patch: Partial<ActivityRecord>): Promise<ActivityRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    await this.record(updated);
    return updated;
  }

  close(): void {
    // Shared connection — managed by closeSharedConnection() / closeAllSharedConnections()
  }
}

// ============================================================
// SQLiteApprovalStore (unchanged except for daily_spending table)
// ============================================================

/**
 * SQLiteApprovalStore — persistent ApprovalStore backed by SQLite.
 *
 * Shares the same DB file as SQLiteActivityStore. The partial unique index
 * idx_approvals_activity_one enforces that at most one PENDING_APPROVAL record
 * exists per activity id. This is the structural guard against duplicate pending
 * approvals for the same intent.
 *
 * record() performs an explicit pre-check for an existing pending approval
 * before inserting, so callers get a clear error (not a raw SQL exception).
 * SQLite's unique index is the final safety net.
 */
export class SQLiteApprovalStore implements ApprovalStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = getSharedConnection(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        policy_decision_json TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        approved_at TEXT,
        rejected_at TEXT,
        expired_at TEXT,
        approver TEXT,
        expires_at TEXT,
        tx_hash TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approvals(agent_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
      CREATE INDEX IF NOT EXISTS idx_approvals_activity ON approvals(activity_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_owner ON approvals(owner_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_activity_one
        ON approvals(activity_id) WHERE status = 'pending_approval';
    `);
  }

  async record(record: ApprovalRecord): Promise<void> {
    // Invariant: at most one PENDING_APPROVAL per activity id.
    // SQLite's partial unique index (idx_approvals_activity_one) is the final
    // structural guard; this pre-check gives callers a clear error and keeps
    // existing records from being silently replaced.
    if (record.status === "pending_approval") {
      const existing = this.db
        .prepare(
          "SELECT id FROM approvals WHERE activity_id = ? AND status = 'pending_approval' AND id != ?"
        )
        .get(record.activityId, record.id) as { id: string } | undefined;
      if (existing) {
        throw new Error(
          `ApprovalStore: activity ${record.activityId} already has a pending approval (${existing.id}); refusing to create a second one`
        );
      }
    }

    this.db
      .prepare(
        `INSERT INTO approvals
         (id, activity_id, agent_id, owner_id, intent_json, policy_decision_json, status,
          requested_at, approved_at, rejected_at, expired_at, approver, expires_at,
          tx_hash, error, created_at, updated_at)
         VALUES (@id, @activity_id, @agent_id, @owner_id, @intent_json, @policy_decision_json, @status,
                 @requested_at, @approved_at, @rejected_at, @expired_at, @approver, @expires_at,
                 @tx_hash, @error, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           activity_id = excluded.activity_id,
           agent_id = excluded.agent_id,
           owner_id = excluded.owner_id,
           intent_json = excluded.intent_json,
           policy_decision_json = excluded.policy_decision_json,
           status = excluded.status,
           requested_at = excluded.requested_at,
           approved_at = excluded.approved_at,
           rejected_at = excluded.rejected_at,
           expired_at = excluded.expired_at,
           approver = excluded.approver,
           expires_at = excluded.expires_at,
           tx_hash = excluded.tx_hash,
           error = excluded.error,
           updated_at = excluded.updated_at`
      )
      .run({
        id: record.id,
        activity_id: record.activityId,
        agent_id: record.agentId,
        owner_id: record.ownerId,
        intent_json: JSON.stringify(record.intent),
        policy_decision_json: JSON.stringify(record.policyDecision),
        status: record.status,
        requested_at: record.requestedAt,
        approved_at: record.approvedAt,
        rejected_at: record.rejectedAt,
        expired_at: record.expiredAt,
        approver: record.approver,
        expires_at: record.expiresAt,
        tx_hash: record.txHash,
        error: record.error,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      });
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    if (!row) return null;
    return rowToApprovalRecord(row as unknown as ApprovalRow);
  }

  async listByAgent(agentId: string, limit = 50, offset = 0, status?: string): Promise<ApprovalRecord[]> {
    const safeOffset = clampOffset(offset);
    if (status === undefined) {
      const rows = this.db
        .prepare("SELECT * FROM approvals WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
        .all(agentId, clampLimit(limit), safeOffset);
      return rows.map((r) => rowToApprovalRecord(r as unknown as ApprovalRow));
    }
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(agentId, status, clampLimit(limit), safeOffset);
    return rows.map((r) => rowToApprovalRecord(r as unknown as ApprovalRow));
  }

  async listByStatus(agentId: string, status: string, limit = 50, offset = 0): Promise<ApprovalRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM approvals WHERE agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
      )
      .all(agentId, status, clampLimit(limit), clampOffset(offset));
    return rows.map((r) => rowToApprovalRecord(r as unknown as ApprovalRow));
  }

  async listAll(limit = 50, offset = 0): Promise<ApprovalRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(clampLimit(limit), clampOffset(offset));
    return rows.map((r) => rowToApprovalRecord(r as unknown as ApprovalRow));
  }

  async listByOwner(ownerId: string, limit = 50, offset = 0, status?: string): Promise<ApprovalRecord[]> {
    const safeOffset = clampOffset(offset);
    if (status === undefined) {
      const rows = this.db
        .prepare("SELECT * FROM approvals WHERE owner_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
        .all(ownerId, clampLimit(limit), safeOffset);
      return rows.map((r) => rowToApprovalRecord(r as unknown as ApprovalRow));
    }
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE owner_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(ownerId, status, clampLimit(limit), safeOffset);
    return rows.map((r) => rowToApprovalRecord(r as unknown as ApprovalRow));
  }

  async countByOwner(ownerId: string, status?: string): Promise<number> {
    const row =
      status === undefined
        ? this.db
            .prepare("SELECT COUNT(*) AS count FROM approvals WHERE owner_id = ?")
            .get(ownerId)
        : this.db
            .prepare("SELECT COUNT(*) AS count FROM approvals WHERE owner_id = ? AND status = ?")
            .get(ownerId, status);
    return Number((row as unknown as { count: number | bigint }).count);
  }

  async getForOwner(id: string, ownerId: string): Promise<ApprovalRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE id = ? AND owner_id = ?")
      .get(id, ownerId);
    return row ? rowToApprovalRecord(row as unknown as ApprovalRow) : null;
  }

  async update(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    await this.record(updated);
    return updated;
  }

  close(): void {
    // Shared connection — managed by closeSharedConnection() / closeAllSharedConnections()
  }
}

// ============================================================
// Row types + conversion functions
// ============================================================

interface ActivityRow {
  id: string;
  agent_id: string;
  owner_id: string;
  idempotency_key: string | null;
  intent_json: string;
  policy_decision_json: string;
  authorization_status: string | null;
  simulation_result_json: string | null;
  tx_hash: string | null;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface ApprovalRow {
  id: string;
  activity_id: string;
  agent_id: string;
  owner_id: string;
  intent_json: string;
  policy_decision_json: string;
  status: string;
  requested_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  expired_at: string | null;
  approver: string | null;
  expires_at: string | null;
  tx_hash: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToActivityRecord(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    ownerId: row.owner_id,
    idempotencyKey: row.idempotency_key,
    intent: JSON.parse(row.intent_json) as AgentIntent,
    policyDecision: JSON.parse(row.policy_decision_json) as PolicyDecision,
    authorizationStatus: row.authorization_status as AuthorizationStatus | null,
    simulationResult: row.simulation_result_json
      ? (JSON.parse(row.simulation_result_json) as SimulationResult)
      : null,
    txHash: row.tx_hash,
    status: row.status as ActivityRecord["status"],
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToApprovalRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    activityId: row.activity_id,
    agentId: row.agent_id,
    ownerId: row.owner_id,
    intent: JSON.parse(row.intent_json) as AgentIntent,
    policyDecision: JSON.parse(row.policy_decision_json) as PolicyDecision,
    status: row.status as ApprovalStatus,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    expiredAt: row.expired_at,
    approver: row.approver,
    expiresAt: row.expires_at,
    txHash: row.tx_hash,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
