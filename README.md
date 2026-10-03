# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.

## Watch Number Selection Backend

The serial-number picker UI is present, but its database-backed number chart and reservation API are not implemented in this project yet. The picker requests `/api/serials/chart?product=...`; in local development it resolves the portal origin from the picker script, so it currently requests the local Vite host, where that API does not exist. The grid cannot load until a backend is deployed and the picker is configured to use it, or Vite proxies the API during development.

### Database Requirements

- Map each watch product to a number pool or chapter. Preserve current IDs as migration references where useful: Veni `9059827024026`; Vici `9063617233050`; Vidi `9063535313050`; Ecru `9063653572762`; Jura Gruen `9063737753754`; Lac Leman `9063672447130`.
- Store number pools/chapters, tiers, and watch numbers. Each number needs its pool, numeral/display label, tier, reservation fee, and state (`available`, `held`, `sold`, or `withheld`). Enforce uniqueness of a numeral within its pool.
- Store holds with the number, session ID, private hold token, state, and expiry. Holds last 12 minutes. Creating or refreshing a hold must be atomic so concurrent shoppers cannot hold the same number.
- Link holds to orders/reservations. A paid order permanently marks the number sold; expiry, release, cancellation, and refund transitions must be handled.
- Add a waitlist table if the queue feature is enabled. Custom-number checks must use the same number register.

### Required API

- `GET /api/serials/chart?product=...`: return product and chapter details, tiers, and number rows. The picker reads row fields `n`, `display`, `tierId`, `status`, `feeInr`, and `freeInSeconds`.
- `GET /api/serials/custom?product=...&serial=...`: check a requested numeral and return whether it is available, its quote, and alternatives when unavailable.
- `POST /api/serials/hold`: atomically reserve a number and return the hold token, serial, expiry, fee, and tier details.
- `POST /api/serials/release`: release a hold by token.
- `POST /api/serials/queue`: add a shopper to the waitlist for a number.
- `POST /api/serials/revalidate`: validate all held numbers in the cart before checkout.

The picker implementation is in [`public/portal.czard.com/czard-serial-picker.js`](public/portal.czard.com/czard-serial-picker.js). Its API origin is configurable through the script's `data-portal` attribute. The backend must also validate input, rate-limit public endpoints, protect hold tokens, and perform inventory changes transactionally; database tables alone are not sufficient.

## Profile Authentication Backend

Profile sign-in is currently a local demonstration flow: entering a valid-looking email stores account data in this browser's `localStorage`. It does not verify the customer's identity, use a server-side user database, or create a secure authenticated session. Do not treat this as production authentication. Shopify authentication is not required for the planned first-party profile flow.

### Pending Implementation

- Choose and implement the first-party sign-in method. If using email/password, store only a strong password hash, never a plaintext password; normalize and uniquely constrain email addresses.
- Add email verification and single-use, expiring password-reset tokens. Store only hashes of verification/reset tokens and invalidate them after use.
- Create server-managed sessions using secure, HTTP-only, SameSite cookies, with expiry, rotation, logout/revocation, and CSRF protection where applicable.
- Persist profile fields, addresses, and communication preferences against an internal user ID. Enforce ownership on every read and write so a customer can access only their own records.
- Require authentication and authorization on profile, address, order, and preference APIs. Validate inputs, rate-limit sign-in/reset endpoints, and avoid revealing whether an email is registered.
- Migrate existing browser-local account data only through an explicit, verified account-linking flow; localStorage values alone do not prove identity.

The frontend must call the deployed first-party authentication/profile API instead of treating localStorage as the source of truth. Until that backend is implemented, profile data and sign-in state are limited to the current browser and can be cleared or changed by that browser's user.
