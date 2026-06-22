# GBRAIN Cloud Runtime Deployment Runbook

Status: no-cutover proof. Do not move ingestion, OAuth sessions, Telegram auth,
Granola auth, or OpenClaw crons in this phase.

## Target

- Platform: DigitalOcean App Platform Day 1. Railway remains a fallback.
- Service: always-on container running `gbrain serve --http`.
- Data: existing Supabase/Postgres GBRAIN database.
- Access: OAuth client credentials per tool/surface. Do not distribute the admin bootstrap token.
- Rollback: stop/delete the cloud proof service; Mac mini runtime and crons remain untouched.

DigitalOcean references:

- App specs: https://docs.digitalocean.com/products/app-platform/reference/app-spec/
- Dockerfile builds: https://docs.digitalocean.com/products/app-platform/reference/dockerfile/
- App Platform pricing: https://docs.digitalocean.com/products/app-platform/details/pricing/

Railway fallback references:

- CLI install/auth: https://docs.railway.com/cli
- Custom Dockerfile path: https://docs.railway.com/builds/dockerfiles

## Current Blockers

- DigitalOcean CLI (`doctl`) is installed. The DougButdorf account token is in
  local `secrets.env` as `DIGITALOCEAN_ACCESS_TOKEN`.
- DigitalOcean App Platform app exists:
  `794e8d0e-c218-4dea-9ed4-f0bc10cb28f2`.
- Docker is not installed here, so local image build verification is not available.
- Secrets are loaded into DigitalOcean App Platform from a private local spec.
- Public DigitalOcean app URL:
  `https://gbrain-cloud-runtime-v2l54.ondigitalocean.app`.

## One-Time Local Tooling

DigitalOcean CLI is installed locally as `doctl 1.162.0`. If this machine is
rebuilt, install it again with:

```bash
brew install doctl
doctl version
```

Authenticate only when Doug is ready to approve/use the DigitalOcean account:

```bash
set -a
source ./secrets.env
set +a
doctl --access-token "$DIGITALOCEAN_ACCESS_TOKEN" account get
```

Install Railway CLI without agent auto-configuration only if using the fallback:

```bash
bash <(curl -fsSL railway.com/install.sh) -y
export PATH="$HOME/.railway/bin:$PATH"
railway --version
railway telemetry disable
```

Current local status: Railway CLI `5.18.0` is installed and telemetry is
disabled. `railway whoami` is still unauthorized.

Authenticate:

```bash
railway login
```

Use browserless login if this is run over SSH:

```bash
railway login --browserless
```

Alternative for non-interactive deploy: set `RAILWAY_TOKEN` or
`RAILWAY_API_TOKEN` for the shell/session, then run the project commands below.

## Create No-Cutover Service On DigitalOcean

From the OpenClaw workspace:

```bash
cd /Users/landokeynes/.openclaw/workspace
chmod +x infra/gbrain-cloud-runtime/preflight.sh
./infra/gbrain-cloud-runtime/preflight.sh
```

Use DigitalOcean App Platform for the first proof. The committed spec builds
from public runtime-only repo `DougButdorf/gbrain-cloud-runtime` so DigitalOcean
does not need GitHub App access to the private workspace repo:

```bash
cp infra/gbrain-cloud-runtime/digitalocean-app.yaml /tmp/gbrain-cloud-runtime.do.yaml
```

Edit `/tmp/gbrain-cloud-runtime.do.yaml` locally and replace only the placeholder
secret values. Do not commit or paste real values into chat, reports, or repo
files. Then create the app:

```bash
doctl apps create --spec /tmp/gbrain-cloud-runtime.do.yaml
doctl apps list
doctl apps get <app-id>
doctl apps logs <app-id> --type run --follow
```

DigitalOcean App Platform creates a default HTTPS domain ending in
`ondigitalocean.app`. Set `GBRAIN_PUBLIC_URL` to that URL and redeploy/update the
app spec once the first deploy is healthy. Current proof URL is
`https://gbrain-cloud-runtime-v2l54.ondigitalocean.app`.

The committed spec intentionally uses:

- `git.repo_clone_url: https://github.com/DougButdorf/gbrain-cloud-runtime.git`
- `dockerfile_path: Dockerfile.do`
- `http_port: 8765`
- `/health` readiness and liveness checks
- `apps-s-1vcpu-0.5gb` for the cheapest proof. Move to
  `apps-s-1vcpu-1gb-fixed` if the runtime is memory constrained.

Set variables from `digitalocean.env.example`. Paste real secret values only
into DigitalOcean, never into repo files, chat, or reports.

Minimum required:

