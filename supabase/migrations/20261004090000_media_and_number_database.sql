-- CZARD media management and watch-number database foundation.
-- Media remains locally served by the storefront until remote assets are enabled.

CREATE TABLE IF NOT EXISTS public.media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_path text UNIQUE NOT NULL,
  storage_bucket text NOT NULL,
  storage_path text NOT NULL,
  public_url text NOT NULL DEFAULT '',
  asset_type text NOT NULL DEFAULT 'image'
    CHECK (asset_type IN ('image', 'video', 'audio', 'svg')),
  page_used text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('uploaded', 'pending')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  reference text,
  collection text,
  price numeric,
  currency text NOT NULL DEFAULT 'INR',
  description text,
  specs jsonb NOT NULL DEFAULT '{}'::jsonb,
  hero_image_path text,
  video_path text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS legacy_shop_product_id text,
  ADD COLUMN IF NOT EXISTS number_pool_id uuid,
  ADD COLUMN IF NOT EXISTS delivery_note text;

CREATE UNIQUE INDEX IF NOT EXISTS products_legacy_shop_product_id_uidx
  ON public.products (legacy_shop_product_id)
  WHERE legacy_shop_product_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.number_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_number_pool_id_fkey;
ALTER TABLE public.products
  ADD CONSTRAINT products_number_pool_id_fkey
  FOREIGN KEY (number_pool_id) REFERENCES public.number_pools(id);

UPDATE public.products AS product
SET legacy_shop_product_id = product_mapping.legacy_id
FROM (VALUES
  ('veni', '9059827024026'),
  ('vici', '9063617233050'),
  ('vidi', '9063535313050'),
  ('ecru', '9063653572762'),
  ('jura-gruen', '9063737753754'),
  ('lac-leman', '9063672447130')
) AS product_mapping(slug, legacy_id)
WHERE product.slug = product_mapping.slug
  AND product.legacy_shop_product_id IS NULL;

CREATE TABLE IF NOT EXISTS public.number_tiers (
  pool_id uuid NOT NULL REFERENCES public.number_pools(id) ON DELETE CASCADE,
  tier_id text NOT NULL,
  label text NOT NULL,
  rank integer NOT NULL DEFAULT 0,
  PRIMARY KEY (pool_id, tier_id)
);

CREATE TABLE IF NOT EXISTS public.watch_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES public.number_pools(id) ON DELETE CASCADE,
  numeral integer NOT NULL CHECK (numeral >= 0),
  display text NOT NULL,
  tier_id text,
  fee_inr integer NOT NULL DEFAULT 0 CHECK (fee_inr >= 0),
  status text NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'sold', 'withheld')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pool_id, numeral),
  UNIQUE (pool_id, display),
  FOREIGN KEY (pool_id, tier_id)
    REFERENCES public.number_tiers(pool_id, tier_id)
);

