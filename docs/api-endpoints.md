# J-Track Backend — Full API Reference for Frontend Development

All endpoints, purpose, request shape, response shape, auth requirements, and
example frontend calls. Verified against the actual route/controller source code
in `services/*/src/`.

---

## 1. Base URLs & Ports

| Service | Local dev | Docker (server-side only) | Route prefix |
|---------|-----------|---------------------------|--------------|
| Auth    | `http://localhost:7000` | `http://auth:7000`      | `/api/auth/*`  |
| User    | `http://localhost:7001` | `http://user:7001`      | `/api/users/*` |
| Job     | `http://localhost:7002` | `http://jobservice:7002` | `/api/jobs/*` |
| Utils   | `http://localhost:6001` | `http://utils:6001`     | `/api/utils/*` |

In production, nginx proxies everything behind one domain on the same origin:

| Frontend URL | Proxied to |
|--------------|-----------|
| `/api/auth/*`  | auth service   |
| `/api/users/*` | user service   |
| `/api/jobs/*`  | job service    |
| `/api/utils/*` | utils service  |
| `/api/auth/health`, `/api/users/health`, `/api/jobs/health`, `/api/utils/health` | per-service `/health` |

So in a deployed app the frontend can call **same-origin relative paths**
(`/api/auth/login`, `/api/jobs/active-jobs`, ...) and nginx routes them. In local
dev you call the full URLs with `http://localhost:PORT`.

---

## 2. Authentication Model (read this first)

- JWT tokens are stored in **httpOnly cookies**, not localStorage.
- Login/register set two cookies: `accessToken` (15 min) and `refreshToken` (7 days),
  both `httpOnly`, `secure`, `sameSite: strict`.
- Browsers send them automatically on every same-origin request. For cross-origin
  dev (frontend `:3000` → backend `:7xxx`) the services set CORS with
  `origin: FRONTEND_URL` and `credentials: true`, so you must fetch with
  `credentials: "include"`.
- The `isAuthenticated` middleware (used on all protected routes) verifies the
  access token. If it is expired but a valid refresh token exists, it
  **automatically issues a new accessToken cookie** in the response — the frontend
  does not need to implement refresh logic.
- A user with an unverified email cannot log in (login returns `403`).
- Roles: `recruiter` or `jobseeker`. Several endpoints are role-gated.

### Frontend fetch convention

```ts
// JSON request (same-origin via nginx, or cross-origin with credentials)
const res = await fetch("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  credentials: "include",        // required for cookies cross-origin
  body: JSON.stringify({ email, password }),
});

// Multipart (file upload)
const fd = new FormData();
fd.append("file", fileInput.files[0]);   // field name varies — see each endpoint
const res = await fetch("/api/users/profile-pic", {
  method: "POST",
  credentials: "include",
  body: fd,                               // do NOT set Content-Type manually
});
```

**Error shape (global error middleware):** non-2xx responses return JSON:
```json
{ "success": false, "message": "Human readable error" }
```

---

## 3. AUTH SERVICE  (`:7000`) — `/api/auth/*`

### 3.1 `POST /api/auth/register`  (public)
Create a user. `recruiter` gets `name/email/password/phone_number/role`.
`jobseeker` may also pass `bio` and an optional resume file.
- **Multipart/form-data** (because of optional file upload). Field names:
  `name`, `email`, `password`, `phone_number`, `role`, `bio` (optional), `file` (optional, resume PDF/image).
- On success a verification email is sent (via Kafka) with a link to
  `${FRONTEND_URL}/verify-email?token=...`.
- Roles must be exactly `"recruiter"` or `"jobseeker"`.

