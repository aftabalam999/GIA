# GIA — AI Development Workflow

> **Version:** V1  
> **Status:** Active  
> **File:** `WORKFLOW.md`  
> **Purpose:** Mandatory workflow for AI coding agents working on GIA.

---

# 1. Purpose

This document defines how an AI coding agent must:

- Understand the existing codebase
- Plan changes
- Write new code
- Fix bugs
- Refactor code
- Modify architecture
- Add dependencies
- Run tests
- Validate changes
- Handle uncertainty

This document works together with:

```text
ARCHITECTURE.md
```

`ARCHITECTURE.md` defines the architecture.

`WORKFLOW.md` defines the development process.

Both documents must be followed.

---

# 2. Golden Rule

> **Do not modify code until you understand why the code exists, what depends on it, and which architectural boundary it belongs to.**

Never start by immediately editing the first file that appears relevant.

First:

```text
Understand
    ↓
Investigate
    ↓
Plan
    ↓
Implement
    ↓
Test
    ↓
Review
```

---

# 3. Priority Order

When making a decision, follow this hierarchy:

```text
1. User's explicit requirement
        ↓
2. ARCHITECTURE.md
        ↓
3. WORKFLOW.md
        ↓
4. Existing module boundaries
        ↓
5. Existing interfaces/contracts
        ↓
6. Existing implementation
        ↓
7. New implementation
```

Existing code is not automatically correct.

If existing code violates the architecture, do not blindly copy the same pattern.

---

# 4. Mandatory First Step

Before changing anything, inspect the repository.

At minimum understand:

```text
Project structure
Package manager
Application entry points
Frontend structure
Backend structure
Database structure
AI modules
Environment configuration
Tests
Existing documentation
```

Determine:

```text
Where does the request enter?

Which module owns the functionality?

Where is the data stored?

Which service performs the operation?

Which modules depend on it?

How is it currently tested?
```

Do not guess.

---

# 5. Repository Exploration Workflow

Use this sequence:

```text
1. List project structure
        ↓
2. Identify relevant files
        ↓
3. Read the implementation
        ↓
4. Search for usages
        ↓
5. Search for related interfaces
        ↓
6. Search for tests
        ↓
7. Check documentation
        ↓
8. Determine the smallest correct change
```

Example:

If asked:

```text
"Fix memory retrieval."
```

Do not immediately edit:

```text
memory/retrieval.ts
```

First inspect:

```text
memory/
ai/
rag/
database/
schemas/
tests/
```

Then determine the actual failure path.

---

# 6. Search Before Creating

Before creating a new:

```text
service
utility
hook
component
repository
interface
schema
function
tool
provider
```

search the codebase.

The AI must not create duplicate functionality.

Bad:

```text
memoryService.ts
memoryManager.ts
memoryHandler.ts
memoryHelper.ts
```

when an existing `MemoryService` already performs the required responsibility.

Prefer:

```text
Existing Service
      ↓
Extend it
```

instead of:

```text
New Service
      ↓
Duplicate logic
```

---

# 7. Understand Ownership

Every feature must have an owner.

Example:

```text
Authentication
→ API/Auth module

Database access
→ Repository layer

Business logic
→ Service layer

LLM selection
→ Model Router

Agent workflow
→ AI/Agent layer

Memory retrieval
→ Memory module

Document retrieval
→ RAG module

Tool execution
→ Tool module

UI state
→ Frontend store
```

Do not place functionality wherever it is convenient.

Place it where its responsibility belongs.

---

# 8. Dependency Direction

Dependencies should flow toward lower-level abstractions.

Preferred:

```text
Controller
    ↓
Service
    ↓
Repository
    ↓
Database
```

AI:

```text
API
 ↓
Orchestrator
 ↓
Domain Services
 ↓
Provider Interfaces
 ↓
External Providers
```

Frontend:

```text
UI
 ↓
Feature Logic
 ↓
Frontend Service
 ↓
API
```

Avoid circular dependencies.

Bad:

```text
Service A
   ↓
Service B
   ↓
Service A
```

If circular dependencies appear, reconsider the module boundaries.

