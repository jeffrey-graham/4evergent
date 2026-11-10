import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import type { Signer } from "@4evergent/stellar";
import type { PolicyRules } from "@4evergent/shared";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";

// NOTE: approval integration tests must not call the live Horizon network.
// We test only the persistence + state-machine + idempotency behavior.
// The async execution after approval uses a local stub account (no network).

// NOTE: approval integration tests use deterministic mocks and in-process
// HTTP servers. They do NOT call the live Stellar testnet.

class MockSigner implements Signer {
  private id: string;
  constructor(id: string) {
    this.id = id.startsWith("G") ? id : `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string { return this.id; }
  getNetworkPassphrase(): string { return "Test SDF Network ; September 2015"; }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [{ hint: Buffer.from("mock"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

const TEST_AGENT = {
  id: "test-agent",
  displayName: "Test",
  description: "test agent",
  ownerId: "test",
  stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  capabilities: [],
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  active: true,
  metadata: {},
};

async function startServer(opts?: { policyRules?: Partial<PolicyRules>; signer?: Signer; deferExecution?: boolean }) {
  const signer = opts?.signer ?? new MockSigner("test-agent");
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer,
    policyRules: opts?.policyRules,
    deferExecution: opts?.deferExecution,
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
  });
  server.registerAgent(TEST_AGENT);

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    store: typeof server.store;
    approvals: typeof server.approvals;
  }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        store: server.store,
        approvals: server.approvals,
      });
    });
  });
}

async function post(baseUrl: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ===== Approval flow lifecycle =====

test("approval: submit intent requiring approval → 202 pending_approval", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, store, approvals } = await startServer({ policyRules: rules });
  try {
    const res = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "approval flow test",
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.status, "requires_approval");
    assert.ok(res.body.approvalId, "approvalId must be returned");
    assert.ok(res.body.activityId, "activityId must be returned");

    // Activity persisted with requires_approval status
    const activity = await store.get(res.body.activityId);
    assert.ok(activity);
    assert.equal(activity!.status, "requires_approval");
    assert.equal(activity!.authorizationStatus, "pending_approval");

    // Approval persisted
    const approval = await approvals.get(res.body.approvalId);
    assert.ok(approval);
    assert.equal(approval!.status, "pending_approval");
  } finally {
    await close();
  }
});

test("approval: approve valid approval → 200 approved (async execution)", async () => {
  // NOTE: approve endpoint marks the approval as "approved" and kicks off
  // execution asynchronously. The HTTP response returns "approved" immediately.
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, approvals } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "approval approve test",
    });
    assert.equal(intentRes.status, 202);

    // Approve
    const approveRes = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "tester" });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.status, "approved");
    assert.ok(approveRes.body.message.includes("queued"));

    // Verify approval persisted as approved
    const approval = await approvals.get(intentRes.body.approvalId);
    assert.ok(approval);
    assert.equal(approval!.status, "approved");
    // Phase 28K-2: approver comes from authenticated identity (no client spoofing).
    // DevAuthProvider returns subject="dev-user", so approver is "dev-user".
    assert.equal(approval!.approver, "dev-user");
    assert.ok(approval!.approvedAt);
  } finally {
    await close();
  }
});

test("approval: second approve is rejected (idempotent — no double submission)", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, approvals } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "double approve test",
    });

    // First approve → 200
    const firstApprove = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "tester1" });
    assert.equal(firstApprove.status, 200);

    // Second approve → 409 conflict (already approved, cannot approve again)
    const secondApprove = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "tester2" });
    assert.equal(secondApprove.status, 409);
    assert.match(secondApprove.body.message, /cannot approve/);

    // Verify still approved (not double-executed)
    const approval = await approvals.get(intentRes.body.approvalId);
    assert.equal(approval!.status, "approved");
  } finally {
    await close();
  }
});

test("approval: reject nonexistent approval → 404", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await post(baseUrl, "/approvals/nonexistent-id/approve", {});
    assert.equal(res.status, 404);
    assert.equal(res.body.status, "rejected");
    assert.match(res.body.message, /not found/);
  } finally {
    await close();
  }
});

test("approval: reject already-approved approval → 409", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "approve then reject test",
    });

    // Approve first
    const approve = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "tester" });
    assert.equal(approve.status, 200);

    // Now try to reject → must fail (409 conflict)
    const reject = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/reject`, {});
    assert.equal(reject.status, 409);
    assert.match(reject.body.message, /cannot reject/);
  } finally {
    await close();
  }
});

