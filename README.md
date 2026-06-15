# j-track-services

> **j-track** — Microservices-based job tracking platform backend.

A pnpm monorepo powering a job marketplace with JWT-authenticated REST APIs, AI-powered resume analysis and career guidance, real-time SSE streaming, async email delivery via Kafka, and Redis caching — all built with TypeScript on Express 5.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 Next.js Frontend                         │
│            http://localhost:3000                          │
│  Server Components | API Routes | Client Components      │
└──────┬──────────────────────────┬───────────────────────┘
       │                          │
       │       HTTP (REST)        │
       ▼                          ▼
┌──────────────┐   ┌─────────────────────────────┐
│ Auth Service │   │   User Service               │
│ :7000        │   │   :7001                      │
│ /api/auth/*  │   │   /api/users/*               │
│ JWT · bcrypt │   │   Profile · Skills           │
└──────┬───────┘   └──────────┬──────────────────┘
       │                       │
       │    ┌──────────────────▼──────────┐
       │    │   Job Service               │
       │    │   :7002                     │
       │    │   /api/jobs/*               │
       │    │   Companies · Jobs · Apply   │
       │    └──────────┬─────────────────┘
       │               │
       │   ┌───────────▼─────────────────────┐
       │   │   Utils Service                  │
       │   │   :6001                          │
       │   │   /api/utils/upload             │
       │   │   /api/utils/ai/*               │
       │   │   Gemini · Groq · Cloudinary     │
       │   │   Nodemailer (email consumer)    │
       │   └─────────────────────────────────┘
       │
        │         ┌──────────────────────┐
        ├────────►│   Apache Kafka        │
        │         │  send-mail            │
        │         │  job-events           │
        │         └──────────┬───────────┘
        │                    │
        │         ┌──────────▼──────────┐
        ├────────►│   PostgreSQL         │
        │         │  + job_analytics     │
        │         └─────────────────────┘
       │
       │         ┌─────────────────────┐
       ├────────►│   Redis              │
       │         │  Cache + Rate Limit  │
       │         └─────────────────────┘
```

### Service Communication Patterns

| Pattern | Mechanism | Use Case |
|---------|-----------|----------|
| **Synchronous** | HTTP REST (internal) | Auth/User/Job → Utils for file uploads & AI analysis via `UTILS_SERVICE_URL` |
| **Asynchronous** | Apache Kafka | Auth/Job → `send-mail` topic → Utils consumer → Nodemailer SMTP |
| **Event-driven** | Apache Kafka | Job service → `job-events` topic → analytics consumer (DB aggregation) + notification consumer (recruiter alerts) |
| **Shared Library** | `@jtrack/shared` workspace package | Database client, JWT utilities, auth middleware, error handling, Kafka/Redis helpers |

---

## Next.js Integration

This backend is designed to work with a Next.js frontend. Here's how they connect:

### API Calls

All services expose REST endpoints at their respective ports. A Next.js app can call them in three ways:

**Server Components (SSR):**
```ts
// app/jobs/page.tsx
async function getJobs() {
  const res = await fetch("http://jobservice:7002/api/jobs/active-jobs", {
    cache: "no-store",
  });
  return res.json();
}

export default async function JobsPage() {
  const jobs = await getJobs();
  // ...
}
```
For server-side calls, use the Docker service name (`http://auth:7000`, `http://user:7001`, etc.) when running in Docker, or `http://localhost:PORT` during local dev.

**Client Components:**
```ts
const res = await fetch("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
  credentials: "include",
});
```
The backend sets JWT tokens as `httpOnly`, `sameSite: "strict"` cookies. Browsers send them automatically on same-origin requests. For cross-origin (frontend on `:3000`, backend on `:7xxx`), CORS is configured to allow `http://localhost:3000` with `credentials: true`.

**Next.js Route Handlers (API Routes):**
```ts
// app/api/proxy/route.ts
export async function POST(req: Request) {
  const body = await req.json();
  const res = await fetch("http://localhost:7001/api/users/me", {
    headers: { cookie: req.headers.get("cookie") || "" },
  });
  return new Response(await res.text(), { status: res.status });
}
```

### Cookie-Based Auth Flow

1. User logs in via `POST /api/auth/login` — backend sets `accessToken` (15min) and `refreshToken` (7d) as httpOnly cookies
2. Subsequent requests include these cookies automatically
3. When the access token expires, the `isAuthenticated` middleware automatically refreshes it using the refresh token and sets a new access token cookie
4. Next.js Middleware can check for the presence of cookies to protect routes

### CORS

All services configure CORS with:
- Origin: `http://localhost:3000`
- Credentials: `true`

Adjust the `FRONTEND_URL` environment variable for production deployments.

---

## Tech Stack

| Category | Technology |
|----------|-----------|
| **Runtime** | Node.js ≥20 |
| **Language** | TypeScript 6 |
| **Framework** | Express 5 |
| **Database** | PostgreSQL |
| **ORM** | Prisma 6 |
| **Cache** | Redis 7 |
| **Message Broker** | Apache Kafka (via `kafkajs`) |
| **AI** | Groq, Google Gemini |
| **Media** | Cloudinary |
| **Auth** | JWT (`jsonwebtoken`), bcrypt |
| **Validation** | Zod 4 |
| **Email** | Nodemailer (SMTP) |
| **Testing** | Vitest 4 |
| **CI/CD** | GitHub Actions |
| **Container Registry** | GitHub Container Registry (GHCR) |
| **Monorepo** | pnpm workspaces |
| **Migrations** | Prisma Migrate |

---

## Services

### Auth Service (`:7000`)

Authentication gateway — registration, login, password management.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/auth/register` | POST | No | Register user (recruiter/jobseeker) with optional resume |
| `/api/auth/login` | POST | No | Login → JWT access + refresh cookies |
| `/api/auth/logout` | POST | Yes | Clear session |
| `/api/auth/me` | GET | Yes | Current user profile |
| `/api/auth/forgot-password` | POST | No | Sends reset email via Kafka |
| `/api/auth/reset-password/:token` | POST | No | Reset password with token |
| `/api/auth/change-password` | PATCH | Yes | Change password (requires current password) |
| `/health` | GET | No | Health check (DB, Redis, Kafka) |

### User Service (`:7001`)

Profile and skills management.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/users/me` | GET | Yes | Full profile with skills |
| `/api/users/:id` | GET | No | Public profile (Redis-cached) |
| `/api/users/update` | PUT | Yes | Update name, phone, bio |
| `/api/users/bio` | PUT | Yes | Update bio only |
| `/api/users/profile-pic` | POST | Yes | Upload profile picture |
| `/api/users/resume` | POST | Yes | Upload resume (jobseeker) |
| `/api/users/add-skill` | POST | Yes | Add skill to profile |
| `/api/users/remove-skill` | DELETE | Yes | Remove skill |
| `/api/users/skills` | GET | No | All available skills |
| `/health` | GET | No | Health check |

### Job Service (`:7002`)

Companies, jobs, applications, and match analysis.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/jobs/create-com` | POST | Yes | Create company (with logo upload) |
| `/api/jobs/` | GET | No | List all companies |
| `/api/jobs/:company_id` | GET | No | Get company by ID |
| `/api/jobs/detail/:company_id` | GET | Yes | Get company with all job listings |
| `/api/jobs/:id` | DELETE | Yes | Delete company |
| `/api/jobs/create-job` | POST | Yes | Create job listing |
| `/api/jobs/jobs/:job_id` | PATCH | Yes | Update job listing |
| `/api/jobs/jobs/:job_id` | DELETE | Yes | Delete job listing |
| `/api/jobs/active-jobs` | GET | No | All active job listings |
| `/api/jobs/jobs/:job_id` | GET | No | Job detail |
| `/api/jobs/apply` | POST | Yes | Apply to job (SSE response) |
| `/api/jobs/my-applications` | GET | Yes | User's applications |
| `/api/jobs/applications-by-job/:job_id` | GET | Yes | Recruiter view of applications |
| `/api/jobs/applications/:application_id` | PATCH | Yes | Update application status |
| `/api/jobs/analyze-match/:jobId` | POST | Yes | SSE match analysis (internally calls Utils) |
| `/api/jobs/analytics/:job_id` | GET | Yes | Recruiter dashboard: daily views, applications, status changes |
| `/health` | GET | No | Health check (DB, Redis, Kafka) |

### Utils Service (`:6001`)

AI-powered utilities, file storage, email delivery.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/utils/upload` | POST | No | Upload to Cloudinary (internal) |
| `/api/utils/:public_id` | DELETE | No | Delete from Cloudinary (internal) |
| `/api/utils/ai/career-guidance` | POST | No | SSE career advice (Gemini) — rate-limited |
| `/api/utils/ai/analyze-match` | POST | No | SSE match analysis (Groq) — rate-limited |
| `/api/utils/ai/analyze` | POST | No | SSE resume analysis (Groq) — rate-limited |
| `/api/utils/ai/generate` | POST | No | Test Gemini prompt — rate-limited |

**Kafka consumers:**
- `mail-service-group` — listens on `send-mail` topic → sends email via Nodemailer. Failed deliveries routed to `send-mail-dlq`.
- `notification-group` — listens on `job-events` topic → sends new application alerts to recruiters.

---

## CI/CD Pipeline

The project uses GitHub Actions for continuous integration. The pipeline runs **only on pull requests** — no separate build on merge.

### Pipeline jobs

| Job | Trigger | Description |
|-----|---------|-------------|
| `infra-check` | Always | Validates docker-compose and nginx config syntax |
| `changes` | Always | Detects which files changed using `dorny/paths-filter` |
| `audit` | Always | Runs `pnpm audit --audit-level=high` |
| `build` | Services changed | Builds, lints, type-checks, and tests each changed service |
| `smoke-e2e` | E2E or services changed | Spins up all services and runs one critical cross-service flow |
| `docker-build` | Services changed | Builds Docker images with layer caching, smoke tests containers, scans with Trivy |
| `ci-passed` | Always | Gate — exits non-zero if any upstream job failed |

### Path-based filtering

Only services with file changes are built and dockerized. The `changes` job computes a dynamic matrix:

| Changed path | Services built |
|---|---|
| `services/auth/**` | auth |
| `services/user/**` | user |
| `services/jobservice/**` | jobservice |
| `services/utils/**` | utils |
| `packages/shared/**` | all 4 |
| `e2e/**` | none (triggers smoke-e2e only) |
| `.github/workflows/**`, config files | none |

### Docker build

Each service builds a Docker image using `docker/build-push-action` with:
- **Layer caching** via GHCR (`type=registry`) — dependency install layers are reused across runs, reducing build time from ~3min to ~20s
- **Builder driver** — `docker-container` (via `setup-buildx-action`) enables registry cache export
- **Lowercase registry** — repository name is lowercased to satisfy Docker tag requirements

### Image tagging

- **PR builds** — images are pushed to GHCR tagged with the commit SHA (e.g., `ghcr.io/org/repo/auth:abc123`)
- **On merge** — a separate `retag.yml` workflow copies the SHA tag to `latest` using `docker buildx imagetools create` (manifest copy, no rebuild)

### Trivy vulnerability scanning

Every Docker image is scanned with [Trivy](https://github.com/aquasecurity/trivy-action) at `CRITICAL` and `HIGH` severity levels. Non-zero findings are reported but do not block CI.

### E2E testing

| Test suite | When | Coverage |
|---|---|---|
| **Smoke** (`smoke-e2e`) | Every PR with code changes | Single critical flow: register → cross-service JWT → create company → create job → apply → verify. Runs in ~5-7min. |
| **Full suite** (`e2e-full.yml`) | Weekly (Sunday 2AM) + manual dispatch | All 500+ tests across auth, user, jobs modules. Runs in ~20min. |

The smoke test covers the most common failure modes: broken cross-service JWT, Kafka message loss, DB schema drift, and role/permission enforcement.

---

## Container Registry

Docker images are hosted on **GitHub Container Registry (GHCR)**:

```
ghcr.io/<owner>/j-track-services/<service>:<sha>
```

Cache manifests are stored alongside images using the `:cache` tag suffix:

```
ghcr.io/<owner>/j-track-services/<service>:cache
```

---

## Dependabot

Dependencies are managed automatically via Dependabot:

| Ecosystem | Schedule | Groups |
|-----------|----------|--------|
| npm | Weekly (Sunday) | `patches`, `minor` |
| GitHub Actions | Weekly (Sunday) | — |

Patches and minor updates are grouped into single PRs to reduce noise. Pull requests trigger the full CI pipeline automatically.

---

## Getting Started

### Prerequisites

- Node.js ≥20
- pnpm ≥9
- PostgreSQL database
- Redis instance
- Apache Kafka broker
- API keys for Groq, Gemini, Cloudinary
- SMTP credentials

### Environment Variables

Create a `.env` file at the project root based on `.env.example`:

| Variable | Required | Services | Default |
|----------|----------|----------|---------|
| `DB_URL` | Yes | All | `postgresql://jtrack:jtrack123@localhost:5432/jtrack` |
| `REDIS_URL` | Yes | Auth, User, Job | `redis://localhost:6379` |
| `KAFKA_BROKER` | Yes | Auth, Job, Utils | `localhost:9092` |
| `JWT_ACCESS_SECRET` | Yes | Auth, Shared | — |
| `JWT_REFRESH_SECRET` | Yes | Auth, Shared | — |
| `JWT_RESET_SECRET` | Yes | Auth | — |
| `UTILS_SERVICE_URL` | Yes | Auth, User, Job | `http://localhost:6001/api/utils` |
| `FRONTEND_URL` | Yes | Auth, User, Job | `http://localhost:3000` |
| `CLOUD_NAME` | Yes | Utils | — |
| `CLOUD_API_KEY` | Yes | Utils | — |
| `CLOUD_API_SECRET` | Yes | Utils | — |
| `API_KEY_GROQ` | Yes | Utils | — |
| `API_KEY_GEMINI` | Yes | Utils | — |
| `SMTP_HOST` | Yes | Utils | `smtp.gmail.com` |
| `SMTP_PORT` | Yes | Utils | `465` |
| `SMTP_SECURE` | No | Utils | `true` |
| `MAIL_USER` | Yes | Utils | — |
| `MAIL_PASS` | Yes | Utils | — |
| `NODE_ENV` | No | All | `development` |
| `PORT` | No | Per service | *(see Ports)* |
| `KAFKA_CONNECTION_TIMEOUT` | No | Auth, Job, Utils | `10000` |
| `KAFKA_AUTH_TIMEOUT` | No | Auth, Job, Utils | `10000` |
| `KAFKA_RETRY_INITIAL_TIME` | No | Auth, Job, Utils | `300` |
| `KAFKA_RETRY_COUNT` | No | Auth, Job, Utils | `10` |
| `KAFKA_SASL_MECHANISM` | No | Auth, Job, Utils | — |
| `KAFKA_SASL_USERNAME` | No | Auth, Job, Utils | — |
| `KAFKA_SASL_PASSWORD` | No | Auth, Job, Utils | — |
| `KAFKA_SSL` | No | Auth, Job, Utils | — |
| `KAFKA_CONSUMER_GROUP` | No | Utils | `mail-service-group` |
| `KAFKA_MAIL_TOPIC` | No | Utils | `send-mail` |
| `KAFKA_DLQ_TOPIC` | No | Utils | `send-mail-dlq` |
| `MAIL_SEND_RETRIES` | No | Utils | `3` |

### Ports

| Service | Default |
|---------|---------|
| Auth | `7000` |
| User | `7001` |
| Job | `7002` |
| Utils | `6001` |

### Install & Run (Local)

```bash
# Install dependencies
pnpm install

# Build shared library first, then services
pnpm run build

# Run all services in dev mode (watch + restart)
pnpm run dev

# Run individual services
pnpm run dev:auth
pnpm run dev:user
pnpm run dev:job
pnpm run dev:utils
```

### Docker

```bash
# Build all service images
pnpm run docker:build

# Start everything (PostgreSQL, Redis, Kafka, all services)
pnpm run docker:up

# View logs
pnpm run docker:logs

# Stop everything
pnpm run docker:down
```

### Database Seeding

```bash
cd services/jobservice
pnpm tsx seed.ts
```

Populates: 2 recruiters, 8 jobseekers, 3 companies, 8 jobs, 10 skills, 15 applications.

> **Note:** Migrations are applied automatically at service startup via `prisma migrate deploy`. No manual migration step needed after the initial `prisma migrate dev` during local development.

---

## Shared Library (`@jtrack/shared`)

Reusable modules consumed by all services via `"@jtrack/shared": "workspace:*"`:

| Module | Export | Purpose |
|--------|--------|---------|
| `db` | `prisma` | PrismaClient singleton |
| `token` | `signAccessToken`, `signRefreshToken`, `signResetToken` | JWT helpers (15min / 7d / 15min) |
| `cookies` | `accessCookieOptions`, `refreshCookieOptions` | HTTP-only, secure, sameSite cookie config |
| `buffer` | `getBuffer` | File → data URI conversion |
| `errorHandler` | `ErrorHandler` class, `errorMiddleware` | Custom errors with status codes |
| `tryCatch` | `TryCatch` | Express async error wrapper |
| `isauthenticated` | `isAuthenticated` | JWT verification + auto-refresh middleware |
| `kafka/producer` | `getKafkaProducer` | Kafka producer singleton |
| `kafka/topic` | `ensureTopic`, `listTopics` | Topic management |
| `kafka/types` | `MailMessage`, `KafkaHealth`, `ProducerInstance` | Type definitions |
| `kafka/config` | `resolveKafkaConfig`, `sleep` | Shared Kafka config builder |
| `kafka/consumer` | `checkKafkaHealth` | Consumer health check helper |
| `redis/helpers` | `createRedisHelpers` | Generic Redis get/set/delete + rate limiting |
| `migrate` | `runMigrationsWithLock` | Runs `prisma migrate deploy` at service startup |

---

## Design Decisions

- **HTTP-only cookies for JWT** — access and refresh tokens stored in secure, httpOnly, sameSite cookies. Prevents XSS token exfiltration. Access token auto-refreshes via `isAuthenticated` middleware when expired but refresh token is valid.
- **SSE for AI responses** — career guidance, match analysis, and resume scoring stream tokens in real-time via Server-Sent Events rather than blocking on long-running AI inference.
- **Kafka for event-driven analytics** — job views, applications, and status changes are published as structured events to the `job-events` topic. Two independent consumer groups process the same stream: the analytics consumer (job service) upserts daily counts into `job_analytics` via Prisma, and the notification consumer (utils service) sends real-time recruiter alerts.
- **Internal service HTTP calls** — auth, user, and job services call the utils service directly for file uploads and AI analysis. The utils service does not expose auth middleware externally, relying on network-level isolation. Endpoints are rate-limited instead.
- **pnpm workspaces** — strict dependency isolation with the `.pnpm` virtual store. Dependencies are deduplicated and hoisted only as configured via `.npmrc`.
- **Redis caching** — user profiles cached for 5 minutes; active jobs and job details cached with TTL. Cache invalidation on writes.
- **Prisma ORM with raw escape hatches** — the monorepo migrated from raw `pg` SQL to Prisma for auto-generated migrations, type-safe queries, and schema management. ~60 of ~72 queries use Prisma's generated client; the remaining 12 use `$queryRaw` for PostgreSQL-specific features (JSON aggregates, full-text search, COALESCE sums) that don't map cleanly to Prisma's query API.
- **tsvector full-text search** — `users` and `companies` tables have `search_vector tsvector` columns updated by PL/pgSQL triggers on INSERT/UPDATE, with GIN indexes for efficient search. The Prisma schema uses `Unsupported("tsvector")` for these columns.
- **Single CI pipeline** — everything runs on PR only (including docker build and push). No redundant pipeline on merge. Critical e2e smoke test on every PR prevents merge of broken cross-service flows.

---

## Testing

```bash
# Run all unit tests
pnpm test

# Run e2e smoke test (single critical flow)
pnpm test:e2e

# Run full e2e suite
pnpm test:e2e:watch
```

Tests use **Vitest** with v8 coverage. Unit tests cover controllers, validators, and service logic with mocked dependencies. E2E tests spin up all 4 services against real PostgreSQL, Redis, and Kafka instances.

---

## Project Structure

```
j-track-services/
├── .github/
│   ├── actions/setup/          # Composite action: checkout + deps + build + DB init
│   ├── workflows/
│   │   ├── ci.yml              # Main PR pipeline
│   │   ├── e2e-full.yml        # Full e2e suite (weekly + manual)
│   │   └── retag.yml           # Retag SHA → latest on merge
│   └── dependabot.yml
├── e2e/                         # End-to-end tests
│   ├── src/
│   │   ├── smoke.test.ts        # Single critical cross-service flow
│   │   ├── auth.test.ts
│   │   ├── user.test.ts
│   │   ├── jobs.test.ts
│   │   ├── client.ts            # HTTP client with cookie support
│   │   ├── config.ts            # Service URLs and endpoints
│   │   ├── fixtures.ts          # Test data generators
│   │   └── helpers.ts           # Auth helpers (register, login)
│   ├── vitest.config.ts
│   └── package.json
├── nginx/                       # Reverse proxy config
│   ├── Dockerfile
│   ├── Dockerfile.prod
│   ├── nginx.conf
│   ├── prod/conf.d/
│   └── ssl/
├── packages/
│   └── shared/                  # @jtrack/shared
│       ├── prisma/
│       │   ├── schema.prisma     # Prisma schema (8 tables, 5 enums, tsvector)
│       │   └── migrations/       # Versioned migration SQL
│       ├── src/
│       │   ├── index.ts
│       │   ├── db.ts
│       │   ├── token.ts
│       │   ├── cookies.ts
│       │   ├── buffer.ts
│       │   ├── errorHandler.ts
│       │   ├── tryCatch.ts
│       │   ├── isauthenticated.ts
│       │   ├── migrate.ts        # Runs prisma migrate deploy at startup
│       │   ├── redis/helpers.ts
│       │   └── kafka/
│       └── tsconfig.json
├── services/
│   ├── auth/                    # Authentication service
│   ├── user/                    # Profile & skills service
│   ├── jobservice/              # Jobs, companies, applications
│   └── utils/                   # AI, uploads, email consumer
├── docker-compose.yml
├── docker-compose.dev.yml
├── docker-compose.prod.yml
├── eslint.config.js
├── pnpm-workspace.yaml
└── package.json
```

---

## Kafka Topics

| Topic | Producer | Consumer | Purpose |
|-------|----------|----------|---------|
| `send-mail` | Auth, Job | Utils (mail-service-group) | Password resets, application status |
| `send-mail-dlq` | Utils | — | Dead-letter queue for failed sends |
| `job-events` | Job | Job (job-analytics-group), Utils (notification-group) | Job view/app/status tracking, recruiter alerts |

---

## License

MIT
