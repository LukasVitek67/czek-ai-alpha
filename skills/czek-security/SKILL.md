---
name: czek-security
description: Use when code touches passwords, API keys, tokens, login/auth, user input, file uploads, SQL/databases, shell commands or anything exposed to the internet. Practical checklist so student projects are not trivially hackable and never leak secrets.
---

# Security basics

- **Secrets**: never hard-code keys/passwords. Use environment variables or a config file listed in `.gitignore`; provide `.env.example` with placeholders. Never print secrets in logs or error messages. A leaked key must be revoked, not just deleted from git.
- **Passwords**: hash with bcrypt/argon2/scrypt (library), never store plain text or plain SHA.
- **Input**: validate type/length/format on the server side. Escape output in HTML (use the framework's templating, avoid `innerHTML` with user data).
- **SQL**: always parameterized queries / ORM; never string-concatenate user input into SQL.
- **Shell**: never pass user input into a shell string; use argument arrays (`execFile`, `subprocess.run([...])`).
- **Files**: restrict uploads by type and size, generate your own file names, prevent `../` path traversal.
- **Auth**: check permissions on every request on the server, not only by hiding buttons. Sessions/cookies `HttpOnly`, `Secure`, `SameSite`.
- **Dependencies**: prefer well-known packages; run the package manager's audit when adding several.
- **CORS / APIs**: do not open `*` with credentials; rate-limit login and expensive endpoints.
