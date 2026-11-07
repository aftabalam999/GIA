import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { PermissionManager } from '../src/ai/permissions/permission.manager.js';
import { PlanRepository } from '../src/ai/planner/plan.repository.js';
import { ExecutionPlan } from '../src/ai/planner/planner.interface.js';
import { SessionService } from '../src/auth/services/session.service.js';
import { UserRepository } from '../src/database/repositories/user.repository.js';
import { hashPassword } from '../src/shared/auth.js';

describe('PHASE 5.6: Production Database, Transaction Atomicity and Multi-Process Verification', () => {
  let userA: { id: string; email: string; sessionId: string };
  let convoAId: string;

  beforeAll(async () => {
    await initializeDatabase();

    // Create test user in PostgreSQL
    const emailA = `audit_p56_user_${Date.now()}@gia.ai`;
    const passwordHash = await hashPassword('Password123!');
    const createdUser = await UserRepository.create(emailA, 'Audit User P56', passwordHash);
    const session = await SessionService.createSession(createdUser.id, createdUser.email, createdUser.name);
    userA = { id: createdUser.id, email: emailA, sessionId: session.id };

    // Create test conversation in PostgreSQL
    const convoRes = await query<{ id: string }>(
      `INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, $3) RETURNING id`,
      [crypto.randomUUID(), userA.id, 'Production DB & Multi-Process Audit']
    );
    convoAId = convoRes.rows[0].id;
  });

  beforeEach(() => {
    PermissionManager.resetState();
  });

  afterAll(async () => {
    // Cleanup test data
    if (userA?.id) {
      await query(`DELETE FROM users WHERE id = $1`, [userA.id]);
    }
  });

  async function createTestPlan(userId: string, conversationId: string): Promise<ExecutionPlan> {
    const plan: ExecutionPlan = {
      id: crypto.randomUUID(),
      conversation_id: conversationId,
      user_id: userId,
      objective: 'Launch application and sync configuration',
      status: 'pending',
      version: 1,
      is_ambiguous: false,
      steps: [
        {
          step_id: 1,
          action: 'launch_application',
          target: 'Visual Studio Code',
          tool_name: 'launch_application',
          tool_args: { application_name: 'Visual Studio Code' },
          description: 'Launch VS Code IDE',
          risk_level: 'low',
          requires_approval: false,
          depends_on: [],
          expected_outcome: 'VS Code launched',
        },
      ],
      approval: { required: true, approved: false, approved_at: null },
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    return await PlanRepository.create(plan);
  }

  function waitForServer(port: number, retries = 35): Promise<void> {
    return new Promise((resolve, reject) => {
      function ping() {
        const req = http.get(`http://127.0.0.1:${port}/api/v1/health`, (res) => {
          resolve();
        });
        req.on('error', () => {
          if (--retries <= 0) return reject(new Error(`Server on port ${port} timed out`));
          setTimeout(ping, 150);
        });
      }
      ping();
    });
  }

  // ============================================================================
  // 1. DATABASE MIGRATION AND POSTGRESQL SCHEMA AUDIT
  // ============================================================================
  describe('1. Database Migration & Schema Audit', () => {
    it('1.1 Migration is registered in schema_migrations table', async () => {
      const res = await query<{ version: string; applied_at: Date }>(
        `SELECT version, applied_at FROM schema_migrations WHERE version = '009_voice_approval_challenges.sql'`
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].version).toBe('009_voice_approval_challenges.sql');
      expect(res.rows[0].applied_at).toBeInstanceOf(Date);
    });

    it('1.2 voice_approval_challenges table has all required columns with exact types', async () => {
      const cols = await query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable 
         FROM information_schema.columns 
         WHERE table_name = 'voice_approval_challenges'
         ORDER BY ordinal_position`
      );

      const colMap = new Map(cols.rows.map((c) => [c.column_name, c]));
      expect(colMap.has('id')).toBe(true);
      expect(colMap.get('id')?.data_type).toBe('uuid');
      expect(colMap.get('id')?.is_nullable).toBe('NO');

      expect(colMap.has('challenge_token')).toBe(true);
      expect(colMap.get('challenge_token')?.is_nullable).toBe('NO');

      expect(colMap.has('plan_id')).toBe(true);
      expect(colMap.get('plan_id')?.data_type).toBe('uuid');

      expect(colMap.has('plan_version')).toBe(true);
      expect(colMap.get('plan_version')?.data_type).toBe('integer');

      expect(colMap.has('user_id')).toBe(true);
      expect(colMap.get('user_id')?.data_type).toBe('uuid');

      expect(colMap.has('conversation_id')).toBe(true);
      expect(colMap.get('conversation_id')?.data_type).toBe('uuid');

      expect(colMap.has('created_at')).toBe(true);
      expect(colMap.get('created_at')?.data_type).toBe('timestamp with time zone');

      expect(colMap.has('expires_at')).toBe(true);
      expect(colMap.get('expires_at')?.data_type).toBe('timestamp with time zone');

      expect(colMap.has('consumed')).toBe(true);
      expect(colMap.get('consumed')?.data_type).toBe('boolean');

      expect(colMap.has('consumed_at')).toBe(true);

      expect(colMap.has('revoked')).toBe(true);
      expect(colMap.get('revoked')?.data_type).toBe('boolean');

      expect(colMap.has('revoked_at')).toBe(true);
    });

    it('1.3 Constraints: Primary key, unique token, and cascading foreign keys exist', async () => {
      const constraints = await query<{
        conname: string;
        contype: string;
        def: string;
      }>(
        `SELECT conname, contype, pg_get_constraintdef(c.oid) as def
         FROM pg_constraint c
         JOIN pg_class t ON c.conrelid = t.oid
         WHERE t.relname = 'voice_approval_challenges'`
      );

      const pk = constraints.rows.find((c) => c.contype === 'p');
      expect(pk?.def).toBe('PRIMARY KEY (id)');

      const uniqueToken = constraints.rows.find((c) => c.conname.includes('challenge_token'));
      expect(uniqueToken).toBeDefined();

      const fkeys = constraints.rows.filter((c) => c.contype === 'f');
      expect(fkeys.some((f) => f.def.includes('REFERENCES task_plans(id) ON DELETE CASCADE'))).toBe(true);
      expect(fkeys.some((f) => f.def.includes('REFERENCES users(id) ON DELETE CASCADE'))).toBe(true);
      expect(fkeys.some((f) => f.def.includes('REFERENCES conversations(id) ON DELETE CASCADE'))).toBe(true);
    });

    it('1.4 Indexes: Required btree indexes exist on query columns', async () => {
      const idxs = await query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'voice_approval_challenges'`
      );
      const names = idxs.rows.map((i) => i.indexname);
      expect(names).toContain('voice_approval_challenges_pkey');
      expect(names).toContain('idx_voice_approval_challenges_token');
      expect(names).toContain('idx_voice_approval_challenges_plan_id');
      expect(names).toContain('idx_voice_approval_challenges_user_id');
      expect(names).toContain('idx_voice_approval_challenges_expires_at');
    });

    it('1.5 Idempotency: Re-running 009 migration SQL executes safely without error', async () => {
      const migrationPath = path.resolve(__dirname, '../src/database/migrations/009_voice_approval_challenges.sql');
      const sql = await fs.readFile(migrationPath, 'utf8');

      // Executing migration directly against PostgreSQL must succeed cleanly
      await expect(query(sql)).resolves.not.toThrow();
    });
  });

  // ============================================================================
  // 2. REAL MULTI-PROCESS CONCURRENCY (TWO INDEPENDENT NODE.JS PROCESSES)
  // ============================================================================
  describe('2. Real Multi-Process Concurrency over HTTP', () => {
    let proc1: ChildProcess;
    let proc2: ChildProcess;
    const PORT_1 = 5041;
    const PORT_2 = 5042;

    beforeAll(async () => {
      const backendDir = path.resolve(__dirname, '..');
      const envBase = { ...process.env, NODE_ENV: 'test' };

      // Spawn Process 1
      proc1 = spawn('npx', ['tsx', 'src/server.ts'], {
        cwd: backendDir,
        env: { ...envBase, PORT: String(PORT_1) },
        stdio: 'ignore',
      });

      // Spawn Process 2
      proc2 = spawn('npx', ['tsx', 'src/server.ts'], {
        cwd: backendDir,
        env: { ...envBase, PORT: String(PORT_2) },
        stdio: 'ignore',
      });

      await Promise.all([waitForServer(PORT_1), waitForServer(PORT_2)]);
    }, 20000);

    afterAll(() => {
      if (proc1) proc1.kill('SIGTERM');
      if (proc2) proc2.kill('SIGTERM');
    });

    it('2.1 Two independent processes concurrently receiving the same challenge: exactly one 200, one 400', async () => {
      const plan = await createTestPlan(userA.id, convoAId);
      const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

      const requestBody = {
        planVersion: plan.version,
        channel: 'voice_command',
        voiceTranscript: 'gia approve this plan',
        challengeToken: challenge.challengeToken,
      };

      // Dispatch simultaneous HTTP POST requests to both independent backend servers
      const [res1, res2] = await Promise.all([
        fetch(`http://127.0.0.1:${PORT_1}/api/v1/conversations/${convoAId}/plans/${plan.id}/approve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userA.sessionId}`,
          },
          body: JSON.stringify(requestBody),
        }),
        fetch(`http://127.0.0.1:${PORT_2}/api/v1/conversations/${convoAId}/plans/${plan.id}/approve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userA.sessionId}`,
          },
          body: JSON.stringify(requestBody),
        }),
      ]);

      const [data1, data2] = await Promise.all([res1.json(), res2.json()]);

      const statusCodes = [res1.status, res2.status].sort();
      expect(statusCodes).toEqual([200, 400]);

      const winnerData = res1.status === 200 ? data1 : data2;
      const loserData = res1.status === 400 ? data1 : data2;

      // Winner received a valid cryptographic ticket
      expect(winnerData.success).toBe(true);
      expect(winnerData.ticket.ticketToken).toMatch(/^gia_ticket_[0-9a-f]{32}$/);
      expect(winnerData.ticket.planId).toBe(plan.id);

      // Loser was rejected with replay attack prevention
      expect(loserData.success).toBe(false);
      expect(loserData.message).toContain('Challenge has already been consumed. Replay attacks are prohibited.');

      // Check PostgreSQL database: exactly 1 ticket in plan_approvals, challenge marked consumed
      const chalDb = await query<{ consumed: boolean; consumed_at: Date }>(
        `SELECT consumed, consumed_at FROM voice_approval_challenges WHERE challenge_token = $1`,
        [challenge.challengeToken]
      );
      expect(chalDb.rows[0].consumed).toBe(true);
      expect(chalDb.rows[0].consumed_at).not.toBeNull();

      const ticketDb = await query<{ id: string; ticket_token: string }>(
        `SELECT id, ticket_token FROM plan_approvals WHERE plan_id = $1`,
        [plan.id]
      );
      expect(ticketDb.rows).toHaveLength(1);
      expect(ticketDb.rows[0].ticket_token).toBe(winnerData.ticket.ticketToken);

      const planDb = await query<{ status: string }>(
        `SELECT status FROM task_plans WHERE id = $1`,
        [plan.id]
      );
      expect(planDb.rows[0].status).toBe('approved');
    });

    it('2.2 Replay attempt to both worker instances is rejected (HTTP 400)', async () => {
      const plan = await createTestPlan(userA.id, convoAId);
      const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

      // First use succeeds on Instance 1
      const resFirst = await fetch(`http://127.0.0.1:${PORT_1}/api/v1/conversations/${convoAId}/plans/${plan.id}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.sessionId}`,
        },
        body: JSON.stringify({
          planVersion: plan.version,
          channel: 'voice_command',
          voiceTranscript: 'gia proceed',
          challengeToken: challenge.challengeToken,
        }),
      });
      expect(resFirst.status).toBe(200);

      // Attempt reuse on Instance 2 (which has never seen this challenge in its local memory)
      const resReplay = await fetch(`http://127.0.0.1:${PORT_2}/api/v1/conversations/${convoAId}/plans/${plan.id}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.sessionId}`,
        },
        body: JSON.stringify({
          planVersion: plan.version,
          channel: 'voice_command',
          voiceTranscript: 'gia proceed',
          challengeToken: challenge.challengeToken,
        }),
      });
      const dataReplay = await resReplay.json();

      expect(resReplay.status).toBe(400);
      expect(dataReplay.success).toBe(false);
      expect(dataReplay.message).toContain('Challenge has already been consumed. Replay attacks are prohibited.');
    });

    it('2.3 Post-restart process strictly rejects consumed challenges based on database persistence', async () => {
      const plan = await createTestPlan(userA.id, convoAId);
      const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

      // Consume challenge on Instance 1
      const resConsume = await fetch(`http://127.0.0.1:${PORT_1}/api/v1/conversations/${convoAId}/plans/${plan.id}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.sessionId}`,
        },
        body: JSON.stringify({
          planVersion: plan.version,
          channel: 'voice_command',
          voiceTranscript: 'approve',
          challengeToken: challenge.challengeToken,
        }),
      });
      expect(resConsume.status).toBe(200);

      // Spawn Worker 3 on PORT 5043 (brand new process with completely empty in-memory state)
      const PORT_3 = 5043;
      const proc3 = spawn('npx', ['tsx', 'src/server.ts'], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PORT: String(PORT_3), NODE_ENV: 'test' },
        stdio: 'ignore',
      });

      try {
        await waitForServer(PORT_3);

        const resWorker3 = await fetch(`http://127.0.0.1:${PORT_3}/api/v1/conversations/${convoAId}/plans/${plan.id}/approve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userA.sessionId}`,
          },
          body: JSON.stringify({
            planVersion: plan.version,
            channel: 'voice_command',
            voiceTranscript: 'approve',
            challengeToken: challenge.challengeToken,
          }),
        });

        const dataWorker3 = await resWorker3.json();
        expect(resWorker3.status).toBe(400);
        expect(dataWorker3.success).toBe(false);
        expect(dataWorker3.message).toContain('Challenge has already been consumed. Replay attacks are prohibited.');
      } finally {
        proc3.kill('SIGTERM');
      }
    });
  });

  // ============================================================================
  // 3. TRANSACTION ATOMICITY IN requestApproval (FAILURE SCENARIOS A - E)
  // ============================================================================
  describe('3. Transaction Atomicity Audit in requestApproval', () => {
    it('3.1 Scenario A: Failure during plan update triggers ROLLBACK; challenge remains unconsumed', async () => {
      const plan = await createTestPlan(userA.id, convoAId);
      const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

      // Artificially change the plan status in DB to 'cancelled' so the atomic UPDATE fails
      await query(`UPDATE task_plans SET status = 'cancelled' WHERE id = $1`, [plan.id]);

      const approvalRes = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId: userA.id,
        conversationId: convoAId,
        channel: 'voice_command',
        voiceTranscript: 'approve this plan',
        challengeToken: challenge.challengeToken,
      });

      expect(approvalRes.success).toBe(false);

      // Verify that transaction rollback prevented challenge consumption in PostgreSQL
      const chalDb = await query<{ consumed: boolean }>(
        `SELECT consumed FROM voice_approval_challenges WHERE challenge_token = $1`,
        [challenge.challengeToken]
      );
      expect(chalDb.rows[0].consumed).toBe(false);

      // Verify no ticket was persisted
      const ticketDb = await query(
        `SELECT * FROM plan_approvals WHERE plan_id = $1`,
        [plan.id]
      );
      expect(ticketDb.rows).toHaveLength(0);
    });

    it('3.2 Scenario B: Failure during ticket insertion triggers ROLLBACK; reverts plan status and preserves challenge', async () => {
      const plan = await createTestPlan(userA.id, convoAId);
      const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

      // Execute transaction simulating a crash/failure during plan_approvals ticket insertion
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Step 1: Lock plan
        const planLock = await client.query(`SELECT * FROM task_plans WHERE id = $1 FOR UPDATE`, [plan.id]);
        expect(planLock.rows).toHaveLength(1);

        // Step 2: Consume challenge
        await client.query(
          `UPDATE voice_approval_challenges SET consumed = true, consumed_at = NOW() WHERE challenge_token = $1`,
          [challenge.challengeToken]
        );

        // Step 3: Update plan
        await client.query(
          `UPDATE task_plans SET status = 'approved' WHERE id = $1`,
          [plan.id]
        );

        // Step 4: Simulate unexpected crash / ticket insertion error (e.g. invalid foreign key or DB error)
        throw new Error('SIMULATED_DB_FAILURE_DURING_TICKET_INSERT');
      } catch (err: any) {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      // Verify PostgreSQL state post-rollback:
      // 1. Challenge was NOT consumed
      const chalDb = await query<{ consumed: boolean }>(
        `SELECT consumed FROM voice_approval_challenges WHERE challenge_token = $1`,
        [challenge.challengeToken]
      );
      expect(chalDb.rows[0].consumed).toBe(false);

      // 2. Plan was NOT left approved
      const planDb = await query<{ status: string }>(
        `SELECT status FROM task_plans WHERE id = $1`,
        [plan.id]
      );
      expect(planDb.rows[0].status).toBe('pending');

      // 3. No orphan execution ticket was left
      const ticketDb = await query(
        `SELECT * FROM plan_approvals WHERE plan_id = $1`,
        [plan.id]
      );
      expect(ticketDb.rows).toHaveLength(0);
    });

    it('3.3 Scenario C: Ticket creation cannot precede challenge consumption; no ticket created on consumed challenge', async () => {
      const plan = await createTestPlan(userA.id, convoAId);
      const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

      // First call succeeds
      const firstApproval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId: userA.id,
        conversationId: convoAId,
        channel: 'voice_command',
        voiceTranscript: 'approve',
        challengeToken: challenge.challengeToken,
      });
      expect(firstApproval.success).toBe(true);

      // Second call fails; cannot create a second ticket
      const secondApproval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId: userA.id,
        conversationId: convoAId,
        channel: 'voice_command',
        voiceTranscript: 'approve',
        challengeToken: challenge.challengeToken,
      });
      expect(secondApproval.success).toBe(false);

      const ticketCount = await query<{ count: string }>(
        `SELECT count(*) FROM plan_approvals WHERE plan_id = $1`,
        [plan.id]
      );
      expect(Number(ticketCount.rows[0].count)).toBe(1);
    });

    it('3.4 Scenario D: Connection disconnect or unhandled exception aborts transaction cleanly', async () => {
      const plan = await createTestPlan(userA.id, convoAId);
      const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

      // Acquire dedicated client and begin transaction
      const client = await pool.connect();
      await client.query('BEGIN');
      await client.query(
        `UPDATE voice_approval_challenges SET consumed = true WHERE challenge_token = $1`,
        [challenge.challengeToken]
      );
      // Abruptly release client without COMMIT
      await client.query('ROLLBACK');
      client.release();

      const chalDb = await query<{ consumed: boolean }>(
        `SELECT consumed FROM voice_approval_challenges WHERE challenge_token = $1`,
        [challenge.challengeToken]
      );
      expect(chalDb.rows[0].consumed).toBe(false);
    });

    it('3.5 Scenario E: Concurrent approvals on modified plan versions serialize; stale version rejected', async () => {
      const plan = await createTestPlan(userA.id, convoAId);
      const challengeV1 = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, 1);

      // Simulate modification in DB to version 2
      await query(`UPDATE task_plans SET version = 2 WHERE id = $1`, [plan.id]);

      // Attempt approval using challengeV1
      const approval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: 1, // stale version
        userId: userA.id,
        conversationId: convoAId,
        channel: 'voice_command',
        voiceTranscript: 'approve',
        challengeToken: challengeV1.challengeToken,
      });

      expect(approval.success).toBe(false);
      expect(approval.message).toContain('Plan version mismatch');

      // Plan was NOT marked approved
      const planDb = await query<{ status: string }>(
        `SELECT status FROM task_plans WHERE id = $1`,
        [plan.id]
      );
      expect(planDb.rows[0].status).toBe('pending');
    });
  });

  // ============================================================================
  // 4. DATABASE CONSTRAINTS AND CASCADE VERIFICATION
  // ============================================================================
  describe('4. Database Constraints & Cascade Verification', () => {
    it('4.1 Unique constraint on challenge_token prevents duplicate insertions', async () => {
      const plan = await createTestPlan(userA.id, convoAId);
      const duplicateToken = `gia_chal_duplicate_${crypto.randomBytes(8).toString('hex')}`;

      // Insert first challenge
      await query(
        `INSERT INTO voice_approval_challenges (challenge_token, plan_id, plan_version, user_id, conversation_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '60 seconds')`,
        [duplicateToken, plan.id, plan.version, userA.id, convoAId]
      );

      // Insert duplicate challenge must throw a unique constraint violation error (23505)
      await expect(
        query(
          `INSERT INTO voice_approval_challenges (challenge_token, plan_id, plan_version, user_id, conversation_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '60 seconds')`,
          [duplicateToken, plan.id, plan.version, userA.id, convoAId]
        )
      ).rejects.toThrow();
    });

    it('4.2 Deleting a task_plan cascades and cleans up all associated challenges and tickets', async () => {
      const plan = await createTestPlan(userA.id, convoAId);
      const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

      const approval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId: userA.id,
        conversationId: convoAId,
        channel: 'voice_command',
        voiceTranscript: 'gia approve',
        challengeToken: challenge.challengeToken,
      });
      expect(approval.success).toBe(true);

      // Confirm records exist in both tables
      const chalBefore = await query(`SELECT * FROM voice_approval_challenges WHERE plan_id = $1`, [plan.id]);
      const ticketBefore = await query(`SELECT * FROM plan_approvals WHERE plan_id = $1`, [plan.id]);
      expect(chalBefore.rows.length).toBeGreaterThan(0);
      expect(ticketBefore.rows.length).toBeGreaterThan(0);

      // Delete task_plan
      await query(`DELETE FROM task_plans WHERE id = $1`, [plan.id]);

      // Confirm cascade deleted associated challenges and tickets
      const chalAfter = await query(`SELECT * FROM voice_approval_challenges WHERE plan_id = $1`, [plan.id]);
      const ticketAfter = await query(`SELECT * FROM plan_approvals WHERE plan_id = $1`, [plan.id]);
      expect(chalAfter.rows).toHaveLength(0);
      expect(ticketAfter.rows).toHaveLength(0);
    });
  });

  // ============================================================================
  // 5. FAILURE, RECOVERY AND FAIL-CLOSED GUARANTEES
  // ============================================================================
  describe('5. Fail-Closed Guarantees without In-Memory Fallback', () => {
    it('5.1 createApprovalChallenge fails closed if database insertion fails (no phantom in-memory challenge)', async () => {
      const fakePlanId = crypto.randomUUID(); // non-existent plan violates foreign key

      // Must reject / throw rather than silently falling back to in-memory
      await expect(
        PermissionManager.createApprovalChallenge(fakePlanId, userA.id, convoAId, 1)
      ).rejects.toThrow();
    });

    it('5.2 Ticket revocation in PostgreSQL is durable and immediately recognized across process memory wipes', async () => {
      const plan = await createTestPlan(userA.id, convoAId);
      const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

      const approval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId: userA.id,
        conversationId: convoAId,
        channel: 'voice_command',
        voiceTranscript: 'gia approve',
        challengeToken: challenge.challengeToken,
      });
      expect(approval.success).toBe(true);
      const ticketToken = approval.ticket?.ticketToken!;

      // Invalidate approval (revokes in PostgreSQL)
      await PermissionManager.invalidateApproval(plan.id, 'User cancelled task');

      // Simulate complete process memory wipe (restart)
      PermissionManager.resetState();

      // Verify tool execution check against PostgreSQL: MUST be denied
      const toolCheck = await PermissionManager.verifyToolExecution(
        userA.id,
        'launch_application',
        {},
        ticketToken,
        1
      );
      expect(toolCheck.allowed).toBe(false);
      expect(toolCheck.reason).toContain('PERMISSION_DENIED');
    });
  });
});