test("approval: reject valid pending approval → 200 rejected", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, approvals } = await startServer({ policyRules: rules });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "reject flow test",
    });
    assert.equal(intentRes.status, 202);

    const reject = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/reject`, {});
    assert.equal(reject.status, 200);
    assert.equal(reject.body.status, "rejected");

    const approval = await approvals.get(intentRes.body.approvalId);
    assert.ok(approval);
    assert.equal(approval!.status, "rejected");
    assert.ok(approval!.rejectedAt);
  } finally {
    await close();
  }
});

test("approval: approve endpoint rejects raw XDR injection", async () => {
  const rules: Partial<PolicyRules> = {
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "xdr injection test",
    });
    assert.equal(intentRes.status, 202);

    const res = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, {
      xdr: "AAAAAgAAAAA=",
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /raw XDR/);
  } finally {
    await close();
  }
});

test("approval: reject endpoint rejects raw XDR injection", async () => {
  const rules: Partial<PolicyRules> = {
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "xdr reject injection test",
    });
    assert.equal(intentRes.status, 202);

    const res = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/reject`, {
      xdr: "AAAAAgAAAAA=",
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /raw XDR/);
  } finally {
    await close();
  }
});

test("approval: approve approval belonging to other agent — current impl allows (no cross-agent guard yet)", async () => {
  // LIMITATION: Phase 3 does not enforce cross-agent approval ownership.
  // A future phase will add agent-scoped approval access control.
  // This test documents the current behavior.
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "cross-agent test",
    });
    assert.equal(intentRes.status, 202);

    // Anyone with the approvalId can approve — this is a known limitation
    const approve = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "anonymous" });
    assert.equal(approve.status, 200);
  } finally {
    await close();
  }
});

test("approval does not leak secrets in response", async () => {
  const rules: Partial<PolicyRules> = {
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "check privacy",
    });
    const approveRes = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "tester" });
    const json = JSON.stringify(intentRes) + JSON.stringify(approveRes);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

test("approval: policy tightened via PUT /agents/:id/policy before approve denies execution with policy message (#56)", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "100" },
    dailySpendingLimit: { XLM: "500" },
    allowedAssets: ["XLM"],
    approvalThreshold: "10",
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, approvals } = await startServer({ policyRules: rules, deferExecution: false });
  try {
    // 1. Submit an intent for 50 XLM that passes initial policy (<= 100 XLM) and requires approval (> 10 XLM)
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "policy re-evaluation test",
    });
    assert.equal(intentRes.status, 202);
    assert.equal(intentRes.body.status, "requires_approval");
    const approvalId = intentRes.body.approvalId as string;
    assert.ok(approvalId);

    // 2. Tighten the agent policy via PUT /agents/:id/policy so maxTxAmount is now 20 XLM (< 50 XLM)
    const policyRes = await fetch(`${baseUrl}/agents/test-agent/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maxTxAmount: { XLM: "20" },
        dailySpendingLimit: { XLM: "500" },
        allowedAssets: ["XLM"],
        allowedDestinations: [],
        allowedContractIds: [],
        txTypeRestrictions: {
          payment: true,
          trustline: true,
          contract_call: false,
          account_settings: false,
        },
        approvalThreshold: "10",
        requireHumanApprovalForAmountAbove: "10",
      }),
    });
    assert.equal(policyRes.status, 200);

    // 3. Approve the pending intent
    const approveRes = await post(baseUrl, `/approvals/${approvalId}/approve`, { approver: "tester" });
    assert.equal(approveRes.status, 200);

    // 4. Wait for async executeApproved() to complete and assert it was denied by policy (not simulation or network error)
    let updated = await approvals.get(approvalId);
    for (let i = 0; i < 30 && updated?.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      updated = await approvals.get(approvalId);
    }

    assert.ok(updated, "approval record must exist");
    assert.equal(updated!.status, "failed");
    assert.ok(updated!.error, "approval error must be recorded");
    assert.match(updated!.error!, /Policy re-evaluation denied:.*exceeds max tx limit/i);
    assert.doesNotMatch(updated!.error!, /Simulation failed|Cannot load source account|network/i);
  } finally {
    await close();
  }
});
