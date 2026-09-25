# Pranaam backend

Express 5, CommonJS JavaScript and PostgreSQL. Authentication follows the design's roles and modular boundaries while preserving the existing runtime and pg driver.

## Setup

1. Run `npm install`.
2. Copy missing settings from `.env.example` into your existing `.env`. Keep your database credentials.
3. Set two different random JWT secrets (at least 32 bytes each). Generate each with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
4. Run `npm run migrate` against the intended PostgreSQL database. The email migration requires an existing authentication schema (users, roles, user_roles, auth_sessions). It enforces non-null, non-blank, case-insensitive unique email addresses and makes a legacy username column optional. Resolve missing or duplicate emails before migrating; failures roll back atomically. The original baseline migration is not present in this checkout. vendor_id is nullable pending the vendor module.
5. Create an account using environment variables and `npm run create-user`. Required: AUTH_USER_EMAIL, AUTH_USER_PASSWORD (12+ characters, at most 72 UTF-8 bytes), AUTH_USER_ROLE. Optional: AUTH_USER_FIRST_NAME, AUTH_USER_LAST_NAME, AUTH_USER_VENDOR_ID. Existing email addresses are rejected. Passwords are bcrypt-hashed with cost 12; no default accounts are created.
6. Run `npm start`. Run `npm test` for API tests.

PowerShell account creation example (choose your own password):

```powershell
$env:AUTH_USER_EMAIL = 'admin@example.com'
$env:AUTH_USER_PASSWORD = '<your strong password>'
$env:AUTH_USER_ROLE = 'PLATFORM_ADMIN'
npm.cmd run create-user
Remove-Item Env:AUTH_USER_PASSWORD
```

## API

| Method | Endpoint | Input |
| --- | --- | --- |
| POST | /login | JSON email, password, role |
| POST | /refresh | JSON refreshToken, or refreshToken cookie |
| POST | /logout | Refresh token body/cookie or access token cookie/Bearer header |
| GET | /me | Access token cookie or Authorization: Bearer token |

All four endpoints also exist under `/api/v1/auth`, as specified by the design. Send credentials in the JSON body, never URL query parameters.

Login example:

```json
{ "email": "admin@example.com", "password": "<your password>", "role": "PLATFORM_ADMIN" }
```

Login and refresh return the same shape:

```json
{
  "user": {
    "id": "uuid",
    "name": "Admin User",
    "firstName": "Admin",
    "lastName": "User",
    "email": "admin@example.com",
    "mobile": null,
    "role": "PLATFORM_ADMIN",
    "roles": ["PLATFORM_ADMIN"],
    "vendorId": null,
    "status": "ACTIVE"
  },
  "accessToken": "<JWT>",
  "refreshToken": "<JWT>",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "refreshExpiresIn": 604800
}
```

The access token is the JWT; no duplicate jwt field is needed. Expiry values are remaining seconds and can be slightly lower than configured TTLs. Both tokens are also set as HttpOnly cookies. Password hashes are never returned.

Supported roles: VENDOR, CUSTOMER, GRO, GRL, GRM, AIRPORT_ADMIN, OPERATIONS, FINANCE, PLATFORM_ADMIN. The requested role must already belong to the account. The session retains that selected role through refresh.

Refresh rotates both tokens and retrieves current user data. Session lifetime is absolute (seven days by default); refreshing does not extend it. Reusing an old refresh token revokes the entire session. Clients must serialize refresh requests and retain the latest pair. Logout revokes supplied valid sessions immediately and clears cookies; other devices remain logged in.

Browser requests should use `credentials: 'include'`. Set CORS_ORIGINS to exact frontend origins, including the API origin if making same-origin browser requests. Cookies use SameSite=Lax by default and Secure in production. Cross-site deployments need COOKIE_SAME_SITE=none and COOKIE_SECURE=true with HTTPS. Origins are checked on requests to prevent cookie-based CSRF. Token fields are returned in JSON as requested, so HttpOnly does not protect copies explicitly read or stored by frontend JavaScript; avoid persistent browser storage.

## Structure and authorization

- src/config: database and validated token/cookie settings
- src/controllers: HTTP inputs/outputs and cookies
- src/services: credentials, JWTs, session rotation/revocation
- src/repositories: parameterized PostgreSQL queries
- src/middleware: authentication, role enforcement, validation
- src/routes: routes and authentication rate limiting
- migrations / scripts: schema migration and account provisioning
- tests: HTTP authentication/security tests using an injected in-memory repository

Protect future routes with `authenticate(service)`, then `authorize('OPERATIONS', 'PLATFORM_ADMIN')` from src/middleware/auth.middleware.js. Authorization uses the selected role, not a role supplied in subsequent requests. Use req.user.vendorId for future tenant-scoped queries. The pre-existing /api/data demo remains unchanged.

Errors use code, message, details and correlationId (rate limits use code/message). Invalid input: 400; invalid credentials/session: 401; role/origin denied: 403; throttling: 429. Auth responses use Cache-Control: no-store.

The default rate limiter is process-local; a multi-instance deployment needs a shared store and an explicit trusted-proxy configuration appropriate to its infrastructure. PostgreSQL sessions persist across restarts. Expired sessions can be periodically removed by an operational retention job. Tests exercise HTTP behavior but do not substitute for migration and repository checks against PostgreSQL.


Login identifies accounts by email (trimmed, case-insensitive). Refresh and logout authenticate with tokens/cookies and do not accept an email alone as proof of identity. User responses contain email and no username.