---

# 9. Before Coding

Before implementation, define the task internally as:

```text
Problem
Expected behavior
Current behavior
Root cause
Affected modules
Required change
Potential side effects
Testing strategy
```

For non-trivial changes, create a short implementation plan before editing.

Example:

```text
Problem:
Memory retrieval returns irrelevant memories.

Root cause:
Similarity threshold is applied after an incorrect metadata filter.

Change:
Move metadata filtering before ranking and adjust retrieval contract.

Affected:
memory/retrieval
memory/repository
tests/memory
```

Do not produce an enormous plan for a one-line bug fix.

The planning depth must match the complexity.

---

# 10. Bug-Fixing Workflow

Every bug must follow:

```text
Reproduce
    ↓
Observe
    ↓
Trace
    ↓
Identify Root Cause
    ↓
Fix Root Cause
    ↓
Test Regression
    ↓
Review Side Effects
```

Do not fix symptoms without understanding the cause.

---

# 11. Reproduce the Bug

Before changing code, determine whether the bug can be reproduced.

Record:

```text
Input
Expected result
Actual result
Error
Environment
Relevant logs
```

Example:

```text
Input:
"What database did I choose?"

Expected:
PostgreSQL

Actual:
No memory found
```

Then trace the request.

---

# 12. Trace the Complete Execution Path

For bugs involving multiple layers, trace the full path.

Example:

```text
Frontend
 ↓
API
 ↓
Controller
 ↓
Service
 ↓
Memory Retrieval
 ↓
Database
 ↓
Context Builder
 ↓
LLM
```

Determine exactly where the expected behavior diverges.

Do not assume the bug is in the component named by the user.

If the user says:

```text
"Memory is broken."
```

the problem could actually be:

```text
Frontend request
API validation
Database query
Embedding generation
Vector search
Ranking
Context construction
LLM prompt
```

---

# 13. Root Cause Requirement

A bug fix is incomplete until the root cause is understood.

Bad:

```text
Add another if statement
```

Good:

```text
The retrieval query excluded memories because
the metadata filter was applied using the wrong user ID.
```

The implementation should address the cause rather than hide the symptom.

---

# 14. Minimal Correct Change

Prefer the smallest change that correctly solves the problem.

Do not turn:

```text
Bug in function A
```

into:

```text
Rewrite entire module A
Rewrite database layer
Change API contracts
Introduce Redis
Replace ORM
```

unless the evidence requires it.

Minimal does not mean "hack."

It means:

> The smallest architecturally correct solution.

---

# 15. Do Not Over-Engineer

Do not introduce a new technology merely because it could solve the problem.

Examples:

```text
Need caching
→ Do not automatically add Redis.

Need vector search
→ Use pgvector in V1.

Need background processing
→ Do not automatically introduce Kafka.

Need scalability
→ Do not automatically create microservices.
```

Check `ARCHITECTURE.md` first.

---

# 16. New Dependency Workflow

Before adding a package:

```text
1. Check whether existing dependencies solve the problem.
2. Check whether the functionality is actually necessary.
3. Check architectural compatibility.
4. Check package maintenance and stability.
5. Check bundle/runtime impact.
6. Add only if justified.
```

Never add a package for something that can be implemented cleanly with existing dependencies.

---

# 17. LLM Provider Rules

When implementing AI functionality:

```text
DO NOT
```

hard-code provider-specific behavior into business logic.

Bad:

```ts
if (provider === "openai") {
  // application logic
}
```

inside general application services.

Prefer:

```text
Application
    ↓
LLM Interface
    ↓
Provider Adapter
```

Provider-specific code belongs in:

```text
ai/providers/
```

---

# 18. Model Selection Rules

Never scatter model names throughout the codebase.

Bad:

```ts
model: "some-model"
```

inside multiple services.

Prefer:

```text
Application
    ↓
Model Router
    ↓
Model Configuration
```

The model router owns model selection.

---

# 19. Memory Rules

Before implementing memory behavior, determine whether the information is:

```text
Temporary
Conversational
Persistent
Semantic
Episodic
```

Do not store every message as long-term memory.

