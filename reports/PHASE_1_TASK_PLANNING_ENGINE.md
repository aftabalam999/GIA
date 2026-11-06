# PHASE 1: GIA AUTONOMOUS TASK PLANNING ENGINE IMPLEMENTATION REPORT

## Executive Summary

This report documents the architectural design, implementation, and verification of the **Mandatory Plan-First Architecture** for the GIA Desktop Assistant.

Under this architecture, **GIA never executes an actionable user instruction immediately**. Every actionable instruction is intercepted and decomposed into an atomic, dependency-ordered, risk-evaluated **Execution Plan** that requires explicit user approval before execution.

---

## 1. Plan-First Architecture Lifecycle

```mermaid
flowchart TD
    UserReq["User Natural Language Request"] --> Intent["Intent Understanding & Classification"]
    Intent -->|"Actionable Instruction"| PlanningEngine["Planning Engine (Qwen 3.5 4B)"]
    Intent -->|"Chit-Chat / Question"| DirectResp["Conversational Response"]
    PlanningEngine --> SchemaVal["Strict Zod Schema Validation"]
    SchemaVal --> DBStore["Persist Plan (status: awaiting_approval)"]
    DBStore --> Present["Present Plan to User with Risk & Dependencies"]
    Present --> UserDecision{"User Feedback"}
    UserDecision -->|"Modification Request"| Modify["Update Plan (v+1, zero execution)"]
    Modify --> Present
    UserDecision -->|"Explain Request"| Explain["Explain Actions (zero execution)"]
    Explain --> Present
    UserDecision -->|"Cancel / Reject"| Reject["Mark Plan Rejected"]
    UserDecision -->|"Explicit Approval"| Approved["Mark Plan Approved (Ready for Phase 2 Execution)"]
```

---

## 2. Structured Execution Plan Schema

All generated plans adhere strictly to the `ExecutionPlanSchema` validated using Zod:

```typescript
{
  "id": "uuid",
  "conversation_id": "uuid",
  "user_id": "uuid",
  "objective": "Open YouTube in Google Chrome",
  "status": "awaiting_approval" | "approved" | "rejected" | "modifying" | "executing" | "completed" | "failed",
  "is_ambiguous": boolean,
  "clarification_question": string | null,
  "steps": [
    {
      "step_id": 1,
      "action": "launch_application",
      "target": "Google Chrome",
      "description": "Launch Google Chrome",
      "tool_name": "open_application",
      "tool_args": { "appName": "Google Chrome" },
      "risk_level": "low" | "medium" | "high" | "critical",
      "requires_approval": true,
      "depends_on": [],
      "expected_outcome": "Google Chrome process running and active"
    },
    {
      "step_id": 2,
      "action": "wait_for_application",
      "target": "Google Chrome",
      "description": "Wait until Google Chrome is ready to accept navigation",
      "tool_name": null,
      "tool_args": {},
      "risk_level": "low",
      "requires_approval": true,
      "depends_on": [1],
      "expected_outcome": "Google Chrome window initialized"
    },
    {
      "step_id": 3,
      "action": "navigate_browser",
      "target": "https://www.youtube.com",
      "description": "Navigate Chrome to YouTube",
      "tool_name": "open_url",
      "tool_args": { "url": "https://www.youtube.com" },
      "risk_level": "low",
      "requires_approval": true,
      "depends_on": [2],
      "expected_outcome": "YouTube homepage loaded in browser tab"
    },
    {
      "step_id": 4,
      "action": "verify_browser",
      "target": "https://www.youtube.com",
      "description": "Verify YouTube loaded successfully",
      "tool_name": null,
      "tool_args": {},
      "risk_level": "low",
      "requires_approval": true,
      "depends_on": [3],
      "expected_outcome": "Browser verification complete"
    }
  ],
  "approval": {
    "required": true,
    "approved": false,
    "approved_at": null,
    "feedback": null
  },
  "metadata": {},
  "version": 1
}
```

---

## 3. Planning Restrictions & Security Invariants

1. **Zero Immediate Execution:** The planning engine has no permission to call `ToolExecutor.executeTool`, child process spawns, or shell commands. All step executions are deferred until explicit user approval.
2. **Strict Schema Validation:** Malformed JSON, negative `step_id` values, invalid `risk_level` enums, or empty step lists fail schema validation and trigger safe fallbacks.
3. **Indirect Prompt Injection Defense:** Instructions contained within retrieved documents, external webpages, or context chunks are never accepted as authorization to approve or execute a plan.
4. **Ambiguity Gate:** Vague instructions (e.g., *"open it"*, *"run the program"*, *"delete it"*) are flagged with `is_ambiguous: true`, and GIA asks clarification questions before formulating actions.
5. **Modification Safety:** Feedback messages (*"Also open..."*, *"Don't open X, open Y"*, *"Remove step 2"*) update the plan draft in place, increment the version number, and maintain `approved: false` without triggering tools.

---

## 4. Conversation Handling & Follow-up Support

The planning engine supports multi-turn natural language conversation around pending plans:

| User Follow-Up Message | Engine Behavior | Resulting State |
| :--- | :--- | :--- |
| *"Also open YouTube"* | Appends an atomic step with dependency on prior step. | Step added, version incremented, `approved: false`. |
| *"Don't open YouTube, open GitHub"* | Replaces target, tool arguments, and description in-place. | Step replaced, version incremented, `approved: false`. |
| *"Remove the second step"* | Removes step #2 and re-indexes remaining steps (1, 2, 3...). | Steps re-indexed, version incremented, `approved: false`. |
| *"Explain what this action does"* | Outputs detailed breakdown of action, risk, tool, and dependencies. | Zero plan changes, zero executions. |
| *"Approved"* / *"Proceed"* | Marks plan status as `approved`, sets `approved_at` timestamp. | Plan ready for Phase 2 Execution. |
| *"Cancel"* / *"Reject"* | Marks plan status as `rejected`. | Plan archived, zero executions. |

---

## 5. REST Endpoints Implemented

Registered under `/api/v1` in `backend/src/api/routes/plans.ts`:

- `GET /api/v1/conversations/:id/plans/active` — Retrieves the active plan awaiting approval for the conversation.
- `POST /api/v1/conversations/:id/plans` — Generates a new validated structured plan from an instruction.
- `PUT /api/v1/conversations/:id/plans/:planId` — Modifies an existing plan based on feedback without executing anything.
- `POST /api/v1/conversations/:id/plans/:planId/approve` — Explicitly approves the plan for execution.
- `POST /api/v1/conversations/:id/plans/:planId/reject` — Rejects and archives the plan.

---

## 6. Verification & Test Matrix

All 26 test suites (206 total tests) passed with 0 failures:

| Test Suite | Tests | Result | Description |
| :--- | :--- | :--- | :--- |
| `tests/planner.test.ts` | 16 | **PASS** | Schema validation, zero-execution invariant, ambiguity detection, modification, explanation, REST API. |
| `tests/router.test.ts` | 24 | **PASS** | Intent routing, deterministic commands, LLM fallback. |
| `tests/tools.test.ts` | 17 | **PASS** | Tool registry, system info, directory listing, read file, search. |
| `tests/orchestrator.test.ts` | 5 | **PASS** | State machine node transitions and observability. |
| `tests/e2e.test.ts` | 12 | **PASS** | End-to-end user journeys and database persistence. |
| Full Suite (26 files) | **206** | **PASS** | **100% passing across all backend modules.** |

---

## 7. Next Steps (Phase 2 Readiness)

The Autonomous Task Planning Engine is fully verified, schema-enforced, and integrated. We are ready for **Phase 2: Execution Engine & Controlled Verification**.

