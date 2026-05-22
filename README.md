# j-track-services

> **HireHeaven** — Microservices-based job tracking platform backend.

A pnpm monorepo powering a job marketplace with JWT-authenticated REST APIs, AI-powered resume analysis and career guidance, real-time SSE streaming, async email delivery via Kafka, and Redis caching — all built with TypeScript on Express 5.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Frontend (React)                      │
│                   http://localhost:3000                  │
└──────────────┬──────────────────────────┬───────────────┘
               │                          │
               │       HTTP (REST)        │
               ▼                          ▼
┌─────────────────────┐   ┌─────────────────────────────┐
│   Auth Service      │   │    User Service              │
│   :7000             │   │    :7001                     │
│   /api/auth/*       │   │    /api/users/*              │
│   JWT · bcrypt      │   │    Profile · Skills          │
└──────┬──────────────┘   └──────────┬──────────────────┘
       │                              │
       │                              │
       │         ┌────────────────────▼──────────┐
       │         │     Job Service                │
       │         │     :7002                      │
       │         │     /api/jobs/*                │
       │         │     Companies · Jobs · Apply    │
       │         └──────────┬────────────────────┘
       │                     │
       │                     │
       │   ┌─────────────────▼────────────────────┐
       │   │      Utils Service                    │
       │   │      :6001                            │
       │   │      /api/utils/ai/*                  │
       │   │      /api/utils/upload                │
       │   │      Gemini · Groq · Cloudinary       │
       │   │      Nodemailer (email consumer)      │
       │   └──────────────────────────────────────┘
       │
       │              ┌─────────────────────┐
       ├──────────────►     Apache Kafka     │
       │   (send-mail) │                     │
       │              └──────────┬──────────┘
       │                         │
       │              ┌──────────▼──────────┐
       │              │     PostgreSQL       │
       ├──────────────►     (Neon)           │
       │              │                     │
       │              └─────────────────────┘
       │
       │              ┌─────────────────────┐
       ├──────────────►     Redis            │
       │              │  Cache + Rate Limit  │
       │              └─────────────────────┘
```

### Service Communication Patterns

| Pattern | Mechanism | Use Case |
|---------|-----------|----------|
| **Synchronous** | HTTP REST (internal) | Auth/User/Job → Utils for file uploads & AI analysis via `UTILS_SERVICE_URL` |
| **Asynchronous** | Apache Kafka | Auth/Job → `send-mail` topic → Utils consumer → Nodemailer SMTP |
| **Shared Library** | `@jtrack/shared` workspace package | Database client, JWT utilities, auth middleware, error handling, Kafka/Redis helpers |

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
| `/api/auth/register` | POST | No | Register user (recruiter/jobseeker) |
| `/api/auth/login` | POST | No | Login → JWT access + refresh cookies |
| `/api/auth/logout` | POST | Yes | Clear session |
| `/api/auth/me` | GET | Yes | Current user profile |
| `/api/auth/forgot-password` | POST | No | Sends reset email via Kafka |
| `/api/auth/reset-password/:token` | POST | No | Reset password with token |
| `/api/auth/change-password` | PATCH | Yes | Change password |
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
| `/api/jobs/create-com` | POST | Yes | Create company |
| `/api/jobs/:id` | DELETE | Yes | Delete company |
| `/api/jobs/` | GET | No | List companies |
| `/api/jobs/:company_id` | GET | No | Get company |
| `/api/jobs/detail/:company_id` | GET | No | Company with jobs |
| `/api/jobs/create-job` | POST | Yes | Create job listing |
| `/api/jobs/jobs/:job_id` | PATCH/DELETE | Yes | Update/delete job |
| `/api/jobs/active-jobs` | GET | No | Active job listings |
| `/api/jobs/jobs/:job_id` | GET | No | Job detail |
| `/api/jobs/apply` | POST | Yes | Apply to job |
| `/api/jobs/my-applications` | GET | Yes | User's applications |
| `/api/jobs/applications-by-job/:job_id` | GET | Yes | Recruiter view |
| `/api/jobs/applications/:application_id` | PATCH | Yes | Update status |
| `/api/jobs/analyze-match/:jobId` | POST | Yes | SSE match analysis |
| `/health` | GET | No | Health check |

**Owns tables:** `companies`, `jobs`, `applications`

### Utils Service (`:6001`)

AI-powered utilities, file storage, email delivery.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/utils/upload` | POST | Internal | Upload to Cloudinary |
| `/api/utils/:public_id` | DELETE | Internal | Delete from Cloudinary |
| `/api/utils/ai/career-guidance` | POST | Yes | SSE career advice (Gemini) |
| `/api/utils/ai/analyze-match` | POST | Yes | SSE match analysis (Groq) |
| `/api/utils/ai/analyze` | POST | Yes | SSE ATS resume scoring (Groq) |
| `/api/utils/ai/generate` | POST | Yes | Test Gemini prompt |

**Kafka consumer:** Listens on `send-mail` topic → sends email via Nodemailer. Failed deliveries routed to `send-mail-dlq`.

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

Create a `.env` file in each service directory or manage them centrally:

| Variable | Required | Services | Default |
|----------|----------|----------|---------|
| `DB_URL` | Yes | All | — |
| `REDIS_URL` | Yes | Auth, User, Job | — |
| `KAFKA_BROKER` | Yes | Auth, Job, Utils | `localhost:9092` |
| `JWT_ACCESS_SECRET` | Yes | Auth, Shared | — |
| `JWT_REFRESH_SECRET` | Yes | Auth, Shared | — |
| `JWT_RESET_SECRET` | Yes | Auth, Shared | — |
| `UTILS_SERVICE_URL` | Yes | Auth, User, Job | — |
| `FRONTEND_URL` | Yes | Auth, Job | `http://localhost:3000` |
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

### Ports

| Service | Default |
|---------|---------|
| Auth | `7000` |
| User | `7001` |
| Job | `7002` |
| Utils | `6001` |

### Install & Run

```bash
# Install dependencies (root node_modules with pnpm virtual store)
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
| `redis/helpers` | `createRedisHelpers` | Generic Redis get/set/delete + rate limiting |

---

## Design Decisions

- **HTTP-only cookies for JWT** — access and refresh tokens stored in secure, httpOnly, sameSite cookies. Prevents XSS token exfiltration. Access token auto-refreshes via `isAuthenticated` middleware when expired but refresh token is valid.
- **SSE for AI responses** — career guidance, match analysis, and resume scoring stream tokens in real-time via Server-Sent Events rather than blocking on long-running AI inference.
- **Kafka for async email** — password resets and application status notifications are published to `send-mail` topic. The utils service consumes asynchronously, decoupling email delivery from request-response cycles. Failed deliveries go to `send-mail-dlq` dead-letter queue.
- **Internal service HTTP calls** — auth, user, and job services call the utils service directly for file uploads and AI analysis. The utils service does not expose auth middleware externally, relying on network-level isolation.
- **pnpm workspaces** — strict dependency isolation with the `.pnpm` virtual store. Dependencies are deduplicated and hoisted only as configured via `.npmrc` (`shamefully-hoist=true`).
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
| `send-mail` | Auth, Job | Utils | Password resets, application status |
| `send-mail-dlq` | Utils | — | Dead-letter queue for failed sends |

---

## License

MIT