Before creating persistent memory, evaluate:

```text
Relevance
Durability
Importance
Confidence
Duplication
Sensitivity
Expiration
```

---

# 20. RAG Rules

RAG and memory must remain separate.

If the user asks about:

```text
User preference
Past decision
Personal fact
```

consider memory.

If the user asks:

```text
What does this document say?
What does this PDF contain?
What does the knowledge base say?
```

consider RAG.

If both are needed:

```text
Memory
   +
RAG
   ↓
Context Builder
```

Do not merge their storage or responsibilities simply to reduce code.

---

# 21. Tool Rules

All tools must go through the tool system.

Do not allow arbitrary tool execution.

Every tool must define:

```text
Name
Description
Input schema
Permission
Execution
Error handling
```

Before execution:

```text
LLM Tool Request
      ↓
Schema Validation
      ↓
Permission Check
      ↓
Execution
```

Never:

```text
LLM
 ↓
Raw shell command
 ↓
Operating system
```

without validation and authorization.

---

# 22. Destructive Operations

Destructive operations require explicit authorization.

Examples:

```text
Delete files
Drop database
Delete records
Force git operations
Execute destructive shell commands
Destroy infrastructure
```

The AI coding agent must not perform destructive operations merely because they appear convenient.

---

# 23. Database Changes

Before changing the database:

```text
1. Inspect current schema.
2. Inspect relations.
3. Inspect migrations.
4. Inspect application queries.
5. Determine backward compatibility.
6. Implement migration.
7. Update affected code.
8. Test migration.
```

Never modify production schema manually when the project uses migrations.

---

# 24. API Changes

Before modifying an API:

```text
1. Find route.
2. Find controller.
3. Find service.
4. Find frontend consumers.
5. Find tests.
6. Check API contract.
```

Avoid breaking existing clients unnecessarily.

If a breaking change is required:

```text
Document it.
Version it when appropriate.
Update consumers.
Update tests.
```

---

# 25. Frontend Changes

Before modifying UI:

```text
Understand:
Component
Feature
State
API
Loading state
Error state
Empty state
```

Do not put backend logic into React components.

Bad:

```text
React Component
    ↓
Database
```

Correct:

```text
React
 ↓
Frontend Service
 ↓
API
 ↓
Backend
```

---

# 26. State Management

Do not introduce global state unless the state is genuinely global.

Prefer:

```text
Local UI State
```

for:

```text
Modal open/close
Input values
Temporary UI state
```

Use shared stores for:

```text
Authentication
Current user
Conversation state
Application-wide settings
```

Do not put everything into one global store.

---

# 27. TypeScript Rules

TypeScript must be used strictly.

Avoid:

```ts
any
```

unless there is a documented reason.

Prefer:

```ts
unknown
```

with validation when dealing with external data.

External inputs must be validated.

Examples:

```text
API requests
LLM outputs
Tool arguments
Web responses
Uploaded metadata
Environment configuration
```

---

# 28. Validation

Validate at boundaries.

```text
External Input
      ↓
Validation
      ↓
Application Logic
```

Do not assume external data is valid.

Especially validate:

```text
API input
Tool input
LLM structured output
Database input
File metadata
Environment variables
```

---

# 29. Error Handling

Errors must be meaningful.

Bad:

```ts
throw new Error("Something went wrong");
```

Prefer errors that identify:

```text
Operation
Cause
Context
Recoverability
```

Example:

```text
Failed to retrieve memories for conversation X:
vector search timed out.
```

Do not expose internal secrets or sensitive system details to users.

---

# 30. Async and External Services

Every external service call must consider:

```text
Timeout
Retry
Failure
Rate limit
Invalid response
Partial failure
```

Never assume:

```text
LLM always responds
Database always responds
Network always works
Tool always succeeds
```

---

# 31. Logging

Logs should help diagnose failures.

Useful:

```text
request_id
conversation_id
operation
service
duration
status
error type
```

Do not log:

```text
API keys
Passwords
Tokens
Secrets
Sensitive user data
```

unless there is a justified and controlled mechanism.

---

# 32. Testing Workflow

After implementation:

