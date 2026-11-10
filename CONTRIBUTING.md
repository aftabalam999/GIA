# Contributing to GIA

Thank you for your interest in contributing to **GIA**!

GIA is an open-source AI-powered voice assistant project. Contributions from developers, designers, testers, and documentation writers are welcome.

This document explains how to contribute to the project while maintaining code quality, consistency, and security.

## 1. Code of Conduct

All contributors are expected to:

- Be respectful and professional.
- Communicate constructively.
- Respect different opinions and technical approaches.
- Provide meaningful feedback.
- Avoid harassment, discrimination, or abusive behavior.

## 2. Getting Started

Before contributing, make sure you have:

- Git installed.
- Node.js and npm installed.
- Rust and Cargo installed (for Tauri components).
- A code editor such as VS Code.
- Basic knowledge of the technologies used in the project.

### Fork the Repository

1. Fork the GIA repository.
2. Clone your fork:

```bash
git clone https://github.com/YOUR_USERNAME/GIA.git
```

3. Navigate to the project directory:

```bash
cd GIA
```

4. Add the original repository as an upstream remote:

```bash
git remote add upstream https://github.com/aftabalam999/GIA.git
```

5. Install dependencies according to the project's setup instructions.

## 3. Create a Branch

Always create a separate branch for your contribution.

```bash
git checkout -b feature/your-feature-name
```

Use meaningful branch names:

- `feature/voice-improvement`
- `feature/vision-integration`
- `fix/audio-processing`
- `fix/permission-handling`
- `docs/update-readme`
- `refactor/backend-services`

Do not make changes directly to the `main` branch.

## 4. Contribution Guidelines

### Code Contributions

- Write clean, readable, and maintainable code.
- Follow the existing project architecture.
- Use meaningful variable and function names.
- Avoid unnecessary dependencies.
- Handle errors properly.
- Avoid duplicating existing functionality.
- Keep changes focused on a specific feature or issue.
- Do not introduce breaking changes without discussing them first.

### Frontend Contributions

- Follow the existing component structure.
- Maintain consistent UI design.
- Build reusable components where appropriate.
- Handle loading, error, and empty states.
- Ensure responsive layouts.

### Backend Contributions

- Follow the existing API architecture.
- Validate incoming requests.
- Implement proper error handling.
- Keep business logic separate from route handlers.
- Protect sensitive information.
- Never expose API keys, tokens, or credentials.

### AI and Voice Service Contributions

- Maintain compatibility with the existing AI-service architecture.
- Handle model failures and unavailable services gracefully.
- Avoid unnecessary external API dependencies.
- Preserve local-first functionality where applicable.
- Do not expose private model configurations or credentials.
- Test voice input, speech output, and command execution independently.

## 5. Commit Guidelines

Write clear and descriptive commit messages.

Follow this format:

```text
type: short description
```

Examples:

```text
feat: add voice command support
fix: resolve microphone initialization issue
docs: update installation instructions
refactor: improve command execution flow
test: add backend service tests
chore: update project dependencies
```

Common commit types:

| Type | Purpose |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation |
| `refactor` | Code restructuring |
| `test` | Adding or updating tests |
| `chore` | Maintenance |
| `perf` | Performance improvement |

## 6. Testing Requirements

Before submitting a pull request:

- Run the relevant test suites.
- Verify that existing functionality still works.
- Test the new functionality.
- Check for console errors and backend errors.
- Ensure there are no unintended breaking changes.

Do not submit code that you have not tested.

If automated tests cannot be run, explain why in your pull request.

## 7. Pull Request Process

Once your changes are ready:

1. Commit your changes.
2. Push your branch to your fork.

```bash
git add .
git commit -m "feat: describe your changes"
git push origin feature/your-feature-name
```

3. Open a Pull Request against the original GIA repository.
4. Provide a clear title and description.
5. Link the related issue, if applicable.
6. Explain what you changed and why.
7. Include screenshots or recordings when relevant.
8. Wait for review and address requested changes.

### Pull Request Checklist

Before submitting, verify:

- [ ] My code follows the existing project conventions.
- [ ] I have tested my changes.
- [ ] I have not committed API keys, passwords, or secrets.
- [ ] I have updated documentation where necessary.
- [ ] My changes do not introduce unrelated modifications.
- [ ] I have provided a clear pull request description.

## 8. Reporting Bugs

If you discover a bug, open a GitHub Issue.

Include:

- A clear description of the problem.
- Steps to reproduce the issue.
- Expected behavior.
- Actual behavior.
- Operating system and environment details.
- Relevant error messages or logs.
- Screenshots or recordings, if applicable.

Provide enough information for maintainers to reproduce the issue.

## 9. Suggesting Features

Feature suggestions are welcome.

When proposing a feature, explain:

- What problem does it solve?
- Why is this feature useful?
- How should it work?
- Does it affect the existing architecture?
- Are there any possible limitations or trade-offs?

Discuss major architectural changes with maintainers before implementing them.

## 10. Security Guidelines

Security is a priority for GIA.

- Never commit API keys, passwords, or access tokens.
- Never expose sensitive user data.
- Validate and authorize commands before execution.
- Follow the principle of least privilege.
- Do not introduce unauthorized system access.
- Report security vulnerabilities privately instead of publishing exploit details in public issues.

For security-related concerns, follow the instructions in [SECURITY.md](SECURITY.md).

## 11. Documentation Contributions

Documentation improvements are also valuable.

You can contribute by:

- Improving installation instructions.
- Adding setup guides.
- Documenting APIs and services.
- Improving code comments.
- Adding architecture explanations.
- Fixing spelling and grammatical errors.

Keep documentation accurate and easy to understand.

## 12. Questions and Discussions

If you have questions about contributing, architecture, or implementation decisions, open a GitHub Discussion or create an issue in the repository.

For significant changes, discuss your approach with the maintainers before starting implementation.

## 13. License

By contributing to GIA, you agree that your contributions will be licensed under the project's existing license.

Please ensure that any third-party code, assets, or dependencies you introduce are compatible with the project's license.

---

**Thank you for helping improve GIA.**

Every meaningful contribution helps make GIA better.