```bash
GBRAIN_DATABASE_URL='postgresql://...'
OPENAI_API_KEY='...'
GBRAIN_ADMIN_BOOTSTRAP_TOKEN='...'
GBRAIN_REQUIRE_ADMIN_TOKEN=1
GBRAIN_DISABLE_DIRECT_POOL=1
GBRAIN_HTTP_TRUST_PROXY=1
GBRAIN_HTTP_CORS_ORIGIN='https://claude.ai,https://chatgpt.com,https://chat.openai.com'
```

Current model-provider config also needs:

```bash
DEEPSEEK_API_KEY='...'
GOOGLE_GENERATIVE_AI_API_KEY='...'
```

Current DB-backed model config verified locally:

- embeddings: `text-embedding-3-large`, dimensions `1536`
- chat/reasoning: `deepseek:deepseek-chat`
- utility/expansion: `google:gemini-2.0-flash`

Add Anthropic only when we intentionally route specific GBRAIN tasks to it:

```bash
ANTHROPIC_API_KEY='...'
```

## Railway Fallback

From the OpenClaw workspace:

```bash
cd /Users/landokeynes/.openclaw/workspace
./infra/gbrain-cloud-runtime/preflight.sh
railway init --name gbrain-cloud-runtime
railway add --service gbrain-serve
railway link
railway variables set RAILWAY_DOCKERFILE_PATH=infra/gbrain-cloud-runtime/Dockerfile
```

Set variables from `env.example`. Paste real secret values only into Railway,
never into repo files, chat, or reports. Then deploy:

```bash
railway up --detach
railway logs
```

Generate or copy the Railway public domain, then set:

```bash
railway variables set GBRAIN_PUBLIC_URL='https://<railway-domain>'
railway up --detach
```

## Smoke Test

```bash
export GBRAIN_PUBLIC_URL='https://<railway-domain>'
curl -fsS "$GBRAIN_PUBLIC_URL/health"
./infra/gbrain-cloud-runtime/smoke-test.sh "$GBRAIN_PUBLIC_URL"
```

Expected `/health` shape is liveness JSON from GBRAIN. A 200 here only proves
runtime + DB liveness, not that all remote clients are connected.

## OAuth Clients For Tools

Register separate clients so access can be revoked per surface.

Read/write for coding agents that should query and capture pages:

```bash
GBRAIN_DATABASE_URL='postgresql://...' \
  gbrain auth register-client codex-cloud \
  --grant-types client_credentials \
  --scopes "read write" \
  --source codex \
  --federated-read default,openclaw,codex,claude

GBRAIN_DATABASE_URL='postgresql://...' \
  gbrain auth register-client claude-code-cloud \
  --grant-types client_credentials \
  --scopes "read write" \
  --source claude \
  --federated-read default,openclaw,codex,claude
```

Admin scope is reserved for Lando/operator maintenance:

```bash
GBRAIN_DATABASE_URL='postgresql://...' \
  gbrain auth register-client lando-admin-cloud \
  --grant-types client_credentials \
  --scopes "read write admin sources_admin users_admin" \
  --source openclaw \
  --federated-read default,openclaw,codex,claude
```

Mint and test a token:

```bash
curl -fsS -X POST "$GBRAIN_PUBLIC_URL/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=$GBRAIN_CLIENT_ID&client_secret=$GBRAIN_CLIENT_SECRET&scope=read%20write"

GBRAIN_BEARER_TOKEN='...' ./infra/gbrain-cloud-runtime/smoke-test.sh "$GBRAIN_PUBLIC_URL"
```

## Connect Agents

Use `gbrain connect` on each machine/tool surface after the DigitalOcean endpoint is
healthy and the OAuth client exists.

Codex example:

```bash
gbrain connect "$GBRAIN_PUBLIC_URL/mcp" \
  --oauth \
  --client-id "$GBRAIN_CODEX_CLIENT_ID" \
  --client-secret "$GBRAIN_CODEX_CLIENT_SECRET" \
  --agent codex \
  --install
```

Claude Code example:

```bash
gbrain connect "$GBRAIN_PUBLIC_URL/mcp" \
  --oauth \
  --client-id "$GBRAIN_CLAUDE_CLIENT_ID" \
  --client-secret "$GBRAIN_CLAUDE_CLIENT_SECRET" \
  --agent claude-code \
  --install
```

## Safety Gates

- Do not disable Mac mini GBRAIN or ingestion crons during Day 1.
- Do not move local OAuth/session files to Railway.
- Do not enable shell jobs in cloud (`GBRAIN_ALLOW_SHELL_JOBS` stays unset).
- Do not put `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` into Codex/Claude configs.
- Keep first external clients read/write only, not admin.
- Stop if Railway requires paid upgrade or a new external account/licensing step.