```text
1. Run targeted tests.
2. Run related integration tests.
3. Run type checking.
4. Run linting.
5. Run broader tests if appropriate.
6. Inspect the diff.
```

For a bug fix:

```text
Test that reproduces the bug
        ↓
Fix
        ↓
Test passes
        ↓
Regression tests pass
```

---

# 33. Test Requirements for Bug Fixes

A bug fix should normally include a regression test.

Example:

```text
Bug:
Memory retrieval ignored user_id.

Regression test:
Create memories for User A and User B.
Request User A memories.
Assert User B memories are never returned.
```

This prevents the same bug from returning later.

---

# 34. Test Requirements for Features

A new feature should normally include:

```text
Happy path
Validation failure
Expected error
Important edge case
```

Complex features should have integration coverage.

---

# 35. Edge Cases

Before considering a feature complete, consider:

```text
Empty input
Null values
Missing data
Invalid input
Large input
Duplicate input
Network failure
Timeout
Permission failure
Concurrent requests
Unexpected LLM output
```

Do not test every theoretical case for trivial code.

Focus on realistic failure modes.

---

# 36. AI Output Validation

LLM output is untrusted data.

Do not assume the model follows instructions perfectly.

When structured output is required:

```text
LLM
 ↓
Schema Validation
 ↓
Application
```

not:

```text
LLM
 ↓
Application
```

If validation fails:

```text
Retry
Repair
Fallback
Graceful failure
```

depending on the situation.

---

# 37. Git Workflow

Before making changes:

```text
Check git status.
```

Do not overwrite unrelated user changes.

After changes:

```text
Check git diff.
```

Ensure the diff contains only intended modifications.

Never blindly execute:

```text
git reset --hard
git clean -fd
```

or other destructive commands.

---

# 38. Preserve User Changes

If the repository already contains uncommitted changes:

```text
DO NOT
```

overwrite them unless explicitly instructed.

Determine:

```text
Which changes existed before?
Which changes were introduced by you?
```

Keep unrelated work untouched.

---

# 39. Refactoring Workflow

Refactoring is allowed when it improves correctness or maintainability.

Before refactoring:

```text
Identify current behavior.
Identify consumers.
Identify tests.
Define desired structure.
```

Then:

```text
Refactor
 ↓
Run tests
 ↓
Compare behavior
```

Do not refactor unrelated code while solving a different task.

---

# 40. Architecture Change Workflow

Architecture changes require more caution.

Before changing architecture:

```text
1. Identify the limitation.
2. Explain why the current architecture cannot support it.
3. Identify affected components.
4. Evaluate simpler alternatives.
5. Check V1/V2 boundaries.
6. Update ARCHITECTURE.md.
7. Implement the change.
8. Update tests and documentation.
```

Never silently change architecture.

---

# 41. Documentation Workflow

When behavior changes, update relevant documentation.

Examples:

```text
Architecture change
→ ARCHITECTURE.md

API change
→ API documentation

New tool
→ Tool documentation

Memory behavior change
→ Memory documentation

Development process change
→ WORKFLOW.md
```

Documentation must reflect the actual implementation.

---

# 42. Environment Variables

When adding an environment variable:

```text
1. Add configuration handling.
2. Add it to `.env.example`.
3. Validate it.
4. Document its purpose.
```

Never commit actual secrets.

---

# 43. Database Credentials and API Keys

Never hard-code:

```text
API keys
Passwords
Tokens
Database credentials
Cloudinary secrets
```

Bad:

```ts
const apiKey = "sk-...";
```

Correct:

```ts
const apiKey = env.OPENAI_API_KEY;
```

---

# 44. Performance Workflow

Do not optimize based on assumptions.

First:

```text
Measure
 ↓
Identify bottleneck
 ↓
Optimize
 ↓
Measure again
```

Do not add caching, workers, queues, indexes, or additional infrastructure without evidence.

---

# 45. Security Workflow

For any security-sensitive feature:

```text
Identify trust boundary
        ↓
Validate input
        ↓
Authenticate
        ↓
Authorize
        ↓
Execute
        ↓
Audit/log appropriately
```

