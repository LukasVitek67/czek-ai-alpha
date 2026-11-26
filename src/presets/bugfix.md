<!-- Plán presetu „Oprava chyby“: vygeneroval openai/gpt-oss-120b (groq), 2026-11-26, tools/presets-generate.js -->
## Goal of this mode
Find the root cause of the reported failure, apply the smallest correct fix, add a regression test, and verify that the original symptom is gone.

## Plan
1. **Parse the user request** – read the chat message, note the symptom, stack (Node.js, npm scripts, etc.), and any file paths the user mentioned.
2. **Locate the relevant code** – use `glob` to list candidate files, then `grep -R` for the function name, error string, or test name the user cited.
3. **Reproduce the failure** – open a terminal with `bash` and run the exact command the user described (e.g., `npm test`, `node src/index.js`). Capture stdout/stderr to a temporary file for later inspection.
4. **Read the complete error** – open the captured output with `read`, scroll to the stack trace, and note the file/line numbers.
5. **Load the debugging skill** – `skill czek-debugging` and follow its checklist: set breakpoints, add `console.log` or `debugger` statements, and run the code in the same environment.
6. **Identify the root cause** – step through the code using the inserted logs or Node’s `--inspect` flag, compare expected vs. actual values, and confirm the defect is not a downstream symptom.
7. **Design the minimal fix** – edit only the file that contains the faulty logic (`edit <path>`). Apply the change that directly resolves the cause (e.g., correct a conditional, fix an off-by-one index, add a missing `await`).
8. **Run the full test suite** – `bash npm test` (or the project's test command). Ensure all existing tests still pass.
9. **Add a regression test** – load `czek-testing`, create a new test file under the project's test directory that reproduces the original bug scenario and asserts the correct behavior. Use the same test framework the project already uses (Jest, Mocha, etc.).
10. **Run tests again** – confirm the new test fails before the fix, passes after the fix, and that no other test regressed.
11. **Run the original command again** – repeat step 3 to verify the symptom is gone.
12. **Perform a quick code review** – `skill czek-review` to check for style violations, missing error handling, or accidental side-effects introduced by the fix.
13. **Document the change** – prepend a concise comment to the edited block explaining *why* the change was made, referencing the bug ID or user description.
14. **Save all modifications** – `write` each edited file, ensure no stray temporary files remain.
15. **Report back** – summarize the root cause, the exact change, the new regression test, and the verification results.

## Quality bar
- The bug is reproduced locally exactly as described.
- The stack trace points to the edited line(s); no unrelated files are changed.
- All pre-existing tests pass (`npm test` returns 0).
- The newly added regression test fails before the fix and passes after it.
- Running the original command shows no error output and correct program behavior.
- Code follows the project's linting/formatting rules and includes an explanatory comment.

## Verify before saying done
- `bash npm test` → exit code 0 and green output.
- `bash <original command>` → capture output, grep for the original error string; it must be absent.
- Open the edited file and confirm only the intended lines changed.
- Open the new test file and ensure it uses the same test framework and naming conventions as existing tests.
- Run `skill czek-review` and confirm it reports no warnings.

## Avoid
- Fixing only the symptom (e.g., adding a try/catch) without addressing the underlying logic error.
- Changing unrelated modules or formatting the whole project.
- Adding a test that mirrors the fix rather than reproducing the original failure.
- Committing or pushing changes without the user’s explicit request.
- Installing global npm packages or new build tools that the project does not already use.
