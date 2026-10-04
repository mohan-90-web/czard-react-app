import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-czard-session',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders })
}

function currencyPrices(base: number, fee: number) {
  return { INR: { base, fee, total: base + fee } }
}

async function resolveProduct(admin: ReturnType<typeof createClient>, key: string) {
  const byLegacyId = await admin
    .from('products')
    .select('id, slug, name, price, currency, number_pool_id, delivery_note')
    .eq('legacy_shop_product_id', key)
    .maybeSingle()
  if (byLegacyId.error || byLegacyId.data) return byLegacyId

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    return byLegacyId
  }

  return admin
    .from('products')
    .select('id, slug, name, price, currency, number_pool_id, delivery_note')
    .eq('id', key)
    .maybeSingle()
}

async function handleRequest(request: Request) {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const projectUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!projectUrl || !serviceRoleKey) return reply({ message: 'Serial service is not configured.' }, 503)

  const admin = createClient(projectUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const url = new URL(request.url)
  const route = url.pathname.split('/api/serials/')[1]?.split('/')[0]
  const sessionId = request.headers.get('x-czard-session') || ''

  if (route === 'chart' && request.method === 'GET') {
    const product = url.searchParams.get('product') || ''
    if (!product) return reply({ message: 'A product is required.' }, 400)
    const { data, error } = await admin.rpc('czard_serial_chart', { p_product: product })
    if (error) return reply({ message: 'Could not load the number chart.' }, 500)
    if (!data) return reply({ message: 'This product is not mapped to a number pool.' }, 404)
    return reply(data)
  }

  if (route === 'hold' && request.method === 'POST') {
    if (!sessionId) return reply({ message: 'A picker session is required.' }, 400)
    const body = await request.json().catch(() => null)
    if (!body?.product || !Number.isInteger(Number(body.serial))) return reply({ message: 'Product and number are required.' }, 400)
    const { data, error } = await admin.rpc('czard_hold_number', {
      p_product: String(body.product),
      p_numeral: Number(body.serial),
      p_session_id: sessionId,
      p_hold_token: body.holdToken ? String(body.holdToken) : null,
      p_hold_seconds: 720,
    })
    if (error) return reply({ message: 'Could not reserve this number.' }, 500)
    return reply(data, data?.ok ? 200 : 409)
  }

  if (route === 'release' && request.method === 'POST') {
    if (!sessionId) return reply({ message: 'A picker session is required.' }, 400)
    const body = await request.json().catch(() => null)
    if (!body?.holdToken) return reply({ message: 'A hold token is required.' }, 400)
    const { data, error } = await admin.rpc('czard_release_number', {
      p_hold_token: String(body.holdToken),
      p_session_id: sessionId,
      p_reason: body.reason ? String(body.reason).slice(0, 64) : null,
    })
    if (error) return reply({ message: 'Could not release the number.' }, 500)
    return reply({ ok: true, released: data === true })
  }

  if (route === 'custom' && request.method === 'GET') {
    const productKey = url.searchParams.get('product') || ''
    const raw = url.searchParams.get('serial') || ''
    const numeral = Number(raw)
    if (!productKey || !/^\d{4,8}$/.test(raw) || !Number.isSafeInteger(numeral)) {
      return reply({ ok: false, message: 'Enter a number with 4 to 8 digits.' }, 400)
    }
    const { data: product, error: productError } = await resolveProduct(admin, productKey)
    if (productError || !product?.number_pool_id) return reply({ ok: false, message: 'This product is not mapped to a number pool.' }, 404)
    const { data: number, error } = await admin
      .from('watch_numbers')
      .select('id, numeral, display, fee_inr, status, tier_id')
      .eq('pool_id', product.number_pool_id)
      .eq('numeral', numeral)
      .maybeSingle()
    if (error) return reply({ ok: false, message: 'Could not check the number register.' }, 500)
    if (!number) return reply({ ok: false, message: 'Custom-number registration is not configured for this number.' })
    const { data: activeHold } = await admin
      .from('number_holds')
      .select('id')
      .eq('watch_number_id', number.id)
      .eq('state', 'held')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    const available = number.status === 'available' && !activeHold
    const base = Number(product.price) || 0
    const fee = Number(number.fee_inr) || 0
    return reply({
      ok: true,
      available,
      status: number.status === 'sold' ? 'taken' : activeHold ? 'reserved' : number.status,
      numeral: number.numeral,
      display: number.display,
      basePriceInr: base,
      premiumInr: fee,
      priceInr: base + fee,
      prices: currencyPrices(base, fee),
      suggestions: [],
    })
  }

  if (route === 'queue' && request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const email = String(body?.contact?.email || '').trim().toLowerCase()
    const numeral = Number(body?.serial)
    if (!body?.product || !Number.isSafeInteger(numeral) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply({ message: 'A product, number, and valid email are required.' }, 400)
    }
    const { data: product, error: productError } = await resolveProduct(admin, String(body.product))
    if (productError || !product?.number_pool_id) return reply({ message: 'This product is not mapped to a number pool.' }, 404)
    const { data: number } = await admin.from('watch_numbers').select('id, display').eq('pool_id', product.number_pool_id).eq('numeral', numeral).maybeSingle()
    if (!number) return reply({ message: 'That number is not in the register.' }, 404)
    const { error: insertError } = await admin.from('number_waitlist').upsert(
      { watch_number_id: number.id, email, state: 'waiting' },
      { onConflict: 'watch_number_id,email', ignoreDuplicates: true },
    )
    if (insertError) return reply({ message: 'Could not join the number queue.' }, 500)
    const { count } = await admin.from('number_waitlist').select('id', { count: 'exact', head: true }).eq('watch_number_id', number.id).eq('state', 'waiting')
    return reply({ ok: true, ticket: { position: count || 1 } })
  }

  if (route === 'revalidate' && request.method === 'POST') {
    const body = await request.json().catch(() => null)
    if (!Array.isArray(body?.items) || body.items.length > 25) return reply({ ok: false, items: [] }, 400)
    const results = []
    for (const item of body.items) {
      const serial = Number(item.serial)
      if (!Number.isSafeInteger(serial)) {
        results.push({ ...item, status: 'invalid' })
        continue
      }
      const { data: product } = await resolveProduct(admin, String(item.product || ''))
      const { data: number } = product?.number_pool_id
        ? await admin.from('watch_numbers').select('id, status').eq('pool_id', product.number_pool_id).eq('numeral', serial).maybeSingle()
        : { data: null }
      if (Number(item.quantity) > 1) {
        results.push({ ...item, status: 'quantity' })
        continue
      }
      if (!number || number.status !== 'available' || !item.holdToken || !sessionId) {
        results.push({ ...item, status: number?.status === 'sold' ? 'gone' : 'expired' })
        continue
      }
      const { data: hold } = await admin.from('number_holds').select('id').eq('watch_number_id', number.id).eq('hold_token', item.holdToken).eq('session_id', sessionId).eq('state', 'held').gt('expires_at', new Date().toISOString()).maybeSingle()
      results.push({ ...item, status: hold ? 'held' : 'expired' })
    }
    return reply({ ok: results.every((item) => item.status === 'held' || item.status === 'ok'), items: results })
  }

  return reply({ message: 'Serial API route not found.' }, 404)
}

Deno.serve((request) => handleRequest(request).catch(() => reply({ message: 'Serial service request failed.' }, 500)))