CREATE TABLE IF NOT EXISTS public.number_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_number_id uuid NOT NULL REFERENCES public.watch_numbers(id),
  session_id text NOT NULL,
  hold_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  state text NOT NULL DEFAULT 'held'
    CHECK (state IN ('held', 'released', 'expired', 'fulfilled')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  release_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS number_holds_one_active_per_number_uidx
  ON public.number_holds (watch_number_id)
  WHERE state = 'held';
CREATE INDEX IF NOT EXISTS number_holds_session_state_idx
  ON public.number_holds (session_id, state, expires_at);

CREATE TABLE IF NOT EXISTS public.number_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_number_id uuid NOT NULL UNIQUE REFERENCES public.watch_numbers(id),
  product_id uuid NOT NULL REFERENCES public.products(id),
  hold_id uuid REFERENCES public.number_holds(id),
  external_order_id text UNIQUE NOT NULL,
  state text NOT NULL DEFAULT 'paid'
    CHECK (state IN ('paid', 'cancelled', 'refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.number_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_number_id uuid NOT NULL REFERENCES public.watch_numbers(id),
  email text NOT NULL,
  state text NOT NULL DEFAULT 'waiting'
    CHECK (state IN ('waiting', 'offered', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (watch_number_id, email)
);

CREATE TABLE IF NOT EXISTS public.czard_media_admins (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.czard_media_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.number_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.number_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watch_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.number_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.number_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.number_waitlist ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_czard_media_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.czard_media_admins
    WHERE user_id = (SELECT auth.uid())
  );
$function$;

REVOKE ALL ON FUNCTION public.is_czard_media_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_czard_media_admin() TO authenticated;
REVOKE ALL ON TABLE public.czard_media_admins FROM anon, authenticated;

GRANT SELECT ON TABLE public.media_assets, public.products TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.media_assets, public.products TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.media_assets, public.products FROM anon;
REVOKE ALL ON TABLE
  public.number_pools,
  public.number_tiers,
  public.watch_numbers,
  public.number_holds,
  public.number_reservations,
  public.number_waitlist
FROM anon, authenticated;
GRANT ALL ON TABLE
  public.number_pools,
  public.number_tiers,
  public.watch_numbers,
  public.number_holds,
  public.number_reservations,
  public.number_waitlist
TO service_role;

DROP POLICY IF EXISTS anon_select_media_assets ON public.media_assets;
DROP POLICY IF EXISTS anon_insert_media_assets ON public.media_assets;
DROP POLICY IF EXISTS anon_update_media_assets ON public.media_assets;
DROP POLICY IF EXISTS anon_delete_media_assets ON public.media_assets;
DROP POLICY IF EXISTS anon_select_products ON public.products;
DROP POLICY IF EXISTS anon_insert_products ON public.products;
DROP POLICY IF EXISTS anon_update_products ON public.products;
DROP POLICY IF EXISTS anon_delete_products ON public.products;
DROP POLICY IF EXISTS media_assets_public_read ON public.media_assets;
DROP POLICY IF EXISTS media_assets_admin_insert ON public.media_assets;
DROP POLICY IF EXISTS media_assets_admin_update ON public.media_assets;
DROP POLICY IF EXISTS media_assets_admin_delete ON public.media_assets;
DROP POLICY IF EXISTS products_public_read ON public.products;
DROP POLICY IF EXISTS products_admin_write ON public.products;

CREATE POLICY media_assets_public_read ON public.media_assets
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY media_assets_admin_insert ON public.media_assets
  FOR INSERT TO authenticated WITH CHECK (public.is_czard_media_admin());
CREATE POLICY media_assets_admin_update ON public.media_assets
  FOR UPDATE TO authenticated USING (public.is_czard_media_admin())
  WITH CHECK (public.is_czard_media_admin());
CREATE POLICY media_assets_admin_delete ON public.media_assets
  FOR DELETE TO authenticated USING (public.is_czard_media_admin());

CREATE POLICY products_public_read ON public.products
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY products_admin_write ON public.products
  FOR ALL TO authenticated USING (public.is_czard_media_admin())
  WITH CHECK (public.is_czard_media_admin());

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES
  ('product-images', 'product-images', true, 157286400),
  ('product-videos', 'product-videos', true, 157286400),
  ('audio', 'audio', true, 157286400)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS "Public upload access for product-images bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public update access for product-images bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public delete access for product-images bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public read access for product-images bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public upload access for product-videos bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public update access for product-videos bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public delete access for product-videos bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public read access for product-videos bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public upload access for audio bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public update access for audio bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public delete access for audio bucket" ON storage.objects;
DROP POLICY IF EXISTS "Public read access for audio bucket" ON storage.objects;
DROP POLICY IF EXISTS czard_media_public_read ON storage.objects;
DROP POLICY IF EXISTS czard_media_admin_insert ON storage.objects;
DROP POLICY IF EXISTS czard_media_admin_update ON storage.objects;
DROP POLICY IF EXISTS czard_media_admin_delete ON storage.objects;

CREATE POLICY czard_media_public_read ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id IN ('product-images', 'product-videos', 'audio'));
CREATE POLICY czard_media_admin_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id IN ('product-images', 'product-videos', 'audio') AND public.is_czard_media_admin());
CREATE POLICY czard_media_admin_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id IN ('product-images', 'product-videos', 'audio') AND public.is_czard_media_admin())
  WITH CHECK (bucket_id IN ('product-images', 'product-videos', 'audio') AND public.is_czard_media_admin());
CREATE POLICY czard_media_admin_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id IN ('product-images', 'product-videos', 'audio') AND public.is_czard_media_admin());