Never rely solely on frontend validation.

Frontend validation is for UX.

Backend validation is mandatory.

---

# 46. When Something Fails

If implementation fails:

Do not randomly modify multiple files.

Instead:

```text
Failure
 ↓
Read error
 ↓
Identify layer
 ↓
Trace inputs
 ↓
Check assumptions
 ↓
Fix one cause
 ↓
Retest
```

Avoid:

```text
Change 10 things
 ↓
Run tests
 ↓
Hope
```

---

# 47. When Tests Fail

Do not automatically assume the new code is wrong.

Determine whether the failure is:

```text
Implementation bug
Test bug
Environment issue
Existing unrelated failure
Dependency issue
```

If the failure is unrelated:

```text
Do not silently modify unrelated code
```

Document it.

---

# 48. When Uncertain

If there are multiple technically valid approaches:

```text
Prefer the option that:
```

1. Fits `ARCHITECTURE.md`.
2. Reuses existing infrastructure.
3. Minimizes complexity.
4. Minimizes coupling.
5. Preserves interfaces.
6. Is easy to test.
7. Can evolve later.

Do not choose technology merely because it is popular.

---

# 49. Stop Conditions

The AI should stop and ask for clarification when:

```text
The requirement is fundamentally ambiguous.

Two interpretations produce materially different behavior.

A destructive operation is required without authorization.

Architecture must change but the intended direction is unclear.

Sensitive/security-critical behavior is unspecified.

A database migration could cause irreversible data loss.

Existing code contains conflicting architectural decisions
that cannot be resolved safely.
```

Do not guess in these situations.

---

# 50. Implementation Completion Checklist

Before declaring a task complete:

```text
[ ] Requirement understood
[ ] Existing implementation inspected
[ ] Existing usages searched
[ ] Existing interfaces checked
[ ] Architecture checked
[ ] Correct module selected
[ ] Minimal correct change implemented
[ ] Types validated
[ ] Errors handled
[ ] Relevant tests added/updated
[ ] Tests executed
[ ] Lint passed
[ ] Type check passed
[ ] Git diff inspected
[ ] No secrets added
[ ] No unrelated files modified
[ ] Documentation updated if necessary
```

---

# 51. Bug-Fix Completion Checklist

```text
[ ] Bug reproduced
[ ] Expected behavior identified
[ ] Actual behavior identified
[ ] Root cause identified
[ ] Root cause fixed
[ ] Regression test added
[ ] Related tests passed
[ ] No unrelated behavior broken
[ ] Diff reviewed
```

---

# 52. Feature Completion Checklist

```text
[ ] Requirement understood
[ ] Architecture checked
[ ] Existing functionality searched
[ ] Design planned
[ ] Correct module selected
[ ] Implementation completed
[ ] Validation added
[ ] Error handling added
[ ] Tests added
[ ] Integration verified
[ ] Documentation updated
[ ] Diff reviewed
```

---

# 53. Code Review Checklist

Before finalizing code, ask:

### Correctness

```text
Does it actually solve the problem?
```

### Architecture

```text
Does it belong in this module?
```

### Maintainability

```text
Will another developer understand it?
```

### Duplication

```text
Did I recreate existing functionality?
```

### Security

```text
Can untrusted input cause damage?
```

### Performance

```text
Did I introduce unnecessary expensive operations?
```

### Reliability

```text
What happens when the dependency fails?
```

### Testing

```text
What prevents this bug from returning?
```

---

# 54. Anti-Patterns

The following behavior is prohibited.

## Copy-Paste Development

```text
Find similar code
 ↓
Copy
 ↓
Rename variables
 ↓
Ship
```

Instead, determine whether the existing implementation should be reused.

---

## Giant Controller

```text
Controller
 ├── validation
 ├── database
 ├── LLM
 ├── memory
 ├── RAG
 ├── tools
 └── response formatting
```

This is prohibited.

Controllers should remain thin.

---

## Giant React Component

Do not create components containing:

```text
API calls
business logic
state management
AI logic
complex rendering
database assumptions
```

Split responsibilities.

---

## God Service

