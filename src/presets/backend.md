<!-- Plán presetu „Backend a API“: vygeneroval openai/gpt-oss-120b (groq), 2026-11-26, tools/presets-generate.js -->
## Goal of this mode
Build a reliable, secure, and well-tested backend service (HTTP/REST API, DB layer, auth, validation, logging, secrets) that matches the existing project’s stack and passes automated checks.

## Plan
1. **Read the request and locate the project root** – use `glob "**/package.json"` or `**/pyproject.toml` to detect Node.js, TypeScript, Python, or other back-end languages.
2. **Load the appropriate skill** – invoke `skill czek-security` for auth/secret handling, `skill czek-testing` for test scaffolding, `skill czek-performance` for latency checks, `skill czek-review` for code-style compliance, and `skill czek-research` if a library decision is required.
3. **Map the existing architecture** – list current folders (`src/`, `routes/`, `controllers/`, `models/`, `migrations/`, `config/`). Record the framework (Express, Fastify, Nest, Django, Flask, etc.) and DB (PostgreSQL, MySQL, SQLite).
4. **Define the new endpoint or service** – write a concise spec: HTTP method, path, request schema, response schema, auth requirements, error codes. Store it in a markdown file under `docs/api/`.
5. **Create or extend route definitions** – add a file in `src/routes/` (or `app/urls.py`). Follow the project’s pattern (router-first, controller-first, or class-based view).
6. **Implement controller/service logic** – place business code in `src/controllers/` or `src/services/`. Use dependency injection if the project uses it.
7. **Add input validation** – integrate the project’s validator (Joi, Zod, class-validator, marshmallow). Create a schema file next to the controller and plug it into the route middleware.
8. **Wire authentication & authorization** – follow the existing auth flow (JWT, session cookie, OAuth). Use `skill czek-security` to ensure token verification, role checks, and secure cookie flags.
9. **Persist data** – write a model or ORM entity in `src/models/` (Sequelize, TypeORM, Prisma, SQLAlchemy, Django ORM). Add a migration file using the project’s CLI (`npm run migrate`, `alembic revision`, etc.).
10. **Configure secrets** – store DB credentials, API keys, and JWT secrets in `.env` or OS env vars. Add a reference in `config/` and ensure `.env.example` is updated.
11. **Add logging** – use the existing logger (winston, pino, python-logging). Log request start, input payload (sanitized), outcome, and error stack trace.
12. **Write unit and integration tests** – generate test files in `tests/` using the framework’s test runner (jest, mocha, pytest). Cover happy path, validation failures, auth failures, and DB error handling. Apply `skill czek-testing` for coverage thresholds (≥80%).
13. **Run static analysis** – execute `npm run lint` or `flake8`. Then invoke `skill czek-review` to verify style and security lint rules.
14. **Benchmark the endpoint** – use `skill czek-performance` to run a quick `autocannon` or `hey` request and ensure response time ≤ the project’s SLA (e.g., 200 ms under 100 concurrent users).
15. **Commit locally** – stage changed files, run `git diff --stat` to confirm only intended modifications, and create a descriptive commit (`git commit -m "feat: add /orders POST endpoint with validation and tests"`).
16. **Report** – summarize files added/modified, test results, lint output, and performance numbers. Ask the user if further integration steps are needed.

## Quality bar
- Endpoint follows the project’s routing convention and returns JSON with correct status codes.
- Input schema validates all required fields; invalid payload returns 400 with error details.
- Auth middleware rejects unauthenticated requests with 401 and unauthorized roles with 403.
- ORM model includes proper indexes, constraints, and migration runs without error.
- All new code passes lint, has no new security warnings, and meets the `czek-security` checklist (no hard-coded secrets, proper header sanitization).
- Unit + integration test coverage ≥ 80 % for the new files; all tests pass.
- Performance test shows median latency ≤ project SLA and no memory leaks.
- `.env.example` lists every new env variable with placeholder values.

## Verify before saying done
- Run `npm test` or `pytest -q` and confirm 0 failures.
- Execute `npm run lint` (or `flake8`) and ensure exit code 0.
- Run `skill czek-security` and confirm “All checks passed”.
- Perform a live request with `curl` (or `http`) to the new endpoint using a valid token; verify response body and status.
- Run a failure case (missing field, bad token) and verify correct error code/message.
- Execute `skill czek-performance` and capture latency; compare to SLA.
- Use `git diff --stat` to ensure only intended files changed.

## Avoid
- Adding a full framework (e.g., Nest) when the project uses plain Express.
- Hard-coding secrets or connection strings in source files.
- Skipping migration generation or forgetting to run it locally.
- Leaving console.log statements or debug output in production code.
- Writing tests that only hit happy paths; omit validation and auth edge cases.
- Ignoring existing lint or security rules; do not disable them for convenience.
- Committing generated files (node_modules, __pycache__) or large binary assets.