CREATE INDEX IF NOT EXISTS media_assets_status_idx ON public.media_assets (status);
CREATE INDEX IF NOT EXISTS watch_numbers_pool_status_idx ON public.watch_numbers (pool_id, status, numeral);
CREATE INDEX IF NOT EXISTS number_holds_expiry_idx ON public.number_holds (expires_at) WHERE state = 'held';

CREATE OR REPLACE FUNCTION public.czard_serial_chart(p_product text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  product_row record;
  serial_rows jsonb;
  tier_rows jsonb;
BEGIN
  SELECT p.id, p.name, p.price, p.delivery_note, p.number_pool_id, pool.name AS pool_name
  INTO product_row
  FROM public.products AS p
  JOIN public.number_pools AS pool ON pool.id = p.number_pool_id
  WHERE p.legacy_shop_product_id = p_product OR p.id::text = p_product
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('id', tier.tier_id, 'label', tier.label, 'rank', tier.rank)
    ORDER BY tier.rank, tier.tier_id
  ), '[]'::jsonb)
  INTO tier_rows
  FROM public.number_tiers AS tier
  WHERE tier.pool_id = product_row.number_pool_id;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'n', number.numeral,
      'display', number.display,
      'tierId', number.tier_id,
      'status', CASE
        WHEN number.status = 'sold' THEN 'taken'
        WHEN number.status = 'withheld' THEN 'withheld'
        WHEN hold.id IS NOT NULL THEN 'reserved'
        ELSE 'available'
      END,
      'freeInSeconds', CASE
        WHEN hold.id IS NULL THEN NULL
        ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (hold.expires_at - now())))::integer)
      END,
      'feeInr', number.fee_inr,
      'premiumInr', number.fee_inr,
      'priceInr', COALESCE(product_row.price, 0) + number.fee_inr,
      'prices', jsonb_build_object('INR', jsonb_build_object(
        'base', COALESCE(product_row.price, 0),
        'fee', number.fee_inr,
        'total', COALESCE(product_row.price, 0) + number.fee_inr
      ))
    ) ORDER BY number.numeral
  ), '[]'::jsonb)
  INTO serial_rows
  FROM public.watch_numbers AS number
  LEFT JOIN LATERAL (
    SELECT active_hold.id, active_hold.expires_at
    FROM public.number_holds AS active_hold
    WHERE active_hold.watch_number_id = number.id
      AND active_hold.state = 'held'
      AND active_hold.expires_at > now()
    ORDER BY active_hold.expires_at DESC
    LIMIT 1
  ) AS hold ON true
  WHERE number.pool_id = product_row.number_pool_id;

  RETURN jsonb_build_object(
    'product', jsonb_build_object('name', product_row.name, 'deliveryNote', product_row.delivery_note),
    'chapter', jsonb_build_object('name', product_row.pool_name),
    'basePriceInr', COALESCE(product_row.price, 0),
    'tiers', tier_rows,
    'serials', serial_rows,
    'money', jsonb_build_object('home', 'INR', 'country', 'IN', 'resolved', true, 'currencies', jsonb_build_array(
      jsonb_build_object('code', 'INR', 'symbol', '₹', 'locale', 'en-IN', 'rate', 1, 'minorUnits', 2)
    ))
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.czard_hold_number(
  p_product text,
  p_numeral integer,
  p_session_id text,
  p_hold_token text DEFAULT NULL,
  p_hold_seconds integer DEFAULT 720
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  product_row record;
  number_row public.watch_numbers%ROWTYPE;
  hold_row public.number_holds%ROWTYPE;
  hold_duration integer := LEAST(GREATEST(COALESCE(p_hold_seconds, 720), 60), 720);
  active_count integer;
  hold_expiry timestamptz;
BEGIN
  IF p_session_id IS NULL OR length(p_session_id) < 8 OR length(p_session_id) > 128 THEN
    RETURN jsonb_build_object('ok', false, 'message', 'A valid picker session is required.');
  END IF;

  SELECT p.id, p.number_pool_id, COALESCE(p.price, 0) AS base_price
  INTO product_row
  FROM public.products AS p
  WHERE p.legacy_shop_product_id = p_product OR p.id::text = p_product
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'message', 'This product is not mapped to a number pool.');
  END IF;

  IF product_row.number_pool_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'This product is not mapped to a number pool.');
  END IF;

  SELECT number.* INTO number_row
  FROM public.watch_numbers AS number
  WHERE number.pool_id = product_row.number_pool_id AND number.numeral = p_numeral
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'message', 'That number is not in this product''s register.');
  END IF;

  UPDATE public.number_holds
  SET state = 'expired', released_at = now(), release_reason = 'expired'
  WHERE watch_number_id = number_row.id AND state = 'held' AND expires_at <= now();

  SELECT active_hold.* INTO hold_row
  FROM public.number_holds AS active_hold
  WHERE active_hold.watch_number_id = number_row.id
    AND active_hold.state = 'held'
    AND active_hold.expires_at > now()
  FOR UPDATE;

  IF FOUND THEN
    IF hold_row.session_id = p_session_id AND hold_row.hold_token::text = p_hold_token THEN
      hold_expiry := now() + make_interval(secs => hold_duration);
      UPDATE public.number_holds SET expires_at = hold_expiry WHERE id = hold_row.id;
      RETURN jsonb_build_object('ok', true, 'hold', jsonb_build_object(
        'token', hold_row.hold_token,
        'serial', number_row.numeral,
        'display', number_row.display,
        'expiresAt', hold_expiry,
        'holdSeconds', hold_duration,
        'feeInr', number_row.fee_inr,
        'tierId', number_row.tier_id,
        'tierLabel', (SELECT tier.label FROM public.number_tiers AS tier WHERE tier.pool_id = number_row.pool_id AND tier.tier_id = number_row.tier_id)
      ), 'lineItemProperties', jsonb_build_object(
        'Serial', number_row.display,
        '_czard_hold', hold_row.hold_token,
        '_czard_tier', COALESCE(number_row.tier_id, '')
      ));
    END IF;

    RETURN jsonb_build_object('ok', false, 'status', 'reserved', 'message', number_row.display || ' is in someone else''s checkout.');
  END IF;

  IF number_row.status <> 'available' THEN
    RETURN jsonb_build_object('ok', false, 'status', number_row.status, 'message', number_row.display || ' is no longer available.');
  END IF;

  SELECT count(*) INTO active_count
  FROM public.number_holds AS active_hold
  WHERE active_hold.session_id = p_session_id
    AND active_hold.state = 'held'
    AND active_hold.expires_at > now();

  IF active_count >= 4 THEN
    RETURN jsonb_build_object('ok', false, 'message', 'This session already has the maximum number of active holds.');
  END IF;

  hold_expiry := now() + make_interval(secs => hold_duration);
  INSERT INTO public.number_holds (watch_number_id, session_id, expires_at)
  VALUES (number_row.id, p_session_id, hold_expiry)
  RETURNING * INTO hold_row;

  RETURN jsonb_build_object('ok', true, 'hold', jsonb_build_object(
    'token', hold_row.hold_token,
    'serial', number_row.numeral,
    'display', number_row.display,
    'expiresAt', hold_expiry,
    'holdSeconds', hold_duration,
    'feeInr', number_row.fee_inr,
    'tierId', number_row.tier_id,
    'tierLabel', (SELECT tier.label FROM public.number_tiers AS tier WHERE tier.pool_id = number_row.pool_id AND tier.tier_id = number_row.tier_id)
  ), 'lineItemProperties', jsonb_build_object(
    'Serial', number_row.display,
    '_czard_hold', hold_row.hold_token,
    '_czard_tier', COALESCE(number_row.tier_id, '')
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.czard_release_number(
  p_hold_token text,
  p_session_id text,
  p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  affected integer;
BEGIN
  UPDATE public.number_holds
  SET state = 'released', released_at = now(), release_reason = left(COALESCE(p_reason, 'released'), 64)
  WHERE hold_token::text = p_hold_token
    AND session_id = p_session_id
    AND state = 'held';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$function$;

REVOKE ALL ON FUNCTION public.czard_serial_chart(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.czard_hold_number(text, integer, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.czard_release_number(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.czard_serial_chart(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.czard_hold_number(text, integer, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.czard_release_number(text, text, text) TO service_role;