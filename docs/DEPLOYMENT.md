# Production Deployment Runbook

Manual promotion of immutable, SHA-tagged images from GHCR to the Azure VM,
executed by GitHub Actions over SSH. Nobody SSHes into the VM for normal
deployments; nobody edits `.env` on the VM.

## Layout on the VM (provisioned once)

```
/opt/jtrack/
  docker-compose.prod.yml   # from repo (pinned to this repo's main)
  .env                      # SECRETS: DB_URL, REDIS_URL, KAFKA_*, JWT_*, SMTP, CLOUDINARY, API_KEY_NIM…
  versions.env              # GHCR_REPO + one *_TAG per service (the deployable state)
  nginx/…                   # nginx.conf + conf.d + ssl certs
  deployed-versions.txt     # audit log (appended by every deployment)
```

`versions.env` template:

```bash
GHCR_REPO=ghcr.io/<org>/<repo>
AUTH_TAG=<full-40-char-sha>
USER_TAG=<full-40-char-sha>
JOBSERVICE_TAG=<full-40-char-sha>
UTILS_TAG=<full-40-char-sha>
```

## One-time provisioning checklist

1. Create VM; open inbound 80/443 only; harden SSH (key-only).
2. Install Docker Engine + compose plugin.
3. `docker login ghcr.io` with a PAT that has `read:packages`.
4. Copy the four files above; fill `.env` secrets and initial SHA tags in
   `versions.env` (bootstrap by looking at GHCR package versions).
5. GitHub repo → Settings → Secrets → Actions:
   - `PROD_SSH_HOST`, `PROD_SSH_USER`, `PROD_SSH_KEY` (dedicated deploy key).
6. Optional but recommended: Settings → Environments → create `production`
   and add a required reviewer. The apply job targets this environment, so
   adding reviewers later adds an approval gate with zero workflow changes.
7. `docker compose --env-file versions.env pull && docker compose --env-file versions.env up -d`

## Promoting a release

Run the **Production Deploy** workflow (Actions tab → Production Deploy → Run workflow):

| Input | Meaning |
|---|---|
| `AUTH_TAG` … `UTILS_TAG` | Target Git SHA **per service**. Blank = leave untouched. Short SHAs are resolved automatically. |
| `dry_run` | Default **true**: validates everything and prints the plan without touching the VM. |
| `show_current` | Only print the currently deployed versions. |
| `allow_shared_partial` | Override for the coordinated-release guard — use sparingly, knowingly. |

What the workflow does before touching production:

1. Validates input format and resolves short SHAs to full SHAs.
2. Refuses partial selection if any selected commit touched
   `packages/shared/**`, `pnpm-lock.yaml`, root `package.json`,
   `pnpm-workspace.yaml`, or `.npmrc` unless all four services are selected
   (or you explicitly override). Those changes require a coordinated release.
3. Verifies every requested image exists in GHCR (`docker manifest inspect`).
   A missing artifact aborts before anything is changed.
4. Prints exactly which service → which SHA will be deployed.

What it does on the VM (only when `dry_run=false`):

```bash
cp versions.env versions.env.bak.<ts>          # rollback safety net
sed -i "s/^JOBSERVICE_TAG=.*/JOBSERVICE_TAG=<sha>/" versions.env   # per service
grep -q "^JOBSERVICE_TAG=<sha>$" versions.env  # verify edit landed
docker compose --env-file versions.env pull jobservice
docker compose --env-file versions.env up -d jobservice
```

Only the selected services are pulled and recreated. Compose additionally
guarantees unchanged services aren't recreated even if included by accident.
Afterwards each restarted service is polled until its HEALTHCHECK reports
healthy (120s budget); failure prints container logs and fails the run.

Every deployment appends to `deployed-versions.txt`:
`<UTC timestamp> <services deployed>` — plus each run URL lives in Actions history.

## Rolling back

Re-run **Production Deploy** with the previous known-good SHA for the affected
service(s) (find them in `deployed-versions.txt` / previous run summary).

- No rebuild happens — the old immutable image is still in GHCR.
- The pre-change file state also exists as `/opt/jtrack/versions.env.bak.*`.

## Verifying what is running

```bash
ssh <vm> 'cat /opt/jtrack/versions.env'                    # desired state
ssh <vm> 'cd /opt/jtrack && docker compose --env-file versions.env ps'
docker inspect ghcr.io/<org>/<repo>/jobservice:<sha> \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

## Image retention policy

- Every merge publishes `<service>:<full-SHA>` (+ convenience `:latest`).
- **Never delete** SHA images that are deployed or retained as rollback candidates.
- Safe periodic cleanup: delete *untagged* layers and stale `prbuild` artifacts;
  optionally keep only the last ~20 non-deployed SHA tags per package.
- Configure via GitHub package settings or a scheduled cleanup workflow — review
  against `deployed-versions.txt` first.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `P1002 advisory lock timeout` in auth logs | Migrations must use Neon's direct endpoint (the publish image already strips `-pooler`). Check auth startup logs show no `-pooler` host. |
| GHCR pull unauthorized on VM | `docker login ghcr.io` token expired — refresh the PAT. |
| Deployment failed after `up -d` | Check health output in the run; roll back by re-running with the previous SHA. |
| `versions.env` edited manually by someone | Re-run deploy with current desired tags; Compose converges to the env. |
