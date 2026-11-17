# CoMem memory provider for Hermes

This provider connects a Hermes profile to CoMem's automatic context and session APIs. It does not replace Hermes's native `MEMORY.md` or `USER.md` files, and it does not duplicate CoMem's extraction or merge logic.

## Install

From the CoMem repository:

```sh
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME/plugins"
ln -s "$PWD/integrations/hermes-memory" "$HERMES_HOME/plugins/comem"
hermes plugins doctor --ci "$PWD/integrations/hermes-memory"
```

Configure and activate it:

```sh
hermes memory setup
hermes memory status
```

Choose **CoMem** in the provider list. The same provider configuration is available in Hermes's memory-provider panel. `hermes memory setup comem` activates CoMem with the default local address, but does not prompt for remote or custom settings.

The default API address is `http://127.0.0.1:1933/api/v1`. The setup form names `COMEM_TOKEN` as the default environment variable for the API key and stores an entered key under that name in the profile's `.env`; `COMEM_BASE_URL` can override the endpoint. Use an API key issued to the same CoMem account that you use in the console. That is also the recommended setup for a loopback server: without a key, `auth.trustLoopback: true` authenticates the provider as the server's configured `server.subject` (`user:local` by default), which may not be the browser login account. For a remote or container endpoint, the API key is required.

The equivalent non-secret configuration is:

```yaml
memory:
  provider: comem
  comem:
    base_url: http://127.0.0.1:1933/api/v1
    max_tokens: 1200
```

`memory.provider: comem` is the activation switch. `max_tokens` is the automatic recall budget and defaults to 1200. Start a new chat after changing provider settings.

## What Hermes gets

- Before a model call, the provider calls `POST /context` with the current prompt, Hermes session ID and current context epoch. Hermes only supplies the completed prompt to background prefetch, so this provider does not cache speculative recall. Recall stays within a 7.5-second server/request budget and the host's fixed 8-second provider timeout.
- After a completed, uninterrupted turn, the user and assistant messages are spooled to the profile's `comem-provider/outbox/`, appended with stable IDs through `POST /sessions/{id}/messages`, and committed through `/commit`. CoMem then runs extraction, merge and review normally.
- A failed write remains in the profile-local outbox and is retried after the next completed turn, up to 10 queued turns per completed exchange. CoMem outage therefore does not block Hermes responses.
- Each queued turn records the CoMem endpoint, credential fingerprint and authenticated `subject` through `GET /auth/me`. A queued turn is replayed only when all three still match. Changing server, API key or account leaves the old queue untouched and reports the skipped binding in status.
- Primary sessions write; cron and subagent contexts do not. Hermes remains responsible for redacting secrets and for skipping interrupted turns.
- The provider returns one recall indicator and no extra tools. CoMem's 16 MCP tools remain the explicit read/write interface.

The provider strips Hermes's `<memory-context>` fence and CoMem recall fences before capture, so recalled memory is not archived as a new user statement.

## Status and limits

`hermes memory status` shows the endpoint, authentication mode, the last authenticated subject, pending local writes, the last transport error, and `last_recall`. `last_recall` contains:

| Field | Meaning |
|---|---|
| `outcome` | `received`, `empty`, or `failed` |
| `at` | When the prefetch attempt finished, in UTC |
| `session_id` | CoMem session ID used by the request |
| `count` | Number of returned context items |
| `bytes` | UTF-8 byte length of the rendered context returned to Hermes |
| `degradation` | CoMem degradation reason, or `null` |
| `budget_ms` | Exact `budgetMs` sent in that `/context` request |
| `timeout_s` | HTTP timeout used by that request |

`received` means CoMem returned non-empty context to Hermes; it does not prove the model used that context. `empty` means the request succeeded without rendered context, and `failed` means the request did not complete successfully. The status file stores metadata only, never memory text, prompts, or credentials.

The provider is loaded into the Hermes process. Editing this source file does not change constants in an already-running process. Compare `budget_ms` and `timeout_s` in `last_recall` with the current source when diagnosing which values are actually loaded; do not infer them from the file on disk.

Provider failures are logged and fail open.

The provider needs Hermes v0.23.1 or a compatible v0.23.x `MemoryProvider` ABI; v0.23.2 is verified. It targets CoMem's HTTP envelope and identity semantics; changing either API requires updating this adapter. `hermes memory status` checks configuration, not network reachability. After setup, compare the reported `subject` with the current space in the CoMem console, send a new prompt, and verify the archived messages in **Sessions**.

A completed archive leaves `messageCount` at zero when no live messages are retained; `lastCommitAt` is the evidence that submission succeeded. Task-list visibility differs by deployment and completion state, so do not infer a capture failure solely from an empty Tasks tab.

Provider state stays under `$HERMES_HOME/comem-provider/`. Deleting that directory discards queued local writes while leaving native Hermes memory and remote CoMem data intact.
