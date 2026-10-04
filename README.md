# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.

## Supabase Integration

The media uploader from the downloaded project is integrated at `/admin/media`. It requires Supabase Auth and an entry in `czard_media_admins`; anonymous users can read public media metadata but cannot upload, update, or delete assets. The migration replaces the downloaded project's unsafe public-write policies. Do not copy its `.env` file into this repository.

1. Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_CZARD_SERIAL_API_BASE` for the Supabase project.
2. Link the Supabase CLI to that project and run `supabase db push` from this folder. It applies all migrations in timestamp order, including the three imported migrations, the secure media/number schema, and the local-path seed. No migration truncates `media_assets`. These migrations have **not** been applied to the remote database.
3. Create a Supabase Auth user for the media administrator, then insert that user's UUID into `public.czard_media_admins` using the Supabase SQL editor.
4. Deploy the serial Edge Function with `supabase functions deploy serials`.

The downloaded 365-path manifest is retained, with its one image absent from this local checkout removed. [`20261004090001_seed_local_media_asset_paths.sql`](supabase/migrations/20261004090001_seed_local_media_asset_paths.sql) adds upload mappings for every supported media file under `media-manager/cdn/shop` (including the 360 frames). Storefront HTML keeps using its existing local image paths; these DB rows do not rewrite those URLs.

## Watch Number Selection Backend

The picker, database schema, chart/hold/release SQL functions, and Supabase Edge Function source are present. Number selection is **not live yet**: the migration and Edge Function have not been deployed, and the downloaded project contains no authoritative watch-number inventory to seed. The Edge Function URL is supplied by `VITE_CZARD_SERIAL_API_BASE`; without it, the picker falls back to its script origin and requests the local Vite host.

### Database Requirements

- Map each watch product to a number pool or chapter. Preserve current IDs as migration references where useful: Veni `9059827024026`; Vici `9063617233050`; Vidi `9063535313050`; Ecru `9063653572762`; Jura Gruen `9063737753754`; Lac Leman `9063672447130`.
- Seed the number pools/chapters, tiers, and watch numbers from the authoritative inventory. Each number needs its pool, numeral/display label, tier, reservation fee, and state (`available`, `sold`, or `withheld`). The migration enforces uniqueness within a pool; active holds are represented separately.
- Holds store the number, session ID, private token, state, and expiry. The database hold function uses a row lock and a 12-minute expiry so two shoppers cannot reserve the same number at once.
- Link orders to reservations. The schema is present, but a paid-order webhook still needs to mark numbers sold and handle cancellation/refund transitions.
- Add a waitlist table if the queue feature is enabled. Custom-number checks must use the same number register.

### Required API

- `GET /api/serials/chart?product=...`: return product and chapter details, tiers, and number rows. The picker reads row fields `n`, `display`, `tierId`, `status`, `feeInr`, and `freeInSeconds`.
- `GET /api/serials/custom?product=...&serial=...`: check a requested numeral and return whether it is available, its quote, and alternatives when unavailable.
- `POST /api/serials/hold`: atomically reserve a number and return the hold token, serial, expiry, fee, and tier details.
- `POST /api/serials/release`: release a hold by token.
- `POST /api/serials/queue`: add a shopper to the waitlist for a number.
- `POST /api/serials/revalidate`: validate all held numbers in the cart before checkout.

The picker implementation is in [`public/portal.czard.com/czard-serial-picker.js`](public/portal.czard.com/czard-serial-picker.js); the Edge Function is in [`supabase/functions/serials/index.ts`](supabase/functions/serials/index.ts). Custom-number lookup only recognizes numbers in the seeded register; automatic creation/fulfillment of custom numbers is not implemented. Add rate limiting and order-webhook handling before production use.

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