Avoid one service responsible for:

```text
Memory
RAG
LLM
Tools
Database
Authentication
```

Separate responsibilities.

---

## Any Everywhere

Do not use:

```ts
any
```

to bypass TypeScript problems.

Fix the type problem.

---

## Silent Failure

Do not swallow errors:

```ts
try {
  ...
} catch {
}
```

Handle or propagate the error appropriately.

---

## Magic Values

Avoid unexplained:

```text
numbers
timeouts
thresholds
model names
limits
```

Use named configuration/constants where appropriate.

---

## Premature Optimization

Do not introduce:

```text
Redis
Queues
Caching
Microservices
Workers
```

without an actual requirement.

---

## Premature Abstraction

Do not create abstractions for hypothetical future requirements.

First solve the real problem cleanly.

Abstract when there is a demonstrated need.

---

# 55. AI Agent Operating Loop

Every coding task should follow this loop:

```text
┌───────────────────────┐
│       RECEIVE TASK    │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│     UNDERSTAND        │
│ Requirement + Context │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│      INVESTIGATE      │
│ Search + Trace + Read │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│         PLAN          │
│ Smallest Correct Fix  │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│      IMPLEMENT        │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│        TEST           │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│        REVIEW         │
│ Diff + Architecture   │
└───────────┬───────────┘
            │
            ▼
        ┌───────┐
        │ DONE  │
        └───────┘
```

---

# 56. Decision Tree

When asked to modify GIA:

```text
                    TASK
                      │
                      ▼
             Understand Request
                      │
                      ▼
             Search Existing Code
                      │
                      ▼
            Does functionality exist?
                 /          \
               YES           NO
                │             │
                ▼             ▼
          Reuse/Extend     Design New
                │             │
                └──────┬──────┘
                       ▼
                Check Architecture
                       │
                       ▼
                Implement Change
                       │
                       ▼
                    Test
                       │
                       ▼
                 Review Diff
                       │
                       ▼
                    DONE
```

---

# 57. Definition of Done

A task is complete only when:

```text
The requested behavior works.

The implementation belongs to the correct architectural layer.

Existing functionality has not been unnecessarily broken.

Relevant errors are handled.

Relevant tests pass.

No secrets were introduced.

No unrelated changes were made.

The code follows the project's architecture.

Documentation is updated when required.
```

"It works on my machine" is not a sufficient definition of done.

---

# 58. Final Rule

The AI coding agent must optimize for:

```text
Correctness
    >
Architectural consistency
    >
Maintainability
    >
Reliability
    >
Simplicity
    >
Performance optimization
```

Do not sacrifice architectural correctness for a quick patch.

Do not sacrifice correctness for fewer lines of code.

Do not sacrifice simplicity for unnecessary abstraction.

Do not sacrifice security for convenience.

---

# 59. GIA Development Principle

The fundamental development loop is:

```text
UNDERSTAND
    ↓
DO NOT GUESS
    ↓
INVESTIGATE
    ↓
DESIGN
    ↓
IMPLEMENT
    ↓
VERIFY
    ↓
REVIEW
```

The AI agent must behave as an engineer modifying an existing system, not as a code generator producing isolated snippets.

---

# 60. Summary

GIA development follows these principles:

```text
Understand before editing.

Search before creating.

Trace before fixing.

Find the root cause.

Make the smallest architecturally correct change.

Keep responsibilities separated.

Do not duplicate functionality.

Do not introduce unnecessary technologies.

Treat LLM output as untrusted.

Validate external input.

Protect secrets.

Test changes.

Review the final diff.

Preserve existing user changes.

Update documentation when architecture changes.

Ask instead of guessing when the requirement is materially ambiguous.
```

The goal is not to produce the most code.

The goal is to produce the **correct code inside the correct architecture with the smallest unnecessary change**.

NEVER implement multiple major subsystems in one task unless explicitly instructed.

After completing a subsystem:
1. Run tests.
2. Run lint/type checks.
3. Verify affected APIs.
4. Inspect the diff.
5. Fix regressions.
6. Update documentation if architecture changed.
7. Stop and wait for the next instruction.