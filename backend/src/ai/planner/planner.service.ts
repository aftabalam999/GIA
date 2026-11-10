import { randomUUID } from 'crypto';
import { LLMGateway } from '../router/index.js';
import {
  ExecutionPlan,
  ExecutionPlanSchema,
  PlanStep,
  PlanStepSchema,
  PlanIntentResult,
} from './planner.interface.js';
import { PlanRepository } from './plan.repository.js';
import { logger } from '../../shared/logger.js';

export class TaskPlanningEngine {
  /**
   * Generates a new structured execution plan from a user instruction.
   * STRICT SAFETY RESTRICTION: The planner NEVER executes tools, shell commands, or accesses the filesystem.
   */
  static async createPlan(
    userId: string,
    conversationId: string,
    instruction: string,
    _contextHistory?: any[]
  ): Promise<ExecutionPlan> {
    const trimmed = instruction.trim();

    // 1. Check for ambiguous instructions
    if (this.isAmbiguousInstruction(trimmed)) {
      const planId = randomUUID();
      const trimmedLower = trimmed.toLowerCase();
      const isFolderAmbiguous =
        /\b(?:make|create|new|build|generate|add)\b(?:\s+(?:a|an|one|new|another|me|the|[0-9]+))*\s+(?:folder|directory)\b/i.test(trimmedLower) ||
        /\b(?:folder|directory)\b.*\b(?:banao|bana\s+do|bana\s+de|create\s+karo|make|create)\b/i.test(trimmedLower);
      const isBrowserAmbiguous =
        /^(?:(?:can\s+you\s+|please\s+)?(?:open|launch|start)\s+(?:a|the|my)?\s*(?:web\s*)?browser\b)/i.test(trimmedLower);
      const isSearchAmbiguous =
        /^(?:(?:can\s+you\s+|please\s+)?search\s+(?:something\s+)?(?:on\s+(?:the\s+)?(?:internet|web|google)|online)?)$/i.test(trimmedLower) ||
        trimmedLower === 'search something' ||
        trimmedLower === 'search something on the internet' ||
        trimmedLower === 'search the internet' ||
        trimmedLower === 'search the web' ||
        trimmedLower === 'search online';

      let targetLocation = 'Desktop';
      if (trimmedLower.includes('document')) targetLocation = 'Documents';
      if (trimmedLower.includes('download')) targetLocation = 'Downloads';

      let objective = trimmed;
      if (isFolderAmbiguous) objective = `Create folder on ${targetLocation}`;
      else if (isBrowserAmbiguous) objective = 'Open web browser';
      else if (isSearchAmbiguous) objective = 'Search the web';

      let description = 'Awaiting user clarification before proceeding with task planning';
      let expectedOutcome = 'Clarification received from user';
      if (isFolderAmbiguous) {
        description = 'Awaiting folder name clarification from user';
        expectedOutcome = 'Folder name provided by user';
      } else if (isBrowserAmbiguous) {
        description = 'Awaiting browser selection from user';
        expectedOutcome = 'Browser choice provided by user';
      } else if (isSearchAmbiguous) {
        description = 'Awaiting search query from user';
        expectedOutcome = 'Search query provided by user';
      }

      const ambiguousPlan: ExecutionPlan = {
        id: planId,
        conversation_id: conversationId,
        user_id: userId,
        objective,
        status: 'awaiting_approval',
        is_ambiguous: true,
        clarification_question: this.generateClarificationQuestion(trimmed),
        steps: [
          {
            step_id: 1,
            action: 'await_clarification',
            target: isFolderAmbiguous ? targetLocation : '',
            description,
            tool_name: undefined,
            tool_args: {},
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: expectedOutcome,
          },
        ],
        approval: {
          required: true,
          approved: false,
          approved_at: null,
          feedback: null,
        },
        metadata: {
          original_instruction: trimmed,
          ...(isFolderAmbiguous
            ? { pending_action: 'create_directory', target_location: targetLocation, missing_param: 'folder_name' }
            : {}),
          ...(isBrowserAmbiguous
            ? { pending_action: 'open_browser', missing_param: 'browser_name' }
            : {}),
          ...(isSearchAmbiguous
            ? { pending_action: 'search_browser', missing_param: 'search_query' }
            : {}),
        },
        version: 1,
      };

      const saved = await PlanRepository.create(ambiguousPlan);
      return saved;
    }

    // 2. Deterministic planner for common direct patterns (instant, zero-latency)
    const deterministicSteps = this.generateDeterministicSteps(trimmed);
    if (deterministicSteps) {
      const planId = randomUUID();
      const plan: ExecutionPlan = {
        id: planId,
        conversation_id: conversationId,
        user_id: userId,
        objective: deterministicSteps.objective,
        status: 'awaiting_approval',
        is_ambiguous: false,
        clarification_question: null,
        steps: deterministicSteps.steps,
        approval: {
          required: true,
          approved: false,
          approved_at: null,
          feedback: null,
        },
        metadata: { original_instruction: trimmed, planner_type: 'deterministic' },
        version: 1,
      };

      const validated = this.validatePlan(plan);
      return PlanRepository.create(validated);
    }

    // 3. LLM-based autonomous task decomposition using Qwen
    const prompt = `You are the GIA Autonomous Task Planning Engine.
Your ONLY role is to break down the user's natural language instruction into an atomic, dependency-ordered execution plan.
STRICT RESTRICTION: You NEVER execute actions, shell commands, or tools. You ONLY output a validated JSON plan.

Instruction: "${trimmed}"

Output a single JSON object matching this schema:
{
  "objective": "Concise summary of the user's actual goal",
  "is_ambiguous": boolean,
  "clarification_question": string or null,
  "steps": [
    {
      "step_id": number (starting at 1),
      "action": "short action verb phrase (e.g. launch_application, navigate_browser, verify_browser, read_file)",
      "target": "target app, url, or path",
      "description": "Clear explanation of what this atomic step does",
      "tool_name": "open_application" | "open_url" | "open_file_or_folder" | "list_directory" | "read_file_content" | "search_files" | "get_system_info" | null,
      "tool_args": object with tool arguments,
      "risk_level": "low" | "medium" | "high" | "critical",
      "requires_approval": true,
      "depends_on": array of previous step_id numbers that must finish first (e.g. []),
      "expected_outcome": "Expected state after successful step execution"
    }
  ]
}

Constraints:
- Break complex tasks into atomic sequential steps (e.g., launch app -> wait/verify -> navigate -> verify).
- All steps must set "requires_approval": true.
- Output ONLY valid JSON. No markdown fences. No other text.`;

    try {
      const response = await LLMGateway.generate(
        {
          systemPrompt: 'You are an autonomous AI task planner. You generate structured JSON execution plans.',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          responseFormat: 'json',
          maxTokens: 500,
          enableThinking: false,
        },
        { modelType: 'reasoning' }
      );

      const parsed = JSON.parse(response.content);
      const planId = randomUUID();

      const candidatePlan: ExecutionPlan = {
        id: planId,
        conversation_id: conversationId,
        user_id: userId,
        objective: parsed.objective || trimmed,
        status: 'awaiting_approval',
        is_ambiguous: Boolean(parsed.is_ambiguous),
        clarification_question: parsed.clarification_question || null,
        steps: (parsed.steps || []).map((s: any, idx: number) => ({
          step_id: s.step_id || idx + 1,
          action: s.action || 'execute_action',
          target: s.target || '',
          description: s.description || `Step ${idx + 1}`,
          tool_name: s.tool_name || undefined,
          tool_args: s.tool_args || {},
          risk_level: ['low', 'medium', 'high', 'critical'].includes(s.risk_level) ? s.risk_level : 'low',
          requires_approval: true,
          depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
          expected_outcome: s.expected_outcome || '',
        })),
        approval: {
          required: true,
          approved: false,
          approved_at: null,
          feedback: null,
        },
        metadata: { original_instruction: trimmed, planner_type: 'llm' },
        version: 1,
      };

      const validated = this.validatePlan(candidatePlan);
      return PlanRepository.create(validated);
    } catch (err: any) {
      logger.error({ msg: 'Planning engine LLM generation failed, falling back to safe fallback plan', err: err.message });
      // Safe fallback plan creation
      const planId = randomUUID();
      const fallbackPlan: ExecutionPlan = {
        id: planId,
        conversation_id: conversationId,
        user_id: userId,
        objective: trimmed,
        status: 'awaiting_approval',
        is_ambiguous: false,
        clarification_question: null,
        steps: [
          {
            step_id: 1,
            action: 'execute_instruction',
            target: trimmed,
            description: `Execute requested instruction: "${trimmed}"`,
            tool_name: undefined,
            tool_args: {},
            risk_level: 'medium',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Instruction executed after approval',
          },
        ],
        approval: {
          required: true,
          approved: false,
          approved_at: null,
          feedback: null,
        },
        metadata: { original_instruction: trimmed, fallback: true },
        version: 1,
      };

      return PlanRepository.create(this.validatePlan(fallbackPlan));
    }
  }

