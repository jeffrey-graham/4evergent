/**
 * CLI behavior tests — mock fetch, invoke command handlers via spawned CLI.
 *
 * The CLI reads FOREGENT_API_URL / FOREGENT_API_KEY at module load; each
 * test sets env + mocks global fetch, then spawns `tsx src/cli.ts <args>`
 * as a child process and asserts stdout/stderr/exit code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// Resolve the tsx CLI entry point directly so we can spawn `node tsx/cli`
// instead of `npx tsx`, which goes through a .ps1 wrapper that fails under
// restricted PowerShell execution policies on Windows.
const _require = createRequire(import.meta.url);
const TSX_BIN = _require.resolve("tsx/cli");

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const PACKAGE_VERSION = _require("../package.json").version as string;

interface CapturedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  requests: CapturedRequest[];
}

function run(
  args: string[],
  opts: {
    env?: Record<string, string>;
    responses?: Array<{ match: string; status: number; body: any }>;
    networkFail?: boolean;
    hang?: boolean;
    real?: boolean;
  } = {}
): RunResult {
  const responses = opts.responses ?? [];
  const requestsPath = CLI.replace(/\.ts$/, ".mock-requests.json");
  // Inline mock server: intercepts fetch inside the child process before CLI runs.
  let prelude: string;
  if (opts.real) {
    // No interception at all: the CLI uses Node's real fetch, so it can be
    // pointed at an actual TCP listener (used by the real-socket timeout test).
    prelude = "";
  } else if (opts.networkFail) {
    prelude = `
    globalThis.fetch = async () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:9");
      (err as any).code = "ECONNREFUSED";
      throw err;
    };
  `;
  } else if (opts.hang) {
    // A stub that accepts the connection and never responds. Like real fetch,
    // the mock honours the caller's AbortSignal, so the CLI's own deadline is
    // what ends the wait. A real open socket keeps the event loop alive; the
    // ref'd interval emulates that so the process cannot exit before the
    // (unref'd) timeout fires.
    prelude = `
    globalThis.fetch = (url, init) => new Promise((_resolve, reject) => {
      const keepAlive = setInterval(() => {}, 1000);
      const settle = (reason) => { clearInterval(keepAlive); reject(reason); };
      const signal = init?.signal;
      if (!signal) return; // no deadline -> would hang forever
      if (signal.aborted) { settle(signal.reason); return; }
      signal.addEventListener("abort", () => settle(signal.reason), { once: true });
    });
  `;
  } else {
    prelude = `
    const responses = ${JSON.stringify(responses)};
    const requestsFile = ${JSON.stringify(requestsPath)};
    const captured: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const parsedUrl = new URL(u);
      const reqPath = parsedUrl.pathname + parsedUrl.search;
      const method = String(init?.method ?? "GET").toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const rawBody = typeof init?.body === "string" ? init.body : undefined;
      let parsedBody: any = rawBody;
      if (rawBody !== undefined) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = rawBody;
        }
      }
      captured.push({ method, url: u, path: reqPath, headers, body: parsedBody });
      writeFileSync(requestsFile, JSON.stringify(captured));
      const hit = responses.find((r) => u.includes(r.match));
      if (!hit) return new Response(JSON.stringify({ error: "no mock for " + u }), { status: 500 });
      return new Response(JSON.stringify(hit.body), { status: hit.status });
    };
  `;
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    FOREGENT_API_URL: "http://mock:3000",
    ...opts.env,
    TSX_CLI_MOCK_PRELUDE: prelude,
  };
  // The request timeout must be explicit per test: never inherit it from the
  // outer environment, so "unset" really means the CLI default.
  if (!(opts.env && "FOREGENT_API_TIMEOUT_MS" in opts.env)) {
    delete env.FOREGENT_API_TIMEOUT_MS;
  }

  // tsx doesn't support --require preambles; use a wrapper instead.
  // On Windows, Node's ESM loader requires file:// URLs for absolute paths
  // inside dynamic import() calls, but tsx itself takes a plain file path.
  const cliUrl = pathToFileURL(CLI).href;
  const wrapper = `
    import { writeFileSync } from "node:fs";
    ${prelude}
    await import(${JSON.stringify(cliUrl)});
  `;
  const wrapperPath = CLI.replace(/\.ts$/, ".mock-wrapper.mts");
  rmSync(requestsPath, { force: true });
  writeFileSync(wrapperPath, wrapper);
  try {
    const r = spawnSync(process.execPath, [TSX_BIN, wrapperPath, ...args], {
      encoding: "utf-8",
      env,
      cwd: path.dirname(CLI),
      timeout: 30000,
    });
    let requests: CapturedRequest[] = [];
    try {
      requests = JSON.parse(readFileSync(requestsPath, "utf-8"));
    } catch {
      requests = [];
    }
    return {
      code: r.status ?? 1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      requests,
    };
  } finally {
    rmSync(wrapperPath, { force: true });
    rmSync(requestsPath, { force: true });
  }
}

for (const flag of ["--version", "-v"]) {
  test(`CLI: ${flag} prints the package version without contacting the API`, () => {
    const r = run([flag], { networkFail: true });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `${PACKAGE_VERSION}\n`);
    assert.equal(r.stderr, "");
  });
}

test("CLI: help documents both version flags", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--version/);
  assert.match(r.stdout, /-v/);
});

test("CLI: health success → exit 0, prints status", () => {
  const r = run(["health"], {
    responses: [{ match: "/health", status: 200, body: { status: "ok", signerAccountId: "GBDMPFEAZOQW7XVTAVPXBT7PPA4ZZW7ZFJW5KJNBYRPJ35H6ASW4ASE3" } }],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /healthy/);
  assert.match(r.stdout, /GBDMPFEAZOQW/);
});

test("CLI: health failure (network error) → exit non-zero", () => {
  const r = run(["health"], {
    networkFail: true,
  });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Health check failed|Cannot connect/);
});

test("CLI: agent list → prints agents", () => {
  const r = run(["agent", "list"], {
    responses: [
      { match: "/agents", status: 200, body: { agents: [{ id: "agent-1", displayName: "Test Agent", active: true, createdAt: "2026-01-01T00:00:00Z" }] } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /agent-1/);
  assert.match(r.stdout, /Test Agent/);
  assert.match(r.stdout, /active/);
});

test("CLI: agent get → prints details", () => {
  const r = run(["agent", "get", "agent-1"], {
    responses: [
      { match: "/agents/agent-1", status: 200, body: { id: "agent-1", displayName: "Test Agent", status: "active", ownerId: "owner-1", stellarAddress: "GAAA", createdAt: "2026-01-01T00:00:00Z" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /agent-1/);
  assert.match(r.stdout, /Test Agent/);
  assert.match(r.stdout, /active/);
});

test("CLI: agent pause → PATCH status=paused", () => {
  const _requestBody: any = null;
  const r = run(["agent", "pause", "agent-1"], {
    responses: [
      { match: "/agents/agent-1/status", status: 200, body: { id: "agent-1", status: "paused" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /paused/);
});

test("CLI: agent resume → status=active", () => {
  const r = run(["agent", "resume", "agent-1"], {
    responses: [
      { match: "/agents/agent-1/status", status: 200, body: { id: "agent-1", status: "active" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /active/);
});

test("CLI: agent disable → status=disabled", () => {
  const r = run(["agent", "disable", "agent-1"], {
    responses: [
      { match: "/agents/agent-1/status", status: 200, body: { id: "agent-1", status: "disabled" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /disabled/);
});

test("CLI: approval list → prints approvals", () => {
  const r = run(["approval", "list"], {
    responses: [
      { match: "/approvals", status: 200, body: { approvals: [{ id: "ap-123", agentId: "agent-1", activityId: "act-1", status: "pending_approval", createdAt: "2026-01-01T00:00:00Z" }] } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /ap-123/);
  assert.match(r.stdout, /pending_approval/);
});

test("CLI: approval approve → exit 0", () => {
  const r = run(["approval", "approve", "ap-1"], {
    responses: [
      { match: "/approvals/ap-1/approve", status: 200, body: { approvalId: "ap-1", activityId: "act-1", status: "approved", message: "approval accepted; transaction queued for execution" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /approved/);
});

test("CLI: approval reject → exit 0", () => {
  const r = run(["approval", "reject", "ap-1"], {
    responses: [
      { match: "/approvals/ap-1/reject", status: 200, body: { approvalId: "ap-1", activityId: "act-1", status: "rejected", message: "approval rejected" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /rejected/);
});

test("CLI: approval get → calls GET /approvals/:id and prints decision fields", () => {
  const r = run(["approval", "get", "ap-1"], {
    responses: [
      {
        match: "/approvals/ap-1",
        status: 200,
        body: {
          approval: {
            id: "ap-1",
            status: "pending_approval",
            intent: { type: "payment", amount: "500", asset: "XLM", destination: "GDEST" },
            policyDecision: { result: "requires_approval", reason: "above threshold", rule: "approvalThreshold" },
            requesterId: "agent-1",
            approverId: null,
            expiresAt: "2026-01-01T01:00:00Z",
            activityId: "act-1",
          },
        },
      },
    ],
  });
  assert.equal(r.code, 0);
  assert.equal(r.requests[0]?.method, "GET");
  assert.equal(r.requests[0]?.path, "/approvals/ap-1");
  assert.match(r.stdout, /ap-1/);
  assert.match(r.stdout, /pending_approval/);
  assert.match(r.stdout, /payment/);
  assert.match(r.stdout, /500/);
  assert.match(r.stdout, /GDEST/);
  assert.match(r.stdout, /approvalThreshold/);
  assert.match(r.stdout, /2026-01-01T01:00:00Z/);
  assert.match(r.stdout, /act-1/);
});

test("CLI: approval get without id → usage on stderr, exit 1", () => {
  const r = run(["approval", "get"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /approval get <id>/);
});

test("CLI: approval get 404 → exit 1 with clear message", () => {
  const r = run(["approval", "get", "nope"], {
    responses: [{ match: "/approvals/nope", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
  assert.match(r.stderr, /not found/);
});

test("CLI: execution list → calls GET /executions (N+1 removed)", () => {
  const r = run(["execution", "list"], {
    responses: [
      { match: "/executions", status: 200, body: { executions: [{ id: "exec-1", agentId: "agent-1", status: "confirmed", txHash: "ab".repeat(32), attempt: 0, createdAt: "2026-01-01T00:00:00Z", intent: { type: "payment", asset: "XLM", amount: "10" } }] } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /exec-1/);
  assert.match(r.stdout, /confirmed/);
  // Must NOT have called /agents or per-agent execution endpoints
  assert.ok(!r.stdout.includes('aggregates'));
});

test("CLI: execution list → empty result", () => {
  const r = run(["execution", "list"], {
    responses: [
      { match: "/executions", status: 200, body: { executions: [] } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /No executions found/);
});

test("CLI: execution list → limit passed as query param", () => {
  const r = run(["execution", "list"], {
    responses: [
      { match: "/executions?limit=100", status: 200, body: { executions: [] } },
    ],
  });
  assert.equal(r.code, 0);
});

test("CLI: execution list → API error → exit 1", () => {
  const r = run(["execution", "list"], {
    responses: [{ match: "/executions", status: 500, body: { error: "server error" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /500|server error/);
});

test("CLI: execution get → prints full detail", () => {
  const r = run(["execution", "get", "exec-1"], {
    responses: [
      { match: "/executions/exec-1", status: 200, body: { execution: { id: "exec-1", agentId: "agent-1", status: "confirmed", txHash: "ab".repeat(32), attempt: 1, error: null, startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z", createdAt: "2026-01-01T00:00:00Z", intent: { type: "payment", asset: "XLM", amount: "10" } } } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /exec-1/);
  assert.match(r.stdout, /confirmed/);
  assert.match(r.stdout, /TxHash/);
});

test("CLI: HTTP 401 → exit 401, prints error", () => {
  const r = run(["agent", "list"], {
    responses: [{ match: "/agents", status: 401, body: { error: "unauthorized" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /401/);
  assert.match(r.stderr, /unauthorized/);
});

// ===== Execution retry / cancel CLI tests =====

test("CLI: execution retry → correct POST route, exit 0", () => {
  const r = run(["execution", "retry", "exec-1"], {
    responses: [{ match: "/executions/exec-1/retry", status: 200, body: { execution: { id: "exec-1", status: "queued" }, message: "execution queued for retry" } }],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /exec-1/);
  assert.match(r.stdout, /retry queued/);
});

test("CLI: execution retry → 404 → exit 1", () => {
  const r = run(["execution", "retry", "nope"], {
    responses: [{ match: "/executions/nope/retry", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
});

test("CLI: execution retry → 409 → exit 1", () => {
  const r = run(["execution", "retry", "exec-1"], {
    responses: [{ match: "/executions/exec-1/retry", status: 409, body: { error: "cannot retry execution in status 'confirmed'" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /409/);
});

test("CLI: execution cancel → correct POST route, exit 0", () => {
  const r = run(["execution", "cancel", "exec-1"], {
    responses: [{ match: "/executions/exec-1/cancel", status: 200, body: { execution: { id: "exec-1", status: "cancelled" }, message: "execution cancelled" } }],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /exec-1/);
  assert.match(r.stdout, /cancelled/);
});

test("CLI: execution cancel → 404 → exit 1", () => {
  const r = run(["execution", "cancel", "nope"], {
    responses: [{ match: "/executions/nope/cancel", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
});

test("CLI: execution cancel → 409 → exit 1", () => {
  const r = run(["execution", "cancel", "exec-1"], {
    responses: [{ match: "/executions/exec-1/cancel", status: 409, body: { error: "cannot cancel execution in status 'failed'" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /409/);
});

test("CLI: execution retry/cancel API key never appears in output", () => {
  const r = run(["execution", "retry", "exec-1"], {
    env: { FOREGENT_API_KEY: "«redacted:sk-…»" },
    responses: [{ match: "/executions/exec-1/retry", status: 200, body: { execution: { id: "exec-1" }, message: "ok" } }],
  });
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes("«redacted:sk-…»"));
  assert.ok(!r.stderr.includes("«redacted:sk-…»"));
});

test("CLI: HTTP 409 conflict on execution retry → exit 1", () => {
  const r = run(["execution", "retry", "exec-1"], {
    responses: [{ match: "/executions/exec-1/retry", status: 409, body: { error: "max retry attempts reached" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /409/);
});

test("CLI: HTTP 404 → exit 404", () => {
  const r = run(["agent", "get", "nope"], {
    responses: [{ match: "/agents/nope", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
  assert.match(r.stderr, /not found/);
});

test("CLI: HTTP 409 → exit 409", () => {
  const r = run(["agent", "pause", "agent-1"], {
    responses: [{ match: "/agents/agent-1/status", status: 409, body: { error: "conflict" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /409/);
});

test("CLI: network failure → exit non-zero, no secret leak", () => {
  const r = run(["agent", "list"], {
    networkFail: true,
  });
  assert.notEqual(r.code, 0);
});

test("CLI: API key never appears in output", () => {
  const r = run(["health"], {
    env: { FOREGENT_API_KEY: "sk-super-secret-key-abc123" },
    responses: [{ match: "/health", status: 200, body: { status: "ok", signerAccountId: "GTEST" } }],
  });
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes("sk-super-secret-key-abc123"));
  assert.ok(!r.stderr.includes("sk-super-secret-key-abc123"));
});

test("CLI: API key sent as Bearer header", () => {
  // The prelude can capture headers; verify indirectly via stderr absence of key.
  const r = run(["agent", "list"], {
    env: { FOREGENT_API_KEY: "sk-another-secret" },
    responses: [{ match: "/agents", status: 200, body: { agents: [] } }],
  });
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes("sk-another-secret"));
  assert.ok(!r.stderr.includes("sk-another-secret"));
});

test("CLI: unknown command → exit 1", () => {
  const r = run(["nonsense"]);
  assert.equal(r.code, 1);
});

test("CLI: no command → usage, exit 1", () => {
  const r = run([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage/);
});

// ===== Phase 2: policy / activity / schedule / intent =====

test("CLI v2: policy get → prints rules", () => {
  const r = run(["policy", "get", "agent-1"], {
    responses: [
      { match: "/agents/agent-1/policy", status: 200, body: { agentId: "agent-1", policy: { maxTxAmount: { XLM: "1000" }, allowedAssets: ["XLM"], approvalThreshold: "10" }, version: 2, updatedAt: "2026-01-01T00:00:00Z" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /agent-1/);
  assert.match(r.stdout, /Version:\s+2/);
  assert.match(r.stdout, /XLM/);
  assert.match(r.stdout, /1000/);
});

test("CLI v2: policy get 404 → exit 1", () => {
  const r = run(["policy", "get", "nope"], {
    responses: [{ match: "/agents/nope/policy", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
});

test("CLI v2: policy get 401 → exit 1", () => {
  const r = run(["policy", "get", "agent-1"], {
    responses: [{ match: "/agents/agent-1/policy", status: 401, body: { error: "unauthorized" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /401/);
});

test("CLI v2: activity list → prints activity", () => {
  const r = run(["activity", "list", "agent-1"], {
    responses: [
      { match: "/agents/agent-1/activity", status: 200, body: { agentId: "agent-1", activity: [{ id: "act-1", agentId: "agent-1", intent: { type: "payment", amount: "10", asset: "XLM" }, status: "requires_approval", txHash: null, error: null, createdAt: "2026-01-01T00:00:00Z" }] } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /act-1/);
  assert.match(r.stdout, /requires_approval/);
});

test("CLI v2: activity list with limit → passes query param", () => {
  const r = run(["activity", "list", "agent-1", "5"], {
    responses: [
      { match: "/agents/agent-1/activity?limit=5", status: 200, body: { agentId: "agent-1", activity: [] } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /No activity found/);
});

test("CLI v2: activity list 404 → exit 1", () => {
  const r = run(["activity", "list", "nope"], {
    responses: [{ match: "/agents/nope/activity", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
});

test("CLI v2: activity get → prints formatted activity detail", () => {
  const r = run(["activity", "get", "agent-1", "act-1"], {
    responses: [
      { match: "/agents/agent-1/activity/act-1", status: 200, body: { activity: { id: "act-1", agentId: "agent-1", intent: { type: "payment", amount: "10", asset: "XLM" }, status: "confirmed", txHash: "abc123", error: null, createdAt: "2026-01-01T00:00:00Z" } } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Activity:/);
  assert.match(r.stdout, /ID:\s+act-1/);
  assert.match(r.stdout, /Type:\s+payment/);
  assert.match(r.stdout, /Amount:\s+10 XLM/);
  assert.match(r.stdout, /Status:\s+confirmed/);
  assert.match(r.stdout, /TxHash:\s+abc123/);
});

test("CLI v2: activity get encodes path identifiers", () => {
  const r = run(["activity", "get", "agent/one", "act one"], {
    responses: [
      { match: "/agents/agent%2Fone/activity/act%20one", status: 200, body: { activity: { id: "act one", agentId: "agent/one", status: "queued", createdAt: "2026-01-01T00:00:00Z" } } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /act one/);
});

test("CLI v2: activity get without both ids shows usage", () => {
  const r = run(["activity", "get", "agent-1"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /activity get <agent-id> <activity-id>/);
});

test("CLI v2: activity get 404 → exit 1", () => {
  const r = run(["activity", "get", "agent-1", "missing"], {
    responses: [{ match: "/agents/agent-1/activity/missing", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
});

test("CLI v2: schedule list → prints schedules", () => {
  const r = run(["schedule", "list", "agent-1"], {
    responses: [
      { match: "/agents/agent-1/schedules", status: 200, body: { agentId: "agent-1", schedules: [{ id: "sch-1", agentId: "agent-1", status: "active", scheduleExpression: "0 * * * *", timezone: "UTC", nextRunAt: "2026-01-01T01:00:00Z", lastRunAt: null, intent: { type: "payment", amount: "5", asset: "XLM" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /sch-1/);
  assert.match(r.stdout, /active/);
  assert.match(r.stdout, /0 \* \* \* \*/);
});

