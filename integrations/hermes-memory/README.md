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

The default API address is `http://127.0.0.1:1933/api/v1`. For a loopback CoMem server with `auth.trustLoopback: true`, no credential is required, but the provider then acts as the server's configured `server.subject` (`user:local` by default). Sign in to the CoMem console with that same account, or give both the provider and MCP server an API key for the account you use in the console. For a remote or container endpoint, run the interactive setup and enter a CoMem API key when prompted. Hermes stores the key as `COMEM_TOKEN` in the profile's `.env`.

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

- Before a model call, the provider calls `POST /context` with the current prompt, Hermes session ID and current context epoch. Hermes only supplies the completed prompt to background prefetch, so this provider does not cache speculative recall. Recall stays within a 6.5-second server budget and the host's 8-second provider timeout.
- After a completed, uninterrupted turn, the user and assistant messages are spooled to the profile's `comem-provider/outbox/`, appended with stable IDs through `POST /sessions/{id}/messages`, and committed through `/commit`. CoMem then runs extraction, merge and review normally.
- A failed write remains in the profile-local outbox and is retried after the next completed turn, up to 10 queued turns per completed exchange. CoMem outage therefore does not block Hermes responses.
- Each queued turn records the CoMem endpoint, credential fingerprint and authenticated `subject` through `GET /auth/me`. A queued turn is replayed only when all three still match. Changing server, API key or account leaves the old queue untouched and reports the skipped binding in status.
- Primary sessions write; cron and subagent contexts do not. Hermes remains responsible for redacting secrets and for skipping interrupted turns.
- The provider returns one recall indicator and no extra tools. CoMem's 16 MCP tools remain the explicit read/write interface.

The provider strips Hermes's `<memory-context>` fence and CoMem recall fences before capture, so recalled memory is not archived as a new user statement.

## Status and limits

`hermes memory status` shows the endpoint, authentication mode, the last authenticated subject, pending local writes, and the last transport error. Provider failures are logged and fail open.

The provider needs Hermes v0.23.1 or a compatible v0.23.x `MemoryProvider` ABI; v0.23.2 is verified. It targets CoMem's HTTP envelope and identity semantics; changing either API requires updating this adapter. `hermes memory status` checks configuration, not network reachability. After setup, compare the reported `subject` with the current space in the CoMem console, send a new prompt, and verify the archived messages in **Sessions**.

A completed archive leaves `messageCount` at zero when no live messages are retained; `lastCommitAt` is the evidence that submission succeeded. Task-list visibility differs by deployment and completion state, so do not infer a capture failure solely from an empty Tasks tab.

Provider state stays under `$HERMES_HOME/comem-provider/`. Deleting that directory discards queued local writes while leaving native Hermes memory and remote CoMem data intact.
