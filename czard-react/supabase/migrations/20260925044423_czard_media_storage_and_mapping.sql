/*
# CZARD Media Storage Setup

## Purpose
Sets up Supabase Storage buckets for product images, videos, and audio assets,
plus a database table to map original Shopify CDN paths to their Supabase
Storage locations. This replaces the broken HTTrack-mangled media references
with working Supabase Storage URLs.

## New Storage Buckets
1. `product-images` — public bucket for all watch photos, collection images,
   page imagery, blog images, favicons, and loader SVGs.
2. `product-videos` — public bucket for hero/background MP4 videos.
3. `audio` — public bucket for ambient sound MP3 files.

## New Tables
1. `media_assets` — maps original asset paths to Supabase Storage URLs.
   - `id` (uuid, primary key)
   - `original_path` (text, unique) — the original file path as referenced in
     the HTML (e.g. "cdn/shop/files/logo.png" or "cdn/shop/t/9/assets/loader-dial-base75cc.svg")
   - `storage_bucket` (text) — which Supabase Storage bucket holds the file
   - `storage_path` (text) — the path within the bucket
   - `public_url` (text) — the full public URL to the asset
   - `asset_type` (text) — 'image' | 'video' | 'audio' | 'svg'
   - `page_used` (text) — which pages reference this asset (comma-separated)
   - `status` (text) — 'uploaded' | 'pending' — whether the file has been uploaded
   - `created_at` (timestamptz)
   - `updated_at` (timestamptz)

2. `products` — structured product data for the CZARD catalog.
   - `id` (uuid, primary key)
   - `slug` (text, unique) — URL slug (e.g. "veni", "vidi", "vici")
   - `name` (text) — product name
   - `reference` (text) — model reference code
   - `collection` (text) — which collection (compass, geneve)
   - `price` (numeric) — product price
   - `currency` (text, default 'INR')
   - `description` (text)
   - `specs` (jsonb) — specification key/value pairs
   - `hero_image_path` (text) — original path to hero image
   - `video_path` (text) — original path to product video
   - `created_at` (timestamptz)

## Security
- All buckets are PUBLIC (anyone can read files).
- Public read access is enabled for catalog/media.
- Writes must be restricted to allow-listed authenticated media admins by the
  follow-up security migration; no anonymous uploads or table writes.

## Important Notes
1. After this migration, you must upload the actual media files to the
   Supabase Storage buckets via the Supabase Dashboard or API.
2. The `media_assets` table serves as the lookup: the Vite server checks
   this table (or a static JSON export) to find the correct Supabase URL
   for each broken media reference.
3. The `status` column tracks whether each file has been uploaded yet.
   Only rows with status='uploaded' should be used as replacements.
*/
-- Create storage buckets
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-images', 'product-images', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('product-videos', 'product-videos', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('audio', 'audio', true)
ON CONFLICT (id) DO NOTHING;

-- Buckets are public for reads. The later admin migration owns write access.
CREATE POLICY "Public read access for product-images bucket"
ON storage.objects FOR SELECT TO anon, authenticated
USING (bucket_id = 'product-images');

CREATE POLICY "Public read access for product-videos bucket"
ON storage.objects FOR SELECT TO anon, authenticated
USING (bucket_id = 'product-videos');

CREATE POLICY "Public read access for audio bucket"
ON storage.objects FOR SELECT TO anon, authenticated
USING (bucket_id = 'audio');

-- Create media_assets table
CREATE TABLE IF NOT EXISTS media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_path text UNIQUE NOT NULL,
  storage_bucket text NOT NULL,
  storage_path text NOT NULL,
  public_url text NOT NULL,
  asset_type text NOT NULL DEFAULT 'image' CHECK (asset_type IN ('image', 'video', 'audio', 'svg')),
  page_used text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('uploaded', 'pending')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_media_assets" ON media_assets;
CREATE POLICY "anon_select_media_assets" ON media_assets FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_media_assets" ON media_assets;
DROP POLICY IF EXISTS "anon_update_media_assets" ON media_assets;
DROP POLICY IF EXISTS "anon_delete_media_assets" ON media_assets;

-- Create products table
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  reference text,
  collection text,
  price numeric,
  currency text NOT NULL DEFAULT 'INR',
  description text,
  specs jsonb DEFAULT '{}'::jsonb,
  hero_image_path text,
  video_path text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_products" ON products;
CREATE POLICY "anon_select_products" ON products FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_products" ON products;
DROP POLICY IF EXISTS "anon_update_products" ON products;
DROP POLICY IF EXISTS "anon_delete_products" ON products;

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_media_assets_original_path ON media_assets (original_path);
CREATE INDEX IF NOT EXISTS idx_media_assets_status ON media_assets (status);
CREATE INDEX IF NOT EXISTS idx_products_slug ON products (slug);