  /**
   * Modifies an existing pending plan based on user feedback without executing anything.
   */
  static async modifyPlan(existingPlan: ExecutionPlan, userFeedback: string): Promise<ExecutionPlan> {
    const feedbackLower = userFeedback.toLowerCase().trim();

    // 0a. Handle ambiguous browser selection resolution (e.g. user specifying "Chrome", "Brave", etc.)
    if (existingPlan.is_ambiguous && existingPlan.metadata?.missing_param === 'browser_name') {
      let browserName = userFeedback.trim().replace(/[.,!?;]+$/, '').trim();
      browserName = browserName.replace(/^(?:open\s+|use\s+|launch\s+|the\s+)/i, '').trim();
      browserName = browserName.replace(/^["']|["']$/g, '').trim();

      const lower = browserName.toLowerCase();
      const resolvedBrowser = ['chrome', 'google chrome'].includes(lower)
        ? 'Google Chrome'
        : ['brave', 'brave browser'].includes(lower)
        ? 'Brave Browser'
        : ['safari'].includes(lower)
        ? 'Safari'
        : ['default', 'default browser'].includes(lower)
        ? 'Google Chrome'
        : browserName || 'Google Chrome';

      const resolvedSteps: PlanStep[] = [
        {
          step_id: 1,
          action: 'open_browser',
          target: resolvedBrowser,
          description: `Launch ${resolvedBrowser} on desktop`,
          tool_name: 'open_browser',
          tool_args: { browser: resolvedBrowser },
          risk_level: 'low',
          requires_approval: true,
          depends_on: [],
          expected_outcome: `${resolvedBrowser} launched and active`,
        },
        {
          step_id: 2,
          action: 'verify_browser',
          target: resolvedBrowser,
          description: `Verify ${resolvedBrowser} is running`,
          tool_name: undefined,
          tool_args: { browser: resolvedBrowser },
          risk_level: 'low',
          requires_approval: true,
          depends_on: [1],
          expected_outcome: `${resolvedBrowser} process verified`,
        },
      ];

      return PlanRepository.update(existingPlan.id, {
        objective: `Launch ${resolvedBrowser}`,
        status: 'awaiting_approval',
        is_ambiguous: false,
        clarification_question: null,
        steps: resolvedSteps,
        approval: { required: true, approved: false, approved_at: null, feedback: userFeedback },
        metadata: {
          ...existingPlan.metadata,
          missing_param: null,
          browser_name: resolvedBrowser,
          resolved_at: new Date().toISOString(),
        },
      });
    }

    // 0b. Handle ambiguous search query resolution (e.g. user specifying search query)
    if (existingPlan.is_ambiguous && existingPlan.metadata?.missing_param === 'search_query') {
      let query = userFeedback.trim().replace(/[.,!?;]+$/, '').trim();
      query = query.replace(/^(?:search\s+(?:for\s+)?|look\s+up\s+|find\s+)/i, '').trim();
      query = query.replace(/^["']|["']$/g, '').trim();

      const browser = (existingPlan.metadata?.browser_name as string) || undefined;
      const resolvedSteps: PlanStep[] = [
        {
          step_id: 1,
          action: 'search_browser',
          target: query,
          description: `Search for "${query}" on web browser`,
          tool_name: 'search_browser',
          tool_args: { query, engine: 'google', browser },
          risk_level: 'low',
          requires_approval: true,
          depends_on: [],
          expected_outcome: `Web browser navigated to search results for "${query}"`,
        },
        {
          step_id: 2,
          action: 'verify_browser',
          target: query,
          description: `Verify browser search for "${query}"`,
          tool_name: undefined,
          tool_args: { query, browser },
          risk_level: 'low',
          requires_approval: true,
          depends_on: [1],
          expected_outcome: 'Search results displayed in browser',
        },
      ];

      return PlanRepository.update(existingPlan.id, {
        objective: `Search "${query}" on web browser`,
        status: 'awaiting_approval',
        is_ambiguous: false,
        clarification_question: null,
        steps: resolvedSteps,
        approval: { required: true, approved: false, approved_at: null, feedback: userFeedback },
        metadata: {
          ...existingPlan.metadata,
          missing_param: null,
          search_query: query,
          resolved_at: new Date().toISOString(),
        },
      });
    }

    // 0c. Handle ambiguous folder name resolution (e.g. user specifying folder name)
    if (existingPlan.metadata?.missing_param === 'folder_name' || (existingPlan.is_ambiguous && !existingPlan.metadata?.missing_param)) {
      let folderName = userFeedback.trim();
      // Strip trailing punctuation
      folderName = folderName.replace(/[.,!?;]+$/, '').trim();
      // Strip conversational prefixes
      folderName = folderName
        .replace(/^(?:name\s+it\s+|call\s+it\s+|named\s+|it['’]?s\s+|the\s+name\s+is\s+|folder\s+name\s+is\s+)/i, '')
        .trim();
      folderName = folderName.replace(/^["']|["']$/g, '').trim();

      const targetLocation = (existingPlan.metadata?.target_location as string) || 'Desktop';

      if (folderName.length > 0) {
        const resolvedSteps: PlanStep[] = [
          {
            step_id: 1,
            action: 'create_directory',
            target: `${targetLocation}/${folderName}`,
            description: `Create directory "${folderName}" on ${targetLocation}`,
            tool_name: 'create_directory',
            tool_args: { directoryPath: targetLocation, folderName },
            risk_level: 'medium',
            requires_approval: true,
            depends_on: [],
            expected_outcome: `Directory "${folderName}" created successfully on ${targetLocation}`,
          },
          {
            step_id: 2,
            action: 'verify_directory',
            target: `${targetLocation}/${folderName}`,
            description: `Verify directory "${folderName}" exists on disk`,
            tool_name: undefined,
            tool_args: { directoryPath: targetLocation, folderName },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [1],
            expected_outcome: `Directory "${folderName}" verified on filesystem`,
          },
        ];

        return PlanRepository.update(existingPlan.id, {
          objective: `Create folder "${folderName}" on ${targetLocation}`,
          status: 'awaiting_approval',
          is_ambiguous: false,
          clarification_question: null,
          steps: resolvedSteps,
          approval: { required: true, approved: false, approved_at: null, feedback: userFeedback },
          metadata: {
            ...existingPlan.metadata,
            missing_param: null,
            folder_name: folderName,
            resolved_at: new Date().toISOString(),
          },
        });
      }
    }

    // 1. Check for step removal: "remove step 2", "delete the second step", "drop step 1"
    const removeMatch = feedbackLower.match(/(?:remove|delete|drop|omit)\s+(?:the\s+)?(?:step\s+(\d+)|second\s+step|third\s+step|first\s+step|last\s+step)/i);
    if (removeMatch) {
      let stepIndexToRemove = -1;
      if (removeMatch[1]) {
        stepIndexToRemove = parseInt(removeMatch[1], 10) - 1;
      } else if (feedbackLower.includes('first')) {
        stepIndexToRemove = 0;
      } else if (feedbackLower.includes('second')) {
        stepIndexToRemove = 1;
      } else if (feedbackLower.includes('third')) {
        stepIndexToRemove = 2;
      } else if (feedbackLower.includes('last')) {
        stepIndexToRemove = existingPlan.steps.length - 1;
      }

      if (stepIndexToRemove >= 0 && stepIndexToRemove < existingPlan.steps.length && existingPlan.steps.length > 1) {
        const updatedSteps = existingPlan.steps
          .filter((_, idx) => idx !== stepIndexToRemove)
          .map((s, idx) => ({ ...s, step_id: idx + 1 }));

        const updated = await PlanRepository.update(existingPlan.id, {
          steps: updatedSteps,
          approval: { required: true, approved: false, approved_at: null, feedback: userFeedback },
          metadata: { ...existingPlan.metadata, last_modification: userFeedback },
        });
        return updated;
      }
    }

    // 2. Check for step replacement: "don't open X, open Y", "instead of X, open Y", "change target to Y"
    const replaceMatch = feedbackLower.match(/(?:don't|do not|instead of)\s+(?:open|navigate to|run)?\s*([a-zA-Z0-9._:/-]+)(?:,|\s+)?\s*(?:open|run|navigate to|use)?\s*([a-zA-Z0-9._:/-]+)/i);
    if (replaceMatch) {
      const oldTarget = replaceMatch[1].trim();
      const newTarget = replaceMatch[2].trim();

      const updatedSteps = existingPlan.steps.map((s) => {
        if (s.target.toLowerCase().includes(oldTarget) || s.description.toLowerCase().includes(oldTarget)) {
          return {
            ...s,
            target: newTarget,
            description: s.description.replace(new RegExp(oldTarget, 'gi'), newTarget),
            expected_outcome: s.expected_outcome.replace(new RegExp(oldTarget, 'gi'), newTarget),
          };
        }
        return s;
      });

      const updatedObjective = existingPlan.objective.replace(new RegExp(oldTarget, 'gi'), newTarget);
      return PlanRepository.update(existingPlan.id, {
        objective: updatedObjective,
        steps: updatedSteps,
        approval: { required: true, approved: false, approved_at: null, feedback: userFeedback },
        metadata: { ...existingPlan.metadata, last_modification: userFeedback },
      });
    }

    // 3. Check for step append: "also open Y", "add another step to open Y"
    const appendMatch = feedbackLower.match(/(?:also\s+(?:open|launch|navigate to|run)|add\s+(?:another\s+)?step\s+(?:to\s+)?(?:open|run|navigate to)?)\s*([a-zA-Z0-9._:/-]+)/i);
    if (appendMatch) {
      const targetToAdd = appendMatch[1].trim();
      const newStepId = existingPlan.steps.length + 1;
      const isUrl = targetToAdd.startsWith('http') || targetToAdd.includes('.com') || targetToAdd.includes('.org');

      const newStep: PlanStep = {
        step_id: newStepId,
        action: isUrl ? 'navigate_browser' : 'launch_application',
        target: targetToAdd,
        description: isUrl ? `Navigate browser to ${targetToAdd}` : `Launch ${targetToAdd}`,
        tool_name: isUrl ? 'open_url' : 'open_application',
        tool_args: isUrl ? { url: targetToAdd } : { appName: targetToAdd },
        risk_level: 'low',
        requires_approval: true,
        depends_on: [newStepId - 1],
        expected_outcome: `${targetToAdd} opened and accessible`,
      };

      const updatedSteps = [...existingPlan.steps, newStep];
      return PlanRepository.update(existingPlan.id, {
        steps: updatedSteps,
        approval: { required: true, approved: false, approved_at: null, feedback: userFeedback },
        metadata: { ...existingPlan.metadata, last_modification: userFeedback },
      });
    }

    // 4. Fallback LLM-powered modification for complex feedback
    const prompt = `You are modifying an existing GIA execution plan based on user feedback.
Current Plan:
${JSON.stringify({ objective: existingPlan.objective, steps: existingPlan.steps }, null, 2)}

User Modification Request: "${userFeedback}"

Output the updated plan in JSON:
{
  "objective": "Updated objective",
  "steps": [
    {
      "step_id": number (starting at 1),
      "action": "action name",
      "target": "target app/file/url",
      "description": "step description",
      "tool_name": "tool name or null",
      "tool_args": {},
      "risk_level": "low" | "medium" | "high" | "critical",
      "requires_approval": true,
      "depends_on": [],
      "expected_outcome": "expected result"
    }
  ]
}`;

    try {
      const response = await LLMGateway.generate(
        {
          systemPrompt: 'You update structured execution plans according to user instructions. Output only JSON.',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          responseFormat: 'json',
          maxTokens: 500,
          enableThinking: false,
        },
        { modelType: 'reasoning' }
      );

      const parsed = JSON.parse(response.content);
      const validatedSteps = (parsed.steps || []).map((s: any, idx: number) => PlanStepSchema.parse({
        step_id: idx + 1,
        action: s.action || 'step',
        target: s.target || '',
        description: s.description || `Step ${idx + 1}`,
        tool_name: s.tool_name || undefined,
        tool_args: s.tool_args || {},
        risk_level: s.risk_level || 'low',
        requires_approval: true,
        depends_on: s.depends_on || [],
        expected_outcome: s.expected_outcome || '',
      }));

      return PlanRepository.update(existingPlan.id, {
        objective: parsed.objective || existingPlan.objective,
        steps: validatedSteps,
        approval: { required: true, approved: false, approved_at: null, feedback: userFeedback },
        metadata: { ...existingPlan.metadata, last_modification: userFeedback },
      });
    } catch {
      return existingPlan;
    }
  }

  /**
   * Explains what the plan or a specific step does without modifying or executing anything.
   */
  static explainPlan(plan: ExecutionPlan, stepId?: number): string {
    if (stepId !== undefined) {
      const step = plan.steps.find((s) => s.step_id === stepId);
      if (!step) {
        return `Step ${stepId} does not exist in plan "${plan.objective}". This plan has ${plan.steps.length} step(s).`;
      }
      return `### Explanation for Step ${step.step_id}: **${step.action}**\n` +
        `• **Target:** \`${step.target || 'None'}\`\n` +
        `• **Description:** ${step.description}\n` +
        `• **Tool:** \`${step.tool_name || 'Standard Orchestrator'}\`\n` +
        `• **Risk Level:** **${step.risk_level.toUpperCase()}**\n` +
        `• **Dependencies:** ${step.depends_on.length > 0 ? step.depends_on.map((d) => `Step ${d}`).join(', ') : 'None (can run immediately)'}\n` +
        `• **Expected Outcome:** ${step.expected_outcome}\n` +
        `\n*This step will NOT execute until you explicitly approve the plan.*`;
    }

    const stepExplanations = plan.steps
      .map(
        (s) =>
          `**Step ${s.step_id}: ${s.description}**\n` +
          `  - Target: \`${s.target || '-'}\` | Tool: \`${s.tool_name || 'System'}\` | Risk: *${s.risk_level}*\n` +
          `  - Expected Result: ${s.expected_outcome}`
      )
      .join('\n\n');

    return `### 🔍 Detailed Plan Breakdown for: **${plan.objective}**\n\n` +
      `**Plan ID:** \`${plan.id}\` (Version ${plan.version})\n` +
      `**Status:** ⏳ *${plan.status}*\n\n` +
      `${stepExplanations}\n\n` +
      `🛡️ **Safety Guarantee:** GIA will wait for your explicit approval before performing any of these steps.`;
  }

  /**
   * Formats the plan into an elegant, human-readable markdown presentation for the chat interface.
   */
  static presentPlan(plan: ExecutionPlan): string {
    if (plan.is_ambiguous) {
      return `❓ **Clarification Needed for Your Request**\n\n` +
        `${plan.clarification_question || 'Your request is ambiguous. Could you please specify more details?'}\n\n` +
        `*Once you clarify, GIA will formulate a validated execution plan.*`;
    }

    const stepsList = plan.steps
      .map((s) => {
        const riskBadge = s.risk_level === 'critical'
          ? '🔴 [CRITICAL RISK]'
          : s.risk_level === 'high'
          ? '🟠 [HIGH RISK]'
          : s.risk_level === 'medium'
          ? '🟡 [MEDIUM RISK]'
          : '🟢 [LOW RISK]';

        const toolBadge = s.tool_name ? ` 🔧 \`${s.tool_name}\`` : '';
        const targetBadge = s.target ? ` • Target: \`${s.target}\`` : '';
        const deps = s.depends_on.length > 0 ? ` *(depends on Step ${s.depends_on.join(', ')})*` : '';

        return `**${s.step_id}. ${s.description}**${targetBadge}${toolBadge}\n` +
          `   ↳ ${riskBadge}${deps}\n` +
          `   ↳ *Expected Outcome:* ${s.expected_outcome || 'Success'}`;
      })
      .join('\n\n');

    return `📋 **Execution Plan Formulated: "${plan.objective}"**\n` +
      `*Plan ID: \`${plan.id}\` • Version: ${plan.version} • Status: ⏳ Awaiting Approval*\n\n` +
      `${stepsList}\n\n` +
      `---\n` +
      `⚠️ **Explicit Approval Required**\n` +
      `In accordance with GIA's Plan-First architecture, no action has been executed yet.\n\n` +
      `• Type **"Approved"** or **"Proceed"** to execute this plan.\n` +
      `• Or tell me how to adjust it (e.g., *"Also open YouTube"*, *"Remove step 2"*, *"Explain step 1"*).`;
  }

  /**
   * Classifies user input intent regarding task planning.
   */
  static classifyIntent(userInput: string, hasActivePlan: boolean, activePlan?: ExecutionPlan): PlanIntentResult {
    const text = userInput.trim().toLowerCase();

    // 1. Approval triggers
    if (
      hasActivePlan &&
      /^(?:yes|y|proceed|approve|approved|go ahead|looks good|execute|run plan|confirm|do it)\b/i.test(text)
    ) {
      return { intent: 'approve_plan', reason: 'User explicitly approved pending plan execution.' };
    }

    // 2. Rejection triggers
    if (
      hasActivePlan &&
      /^(?:no|n|cancel|reject|rejected|abort|stop|discard plan|forget it)\b/i.test(text)
    ) {
      return { intent: 'reject_plan', reason: 'User explicitly cancelled or rejected pending plan.' };
    }

    // 3. Explanation triggers: "explain step 2", "explain what this action does", "why step 1"
    const explainMatch = text.match(/(?:explain|what does|why do we need)\s+(?:what\s+)?(?:step\s+(\d+)|action\s+(\d+)|this\s+action|this\s+plan|the\s+plan)/i);
    if (hasActivePlan && explainMatch) {
      const stepNum = explainMatch[1] || explainMatch[2];
      return {
        intent: 'explain_plan',
        reason: 'User requested explanation of plan or step.',
        stepIdToExplain: stepNum ? parseInt(stepNum, 10) : undefined,
      };
    }

    // 4. Ambiguous plan clarification / missing parameter triggers
    if (hasActivePlan && activePlan && (activePlan.is_ambiguous || activePlan.metadata?.missing_param)) {
      return {
        intent: 'modify_plan',
        reason: 'User provided clarification for missing parameter in pending ambiguous plan.',
      };
    }

    // 5. Modification triggers
    if (
      hasActivePlan &&
      (
        text.startsWith('also ') ||
        text.startsWith("don't ") ||
        text.startsWith('do not ') ||
        text.startsWith('instead ') ||
        text.startsWith('remove ') ||
        text.startsWith('delete ') ||
        text.startsWith('add ') ||
        text.startsWith('change ') ||
        text.includes('another step') ||
        text.includes('second step') ||
        text.includes('first step')
      )
    ) {
      return { intent: 'modify_plan', reason: 'User requested modifications to pending plan.' };
    }

    // 5. Actionable command triggers (Create new plan)
    const isActionable = this.isActionableInstruction(text);
    if (isActionable) {
      return { intent: 'create_plan', reason: 'User requested an actionable instruction requiring task planning.' };
    }

    return { intent: 'conversational', reason: 'General conversation or query.' };
  }

  /**
   * Validates a plan against the strict ExecutionPlanSchema.
   */
  static validatePlan(rawPlan: unknown): ExecutionPlan {
    const parsed = ExecutionPlanSchema.safeParse(rawPlan);
    if (!parsed.success) {
      throw new Error(`Plan validation failed: ${JSON.stringify(parsed.error.format())}`);
    }
    return parsed.data;
  }

  // --- PRIVATE HELPERS ---

  private static isAmbiguousInstruction(text: string): boolean {
    const lower = text.toLowerCase().trim();
    const ambiguousPhrases = [
      'open it',
      'launch it',
      'run it',
      'delete it',
      'open that',
      'do it',
      'open that app',
      'run the program',
      'open the thing',
      'check it',
    ];

    if (ambiguousPhrases.includes(lower) || lower.length < 4) {
      return true;
    }

    // Check if user is asking to create/make a folder or directory without providing the folder name
    const isFolderCommand =
      /\b(?:make|create|new|build|generate|add)\b(?:\s+(?:a|an|one|new|another|me|the|[0-9]+))*\s+(?:folder|directory)\b/i.test(lower) ||
      /\b(?:folder|directory)\b.*\b(?:banao|bana\s+do|bana\s+de|create\s+karo|make|create)\b/i.test(lower);

    if (isFolderCommand) {
      // Check if folder name is provided via named/called/with name or direct word
      const namedMatch = text.match(
        /(?:named|called|with\s+(?:the\s+)?name(?:\s+of)?|naam(?:\s+se|\s+ka)?)\s+["']?([^"'\s.,;]+)["']?/i
      );
      if (namedMatch && namedMatch[1] && namedMatch[1].trim().length > 0) {
        return false;
      }
      const directMatch = text.match(
        /(?:make|create|new|build)\s+(?:a\s+|an\s+|one\s+|new\s+|another\s+|the\s+)?(?:folder|directory)\s+["']?([^"'\s]+)["']?(?:\s+(?:on|in|at)\s+(?:the\s+)?(?:desktop|downloads|documents))?/i
      );
      if (directMatch && directMatch[1]) {
        const candidate = directMatch[1].trim().toLowerCase();
        const skipWords = ['on', 'in', 'at', 'the', 'desktop', 'documents', 'downloads', 'named', 'called', 'here'];
        if (!skipWords.includes(candidate)) {
          return false;
        }
      }
      return true; // Folder creation without a valid folder name is ambiguous!
    }

    // Generic browser opening without specifying which browser
    const isGenericOpenBrowser =
      /^(?:(?:can\s+you\s+|please\s+)?(?:open|launch|start)\s+(?:a|the|my)?\s*(?:web\s*)?browser\b)/i.test(lower) &&
      !lower.includes('chrome') &&
      !lower.includes('brave') &&
      !lower.includes('safari') &&
      !lower.includes('firefox') &&
      !lower.includes('edge');
    if (isGenericOpenBrowser) {
      return true;
    }

    // Generic search without a specific query
    const isGenericSearch =
      /^(?:(?:can\s+you\s+|please\s+)?search\s+(?:something\s+)?(?:on\s+(?:the\s+)?(?:internet|web|google)|online)?)$/i.test(lower) ||
      lower === 'search something' ||
      lower === 'search something on the internet' ||
      lower === 'search the internet' ||
      lower === 'search the web' ||
      lower === 'search online';
    if (isGenericSearch) {
      return true;
    }

    return false;
  }

  private static generateClarificationQuestion(text: string): string {
    const lower = text.toLowerCase();
    if (lower.includes('folder') || lower.includes('directory')) {
      return 'What would you like to name this folder?';
    }
    if (/browser/i.test(lower) && (lower.includes('open') || lower.includes('launch') || lower.includes('start'))) {
      return 'Which browser would you like me to open? Google Chrome, Brave Browser, or your default browser?';
    }
    if (lower.includes('search')) {
      return 'What would you like me to search for?';
    }
    if (lower.includes('open') || lower.includes('launch')) {
      return 'Which specific application, file, or website would you like me to open?';
    }
    if (lower.includes('delete') || lower.includes('remove')) {
      return 'Which specific file or item would you like me to remove?';
    }
    if (lower.includes('run')) {
      return 'Which project, script, or program would you like me to run?';
    }
    return 'Could you please provide more details on what you would like to accomplish?';
  }

  public static isActionableInstruction(text: string): boolean {
    let lower = text.toLowerCase().trim();

    // Strip common conversational / polite prefixes
    lower = lower
      .replace(/^(?:can\s+you\s+(?:please\s+)?|could\s+you\s+(?:please\s+)?|please\s+|kindly\s+|gia,?\s*(?:please\s+)?|hey\s+gia,?\s*)/i, '')
      .trim();

    // Browser tab commands and navigation controls
    if (
      lower.startsWith('new tab') ||
      lower.startsWith('close tab') ||
      lower.startsWith('go back') ||
      lower.startsWith('go forward') ||
      lower.startsWith('refresh') ||
      lower.startsWith('reload') ||
      lower === 'back' ||
      lower === 'forward'
    ) {
      return true;
    }

    // Pure questions or conversational chit-chat are NOT actionable instructions
    if (
      lower.startsWith('what is') ||
      lower.startsWith('what are') ||
      lower.startsWith('who is') ||
      lower.startsWith('who are') ||
      lower.startsWith('who am i') ||
      lower.startsWith('how do') ||
      lower.startsWith('how does') ||
      lower.startsWith('why is') ||
      lower.startsWith('why do') ||
      lower.startsWith('tell me about') ||
      lower.startsWith('explain') ||
      lower.includes('recursion') ||
      lower.includes('javascript')
    ) {
      return false;
    }

    // Action verbs and keywords
    return (
      lower.startsWith('open ') ||
      lower.startsWith('launch ') ||
      lower.startsWith('start ') ||
      lower.startsWith('run ') ||
      lower.startsWith('execute ') ||
      lower.startsWith('navigate ') ||
      lower.startsWith('visit ') ||
      lower.startsWith('browse ') ||
      lower.startsWith('search ') ||
      lower.startsWith('create folder') ||
      lower.startsWith('make folder') ||
      lower.startsWith('make a folder') ||
      lower.startsWith('create a folder') ||
      lower.startsWith('new folder') ||
      lower.startsWith('create directory') ||
      lower.startsWith('make directory') ||
      lower.startsWith('make a directory') ||
      lower.startsWith('create a directory') ||
      lower.startsWith('new directory') ||
      /\b(?:make|create|new|build|generate|add)\b(?:\s+(?:a|an|one|new|another|me|the|[0-9]+))*\s+(?:folder|directory)\b/i.test(lower) ||
      /\b(?:folder|directory)\b.*\b(?:banao|bana\s+do|bana\s+de|create\s+karo|make|create)\b/i.test(lower) ||
      /\b(?:folder|directory)\s+creation\b/i.test(lower) ||
      lower.startsWith('create file') ||
      lower.startsWith('make file') ||
      lower.startsWith('write file') ||
      lower.startsWith('read file') ||
      lower.startsWith('delete file') ||
      lower.startsWith('remove file') ||
      lower.startsWith('list files') ||
      lower.startsWith('list directory') ||
      lower.startsWith('search for file') ||
      lower.startsWith('find file') ||
      lower.startsWith('close ') ||
      lower.startsWith('quit ') ||
      lower.startsWith('kill ') ||
      lower.startsWith('check battery') ||
      lower.startsWith('system info') ||
      lower.startsWith('take a screenshot') ||
      lower.startsWith('screenshot') ||
      lower.includes('vs code') ||
      lower.includes('vscode') ||
      lower.includes('chrome') ||
      lower.includes('youtube') ||
      lower.includes('terminal') ||
      lower.includes('calculator')
    );
  }

  private static generateDeterministicSteps(text: string): { objective: string; steps: PlanStep[] } | null {
    const lower = text.toLowerCase().trim();

    // Folder / Directory Creation Patterns (e.g. "Make a folder on desktop named Jasin-Gia-test")
    const isFolderCreation =
      /\b(?:make|create|new|build|generate|add)\b(?:\s+(?:a|an|one|new|another|me|the|[0-9]+))*\s+(?:folder|directory)\b/i.test(lower) ||
      /\b(?:folder|directory)\b.*\b(?:banao|bana\s+do|bana\s+de|create\s+karo|make|create)\b/i.test(lower) ||
      /\b(?:folder|directory)\s+creation\b/i.test(lower);

    if (isFolderCreation) {
      let targetLocation = 'Desktop';
      if (lower.includes('document')) targetLocation = 'Documents';
      if (lower.includes('download')) targetLocation = 'Downloads';

      let folderName: string | null = null;

      // Pattern 1: ... named/called/with name "XYZ" or XYZ
      const namedMatch = text.match(
        /(?:named|called|with\s+(?:the\s+)?name(?:\s+of)?|naam(?:\s+se|\s+ka)?)\s+["']?([^"'\s.,;]+)["']?/i
      );
      if (namedMatch && namedMatch[1] && namedMatch[1].trim().length > 0) {
        folderName = namedMatch[1].trim();
      }

      // Pattern 2: create folder XYZ on desktop / make folder XYZ
      if (!folderName) {
        const directMatch = text.match(
          /(?:make|create|new|build)\s+(?:a\s+|an\s+|one\s+|new\s+|another\s+|the\s+)?(?:folder|directory)\s+["']?([^"'\s]+)["']?(?:\s+(?:on|in|at)\s+(?:the\s+)?(?:desktop|downloads|documents))?/i
        );
        if (directMatch && directMatch[1]) {
          const candidate = directMatch[1].trim();
          const skipWords = ['on', 'in', 'at', 'the', 'desktop', 'documents', 'downloads', 'named', 'called', 'here'];
          if (!skipWords.includes(candidate.toLowerCase())) {
            folderName = candidate;
          }
        }
      }

      if (folderName) {
        folderName = folderName.replace(/[.,!?;]+$/, '').trim();
        return {
          objective: `Create folder "${folderName}" on ${targetLocation}`,
          steps: [
            {
              step_id: 1,
              action: 'create_directory',
              target: `${targetLocation}/${folderName}`,
              description: `Create directory "${folderName}" on ${targetLocation}`,
              tool_name: 'create_directory',
              tool_args: { directoryPath: targetLocation, folderName },
              risk_level: 'medium',
              requires_approval: true,
              depends_on: [],
              expected_outcome: `Directory "${folderName}" created successfully on ${targetLocation}`,
            },
            {
              step_id: 2,
              action: 'verify_directory',
              target: `${targetLocation}/${folderName}`,
              description: `Verify directory "${folderName}" exists on disk`,
              tool_name: undefined,
              tool_args: { directoryPath: targetLocation, folderName },
              risk_level: 'low',
              requires_approval: true,
              depends_on: [1],
              expected_outcome: `Directory "${folderName}" verified on filesystem`,
            },
          ],
        };
      }
    }

    // --- BROWSER AUTOMATION INTENTS ---

    // 1. Browser Tab Actions: New Tab
    const newTabMatch = lower.match(/^(?:(?:can\s+you\s+|please\s+)?(?:open|create)\s+(?:(?:a|another|the)\s+)?new\s+tab(?:\s+in\s+([a-zA-Z0-9\s]+))?|new\s+tab(?:\s+in\s+([a-zA-Z0-9\s]+))?)$/i);
    if (newTabMatch) {
      const rawBrowser = (newTabMatch[1] || newTabMatch[2] || '').trim().toLowerCase();
      const browser = rawBrowser ? (rawBrowser.includes('brave') ? 'Brave Browser' : 'Google Chrome') : undefined;
      return {
        objective: `Open new tab in ${browser || 'browser'}`,
        steps: [
          {
            step_id: 1,
            action: 'open_new_tab',
            target: browser || 'Browser',
            description: `Open new tab in ${browser || 'browser'}`,
            tool_name: 'browser_tab_action',
            tool_args: { action: 'new_tab', browser },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: `New tab created in ${browser || 'browser'}`,
          },
          {
            step_id: 2,
            action: 'verify_browser',
            target: browser || 'Browser',
            description: 'Verify new browser tab',
            tool_name: undefined,
            tool_args: { browser },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [1],
            expected_outcome: 'New tab active',
          },
        ],
      };
    }

    // 2. Browser Tab Actions: Close Tab
    const closeTabMatch = lower.match(/^(?:(?:can\s+you\s+|please\s+)?close\s+(?:(?:the|this)\s+)?(?:current\s+|active\s+)?tab(?:\s+in\s+([a-zA-Z0-9\s]+))?)$/i);
    if (closeTabMatch) {
      const rawBrowser = (closeTabMatch[1] || '').trim().toLowerCase();
      const browser = rawBrowser ? (rawBrowser.includes('brave') ? 'Brave Browser' : 'Google Chrome') : undefined;
      return {
        objective: `Close active tab in ${browser || 'browser'}`,
        steps: [
          {
            step_id: 1,
            action: 'close_tab',
            target: browser || 'Browser',
            description: `Close active tab in ${browser || 'browser'}`,
            tool_name: 'browser_tab_action',
            tool_args: { action: 'close_tab', browser },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Active tab closed',
          },
          {
            step_id: 2,
            action: 'verify_browser',
            target: browser || 'Browser',
            description: 'Verify tab closure',
            tool_name: undefined,
            tool_args: { browser },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [1],
            expected_outcome: 'Tab closed successfully',
          },
        ],
      };
    }

    // 3. Browser History: Back
    const backMatch = lower.match(/^(?:(?:can\s+you\s+|please\s+)?(?:go\s+back|browser\s+back|back(?:\s+in\s+browser)?))$/i);
    if (backMatch) {
      return {
        objective: 'Navigate back in browser history',
        steps: [
          {
            step_id: 1,
            action: 'browser_back',
            target: 'Browser History',
            description: 'Navigate back in browser history',
            tool_name: 'browser_tab_action',
            tool_args: { action: 'back' },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Previous page loaded in history',
          },
          {
            step_id: 2,
            action: 'verify_browser',
            target: 'Browser History',
            description: 'Verify navigation back',
            tool_name: undefined,
            tool_args: {},
            risk_level: 'low',
            requires_approval: true,
            depends_on: [1],
            expected_outcome: 'History navigation completed',
          },
        ],
      };
    }

    // 4. Browser History: Forward
    const forwardMatch = lower.match(/^(?:(?:can\s+you\s+|please\s+)?(?:go\s+forward|browser\s+forward|forward(?:\s+in\s+browser)?))$/i);
    if (forwardMatch) {
      return {
        objective: 'Navigate forward in browser history',
        steps: [
          {
            step_id: 1,
            action: 'browser_forward',
            target: 'Browser History',
            description: 'Navigate forward in browser history',
            tool_name: 'browser_tab_action',
            tool_args: { action: 'forward' },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Next page loaded in history',
          },
          {
            step_id: 2,
            action: 'verify_browser',
            target: 'Browser History',
            description: 'Verify navigation forward',
            tool_name: undefined,
            tool_args: {},
            risk_level: 'low',
            requires_approval: true,
            depends_on: [1],
            expected_outcome: 'Forward navigation completed',
          },
        ],
      };
    }

    // 5. Browser Tab Actions: Refresh / Reload
    const refreshMatch = lower.match(/^(?:(?:can\s+you\s+|please\s+)?(?:refresh|reload)\s+(?:the\s+|this\s+|current\s+|active\s+)?(?:page|tab|browser|website)(?:\s+in\s+([a-zA-Z0-9\s]+))?|(?:refresh|reload))$/i);
    if (refreshMatch) {
      const rawBrowser = (refreshMatch[1] || '').trim().toLowerCase();
      const browser = rawBrowser ? (rawBrowser.includes('brave') ? 'Brave Browser' : 'Google Chrome') : undefined;
      return {
        objective: `Refresh active tab in ${browser || 'browser'}`,
        steps: [
          {
            step_id: 1,
            action: 'browser_refresh',
            target: browser || 'Browser',
            description: `Reload active tab in ${browser || 'browser'}`,
            tool_name: 'browser_tab_action',
            tool_args: { action: 'refresh', browser },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Active page refreshed',
          },
          {
            step_id: 2,
            action: 'verify_browser',
            target: browser || 'Browser',
            description: 'Verify tab refresh',
            tool_name: undefined,
            tool_args: { browser },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [1],
            expected_outcome: 'Page reloaded successfully',
          },
        ],
      };
    }

    // 6. Direct Browser Launch (e.g. "Open Chrome", "Launch Brave", "Open Safari", "Open default browser")
    const browserLaunchMatch = lower.match(
      /^(?:(?:can\s+you\s+|please\s+)?(?:open|launch|start)\s+(?:the\s+)?(chrome|google\s+chrome|brave|brave\s+browser|safari|default\s+browser))$/i
    );
    if (browserLaunchMatch) {
      const b = browserLaunchMatch[1].toLowerCase();
      const resolvedBrowser = b.includes('brave')
        ? 'Brave Browser'
        : b.includes('safari')
        ? 'Safari'
        : 'Google Chrome';

      return {
        objective: `Launch ${resolvedBrowser}`,
        steps: [
          {
            step_id: 1,
            action: 'open_browser',
            target: resolvedBrowser,
            description: `Launch ${resolvedBrowser} on desktop`,
            tool_name: 'open_browser',
            tool_args: { browser: resolvedBrowser },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: `${resolvedBrowser} process launched and window active`,
          },
          {
            step_id: 2,
            action: 'verify_browser',
            target: resolvedBrowser,
            description: `Verify ${resolvedBrowser} is running on system`,
            tool_name: undefined,
            tool_args: { browser: resolvedBrowser },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [1],
            expected_outcome: `${resolvedBrowser} running successfully`,
          },
        ],
      };
    }

    // 7. Web Search / Search in Browser (e.g. "Search React documentation in Chrome", "Search YouTube in Chrome", "Search React hooks in Brave", "Search React documentation")
    const searchInBrowserMatch = text.match(
      /^(?:(?:can\s+you\s+|please\s+)?search\s+(?:for\s+)?(.+?)\s+(?:in|on|with|using)\s+(chrome|google\s+chrome|brave|brave\s+browser|safari|default\s+browser|browser))$/i
    );
    const inBrowserSearchMatch = text.match(
      /^(?:(?:in|on)\s+(chrome|google\s+chrome|brave|brave\s+browser|safari)\s+search\s+(?:for\s+)?(.+))$/i
    );
    const generalSearchMatch = text.match(
      /^(?:(?:can\s+you\s+|please\s+)?search\s+(?:for\s+|the\s+web\s+for\s+)?(.+))$/i
    );

    if (searchInBrowserMatch || inBrowserSearchMatch || generalSearchMatch) {
      let query = '';
      let targetBrowser: string | undefined = undefined;

      if (searchInBrowserMatch) {
        query = searchInBrowserMatch[1].trim();
        const b = searchInBrowserMatch[2].toLowerCase();
        if (b.includes('brave')) targetBrowser = 'Brave Browser';
        else if (b.includes('chrome')) targetBrowser = 'Google Chrome';
        else if (b.includes('safari')) targetBrowser = 'Safari';
      } else if (inBrowserSearchMatch) {
        const b = inBrowserSearchMatch[1].toLowerCase();
        if (b.includes('brave')) targetBrowser = 'Brave Browser';
        else if (b.includes('chrome')) targetBrowser = 'Google Chrome';
        else if (b.includes('safari')) targetBrowser = 'Safari';
        query = inBrowserSearchMatch[2].trim();
      } else if (generalSearchMatch) {
        query = generalSearchMatch[1].trim();
      }

      if (
        query &&
        !query.toLowerCase().startsWith('file') &&
        !query.toLowerCase().startsWith('directory') &&
        query.toLowerCase() !== 'something' &&
        query.toLowerCase() !== 'something on the internet'
      ) {
        const browserLabel = targetBrowser || 'default browser';
        return {
          objective: `Search "${query}" on ${browserLabel}`,
          steps: [
            {
              step_id: 1,
              action: targetBrowser ? 'search_in_browser' : 'search_web',
              target: query,
              description: `Search for "${query}" on web browser${targetBrowser ? ` using ${targetBrowser}` : ''}`,
              tool_name: 'search_browser',
              tool_args: { query, engine: 'google', browser: targetBrowser },
              risk_level: 'low',
              requires_approval: true,
              depends_on: [],
              expected_outcome: `Web browser navigated to search results for "${query}"`,
            },
            {
              step_id: 2,
              action: 'verify_browser',
              target: query,
              description: `Verify browser search for "${query}"`,
              tool_name: undefined,
              tool_args: { query, browser: targetBrowser },
              risk_level: 'low',
              requires_approval: true,
              depends_on: [1],
              expected_outcome: 'Search results displayed in browser',
            },
          ],
        };
      }
    }

    // 8. Direct URL Navigation / Website Opening (e.g. "Open github.com in Brave", "Open github.com", "Open YouTube")
    const openUrlInBrowserMatch = text.match(
      /^(?:(?:can\s+you\s+|please\s+)?(?:open|navigate\s+to|visit)\s+(?:the\s+)?(?:website\s+|url\s+|link\s+)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?|https?:\/\/[^\s]+)\s+(?:in|on|with)\s+(chrome|google\s+chrome|brave|brave\s+browser|safari|browser))$/i
    );
    const directUrlMatch = text.match(
      /^(?:(?:can\s+you\s+|please\s+)?(?:open|navigate\s+to|visit)\s+(?:the\s+)?(?:website\s+|url\s+|link\s+)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?|https?:\/\/[^\s]+))$/i
    );
    const knownWebsiteMatch = lower.match(
      /^(?:(?:can\s+you\s+|please\s+)?(?:open|navigate\s+to|visit)\s+(youtube|reddit|twitter|github|google|facebook|wikipedia)(?:\s+(?:in|on)\s+(chrome|google\s+chrome|brave|brave\s+browser|safari|browser))?)$/i
    );

    if (openUrlInBrowserMatch || directUrlMatch || knownWebsiteMatch) {
      let rawUrl = '';
      let targetBrowser: string | undefined = undefined;

      if (openUrlInBrowserMatch) {
        rawUrl = openUrlInBrowserMatch[1].trim();
        const b = openUrlInBrowserMatch[2].toLowerCase();
        if (b.includes('brave')) targetBrowser = 'Brave Browser';
        else if (b.includes('chrome')) targetBrowser = 'Google Chrome';
        else if (b.includes('safari')) targetBrowser = 'Safari';
      } else if (directUrlMatch) {
        rawUrl = directUrlMatch[1].trim();
      } else if (knownWebsiteMatch) {
        const site = knownWebsiteMatch[1].toLowerCase();
        rawUrl = `https://www.${site}.com`;
        const b = (knownWebsiteMatch[2] || '').toLowerCase();
        if (b.includes('brave')) targetBrowser = 'Brave Browser';
        else if (b.includes('chrome')) targetBrowser = 'Google Chrome';
        else if (b.includes('safari')) targetBrowser = 'Safari';
      }

      if (rawUrl) {
        const cleanUrl = rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
          ? rawUrl
          : `https://${rawUrl}`;
        const browserLabel = targetBrowser || 'browser';

        return {
          objective: `Open ${cleanUrl} in ${browserLabel}`,
          steps: [
            {
              step_id: 1,
              action: targetBrowser ? 'navigate_url' : 'open_website',
              target: cleanUrl,
              description: `Navigate ${browserLabel} to ${cleanUrl}`,
              tool_name: 'navigate_browser',
              tool_args: { url: cleanUrl, browser: targetBrowser },
              risk_level: 'low',
              requires_approval: true,
              depends_on: [],
              expected_outcome: `Navigated to ${cleanUrl}`,
            },
            {
              step_id: 2,
              action: 'verify_browser',
              target: cleanUrl,
              description: `Verify ${cleanUrl} loaded in browser`,
              tool_name: undefined,
              tool_args: { url: cleanUrl, browser: targetBrowser },
              risk_level: 'low',
              requires_approval: true,
              depends_on: [1],
              expected_outcome: 'Page load verified',
            },
          ],
        };
      }
    }

    // Single Application Launch (e.g. "Open Chrome", "Launch Terminal", "Open Spotify", "Open Calculator")
    const appMatch = lower.match(/^(?:(?:can\s+you\s+|please\s+)?(?:open|launch|start)\s+(?:the\s+)?(?:app(?:lication)?\s+)?([a-zA-Z0-9\s._-]+?)(?:\s+app)?)$/i);
    if (appMatch) {
      const app = appMatch[1].trim();
      if (!app.includes('vs code') && !app.includes('vscode') && !app.includes('youtube') && !app.includes('file') && !app.includes('folder')) {
        return {
          objective: `Launch ${app}`,
          steps: [
            {
              step_id: 1,
              action: 'launch_application',
              target: app,
              description: `Launch ${app} on desktop`,
              tool_name: 'launch_application',
              tool_args: { appName: app },
              risk_level: 'low',
              requires_approval: true,
              depends_on: [],
              expected_outcome: `${app} process launched and window presented`,
            },
            {
              step_id: 2,
              action: 'verify_application',
              target: app,
              description: `Verify ${app} is running on system`,
              tool_name: undefined,
              tool_args: {},
              risk_level: 'low',
              requires_approval: true,
              depends_on: [1],
              expected_outcome: `${app} running successfully`,
            },
          ],
        };
      }
    }

    // VS Code Launch / Open Folder in VS Code
    if (lower.includes('vs code') || lower.includes('vscode')) {
      // Extract requested folder/project name dynamically from instruction
      let requestedFolder: string | null = null;

      // Pattern A: Quoted name: folder "New Go" / project "XYZ"
      const quoteMatch = text.match(/(?:folder|project|workspace|directory)\s+["']([^"']+)["']/i);
      if (quoteMatch) {
        requestedFolder = quoteMatch[1].trim();
      }

      // Pattern B: Named/called: folder named XYZ / called XYZ
      if (!requestedFolder) {
        const namedMatch = text.match(
          /(?:folder|project|workspace|directory)\s+(?:named|called|with\s+(?:the\s+)?name(?:\s+of)?)\s+["']?([^"'\s.,;]+)["']?/i
        );
        if (namedMatch) {
          requestedFolder = namedMatch[1].trim();
        }
      }

      // Pattern C: "open [the] folder [XYZ] [present on desktop] in/with VS Code"
      if (!requestedFolder) {
        const openFolderMatch = text.match(
          /open\s+(?:the\s+)?(?:folder|project|workspace|directory)\s+["']?([^"'\r\n]+?)["']?(?:\s+(?:present\s+on|on|in|at)\s+(?:the\s+)?(?:desktop|downloads|documents))?\s+(?:in|with)\s+(?:vs\s*code|vscode|visual\s+studio\s+code)/i
        );
        if (openFolderMatch) {
          const candidate = openFolderMatch[1].trim();
          const skipWords = ['a', 'the', 'one', 'this', 'that', 'it', 'desktop', 'downloads', 'documents'];
          if (
            !skipWords.includes(candidate.toLowerCase()) &&
            !candidate.toLowerCase().startsWith('on ') &&
            !candidate.toLowerCase().startsWith('in ')
          ) {
            requestedFolder = candidate;
          }
        }
      }

      // Pattern D: "open XYZ folder in vs code"
      if (!requestedFolder) {
        const folderWordMatch = text.match(
          /open\s+["']?([^"'\r\n]+?)["']?\s+(?:folder|project|workspace|directory)\s+(?:in|with)\s+(?:vs\s*code|vscode|visual\s+studio\s+code)/i
        );
        if (folderWordMatch) {
          const candidate = folderWordMatch[1].trim();
          const skipWords = ['a', 'the', 'one', 'this', 'that', 'it', 'desktop', 'downloads', 'documents'];
          if (!skipWords.includes(candidate.toLowerCase())) {
            requestedFolder = candidate;
          }
        }
      }

      // Pattern E: "open XYZ in vs code"
      if (!requestedFolder) {
        const openInMatch = text.match(
          /open\s+["']?([^"'\r\n]+?)["']?\s+(?:in|with)\s+(?:vs\s*code|vscode|visual\s+studio\s+code)/i
        );
        if (openInMatch) {
          let candidate = openInMatch[1]
            .replace(/^(?:the\s+)?(?:folder|project|workspace|directory)\s+/i, '')
            .trim();
          candidate = candidate
            .replace(/^(?:present\s+on|on|in|at)\s+(?:the\s+)?(?:desktop|downloads|documents)\s+/i, '')
            .trim();
          const skipWords = [
            'a', 'the', 'one', 'this', 'that', 'it', 'desktop', 'downloads', 'documents', 'code', 'vscode'
          ];
          if (candidate && !skipWords.includes(candidate.toLowerCase())) {
            requestedFolder = candidate;
          }
        }
      }

      const isProjectExplicit =
        Boolean(requestedFolder) ||
        lower.includes('folder') ||
        lower.includes('project') ||
        lower.includes('workspace');

      if (isProjectExplicit) {
        const targetFolder = requestedFolder || 'GIA-AI';
        return {
          objective: `Open "${targetFolder}" in Visual Studio Code`,
          steps: [
            {
              step_id: 1,
              action: 'launch_application',
              target: 'Visual Studio Code',
              description: `Open "${targetFolder}" folder in Visual Studio Code`,
              tool_name: 'open_folder_in_vscode',
              tool_args: { folderName: targetFolder },
              risk_level: 'medium',
              requires_approval: true,
              depends_on: [],
              expected_outcome: `Visual Studio Code workspace opened with "${targetFolder}"`,
            },
            {
              step_id: 2,
              action: 'verify_workspace',
              target: 'Visual Studio Code',
              description: 'Verify workspace opened in editor window',
              tool_name: undefined,
              tool_args: {},
              risk_level: 'low',
              requires_approval: true,
              depends_on: [1],
              expected_outcome: 'VS Code editor ready',
            },
          ],
        };
      }

      return {
        objective: 'Launch Visual Studio Code',
        steps: [
          {
            step_id: 1,
            action: 'launch_application',
            target: 'Visual Studio Code',
            description: 'Launch Visual Studio Code on desktop',
            tool_name: 'launch_application',
            tool_args: { appName: 'Visual Studio Code' },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Visual Studio Code running and window visible',
          },
          {
            step_id: 2,
            action: 'verify_application',
            target: 'Visual Studio Code',
            description: 'Verify Visual Studio Code is running on system',
            tool_name: undefined,
            tool_args: {},
            risk_level: 'low',
            requires_approval: true,
            depends_on: [1],
            expected_outcome: 'Visual Studio Code process verified',
          },
        ],
      };
    }

    // Screenshot Capture
    if (lower.includes('screenshot') || lower.includes('capture screen')) {
      return {
        objective: 'Capture Desktop Screenshot',
        steps: [
          {
            step_id: 1,
            action: 'capture_screen',
            target: 'Desktop Display',
            description: 'Capture screenshot of active desktop window',
            tool_name: 'capture_screen',
            tool_args: {},
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Screenshot captured and stored safely',
          },
        ],
      };
    }

    // System Diagnostics
    if (lower === 'system info' || lower.includes('battery status') || lower.includes('laptop specs')) {
      return {
        objective: 'Retrieve Laptop System & Battery Diagnostics',
        steps: [
          {
            step_id: 1,
            action: 'read_system_metrics',
            target: 'System Hardware & Battery',
            description: 'Collect CPU, memory, uptime, and battery telemetry from macOS',
            tool_name: 'get_system_info',
            tool_args: {},
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'System telemetry captured and formatted',
          },
        ],
      };
    }

    return null;
  }
}