Request fields:
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "StrongPass1!",
  "phone_number": "09123456789",
  "role": "jobseeker",
  "bio": "optional bio for jobseekers"
}
// + optional file part "file" for jobseeker resume
```

Response `201`:
```json
{ "message": "User registered successfully. Please verify your email to log in." }
```

Frontend:
```ts
const fd = new FormData();
fd.append("name", name);
fd.append("email", email);
fd.append("password", password);
fd.append("phone_number", phone);
fd.append("role", role);
if (resumeFile) fd.append("file", resumeFile);
if (bio) fd.append("bio", bio);
await fetch("/api/auth/register", { method: "POST", body: fd, credentials: "include" });
```
Notes: login/register are rate-limited (100 per 15 min per IP, stricter via nginx).

### 3.2 `POST /api/auth/verify-email`  (public)
Confirm the email with the token from the emailed link.
```json
{ "token": "<token from URL query param>" }
```
Response `200`:
```json
{ "success": true, "message": "Email verified successfully. You can now log in." }
```
Frontend: read `token` from the URL (`/verify-email?token=...`) and POST it here.
The token is single-use and expires after 15 minutes (stored in Redis).

### 3.3 `POST /api/auth/resend-verification`  (public)
Re-send the verification email.
```json
{ "email": "john@example.com" }
```
Response `200`:
```json
{ "success": true, "message": "Verification link sent. Please check your inbox." }
```
Returns the same success message even if the email does not exist (anti-enumeration).
Rate-limited per email.

### 3.4 `POST /api/auth/login`  (public)
Logs in and sets `accessToken` + `refreshToken` httpOnly cookies.
```json
{ "email": "john@example.com", "password": "StrongPass1!" }
```
Response `200`:
```json
{
  "success": true,
  "message": "Login success",
  "user": { "user_id": 1, "name": "John Doe", "email": "john@example.com", "role": "jobseeker" }
}
```
Errors: `401 Invalid credentials`, `403 Email not verified...`.
Frontend: use `credentials: "include"` so the cookies are stored; then navigate to the app.
The user object gives you `role` to switch between jobseeker/recruiter UI.

### 3.5 `POST /api/auth/logout`  (protected)
Clears the session cookies and revokes the server-side refresh token.
No body needed. Response `200`:
```json
{ "success": true, "message": "Logged out" }
```
Frontend: `await fetch("/api/auth/logout", { method: "POST", credentials: "include" })` then redirect to login.

### 3.6 `GET /api/auth/me`  (protected)
Current user profile (Redis-cached 5 min).
Response `200`:
```json
{
  "success": true,
  "user": {
    "user_id": 1, "name": "John", "email": "john@example.com",
    "role": "jobseeker", "phone_number": "09123456789", "bio": null,
    "resume": "https://res.cloudinary.com/...", "profile_pic": null,
    "created_at": "2026-01-01T00:00:00.000Z"
  }
}
```
Use this to hydrate the app on load / for a "who am I" check.

### 3.7 `POST /api/auth/forgot-password`  (public)
Sends a password reset email with link `${FRONTEND_URL}/reset-password?token=...`.
```json
{ "email": "john@example.com" }
```
Response `200`:
```json
{ "success": true, "message": "If that email exists, a reset link has been sent" }
```

### 3.8 `POST /api/auth/reset-password/:token`  (public)
Set a new password using the token from the emailed link.
```json
{ "newPassword": "NewStrongPass1!" }
```
- Password must be ≥ 8 characters.
- Response `200`: `{ "success": true, "message": "Password reset successful. You can now log in." }`
Frontend: this is the submit handler on the reset-password page (`/reset-password?token=...`).
The token comes from the URL.

### 3.9 `PATCH /api/auth/change-password`  (protected)
Change password while logged in. Requires the current password.
```json
{ "currentPassword": "OldPass1!", "newPassword": "NewPass1!" }
```
- New password ≥ 8 chars and must differ from current.
- On success the server invalidates the refresh token and clears cookies —
  **the user must log in again**.
- Response `200`: `{ "success": true, "message": "Password changed successfully. Please login again." }`

### 3.10 `GET /health`  (public)
Liveness. `200`:
```json
{ "service": "auth-service", "status": "ok", "uptime": 123.4 }
```

### 3.11 `GET /health/ready`  (public)
Readiness (DB + Redis + Kafka). `200` or `503`:
```json
{
  "service": "auth-service", "status": "ready",
  "kafka": { "connected": true }, "database": "connected", "redis": "connected"
}
```

---

## 4. USER SERVICE  (`:7001`) — `/api/users/*`

All JSON bodies are parsed with a `10mb` limit. File uploads use `multipart/form-data`.

### 4.1 `GET /api/users/me`  (protected)
Full profile including skills and subscription (Redis-cached 5 min).
Response `200`:
```json
{
  "success": true,
  "user": {
    "user_id": 1, "name": "John", "email": "john@example.com", "role": "jobseeker",
    "phone_number": "09123456789", "bio": "…", "resume": "https://…", "profile_pic": "https://…",
    "created_at": "…", "subscription": null,
    "skills": [ { "skill_id": 1, "name": "typescript" } ]
  }
}
```

### 4.2 `GET /api/users/:id`  (public)
Public profile of any user by numeric id (Redis-cached 5 min). Excludes email/phone/resume.
Response `200`:
```json
{
  "success": true,
  "user": {
    "user_id": 1, "name": "John", "role": "jobseeker", "bio": "…",
    "profile_pic": "https://…", "created_at": "…",
    "skills": [ { "skill_id": 1, "name": "typescript" } ]
  }
}
```
Frontend: `/api/users/${userId}`. Use on job-detail pages to show applicant info, etc.

### 4.3 `PUT /api/users/update`  (protected)
Update name / phone_number / bio. Send only the fields you want to change.
```json
{ "name": "John Updated", "phone_number": "0987654321", "bio": "New bio" }
```
- name ≥ 2 chars; phone matches `/^\+?[0-9\s\-().]{7,20}$/`.
- Response `200`: `{ "success": true, "message": "Profile updated", "user": {...} }`

### 4.4 `PUT /api/users/bio`  (protected)
Update bio only (max 2000 chars, cannot be empty).
```json
{ "bio": "Software engineer" }
```
Response `200`: `{ "success": true, "message": "Bio updated", "user": { "user_id": 1, "bio": "..." } }`

### 4.5 `POST /api/users/profile-pic`  (protected)
Upload a profile picture (JPEG/PNG/WEBP, max 5 MB). **Multipart field name: `profile_pic`**.
```http
Content-Type: multipart/form-data
profile_pic: <image file>
```
Response `200`:
```json
{ "success": true, "message": "Profile picture updated", "profile_pic": "https://res.cloudinary.com/..." }
```
Frontend:
```ts
const fd = new FormData();
fd.append("profile_pic", file);
await fetch("/api/users/profile-pic", { method: "POST", credentials: "include", body: fd });
```
Note: re-uploading replaces the old image on Cloudinary (old one is deleted).

### 4.6 `POST /api/users/resume`  (protected, jobseeker only)
Upload resume — **PDF only**, max 5 MB. **Multipart field name: `resume`**.
```http
Content-Type: multipart/form-data
resume: <pdf file>
```
Response `200`:
```json
{ "success": true, "message": "Resume updated", "resume": "https://res.cloudinary.com/..." }
```
The resume URL is required later to apply to jobs and run AI match analysis.

### 4.7 `POST /api/users/add-skill`  (protected)
Add skills to the profile (upserts skill names, max 30 per call, each ≤ 100 chars).
```json
{ "skills": ["typescript", "react", "nodejs"] }
```
Response `200`:
```json
{ "success": true, "message": "Skills added", "skills": [ { "skill_id": 4, "name": "nodejs" }, ... ] }
```

### 4.8 `DELETE /api/users/remove-skill`  (protected)
Remove skills by their ids. **Note: this is a DELETE with a JSON body.**
```json
{ "skill_ids": [1, 4] }
```
Response `200`:
```json
{ "success": true, "message": "Skills removed", "skills": [ ...remaining... ] }
```

### 4.9 `GET /api/users/skills`  (public)
All available skills (Redis-cached 1 hour).
Response `200`: `{ "success": true, "skills": [ { "skill_id": 1, "name": "typescript" }, ... ] }`
Frontend: use to render a skill picker/autocomplete.

### 4.10 `GET /health`  (public)
`200`: `{ "status": "ok" }`

---

## 5. JOB SERVICE  (`:7002`) — `/api/jobs/*`

### 5.1 Companies

#### `POST /api/jobs/create-com`  (protected, recruiter only)
Create a company. **Multipart/form-data** (optional logo upload). Field names:
`name`, `description`, `website`, `location` (opt), `size` (opt), `industry` (opt), `logo` (opt, file).
- `website` must be a valid `http(s)` URL.
- Company name must be unique (case-insensitive).
- Logo must be JPEG/PNG/WebP ≤ 5 MB.

Response `201`:
```json
{
  "success": true, "message": "Company created successfully",
  "company": { "company_id": 1, "name": "Acme", "description": "...", "website": "https://acme.com",
    "location": null, "size": null, "industry": null, "logo": null, "created_at": "..." }
}
```
Frontend:
```ts
const fd = new FormData();
fd.append("name", name);
fd.append("description", description);
fd.append("website", website);
if (location) fd.append("location", location);
if (logoFile) fd.append("logo", logoFile);
await fetch("/api/jobs/create-com", { method: "POST", credentials: "include", body: fd });
```

#### `GET /api/jobs/`  (public)
Paginated list of all companies (Redis-cached 5 min, invalidated on writes).
Query params: `page` (default 1), `limit` (default 20, max 100), `search` (matches name/industry/location, case-insensitive), `industry` (exact match, case-insensitive), `sort` (`recent` default = newest first, `name` = A–Z, `roles` = most open roles first).
Response `200`:
```json
{
  "success": true, "count": 3, "total": 3, "page": 1, "totalPages": 1,
  "companies": [ { "company_id": 1, "name": "Acme", "description": "...", "website": "https://acme.com",
    "location": null, "size": null, "industry": null, "logo": null, "created_at": "..." } ]
}
```
Frontend: `/api/jobs/?page=1&limit=20&search=&industry=&sort=roles`. Use for a browse-companies page.
Note: filter params are included in the cache key, so different filter combinations are cached separately.

#### `GET /api/jobs/:company_id`  (public)
Single company by id (Redis-cached 5 min).
Response `200`:
```json
{ "success": true, "company": { "company_id": 1, "name": "Acme", "description": "...", "website": "...", "location": null, "size": null, "industry": null, "logo": null, "created_at": "..." } }
```

#### `GET /api/jobs/detail/:company_id`  (protected, recruiter, own company only)
Company plus all its job listings and the recruiter's info. Rich response:
```json
{
  "success": true,
  "company": {
    "company_id": 1, "name": "Acme", "description": "...", "website": "...", "logo": null,
    "location": null, "size": null, "industry": null, "logo_public_id": null, "created_at": "...",
    "recruiter": { "user_id": 1, "name": "Recruiter", "email": "r@acme.com" },
    "jobs": [ { "job_id": 1, "title": "Dev", "description": "...", "salary": 1000, "location": "Remote",
      "job_type": "Full_time", "openings": 2, "role": "Engineer", "work_location": "Remote", "is_active": true, "created_at": "..." } ]
  }
}
```
Note `job_type`/`work_location` come back in the DB enum form (`Full_time`, `On_site`) here.

#### `GET /api/jobs/my-companies`  (protected, recruiter only)
Companies owned by the logged-in recruiter.
Response `200`:
```json
{ "success": true, "count": 1, "total": 1, "companies": [ ...same company shape... ] }
```

#### `PATCH /api/jobs/:company_id`  (protected, recruiter, own company only)
Update company. **Multipart/form-data** (optional `logo` file to replace the logo).
Send only the fields to change: `name`, `description`, `website`, `location`, `size`, `industry`, `logo`.
Response `200`: `{ "success": true, "message": "Company updated successfully", "company": {...} }`

#### `DELETE /api/jobs/:id`  (protected, recruiter, own company only)
Delete a company by id. Response `200`: `{ "success": true, "message": "Company deleted successfully" }`

### 5.2 Jobs

#### `POST /api/jobs/create-job`  (protected, recruiter only)
Create a job under a company the recruiter owns. **JSON body.**
```json
{
  "title": "Senior Developer",
  "description": "Full description...",
  "location": "Yangon",
  "role": "Engineer",
  "job_type": "Full-time",
  "work_location": "Remote",
  "openings": 2,
  "salary": 1500000,
  "company_id": 1,
  "details": {
    "responsibilities": "...",
    "required_skills": "...",
    "preferred_skills": "...",
    "tech_stack": ["typescript", "node"],
    "experience_years": 3,
    "education": "...",
    "certifications": [],
    "languages": [],
    "benefits": "...",
    "visa_sponsorship": false,
    "working_hours": "...",
    "team_structure": "...",
    "reporting_line": "...",
    "career_growth": "...",
    "interview_process": "...",
    "application_instructions": "..."
  }
}
```
Valid values:
- `job_type`: `"Full-time" | "Part-time" | "Contract" | "Internship"`
- `work_location`: `"On-site" | "Remote" | "Hybrid"`
- `openings`: positive integer ≤ 999; `salary`: number ≥ 0 (optional).
- `details` is optional; any key/value object (rich JSONB details).

Response `201`:
```json
{
  "success": true, "message": "Job created successfully",
  "job": { "job_id": 1, "title": "Senior Developer", "description": "...", "salary": 1500000,
    "location": "Yangon", "job_type": "Full_time", "openings": 2, "role": "Engineer",
    "work_location": "Remote", "company_id": 1, "is_active": true, "created_at": "...", "details": {...} }
}
```
Note: the created/updated job returns `job_type` and `work_location` in DB enum form
(`Full_time`, `On_site`, ...). Map them back for display:
`Full_time` → "Full-time", `Part_time` → "Part-time", `On_site` → "On-site".

#### `GET /api/jobs/active-jobs`  (public)
List active jobs with filters + pagination (Redis-cached 60s). This is the main
browse endpoint.
Query params:
- `title` — substring match (case-insensitive)
- `location` — substring match
- `job_type` — comma-separated: `Full-time,Part-time` (or repeated params)
- `work_location` — comma-separated: `Remote,Hybrid`
- `page` (default 1), `limit` (default 20, max 100)

Response `200`:
```json
{
  "success": true, "count": 5, "total": 12, "page": 1, "totalPages": 1,
  "jobs": [
    { "job_id": 1, "title": "Senior Developer", "description": "...", "salary": 1500000,
      "location": "Yangon", "job_type": "Full_time", "role": "Engineer", "work_location": "Remote",
      "openings": 2, "created_at": "...", "details": {...},
      "company_name": "Acme", "company_logo": null, "company_id": 1 }
  ]
}
```
Frontend: `/api/jobs/active-jobs?title=dev&location=yangon&job_type=Full-time,Contract&work_location=Remote,Hybrid&page=1&limit=20`
Filter values use the human labels (`Full-time`), not the enum form.

#### `GET /api/jobs/my-jobs`  (protected, recruiter only)
Jobs of the recruiter's companies, each with `total_applications` count.
Query params: `search` (matches title/location/company name, case-insensitive), `status` (`active` or `paused`), `page` (default 1), `limit` (default 20, max 100).
Response `200`:
```json
{ "success": true, "count": 2, "total": 2, "page": 1, "totalPages": 1, "jobs": [ { "...same job shape...", "is_active": true, "company_id": 1, "company_name": "Acme", "company_logo": null, "total_applications": 5 } ] }
```

#### `GET /api/jobs/jobs/:job_id`  (public)
Job detail (Redis-cached 10 min). Also fires a `job.viewed` Kafka event for analytics (best-effort).
Response `200`:
```json
{
  "success": true, "fromCache": false,
  "job": {
    "job_id": 1, "title": "Senior Developer", "description": "...", "salary": 1500000,
    "location": "Yangon", "job_type": "Full_time", "role": "Engineer", "work_location": "Remote",
    "openings": 2, "is_active": true, "created_at": "...", "details": {...},
    "company_id": 1, "company_name": "Acme", "company_description": "...",
    "company_website": "https://acme.com", "company_logo": null, "total_applications": 5
  }
}
```

#### `PATCH /api/jobs/jobs/:job_id`  (protected, recruiter, own company only)
Update a job. Send only changed fields. **JSON body.**
`title`, `description`, `location`, `role`, `job_type`, `work_location`, `openings`,
`salary` (or `""`/`null` to clear), `is_active` (boolean), `details` (object or `null`).
Response `200`: `{ "success": true, "message": "Job updated successfully", "job": {...} }`

#### `DELETE /api/jobs/jobs/:job_id`  (protected, recruiter, own company only)
Delete a job. Response `200`: `{ "success": true, "message": "Job deleted successfully" }`

### 5.3 Applications

#### `POST /api/jobs/apply`  (protected, jobseeker only)
Apply to a job. **JSON body.**
```json
{ "jobId": 1 }
```
Requirements:
- The applicant must have a resume uploaded (`400` otherwise).
- The job must be active (`403`).
- Duplicate application → `409 You have already applied for this job`.
- The `subscribed` flag on the application is set automatically from the user's
  subscription expiry.

Response `200`:
```json
{ "success": true, "message": "Application submitted successfully", "application": { "application_id": 1, "job_id": 1, "applicant_id": 2, "applicant_email": "john@example.com", "subscribed": false, "resume": "https://...", "applied_at": "..." } }
```
Side effects (all async/event-driven, do not wait for them):
- `job.applied` event → analytics + recruiter notification email (via Kafka outbox).

#### `GET /api/jobs/my-applications`  (protected, jobseeker only)
The logged-in jobseeker's applications with job + company info (Redis-cached 5 min).
Query params: `status` (comma-separated filter, validated against `Applied|Submitted|Rejected|Hired`).
Response `200`:
```json
{
  "success": true, "count": 2,
  "applications": [
    { "application_id": 1, "status": "Applied", "applied_at": "...", "subscribed": false,
      "job_id": 1, "job_title": "Senior Developer", "job_salary": 1500000, "job_location": "Yangon",
      "job_type": "Full_time", "work_location": "Remote", "is_active": true,
      "company_id": 1, "company_name": "Acme", "company_logo": null }
  ]
}
```
Returns an empty array (`"applications": []`) when there are no applications — the
frontend treats that as a normal empty state, not an error.

#### `GET /api/jobs/applications-by-job/:job_id`  (protected, recruiter, own job only)
All applicants for one of the recruiter's jobs, including the applicant's public
profile + resume URL. Default sorted by subscribed first, then oldest first.
Query params: `search` (matches applicant name/email/bio, case-insensitive), `status` (comma-separated, validated against `Applied|Submitted|Rejected|Hired`), `sort` (`subscribed` default, `date` = newest first, `name` = A–Z), `page` (default 1), `limit` (default 20, max 100).
Response `200`:
```json
{
  "success": true, "count": 2, "total": 2, "page": 1, "totalPages": 1,
  "applications": [
    { "application_id": 1, "status": "Applied", "applied_at": "...", "subscribed": false,
      "resume": "https://res.cloudinary.com/...", "user_id": 2, "name": "John", "email": "john@example.com",
      "phone_number": "09123456789", "bio": "...", "profile_pic": null, "job_id": 1, "title": "Senior Developer" }
  ]
}
```
Returns an empty array for an owned job with no applications (a `404` is only returned
when the job does not exist or does not belong to the recruiter).

#### `PATCH /api/jobs/applications/:application_id`  (protected, recruiter, own job only)
Update an application's status. **JSON body.**
```json
{ "status": "Hired" }
```
Valid statuses: `"Submitted" | "Rejected" | "Hired"` (also accepts `"Applied"` in the DB, but the API validates only the three listed).
Rules:
- Cannot change status of an inactive job (`400`).
- `Hired` and `Rejected` are terminal — no further changes (`409`).
- Setting the same status again is a no-op success (`200`).
Side effects (async): emails the applicant a status-update email, publishes
`application.status_changed` for analytics + notification.

Response `200`:
```json
{ "success": true, "message": "Application status updated successfully", "application": { "application_id": 1, "job_id": 1, "applicant_id": 2, "applicant_email": "...", "status": "Hired", "applied_at": "...", "subscribed": false, "job_title": "Senior Developer", "company_name": "Acme" } }
```

### 5.4 AI Match Analysis

#### `POST /api/jobs/analyze-match/:jobId`  (protected, jobseeker only)
Streams a live match analysis comparing the user's resume to the job. This is a
**Server-Sent Events (SSE)** endpoint. The job service internally calls the utils
service `/api/utils/ai/analyze-match` and pipes the stream through.

Requirements: jobseeker must have a resume uploaded.

Request: no body — the job id is in the URL. Call with `fetch` + `ReadableStream`:
```ts
const res = await fetch(`/api/jobs/analyze-match/${jobId}`, {
  method: "POST",
  credentials: "include",
  headers: { Accept: "text/event-stream" },
});

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  // Parse SSE frames: split on "\n\n", each frame starts with "data: {json}"
}
```
Response headers: `Content-Type: text/event-stream`.

SSE event data shapes (each line is `data: <json>\n\n`):
```jsonc
// progress phases
{ "status": "progress", "stage": "download", "message": "Downloading resume from Cloudinary" }
{ "status": "progress", "stage": "analyze",  "message": "Analyzing match with Groq AI" }
// streaming text tokens
{ "status": "chunk", "text": "..." }
// final result
{
  "status": "complete",
  "result": {
    "matchScore": 87,
    "strengths": ["TypeScript", "Node.js"],
    "gaps": ["Kubernetes"],
    "recommendation": "yes",          // "yes" | "maybe" | "no"
    "recommendationReason": "...",
    "summary": "...",
    "fullAnalysis": "..."
  }
}
// error
{ "status": "error", "message": "..." }
```

### 5.5 Analytics (recruiter dashboard)

#### `GET /api/jobs/analytics/:job_id`  (protected, recruiter, own job only)
Daily views, applications, and status changes for a job (last 90 days) + totals.
Response `200`:
```json
{
  "success": true,
  "job": { "job_id": 1, "title": "Senior Developer", "is_active": true, "created_at": "..." },
  "analytics": {
    "total_views": 120, "total_applications": 5, "total_status_changes": 3,
    "daily": [ { "date": "2026-08-19", "views": 10, "applications": 1, "status_changes": 0 } ]
  }
}
```
Frontend: render daily rows as a chart; the totals for KPI cards.

### 5.6 Health

- `GET /health` — `200`: `{ "service": "job-service", "status": "ok", "uptime": 1.2 }`
- `GET /health/ready` — `200`/`503`: checks Kafka, DB, Redis, analytics consumer.

---

## 6. UTILS SERVICE  (`:6001`) — `/api/utils/*`

No auth middleware — these are **internal** endpoints called by the other services
and guarded by rate limits + network isolation. The frontend normally never calls
these directly (uploads go through user/job service endpoints which proxy here).

### 6.1 `POST /api/utils/upload`  (internal, rate-limited via nginx)
Upload a file to Cloudinary. **JSON body** (not multipart):
```json
{
  "buffer": "data:image/png;base64,iVBOR...",
  "public_id": "optional existing public_id to replace"
}
```
- `buffer` is a base64 data URI, max 10 MB.
- If `public_id` is provided, the old file at that id is deleted first.
- Allowed formats: jpg, jpeg, png, webp, pdf.

Response `200`:
```json
{ "success": true, "message": "Upload successful", "url": "https://res.cloudinary.com/...", "public_id": "j-track/abc123" }
```
The auth/user/job services already implement this for you (register resume,
profile-pic, resume upload, company logo). Use it directly only if you need a
generic upload widget.

### 6.2 `DELETE /api/utils/:public_id`  (internal)
Delete a file from Cloudinary by public_id. Response `200`:
```json
{ "success": true, "message": "Image deleted successfully" }
```

### 6.3 `POST /api/utils/ai/generate`  (internal — test endpoint, rate-limited 10/min)
Test Gemini connectivity. No body. Response `200`:
```json
{ "success": true, "result": "AI text...", "model": "gemini-..." }
```

### 6.4 `POST /api/utils/ai/career-guidance`  (internal — SSE, rate-limited 5/min)
Career guidance for jobseekers (Gemini). **JSON body:**
```json
{
  "skills": ["typescript", "react"],
  "experienceLevel": "mid",        // optional, "junior" | "mid" | "senior"
  "targetRole": "Full Stack Developer"  // optional
}
```
Response: SSE stream with `data:` frames:
```jsonc
{ "status": "start" }
{ "chunk": "text token..." }       // repeated
{ "status": "done", "result": { ...AI JSON... }, "meta": { "responseTime": 123, "model": "gemini-..." } }
{ "status": "error", "message": "..." }
```

### 6.5 `POST /api/utils/ai/analyze-match`  (internal — SSE, rate-limited 5/min)
Raw match analysis (Groq). The job-service `/api/jobs/analyze-match/:jobId`
calls this — prefer using that endpoint from the frontend. **JSON body:**
```json
{
  "resumeUrl": "https://res.cloudinary.com/...pdf",
  "job": {
    "title": "Senior Developer",
    "description": "...",
    "salary": 1500000,
    "location": "Yangon",
    "job_type": "Full-time",
    "work_location": "Remote",
    "role": "Engineer",
    "company_name": "Acme",
    "details": { "responsibilities": "...", "required_skills": "...", "tech_stack": ["ts"], ... }
  }
}
```
SSE events: `progress` (download/analyze stages) → `chunk` (text tokens) →
`complete` with `result.matchScore / strengths / gaps / recommendation / summary / fullAnalysis`.
See §5.4 for the exact shape (identical).

### 6.6 `POST /api/utils/ai/analyze`  (internal — SSE, rate-limited 3/min)
Full resume analysis (Groq). **Multipart/form-data, field name `resume`** (PDF only, ≤ 5 MB).
SSE events:
```jsonc
{ "status": "extracting", "message": "Reading your resume..." }
{ "status": "analyzing", "message": "Analyzing..." }
{
  "status": "done",
  "result": {
    "atsScore": { "...": "..." },
    "candidateProfile": { "...": "..." },
    "summary": "...",
    "detectedSkills": { "...": "..." },
    "missingKeywords": [],
    "suggestedRoles": [],
    "strengths": [],
    "improvements": [],
    "quickWins": []
  }
}
{ "status": "error", "message": "..." }
```

### 6.7 Health
- `GET /health` — `200`: `{ "service": "utils-service", "status": "ok", "uptime": 1.2 }`
- `GET /health/ready` — `200`/`503`: checks both Kafka consumers (mail + notification).

---

## 7. Frontend Quick-Start Cheat Sheet

### Base URL helper
```ts
const BASE: Record<string, string> = {
  auth: "http://localhost:7000",
  user: "http://localhost:7001",
  jobs: "http://localhost:7002",
  utils: "http://localhost:6001",
};
// In production use same-origin relative paths and drop BASE entirely.
```

### Auth state / guard
```ts
async function fetchMe() {
  const res = await fetch(`${BASE.auth}/api/auth/me`, { credentials: "include" });
  if (!res.ok) return null;             // 401 → not logged in
  const { user } = await res.json();
  return user;                          // { user_id, name, email, role }
}
```
Use the returned `role` to render recruiter vs. jobseeker routes.

### Endpoint index (all in one place)

| Method | Path | Auth | Role | Body / Params | Purpose |
|--------|------|------|------|---------------|---------|
| POST | `/api/auth/register` | – | – | multipart: name,email,password,phone_number,role,bio?,file? | register |
| POST | `/api/auth/verify-email` | – | – | `{ token }` | confirm email |
| POST | `/api/auth/resend-verification` | – | – | `{ email }` | resend verify email |
| POST | `/api/auth/login` | – | – | `{ email, password }` | login (sets cookies) |
| POST | `/api/auth/logout` | ✔ | – | – | logout (clears cookies) |
| GET  | `/api/auth/me` | ✔ | – | – | current user |
| POST | `/api/auth/forgot-password` | – | – | `{ email }` | send reset email |
| POST | `/api/auth/reset-password/:token` | – | – | `{ newPassword }` | set new password |
| PATCH| `/api/auth/change-password` | ✔ | – | `{ currentPassword, newPassword }` | change password |
| GET  | `/api/users/me` | ✔ | – | – | profile + skills + subscription |
| GET  | `/api/users/:id` | – | – | – | public profile |
| PUT  | `/api/users/update` | ✔ | – | `{ name?, phone_number?, bio? }` | update profile |
| PUT  | `/api/users/bio` | ✔ | – | `{ bio }` | update bio |
| POST | `/api/users/profile-pic` | ✔ | – | multipart: `profile_pic` | upload avatar |
| POST | `/api/users/resume` | ✔ | jobseeker | multipart: `resume` (pdf) | upload resume |
| POST | `/api/users/add-skill` | ✔ | – | `{ skills: string[] }` | add skills |
| DELETE | `/api/users/remove-skill` | ✔ | – | body `{ skill_ids: number[] }` | remove skills |
| GET  | `/api/users/skills` | – | – | – | all skills |
| POST | `/api/jobs/create-com` | ✔ | recruiter | multipart: name,description,website,location?,size?,industry?,logo? | create company |
| GET  | `/api/jobs/` | – | – | `?page&limit&search&industry&sort` | list companies |
| GET  | `/api/jobs/:company_id` | – | – | – | company by id |
| GET  | `/api/jobs/detail/:company_id` | ✔ | recruiter(own) | – | company + jobs + recruiter |
| GET  | `/api/jobs/my-companies` | ✔ | recruiter | – | my companies |
| PATCH| `/api/jobs/:company_id` | ✔ | recruiter(own) | multipart fields | update company |
| DELETE | `/api/jobs/:id` | ✔ | recruiter(own) | – | delete company |
| POST | `/api/jobs/create-job` | ✔ | recruiter | JSON job (see §5.2) | create job |
| GET  | `/api/jobs/active-jobs` | – | – | `?title&location&job_type&work_location&page&limit` | browse jobs |
| GET  | `/api/jobs/my-jobs` | ✔ | recruiter | `?search&status&page&limit` | my jobs + app counts |
| GET  | `/api/jobs/jobs/:job_id` | – | – | – | job detail |
| PATCH| `/api/jobs/jobs/:job_id` | ✔ | recruiter(own) | JSON partial job | update job |
| DELETE | `/api/jobs/jobs/:job_id` | ✔ | recruiter(own) | – | delete job |
| POST | `/api/jobs/apply` | ✔ | jobseeker | `{ jobId }` | apply to job |
| GET  | `/api/jobs/my-applications` | ✔ | jobseeker | `?status` | my applications |
| GET  | `/api/jobs/applications-by-job/:job_id` | ✔ | recruiter(own) | `?search&status&sort&page&limit` | applicants for a job |
| PATCH| `/api/jobs/applications/:application_id` | ✔ | recruiter(own) | `{ status }` | update app status |
| POST | `/api/jobs/analyze-match/:jobId` | ✔ | jobseeker | – (SSE) | live resume↔job match |
| GET  | `/api/jobs/analytics/:job_id` | ✔ | recruiter(own) | – | job analytics dashboard |
| POST | `/api/utils/upload` | internal | – | JSON `{ buffer, public_id? }` | Cloudinary upload |
| DELETE | `/api/utils/:public_id` | internal | – | – | Cloudinary delete |
| POST | `/api/utils/ai/generate` | internal | – | – (test) | Gemini test |
| POST | `/api/utils/ai/career-guidance` | internal | – | JSON (SSE) | career advice |
| POST | `/api/utils/ai/analyze-match` | internal | – | JSON (SSE) | raw match analysis |
| POST | `/api/utils/ai/analyze` | internal | – | multipart `resume` (SSE) | resume analysis |

---

## 8. Gotchas / Notes

1. **Enum names differ by context.** API *input* uses human labels (`"Full-time"`, `"Remote"`).
   Some *outputs* (created/updated job, company detail, my-jobs) return the DB enum form
   (`Full_time`, `On_site`). Map for display: `Full_time→Full-time`, `Part_time→Part-time`, `On_site→On-site`.
2. **Application statuses:** API accepts `Submitted | Rejected | Hired` but the DB
   default is `Applied`. A newly created application will come back with
   `status: "Applied"` even though `Applied` is not an accepted update value.
3. **My-applications empty:** returns a `200` with `applications: []`, not a `404`.
   Guarding against an empty array is enough.
4. **remove-skill uses DELETE with a body** — some proxies/clients strip DELETE bodies;
   if you use fetch it works, but keep it in mind.
5. **Cookies:** always use `credentials: "include"`. Tokens auto-refresh via the
   middleware, so a 401 means truly logged out — redirect to login.
6. **SSE:** use `text/event-stream` parsing. Read frames split by blank lines and
   strip the `data: ` prefix. Do not buffer the whole stream on the client for the
   final result — render streaming `chunk`/`text` events live if desired.
7. **Rate limits:** login/register/forgot/resend are rate-limited at the service
   (100/15min) and stricter at nginx (login 5r/m, register 3r/m, forgot 3r/m,
   apply 10r/m, general 100r/m). Handle 429 responses.
8. **Uploads are proxied:** the frontend should call `/api/users/*` or
   `/api/jobs/create-com` with multipart form data; those services upload to
   Cloudinary via utils internally. Only use `/api/utils/upload` for a raw widget.
9. **Base URLs in Docker:** if you call from a Next.js server component, use the
   Docker service names (`http://jobservice:7002`, `http://user:7001`, ...).
   From the browser, use the nginx domain or localhost ports.