test("CLI v2: schedule list limit → passes query param", () => {
  const r = run(["schedule", "list", "agent-1", "10"], {
    responses: [
      { match: "/agents/agent-1/schedules?limit=10", status: 200, body: { agentId: "agent-1", schedules: [] } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /No schedules found/);
});

test("CLI v2: schedule get → prints full detail", () => {
  const r = run(["schedule", "get", "agent-1", "sch-1"], {
    responses: [
      { match: "/agents/agent-1/schedules/sch-1", status: 200, body: { schedule: { id: "sch-1", agentId: "agent-1", ownerId: "owner-1", status: "active", scheduleExpression: "0 12 * * *", timezone: "UTC", nextRunAt: "2026-01-01T12:00:00Z", lastRunAt: "2026-01-01T00:00:00Z", intent: { type: "payment", asset: "XLM", amount: "5", destination: "GAAA", reason: "daily" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" } } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /sch-1/);
  assert.match(r.stdout, /0 12 \* \* \*/);
  assert.match(r.stdout, /payment/);
});

test("CLI v2: schedule get 404 → exit 1", () => {
  const r = run(["schedule", "get", "agent-1", "nope"], {
    responses: [{ match: "/agents/agent-1/schedules/nope", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
});

test("CLI v2: intent submit payment → 202 accepted", () => {
  const r = run(["intent", "submit", "agent-1", "payment", "XLM", "10", "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "test payment"], {
    responses: [
      { match: "/agents/agent-1/intents", status: 202, body: { activityId: "act-9", agentId: "agent-1", status: "requires_approval", approvalId: "ap-9", policyDecision: { result: "requires_approval", reason: "above threshold", rule: "approval" } } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /accepted/);
  assert.match(r.stdout, /act-9/);
  assert.match(r.stdout, /ap-9/);
});

test("CLI v2: intent submit trustline → 202", () => {
  const r = run(["intent", "submit", "agent-1", "trustline", "USDC", "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "add trustline"], {
    responses: [
      { match: "/agents/agent-1/intents", status: 202, body: { activityId: "act-10", agentId: "agent-1", status: "requires_approval", approvalId: "ap-10" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /act-10/);
});

test("CLI v2: intent submit contract_call → 202", () => {
  const r = run(["intent", "submit", "agent-1", "contract_call", "CABC123", "transfer", '["a","b"]', "call transfer"], {
    responses: [
      { match: "/agents/agent-1/intents", status: 202, body: { activityId: "act-11", agentId: "agent-1", status: "requires_approval", approvalId: "ap-11" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /act-11/);
});

test("CLI v2: intent submit 200 idempotent duplicate", () => {
  const r = run(["intent", "submit", "agent-1", "payment", "XLM", "10", "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "dup", "--idempotency-key", "key-1"], {
    responses: [
      { match: "/agents/agent-1/intents", status: 200, body: { activityId: "act-original", agentId: "agent-1", status: "requires_approval" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /idempotent duplicate/);
  assert.match(r.stdout, /act-original/);
});

test("CLI v2: intent submit 400 validation error", () => {
  const r = run(["intent", "submit", "agent-1", "payment", "XLM", "0", "GAAA", "bad"], {
    responses: [
      { match: "/agents/agent-1/intents", status: 400, body: { error: "Intent validation failed: amount must be positive" } },
    ],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /400/);
  assert.match(r.stderr, /validation/);
});

test("CLI v2: intent submit 403 policy denial", () => {
  const r = run(["intent", "submit", "agent-1", "payment", "XLM", "9999", "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "too big"], {
    responses: [
      { match: "/agents/agent-1/intents", status: 403, body: { activityId: "act-denied", agentId: "agent-1", status: "rejected", policyDecision: { result: "deny", reason: "max tx", rule: "maxTxAmount" } } },
    ],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /403/);
});

test("CLI v2: intent submit 404 agent not found", () => {
  const r = run(["intent", "submit", "nope", "payment", "XLM", "10", "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "x"], {
    responses: [
      { match: "/agents/nope/intents", status: 404, body: { error: "not found" } },
    ],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
});

test("CLI v2: intent submit 409 conflict", () => {
  const r = run(["intent", "submit", "agent-1", "payment", "XLM", "10", "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "x", "--idempotency-key", "key-conflict"], {
    responses: [
      { match: "/agents/agent-1/intents", status: 409, body: { error: "Idempotency-Key already used with a different intent" } },
    ],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /409/);
});

test("CLI v2: intent submit account_settings rejected locally", () => {
  const r = run(["intent", "submit", "agent-1", "account_settings", "setting", "value", "reason"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not supported/);
});

test("CLI v2: intent submit missing args → usage", () => {
  const r = run(["intent", "submit", "agent-1", "payment"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /payment requires/);
});

test("CLI v2: intent submit contract_call invalid args JSON", () => {
  const r = run(["intent", "submit", "agent-1", "contract_call", "CABC", "fn", "not-json", "reason"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /JSON array/);
});

test("CLI v2: intent submit network failure warns about idempotency", () => {
  const r = run(["intent", "submit", "agent-1", "payment", "XLM", "10", "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "x", "--idempotency-key", "key-net"], {
    networkFail: true,
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /UNKNOWN/);
  assert.match(r.stderr, /SAME --idempotency-key/);
});

test("CLI v2: intent submit network failure without key warns duplicate risk", () => {
  const r = run(["intent", "submit", "agent-1", "payment", "XLM", "10", "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "x"], {
    networkFail: true,
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /UNKNOWN/);
  assert.match(r.stderr, /No Idempotency-Key/);
});

// ===== Batch 3: Agent Create =====

test("CLI v3: agent create → POST /agents, exit 0", () => {
  const r = run(["agent", "create", "My Agent", "--description", "test agent"], {
    responses: [
      { match: "/agents", status: 201, body: { agent: { id: "agent-new", displayName: "My Agent", status: "active" } } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /agent-new/);
  assert.match(r.stdout, /My Agent/);
});

test("CLI v3: agent create → no name → exit 1", () => {
  const r = run(["agent", "create"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage/);
});

test("CLI v3: agent create → 400 validation error → exit 1", () => {
  const r = run(["agent", "create", ""], {
    responses: [{ match: "/agents", status: 400, body: { error: "displayName is required" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /400/);
});

test("CLI v3: agent create → 401 → exit 1", () => {
  const r = run(["agent", "create", "My Agent"], {
    responses: [{ match: "/agents", status: 401, body: { error: "unauthorized" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /401/);
});

// ===== Batch 3: Policy Update =====

test("CLI v3: policy update → PUT /agents/:id/policy, exit 0", () => {
  const r = run(["policy", "update", "agent-1", "--rules", '{"maxTxAmount":{"XLM":"1000"}}'], {
    responses: [
      { match: "/agents/agent-1/policy", status: 200, body: { agentId: "agent-1", policy: { maxTxAmount: { XLM: "1000" } }, version: 2 } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /agent-1/);
  assert.match(r.stdout, /Version:\s+2/);
});

test("CLI v3: policy update → missing --rules → exit 1", () => {
  const r = run(["policy", "update", "agent-1"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--rules/);
});

test("CLI v3: policy update → invalid JSON → exit 1", () => {
  const r = run(["policy", "update", "agent-1", "--rules", "not-json"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /valid JSON/);
});

test("CLI v3: policy update → 404 → exit 1", () => {
  const r = run(["policy", "update", "nope", "--rules", '{"maxTxAmount":{"XLM":"1000"}}'], {
    responses: [{ match: "/agents/nope/policy", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
});

// ===== Batch 3: Schedule Create =====

test("CLI v3: schedule create → POST /agents/:id/schedules, exit 0", () => {
  const r = run(["schedule", "create", "agent-1", "0 * * * *", "payment", "XLM", "10", "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "daily"], {
    responses: [
      { match: "/agents/agent-1/schedules", status: 201, body: { schedule: { id: "sch-new", agentId: "agent-1", scheduleExpression: "0 * * * *", timezone: "UTC", nextRunAt: "2026-01-01T01:00:00Z" } } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /sch-new/);
  assert.match(r.stdout, /0 \* \* \* \*/);
});

test("CLI v3: schedule create → no args → exit 1", () => {
  const r = run(["schedule", "create", "agent-1"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage/);
});

test("CLI v3: schedule create → 400 invalid expression → exit 1", () => {
  const r = run(["schedule", "create", "agent-1", "invalid", "payment", "XLM", "10", "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "daily"], {
    responses: [{ match: "/agents/agent-1/schedules", status: 400, body: { error: "schedule expression must have 5 fields" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /400/);
});

test("CLI v3: schedule create → 404 agent → exit 1", () => {
  const r = run(["schedule", "create", "nope", "0 * * * *", "payment", "XLM", "10", "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "daily"], {
    responses: [{ match: "/agents/nope/schedules", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
});

// ===== Batch 3: Schedule Update =====

test("CLI v3: schedule update → PATCH /agents/:id/schedules/:id, exit 0", () => {
  const r = run(["schedule", "update", "agent-1", "sch-1", "0 12 * * *"], {
    responses: [
      { match: "/agents/agent-1/schedules/sch-1", status: 200, body: { schedule: { id: "sch-1", scheduleExpression: "0 12 * * *", nextRunAt: "2026-01-01T12:00:00Z" } } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /0 12 \* \* \*/);
  assert.match(r.stdout, /Next Run/);
});

test("CLI v3: schedule update → missing args → exit 1", () => {
  const r = run(["schedule", "update", "agent-1"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage/);
});

test("CLI v3: schedule update → 404 → exit 1", () => {
  const r = run(["schedule", "update", "agent-1", "nope", "0 12 * * *"], {
    responses: [{ match: "/agents/agent-1/schedules/nope", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
});

// ===== Batch 3: Schedule Pause/Resume/Disable/Delete =====

test("CLI v3: schedule pause → POST /agents/:id/schedules/:id/pause, exit 0", () => {
  const r = run(["schedule", "pause", "agent-1", "sch-1"], {
    responses: [{ match: "/agents/agent-1/schedules/sch-1/pause", status: 200, body: { schedule: { id: "sch-1", status: "paused" } } }],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /paused/);
});

test("CLI v3: schedule pause → 404 → exit 1", () => {
  const r = run(["schedule", "pause", "agent-1", "nope"], {
    responses: [{ match: "/agents/agent-1/schedules/nope/pause", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
});

test("CLI v3: schedule resume → POST /agents/:id/schedules/:id/resume, exit 0", () => {
  const r = run(["schedule", "resume", "agent-1", "sch-1"], {
    responses: [{ match: "/agents/agent-1/schedules/sch-1/resume", status: 200, body: { schedule: { id: "sch-1", status: "active" } } }],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /active/);
});

test("CLI v3: schedule resume → 404 → exit 1", () => {
  const r = run(["schedule", "resume", "agent-1", "nope"], {
    responses: [{ match: "/agents/agent-1/schedules/nope/resume", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
});

test("CLI v3: schedule disable → POST /agents/:id/schedules/:id/disable, exit 0", () => {
  const r = run(["schedule", "disable", "agent-1", "sch-1"], {
    responses: [{ match: "/agents/agent-1/schedules/sch-1/disable", status: 200, body: { schedule: { id: "sch-1", status: "disabled" } } }],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /disabled/);
});

test("CLI v3: schedule disable → 404 → exit 1", () => {
  const r = run(["schedule", "disable", "agent-1", "nope"], {
    responses: [{ match: "/agents/agent-1/schedules/nope/disable", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
});

test("CLI v3: schedule delete → DELETE /agents/:id/schedules/:id, exit 0", () => {
  const r = run(["schedule", "delete", "agent-1", "sch-1"], {
    responses: [{ match: "/agents/agent-1/schedules/sch-1", status: 200, body: { deleted: true } }],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /deleted/);
});

test("CLI v3: schedule delete → 404 → exit 1", () => {
  const r = run(["schedule", "delete", "agent-1", "nope"], {
    responses: [{ match: "/agents/agent-1/schedules/nope", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
});

test("CLI v3: agent create → API key never appears in output", () => {
  const r = run(["agent", "create", "Test"], {
    env: { FOREGENT_API_KEY: "«redacted:sk-…»" },
    responses: [{ match: "/agents", status: 201, body: { agent: { id: "a", displayName: "Test" } } }],
  });
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes("«redacted:sk-…»"));
});

test("CLI: no command → usage lists all eight top-level commands", () => {
  const r = run([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage/);
  assert.match(r.stderr, /policy/);
  assert.match(r.stderr, /activity/);
  assert.match(r.stderr, /schedule/);
  assert.match(r.stderr, /intent/);
});

// ===== #125 Request timeout =====

test("CLI timeout: a stub that never responds exits 3 with the timeout message", () => {
  const r = run(["health"], { hang: true, env: { FOREGENT_API_TIMEOUT_MS: "300" } });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /Request timed out after 300ms/);
  assert.match(r.stderr, /did not respond/);
  // Distinct from the connection-refused and HTTP-error failure modes.
  assert.doesNotMatch(r.stderr, /Cannot connect/);
});

test("CLI timeout: the default (5000ms) applies when the override is unset", () => {
  const r = run(["health"], { hang: true });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /Request timed out after 5000ms/);
});

test("CLI timeout: exit code 3 is distinguishable from connection-refused and HTTP errors", () => {
  const refused = run(["health"], { networkFail: true });
  assert.equal(refused.code, 1);
  assert.doesNotMatch(refused.stderr, /timed out/);

  const httpError = run(["health"], {
    responses: [{ match: "/health", status: 500, body: { error: "server error" } }],
  });
  assert.equal(httpError.code, 1);
  assert.doesNotMatch(httpError.stderr, /timed out/);
});

test("CLI timeout: a normal response is unaffected by the deadline", () => {
  const r = run(["health"], {
    env: { FOREGENT_API_TIMEOUT_MS: "1234" },
    responses: [
      { match: "/health", status: 200, body: { status: "ok", signerAccountId: "GTEST" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /healthy/);
});

test("CLI timeout: a timed-out intent submit keeps the UNKNOWN / idempotency warning", () => {
  const r = run(
    ["intent", "submit", "agent-1", "payment", "XLM", "10", "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "x", "--idempotency-key", "key-timeout"],
    { hang: true, env: { FOREGENT_API_TIMEOUT_MS: "300" } }
  );
  assert.equal(r.code, 3);
  assert.match(r.stderr, /timed out/);
  assert.match(r.stderr, /UNKNOWN/);
  assert.match(r.stderr, /SAME --idempotency-key/);
});

test("CLI timeout: an invalid override warns and falls back to the default", () => {
  const r = run(["health"], {
    env: { FOREGENT_API_TIMEOUT_MS: "not-a-number" },
    responses: [
      { match: "/health", status: 200, body: { status: "ok", signerAccountId: "GTEST" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /Ignoring invalid FOREGENT_API_TIMEOUT_MS/);
  assert.match(r.stderr, /using default 5000ms/);
});

test("CLI timeout: a real listener that accepts but never responds exits 3", async () => {
  // Mirrors the acceptance scenario with a real socket, so Node's own fetch
  // (not the mock) is what trips the deadline.
  const server = net.createServer(() => {
    /* accept the connection, never write a response */
  });
  // Do not let the listener keep the test runner alive; the closing below is
  // best-effort and not awaited (a queued, never-accepted connection can make
  // close() linger on some platforms).
  server.unref();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const r = run(["health"], {
      real: true,
      env: {
        FOREGENT_API_URL: `http://127.0.0.1:${port}`,
        FOREGENT_API_TIMEOUT_MS: "400",
      },
    });
    assert.equal(r.code, 3, `code=${r.code} stderr=${JSON.stringify(r.stderr)} stdout=${JSON.stringify(r.stdout)}`);
    assert.match(r.stderr, /Request timed out after 400ms/);
  } finally {
    server.close();
  }
});

// ===== Direct unit & handler request coverage (#46) =====

interface CliHandlersModule {
  buildIntentArgs: (args: string[]) => { intent: any; error?: string };
  cmdPolicyGet: (agentId: string) => Promise<number>;
  cmdActivityList: (agentId: string, limit: string) => Promise<number>;
  cmdScheduleList: (agentId: string, limit: string) => Promise<number>;
  cmdScheduleGet: (agentId: string, scheduleId: string) => Promise<number>;
  cmdIntentSubmit: (agentId: string, args: string[], idempotencyKey: string | null) => Promise<number>;
  cmdAgentCreate: (args: string[]) => Promise<number>;
  cmdPolicyUpdate: (agentId: string, args: string[]) => Promise<number>;
  cmdScheduleCreate: (agentId: string, args: string[]) => Promise<number>;
  cmdScheduleUpdate: (agentId: string, args: string[]) => Promise<number>;
  cmdSchedulePause: (agentId: string, scheduleId: string) => Promise<number>;
  cmdScheduleResume: (agentId: string, scheduleId: string) => Promise<number>;
  cmdScheduleDisable: (agentId: string, scheduleId: string) => Promise<number>;
  cmdScheduleDelete: (agentId: string, scheduleId: string) => Promise<number>;
  cmdApprovalGet: (id: string) => Promise<number>;
}

let cachedHandlersPromise: Promise<CliHandlersModule> | null = null;

function loadCliHandlers(): Promise<CliHandlersModule> {
  if (!cachedHandlersPromise) {
    cachedHandlersPromise = (async () => {
      const cliSource = readFileSync(CLI, "utf-8").replace(
        /main\(\)\.then\([\s\S]*$/,
        `export {
  buildIntentArgs,
  cmdPolicyGet,
  cmdActivityList,
  cmdScheduleList,
  cmdScheduleGet,
  cmdIntentSubmit,
  cmdAgentCreate,
  cmdPolicyUpdate,
  cmdScheduleCreate,
  cmdScheduleUpdate,
  cmdSchedulePause,
  cmdScheduleResume,
  cmdScheduleDisable,
  cmdScheduleDelete,
  cmdApprovalGet,
};\n`
      );
      const unitWrapperPath = CLI.replace(/\.ts$/, ".unit-wrapper.mts");
      writeFileSync(unitWrapperPath, cliSource);
      try {
        return (await import(`${pathToFileURL(unitWrapperPath).href}?t=${Date.now()}`)) as CliHandlersModule;
      } finally {
        rmSync(unitWrapperPath, { force: true });
      }
    })();
  }
  return cachedHandlersPromise;
}

async function runHandlerWithMockFetch(
  responses: Array<{ match: string; status: number; body: any }>,
  fn: (mod: CliHandlersModule) => Promise<number>
): Promise<{ code: number; requests: CapturedRequest[]; stdout: string; stderr: string }> {
  const mod = await loadCliHandlers();
  const realFetch = globalThis.fetch;
  const origLog = console.log;
  const origError = console.error;
  const requests: CapturedRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];

  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(" "));
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const parsedUrl = new URL(u);
    const reqPath = parsedUrl.pathname + parsedUrl.search;
    const method = String(init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    let parsedBody: any = rawBody;
    if (rawBody !== undefined) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
    }
    requests.push({ method, url: u, path: reqPath, headers, body: parsedBody });
    const hit = responses.find((r) => u.includes(r.match));
    if (!hit) {
      return new Response(JSON.stringify({ error: "no mock for " + u }), { status: 500 });
    }
    return new Response(JSON.stringify(hit.body), { status: hit.status });
  }) as typeof fetch;

  try {
    const code = await fn(mod);
    return { code, requests, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    globalThis.fetch = realFetch;
    console.log = origLog;
    console.error = origError;
  }
}

test("buildIntentArgs: payment happy path (with and without memo) and missing-args error", async () => {
  const { buildIntentArgs } = await loadCliHandlers();

  const withoutMemo = buildIntentArgs(["payment", "XLM", "25", "GDEST", "invoice-1"]);
  assert.equal(withoutMemo.error, undefined);
  assert.deepEqual(withoutMemo.intent, {
    type: "payment",
    asset: "XLM",
    destination: "GDEST",
    amount: "25",
    reason: "invoice-1",
  });

  const withMemo = buildIntentArgs(["payment", "USDC", "100", "GDEST", "payroll", "memo-42"]);
  assert.equal(withMemo.error, undefined);
  assert.deepEqual(withMemo.intent, {
    type: "payment",
    asset: "USDC",
    destination: "GDEST",
    amount: "100",
    reason: "payroll",
    memo: "memo-42",
  });

  const missingArgs = buildIntentArgs(["payment", "XLM", "25", "GDEST"]);
  assert.equal(missingArgs.intent, null);
  assert.match(missingArgs.error ?? "", /payment requires: <asset> <amount> <destination> <reason> \[memo\]/);
});

test("buildIntentArgs: trustline with and without limit, and missing-args error", async () => {
  const { buildIntentArgs } = await loadCliHandlers();

  const noLimit = buildIntentArgs(["trustline", "USDC", "GISSUER", "enable usdc"]);
  assert.equal(noLimit.error, undefined);
  assert.deepEqual(noLimit.intent, {
    type: "trustline",
    assetCode: "USDC",
    issuer: "GISSUER",
    reason: "enable usdc",
  });
  assert.equal("limit" in noLimit.intent, false);

  const withLimit = buildIntentArgs(["trustline", "USDC", "GISSUER", "enable usdc", "5000"]);
  assert.equal(withLimit.error, undefined);
  assert.deepEqual(withLimit.intent, {
    type: "trustline",
    assetCode: "USDC",
    issuer: "GISSUER",
    reason: "enable usdc",
    limit: "5000",
  });

  const missing = buildIntentArgs(["trustline", "USDC", "GISSUER"]);
  assert.equal(missing.intent, null);
  assert.match(missing.error ?? "", /trustline requires: <assetCode> <issuer> <reason> \[limit\]/);
});

test("buildIntentArgs: contract_call valid JSON array, invalid JSON error, and non-array JSON error", async () => {
  const { buildIntentArgs } = await loadCliHandlers();

  const valid = buildIntentArgs(["contract_call", "CCONTRACT123", "transfer", '["GFROM","GTO",100]', "invoke transfer"]);
  assert.equal(valid.error, undefined);
  assert.deepEqual(valid.intent, {
    type: "contract_call",
    contractId: "CCONTRACT123",
    function: "transfer",
    args: ["GFROM", "GTO", 100],
    reason: "invoke transfer",
  });

  const invalidJson = buildIntentArgs(["contract_call", "CCONTRACT123", "transfer", "{bad-json", "invoke transfer"]);
  assert.equal(invalidJson.intent, null);
  assert.match(invalidJson.error ?? "", /contract_call args must be a valid JSON array/);

  const nonArrayJson = buildIntentArgs(["contract_call", "CCONTRACT123", "transfer", '{"not":"an array"}', "invoke transfer"]);
  assert.equal(nonArrayJson.intent, null);
  assert.match(nonArrayJson.error ?? "", /contract_call args must be a JSON array/);

  const missingContractArgs = buildIntentArgs(["contract_call", "CCONTRACT123", "transfer"]);
  assert.equal(missingContractArgs.intent, null);
  assert.match(missingContractArgs.error ?? "", /contract_call requires/);
});

test("buildIntentArgs: account_settings rejection and unknown/missing type errors", async () => {
  const { buildIntentArgs } = await loadCliHandlers();

  const accountSettings = buildIntentArgs(["account_settings", "set", "value", "reason"]);
  assert.equal(accountSettings.intent, null);
  assert.match(accountSettings.error ?? "", /account_settings is not supported/);

  const unknownType = buildIntentArgs(["swap", "XLM", "USDC"]);
  assert.equal(unknownType.intent, null);
  assert.match(unknownType.error ?? "", /unknown intent type 'swap'/);

  const missingType = buildIntentArgs([]);
  assert.equal(missingType.intent, null);
  assert.match(missingType.error ?? "", /intent type required/);
});

test("cmdPolicyGet and cmdPolicyUpdate: GET and PUT /agents/:id/policy with parsed body", async () => {
  const getRes = await runHandlerWithMockFetch(
    [
      {
        match: "/agents/agent-1/policy",
        status: 200,
        body: { agentId: "agent-1", policy: { maxTxAmount: { XLM: "500" } }, version: 3 },
      },
    ],
    (m) => m.cmdPolicyGet("agent-1")
  );
  assert.equal(getRes.code, 0);
  assert.equal(getRes.requests.length, 1);
  assert.equal(getRes.requests[0]!.method, "GET");
  assert.equal(getRes.requests[0]!.path, "/agents/agent-1/policy");
  assert.equal(getRes.requests[0]!.body, undefined);

  const rulesPayload = { maxTxAmount: { XLM: "1000" }, allowedAssets: ["XLM", "USDC"] };
  const updateRes = await runHandlerWithMockFetch(
    [
      {
        match: "/agents/agent-1/policy",
        status: 200,
        body: { agentId: "agent-1", policy: rulesPayload, version: 4 },
      },
    ],
    (m) => m.cmdPolicyUpdate("agent-1", ["--rules", JSON.stringify(rulesPayload)])
  );
  assert.equal(updateRes.code, 0);
  assert.equal(updateRes.requests.length, 1);
  assert.equal(updateRes.requests[0]!.method, "PUT");
  assert.equal(updateRes.requests[0]!.path, "/agents/agent-1/policy");
  assert.deepEqual(updateRes.requests[0]!.body, rulesPayload);

  // Also verify via spawned CLI harness
  const spawnedUpdate = run(["policy", "update", "agent-1", "--rules", JSON.stringify(rulesPayload)], {
    responses: [{ match: "/agents/agent-1/policy", status: 200, body: { agentId: "agent-1", version: 4 } }],
  });
  assert.equal(spawnedUpdate.code, 0);
  assert.equal(spawnedUpdate.requests[0]?.method, "PUT");
  assert.equal(spawnedUpdate.requests[0]?.path, "/agents/agent-1/policy");
  assert.deepEqual(spawnedUpdate.requests[0]?.body, rulesPayload);
});

test("cmdActivityList: GET /agents/:id/activity?limit= with default and explicit limit", async () => {
  const defaultLimit = await runHandlerWithMockFetch(
    [{ match: "/agents/agent-1/activity?limit=50", status: 200, body: { activity: [] } }],
    (m) => m.cmdActivityList("agent-1", "")
  );
  assert.equal(defaultLimit.code, 0);
  assert.equal(defaultLimit.requests.length, 1);
  assert.equal(defaultLimit.requests[0]!.method, "GET");
  assert.equal(defaultLimit.requests[0]!.path, "/agents/agent-1/activity?limit=50");

  const customLimit = await runHandlerWithMockFetch(
    [{ match: "/agents/agent-1/activity?limit=15", status: 200, body: { activity: [] } }],
    (m) => m.cmdActivityList("agent-1", "15")
  );
  assert.equal(customLimit.code, 0);
  assert.equal(customLimit.requests.length, 1);
  assert.equal(customLimit.requests[0]!.method, "GET");
  assert.equal(customLimit.requests[0]!.path, "/agents/agent-1/activity?limit=15");

  const invalidLimit = await runHandlerWithMockFetch([], (m) => m.cmdActivityList("agent-1", "101"));
  assert.equal(invalidLimit.code, 1);
  assert.equal(invalidLimit.requests.length, 0);
});

test("cmdAgentCreate: POST /agents with parsed displayName, description, capabilities, and stellarAddress", async () => {
  const createRes = await runHandlerWithMockFetch(
    [
      {
        match: "/agents",
        status: 201,
        body: { agent: { id: "agent-created", displayName: "Treasury Bot", status: "active" } },
      },
    ],
    (m) =>
      m.cmdAgentCreate([
        "Treasury Bot",
        "--description",
        "Automated treasury",
        "--capabilities",
        "payment, trustline",
        "--stellar-address",
        "GBDMPFEAZOQW7XVTAVPXBT7PPA4ZZW7ZFJW5KJNBYRPJ35H6ASW4ASE3",
      ])
  );
  assert.equal(createRes.code, 0);
  assert.equal(createRes.requests.length, 1);
  assert.equal(createRes.requests[0]!.method, "POST");
  assert.equal(createRes.requests[0]!.path, "/agents");
  assert.deepEqual(createRes.requests[0]!.body, {
    displayName: "Treasury Bot",
    description: "Automated treasury",
    capabilities: ["payment", "trustline"],
    stellarAddress: "GBDMPFEAZOQW7XVTAVPXBT7PPA4ZZW7ZFJW5KJNBYRPJ35H6ASW4ASE3",
  });
});

test("cmdIntentSubmit: POST /agents/:id/intents with parsed intent body and Idempotency-Key header when supplied", async () => {
  const withKey = await runHandlerWithMockFetch(
    [
      {
        match: "/agents/agent-1/intents",
        status: 202,
        body: { activityId: "act-100", agentId: "agent-1", status: "queued" },
      },
    ],
    (m) =>
      m.cmdIntentSubmit(
        "agent-1",
        ["payment", "XLM", "50", "GDEST", "rebalance", "memo-1", "--idempotency-key", "idem-key-123"],
        null
      )
  );
  assert.equal(withKey.code, 0);
  assert.equal(withKey.requests.length, 1);
  assert.equal(withKey.requests[0]!.method, "POST");
  assert.equal(withKey.requests[0]!.path, "/agents/agent-1/intents");
  assert.equal(withKey.requests[0]!.headers["Idempotency-Key"], "idem-key-123");
  assert.deepEqual(withKey.requests[0]!.body, {
    type: "payment",
    asset: "XLM",
    destination: "GDEST",
    amount: "50",
    reason: "rebalance",
    memo: "memo-1",
  });

  const withoutKey = await runHandlerWithMockFetch(
    [
      {
        match: "/agents/agent-1/intents",
        status: 202,
        body: { activityId: "act-101", agentId: "agent-1", status: "queued" },
      },
    ],
    (m) => m.cmdIntentSubmit("agent-1", ["trustline", "USDC", "GISSUER", "open usdc", "1000"], null)
  );
  assert.equal(withoutKey.code, 0);
  assert.equal(withoutKey.requests.length, 1);
  assert.equal(withoutKey.requests[0]!.method, "POST");
  assert.equal(withoutKey.requests[0]!.path, "/agents/agent-1/intents");
  assert.equal(withoutKey.requests[0]!.headers["Idempotency-Key"], undefined);
  assert.deepEqual(withoutKey.requests[0]!.body, {
    type: "trustline",
    assetCode: "USDC",
    issuer: "GISSUER",
    reason: "open usdc",
    limit: "1000",
  });

  // Also verify spawned CLI request capture for Idempotency-Key
  const spawnedIntent = run(
    ["intent", "submit", "agent-1", "payment", "XLM", "10", "GDEST", "pay", "--idempotency-key", "spawn-idem-1"],
    {
      responses: [
        { match: "/agents/agent-1/intents", status: 202, body: { activityId: "act-102", agentId: "agent-1", status: "queued" } },
      ],
    }
  );
  assert.equal(spawnedIntent.code, 0);
  assert.equal(spawnedIntent.requests[0]?.method, "POST");
  assert.equal(spawnedIntent.requests[0]?.path, "/agents/agent-1/intents");
  assert.equal(spawnedIntent.requests[0]?.headers["Idempotency-Key"], "spawn-idem-1");
});

test("All schedule handlers (cmdScheduleList, cmdScheduleGet, cmdScheduleCreate, cmdScheduleUpdate, cmdSchedulePause, cmdScheduleResume, cmdScheduleDisable, cmdScheduleDelete): routes, methods, and bodies", async () => {
  // Specific route prefixes come before general /schedules match
  const scheduleResponses = [
    { match: "/agents/agent-1/schedules/sch-1/pause", status: 200, body: { schedule: { id: "sch-1", status: "paused" } } },
    { match: "/agents/agent-1/schedules/sch-1/resume", status: 200, body: { schedule: { id: "sch-1", status: "active" } } },
    { match: "/agents/agent-1/schedules/sch-1/disable", status: 200, body: { schedule: { id: "sch-1", status: "disabled" } } },
    {
      match: "/agents/agent-1/schedules/sch-1",
      status: 200,
      body: {
        schedule: {
          id: "sch-1",
          agentId: "agent-1",
          status: "active",
          scheduleExpression: "0 12 * * *",
          timezone: "UTC",
          nextRunAt: "2026-01-01T12:00:00Z",
          lastRunAt: null,
          intent: { type: "payment", asset: "XLM", amount: "10", destination: "GDEST", reason: "daily" },
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    },
    {
      match: "/agents/agent-1/schedules?limit=25",
      status: 200,
      body: { schedules: [] },
    },
    {
      match: "/agents/agent-1/schedules",
      status: 201,
      body: {
        schedule: {
          id: "sch-1",
          agentId: "agent-1",
          scheduleExpression: "0 * * * *",
          timezone: "America/New_York",
          nextRunAt: "2026-01-01T01:00:00Z",
        },
      },
    },
  ];

  const listRes = await runHandlerWithMockFetch(scheduleResponses, (m) => m.cmdScheduleList("agent-1", "25"));
  assert.equal(listRes.code, 0);
  assert.equal(listRes.requests[0]!.method, "GET");
  assert.equal(listRes.requests[0]!.path, "/agents/agent-1/schedules?limit=25");

  const getRes = await runHandlerWithMockFetch(scheduleResponses, (m) => m.cmdScheduleGet("agent-1", "sch-1"));
  assert.equal(getRes.code, 0);
  assert.equal(getRes.requests[0]!.method, "GET");
  assert.equal(getRes.requests[0]!.path, "/agents/agent-1/schedules/sch-1");

  const createRes = await runHandlerWithMockFetch(scheduleResponses, (m) =>
    m.cmdScheduleCreate("agent-1", [
      "0 * * * *",
      "payment",
      "XLM",
      "10",
      "GDEST",
      "daily",
      "--timezone",
      "America/New_York",
    ])
  );
  assert.equal(createRes.code, 0);
  assert.equal(createRes.requests[0]!.method, "POST");
  assert.equal(createRes.requests[0]!.path, "/agents/agent-1/schedules");
  assert.deepEqual(createRes.requests[0]!.body, {
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDEST",
      amount: "10",
      reason: "daily",
    },
    scheduleExpression: "0 * * * *",
    timezone: "America/New_York",
  });

  const updateRes = await runHandlerWithMockFetch(scheduleResponses, (m) =>
    m.cmdScheduleUpdate("agent-1", ["sch-1", "0 12 * * *"])
  );
  assert.equal(updateRes.code, 0);
  assert.equal(updateRes.requests[0]!.method, "PATCH");
  assert.equal(updateRes.requests[0]!.path, "/agents/agent-1/schedules/sch-1");
  assert.deepEqual(updateRes.requests[0]!.body, { scheduleExpression: "0 12 * * *" });

  const pauseRes = await runHandlerWithMockFetch(scheduleResponses, (m) => m.cmdSchedulePause("agent-1", "sch-1"));
  assert.equal(pauseRes.code, 0);
  assert.equal(pauseRes.requests[0]!.method, "POST");
  assert.equal(pauseRes.requests[0]!.path, "/agents/agent-1/schedules/sch-1/pause");
  assert.deepEqual(pauseRes.requests[0]!.body, {});

  const resumeRes = await runHandlerWithMockFetch(scheduleResponses, (m) => m.cmdScheduleResume("agent-1", "sch-1"));
  assert.equal(resumeRes.code, 0);
  assert.equal(resumeRes.requests[0]!.method, "POST");
  assert.equal(resumeRes.requests[0]!.path, "/agents/agent-1/schedules/sch-1/resume");
  assert.deepEqual(resumeRes.requests[0]!.body, {});

  const disableRes = await runHandlerWithMockFetch(scheduleResponses, (m) => m.cmdScheduleDisable("agent-1", "sch-1"));
  assert.equal(disableRes.code, 0);
  assert.equal(disableRes.requests[0]!.method, "POST");
  assert.equal(disableRes.requests[0]!.path, "/agents/agent-1/schedules/sch-1/disable");
  assert.deepEqual(disableRes.requests[0]!.body, {});

  const deleteRes = await runHandlerWithMockFetch(scheduleResponses, (m) => m.cmdScheduleDelete("agent-1", "sch-1"));
  assert.equal(deleteRes.code, 0);
  assert.equal(deleteRes.requests[0]!.method, "DELETE");
  assert.equal(deleteRes.requests[0]!.path, "/agents/agent-1/schedules/sch-1");
  assert.equal(deleteRes.requests[0]!.body, undefined);
});

test("Handler error paths: non-2xx on schedule command, invalid JSON in contract_call args, and missing required args", async () => {
  // 1. Non-2xx on a schedule command
  const scheduleError = await runHandlerWithMockFetch(
    [{ match: "/agents/agent-1/schedules/sch-1/pause", status: 409, body: { error: "schedule already paused" } }],
    (m) => m.cmdSchedulePause("agent-1", "sch-1")
  );
  assert.equal(scheduleError.code, 1);
  assert.equal(scheduleError.requests.length, 1);
  assert.equal(scheduleError.requests[0]!.method, "POST");
  assert.equal(scheduleError.requests[0]!.path, "/agents/agent-1/schedules/sch-1/pause");
  assert.match(scheduleError.stderr, /409/);

  // 2. Invalid JSON and non-array JSON in contract_call args
  const invalidJsonSubmit = await runHandlerWithMockFetch([], (m) =>
    m.cmdIntentSubmit("agent-1", ["contract_call", "CCONTRACT", "fn", "{invalid", "reason"], null)
  );
  assert.equal(invalidJsonSubmit.code, 1);
  assert.equal(invalidJsonSubmit.requests.length, 0);
  assert.match(invalidJsonSubmit.stderr, /valid JSON array/);

  const nonArrayScheduleCreate = await runHandlerWithMockFetch([], (m) =>
    m.cmdScheduleCreate("agent-1", ["0 * * * *", "contract_call", "CCONTRACT", "fn", '{"obj":true}', "reason"])
  );
  assert.equal(nonArrayScheduleCreate.code, 1);
  assert.equal(nonArrayScheduleCreate.requests.length, 0);
  assert.match(nonArrayScheduleCreate.stderr, /must be a JSON array/);

  // 3. Missing required arguments across handlers
  assert.equal((await runHandlerWithMockFetch([], (m) => m.cmdPolicyGet(""))).code, 1);
  assert.equal((await runHandlerWithMockFetch([], (m) => m.cmdPolicyUpdate("", []))).code, 1);
  assert.equal((await runHandlerWithMockFetch([], (m) => m.cmdActivityList("", ""))).code, 1);
  assert.equal((await runHandlerWithMockFetch([], (m) => m.cmdScheduleList("", ""))).code, 1);
  assert.equal((await runHandlerWithMockFetch([], (m) => m.cmdScheduleGet("agent-1", ""))).code, 1);
  assert.equal((await runHandlerWithMockFetch([], (m) => m.cmdScheduleCreate("agent-1", ["0 * * * *"]))).code, 1);
  assert.equal((await runHandlerWithMockFetch([], (m) => m.cmdScheduleUpdate("agent-1", ["sch-1"]))).code, 1);
  assert.equal((await runHandlerWithMockFetch([], (m) => m.cmdSchedulePause("agent-1", ""))).code, 1);
  assert.equal((await runHandlerWithMockFetch([], (m) => m.cmdScheduleResume("agent-1", ""))).code, 1);
  assert.equal((await runHandlerWithMockFetch([], (m) => m.cmdScheduleDisable("agent-1", ""))).code, 1);
  assert.equal((await runHandlerWithMockFetch([], (m) => m.cmdScheduleDelete("agent-1", ""))).code, 1);
  assert.equal((await runHandlerWithMockFetch([], (m) => m.cmdAgentCreate([]))).code, 1);
  assert.equal((await runHandlerWithMockFetch([], (m) => m.cmdIntentSubmit("", [], null))).code, 1);
});

// ===== #57 JSON output mode (--json & FOREGENT_OUTPUT=json) =====

test("CLI --json: --help documents --json and FOREGENT_OUTPUT=json", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--json/);
  assert.match(r.stdout, /FOREGENT_OUTPUT=json/);
});

test("CLI --json: outputs valid JSON with expected keys for health, agent list, agent get, approval list, execution list, execution get, policy get, activity list, schedule list", () => {
  const mockResponses = [
    {
      match: "/health",
      status: 200,
      body: { status: "ok", signerAccountId: "GBDMPFEAZOQW7XVTAVPXBT7PPA4ZZW7ZFJW5KJNBYRPJ35H6ASW4ASE3" },
    },
    {
      match: "/agents/agent-1/policy",
      status: 200,
      body: { agentId: "agent-1", policy: { maxTxAmount: { XLM: "500" } }, version: 3 },
    },
    {
      match: "/agents/agent-1/activity",
      status: 200,
      body: { agentId: "agent-1", activity: [{ id: "act-1", agentId: "agent-1", status: "confirmed" }] },
    },
    {
      match: "/agents/agent-1/schedules",
      status: 200,
      body: { agentId: "agent-1", schedules: [{ id: "sch-1", agentId: "agent-1", status: "active" }] },
    },
    {
      match: "/agents/agent-1",
      status: 200,
      body: { id: "agent-1", displayName: "Alpha Agent", status: "active", stellarAddress: "GAAA" },
    },
    {
      match: "/agents",
      status: 200,
      body: { agents: [{ id: "agent-1", displayName: "Alpha Agent", status: "active" }] },
    },
    {
      match: "/approvals",
      status: 200,
      body: { approvals: [{ id: "ap-1", agentId: "agent-1", status: "pending_approval" }] },
    },
    {
      match: "/executions/exec-1",
      status: 200,
      body: { execution: { id: "exec-1", agentId: "agent-1", status: "confirmed", txHash: "ab".repeat(32) } },
    },
    {
      match: "/executions",
      status: 200,
      body: { executions: [{ id: "exec-1", agentId: "agent-1", status: "confirmed" }] },
    },
  ];

  const cases: Array<{ args: string[]; expectedKey: string }> = [
    { args: ["health", "--json"], expectedKey: "signerAccountId" },
    { args: ["agent", "list", "--json"], expectedKey: "agents" },
    { args: ["agent", "get", "agent-1", "--json"], expectedKey: "displayName" },
    { args: ["approval", "list", "--json"], expectedKey: "approvals" },
    { args: ["execution", "list", "--json"], expectedKey: "executions" },
    { args: ["execution", "get", "exec-1", "--json"], expectedKey: "execution" },
    { args: ["policy", "get", "agent-1", "--json"], expectedKey: "policy" },
    { args: ["activity", "list", "agent-1", "--json"], expectedKey: "activity" },
    { args: ["--json", "schedule", "list", "agent-1"], expectedKey: "schedules" },
  ];

  for (const c of cases) {
    const r = run(c.args, { responses: mockResponses });
    assert.equal(r.code, 0, `expected exit 0 for ${c.args.join(" ")}, got stderr=${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(c.expectedKey in parsed, `expected key '${c.expectedKey}' in ${r.stdout}`);
  }
});

test("CLI --json: FOREGENT_OUTPUT=json produces identical JSON output and default human output is unchanged", () => {
  const agentListResponse = [
    {
      match: "/agents",
      status: 200,
      body: { agents: [{ id: "agent-1", displayName: "Alpha Agent", status: "active" }] },
    },
  ];

  const viaFlag = run(["agent", "list", "--json"], { responses: agentListResponse });
  const viaEnv = run(["agent", "list"], {
    env: { FOREGENT_OUTPUT: "json" },
    responses: agentListResponse,
  });
  const humanDefault = run(["agent", "list"], { responses: agentListResponse });

  assert.equal(viaFlag.code, 0);
  assert.equal(viaEnv.code, 0);
  assert.equal(viaFlag.stdout, viaEnv.stdout);
  assert.deepEqual(JSON.parse(viaEnv.stdout), {
    agents: [{ id: "agent-1", displayName: "Alpha Agent", status: "active" }],
  });

  // Human output without --json or FOREGENT_OUTPUT=json stays byte-identical
  assert.equal(humanDefault.code, 0);
  assert.equal(humanDefault.stdout, "agent-1\tAlpha Agent\tactive\n");
});


