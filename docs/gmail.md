# Gmail connection

Code: `src/google/` (OAuth client, token encryption, HTTP routes), `src/app/postgres/gmail.ts`, `api/google/`. Tables: `google_accounts`, `oauth_states`.

Users can opt in to giving the agent read-only access to their Gmail, so it can follow their job applications by email (ANI-104). It is optional: everything else works without it.

## Flow

1. `/connect_gmail` explains what is read (read-only Gmail, nothing sent or changed), what is stored (Gmail address, an encrypted access key, details from application emails) and how to stop (`/disconnect_gmail`), with a **🔗 Connect Gmail** button.
2. The button opens `GET /api/google/connect?state=…`, which redirects to Google sign-in while the state is pending.
3. Google redirects to `GET /api/google/callback?state=…&code=…`. The callback consumes the state, exchanges the code (with the PKCE verifier stored with the state), reads the Gmail address from the Gmail profile endpoint and stores the grant. It messages the result to the user's Telegram chat and shows a page saying to go back to Telegram.

The only scope ever requested is `https://www.googleapis.com/auth/gmail.readonly` (`GMAIL_READONLY_SCOPE`), without `include_granted_scopes`. `prompt=consent` and `access_type=offline` make Google issue a refresh token on every consent. A grant without the Gmail scope (the user unticked it) is revoked and the user is asked to try again.

### State

- 32 random bytes, sent only in the link; `oauth_states` stores its SHA-256, so a database read can't be used to finish someone's sign-in.
- Bound to the user who sent `/connect_gmail`: the grant is stored for that user and the confirmation goes to their chat.
- Single use (deleted when the callback runs, whatever the outcome), valid for 10 minutes, and a new `/connect_gmail` invalidates the user's earlier links.

## Storage

`google_accounts` (one per user): Gmail address, granted scopes, `refresh_token_encrypted`, `status` (`active` | `needs_reconnect`), `connected_at`, `last_sync_at` (set by the Gmail sync). Access tokens are never stored; they are refreshed when needed (`gmail.accessToken`).

Refresh tokens are encrypted with AES-256-GCM (`TokenCipher`) under `GOOGLE_TOKEN_ENCRYPTION_KEY`, with the user id as authenticated data, so a ciphertext only decrypts for the row it was written for. Format: `v1.<iv>.<tag>.<ciphertext>` (base64url).

## Expired or revoked grants

When Google rejects the refresh token (`invalid_grant`: revoked by the user, password change, or the 7-day expiry of apps in testing mode), or the stored token can't be decrypted, `gmail.accessToken` marks the account `needs_reconnect`, drops the token and returns `needs_reconnect`. `/connect_gmail` checks the grant with Google and, for a lost grant, sends `gmailConnectView(t, url, email)`: a reconnect prompt with **🔗 Reconnect Gmail**. Consumers such as the Gmail sync should send the same view instead of failing silently.

Reconnecting the same Google account replaces the stored token without revoking the old one (revoking any token revokes the whole grant); connecting a different account revokes the previous account's grant.

## Disconnect

`/disconnect_gmail` asks for confirmation (**🔌 Disconnect and delete**, `gm:disconnect`). It then revokes the refresh token at Google, deletes the `google_accounts` row and any pending links, and reports whether Google confirmed the revocation (if not, it points to myaccount.google.com/permissions). Data derived from email must reference `google_accounts` with `on delete cascade` or be deleted in `PgGmailService.disconnect`. Everything is also deleted with the user.

## Setup

1. Google Cloud Console → enable the Gmail API → OAuth consent screen (external) with the `gmail.readonly` scope → OAuth client (Web application) with redirect URI `https://<production host>/api/google/callback`.
2. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`) in Vercel. The base URL is `APP_BASE_URL`, or `https://$VERCEL_PROJECT_PRODUCTION_URL`.

Without all of them, `/connect_gmail` replies that Gmail isn't available. Changing the encryption key makes every stored token undecryptable, so all users are asked to reconnect.

## Constraints

`gmail.readonly` is a Google **restricted scope**:
- In testing mode the app is limited to 100 allow-listed test users, and refresh tokens expire after 7 days (users get the reconnect prompt).
- Publishing for external users requires Google verification and a third-party security assessment (CASA), renewed yearly.

That is fine for personal and beta use; decide before opening to more users. The lower-privilege alternative to evaluate is a per-user inbound address that the user forwards to with a Gmail filter (e.g. mail from greenhouse.io, lever.co, ashbyhq.com). It needs no Google scope and no verification, at the cost of a manual setup step and only seeing forwarded mail.

A later Google Calendar scope for interview scheduling should be requested as incremental consent (`include_granted_scopes`) in its own flow, not added here. LinkedIn sign-in (ANI-101) is not implemented yet; when it is, it can share `oauth_states` by adding a provider column.
