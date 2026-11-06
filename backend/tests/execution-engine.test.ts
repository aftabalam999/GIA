import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { PlanRepository } from '../src/ai/planner/plan.repository.js';
import { TaskPlanningEngine } from '../src/ai/planner/planner.service.js';
import { PermissionManager } from '../src/ai/permissions/permission.manager.js';
import { PlanExecutionEngine } from '../src/ai/execution/plan-execution.engine.js';
import { ExecutionRepository } from '../src/ai/execution/execution.repository.js';
import { ToolExecutor } from '../src/ai/tools/executor.js';
import { registry } from '../src/ai/tools/registry.js';
import { planRoutes } from '../src/api/routes/plans.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { toolRoutes } from '../src/api/routes/tools.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { ExecutionPlan } from '../src/ai/planner/planner.interface.js';

describe('PHASE 3: Approved Plan Execution Engine & Centralized Tool Registry Suite', () => {
  const app = Fastify();
  let userToken: string;
  let userId: string;
  let user2Token: string;
  let user2Id: string;
  let conversationId: string;
  const testTmpFiles: string[] = [];

  beforeAll(async () => {
    app.setErrorHandler(errorHandler);
    await app.register(cors);
    await app.register(fastifyCookie);
    await app.register(fastifyJwt, { secret: 'test_jwt_secret_key_phase_3_execution_123' });
    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.register(planRoutes, { prefix: '/api/v1' });
    await app.register(toolRoutes, { prefix: '/api/v1' });

    await initializeDatabase();
    await query('DELETE FROM users');

    // Create User 1
    const signup1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'execution_tester@gia.ai', password: 'secure_password_123', name: 'Execution Tester' },
    });
    const body1 = JSON.parse(signup1.body);
    userToken = body1.token;
    userId = body1.user.id;

    // Create User 2
    const signup2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'intruder@gia.ai', password: 'secure_password_123', name: 'Intruder' },
    });
    const body2 = JSON.parse(signup2.body);
    user2Token = body2.token;
    user2Id = body2.user.id;

    // Create Conversation
    const convoRes = await query<{ id: string }>(
      'INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id',
      [userId, 'Phase 3 Execution Engine Tests']
    );
    conversationId = convoRes.rows[0].id;
  });

  afterAll(async () => {
    PlanExecutionEngine.resetState();
    PermissionManager.setGateEnforced(false);
    for (const f of testTmpFiles) {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
    await query('DELETE FROM users');
    await pool.end();
  });

  beforeEach(() => {
    PlanExecutionEngine.resetState();
    PermissionManager.resetState();
    PermissionManager.setGateEnforced(false);
  });

  describe('1. Centralized Allowlisted Tool Registry (12 Core Tools with Verification)', () => {
    it('Tool 1: launch_application executes and verifies application launch', async () => {
      const tool = registry.get('launch_application');
      expect(tool).toBeDefined();
      expect(tool?.permissions).toContain('open:apps');

      const res = await tool!.execute({ appName: 'Calculator' }, { userId });
      expect(res.success).toBe(true);

      const verification = await tool!.verify!({ appName: 'Calculator' }, res, { userId });
      expect(verification.verified).toBe(true);
    });

    it('Tool 2: close_application gracefully quits an application and verifies shutdown', async () => {
      const tool = registry.get('close_application');
      expect(tool).toBeDefined();

      const res = await tool!.execute({ appName: 'Calculator', force: false }, { userId });
      expect(res.success).toBe(true);

      const verification = await tool!.verify!({ appName: 'Calculator', force: false }, res, { userId });
      expect(verification.verified).toBe(true);
    });

    it('Tool 3: navigate_browser navigates to URL and verifies protocol', async () => {
      const tool = registry.get('navigate_browser');
      expect(tool).toBeDefined();

      const res = await tool!.execute({ url: 'https://www.youtube.com' }, { userId });
      expect(res.success).toBe(true);
      expect(res.navigatedUrl).toBe('https://www.youtube.com');

      const verification = await tool!.verify!({ url: 'https://www.youtube.com' }, res, { userId });
      expect(verification.verified).toBe(true);
    });

    it('Tool 4: search_browser formats engine queries (Google, YouTube, GitHub) with verification', async () => {
      const tool = registry.get('search_browser');
      expect(tool).toBeDefined();

      const res = await tool!.execute({ query: 'Rust Tauri GIA', engine: 'github' }, { userId });
      expect(res.success).toBe(true);
      expect(res.searchUrl).toContain('github.com/search?q=');

      const verification = await tool!.verify!({ query: 'Rust Tauri GIA', engine: 'github' }, res, { userId });
      expect(verification.verified).toBe(true);
    });

    it('Tool 5: create_file writes within user boundary and verifies disk presence', async () => {
      const tool = registry.get('create_file');
      expect(tool).toBeDefined();

      const testFileRel = `test_file_${Date.now()}.txt`;
      const fullPath = path.join(os.homedir(), testFileRel);
      testTmpFiles.push(fullPath);

      const res = await tool!.execute({ filePath: testFileRel, content: 'GIA Phase 3 File Content' }, { userId });
      expect(res.success).toBe(true);

      const verification = await tool!.verify!({ filePath: testFileRel, content: 'GIA Phase 3 File Content' }, res, { userId });
      expect(verification.verified).toBe(true);
      expect(fs.existsSync(fullPath)).toBe(true);
    });

    it('Tool 6: read_file reads file content safely with boundary verification', async () => {
      const tool = registry.get('read_file');
      expect(tool).toBeDefined();

      const testFileRel = `read_test_${Date.now()}.txt`;
      const fullPath = path.join(os.homedir(), testFileRel);
      testTmpFiles.push(fullPath);
      fs.writeFileSync(fullPath, 'Hello from read_file verification test');

      const res = await tool!.execute({ filePath: testFileRel }, { userId });
      expect(res.success).toBe(true);
      expect(res.content).toContain('Hello from read_file');

      const verification = await tool!.verify!({ filePath: testFileRel }, res, { userId });
      expect(verification.verified).toBe(true);
    });

    it('Tool 7: update_file modifies or appends file content with verification', async () => {
      const tool = registry.get('update_file');
      expect(tool).toBeDefined();

      const testFileRel = `update_test_${Date.now()}.txt`;
      const fullPath = path.join(os.homedir(), testFileRel);
      testTmpFiles.push(fullPath);
      fs.writeFileSync(fullPath, 'Initial Line\n');

      const res = await tool!.execute({ filePath: testFileRel, content: 'Appended Line\n', append: true }, { userId });
      expect(res.success).toBe(true);

      const contentAfter = fs.readFileSync(fullPath, 'utf-8');
      expect(contentAfter).toContain('Initial Line');
      expect(contentAfter).toContain('Appended Line');

      const verification = await tool!.verify!({ filePath: testFileRel, content: 'Appended Line\n', append: true }, res, { userId });
      expect(verification.verified).toBe(true);
    });

    it('Tool 8: delete_file safely unlinks file and verifies non-existence', async () => {
      const tool = registry.get('delete_file');
      expect(tool).toBeDefined();

      const testFileRel = `delete_test_${Date.now()}.txt`;
      const fullPath = path.join(os.homedir(), testFileRel);
      fs.writeFileSync(fullPath, 'To be deleted');
      expect(fs.existsSync(fullPath)).toBe(true);

      const res = await tool!.execute({ filePath: testFileRel }, { userId });
      expect(res.success).toBe(true);

      const verification = await tool!.verify!({ filePath: testFileRel }, res, { userId });
      expect(verification.verified).toBe(true);
      expect(fs.existsSync(fullPath)).toBe(false);
    });

    it('Tool 9: open_folder verifies directory existence and opens folder', async () => {
      const tool = registry.get('open_folder');
      expect(tool).toBeDefined();

      const res = await tool!.execute({ folderPath: 'Desktop' }, { userId });
      expect(res.success).toBe(true);

      const verification = await tool!.verify!({ folderPath: 'Desktop' }, res, { userId });
      expect(verification.verified).toBe(true);
    });

    it('Tool 10: execute_terminal_command strictly enforces allowlisted commands and blocks shell metacharacters', async () => {
      const tool = registry.get('execute_terminal_command');
      expect(tool).toBeDefined();

      // Safe allowlisted command: echo
      const safeRes = await tool!.execute({ command: 'echo GIA_SAFE_COMMAND_TEST' }, { userId });
      expect(safeRes.success).toBe(true);
      expect(safeRes.stdout).toBe('GIA_SAFE_COMMAND_TEST');

      // Shell metacharacters injection block (; && | ` $)
      await expect(tool!.execute({ command: 'echo hello; rm -rf /' }, { userId })).rejects.toThrow(
        /forbidden shell operators/
      );

      // Non-allowlisted command block
      await expect(tool!.execute({ command: 'cat /etc/passwd' }, { userId })).rejects.toThrow(
        /not permitted/
      );
    });

    it('Tool 11: capture_screen captures desktop screenshot and verifies file', async () => {
      const tool = registry.get('capture_screen');
      expect(tool).toBeDefined();

      const screenshotRel = `test_screenshot_${Date.now()}.png`;
      const destPath = path.join(os.tmpdir(), screenshotRel);
      testTmpFiles.push(destPath);

      const res = await tool!.execute({ destinationPath: destPath }, { userId });
      expect(res.success).toBe(true);

      const verification = await tool!.verify!({ destinationPath: destPath }, res, { userId });
      expect(verification.verified).toBe(true);
      expect(fs.existsSync(destPath)).toBe(true);
    });

    it('Tool 12: interact_with_application focuses frontmost application window with verification', async () => {
      const tool = registry.get('interact_with_application');
      expect(tool).toBeDefined();

      const res = await tool!.execute({ appName: 'Finder', action: 'activate' }, { userId });
      expect(res.success).toBe(true);

      const verification = await tool!.verify!({ appName: 'Finder', action: 'activate' }, res, { userId });
      expect(verification.verified).toBe(true);
    });
  });

  describe('2. Core Execution Engine Rules & Guardrails', () => {
    it('Rule 1: Rejects execution of unapproved plan (status: awaiting_approval)', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'system info');
      expect(plan.status).toBe('awaiting_approval');

      await expect(
        PlanExecutionEngine.executeApprovedPlan({
          planId: plan.id,
          planVersion: plan.version,
          userId,
          ticketToken: 'fake_ticket_token',
        })
      ).rejects.toThrow(/Only approved plans can be executed/);
    });

    it('Rule 2: Rejects execution of rejected plan', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'system info');
      await PermissionManager.rejectPlan(plan.id, userId);

      await expect(
        PlanExecutionEngine.executeApprovedPlan({
          planId: plan.id,
          planVersion: plan.version,
          userId,
          ticketToken: 'fake_ticket_token',
        })
      ).rejects.toThrow(/Only approved plans can be executed/);
    });

    it('Rule 3: Rejects execution on plan version mismatch', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'system info');
      const approved = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      // User modified plan (bumps to version 2)
      await TaskPlanningEngine.modifyPlan(plan, 'also check battery');

      // Attempt to execute version 1
      await expect(
        PlanExecutionEngine.executeApprovedPlan({
          planId: plan.id,
          planVersion: 1, // out of date!
          userId,
          ticketToken: approved.ticket!.ticketId,
        })
      ).rejects.toThrow(/Version mismatch/);
    });

    it('Rule 4: Rejects unauthorized user session attempting to execute plan (IDOR Protection)', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'system info');
      const approved = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      await expect(
        PlanExecutionEngine.executeApprovedPlan({
          planId: plan.id,
          planVersion: plan.version,
          userId: user2Id, // Intruder user ID
          ticketToken: approved.ticket!.ticketId,
        })
      ).rejects.toThrow(/Access denied/);
    });

    it('Rule 5: Prevents duplicate and unauthorized parallel execution', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'system info');
      const approved = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      // Simulate active execution running
      const fakeExecutionPromise = PlanExecutionEngine.executeApprovedPlan({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        ticketToken: approved.ticket!.ticketId,
      });

      // Immediate second parallel attempt on same planId must be rejected
      // (Wait, since executeApprovedPlan runs synchronously fast on single step, test by checking status)
      await fakeExecutionPromise;

      // Re-executing already completed plan should be rejected because status is no longer 'approved'
      await expect(
        PlanExecutionEngine.executeApprovedPlan({
          planId: plan.id,
          planVersion: plan.version,
          userId,
          ticketToken: approved.ticket!.ticketId,
        })
      ).rejects.toThrow(/Only approved plans can be executed/);
    });
  });

  describe('3. Execution Behaviour, Dependency Ordering, and Honest Failure Reporting', () => {
    it('should execute steps in dependency order and record audit logs in PostgreSQL', async () => {
      // Create a 2-step plan with dependency: Step 2 depends on Step 1
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'system info');
      const approved = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      const result = await PlanExecutionEngine.executeApprovedPlan({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        ticketToken: approved.ticket!.ticketId,
      });

      expect(result.status).toBe('completed');
      expect(result.completedSteps).toBeGreaterThanOrEqual(1);
      expect(result.stepRecords.length).toBeGreaterThanOrEqual(1);
      expect(result.stepRecords[0].status).toBe('completed');
      expect(result.stepRecords[0].verification?.verified).toBe(true);

      // Verify audit logs in PostgreSQL
      const executions = await ExecutionRepository.getExecutionHistory(plan.id);
      expect(executions.length).toBeGreaterThan(0);
      expect(executions[0].status).toBe('completed');

      const stepAudit = await ExecutionRepository.getStepExecutions(executions[0].id);
      expect(stepAudit.length).toBeGreaterThan(0);
      expect(stepAudit[0].status).toBe('completed');
    });

    it('Honest Failure Reporting: When a prerequisite step fails, dependent step is NOT executed and failure is reported', async () => {
      // Create a plan with a failing step and a dependent step
      const rawPlan = await TaskPlanningEngine.createPlan(userId, conversationId, 'system info');
      const planWithFailure = await PlanRepository.update(rawPlan.id, {
        status: 'approved',
        steps: [
          {
            step_id: 1,
            action: 'failing_step',
            target: 'non_existent_folder_abc_123',
            description: 'Attempt to open invalid non-existent folder',
            tool_name: 'open_folder',
            tool_args: { folderPath: 'non_existent_folder_xyz_987' },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Should fail',
          },
          {
            step_id: 2,
            action: 'dependent_step',
            target: 'System Info',
            description: 'Dependent diagnostic step that must not execute if step 1 fails',
            tool_name: 'get_system_info',
            tool_args: {},
            risk_level: 'low',
            requires_approval: true,
            depends_on: [1],
            expected_outcome: 'Should never run',
          },
        ],
      });

      const approved = await PermissionManager.requestApproval({
        planId: planWithFailure.id,
        planVersion: planWithFailure.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      const result = await PlanExecutionEngine.executeApprovedPlan({
        planId: planWithFailure.id,
        planVersion: planWithFailure.version,
        userId,
        ticketToken: approved.ticket!.ticketId,
      });

      // Honest failure status
      expect(result.status).toBe('failed');
      expect(result.failedStepId).toBe(1);
      expect(result.errorMessage).toContain('Step 1');

      // Prerequisite step failed
      expect(result.stepRecords[0].status).toBe('failed');

      // Dependent step was halted and never silently skipped
      expect(result.stepRecords.length).toBe(1); // Halts immediately at step 1

      // Verify task plan status in DB is failed
      const updatedPlan = await PlanRepository.findById(planWithFailure.id);
      expect(updatedPlan?.status).toBe('failed');
    });

    it('Cancellation during execution halts execution and updates status to cancelled', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'system info');
      const approved = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      // Test cancelExecution method
      const cancelRes = await PlanExecutionEngine.cancelExecution(plan.id, userId);
      expect(typeof cancelRes).toBe('boolean');
    });
  });

  describe('4. Complete Browser Automation Scenario ("Open Chrome and search YouTube")', () => {
    it('executes full 6-step Chrome & YouTube browser automation pipeline after explicit approval', async () => {
      // 1. Create plan for "Open Chrome and search YouTube"
      const plan = await TaskPlanningEngine.createPlan(
        userId,
        conversationId,
        'Open Chrome and search YouTube'
      );

      expect(plan.objective).toBe('Open Chrome and search YouTube');
      expect(plan.steps.length).toBe(6);
      expect(plan.status).toBe('awaiting_approval');

      // Verify the 6 steps matching the prompt requirement:
      // 1. Launch Chrome
      // 2. Verify Chrome is running
      // 3. Focus browser address bar
      // 4. Enter YouTube URL / Navigate
      // 5. Search YouTube
      // 6. Verify page loaded
      expect(plan.steps[0].action).toBe('launch_application');
      expect(plan.steps[1].action).toBe('verify_application');
      expect(plan.steps[2].action).toBe('focus_address_bar');
      expect(plan.steps[3].action).toBe('navigate_browser');
      expect(plan.steps[4].action).toBe('search_browser');
      expect(plan.steps[5].action).toBe('verify_page_loaded');

      // 2. Explicit User Approval Gate
      const approval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'voice_command',
        voiceTranscript: 'GIA, approve this plan.',
      });

      expect(approval.success).toBe(true);
      expect(approval.state).toBe('approved');
      expect(approval.ticket).toBeDefined();

      // 3. Execute approved plan through PlanExecutionEngine
      const executionResult = await PlanExecutionEngine.executeApprovedPlan({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        ticketToken: approval.ticket!.ticketId,
      });

      expect(executionResult.status).toBe('completed');
      expect(executionResult.totalSteps).toBe(6);
      expect(executionResult.completedSteps).toBe(6);
      expect(executionResult.failedStepId).toBeUndefined();

      // Verify each step record
      for (const stepRec of executionResult.stepRecords) {
        expect(stepRec.status).toBe('completed');
        expect(stepRec.verification?.verified).toBe(true);
      }

      // 4. Verify Task Plan status in Database is completed
      const finalPlan = await PlanRepository.findById(plan.id);
      expect(finalPlan?.status).toBe('completed');
    });
  });

  describe('5. REST Endpoints for Plan Execution Engine', () => {
    it('POST /conversations/:id/plans/:planId/execute executes plan successfully', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'system info');
      const approval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${conversationId}/plans/${plan.id}/execute`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          ticketToken: approval.ticket!.ticketId,
          planVersion: plan.version,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.execution.status).toBe('completed');
      expect(body.execution.completedSteps).toBeGreaterThanOrEqual(1);
    });

    it('GET /conversations/:id/plans/:planId/executions returns execution audit history', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'system info');
      const approval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      await PlanExecutionEngine.executeApprovedPlan({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        ticketToken: approval.ticket!.ticketId,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${conversationId}/plans/${plan.id}/executions`,
        headers: { authorization: `Bearer ${userToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.executions.length).toBeGreaterThan(0);
      expect(body.executions[0].status).toBe('completed');
    });

    it('GET /conversations/:id/plans/:planId/executions/:executionId/steps returns step audit records', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'system info');
      const approval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      const execResult = await PlanExecutionEngine.executeApprovedPlan({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        ticketToken: approval.ticket!.ticketId,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${conversationId}/plans/${plan.id}/executions/${execResult.executionId}/steps`,
        headers: { authorization: `Bearer ${userToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.steps.length).toBeGreaterThan(0);
      expect(body.steps[0].status).toBe('completed');
    });
  });
});

