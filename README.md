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
        ├────────►│   PostgreSQL (Neon)  │
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
// Standard fetch (cookies sent automatically for same-origin)
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
You can proxy through Next.js API routes to forward cookies from the browser to backend services.

### Cookie-Based Auth Flow

1. User logs in via `POST /api/auth/login` — backend sets `accessToken` (15min) and `refreshToken` (7d) as httpOnly cookies
2. Subsequent requests include these cookies automatically
3. When the access token expires, the `isAuthenticated` middleware automatically refreshes it using the refresh token and sets a new access token cookie
4. Next.js Middleware can check for the presence of cookies to protect routes:

```ts
// middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const token = req.cookies.get("accessToken");
  if (!token) return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}
```

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
| **Database** | PostgreSQL via Neon (`@neondatabase/serverless`) |
| **Cache** | Redis 5 |
| **Message Broker** | Apache Kafka (via `kafkajs`) |
| **AI** | Groq (`llama-3.3-70b-versatile`), Google Gemini (`gemini-2.0-flash-lite`) |
| **Media** | Cloudinary |
| **Auth** | JWT (`jsonwebtoken`), bcrypt |
| **Validation** | Zod 4 |
| **Email** | Nodemailer (SMTP) |
| **Testing** | Vitest 4 |
| **Monorepo** | pnpm workspaces |

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

**Owns tables:** `users`, `skills`, `user_skills`

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

**Owns tables:** `companies`, `jobs`, `applications`, `job_analytics`

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

## Getting Started

### Prerequisites

- Node.js ≥20
- pnpm ≥9
- PostgreSQL database (Neon)
- Redis instance
- Apache Kafka broker
- API keys for Groq, Gemini, Cloudinary
- SMTP credentials

### Environment Variables

Create a `.env` file at the project root (or per-service `.env` files) based on `.env.example`:

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

---

## Shared Library (`@jtrack/shared`)

Reusable modules consumed by all services via `"@jtrack/shared": "workspace:*"`:

| Module | Export | Purpose |
|--------|--------|---------|
| `db` | `sql` | Neon serverless PostgreSQL client |
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

---

## Design Decisions

- **HTTP-only cookies for JWT** — access and refresh tokens stored in secure, httpOnly, sameSite cookies. Prevents XSS token exfiltration. Access token auto-refreshes via `isAuthenticated` middleware when expired but refresh token is valid.
- **SSE for AI responses** — career guidance, match analysis, and resume scoring stream tokens in real-time via Server-Sent Events rather than blocking on long-running AI inference.
- **Kafka for event-driven analytics** — job views, applications, and status changes are published as structured events to the `job-events` topic. Two independent consumer groups process the same stream: the analytics consumer (job service) aggregates daily counts into `job_analytics`, and the notification consumer (utils service) sends real-time recruiter alerts. This demonstrates the Kafka pattern of one event → multiple reactions.
- **Internal service HTTP calls** — auth, user, and job services call the utils service directly for file uploads and AI analysis. The utils service does not expose auth middleware externally, relying on network-level isolation. Endpoints are rate-limited instead.
- **pnpm workspaces** — strict dependency isolation with the `.pnpm` virtual store. Dependencies are deduplicated and hoisted only as configured via `.npmrc`.
- **Redis caching** — user profiles cached for 5 minutes; active jobs and job details cached with TTL. Cache invalidation on writes.

---

## Testing

```bash
# Run all tests
pnpm test

# Utils service tests only
cd services/utils && pnpm test
```

Tests use **Vitest** with v8 coverage. Currently covers the match analysis pipeline (Zod validation, PDF parsing, AI streaming, error handling, client disconnect).

---

## Project Structure

```
j-track-services/
├── .npmrc                        # pnpm: shamefully-hoist, peer deps
├── pnpm-workspace.yaml           # workspace: packages/*, services/*
├── package.json                  # workspace scripts
├── docker-compose.yml            # All services + infra containers
├── packages/
│   └── shared/                   # @jtrack/shared
│       ├── src/
│       │   ├── index.ts
│       │   ├── db.ts             # Neon PostgreSQL client
│       │   ├── token.ts          # JWT sign/verify
│       │   ├── cookies.ts        # Cookie options
│       │   ├── buffer.ts         # File → data URI
│       │   ├── errorHandler.ts   # Error handling middleware
│       │   ├── tryCatch.ts       # Async wrapper
│       │   ├── isauthenticated.ts# JWT middleware
│       │   ├── redis/helpers.ts  # Redis helpers
│       │   └── kafka/            # Kafka producer, topics, types
│       └── tsconfig.json
└── services/
    ├── auth/                     # Authentication service
    ├── user/                     # Profile & skills service
    ├── jobservice/               # Jobs, companies, applications
    └── utils/                    # AI, uploads, email consumer
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
