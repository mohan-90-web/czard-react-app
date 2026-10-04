/**
 * CZARD serial picker — the storefront half of the number reservation system.
 *
 * Dropped onto the six Shopify product pages with one <script> tag. It does
 * four things, and the last one is the one that matters:
 *
 *   1. Injects a "Buy now" button wherever the merchant placed its
 *      mount, falling back to the add-to-cart form.
 *   2. Opens a modal, fetches /api/serials/chart, and draws the grid.
 *   3. On Reserve, takes a twelve-minute hold, puts the watch in the cart with
 *      the number on it as line item properties, starts the countdown on the
 *      page, closes the popup and opens the cart.
 *   4. Intercepts the checkout button and revalidates BEFORE letting it through.
 *
 * Step 4 is the whole reason this file is not a nice-to-have. A cart lives for
 * days and a hold lives for twelve minutes, so by the time somebody returns to
 * a parked cart their number may well belong to someone else. Shopify's
 * checkout cannot be taught to check; the only place left to say no is the
 * moment before the click lands, which is what the capture-phase listener below
 * is for.
 *
 * Written against a theme nobody here controls, so the defensive posture is
 * deliberate throughout:
 *
 *   - One global, window.CzardSerialPicker. Nothing else is added to the page.
 *   - No jQuery, no framework, no assumption about the theme's cart drawer.
 *   - Every DOM lookup is guarded. A theme that does not match any known
 *     selector loses the button; it must never lose its own add-to-cart.
 *   - Styles are injected once, namespaced .czrd-, and set on properties the
 *     theme is unlikely to reset. A theme's h2 rule must not restyle the modal.
 *   - Targets Safari 14: const/let, template literals, arrow functions and
 *     fetch are fine; optional chaining and ?? are avoided.
 *
 * The session id is minted here and kept in localStorage. It is what makes a
 * hold "yours" — it is sent as x-czard-session on every call, and the portal
 * pairs it with the hold token before it will refresh or release anything.
 */
;(function () {
  'use strict'

  if (window.CzardSerialPicker) return

  /* ---------------------------------------------------------------------
   * Configuration, read off the <script> tag
   * ------------------------------------------------------------------ */

  const script =
    document.currentScript ||
    (function () {
      const all = document.querySelectorAll('script[data-czard-portal],script[data-portal]')
      return all.length ? all[all.length - 1] : null
    })()

  function attr(name, fallback) {
    if (!script) return fallback
    const value = script.getAttribute(name)
    return value === null || value === '' ? fallback : value
  }

  /**
   * The portal origin. Defaults to the script's own host, which is right
   * whenever the file is served from the portal itself — the documented setup —
   * and overridable for the case where a theme has copied the file into its own
   * assets.
   */
  const PORTAL = String(attr('data-portal', '')).replace(/\/+$/, '') ||
    (script && script.src ? new URL(script.src, window.location.href).origin : '')

  const CONFIG = {
    portal: PORTAL,
    productId: attr('data-product', ''),
    variantId: attr('data-variant', ''),
    /**
     * The default only applies when the theme's script tag has no
     * `data-label`. An install that sets one — and the documented snippet in
     * shopify-theme/ used to — keeps whatever it says, so changing this alone
     * does not change a storefront that spells the label out.
     */
    buttonLabel: attr('data-label', 'Buy now'),
    // A theme with an unusual add-to-cart can name its own mount point.
    mount: attr('data-mount', ''),
    /**
     * The reservation-fee variants, as {"499": 12345, "999": 12346, …}.
     *
     * The published list charges a fee "additional to watch MRP" for the VIP
     * numbers, and a Shopify line item property cannot change a price. So the
     * fee is a second product — one variant per amount — added as its own cart
     * line. That is the only mechanism available without a Shopify app, and it
     * is also the honest one: the customer's order shows the watch and the
     * reservation fee as separate lines, which is what they are.
     *
     * Absent or unparseable means no fee is ever charged. The picker still
     * works and still shows the fee in the popup; the money simply is not
     * collected, and orders/paid flags the shortfall rather than hiding it.
     */
    feeVariants: (function () {
      try { return JSON.parse(attr('data-fee-variants', '{}')) } catch (e) { return {} }
    })(),
    /**
     * The fee product's handle, for automatic discovery.
     *
     * Given this, the picker fetches /products/<handle>.js and builds the
     * amount → variant id map itself, matching on PRICE. Nothing has to be
     * pasted, nothing goes stale when a variant is recreated, and the variants
     * can be named whatever reads well in the admin — the price is the fee, so
     * the price is the key.
     */
    feeHandle: attr('data-fee-handle', 'vip-number-reservation-fee'),

    /**
     * The product option that carries the reservation fee.
     *
     * When the watch product has an option whose values are the fee amounts —
     * "Number Fees": None / 499 / 999 / 1999 … — the fee is part of the
     * variant, and the whole flow changes for the better. Choosing a number
     * selects that variant, the theme reprices the page itself because that is
     * what themes do on a variant change, and the shop's own Add to cart and
     * Buy it now work untouched. No second line item, no cart scripting.
     *
     * Detected from the product rather than assumed: if no option by this name
     * exists, the picker falls back to adding a separate fee line.
     */
    feeOption: attr('data-fee-option', 'Number Fees'),

    /** The option value meaning "no fee". Every ordinary number needs one. */
    feeNoneValue: attr('data-fee-none', 'None'),

    /**
     * Where "Buy Now" sends a shopper, when it is not Shopify's own
     * checkout — a one-click provider such as GoKwik, which replaces it.
     *
     * Empty means /checkout. `{cart}` is substituted with Shopify's cart token.
     * A provider that exposes an SDK rather than a URL wants the
     * `czard:checkout` event instead; see goToCheckout.
     */
    checkoutUrl: attr('data-checkout-url', ''),

    /**
     * Start the page on the FEE-FREE variant, so the price a shopper meets is
     * the watch with an ordinary number on it.
     *
     * Shopify serves whichever variant it likes as the default — the first
     * available one — and on a product whose fee is a variant option that can
     * be a ₹2,999 Crown variant. The page then opens quoting a premium nobody
     * asked for, on an option the shopper cannot even see, because
     * hideFeeOption() takes the selector off the page (correctly: the fee is
     * decided by the number, not chosen). So the default has to be pinned here
     * or it is not pinned at all.
     *
     * On by default, and inert on a product with no fee option — which is all
     * six live references, where the fee is a separate cart line and the
     * variant price already IS the fee-free price. Set to "false" to leave
     * Shopify's own default alone.
     */
    defaultFeeFree: attr('data-default-fee-free', '') !== 'false',

    /**
     * The face the popup sets its numbers in.
     *
     * Body copy in the popup is font:inherit and always has been — it is the
     * theme's own type, so the panel reads as part of the shop. The serial
     * numbers are the exception: they are the object being sold, they are set
     * large, and a display face is what makes a five-digit reference look like
     * an engraving rather than a form field.
     *
     * The default is the site's own heading stack, verbatim from
     * src/styles/tokens.css — Fitzgerald over Georgia — and injectStyles()
     * @font-faces Fitzgerald off the portal so the storefront actually gets it
     * rather than quietly landing on the fallback. Nothing third-party is
     * fetched: it is this shop's font, from this shop's server, which the page
     * is already talking to for the chart.
     *
     * Still overridable, because this script is dropped onto a theme nobody
     * here controls and a theme that has moved to another display face should
     * be able to say so without editing this file.
     *
     * Sanitised on the way in: it is written into a stylesheet, so the handful
     * of characters that could end a declaration or open a new rule are dropped.
     */
    displayFont: String(attr('data-display-font', "'Fitzgerald',Georgia,'Times New Roman',serif"))
      .replace(/[{}<>;]/g, '')
      .slice(0, 240),

    /**
     * The product option that carries the warranty length — "Warranty":
     * One Year Warranty / Lifetime Warranty on the Compass trio, absent on the
     * Genève trio (see shopify-theme/VARIANT-SETUP.md).
     *
     * A warranty choice changes the WATCH's own price (₹14,999 vs ₹17,499),
     * not the reservation fee, so it has to be settled before a number is
     * priced at all — a Crown quoted against the wrong warranty is quoted
     * wrong by exactly the warranty gap, not by a rounding error.
     */
    warrantyOption: attr('data-warranty-option', 'Warranty'),

    /**
     * The warranty a product starts on when the shopper has expressed no
     * preference — One Year, the cheaper of the two, so nobody is quoted the
     * ₹2,500 Lifetime price by default.
     *
     * Matched loosely against the option's real values (see
     * normalizeWarranty): "One Year Warranty" in the Shopify admin and
     * "1 Year" on a theme's own control are the same choice, and a merchant
     * should not have to know which spelling this file was written against.
     *
     * Set to "" to preselect nothing and leave whatever Shopify served.
     */
    defaultWarranty: attr('data-default-warranty', 'One Year Warranty'),

    /**
     * Hold the "Buy now" button (and the shop's own buy buttons) shut
     * until the shopper has actually touched the warranty control.
     *
     * OFF by default. It used to be on, on the reasoning that a number quoted
     * against a warranty nobody picked is quoted against an assumption — but
     * the assumption is now made explicitly and visibly instead
     * (`defaultWarranty`, applied to the variant at boot), which buys the same
     * correctness without meeting every shopper with a dead button. Set to
     * "true" to go back to demanding a deliberate touch; the two are mutually
     * exclusive by design, and applyDefaultVariant() leaves the warranty alone
     * when this is on (it still pins the fee to none, which is not the
     * shopper's decision either way). Either way it is inert on a product with
     * no such option (the whole Genève trio).
     */
    requireWarranty: attr('data-require-warranty', '') === 'true',

    /**
     * Hold the buy buttons until a number has been chosen.
     *
     * Off by default because disabling a shop's Add to cart is not a decision a
     * script should make on its own. On, it closes the gap that dynamic
     * checkout and a fast shopper both open: a watch bought with no number on
     * it, which nothing downstream can repair.
     */
    requireNumber: attr('data-require-number', '') === 'true',

    /**
     * What to do with the cart once a number has been reserved.
     *
     * Reserving now ADDS THE WATCH TO THE CART itself rather than leaving the
     * shopper to press the theme's Add to cart afterwards — the number is held
     * for twelve minutes from the moment they confirm, and a hold ticking down
     * against a cart the shopper never filled is a reservation that lapses while
     * they are still reading the page. So the confirm button does the whole
     * thing: hold, cart, timer, close.
     *
     *   'drawer' (default) — open the theme's cart drawer if one can be found.
     *                        Best effort by design: there is no cross-theme API
     *                        for this, so the on-page notice always carries a
     *                        "View cart" link as the guaranteed path.
     *   'cart'             — go to /cart. Certain, and it leaves the product page.
     *   'none'             — add silently and stay put.
     */
    openCart: (attr('data-open-cart', 'drawer') || 'drawer').toLowerCase(),

    /** The product handle, for reading its variants. Derived from the URL when absent. */
    handle: attr('data-handle', '') ||
      (function () {
        const m = window.location.pathname.match(/\/products\/([^/?#]+)/)
        return m ? m[1] : ''
      })(),
    autoOpen: attr('data-auto-open', '') === 'true',
  }

  const SESSION_KEY = 'czard.session'
  const HOLD_KEY = 'czard.hold.' + CONFIG.productId

  /* ---------------------------------------------------------------------
   * Small helpers
   * ------------------------------------------------------------------ */

  /* ---------------------------------------------------------------------
   * The market
   *
   * CZARD sells worldwide, so the currency this popup quotes in is not a
   * constant and never was — it just looked like one while the only shop was
   * the Indian one. It is decided in this order:
   *
   *   1. Shopify's own `Shopify.currency.active`, which is the market the
   *      shopper is actually in and the currency the cart will charge. If the
   *      page around us is showing dollars, the popup showing rupees is not a
   *      formatting preference, it is a lie about what is about to happen.
   *   2. Whatever the chart says the default is, for a theme that does not
   *      publish the global (older themes, and every preview domain).
   *
   * The FIGURES are the portal's, never converted here. A chart row carries a
   * `prices` block with the amount in every currency the shop quotes, worked
   * out by src/lib/pricing/currency.js and rounded there. Converting in this
   * file instead would put a second rounding rule on the other side of the
   * network from the first — and the fee lookup below matches a Shopify
   * variant on its exact amount, so the two rules disagreeing by one dollar is
   * a shopper who cannot add to cart at all.
   * ------------------------------------------------------------------ */

  /**
   * TWO currencies, and keeping them apart is the whole of this section.
   *
   * MARKET is what Shopify will CHARGE. It comes from `Shopify.currency.active`
   * and it is a fact about the shop: it decides what `/products/x.js` reports,
   * which is what the reservation-fee variant lookup matches against, and what
   * the card is debited in. Nothing may quote a figure to the cart in anything
   * else — a fee of "€40" looked up against a variant priced ₹2,499 finds
   * nothing and stops the shopper adding to cart at all.
   *
   * QUOTE is what the shopper is SHOWN, and it comes from the portal, which
   * resolved their country from the IP the request actually arrived on.
   *
   * They used to be one variable, and that is the bug this fixes. A storefront
   * without Shopify Markets configured reports INR as its active currency to
   * every visitor on earth, so the popup quoted rupees in Berlin, in New York
   * and in Singapore — to shoppers who would have to go and look up a rate to
   * find out whether they could afford the watch, and most will not bother.
   *
   * Where the two differ the popup says so, every time a total is shown. That
   * is not a hedge, it is the honest reading: we are quoting a shopper in their
   * own money while the till is still set to rupees, and a checkout page that
   * suddenly says ₹14,999 to somebody who was shown €220 has broken a promise
   * this script made. Configure the market in Shopify and the two agree by
   * themselves — `Shopify.currency.active` becomes EUR, QUOTE follows it, and
   * the note disappears with no code change.
   */
  const MARKET = {
    code: 'INR',
    locale: 'en-IN',
    /** Decimals Shopify reports this currency's prices in. All three are 2. */
    minorUnits: 2,
  }

  const QUOTE = {
    code: 'INR',
    locale: 'en-IN',
    /**
     * Where `code` came from — 'chosen', 'geo', 'browser' or 'charge'. Carried
     * so `CzardSerialPicker.market()` can answer "why am I seeing rupees?" with
     * the step that decided it rather than leaving it to be inferred.
     */
    source: 'charge',
    /**
     * A currency named outright, which outranks every other signal until it is
     * cleared. Set by `CzardSerialPicker.quoteIn()`; empty for every ordinary
     * shopper, and deliberately not persisted — see that function.
     */
    chosen: '',
  }

  /**
   * The rate table off the chart payload, keyed by code — the same figures
   * src/lib/pricing/currency.js prices from, travelling with the payload so the
   * two cannot disagree about what a dollar is. Populated by adoptMarket.
   */
  let RATES = {}

  const formatters = {}

  function formatterFor(code) {
    if (formatters[code]) return formatters[code]
    try {
      formatters[code] = new Intl.NumberFormat(localeFor(code), {
        style: 'currency',
        currency: code,
        maximumFractionDigits: 0,
      })
    } catch (e) {
      formatters[code] = { format: function (n) { return code + ' ' + n } }
    }
    return formatters[code]
  }

  /** The locale a currency is written in, from the table the chart brought. */
  function localeFor(code) {
    const row = RATES[code]
    return (row && row.locale) || QUOTE.locale || 'en-IN'
  }

  /**
   * Format a figure. Defaults to the QUOTE currency, because every caller that
   * does not say otherwise is putting a number in front of the shopper — the
   * handful that mean a figure the cart will charge pass MARKET.code explicitly.
   */
  const money = function (n, code) {
    return formatterFor(code || QUOTE.code).format(Number(n) || 0)
  }

  /** Rupees per unit of a currency, for converting one market's figure to another. */
  function inrPerUnit(code) {
    const row = RATES[code]
    const rate = row && Number(row.inrPerUnit)
    return Number.isFinite(rate) && rate > 0 ? rate : 1
  }

  /**
   * The nearest multiple of `step`, halves up — the same rule
   * src/lib/pricing/currency.js rounds with, repeated here because the live
   * price correction has to land on the same figures the server would have
   * produced. Two rounding rules on two sides of the network is how a fee
   * amount ends up one unit away from the variant priced to carry it.
   */
  function roundToStep(amount, step) {
    const n = Number(amount)
    const s = Number(step)
    if (!isFinite(n)) return 0
    if (!isFinite(s) || s <= 1) return Math.round(n)
    return Math.round(n / s) * s
  }

  /** A charge-currency figure, expressed in the quote currency. */
  function toQuote(amount, fromCode) {
    if (fromCode === QUOTE.code) return Math.round(Number(amount) || 0)
    const inr = (Number(amount) || 0) * inrPerUnit(fromCode)
    const row = RATES[QUOTE.code]
    return roundToStep(inr / inrPerUnit(QUOTE.code), (row && row.priceStep) || 1)
  }

  /** True when the shopper is quoted one currency and charged another. */
  function quotingForeign() {
    return QUOTE.code !== MARKET.code
  }

  /**
   * The sentence that keeps the quote honest. Empty — and invisible — the
   * moment Shopify is actually charging what we are quoting.
   */
  function chargeNote() {
    return quotingForeign()
      ? 'Prices shown in ' + QUOTE.code + '. Checkout is charged in ' + MARKET.code + '.'
      : ''
  }

  /* ---------------------------------------------------------------------
   * Working out the shopper's currency without a proxy
   *
   * The portal answers this from the IP the request arrived on, which is the
   * best answer available and the one used whenever it exists. It does not
   * always exist: geo.js reads `x-vercel-ip-country`, `cf-ipcountry` and
   * `x-country` and guesses at nothing, so a portal on a bare VPS — or behind
   * any proxy not configured to pass one of those through — reports
   * `resolved: false` for every visitor on earth.
   *
   * That case used to fall straight through to the charge currency, which on a
   * shop without Shopify Markets is rupees. Rupees for a shopper in Berlin,
   * and no amount of pricing work on the server changes it: the payload
   * already carries the euro figures, and the popup was choosing not to read
   * them. Everything below exists to make that last case a guess instead of a
   * surrender.
   *
   * The portal's own pages have had this fallback all along — guessFromTimeZone
   * in src/components/MarketProvider.jsx. This is the same idea, one step less
   * coarse, and it stays a FALLBACK: a resolved country always wins.
   * ------------------------------------------------------------------ */

  /**
   * Euro countries, and India. Everywhere else is quoted in dollars.
   *
   * Deliberately the same list as CURRENCY_BY_COUNTRY in
   * src/lib/pricing/currency.js, and it has to stay the same list. This is the
   * answer used when the server could not give one, so a list that disagreed
   * would move a shopper's prices the day geolocation started working — the
   * same person, the same country, a different quote, for no reason they could
   * see.
   */
  const EURO_COUNTRIES = [
    'AT', 'BE', 'HR', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV', 'LT',
    'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES',
    'AD', 'MC', 'SM', 'VA', 'ME', 'XK',
  ]

  function currencyForCountry(code) {
    const country = String(code || '').trim().toUpperCase()
    if (!country) return ''
    if (country === 'IN') return 'INR'
    return EURO_COUNTRIES.indexOf(country) !== -1 ? 'EUR' : 'USD'
  }

  /** The region subtag of a language tag — "en-GB" → "GB", "de" → "". */
  function regionOf(tag) {
    if (!tag) return ''
    try {
      if (window.Intl && Intl.Locale) {
        const region = new Intl.Locale(String(tag)).region
        if (region) return String(region).toUpperCase()
      }
    } catch (e) {
      /* an unparseable tag is one signal missing, not an error */
    }
    // Older browsers, and anything Intl.Locale refused. Handles "en-US" and
    // "en_US"; a tag with a script subtag ("zh-Hans-CN") only resolves through
    // Intl.Locale above, which is where it belongs.
    const match = /^[A-Za-z]{2,3}[-_]([A-Za-z]{2})(?:[-_]|$)/.exec(String(tag))
    return match ? match[1].toUpperCase() : ''
  }

  /**
   * Where this browser appears to be. '' when it will not say.
   *
   * Time zone is asked FIRST, and only about India. A time zone describes where
   * the machine is; a language tag describes what its owner wants to read, and
   * those come apart most often in exactly the market that matters most here —
   * an Indian shopper running an en-US build of Chrome is ordinary, and quoting
   * them dollars on the strength of it would be the precise mistake this
   * fallback exists to avoid. Everywhere else the language tag's region is the
   * better signal, because it names a country outright instead of a continent.
   */
  function guessCountry() {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
      if (zone === 'Asia/Calcutta' || zone === 'Asia/Kolkata') return 'IN'
    } catch (e) {
      /* no Intl, or a locked-down browser: fall through to the language tags */
    }

    try {
      const tags = (navigator.languages && navigator.languages.length)
        ? navigator.languages
        : [navigator.language]
      for (let i = 0; i < tags.length; i++) {
        const region = regionOf(tags[i])
        if (region) return region
      }
    } catch (e) {
      /* nothing to read */
    }

    return ''
  }

  /**
   * Which currency this shopper is being quoted in, which one the till will
   * actually charge, and — the part that matters when somebody reports
   * "it is showing rupees in Berlin" — which step decided it.
   *
   * `source: 'geo'` is the healthy answer. `'browser'` means the portal is not
   * behind a proxy that sets a country header, so this is a guess made from the
   * shopper's own machine; it is usually right and it is worth fixing the
   * header anyway. `'charge'` means even that failed and the till's own
   * currency is being shown, which is the only state that reproduces the
   * original bug.
   */
  function marketReport() {
    return {
      quote: QUOTE.code,
      charge: MARKET.code,
      foreign: quotingForeign(),
      note: chargeNote(),
      country: (state.chart && state.chart.money && state.chart.money.country) || null,
      resolved: Boolean(state.chart && state.chart.money && state.chart.money.resolved),
      source: QUOTE.source,
      /** What the browser thinks, whether or not it was used. */
      guessed: guessCountry() || null,
    }
  }

  /**
   * Point MARKET at the currency this shopper is in, using the table the chart
   * brought with it. Called once per chart load, because a shopper can change
   * market mid-session and Shopify re-renders the page around us when they do.
   */
  function adoptMarket(chart) {
    const table = (chart && chart.money) || null
    const known = (table && table.currencies) || []

    RATES = {}
    for (let i = 0; i < known.length; i++) RATES[known[i].code] = known[i]

    const shopify = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || ''
    const wanted = String(shopify || (table && table.home) || 'INR').toUpperCase()

    let picked = null
    for (let i = 0; i < known.length; i++) {
      if (known[i].code === wanted) picked = known[i]
    }
    // A currency Shopify is charging in that the portal does not price in — a
    // market somebody opened without adding a row to the currency table. There
    // is no good answer available at this point: we cannot convert without a
    // rate, and the reservation-fee variants will not be priced at figures this
    // script can look up either, so VIP numbers on this market will refuse to
    // go into the cart. Falling back to the default at least quotes figures
    // that were actually computed.
    //
    // Loud on the console because this is fixed in an afternoon by whoever
    // opened the market and is invisible to everyone else — including to
    // anybody testing from India, where it cannot reproduce.
    if (!picked) {
      if (window.console && console.warn) {
        console.warn(
          '[czard] This shop is selling in ' + wanted + ', which the portal does not price. ' +
            'Add it to CURRENCIES in src/lib/pricing/currency.js and price the reservation-fee ' +
            'variants for this market — see docs/PRICING.md. Quoting ' +
            ((table && table.default) || 'the default') + ' until then.',
        )
      }
      for (let i = 0; i < known.length; i++) {
        if (known[i].code === (table && table.default)) picked = known[i]
      }
    }
    if (!picked) return

    MARKET.code = picked.code
    MARKET.locale = picked.locale || MARKET.locale
    MARKET.minorUnits = picked.minorUnits == null ? 2 : picked.minorUnits

    /**
     * And now the separate question: what to QUOTE.
     *
     * Four answers, best first, and each one is only taken if the portal
     * actually prices in it — a currency with no row in the table has no rate,
     * no locale and no figures on any chart row, so quoting it would print
     * blanks.
     *
     *   chosen   the shopper (or an operator testing) named it outright
     *   geo      the portal resolved their country from the request's IP
     *   browser  their own time zone and language tags, when the portal could
     *            not — see guessCountry above
     *   charge   nothing known: quote whatever the till is set to
     *
     * `geo` beats `browser` and not the other way round. The portal sees the
     * connection; this file sees a machine's settings, and a VPN, a travelling
     * laptop or a locale somebody set once in 2019 are all ways for the second
     * to be wrong while the first is right.
     *
     * `charge` is last and remains the floor rather than the manifest default,
     * for the reason it always was: a portal behind no geolocating proxy
     * reports dollars as `suggested` while setting `resolved: false`, and
     * quoting every visitor dollars on the strength of knowing nothing would
     * put dollar prices in front of the Indian shoppers who are most of the
     * traffic. What changed is that reaching this floor is now rare — it takes
     * a browser that will not name a time zone OR a region, where before it
     * took only a proxy that did not set a header.
     */
    const fromGeo = table && table.resolved ? String(table.suggested || '').toUpperCase() : ''
    const fromBrowser = fromGeo ? '' : currencyForCountry(guessCountry())

    // `wanted` is already taken, a few lines up, for the currency the TILL is
    // set to. These two being different questions is the whole point of this
    // section, so they do not get to share a name.
    let quoteCode = ''
    let quoteSource = 'charge'
    if (QUOTE.chosen && RATES[QUOTE.chosen]) {
      quoteCode = QUOTE.chosen
      quoteSource = 'chosen'
    } else if (fromGeo && RATES[fromGeo]) {
      quoteCode = fromGeo
      quoteSource = 'geo'
    } else if (fromBrowser && RATES[fromBrowser]) {
      quoteCode = fromBrowser
      quoteSource = 'browser'
    }

    QUOTE.code = quoteCode || MARKET.code
    QUOTE.source = quoteCode ? quoteSource : 'charge'
    QUOTE.locale = (RATES[QUOTE.code] && RATES[QUOTE.code].locale) || MARKET.locale
  }

  /**
   * One row's three figures in the market's currency.
   *
   * Falls back to the rupee fields when a payload arrives without a `prices`
   * block — an older portal against a newer script. That combination quotes
   * rupee amounts under a rupee symbol, which is wrong for a shopper in Paris
   * but is at least internally consistent, and it keeps the popup opening.
   */
  function quoteOf(row) {
    const book = row && row.prices && row.prices[QUOTE.code]
    if (book) return book
    const total = Number((row && row.priceInr) || 0)
    const fee = Number((row && row.premiumInr) || 0)
    return { base: total - fee, fee: fee, total: total }
  }

  /** Shopify reports prices in the currency's minor unit — paise, cents. */
  function majorUnits(price) {
    return Math.round(Number(price) / Math.pow(10, MARKET.minorUnits))
  }

  /**
   * localStorage throws in Safari private mode and when a page is sandboxed, so
   * every access is wrapped. A picker that cannot remember a session still
   * works for the length of one page view, which is better than a picker that
   * throws on load and takes the button with it.
   */
  function storageGet(key) {
    try { return window.localStorage.getItem(key) } catch (e) { return null }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value) } catch (e) { /* not fatal */ }
  }
  function storageDrop(key) {
    try { window.localStorage.removeItem(key) } catch (e) { /* not fatal */ }
  }

  let memorySession = ''

  function sessionId() {
    let id = storageGet(SESSION_KEY) || memorySession
    if (!id) {
      id = mintId()
      memorySession = id
      storageSet(SESSION_KEY, id)
    }
    return id
  }

  function mintId() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID()
      if (window.crypto && window.crypto.getRandomValues) {
        const bytes = new Uint8Array(16)
        window.crypto.getRandomValues(bytes)
        let out = ''
        for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
        return out
      }
    } catch (e) { /* fall through */ }
    // Last resort only. Never reached on any browser this ships to.
    return 'czd-' + String(Date.now()) + '-' + String(Math.floor(Math.random() * 1e9))
  }

  function api(path, options) {
    const opts = options || {}
    const headers = { 'x-czard-session': sessionId() }
    if (opts.body) headers['Content-Type'] = 'application/json'
    const apiBase = window.CZARD_SERIAL_API_BASE || CONFIG.portal

    return fetch(apiBase + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      // No cookies. The session travels in the header above, which is why the
      // portal's CORS never has to emit Allow-Credentials.
      credentials: 'omit',
    }).then(function (response) {
      return response
        .json()
        .catch(function () { return {} })
        .then(function (data) {
          return { ok: response.ok, status: response.status, data: data }
        })
    })
  }

  /* ---------------------------------------------------------------------
   * The hold this browser currently owns for this product
   *
   * Kept so the checkout gate can present the token as proof. The portal will
   * not refresh or release a hold on a session id alone — the token has to come
   * back with it — so losing this is losing the ability to extend the hold, not
   * the hold itself.
   * ------------------------------------------------------------------ */

  /**
   * More than the token, now that the page carries a live countdown.
   *
   * The notice next to the picker button has to be rebuildable after a reload —
   * a shopper who refreshes the product page mid-hold must still see how long
   * they have — and rebuilding it needs the fee and the tier as well as the
   * clock. `currency` is stamped alongside the fee because a shopper can switch
   * market between the reservation and the reload, and a figure quoted in
   * yesterday's currency is worse than no figure.
   */
  /**
   * The deadline in the SHOPPER'S OWN clock, stamped when the hold is granted.
   *
   * `expiresAt` is the truth and stays the truth — it is the server's, and the
   * server is what actually releases the number. But it is an ABSOLUTE instant,
   * and the countdown subtracts it from `Date.now()`, which is the device's
   * idea of the time. Those are two different clocks. A phone running a few
   * minutes fast makes a twelve-minute hold read as less than that, and one
   * running twelve minutes fast makes it read 0:00 the instant it is granted —
   * on a shopper whose hold is in fact entirely intact.
   *
   * `holdSeconds` is a DURATION, so it survives that: the API sends it beside
   * `expiresAt` for exactly this reason and this record used to drop it on the
   * floor. Adding it to the local clock here gives a deadline measured in the
   * same clock the countdown will compare it against, which cancels any fixed
   * skew between the device and the server.
   *
   * Still absolute rather than a seconds-remaining counter, so the property the
   * countdown was built for is kept: a backgrounded tab, where timers are
   * throttled to once a minute, comes back showing the right figure instead of
   * one that fell behind by however long it was hidden.
   */
  function localDeadline(hold) {
    const seconds = Number(hold && hold.holdSeconds)
    return Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : null
  }

  /**
   * The hold, in memory as well as in storage.
   *
   * `storageSet` swallows its failure — deliberately, it is not fatal — and on
   * a browser that refuses localStorage (Safari's private mode throws on write,
   * and a shopper blocking all cookies gets the same) that left `currentHold()`
   * answering null forever. Everything drawn from the hold object itself still
   * rendered, so the notice named the right serial at the right fee and only the
   * clock, which is the one part that reads storage, showed 0:00.
   *
   * `sessionId()` above already keeps a `memorySession` for this exact case.
   * This is the same fallback for the record that matters more: a session id can
   * be minted again, a hold token cannot.
   */
  let memoryHold = null

  function rememberHold(hold) {
    const record = {
      token: hold.token,
      serial: hold.serial,
      display: hold.display,
      expiresAt: hold.expiresAt,
      // Stamped once, here, rather than recomputed on every tick — a deadline
      // recomputed from `holdSeconds` each second would never count down.
      deadlineLocal: localDeadline(hold),
      tierId: hold.tierId || null,
      tierLabel: hold.tierLabel || null,
      fee: holdFee(hold),
      currency: QUOTE.code,
    }
    memoryHold = record
    storageSet(HOLD_KEY, JSON.stringify(record))
  }

  /**
   * Memory first, storage second — and the order is the whole point.
   *
   * `memoryHold` is whatever this page last did; storage is how that survives a
   * reload. Reading storage first looks equivalent and is not, because the two
   * disagree in exactly the case this fallback exists for: when `setItem`
   * throws, `getItem` still happily returns the PREVIOUS hold — the one that
   * has since been replaced or expired. Storage-first hands back that stale
   * record and the fresh one sitting in memory is never consulted, so the
   * countdown reads 0:00 off a hold the shopper no longer has while the notice
   * beside it names the number they just took.
   *
   * On a fresh page memoryHold is null and storage answers, which is the reload
   * case working exactly as before.
   */
  function currentHold() {
    if (memoryHold) return memoryHold
    const raw = storageGet(HOLD_KEY)
    if (!raw) return null
    try { return JSON.parse(raw) } catch (e) { return null }
  }

  function forgetHold() {
    memoryHold = null
    storageDrop(HOLD_KEY)
  }

  /**
   * Give a number back to the grid, now rather than in twelve minutes.
   *
   * Fire and forget, deliberately. Nothing the caller does depends on the
   * answer: the shopper has already moved on to another number or emptied their
   * cart, and the worst case if this never lands is that one serial stays locked
   * until its own expiry — irritating, self-healing, never worth blocking a
   * click over. The portal treats an unknown token as success for the same
   * reason, so a double send is routine rather than an error.
   *
   * Worth doing rather than letting the clock run out, twice over. The release
   * path hands the number straight to the head of its queue, so somebody who has
   * been waiting is offered it now instead of in eleven minutes. And a hold that
   * is never released still counts against MAX_HOLDS_PER_SESSION — a shopper who
   * tries five numbers before settling would otherwise lock all five, hit the
   * cap, and be refused the sixth: the one they actually wanted.
   */
  function releaseHoldToken(token, reason) {
    if (!token) return Promise.resolve(null)
    return api('/api/serials/release', {
      method: 'POST',
      // One of a closed set the portal recognises; anything else is filed as a
      // plain shopper release. It ends up on the admin timeline, which is how
      // ops tells "they swapped it" from "they emptied their cart" when a
      // number keeps coming back.
      body: { holdToken: token, reason: reason || null },
    }).catch(function () { return null })
  }

  /* ---------------------------------------------------------------------
   * Shopify's AJAX cart
   *
   * /cart/add.js when the line does not exist yet, /cart/change.js when it
   * does. Both are theme-independent — they are Shopify's own endpoints, not
   * the theme's — which is why the picker drives them directly rather than
   * trying to cooperate with whatever cart JS the theme ships.
   * ------------------------------------------------------------------ */

  function cartState() {
    return fetch('../cart.js', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json() })
      .catch(function () { return null })
  }

  /**
   * The variant the shopper is actually looking at, right now.
   *
   * `data-variant` is rendered once by Liquid and is only correct until someone
   * changes the variant — which on a modern theme (Minimog, Dawn, anything with
   * a JS variant picker) happens without a page reload. Reading the stale value
   * would attach the number to a cart line for a variant the shopper is no
   * longer on.
   *
   * Every Shopify product form carries the selected variant in a hidden input
   * named `id`, and every theme updates it on switch, because that input IS what
   * gets posted to /cart/add. So it is the one source of truth that does not
   * depend on knowing which theme this is, or which custom event it fires.
   */
  function currentVariantId() {
    const input = document.querySelector(
      'form[action*="/cart/add"] [name="id"]:not([disabled])',
    )
    const live = input && input.value ? String(input.value).trim() : ''
    return live || String(CONFIG.variantId || '')
  }

  /**
   * Resolves to `{ cart, reducedFrom }`. `reducedFrom` is the quantity the line
   * used to carry when this call had to cut it down to one, and null otherwise —
   * see the note on quantity below. Callers that only need the sequencing can
   * ignore the value entirely.
   */
  function attachToCart(properties, variantId, options) {
    const wanted = String(variantId || currentVariantId() || '')
    const forceNewLine = Boolean(options && options.forceNewLine)

    return cartState().then(function (cart) {
      /**
       * `forceNewLine` is what makes a SECOND watch possible.
       *
       * Ordinarily a line for this variant is updated in place, because
       * re-picking a number must replace the old one rather than leave two
       * serials in the cart. When the shopper has asked for another watch that
       * is exactly wrong — the whole point is a second line — so the lookup is
       * skipped and /cart/add.js is posted instead. Shopify keys a cart line on
       * variant AND properties, so a second number produces a second line by
       * itself; no line key has to be invented here.
       */
      const existing =
        !forceNewLine && cart && cart.items
          ? cart.items.filter(function (item) { return String(item.variant_id) === wanted })[0]
          : null

      if (existing) {
        /**
         * change.js addresses the line by key and REPLACES its properties, so
         * re-picking a number overwrites the old one rather than leaving two
         * serials on one line.
         *
         * The quantity goes to 1, and this line used to preserve whatever was
         * there. One number is one watch: a line that says TC-0246 and quantity
         * 3 is asking for three watches carrying the same engraved number, which
         * cannot be made and cannot be shipped. Cutting it here is the earliest
         * point anything notices — before this, the next thing to see it was
         * orders/paid, after the card had been charged.
         *
         * It is never silent. `reducedFrom` goes back to the caller, which says
         * so in the confirmation, because quietly removing two watches from
         * somebody's cart is worse than the problem it solves.
         */
        return fetch('../cart/change.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ id: existing.key, quantity: 1, properties: properties }),
        })
          .then(readCartResponse)
          .then(function (data) {
            return { cart: data, reducedFrom: existing.quantity > 1 ? existing.quantity : null }
          })
      }

      return fetch('../cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ items: [{ id: wanted, quantity: 1, properties: properties }] }),
      })
        .then(readCartResponse)
        .then(function (data) { return { cart: data, reducedFrom: null } })
    })
  }

  /**
   * Put a different number on ONE named cart line, leaving every other line
   * exactly as it is.
   *
   * This is what the number tags press. The ordinary path cannot do it:
   * attachToCart finds a line by VARIANT, and two watches of the same reference
   * on the same warranty are two lines on the same variant — so it would find
   * whichever came first and overwrite that one's serial, silently, while the
   * line the shopper actually clicked kept the number they were trying to
   * change. A line key is the only thing that names one of two identical-looking
   * lines, and it is what serialsInCart() already carries.
   *
   * Two shapes, decided by whether the number moves the line's variant:
   *
   *   SAME VARIANT (every live product — the fee is its own line there, so the
   *   watch line stays on its warranty variant whatever number it carries).
   *   change.js replaces the properties in place. Atomic, keeps the line's
   *   position in the cart, and there is no moment where the cart is wrong.
   *
   *   DIFFERENT VARIANT (fee-in-variant products: an ordinary number to a Crown
   *   moves the line from "None" to "2499"). A line cannot change its variant,
   *   so the new one is added and the old one removed — in that order, because
   *   an add that fails leaves the shopper with the watch they already had,
   *   while a remove that succeeds before a failed add leaves them with nothing.
   *   Neither add can merge into a sibling: Shopify keys a line on variant AND
   *   properties, and the Serial in these properties is unique to this line.
   *
   * The quantity goes to 1 for the same reason attachToCart does it — one
   * number is one watch — and `reducedFrom` reports it so the notice can say so.
   */
  function replaceCartLine(line, properties, variantId) {
    const wanted = String(variantId || line.variant || currentVariantId() || '')
    const reducedFrom = Number(line.quantity) > 1 ? Number(line.quantity) : null

    if (String(line.variant) === wanted) {
      return fetch('../cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ id: line.key, quantity: 1, properties: properties }),
      })
        .then(readCartResponse)
        .then(function (data) { return { cart: data, reducedFrom: reducedFrom } })
    }

    return fetch('../cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: [{ id: wanted, quantity: 1, properties: properties }] }),
    })
      .then(readCartResponse)
      .then(function (data) {
        return removeCartLines([{ key: line.key }]).then(function () {
          return { cart: data, reducedFrom: reducedFrom }
        })
      })
  }

  function readCartResponse(response) {
    return response.json().catch(function () { return {} }).then(function (data) {
      if (!response.ok) {
        const message = data && data.description ? data.description : 'The cart refused that item.'
        throw new Error(message)
      }
      // Themes listen for this to re-render their cart count and drawer. Firing
      // it is the difference between the number appearing in the cart and the
      // shopper thinking nothing happened.
      document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }))
      document.dispatchEvent(new CustomEvent('czard:serial-attached', { bubbles: true, detail: data }))
      return data
    })
  }

  /**
   * Put the reservation fee on the cart as its own line.
   *
   * Keyed by amount rather than by tier, because the fee is not a property of
   * the tier: a Crown is ₹1,999, ₹2,499 or ₹2,999 on a Compass depending on
   * which Crown, and ₹9,999 on a Genève. One variant per AMOUNT is therefore
   * the smallest set that covers the whole table, and it stays correct if the
   * list is repriced without adding variants.
   *
   * A missing variant is reported, not swallowed. The alternative — quietly
   * adding the watch without its fee — sells a ₹2,999 Crown for nothing and
   * nobody finds out until the accounts do.
   */
  /* ---------------------------------------------------------------------
   * Variant mode — the fee lives on the watch itself
   * ------------------------------------------------------------------ */

  let productPromise = null

  /** This product, from Shopify's own JSON. Memoised for the page. */
  function productJson() {
    if (productPromise) return productPromise
    if (!CONFIG.handle) return Promise.resolve(null)
    productPromise = fetch('/products/' + CONFIG.handle + '.js', {
      headers: { Accept: 'application/json' },
    })
      .then(function (r) { return r.ok ? r.json() : null })
      .catch(function () { return null })
    return productPromise
  }

  /** The index of a named option on a /products/<handle>.js payload, or -1. */
  function optionIndexByName(product, name) {
    if (!product || !product.options) return -1
    const wanted = String(name).toLowerCase()
    for (let i = 0; i < product.options.length; i++) {
      const optName = product.options[i].name || product.options[i]
      if (String(optName).toLowerCase() === wanted) return i
    }
    return -1
  }

  /** The index of the fee option, or -1 when this product does not use one. */
  function feeOptionIndex(product) {
    return optionIndexByName(product, CONFIG.feeOption)
  }

  /** The index of the warranty option, or -1 when this product has none. */
  function warrantyOptionIndex(product) {
    return optionIndexByName(product, CONFIG.warrantyOption)
  }

  /** One variant by id, or null. Ids are compared as strings throughout. */
  function variantById(product, id) {
    if (!product || !product.variants) return null
    return product.variants.filter(function (v) {
      return String(v.id) === String(id)
    })[0] || null
  }

  /**
   * The variant that differs from `from` in exactly one option: `optionIdx`,
   * which becomes `value`. Everything else — the fee the number decided, a
   * strap, a dial — is carried across untouched.
   *
   * This is what makes "change the warranty" a move rather than a reset: a
   * Crown reserved at One Year / 2999 has to land on Lifetime / 2999, not on
   * Lifetime / none, which is the same watch with the shopper's ₹2,999 number
   * premium quietly dropped off it.
   */
  function siblingVariant(product, from, optionIdx, value) {
    if (!product || !product.variants || !from) return null
    const wanted = normalizeWarranty(value)

    return product.variants.filter(function (v) {
      if (normalizeWarranty(v.options[optionIdx]) !== wanted) return false
      for (let i = 0; i < v.options.length; i++) {
        if (i === optionIdx) continue
        if (v.options[i] !== from.options[i]) return false
      }
      return true
    })[0] || null
  }

  /**
   * The variant a number's price is really quoted against: the watch's own
   * price for whichever warranty (or other non-fee option) is presently
   * selected, before any VIP premium is added on top.
   *
   * Two shapes, and getting this wrong the first time is what produced a real
   * bug: EVERY live CZARD product — checked directly against
   * czard.myshopify.com, not assumed from the docs — turns out to use the
   * separate reservation-fee PRODUCT (VIP-NUMBER-FEES.md), not a Number Fees
   * variant OPTION (VARIANT-SETUP.md describes a plan that was never actually
   * finished on the store). None of the six carries an option by
   * CONFIG.feeOption's name at all.
   *
   * So requiring feeOptionIndex() to succeed before returning anything — the
   * first version of this function — meant it returned null for every real
   * product, every time, and applyLivePricing() silently skipped
   * reflecting the warranty in the popup's prices on all six. A shopper who
   * chose Lifetime Warranty (+₹2,500) still saw every number priced against
   * One Year, off by exactly that gap on every single row.
   *
   * The fix is that a fee OPTION is optional twice over: when there is one,
   * match every other option against the current variant with the fee option
   * pinned to "no fee" (selectVariantForFee()'s own rule, kept here
   * side-effect-free so reading a price never moves the shopper's variant).
   * When there is none, the fee lives outside the variant entirely — on a
   * fee-line product there is nothing to filter, because the CURRENT variant
   * already IS the fee-free base price for whichever warranty is selected.
   */
  function baseVariantForCurrentOptions(product) {
    if (!product.variants) return null

    const currentId = currentVariantId()
    const current = product.variants.filter(function (v) {
      return String(v.id) === String(currentId)
    })[0] || product.variants[0]
    if (!current) return null

    const idx = feeOptionIndex(product)
    if (idx === -1) return current

    return product.variants.filter(function (v) {
      if (!isNoFee(v.options[idx])) return false
      for (let i = 0; i < v.options.length; i++) {
        if (i === idx) continue
        if (v.options[i] !== current.options[i]) return false
      }
      return true
    })[0] || null
  }

  /** Values a merchant might reasonably have typed for "no fee". */
  const NO_FEE_VALUES = ['none', '0', 'no fee', 'nofee', 'na', 'n/a', '-', '—', 'standard']

  const isNoFee = (value) =>
    NO_FEE_VALUES.indexOf(String(value == null ? '' : value).trim().toLowerCase()) !== -1

  /** The digits in an option value: "₹2,499" and "2499" both mean 2499. */
  function feeValueAmount(value) {
    if (isNoFee(value)) return 0
    const digits = String(value == null ? '' : value).replace(/[^0-9]/g, '')
    return digits ? Number(digits) : null
  }

  /**
   * Switch the product to the variant that carries this fee, keeping every
   * other option as the shopper left it.
   *
   * The warranty they picked is theirs to keep — choosing a number must not
   * quietly move them from Lifetime back to One Year. So only the fee option is
   * changed, and the match is made against the CURRENT variant's other options.
   *
   * Selecting is done by writing the id into the form and firing `change`,
   * which is the one contract every Shopify theme honours: that input is what
   * gets posted to /cart/add, and themes listen to it to reprice the page. It
   * needs no knowledge of this theme's variant picker.
   */
  function selectVariantForFee(feeInr) {
    const amount = Number(feeInr) || 0

    return productJson().then(function (product) {
      if (!product) return { mode: 'none' }
      const idx = feeOptionIndex(product)
      if (idx === -1) return { mode: 'fee-line' }

      const currentId = currentVariantId()
      const current = product.variants.filter(function (v) {
        return String(v.id) === String(currentId)
      })[0] || product.variants[0]

      const match = product.variants.filter(function (v) {
        if (feeValueAmount(v.options[idx]) !== amount) return false
        // Every other option has to match what the shopper already chose.
        for (let i = 0; i < v.options.length; i++) {
          if (i === idx) continue
          if (current && v.options[i] !== current.options[i]) return false
        }
        return true
      })[0]

      if (!match) {
        return {
          mode: 'variant',
          ok: false,
          amount: amount,
          // Named precisely, because the fix is a variant somebody has to create.
          missing: (current ? current.options.filter(function (_, i) { return i !== idx }).join(' / ') + ' / ' : '') +
            (amount === 0 ? CONFIG.feeNoneValue : String(amount)),
        }
      }

      applyVariant(match)
      return { mode: 'variant', ok: true, variant: match }
    })
  }

  /**
   * Write the variant into the form and tell the theme.
   *
   * Three notifications rather than one, because themes listen for different
   * things: a plain `change` on the id input, the same bubbling to the form,
   * and Shopify's own `variant:change` convention. Extra events a theme ignores
   * cost nothing; a missing one leaves the page showing the old price.
   */
  function applyVariant(variant) {
    const inputs = document.querySelectorAll(
      'form[action*="/cart/add"] [name="id"]',
    )
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]
      input.value = String(variant.id)
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    document.dispatchEvent(
      new CustomEvent('variant:change', { bubbles: true, detail: { variant: variant } }),
    )
  }

  /**
   * Write the serial onto the product form as hidden inputs.
   *
   * This is what lets the SHOP'S OWN Add to cart and Buy it now carry the
   * number. Shopify reads `properties[Name]` fields straight off the product
   * form, so the picker does not have to drive the cart at all — which is both
   * less code and a better fit, because the shopper presses the button the
   * theme designed rather than one this script invented.
   */
  /**
   * The properties currently owed to the form, kept so they can be restored.
   *
   * Selecting a variant makes the theme re-render its buy block, which replaces
   * the form and takes these hidden inputs with it — after they were written.
   * Without restoring them the shopper sees the right price, presses the shop's
   * own Add to cart, and the order arrives with no serial on it. Which is the
   * exact failure this whole system exists to prevent, arriving through the
   * back door.
   */
  let pendingProperties = null

  function injectProperties(properties) {
    if (properties) pendingProperties = properties
    const forms = document.querySelectorAll('form[action*="/cart/add"]')
    for (let f = 0; f < forms.length; f++) {
      const form = forms[f]
      // Clear ours first — re-picking must not leave the previous serial behind.
      const stale = form.querySelectorAll('[data-czard-prop]')
      for (let i = 0; i < stale.length; i++) stale[i].parentNode.removeChild(stale[i])

      for (const key in pendingProperties) {
        if (!Object.prototype.hasOwnProperty.call(pendingProperties, key)) continue
        const input = document.createElement('input')
        input.type = 'hidden'
        input.name = 'properties[' + key + ']'
        input.value = pendingProperties[key]
        input.setAttribute('data-czard-prop', '')
        form.appendChild(input)
      }
    }
  }

  /**
   * Enable or disable the shop's buy buttons.
   *
   * Only touches what it disabled itself — `data-czard-disabled` marks them —
   * so a button the theme disabled for its own reasons (sold out, unavailable
   * variant) is never enabled by this. Unconditional now: the two reasons a
   * caller might want the buttons shut (no number chosen, no warranty chosen)
   * are each other's business to decide, not this function's — see
   * refreshGates(), which is what every caller actually goes through.
   */
  function setBuyEnabled(enabled) {
    const buttons = document.querySelectorAll(
      'form[action*="/cart/add"] [type="submit"], form[action*="/cart/add"] [name="add"], .shopify-payment-button__button',
    )
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i]
      if (enabled) {
        if (b.hasAttribute('data-czard-disabled')) {
          b.disabled = false
          b.removeAttribute('data-czard-disabled')
        }
      } else if (!b.disabled) {
        b.disabled = true
        b.setAttribute('data-czard-disabled', '')
      }
    }
  }

  /** Enable or disable the picker's own "Buy now" button. */
  function setPickerButtonEnabled(enabled) {
    const button = document.querySelector('.czrd-btn')
    if (!button) return
    if (enabled) {
      if (button.hasAttribute('data-czard-disabled')) {
        button.disabled = false
        button.removeAttribute('data-czard-disabled')
        button.removeAttribute('title')
      }
    } else if (!button.disabled) {
      button.disabled = true
      button.setAttribute('data-czard-disabled', '')
      button.setAttribute('title', 'Choose a warranty first.')
    }
  }

  /** !requireNumber, or a number is already held for this product. */
  function numberSatisfied() {
    return !CONFIG.requireNumber || Boolean(currentHold())
  }

  /**
   * The one place both gates are combined. Every caller that used to reach
   * for setBuyEnabled() directly now calls this instead, so a shopper who has
   * chosen a number but not a warranty (or the other way round) is never
   * waved through on the strength of only one of the two conditions.
   *
   * The "Buy now" button is gated on the warranty alone — opening the
   * grid before a warranty is settled would show numbers priced against
   * whichever warranty happened to be selected by default, not one the
   * shopper actually chose. The shop's own buy buttons are gated on both.
   */
  function refreshGates() {
    setPickerButtonEnabled(state.warrantyChosen)
    setBuyEnabled(numberSatisfied() && state.warrantyChosen)
  }

  /**
   * The comparable core of a warranty value.
   *
   * The same choice is spelled three ways across the places this script has to
   * match it: "One Year Warranty" in the Shopify admin (the option value),
   * "1 Year" in the theme's own control (luxe-hero's warranty_options setting),
   * and whatever a merchant types into data-default-warranty. Lowercased,
   * with the numeral spelled out, punctuation dropped and a trailing
   * "warranty" trimmed, all three land on "oneyear" — and Lifetime on
   * "lifetime", which is the only thing it must not collide with.
   */
  function normalizeWarranty(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/\b1\b/g, 'one')
      .replace(/[^a-z0-9]/g, '')
      .replace(/warranty$/, '')
  }

  /**
   * Put the product on the variant a shopper should ARRIVE on, once, at boot.
   *
   * Two decisions, deliberately made in one pass rather than in two functions
   * that each call applyVariant(): on a product carrying both options they
   * would each move the variant, so the page would re-render twice at boot and
   * the second pass would be reasoning about a variant the first had just
   * changed underneath it. One target, computed from both rules, applied once.
   *
   * WARRANTY — One Year, the cheaper of the two. This is what replaced the old
   * "disabled until you touch it" gate. The problem that gate solved is real —
   * every number in the popup is priced against the CURRENTLY selected variant,
   * so a grid opened against the wrong warranty is a grid of wrong prices, off
   * by the ₹2,500 gap on every row. Its cost was that the page's main button
   * greeted every shopper dead, with a tooltip as the only explanation. So the
   * assumption is made rather than avoided, in the variant AND in the theme's
   * own control so the shopper can see which one they are being quoted.
   *
   * FEE — none. The price a shopper meets should be the watch with an ordinary
   * number on it, which is the price the shop advertises and the one every
   * premium in the popup is quoted as an addition to. Shopify's own default is
   * simply the first available variant, which on a fee-in-variant product can
   * be a Crown at +₹2,999 — a premium nobody asked for, on an option they
   * cannot see, since hideFeeOption() takes the selector off the page.
   *
   * Neither is a decision the shopper is stuck with: choosing a number moves
   * the fee itself (selectVariantForFee, which preserves the warranty), and the
   * warranty control is one click.
   *
   * Three things it deliberately does not do:
   *
   *   - It leaves the warranty alone when `requireWarranty` is on. That flag
   *     means "make them choose"; preselecting for them is the opposite
   *     instruction. The fee half still applies — nothing about that one is
   *     the shopper's to decide.
   *   - It stands down entirely on ?variant= in the URL. That is somebody
   *     arriving on a specific variant — a Lifetime link from an email, or a
   *     reload after choosing — and overriding it would be this script arguing
   *     with the shopper.
   *   - It never moves an option it was not asked about: the match is made
   *     against the current variant's other options first, exactly as
   *     selectVariantForFee() does.
   */
  /**
   * `force` is what "Buy Now" asks for, and it overrides the ?variant=
   * deference above — the FEE half of it, and only that half.
   *
   * That button's proposition is the lowest available number at no reservation
   * fee, so it insists on the fee-free variant even where this function would
   * otherwise stand aside. The fee is machinery: the selector is off the page
   * (hideFeeOption takes it away), so the premium it carries is never something
   * the shopper chose, and overriding it takes nothing from them.
   *
   * The WARRANTY is the opposite kind of thing, and forcing it was a real bug.
   * A shopper who clicked "Lifetime Warranty", watched the panel reprice to
   * ₹17,499 and then pressed "Buy Now" got a One Year watch in the cart at
   * ₹14,999 — the choice they had just made, reversed without a word by the
   * button that was supposed to act on it. So `force` no longer touches the
   * warranty at all: whatever is selected when the button is pressed is what
   * goes into the cart, which is also the figure standing next to the button.
   *
   * Only "Buy Now" passes it. An ordinary page load still leaves a Lifetime
   * link on Lifetime.
   */
  function applyDefaultVariant(options) {
    const force = Boolean(options && options.force)
    if (!force && /[?&]variant=/.test(window.location.search)) return Promise.resolve()

    return productJson().then(function (product) {
      if (!product || !product.variants) return

      const warrantyIdx =
        force || CONFIG.requireWarranty || !CONFIG.defaultWarranty
          ? -1
          : warrantyOptionIndex(product)
      const wantedWarranty = warrantyIdx === -1 ? '' : normalizeWarranty(CONFIG.defaultWarranty)
      const feeIdx = force || CONFIG.defaultFeeFree ? feeOptionIndex(product) : -1

      // Neither rule applies to this product — the Genève trio reaches here and
      // leaves untouched, which is the whole point of "if applicable".
      if (!wantedWarranty && feeIdx === -1) return

      const satisfied = function (variant) {
        if (wantedWarranty && normalizeWarranty(variant.options[warrantyIdx]) !== wantedWarranty) {
          return false
        }
        if (feeIdx !== -1 && !isNoFee(variant.options[feeIdx])) return false
        return true
      }

      const currentId = currentVariantId()
      const current = product.variants.filter(function (v) {
        return String(v.id) === String(currentId)
      })[0] || null

      // Already there — Shopify's first-available variant is usually One Year,
      // and often "None" as well. Still worth syncing the visible control,
      // because the theme renders its warranty choices from a section setting
      // rather than from the variant, and the two can disagree on a fresh load.
      if (current && satisfied(current)) {
        if (wantedWarranty) syncWarrantyControl(current.options[warrantyIdx])
        return
      }

      const candidates = product.variants.filter(function (v) {
        return satisfied(v) && v.available !== false
      })
      // No such variant in stock. Leaving the page as Shopify served it is the
      // only honest answer: the alternative is selecting something unbuyable
      // and handing the shopper a dead Add to cart.
      if (!candidates.length) return

      const match =
        candidates.filter(function (v) {
          if (!current) return false
          for (let i = 0; i < v.options.length; i++) {
            if (i === warrantyIdx || i === feeIdx) continue
            if (v.options[i] !== current.options[i]) return false
          }
          return true
        })[0] || candidates[0]

      if (wantedWarranty) syncWarrantyControl(match.options[warrantyIdx])
      applyVariant(match)
    })
  }

  /**
   * Tick the theme's own warranty control over to `value`.
   *
   * applyVariant() writes the id input, which is what the CART reads and what
   * most themes reprice from — but a control whose radios drive that input
   * rather than follow it would still be showing the other warranty, and a
   * shopper reading "Lifetime" while being charged for One Year has been
   * misled by exactly the thing that was supposed to help them.
   *
   * Matched on the input's value and its label text, both normalised, so the
   * theme's "1 Year" and the admin's "One Year Warranty" both land. Best
   * effort by design and silent when it finds nothing: the variant is already
   * correct by the time this is called, so the worst case is a control that
   * looks unchanged, not a wrong price.
   */
  function syncWarrantyControl(value) {
    const wanted = normalizeWarranty(value)
    if (!wanted) return

    let groups = findOptionGroups(CONFIG.warrantyOption)
    if (!groups.length) {
      groups = Array.prototype.slice.call(
        document.querySelectorAll('form[action*="/cart/add"]'),
      )
    }

    for (let g = 0; g < groups.length; g++) {
      const group = groups[g]

      const selects = group.querySelectorAll('select')
      for (let s = 0; s < selects.length; s++) {
        const select = selects[s]
        for (let o = 0; o < select.options.length; o++) {
          const option = select.options[o]
          if (normalizeWarranty(option.value) !== wanted &&
              normalizeWarranty(option.textContent) !== wanted) continue
          if (select.value === option.value) break
          select.value = option.value
          select.dispatchEvent(new Event('change', { bubbles: true }))
          select.dispatchEvent(new Event('input', { bubbles: true }))
          break
        }
      }

      const radios = group.querySelectorAll('input[type="radio"]')
      for (let r = 0; r < radios.length; r++) {
        const radio = radios[r]
        const label = radio.labels && radio.labels[0]
        if (normalizeWarranty(radio.value) !== wanted &&
            normalizeWarranty(label && label.textContent) !== wanted) continue
        if (radio.checked) break
        radio.checked = true
        radio.dispatchEvent(new Event('change', { bubbles: true }))
        radio.dispatchEvent(new Event('input', { bubbles: true }))
        break
      }

      /**
       * Button and swatch controls — which is what THIS storefront renders.
       *
       * luxe-product-buy draws each option value as a <button data-option-value>
       * and keeps the selection in a JS array of its own, reflecting it with a
       * class and aria-pressed. There is no input to write, so the two branches
       * above find nothing and the control sits there showing the warranty the
       * shopper is no longer on.
       *
       * Clicking is the only way in, and it is also the RIGHT way in: the
       * theme's own handler updates that private array as well as the styling,
       * so its next variant lookup starts from the truth rather than from the
       * selection it held before this script moved the variant. That click
       * writes the theme's own idea of the variant into the id input — with
       * the fee option back at "none", since its array never saw the fee
       * change — so every caller here applies the variant it actually wants
       * AFTER calling this, and has the last word.
       *
       * Skipped when the control already shows `wanted`, which is what stops a
       * sync from bouncing between the two values.
       */
      const buttons = group.querySelectorAll(
        'button, [role="radio"], [data-option-value]',
      )
      for (let b = 0; b < buttons.length; b++) {
        const button = buttons[b]
        if (button.tagName === 'INPUT' || button.tagName === 'SELECT') continue
        const value = button.getAttribute('data-option-value') || button.textContent
        if (normalizeWarranty(value) !== wanted) continue
        if (button.getAttribute('aria-pressed') === 'true' ||
            button.getAttribute('aria-checked') === 'true' ||
            button.classList.contains('is-active') ||
            button.classList.contains('is-selected') ||
            button.classList.contains('active')) break
        button.click()
        break
      }
    }
  }

  /* ---------------------------------------------------------------------
   * The cart follows the warranty
   *
   * Choosing a warranty and reserving a number are two separate acts, and
   * until now only one order of them worked. Reserve first, change your mind
   * about the warranty second, and the page repriced while the CART LINE
   * stayed exactly where it was — the shopper read "Lifetime Warranty
   * ₹17,499" above the button and checked out with a One Year watch at
   * ₹14,999, because a Shopify cart line IS a variant and nothing on the
   * product page updates it after the fact.
   *
   * So the line is moved to match. Not re-added from scratch: the number, its
   * hold token, its tier and the FEE its variant carries are all kept, because
   * none of them is what the shopper just changed.
   * ------------------------------------------------------------------ */

  /**
   * Guards the whole move, because everything inside it fires the very events
   * that trigger it: replaceCartLine dispatches cart:refresh, and applyVariant
   * dispatches change on the id input. The listeners ignore untrusted events
   * for the same reason — this is the belt to that pair of braces, and it
   * also collapses a shopper clicking both warranties in quick succession into
   * one move rather than two overlapping ones.
   *
   * ON THE DOCUMENT, not in this closure, because this file can be on a page
   * more than once. The live product page carries two of these script tags —
   * one from the luxe-hero section, one from the global snippet by the cart
   * drawer — and two <script src> elements with the same URL both execute.
   * Most of what they do is already idempotent or guarded by a marker in the
   * DOM (injectButton bails on an existing button, bindWarrantyGroup on an
   * existing data-czard-warranty-bound), but a cart WRITE is neither: two
   * instances reading the cart at the same moment would both see the old line,
   * both add its replacement, and the shopper would end up buying two watches.
   * An attribute on <html> is state the instances share; a `let` is not.
   *
   * A request arriving while the lock is held is not dropped — it is queued,
   * and the holder runs it again on the way out. That is the shopper clicking
   * the other warranty mid-move, and it must be the choice they end on.
   */
  const WARRANTY_SYNC_LOCK = 'data-czard-warranty-syncing'
  const WARRANTY_SYNC_QUEUED = 'data-czard-warranty-queued'

  /**
   * Move every reserved line for THIS product onto the warranty now selected.
   *
   * Scoped to this product's lines: a second watch of another reference has its
   * own warranty, chosen on its own page, and this control says nothing about
   * it. Scoped to lines carrying a Serial, so a reservation-fee line — a
   * different product, with no warranty at all — is left alone.
   */
  function syncCartWarranty() {
    const root = document.documentElement
    if (root.hasAttribute(WARRANTY_SYNC_LOCK)) {
      root.setAttribute(WARRANTY_SYNC_QUEUED, '')
      return Promise.resolve()
    }
    root.setAttribute(WARRANTY_SYNC_LOCK, '')

    return Promise.all([productJson(), cartState()])
      .then(function (both) {
        const product = both[0]
        const cart = both[1]
        if (!product || !product.variants || !cart || !cart.items) return

        const warrantyIdx = warrantyOptionIndex(product)
        if (warrantyIdx === -1) return

        const current = variantById(product, currentVariantId())
        if (!current) return
        const wanted = current.options[warrantyIdx]
        if (!normalizeWarranty(wanted)) return

        const held = currentHold()
        let chain = Promise.resolve()
        let pageTarget = null
        let moved = 0
        let blocked = false

        for (let i = 0; i < cart.items.length; i++) {
          const item = cart.items[i]
          if (String(item.product_id) !== String(CONFIG.productId)) continue

          const properties = item.properties || {}
          const serial = properties.Serial || properties.serial
          if (!serial) continue

          const on = variantById(product, item.variant_id)
          if (!on) continue
          if (normalizeWarranty(on.options[warrantyIdx]) === normalizeWarranty(wanted)) continue

          const target = siblingVariant(product, on, warrantyIdx, wanted)
          /**
           * No such variant, or it is sold out. The line stays where it is and
           * the page is put back onto it below: a cart the shopper cannot have
           * is worse than a warranty they cannot switch to, and letting the two
           * disagree silently is worse than either.
           */
          if (!target || target.available === false) {
            blocked = true
            continue
          }

          const line = {
            key: item.key,
            variant: String(item.variant_id),
            quantity: Number(item.quantity) || 1,
            display: serial,
          }
          // The line the page's own price should follow: the one whose number
          // this browser is holding, or failing that the first one moved.
          if (!pageTarget || (held && held.display === serial)) pageTarget = target
          moved++
          chain = chain.then(function () {
            return replaceCartLine(line, properties, String(target.id))
          })
        }

        if (!moved) {
          // Nothing could move, and something wanted to: put the control and
          // the variant back onto what the cart actually holds.
          if (blocked) return adoptCartWarranty()
          return
        }

        return chain.then(function () {
          /**
           * And the page follows the cart it has just rewritten.
           *
           * The theme's own control put the id input on the fee-free variant
           * when it was clicked (syncWarrantyControl's note says why), so
           * without this the panel prices a ₹2,999 Crown as an ordinary
           * number — right warranty, missing premium. Applying the line's
           * real variant puts the figure beside the button back onto the figure
           * in the cart.
           */
          if (pageTarget) applyVariant(pageTarget)
          refreshCartLineUi()
        })
      })
      .catch(function () {
        /**
         * A refused cart write leaves the line where it was —
         * replaceCartLine adds before it removes — so the honest end state
         * is the page agreeing with the cart, not an error the shopper has no
         * way to act on.
         */
        return adoptCartWarranty()
      })
      .then(function () {
        root.removeAttribute(WARRANTY_SYNC_LOCK)
        /**
         * Someone asked while we were busy. Their click is newer than the one
         * this pass acted on, so it gets its own pass rather than being the
         * choice that quietly did not take.
         *
         * This cannot spin: the only thing that queues a pass is a listener,
         * and both listeners ignore the untrusted events this function's own
         * work produces.
         */
        if (root.hasAttribute(WARRANTY_SYNC_QUEUED)) {
          root.removeAttribute(WARRANTY_SYNC_QUEUED)
          scheduleCartWarrantySync()
        }
      })
  }

  /**
   * The other direction, for the one case that is not a shopper changing their
   * mind: a page opening on a cart that already holds a number.
   *
   * boot() pins the variant to the default warranty, which is right for an
   * empty cart and wrong for a returning shopper — their Lifetime watch is
   * still in the cart while the page they came back to says One Year, and
   * anything they press on it (Add to cart, Buy it now) is quoted against the
   * wrong one. The cart is the authority here, because it holds a decision
   * already made; the page default is only an assumption.
   *
   * Reads the cart and moves the PAGE. It never writes to the cart, which is
   * what makes it safe to call at boot.
   */
  function adoptCartWarranty() {
    return Promise.all([productJson(), cartState()]).then(function (both) {
      const product = both[0]
      const cart = both[1]
      if (!product || !product.variants || !cart || !cart.items) return

      const warrantyIdx = warrantyOptionIndex(product)
      if (warrantyIdx === -1) return

      const current = variantById(product, currentVariantId())
      if (!current) return

      for (let i = 0; i < cart.items.length; i++) {
        const item = cart.items[i]
        if (String(item.product_id) !== String(CONFIG.productId)) continue

        const properties = item.properties || {}
        if (!(properties.Serial || properties.serial)) continue

        const on = variantById(product, item.variant_id)
        if (!on) continue

        const wanted = on.options[warrantyIdx]
        if (normalizeWarranty(current.options[warrantyIdx]) === normalizeWarranty(wanted)) return

        // The page keeps its own fee option — boot pins that to none on
        // purpose — and takes only the warranty from the cart.
        const target = siblingVariant(product, current, warrantyIdx, wanted)
        if (!target || target.available === false) return

        syncWarrantyControl(wanted)
        applyVariant(target)
        return
      }
    })
  }

  /**
   * Runs the move one turn AFTER the interaction that asked for it.
   *
   * The listeners fire on the capture phase, which is before the theme's own
   * handler has had the chance to move the variant — read the id input at
   * that moment and it still names the warranty the shopper has just left. A
   * timeout puts this after the whole event dispatch, so currentVariantId()
   * reads their choice rather than the one before it.
   */
  let cartWarrantySyncTimer = 0

  function scheduleCartWarrantySync() {
    window.clearTimeout(cartWarrantySyncTimer)
    cartWarrantySyncTimer = window.setTimeout(function () {
      syncCartWarranty()
    }, 0)
  }

  /**
   * Finds out, once per page load, whether THIS product even has a warranty
   * choice to make. Asynchronous — it is the same /products/<handle>.js fetch
   * feeOptionIndex() reads elsewhere, memoised by productJson() — so
   * state.warrantyChosen stays at its default of `true` (nothing gated) until
   * this resolves. On a product with no such option that default is also the
   * final answer, which is the whole point of "if applicable": nothing about
   * this gate exists for the Genève trio.
   */
  function initWarrantyGate() {
    if (!CONFIG.requireWarranty) return

    productJson().then(function (product) {
      if (warrantyOptionIndex(product) === -1) return

      state.warrantyChosen = false
      refreshGates()
      bindWarrantyGroup()
    })
  }

  /**
   * Attaches the "the shopper touched this" listener to the warranty option's
   * own DOM group, and does nothing once it already has one.
   *
   * Marked on the node itself (`data-czard-warranty-bound`) rather than in a
   * JS flag, because Shopify's Section Rendering API can replace that node
   * wholesale on a variant switch — the same reason hideFeeOption() and
   * injectButton() both re-run on every remount tick rather than once. A
   * stale JS flag would say "already bound" about a node that no longer
   * exists; the attribute only ever describes the node currently in the DOM.
   *
   * Bound on EVERY page now, not only a gated one. The gate was its first
   * reason to exist and is no longer its only one: syncCartWarranty needs to
   * know the moment a warranty is chosen, and on this storefront that moment
   * is a click on a <button> the theme owns, which reaches nothing else in
   * this file. A page with the gate off used to bind nothing at all, which is
   * exactly the page the warranty-vs-cart bug was reported on.
   *
   * Safe to call unconditionally (boot, and every remount tick): the bound
   * attribute short-circuits it, and a re-render that takes the node away
   * takes the attribute with it, so the next tick binds the new one.
   */
  function bindWarrantyGroup() {
    /**
     * Cheap enough for a mutation-observer tick, which is the point: one
     * attribute selector, rather than findOptionGroups walking every label,
     * legend, span, p, h3 and h4 in the document a hundred times a second
     * while the theme swaps a section in.
     */
    if (document.querySelector('[data-czard-warranty-bound]')) return

    let groups = findOptionGroups(CONFIG.warrantyOption)

    /**
     * The fallback that stops this gate ever becoming a trap.
     *
     * findOptionGroups matches on the option's visible LABEL text, and a theme
     * is under no obligation to render that text anywhere — it may show the
     * values as bare swatches, or label the group something the merchant never
     * typed into Shopify. When that happens there is no group to bind, so
     * nothing can ever set warrantyChosen, and the button stays disabled with
     * no action available to the shopper that would open it. A gate whose
     * condition cannot be satisfied is just a broken page.
     *
     * So: fall back to the product form itself. Every Shopify theme has one,
     * and its [name="id"] input is the thing that actually changes when a
     * variant is selected by ANY means — the very contract currentVariantId()
     * and applyVariant() already rely on. On these products Warranty is the
     * only option, so a variant change IS a warranty choice; on a product
     * with several options it is a slightly loose reading of "chose a
     * warranty", which is the right trade against locking the page.
     */
    if (!groups.length) {
      groups = Array.prototype.slice.call(
        document.querySelectorAll('form[action*="/cart/add"]'),
      )
    }

    /**
     * Nothing to bind to at all — no labelled group and no cart form. Rather
     * than leave the button disabled against a condition nothing on the page
     * can now satisfy, open the gate and let the shopper through. The cost of
     * failing open is a number chosen against a possibly-default warranty;
     * the cost of failing closed is a product that cannot be bought at all.
     */
    if (!groups.length) {
      if (!state.warrantyChosen) {
        state.warrantyChosen = true
        refreshGates()
      }
      return
    }

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]
      if (group.hasAttribute('data-czard-warranty-bound')) continue
      group.setAttribute('data-czard-warranty-bound', '')
      // Both events, capture phase — the same reasoning as applyVariant()'s
      // three notifications: a native radio/select fires change, a theme's
      // custom swatch/button picker may only ever fire click, and capturing
      // rather than bubbling means a theme that stops propagation inside the
      // group still lets this see the interaction on the way down.
      group.addEventListener('change', onWarrantyInteract, true)
      group.addEventListener('click', onWarrantyInteract, true)
    }
  }

  /**
   * A real click or change on the warranty control, and the two things that
   * follow from it: the gate opens, and the cart is brought onto the warranty
   * that was just chosen.
   *
   * `isTrusted` is what separates the shopper from this script. syncWarranty-
   * Control dispatches change and input on the theme's own inputs, and
   * applyVariant does the same on the id input; both would arrive here looking
   * exactly like a choice, and the second of them would send syncCartWarranty
   * back round the loop it had just finished. A synthetic event means some
   * code moved the control to match a decision already taken, which is never
   * itself a decision.
   */
  function onWarrantyInteract(event) {
    if (event && event.isTrusted === false) return

    if (!state.warrantyChosen) {
      state.warrantyChosen = true
      refreshGates()
    }

    scheduleCartWarrantySync()
  }

  /**
   * The same interaction, seen from the other end.
   *
   * A theme whose warranty control is a plain <select> or a set of radios
   * changes the id input itself, and on a shop with more than one way to pick
   * a variant (a sticky bar, a quick-view, a keyboard change on the select)
   * the click may never land inside the group bindWarrantyGroup found. The id
   * input is the one thing every one of those paths has to write, so a trusted
   * change on it is a warranty choice this file can rely on seeing.
   *
   * The theme this shop runs does NOT reach here — luxe-product-buy writes the
   * select and dispatches its own synthetic change, which is untrusted — so
   * the two hooks are not redundant, they cover the two shapes a variant
   * control comes in.
   */
  function watchVariantForWarranty() {
    document.addEventListener('change', function (event) {
      const target = event.target
      if (!target || target.name !== 'id') return
      if (event.isTrusted === false) return
      if (!target.closest || !target.closest('form[action*="/cart/add"]')) return
      scheduleCartWarrantySync()
    }, true)
  }

  /**
   * Hide the fee option from the page.
   *
   * The shopper does not choose a fee — they choose a number, and the number
   * decides. Leaving the selector visible invites them to pick ₹9,999 on a
   * ₹499 number, which the picker would then silently overwrite.
   *
   * Matched by the option's label text, because that is the one thing every
   * theme renders and this script knows. Best effort by design: a theme that
   * hides it some other way loses nothing, and `data-fee-option-selector`
   * overrides it outright.
   */
  function hideFeeOption() {
    const explicit = attr('data-fee-option-selector', '')
    if (explicit) {
      const nodes = document.querySelectorAll(explicit)
      for (let i = 0; i < nodes.length; i++) nodes[i].style.display = 'none'
      return
    }

    const groups = findOptionGroups(CONFIG.feeOption)
    for (let i = 0; i < groups.length; i++) groups[i].style.display = 'none'
  }

  /**
   * Every option-group container on the page whose label reads as `name`.
   *
   * Shared by hideFeeOption (which needs the Number Fees group) and the
   * warranty gate below (which needs the Warranty group) — both only know an
   * option by the name a merchant typed into the Shopify admin, and matching
   * on visible label text is the one thing every theme's markup agrees on,
   * whatever it names its classes. Returns every match rather than the first,
   * because a theme can render an option's label more than once (a summary
   * chip plus the control's own legend, say) and missing the real one for a
   * decorative echo would be silent and hard to notice.
   */
  function findOptionGroups(name) {
    const wanted = String(name).trim().toLowerCase()
    if (!wanted) return []

    const out = []
    const labels = document.querySelectorAll('label, legend, span, p, h3, h4')
    for (let i = 0; i < labels.length; i++) {
      const el = labels[i]
      if (el.children.length) continue
      if (String(el.textContent || '').trim().toLowerCase() !== wanted) continue

      const group = optionGroupFor(el)
      if (group && out.indexOf(group) === -1) out.push(group)
    }
    return out
  }

  /**
   * The smallest container holding this option's label AND its values.
   *
   * The previous version ended its selector list with a bare `div`, and
   * `closest('div')` is whatever div happens to be nearest — on markup without
   * one of the tighter hooks that is a page wrapper, so hiding it took the
   * price and the BUY BUTTON with it. The symptom is a shopper reserving a
   * number and then finding nothing to press.
   *
   * So the walk is bounded and every candidate is checked before it is hidden:
   * a container that holds a form, a buy button, a price or the picker's own
   * button is not an option group, whatever its class says. If nothing safe is
   * found, nothing is hidden — a visible fee selector is untidy, and an
   * invisible checkout is a broken shop.
   */
  function optionGroupFor(label) {
    const UNSAFE = [
      'form',
      '[type="submit"]',
      '[name="add"]',
      '.shopify-payment-button',
      '.czrd-btn',
      '[data-ld-buy]',
      '[data-ld-price]',
    ].join(',')

    let node = label.parentElement
    // Four levels is past any real label/values pairing and short of a wrapper.
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      if (node === document.body) break
      if (node.querySelector(UNSAFE)) break
      // It has to actually contain the option's values, or it is just the label.
      if (node.querySelectorAll('input, button, label, option, select').length > 0) {
        return node
      }
    }
    return null
  }

  /**
   * Discover the fee variants from Shopify, keyed by the amount they charge.
   *
   * Matching on price rather than on title is the whole point. A title is a
   * label somebody types — "499", "Rs 499", "Signature (Compass)" — and any of
   * those is a reasonable thing to write in an admin. The price is not a label,
   * it is the fee, so it is the only key that cannot be typed wrong: a variant
   * priced at ₹499 IS the ₹499 fee, whatever it is called.
   *
   * WHICH CURRENCY that price is in is the thing this had wrong. Shopify serves
   * /products/x.js in the shopper's PRESENTMENT currency, so on a US market the
   * variants come back priced in dollars while the lookup key was still the
   * rupee fee — and every VIP number in every market outside India failed to
   * find a variant and refused to go into the cart. The prices were never the
   * problem; the key was. So the map is keyed in whatever currency Shopify just
   * quoted, and looked up with the fee in that same currency, which the chart
   * has already worked out. Price is still the key. It is now a key with a
   * currency attached, which is what a price is.
   *
   * Memoised PER MARKET, because the amounts change when the market does and a
   * map cached from the shopper's last currency is a map of the wrong numbers.
   *
   * An explicit data-fee-variants map wins outright, for a shop that would
   * rather pin the ids — and on a multi-market shop that is the sturdier
   * arrangement, since ids do not move when a currency does.
   */
  let feeMapPromise = null
  let feeMapCurrency = null

  function feeVariantMap() {
    if (Object.keys(CONFIG.feeVariants).length) return Promise.resolve(CONFIG.feeVariants)
    if (feeMapPromise && feeMapCurrency === MARKET.code) return feeMapPromise
    if (!CONFIG.feeHandle) return Promise.resolve({})

    feeMapCurrency = MARKET.code
    feeMapPromise = fetch('/products/' + CONFIG.feeHandle + '.js', {
      headers: { Accept: 'application/json' },
    })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (product) {
        const map = {}
        if (!product || !product.variants) return map
        for (let i = 0; i < product.variants.length; i++) {
          const v = product.variants[i]
          const amount = majorUnits(v.price)
          if (amount > 0 && v.available !== false) map[String(amount)] = v.id
        }
        return map
      })
      .catch(function () { return {} })

    return feeMapPromise
  }

  /** `amount` is in the market's currency — see feeVariantMap above. */
  function attachFee(amount, serialDisplay) {
    const fee = Number(amount) || 0
    if (fee <= 0) return Promise.resolve(null)

    return feeVariantMap().then(function (map) {
      return addFeeLine(map[String(fee)], fee, serialDisplay)
    })
  }

  function addFeeLine(variant, amount, serialDisplay, quantity) {
    if (!variant) {
      return Promise.reject(
        new Error(
          'This number carries a ' + money(amount, MARKET.code) + ' reservation fee, but no fee variant is ' +
            'configured for that amount. Nothing has been added to your cart.',
        ),
      )
    }

    return fetch('../cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        items: [{
          id: String(variant),
          // One fee per watch, so two of the same reference need two. Defaults
          // to 1 for every existing caller.
          quantity: Math.max(1, Number(quantity) || 1),
          properties: {
            // Named so it reads correctly on the confirmation and the packing
            // slip, and so the fee line can be matched to the watch it belongs
            // to when an order is picked.
            'Reserved number': serialDisplay,
            _czard_fee_for: serialDisplay,
          },
        }],
      }),
    }).then(readCartResponse)
  }

  /**
   * Remove the reservation fees that no longer belong to anything, plus the one
   * for the number being given up.
   *
   * Two rules, and the first is why this is not simply "remove every fee line":
   *
   *   1. The fee for `replacingSerial` goes, because that number is being given
   *      up. Without this, re-picking leaves the previous fee behind and the
   *      shopper is charged twice — once for the Crown they changed their mind
   *      about and once for the one they chose.
   *
   *   2. A fee whose watch is no longer in the cart goes too — a ₹2,999 line
   *      attached to nothing, which is a charge for a watch they are not buying.
   *
   * Everything else stays, and THAT is the part that matters once there is more
   * than one watch in the cart. Clearing every fee line — what this did before —
   * is correct for one watch and silently wrong for two: reserving a Crown on a
   * second reference wiped the fee for the first, the shopper checked out paying
   * one premium instead of two, and the shortfall surfaced at orders/paid as
   * `assigned_underpaid`, after the money had moved.
   *
   * A fee line is recognised by its variant being one of the fee variants, and
   * the watch it belongs to by `_czard_fee_for` — the serial, written onto the
   * line when it was added, precisely so this question can be answered later.
   */
  function pruneFeeLines(replacingSerial) {
    return Promise.all([feeVariantMap(), cartState()]).then(function (both) {
      const map = both[0]
      const cart = both[1]
      if (!cart || !cart.items) return undefined

      const feeIds = Object.keys(map).map(function (k) { return String(map[k]) })
      if (!feeIds.length) return undefined

      const isFeeLine = function (item) {
        return feeIds.indexOf(String(item.variant_id)) !== -1
      }

      // Every serial that still has a watch behind it.
      const stillWanted = {}
      for (let i = 0; i < cart.items.length; i++) {
        const item = cart.items[i]
        if (isFeeLine(item)) continue
        const serial = (item.properties || {}).Serial
        if (serial) stillWanted[String(serial)] = true
      }

      return removeCartLines(
        cart.items.filter(function (item) {
          if (!isFeeLine(item)) return false
          const belongsTo = (item.properties || {})._czard_fee_for
          // A fee naming no watch belongs to no watch. Removing it declines
          // money nothing was owed for, which is the safe way to be wrong.
          if (!belongsTo) return true
          if (replacingSerial && String(belongsTo) === String(replacingSerial)) return true
          return !stillWanted[String(belongsTo)]
        }),
      )
    })
  }

  /**
   * The mirror of pruneFeeLines: put back a fee the shopper deleted.
   *
   * pruneFeeLines answers "this fee pays for a watch that is gone". This answers
   * the other direction, which is the one that costs money: the watch is still
   * in the cart, still carrying its VIP number, and the fee line beside it has
   * been removed. Shopify has no notion of one line requiring another, so the
   * cart is perfectly happy to check out a ₹2,999 Crown at the plain price. The
   * shortfall only surfaces at orders/paid as `assigned_underpaid` — after the
   * money has moved and the number is already theirs.
   *
   * Reconciled per serial rather than per product, because two watches of the
   * same reference are two lines with two different numbers and two different
   * premiums. A cart of three Crowns needs three fee lines, and matching on
   * product id would see one line and think it was covered.
   *
   * Ordinary numbers are skipped entirely: premium 0 means no fee line should
   * exist, and adding one would charge for something that is free.
   *
   * THIS IS A REPAIR, NOT A DEFENCE, and the difference matters.
   *
   * It runs in the shopper's browser, so anyone willing to edit their cart
   * outside the picker can still check out without the fee. Plain Shopify has
   * no way to make one line require another — that needs a Cart Transform
   * function, a draft order, or one variant per tier, which is the open item
   * recorded in docs/NUMBER-RESERVATION.md. Until one of those exists, the
   * authoritative check is `assigned_underpaid` at orders/paid: the order is
   * flagged, the shortfall is recorded, and it becomes a refund conversation
   * rather than a silent loss.
   *
   * What this fixes is the ordinary case, which is also the common one:
   * somebody tidying their cart, deleting a line they did not understand, and
   * being charged the wrong amount for it without either side noticing.
   */
  function ensureFeeLines() {
    return Promise.all([feeVariantMap(), cartState()]).then(function (both) {
      const map = both[0]
      const cart = both[1]
      if (!cart || !cart.items || !Object.keys(map).length) return undefined

      const feeIds = Object.keys(map).map(function (k) { return String(map[k]) })
      const isFeeLine = function (item) {
        return feeIds.indexOf(String(item.variant_id)) !== -1
      }

      // Which serials already have a fee line naming them.
      const covered = {}
      for (let i = 0; i < cart.items.length; i++) {
        const item = cart.items[i]
        if (!isFeeLine(item)) continue
        const belongsTo = (item.properties || {})._czard_fee_for
        if (belongsTo) covered[String(belongsTo)] = (covered[String(belongsTo)] || 0) + item.quantity
      }

      // Which serials are in the cart on a watch, and what each one owes.
      const owed = []
      for (let i = 0; i < cart.items.length; i++) {
        const item = cart.items[i]
        if (isFeeLine(item)) continue
        const props = item.properties || {}
        const serial = props.Serial
        if (!serial) continue

        const fee = Number(props._czard_fee || 0)
        if (!(fee > 0)) continue

        const need = item.quantity - (covered[String(serial)] || 0)
        if (need > 0) owed.push({ serial: String(serial), fee: fee, quantity: need })
      }

      if (!owed.length) return undefined

      // Sequentially, not in parallel: /cart/add.js against the same cart from
      // several requests at once is how a line lands twice or not at all.
      return owed.reduce(function (chain, row) {
        return chain.then(function () {
          return addFeeLine(map[String(row.fee)], row.fee, row.serial, row.quantity)
        })
      }, Promise.resolve())
    })
  }

  /**
   * Drop any earlier line for THIS product that carries a serial on a different
   * variant.
   *
   * Only reachable in variant mode, and only because the fee is part of the
   * variant there: picking a Crown after an ordinary number moves the shopper
   * from the "None" variant to the "2499" one, and attachToCart matches an
   * existing line by variant id — so the old line does not get updated, it gets
   * left behind. The shopper would check out with two watches, one of them
   * carrying a number they had already given up.
   *
   * Scoped to lines this picker wrote (`_czard_hold`) so a second watch the
   * shopper genuinely wants is never removed. Two different references are two
   * different product ids and are untouched by definition.
   */
  function clearStaleSerialLines(keepVariantId) {
    const keep = String(keepVariantId || '')

    return cartState().then(function (cart) {
      if (!cart || !cart.items) return undefined

      return removeCartLines(
        cart.items.filter(function (item) {
          const props = item.properties || {}
          if (!props._czard_hold) return false
          if (String(item.product_id) !== String(CONFIG.productId)) return false
          return String(item.variant_id) !== keep
        }),
      )
    })
  }

  /**
   * Drop these cart lines. Sequential rather than parallel: /cart/change.js
   * addresses a line by key, and keys shift as lines are removed.
   */
  function removeCartLines(lines) {
    if (!lines || !lines.length) return Promise.resolve(undefined)

    return lines.reduce(function (chain, item) {
      return chain.then(function () {
        return fetch('../cart/change.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ id: item.key, quantity: 0 }),
        })
      })
    }, Promise.resolve())
  }

  /**
   * Every serial this cart currently carries, as
   * [{ product, serial, holdToken }] — the exact shape /revalidate wants.
   *
   * Read from the cart rather than from localStorage on purpose: the cart is
   * what the shopper is about to check out with, and it may hold numbers picked
   * in another tab, or on another product, or before this browser cleared its
   * storage. Revalidating what we remember instead of what is actually in the
   * cart would let exactly those lines through unchecked.
   */
  function serialsInCart() {
    return cartState().then(function (cart) {
      if (!cart || !cart.items) return []
      const out = []

      for (let i = 0; i < cart.items.length; i++) {
        const item = cart.items[i]
        const props = item.properties || {}
        const serial = props.Serial || props.serial
        if (!serial) continue

        out.push({
          product: String(item.product_id),
          // The property is the display form (TC-0042); the API wants the
          // numeral. Everything after the last dash, digits only.
          serial: Number(String(serial).replace(/^.*-/, '').replace(/[^0-9]/g, '')),
          holdToken: props._czard_hold || null,
          display: serial,
          title: item.product_title || item.title || '',
          /**
           * The variant this number is on, and the band it came from — read for
           * the number tags, which have to be able to re-open the picker
           * against THIS line rather than against whatever the page currently
           * has selected. A second watch is routinely a different warranty from
           * the one showing on the page, and changing its number must not
           * quietly move it onto the page's variant.
           *
           * Ignored by /revalidate, like `title` and `key` beside them — it
           * reads the three fields it needs and leaves the rest.
           */
          variant: String(item.variant_id),
          tier: props._czard_tier || null,
          /**
           * Sent so the portal can refuse a line that names one number and asks
           * for three watches — the shopper typed 3 into the theme's own
           * quantity box, which this script never sees. Kept alongside the line
           * `key` so the refusal can offer to put it right in one press rather
           * than sending them off to find the cart.
           */
          quantity: Number(item.quantity) || 1,
          key: item.key,
        })
      }
      return out
    })
  }

  /* ---------------------------------------------------------------------
   * Styles
   * ------------------------------------------------------------------ */

  const CSS = [
    '.czrd-btn{display:inline-flex;align-items:center;justify-content:center;gap:.5em;',
    'width:100%;margin:.75rem 0;padding:.9em 1.2em;border:1px solid #000;background:#000;',
    'color:#fff;font:inherit;font-size:.95em;letter-spacing:.04em;text-transform:uppercase;',
    'cursor:pointer;border-radius:2px;transition:opacity .2s}',
    '.czrd-btn:hover{opacity:.85}',
    // The number is already spelled out in the label once one is held, so this
    // only firms the weight. It no longer changes the border: both states are
    // solid black now, and a border that appeared on one of them would read as
    // a different KIND of button rather than the same button further along.
    '.czrd-btn[data-has-serial="true"]{font-weight:600}',
    // Held shut by the warranty gate (or requireNumber). Matches the same
    // opacity/cursor language .czrd-cell[disabled] and .czrd-tier[disabled]
    // already use, rather than leaning on whatever the browser's UA
    // stylesheet does with a disabled button — which is inconsistent enough
    // across browsers that a shopper could read it as merely unstyled.
    '.czrd-btn[disabled]{opacity:.4;cursor:not-allowed}',
    '.czrd-btn[disabled]:hover{opacity:.4}',

    /**
     * Buy Now / Proceed to cart — the same geometry as the button
     * above it, in solid black.
     *
     * Solid where .czrd-btn is outlined, because they are not alternatives: one
     * chooses, one finishes, and two identical outlines stacked would read as a
     * choice between two ways of doing the same thing. Black rather than the
     * popup's amber so it does not compete with the picker's own primary action
     * inside the modal, and because a theme's own Buy it now is usually black —
     * this sits where a shopper already expects that control to be.
     *
     * `margin-top:-.25rem` closes the gap the two stacked buttons' margins would
     * otherwise leave, so the pair reads as one block rather than two controls
     * that happen to be near each other.
     */
    '.czrd-buy{display:inline-flex;align-items:center;justify-content:center;gap:.5em;',
    'width:100%;margin:-.25rem 0 .75rem;padding:.9em 1.2em;border:1px solid #000;background:#000;',
    'color:#fff;font:inherit;font-size:.95em;letter-spacing:.04em;text-transform:uppercase;',
    'cursor:pointer;border-radius:2px;transition:opacity .2s}',
    '.czrd-buy:hover{opacity:.85}',
    '.czrd-buy[disabled]{opacity:.4;cursor:not-allowed}',
    '.czrd-buy[disabled]:hover{opacity:.4}',

    /**
     * The popup's palette, declared once on the overlay so both surfaces that
     * use .czrd-modal — the picker and the checkout gate's refusal — inherit it,
     * and so nothing escapes into the theme's own cascade.
     *
     * These are the storefront's colours, not a second opinion about them: warm
     * amber, parchment cream, near-black brown. The picker is part of a brand
     * surface, not a piece of system UI. That is also why there is no
     * prefers-color-scheme arm — this used to invert under the operating
     * system's dark mode, so half the shoppers on the same page saw a black
     * panel over a cream site.
     *
     * The text ramp is cut for contrast rather than for mood: ink-soft is the
     * floor for anything under 13px (5:1 on cream), ink-mute is 13px and up
     * only, and ink-dim is reserved for disabled surfaces, which are exempt.
     * The palette this replaces put 9px labels at roughly 2:1.
     *
     * The DISPLAY face is asked for by name and allowed to fail: the storefront
     * already serves Cormorant Garamond, and a popup has no business adding a
     * third-party font request to a merchant's product page to get it. Where it
     * is absent the stack lands on Georgia, which is the same shape of answer.
     * Body copy stays on font:inherit — the theme's own face — throughout.
     */
    '.czrd-overlay{--czrd-cream:#EDE5D0;--czrd-card:#F4EFE2;--czrd-hover:#FBF8F0;--czrd-sunk:#E4DAC2;',
    '--czrd-ink:#1A1209;--czrd-ink-mid:#5C3E1E;--czrd-ink-soft:#7A5A32;--czrd-ink-mute:#8A6B42;',
    '--czrd-ink-dim:#A78D63;--czrd-line:rgba(90,55,15,.16);--czrd-line-mid:rgba(90,55,15,.28);',
    '--czrd-line-dark:rgba(90,55,15,.44);--czrd-amber:#B8822C;--czrd-amber-dark:#8A5E18;',
    '--czrd-held:#B06A12;--czrd-live:#3F7C50;',
    // The metals, as they appear on the CREAM furniture — the band rules
    // and the filter chips. The darker shadow stops these used to carry went
    // with the pale cards: on the dark surfaces the metal is struck from
    // brighter stops, declared inline where it is drawn.
    // Legacy is struck from a brighter highlight and a deeper base than the
    // Crown gold, so the two read as a hierarchy at swatch size rather than as
    // the same metal twice.
    '--czrd-lgc-hi:#FFF6D2;--czrd-lgc:#8A5A05;',
    '--czrd-gold-hi:#F5ECA0;--czrd-gold:#C8920A;',
    '--czrd-sil-hi:#E8E8E8;--czrd-sil:#9C9C9C;',
    '--czrd-rose-hi:#FFCFA0;--czrd-rose:#C07840;',

    /**
     * The premium surface — one brushed-gold plate, shared by all four named
     * bands.
     *
     * A Crown at ₹2,999 over the watch and an ordinary number at no charge were
     * the same cream rectangle with different coloured text, which is a price
     * list, not a case of watches. This is a metal: bronze at the top falling
     * to champagne at the bottom, the way a flat gold plate takes an overhead
     * light. The ordinary numbers stay cream and flat on purpose — the contrast
     * between the two is what makes the fifty-three worth paying for.
     *
     * The three tiers no longer carry three different metals. They are never
     * on screen beside each other — each band is its own section behind its own
     * sticky heading, which names the tier and states its fee — so a second and
     * third alloy bought nothing and cost the set its coherence.
     */
    '--czrd-metal:linear-gradient(180deg,#96734b 0%,#feddab 100%);',
    // Gone: the same plate with the light off it. Still a metal, just cold.
    '--czrd-metal-gone:linear-gradient(180deg,#6E6154 0%,#CFC5B4 100%);',
    /**
     * Engraved, not printed. Dark ink on the plate rather than metal-coloured
     * text on metal, which at these sizes is unreadable and reads as a sticker.
     *
     * Measured at the TOP of the gradient (#96734b), which is the darkest point
     * and where the largest text sits: the serial clears 3.8:1 against it, past
     * the 3:1 large-text bar, and everything smaller sits further down the plate
     * where the ground is lighter and the ratio climbs past 7:1.
     */
    '--czrd-on-metal:#2A1C0C;--czrd-on-metal-soft:#5C4522;--czrd-on-metal-dim:rgba(42,28,12,.42);',
    // Darker than the amber used on cream. The countdown sits at the foot of
    // the card, on the palest part of the plate, and the lighter brown that
    // reads fine against parchment came out at 4.44:1 there.
    '--czrd-on-metal-amber:#7A4205;',
    '--czrd-serif:"Cormorant Garamond",Cormorant,Georgia,"Times New Roman",serif;',
    'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;',
    'justify-content:center;padding:1rem;background:rgba(26,18,9,.68);backdrop-filter:blur(3px)}',

    '.czrd-modal{position:relative;display:flex;flex-direction:column;width:min(760px,100%);',
    'max-height:min(88vh,920px);background:var(--czrd-cream);color:var(--czrd-ink);border-radius:2px;',
    'border:1px solid var(--czrd-line-mid);overflow:hidden;',
    'box-shadow:0 24px 70px rgba(40,24,4,.45);font-family:inherit}',

    // Bottom sheet under 640px: a 500-number grid on a phone needs the height,
    // and a sheet anchored to the bottom keeps the confirm button under the
    // thumb rather than floating in the middle of the screen.
    '@media (max-width:639px){.czrd-overlay{padding:0;align-items:flex-end}',
    '.czrd-modal{width:100%;max-height:96vh;height:96vh;border-radius:0;border:0;',
    'border-top:1px solid var(--czrd-line-mid)}}',
    '.czrd-drag{width:38px;height:3px;margin:10px auto 0;border-radius:2px;',
    'background:var(--czrd-line-mid);flex-shrink:0}',
    '@media (min-width:640px){.czrd-drag{display:none}}',

    // The rule under the head belongs to the head, not to the toolbar below it:
    // the checkout gate's refusal reuses .czrd-head with no toolbar under it,
    // and would otherwise run its title straight into its body copy.
    '.czrd-head{position:relative;z-index:4;flex-shrink:0;padding:1rem 1.5rem .9rem;',
    'background:var(--czrd-cream);border-bottom:1px solid var(--czrd-line)}',
    '.czrd-eyebrow{margin:0 0 .35rem;font-size:.6rem;font-weight:500;letter-spacing:.28em;',
    'text-transform:uppercase;color:var(--czrd-ink-mute)}',
    '.czrd-title{margin:0;padding-right:2.5rem;font-family:var(--czrd-serif);font-size:2rem;',
    'font-weight:400;letter-spacing:.02em;line-height:1.08;color:var(--czrd-ink)}',
    '.czrd-delivery{margin:.55rem 0 0;padding:.4rem .6rem;font-size:.74rem;letter-spacing:.02em;',
    'color:var(--czrd-ink);background:rgba(181,138,95,.12);border-left:2px solid var(--czrd-gold);}',
    // The sold-out notice. Warm rather than red: this is not an error, it is a
    // reference that finished, and the sentence it carries is a redirection.
    '.czrd-gone{margin:.6rem 0 0;padding:.55rem .7rem;border-left:2px solid #7A5A32;',
    'background:rgba(122,90,50,.07);font-size:.74rem;line-height:1.45;color:var(--czrd-ink)}',
    '.czrd-gone b{font-weight:600}',
    // The grid stays readable underneath it. Every tile is already disabled by
    // the server projecting them as taken; this only stops the wall of them
    // reading as a fault.
    '.czrd-body[data-gone="true"]{opacity:.55}',
    '.czrd-sub{margin:.5rem 0 0;font-size:.72rem;letter-spacing:.02em;color:var(--czrd-ink-soft);',
    'line-height:1.5}',
    // Which watch this popup is about, when a number tag opened it. Boxed and
    // amber-ruled rather than set as another grey line under the title: it is
    // the difference between a pick that adds a number and a pick that replaces
    // one, and a shopper who misses it acts on the wrong watch.
    '.czrd-editing{margin:.65rem 0 0;padding:.45rem .6rem;font-size:.74rem;line-height:1.5;',
    'color:var(--czrd-ink-mid);background:var(--czrd-card);',
    'border-left:2px solid var(--czrd-amber)}',
    '.czrd-editing b{color:var(--czrd-ink);font-weight:600;font-variant-numeric:tabular-nums}',
    '.czrd-close{position:absolute;top:.85rem;right:1.1rem;width:2rem;height:2rem;',
    'border:1px solid var(--czrd-line-mid);background:transparent;color:var(--czrd-ink-soft);',
    'font-size:1.1rem;line-height:1;cursor:pointer;display:flex;align-items:center;',
    'justify-content:center;transition:background .18s,color .18s,border-color .18s}',
    '.czrd-close:hover{background:rgba(90,55,15,.09);color:var(--czrd-ink);',
    'border-color:var(--czrd-line-dark)}',

    '.czrd-engrave{display:flex;align-items:flex-start;gap:.5rem;margin:.7rem 0 0;font-size:.66rem;',
    'letter-spacing:.08em;text-transform:uppercase;color:var(--czrd-ink-soft);line-height:1.5}',
    '.czrd-engrave svg{flex-shrink:0;margin-top:1px}',

    /**
     * The toolbar. The old popup was a scroll and nothing else, which is a fair
     * answer for a chapter of fifty and not one for five hundred: a shopper who
     * came for 137 had to find it by eye. Search is the primary control, the
     * tier chips are the secondary one, and both sit outside .czrd-body so they
     * stay put while the grid moves under them.
     */
    '.czrd-tools{flex-shrink:0;position:relative;z-index:3;padding:.6rem 1.5rem .65rem;',
    'background:var(--czrd-sunk);border-bottom:1px solid var(--czrd-line)}',
    '.czrd-searchwrap{position:relative}',
    '.czrd-searchwrap>svg{position:absolute;left:.75rem;top:50%;transform:translateY(-50%);',
    'pointer-events:none}',
    '.czrd-search{width:100%;padding:.65rem 5.2rem .65rem 2.1rem;font:inherit;font-size:.82rem;',
    'letter-spacing:.02em;color:var(--czrd-ink);background:var(--czrd-card);border-radius:0;',
    'border:1px solid var(--czrd-line-mid);font-variant-numeric:tabular-nums;',
    '-webkit-appearance:none;appearance:none;transition:border-color .18s,box-shadow .18s}',
    '.czrd-search::placeholder{color:var(--czrd-ink-mute)}',
    '.czrd-search:focus{outline:0;border-color:var(--czrd-amber);',
    'box-shadow:0 0 0 2px rgba(184,130,44,.18)}',
    '.czrd-searchmeta{position:absolute;right:2.1rem;top:50%;transform:translateY(-50%);',
    'font-size:.62rem;letter-spacing:.08em;text-transform:uppercase;color:var(--czrd-ink-soft);',
    'pointer-events:none;font-variant-numeric:tabular-nums}',
    '.czrd-searchclear{position:absolute;right:.35rem;top:50%;transform:translateY(-50%);',
    'width:1.5rem;height:1.5rem;display:none;align-items:center;justify-content:center;border:0;',
    'background:transparent;color:var(--czrd-ink-soft);font:inherit;font-size:1rem;cursor:pointer}',
    '.czrd-searchclear:hover{color:var(--czrd-ink)}',
    '.czrd-searchwrap[data-filled="true"] .czrd-searchclear{display:flex}',

    /* The Customize Number button, beside the search box and again in the
     * empty state. Deliberately quieter than the primary CTA - it opens a
     * second choice, it does not commit to one. */
    '.czrd-custombtn{flex:0 0 auto;display:inline-flex;align-items:center;gap:.4rem;',
    'padding:.65rem 1rem;font:inherit;font-size:.62rem;letter-spacing:.14em;',
    'text-transform:uppercase;color:var(--czrd-ink);background:transparent;',
    'border:1px solid var(--czrd-line-mid);border-radius:0;cursor:pointer;',
    'transition:background .18s ease,border-color .18s ease;white-space:nowrap}',
    '.czrd-custombtn:hover{background:rgba(90,55,15,.07);border-color:var(--czrd-amber)}',
    '.czrd-custombtn:focus-visible{outline:2px solid var(--czrd-amber);outline-offset:2px}',

    /* The popup itself - a layer ABOVE the grid, inside the same modal so it
     * inherits the fonts and the colour variables. */
    '.czrd-custom{position:absolute;inset:0;z-index:5;display:none;',
    'background:var(--czrd-cream);flex-direction:column}',
    '.czrd-custom[data-open="true"]{display:flex}',
    '.czrd-customhead{position:relative;padding:1.4rem 1.5rem 1rem;',
    'border-bottom:1px solid var(--czrd-line)}',
    '.czrd-customhead h3{margin:0 0 .3rem;font-family:var(--czrd-serif);font-size:1.35rem;',
    'font-weight:400;color:var(--czrd-ink)}',
    '.czrd-customhead p{margin:0;font-size:.76rem;line-height:1.6;color:var(--czrd-ink-soft)}',
    '.czrd-customback{position:absolute;top:1rem;right:1.2rem;width:2rem;height:2rem;',
    'display:flex;align-items:center;justify-content:center;font-size:1.4rem;line-height:1;',
    'color:var(--czrd-ink-mute);background:transparent;border:0;cursor:pointer}',
    '.czrd-customback:hover{color:var(--czrd-ink)}',
    '.czrd-custombody{flex:1 1 auto;overflow-y:auto;padding:1.5rem}',

    /* The input. Big, centred and in the display face - it is the number
     * being bought, not a form field. */
    '.czrd-custominput{width:100%;padding:.9rem 1rem;text-align:center;',
    'font-family:var(--czrd-serif);font-size:2.4rem;letter-spacing:.22em;',
    'color:var(--czrd-ink);background:var(--czrd-card);',
    'border:1px solid var(--czrd-line-mid);border-radius:0;',
    'transition:border-color .18s ease,box-shadow .18s ease}',
    '.czrd-custominput::placeholder{color:var(--czrd-line-mid);letter-spacing:.22em}',
    '.czrd-custominput:focus{outline:0;border-color:var(--czrd-amber);',
    'box-shadow:0 0 0 3px rgba(138,107,66,.14)}',
    '.czrd-customhint{margin:.7rem 0 0;font-size:.7rem;line-height:1.6;',
    'text-align:center;color:var(--czrd-ink-mute)}',

    /* One status line, whose colour is the whole answer at a glance. */
    '.czrd-customsay{margin:1.1rem 0 0;min-height:1.2rem;font-size:.8rem;line-height:1.6;',
    'text-align:center;color:var(--czrd-ink-soft)}',
    '.czrd-customsay[data-tone="ok"]{color:#3F6B4A}',
    '.czrd-customsay[data-tone="bad"]{color:#8C3A32}',
    '.czrd-customsay[data-tone="busy"]{color:var(--czrd-ink-mute)}',

    /* The price block, shown only when the number can actually be had. */
    '.czrd-customprice{display:none;margin:1.2rem 0 0;padding:1rem 1.1rem;',
    'background:var(--czrd-card);border:1px solid var(--czrd-line)}',
    '.czrd-customprice[data-show="true"]{display:block}',
    '.czrd-customrow{display:flex;justify-content:space-between;gap:1rem;',
    'padding:.3rem 0;font-size:.78rem;color:var(--czrd-ink-soft)}',
    '.czrd-customrow--total{margin-top:.35rem;padding-top:.6rem;',
    'border-top:1px solid var(--czrd-line);font-size:.92rem;color:var(--czrd-ink)}',
    '.czrd-customrow--total b{font-weight:500}',

    /* Suggestions, when the one they wanted is gone. */
    '.czrd-customalt{display:none;margin:1.4rem 0 0}',
    '.czrd-customalt[data-show="true"]{display:block}',
    '.czrd-customalt>p{margin:0 0 .7rem;font-size:.62rem;letter-spacing:.14em;',
    'text-transform:uppercase;color:var(--czrd-ink-mute);text-align:center}',
    '.czrd-customalts{display:flex;flex-wrap:wrap;gap:.5rem;justify-content:center}',
    '.czrd-customalts button{padding:.55rem .9rem;font-family:var(--czrd-serif);',
    'font-size:1.05rem;letter-spacing:.1em;color:var(--czrd-ink);',
    'background:var(--czrd-hover);border:1px solid var(--czrd-line-mid);',
    'border-radius:0;cursor:pointer;transition:border-color .18s ease,background .18s ease}',
    '.czrd-customalts button:hover{background:rgba(90,55,15,.07);',
    'border-color:var(--czrd-amber)}',

    '.czrd-customfoot{flex:0 0 auto;padding:1rem 1.5rem 1.4rem;',
    'border-top:1px solid var(--czrd-line-mid);background:var(--czrd-cream)}',

    '.czrd-chips{display:flex;align-items:center;gap:.35rem;margin-top:.55rem;overflow-x:auto;',
    'scrollbar-width:none;-webkit-overflow-scrolling:touch}',
    '.czrd-chips::-webkit-scrollbar{display:none}',
    '.czrd-chip{flex-shrink:0;display:inline-flex;align-items:center;gap:.4rem;padding:.42rem .7rem;',
    'font:inherit;font-size:.6rem;font-weight:500;letter-spacing:.16em;text-transform:uppercase;',
    'color:var(--czrd-ink-soft);background:transparent;border:1px solid var(--czrd-line-mid);',
    'border-radius:0;cursor:pointer;white-space:nowrap;transition:background .18s,color .18s,border-color .18s}',
    '.czrd-chip:hover{border-color:var(--czrd-line-dark);color:var(--czrd-ink)}',
    '.czrd-chip[aria-pressed="true"]{background:var(--czrd-ink);border-color:var(--czrd-ink);',
    'color:var(--czrd-cream)}',
    '.czrd-chipn{font-size:.6rem;letter-spacing:.04em;color:var(--czrd-ink-mute);',
    'font-variant-numeric:tabular-nums}',
    '.czrd-chip[aria-pressed="true"] .czrd-chipn{color:rgba(237,229,208,.65)}',
    // Base colour as well as per-tier, so a chapter carrying a band this file
    // has no swatch for still gets a mark rather than a 6px hole.
    '.czrd-chipmark{width:6px;height:6px;flex-shrink:0;background:var(--czrd-ink-dim)}',
    '.czrd-chipmark--legacy{background:linear-gradient(135deg,var(--czrd-lgc-hi),var(--czrd-lgc))}',
    '.czrd-chipmark--crown{background:linear-gradient(135deg,var(--czrd-gold-hi),var(--czrd-gold))}',
    '.czrd-chipmark--icon{background:linear-gradient(135deg,var(--czrd-sil-hi),var(--czrd-sil))}',
    '.czrd-chipmark--signature{background:linear-gradient(135deg,var(--czrd-rose-hi),var(--czrd-rose))}',
    '.czrd-chipmark--other{background:var(--czrd-ink-dim)}',
    '.czrd-chip--avail{margin-left:auto}',

    '.czrd-body{padding:0 1.5rem 1rem;overflow-y:auto;overflow-x:hidden;flex:1;',
    'min-height:0;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;',
    'scroll-behavior:smooth}',
    '.czrd-body::-webkit-scrollbar{width:4px}',
    '.czrd-body::-webkit-scrollbar-thumb{background:rgba(90,55,15,.22)}',

    '.czrd-tiergroup{padding-bottom:1.4rem}',
    '.czrd-tiergroup[hidden]{display:none}',

    /**
     * The band heading sticks. A shopper four rows into the Icons should not
     * have to scroll back up to be reminded what an Icon costs — the fee and
     * the remaining count are the two facts they are deciding on, so they
     * travel with the band. The gradient tail lets the cards pass under it
     * without a hard seam.
     */
    '.czrd-tierhead{position:sticky;top:0;z-index:2;display:flex;align-items:stretch;gap:.7rem;',
    'padding:.85rem 0 .6rem;background:linear-gradient(var(--czrd-cream) 78%,rgba(237,229,208,0))}',
    '.czrd-tierrule{width:3px;flex-shrink:0;min-height:1.9rem}',
    '.czrd-tierrule--legacy{background:linear-gradient(180deg,var(--czrd-lgc-hi),var(--czrd-lgc))}',
    '.czrd-tierrule--crown{background:linear-gradient(180deg,var(--czrd-gold-hi),var(--czrd-gold))}',
    '.czrd-tierrule--icon{background:linear-gradient(180deg,var(--czrd-sil-hi),var(--czrd-sil))}',
    '.czrd-tierrule--signature{background:linear-gradient(180deg,var(--czrd-rose-hi),var(--czrd-rose))}',
    '.czrd-tierrule--other{background:var(--czrd-line-dark)}',
    '.czrd-tierlabels{flex:1;min-width:0}',
    // Block, because it is a span carrying a block child — the note below it —
    // and an inline box around a block one is at the browser's discretion.
    '.czrd-label{display:block;margin:0;font-size:.62rem;font-weight:600;letter-spacing:.24em;',
    'text-transform:uppercase;color:var(--czrd-ink)}',
    '.czrd-label__note{display:block;margin-top:.15rem;font-size:.7rem;font-weight:400;',
    'letter-spacing:.02em;text-transform:none;color:var(--czrd-ink-soft);line-height:1.4}',

    /**
     * Fewer, larger, further apart.
     *
     * These were four and five to a row at a .5rem gap, which is a contact
     * sheet — the eye reads it as a block of texture and stops seeing
     * individual cards. Three up at most, with real air between them, is what
     * lets each one be an object. The Crowns get the most room of all: they are
     * the most expensive decision on the screen.
     */
    '.czrd-band{display:grid;grid-template-columns:repeat(2,1fr);gap:.7rem}',
    '@media (min-width:440px){.czrd-band{grid-template-columns:repeat(3,1fr);gap:.8rem}}',
    '@media (min-width:640px){.czrd-band{grid-template-columns:repeat(4,1fr);gap:.9rem}',
    '.czrd-band--legacy,.czrd-band--crown{grid-template-columns:repeat(3,1fr)}}',

    '.czrd-tier{position:relative;display:flex;flex-direction:column;align-items:center;',
    'gap:0;padding:1.5rem .8rem 1.25rem;border:1px solid var(--czrd-line);border-radius:0;',
    'background:var(--czrd-card);color:inherit;font:inherit;text-align:center;cursor:pointer;',
    'overflow:hidden;-webkit-tap-highlight-color:transparent;',
    'transition:border-color .2s,transform .26s cubic-bezier(.34,1.4,.64,1),box-shadow .26s}',
    '.czrd-tier[hidden],.czrd-cell[hidden]{display:none}',

    /**
     * The plate. Two edges and no box: a lit hairline along the top, where an
     * overhead light would catch a milled edge, and a dark one along the bottom
     * where the card meets what it is standing on. A rule all the way round
     * framed the metal instead of letting it sit on the cream.
     */
    '.czrd-tier--legacy,.czrd-tier--crown,.czrd-tier--icon,.czrd-tier--signature{',
    'background:var(--czrd-metal);',
    'border:0;border-bottom:1px solid rgba(42,28,12,.3);',
    'box-shadow:inset 0 1px 0 rgba(255,255,255,.42)}',

    // The sheen. A polished surface answers a cursor moving across it, and that
    // is the difference between a gradient and a metal. Only on the premium
    // tiles — there is nothing to polish on a cream cell.
    '.czrd-tier--legacy:after,.czrd-tier--crown:after,.czrd-tier--icon:after,',
    '.czrd-tier--signature:after{content:"";',
    'position:absolute;top:0;left:-90%;width:55%;height:100%;pointer-events:none;',
    'transform:skewX(-20deg);transition:left .85s ease;',
    'background:linear-gradient(105deg,transparent 20%,rgba(255,255,255,.45) 50%,transparent 80%)}',
    '.czrd-tier:not([disabled]):hover:after{left:150%}',

    /**
     * The number, engraved rather than printed.
     *
     * Metal-coloured text on a metal ground is the obvious move and the wrong
     * one — it is barely legible and reads as a decal. Cut into the plate in
     * dark ink, with a single white hairline under the glyph, is what an
     * engraving actually looks like, and it holds its contrast at every point
     * of the gradient.
     *
     * Weight 400: Fitzgerald at this size does not want bolding, and asking for
     * 500 against a family that ships 400 and 700 invites a synthetic in
     * between on the browsers that oblige.
     */
    '.czrd-tier-serial{position:relative;z-index:1;font-family:var(--czrd-serif);font-size:1.75rem;',
    'font-weight:400;line-height:1;letter-spacing:.06em;font-variant-numeric:tabular-nums;',
    'color:var(--czrd-on-metal);text-shadow:0 1px 0 rgba(255,255,255,.38)}',

    '.czrd-tierhr{position:relative;z-index:1;width:30px;height:1px;margin:.9rem 0 .75rem;',
    'background:var(--czrd-line-mid)}',
    '.czrd-tier--legacy .czrd-tierhr,.czrd-tier--crown .czrd-tierhr,',
    '.czrd-tier--icon .czrd-tierhr,.czrd-tier--signature .czrd-tierhr{',
    'background:linear-gradient(90deg,transparent,rgba(42,28,12,.32),transparent)}',

    '.czrd-tier-price{position:relative;z-index:1;font-size:.88rem;font-weight:500;',
    'letter-spacing:.01em;color:var(--czrd-ink);font-variant-numeric:tabular-nums}',
    '.czrd-tier-fee{position:relative;z-index:1;margin-top:.3rem;font-size:.63rem;',
    'letter-spacing:.05em;color:var(--czrd-ink-soft);font-variant-numeric:tabular-nums}',
    '.czrd-tier-meta{position:relative;z-index:1;display:block;margin-top:.7rem;font-size:.6rem;',
    'font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--czrd-ink-dim);',
    'font-variant-numeric:tabular-nums}',
    // On the plate the ink ramp is the engraved one.
    '.czrd-tier--legacy .czrd-tier-price,.czrd-tier--crown .czrd-tier-price,',
    '.czrd-tier--icon .czrd-tier-price,',
    '.czrd-tier--signature .czrd-tier-price{color:var(--czrd-on-metal)}',
    '.czrd-tier--legacy .czrd-tier-fee,',
    '.czrd-tier--crown .czrd-tier-fee,.czrd-tier--icon .czrd-tier-fee,',
    '.czrd-tier--signature .czrd-tier-fee{color:var(--czrd-on-metal-soft)}',
    '.czrd-tier--legacy .czrd-tier-meta,',
    '.czrd-tier--crown .czrd-tier-meta,.czrd-tier--icon .czrd-tier-meta,',
    '.czrd-tier--signature .czrd-tier-meta{color:var(--czrd-on-metal-dim)}',
    '.czrd-tier[data-status="reserved"] .czrd-tier-meta{color:var(--czrd-held)}',
    '.czrd-tier--legacy[data-status="reserved"] .czrd-tier-meta,',
    '.czrd-tier--crown[data-status="reserved"] .czrd-tier-meta,',
    '.czrd-tier--icon[data-status="reserved"] .czrd-tier-meta,',
    '.czrd-tier--signature[data-status="reserved"] .czrd-tier-meta{color:var(--czrd-on-metal-amber)}',

    // The lift alone, with no cast shadow under it. The top highlight brightens
    // instead — the card catches more light as it rises, which is the same
    // information without putting a grey smudge on the parchment.
    '.czrd-tier:not([disabled]):hover{transform:translateY(-4px);',
    'box-shadow:inset 0 1px 0 rgba(255,255,255,.62)}',

    // The chosen one. The tick is the confirmation and the ring is the
    // emphasis; the card keeps its own colours rather than inverting, so a
    // selected Crown still reads as a Crown.
    '.czrd-tiercheck{position:absolute;top:9px;left:9px;z-index:2;width:17px;height:17px;',
    'display:flex;align-items:center;justify-content:center;font-size:.58rem;line-height:1;',
    'border:1px solid currentColor;opacity:0;transform:scale(.4);',
    'color:var(--czrd-on-metal);',
    'transition:opacity .2s,transform .22s cubic-bezier(.34,1.4,.64,1)}',
    '.czrd-tier[aria-pressed="true"] .czrd-tiercheck{opacity:1;transform:scale(1)}',

    /**
     * Chosen. A single ink rule, drawn as a shadow rather than a border so the
     * card does not change size when it is picked — and so it is the only edge
     * the design draws, on the one card that has earned one.
     *
     * No cast shadow here either, for the same reason as hover. The ring is the
     * state; a drop shadow underneath it would be a second, softer way of
     * saying the same thing.
     */
    // The bottom edge goes to ink with it, so the ring closes rather than
    // running alongside a second, paler line for its bottom quarter.
    '.czrd-tier[aria-pressed="true"]{transform:translateY(-4px);',
    'border-bottom-color:var(--czrd-ink);',
    'box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 0 0 1px var(--czrd-ink)}',

    /**
     * Five hundred numbers is a long scroll, so the ordinary grid is cut into
     * hundred-blocks with a rail that jumps between them and tracks where you
     * are. Sticky under the band heading rather than at the top of the body,
     * so both stay readable at once.
     */
    '.czrd-rail{position:sticky;top:3.4rem;z-index:2;display:flex;gap:.3rem;padding:.15rem 0 .7rem;',
    'overflow-x:auto;scrollbar-width:none;',
    'background:linear-gradient(var(--czrd-cream) 72%,rgba(237,229,208,0))}',
    '.czrd-rail::-webkit-scrollbar{display:none}',
    '.czrd-rail button{flex-shrink:0;padding:.35rem .55rem;font:inherit;font-size:.6rem;',
    'font-weight:500;letter-spacing:.12em;color:var(--czrd-ink-soft);background:var(--czrd-card);',
    'border:1px solid var(--czrd-line);border-radius:0;cursor:pointer;',
    'font-variant-numeric:tabular-nums;transition:background .18s,color .18s,border-color .18s}',
    '.czrd-rail button:hover{border-color:var(--czrd-line-dark);color:var(--czrd-ink)}',
    '.czrd-rail button[aria-current="true"]{background:var(--czrd-ink);border-color:var(--czrd-ink);',
    'color:var(--czrd-cream)}',
    '.czrd-block[hidden]{display:none}',
    '.czrd-blockhead{display:flex;align-items:center;gap:.6rem;margin:.8rem 0 .5rem;',
    'font-size:.58rem;font-weight:500;letter-spacing:.2em;text-transform:uppercase;',
    'color:var(--czrd-ink-mute);font-variant-numeric:tabular-nums}',
    '.czrd-blockhead:after{content:"";flex:1;height:1px;background:var(--czrd-line)}',
    '.czrd-block:first-child .czrd-blockhead{margin-top:0}',

    '.czrd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(62px,1fr));gap:.35rem}',
    '.czrd-cell{display:flex;flex-direction:column;align-items:center;justify-content:center;',
    'gap:.1rem;min-height:52px;padding:.45rem .2rem;border:1px solid var(--czrd-line);',
    'border-radius:0;background:var(--czrd-card);color:inherit;font:inherit;',
    'font-variant-numeric:tabular-nums;cursor:pointer;overflow:hidden;',
    '-webkit-tap-highlight-color:transparent;',
    'transition:border-color .18s,background .18s,transform .22s cubic-bezier(.34,1.4,.64,1),box-shadow .22s}',
    '.czrd-cell:not([disabled]):hover{border-color:rgba(160,110,20,.55);background:var(--czrd-hover);',
    'transform:translateY(-2px);box-shadow:0 4px 14px rgba(130,85,0,.1)}',
    '.czrd-cell-n{display:block;font-family:var(--czrd-serif);font-size:.95rem;font-weight:500;',
    'letter-spacing:.03em;color:var(--czrd-ink-mid)}',
    '.czrd-cell-meta{display:block;font-size:.55rem;letter-spacing:.06em;color:var(--czrd-ink-soft)}',
    '.czrd-cell[data-status="reserved"] .czrd-cell-meta{color:var(--czrd-held);font-weight:500}',
    '.czrd-cell[aria-pressed="true"]{background:#FFF8E6;border-color:var(--czrd-amber);',
    'box-shadow:0 0 0 1px var(--czrd-amber);transform:translateY(-2px)}',
    '.czrd-cell[aria-pressed="true"] .czrd-cell-n,',
    '.czrd-cell[aria-pressed="true"] .czrd-cell-meta{color:var(--czrd-amber-dark)}',

    /**
     * Gone, in the two ways a number can be gone.
     *
     * Sold and withheld are permanent, so they are hatched out of the surface
     * and read as part of the background. Reserved is somebody else's twelve
     * minutes — a dashed amber edge and a running clock, because it is coming
     * back and the shopper can wait for it or queue for it. The old popup drew
     * both as the same faded strikethrough, which told a shopper willing to
     * wait six minutes exactly nothing.
     */
    '.czrd-cell[disabled],.czrd-tier[disabled]{cursor:not-allowed;box-shadow:none}',

    // ── Sold and withheld, on the cream grid: hatched into the background.
    '.czrd-cell[data-status="taken"],.czrd-cell[data-status="withheld"]{',
    'background:repeating-linear-gradient(135deg,transparent 0 5px,rgba(90,55,15,.055) 5px 6px),var(--czrd-sunk);',
    'border-color:var(--czrd-line)}',
    '.czrd-cell[data-status="taken"] .czrd-cell-n,.czrd-cell[data-status="withheld"] .czrd-cell-n,',
    '.czrd-cell[data-status="taken"] .czrd-cell-meta,.czrd-cell[data-status="withheld"] .czrd-cell-meta{',
    'color:var(--czrd-ink-dim)}',

    /**
     * ── Sold and withheld, on a premium card: the gold goes out of it.
     *
     * The card keeps its shape and its light and loses its colour — the same
     * plate in cold grey, hatched over. This is the state that has to be
     * legible at a glance across a band of nine, and a card that merely dimmed
     * still read as gold from the other side of the grid.
     */
    '.czrd-tier[data-status="taken"],.czrd-tier[data-status="withheld"]{',
    'background:repeating-linear-gradient(135deg,transparent 0 5px,rgba(42,28,12,.05) 5px 6px),var(--czrd-metal-gone);',
    // The lit top edge goes; the bottom one stays but fades back, so the card
    // keeps its footing without keeping its light.
    'border:0;border-bottom:1px solid rgba(42,28,12,.14);box-shadow:none}',
    '.czrd-tier[data-status="taken"] .czrd-tier-serial,.czrd-tier[data-status="withheld"] .czrd-tier-serial,',
    '.czrd-tier[data-status="taken"] .czrd-tier-price,.czrd-tier[data-status="withheld"] .czrd-tier-price,',
    '.czrd-tier[data-status="taken"] .czrd-tier-fee,.czrd-tier[data-status="withheld"] .czrd-tier-fee,',
    '.czrd-tier[data-status="taken"] .czrd-tier-meta,.czrd-tier[data-status="withheld"] .czrd-tier-meta{',
    'color:var(--czrd-on-metal-dim);text-shadow:none}',
    '.czrd-tier[data-status="taken"] .czrd-tierhr,',
    '.czrd-tier[data-status="withheld"] .czrd-tierhr{background:rgba(42,28,12,.16)}',

    // ── In someone else's checkout: still gold, because it is coming back.
    '.czrd-cell[data-status="reserved"]{border-style:dashed;',
    'border-color:rgba(176,106,18,.45);background:var(--czrd-card)}',
    '.czrd-cell[data-status="reserved"] .czrd-cell-n{color:var(--czrd-ink-mute)}',
    // No dashed edge here now that the premium cards carry no border. The
    // state is still said twice: the number fades back, and the countdown
    // underneath it runs in amber — which is more than the cream cells get.
    //
    // The lit top edge is put BACK, because .czrd-tier[disabled] above strips
    // every shadow and a reserved card is not a sold one: it is coming back, so
    // it is still live metal. Same specificity as that rule and later in the
    // sheet, which is what lets it win.
    '.czrd-tier[data-status="reserved"]{box-shadow:inset 0 1px 0 rgba(255,255,255,.42)}',
    '.czrd-tier[data-status="reserved"] .czrd-tier-serial{opacity:.42}',

    '.czrd-empty{display:none;padding:3rem 1rem 3.5rem;text-align:center}',
    '.czrd-empty[data-show="true"]{display:block}',
    '.czrd-empty h3{margin:0 0 .35rem;font-family:var(--czrd-serif);font-size:1.35rem;',
    'font-weight:400;color:var(--czrd-ink)}',
    '.czrd-empty p{margin:0;font-size:.78rem;line-height:1.6;color:var(--czrd-ink-soft)}',
    '.czrd-empty button{margin-top:1rem;padding:.6rem 1.1rem;font:inherit;font-size:.62rem;',
    'font-weight:500;letter-spacing:.16em;text-transform:uppercase;color:var(--czrd-ink);',
    'background:transparent;border:1px solid var(--czrd-line-dark);border-radius:0;cursor:pointer}',
    '.czrd-empty button:hover{background:rgba(90,55,15,.07)}',

    // Row-wrapping rather than a fixed column, because the checkout gate's
    // refusal overlay reuses this footer with nothing in it but a status line
    // and one button. The picker's own children opt into a full row each.
    '.czrd-foot{position:relative;z-index:4;flex-shrink:0;display:flex;flex-wrap:wrap;',
    'align-items:center;justify-content:space-between;gap:.6rem 1rem;',
    'padding:.75rem 1.5rem calc(.85rem + env(safe-area-inset-bottom));',
    'background:var(--czrd-cream);border-top:1px solid var(--czrd-line-mid);',
    'box-shadow:0 -8px 24px rgba(60,35,5,.06)}',
    '.czrd-status{flex:1 1 12rem;min-width:0;margin:0;font-size:.74rem;line-height:1.45;',
    'color:var(--czrd-ink-soft)}',
    // Empty most of the time, and an empty flex item still claims a row's worth
    // of gap above the confirm button.
    '.czrd-status:empty{display:none}',
    '.czrd-status[data-tone="error"]{color:#8C2F14;font-weight:600}',
    '.czrd-cta{padding:.85em 1.6em;border:1px solid var(--czrd-ink);border-radius:0;',
    'background:var(--czrd-ink);color:var(--czrd-cream);font:inherit;font-size:.7rem;',
    'font-weight:500;letter-spacing:.22em;text-transform:uppercase;cursor:pointer;',
    'transition:background .2s,border-color .2s,transform .18s,box-shadow .2s}',
    '.czrd-cta:not([disabled]):hover{background:var(--czrd-amber-dark);',
    'border-color:var(--czrd-amber-dark);transform:translateY(-1px);',
    'box-shadow:0 6px 20px rgba(90,55,15,.28)}',
    '.czrd-cta:not([disabled]):active{transform:scale(.99);box-shadow:none}',
    '.czrd-cta[disabled]{background:transparent;border-color:var(--czrd-line-mid);',
    'color:var(--czrd-ink-mute);cursor:not-allowed}',
    // The picker's confirm is the only action in its footer, so it takes the
    // whole width. The gate's stays inline beside its sentence.
    '.czrd-cta--block{flex:1 0 100%;width:100%}',

    /**
     * The selection summary states the watch and the reservation fee as two
     * figures and then totals them, because that is how they will be charged —
     * one cart line each. The popup used to show the split only in the status
     * sentence, where it competed with error copy for the same line and was the
     * first thing overwritten.
     */
    '.czrd-summary{flex:1 0 100%;display:none;padding:.7rem .8rem;background:var(--czrd-card);',
    'border:1px solid var(--czrd-line-mid)}',
    '.czrd-summary[data-show="true"]{display:block}',
    '.czrd-sumtop{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem}',
    '.czrd-sumtag{margin:0 0 .2rem;font-size:.55rem;font-weight:500;letter-spacing:.22em;',
    'text-transform:uppercase;color:var(--czrd-ink-mute)}',
    '.czrd-sumserial{font-family:var(--czrd-serif);font-size:1.5rem;font-weight:500;line-height:1;',
    'letter-spacing:.03em;color:var(--czrd-ink);font-variant-numeric:tabular-nums}',
    '.czrd-sumtier{margin:.3rem 0 0;font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;',
    'color:var(--czrd-ink-soft)}',
    '.czrd-sumlines{flex-shrink:0;text-align:right;font-variant-numeric:tabular-nums}',
    '.czrd-sumline{display:flex;align-items:baseline;justify-content:flex-end;gap:.7rem;',
    'font-size:.7rem;line-height:1.7;color:var(--czrd-ink-soft)}',
    '.czrd-sumline span:last-child{min-width:4.5rem}',
    '.czrd-sumline--total{margin-top:.25rem;padding-top:.25rem;border-top:1px solid var(--czrd-line);',
    'font-size:1.05rem;font-weight:500;color:var(--czrd-ink)}',
    '.czrd-sumline--total span:first-child{font-size:.55rem;font-weight:500;letter-spacing:.2em;',
    'text-transform:uppercase;color:var(--czrd-ink-mute)}',

    // Decodes the grid. Three states, three swatches, said once at the bottom
    // instead of a sentence that has to describe them in words.
    '.czrd-legend{flex:1 0 100%;display:flex;flex-wrap:wrap;align-items:center;',
    'justify-content:center;gap:.35rem .9rem;font-size:.6rem;letter-spacing:.06em;',
    'color:var(--czrd-ink-soft)}',
    '.czrd-legend span{display:inline-flex;align-items:center;gap:.3rem}',
    '.czrd-legend i{width:12px;height:12px;flex-shrink:0;border:1px solid var(--czrd-line-mid);',
    'background:var(--czrd-card)}',
    '.czrd-legend i.czrd-legend--held{border-style:dashed;border-color:rgba(176,106,18,.65)}',
    '.czrd-legend i.czrd-legend--sold{border-color:var(--czrd-line);',
    'background:repeating-linear-gradient(135deg,transparent 0 3px,rgba(90,55,15,.14) 3px 4px),var(--czrd-sunk)}',

    '.czrd-note{margin:.75rem 0 0;padding:.7rem .85rem;background:var(--czrd-card);',
    'border:1px solid var(--czrd-line-mid);border-left:2px solid var(--czrd-amber-dark);',
    'font-size:.78rem;line-height:1.5;color:var(--czrd-ink-mid)}',
    '.czrd-alts{display:flex;gap:.35rem;flex-wrap:wrap;margin-top:.5rem}',
    '.czrd-alt{padding:.4em .7em;border:1px solid var(--czrd-line-dark);border-radius:0;',
    'background:transparent;color:var(--czrd-ink);font:inherit;font-size:.72rem;cursor:pointer;',
    'font-variant-numeric:tabular-nums;transition:background .18s}',
    '.czrd-alt:hover{background:rgba(90,55,15,.07)}',

    '.czrd-chosen{margin:.6rem 0 0;padding:.6rem .75rem;border-left:2px solid currentColor;',
    'font-size:.85rem;line-height:1.5;opacity:.9}',
    '.czrd-chosen__hold{display:block;margin-top:.15rem;font-size:.78rem;opacity:.7}',
    // Tabular figures so the countdown does not jitter the sentence around it
    // once a second, which is what proportional digits do to a running clock.
    '.czrd-chosen__clock{font-variant-numeric:tabular-nums;font-weight:600}',
    '.czrd-chosen__link{color:inherit;text-decoration:underline;text-underline-offset:.15em}',
    // A lapsed hold is not an error the shopper made, so it is stated rather
    // than alarmed: the border goes dashed and the clock is simply gone.
    '.czrd-chosen[data-lapsed="true"]{border-style:dashed;opacity:.75}',

    // The second button is deliberately quieter than the first: choosing a
    // number is the main action on the page, adding a second watch is not.
    '.czrd-btn--another{font-size:.8em;opacity:.85;border-style:dashed;margin-top:.4rem}',
    '.czrd-btn--another:hover{opacity:1}',

    /**
     * The number tags, on the theme's own page.
     *
     * Everything here is `inherit` and `currentColor` for the same reason
     * .czrd-btn is: this sits inside somebody else's product block, on a
     * background this file cannot see, so it takes the ink and the face it
     * lands in rather than asserting the popup's cream palette against a page
     * that may be black. The popup's --czrd-* variables are declared on
     * .czrd-overlay and deliberately do not reach out here.
     *
     * Pill-shaped, where every other surface in this picker is square-cornered:
     * these are the one control on the page that is a LIST of things you have,
     * rather than an action you take, and the shape is what says so before the
     * words do. Tabular figures so five-digit serials line up in the row.
     */
    '.czrd-tags{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem .5rem;margin:.55rem 0 0}',
    '.czrd-tags__lede{font-size:.72rem;letter-spacing:.04em;opacity:.6;flex-basis:100%}',
    '.czrd-tags__row{display:flex;flex-wrap:wrap;gap:.35rem}',
    '.czrd-tag{display:inline-flex;align-items:center;gap:.45em;padding:.35em .75em;',
    'border:1px solid currentColor;border-radius:999px;background:transparent;color:inherit;',
    'font:inherit;font-size:.78rem;letter-spacing:.04em;cursor:pointer;opacity:.75;',
    'font-variant-numeric:tabular-nums;transition:opacity .18s,background .18s}',
    '.czrd-tag:hover{opacity:1;background:rgba(128,128,128,.12)}',
    '.czrd-tag svg{flex-shrink:0;opacity:.7}',
    '.czrd-tag__n{font-weight:600}',
    // Sits where the cart's quantity stepper was, so the row does not collapse
    // and the shopper can see that something was decided rather than missing.
    '.czrd-qty-note{display:inline-block;font-size:.72rem;letter-spacing:.04em;opacity:.6;',
    'white-space:nowrap}',

    '.czrd-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;',
    'clip:rect(0,0,0,0);white-space:nowrap;border:0}',

    // One focus ring for every control in the popup, in a colour that clears
    // AA against both the cream surface and the ink CTA it may land on.
    '.czrd-modal button:focus-visible,.czrd-modal input:focus-visible{',
    'outline:2px solid var(--czrd-amber-dark);outline-offset:2px;position:relative;z-index:3}',

    // Where a number is jumped to from search, the ring is the answer to
    // "did it find it" — the scroll alone is easy to miss on a long grid.
    '@keyframes czrd-flash{0%,100%{box-shadow:0 0 0 0 rgba(184,130,44,0)}',
    '15%{box-shadow:0 0 0 3px rgba(184,130,44,.6)}60%{box-shadow:0 0 0 3px rgba(184,130,44,.35)}}',
    '.czrd-flash{animation:czrd-flash 1.1s ease}',

    '@media (prefers-reduced-motion:reduce){.czrd-btn,.czrd-cell,.czrd-tier,.czrd-cta,',
    '.czrd-chip{transition:none}',
    // The sheen lives on a pseudo-element, so it is not covered by the rule
    // above and has to be stopped by hand.
    '.czrd-tier--legacy:after,.czrd-tier--crown:after,.czrd-tier--icon:after,',
    '.czrd-tier--signature:after{transition:none;display:none}',
    '.czrd-body,.czrd-overlay{scroll-behavior:auto}',
    '.czrd-flash{animation:none}',
    '.czrd-cell:not([disabled]):hover,.czrd-tier:not([disabled]):hover,',
    '.czrd-cell[aria-pressed="true"],.czrd-tier[aria-pressed="true"]{transform:none}}',
  ].join('')

  function injectStyles() {
    if (document.getElementById('czrd-styles')) return
    const tag = document.createElement('style')
    tag.id = 'czrd-styles'

    /**
     * Fitzgerald, from the portal, for the storefront.
     *
     * Regular only. The popup sets every serial at weight 400 — a display serif
     * at 27px does not want bolding, and the other three faces would be 65KB
     * fetched to be never used.
     *
     * `font-display:swap` because the popup must not wait on a font to paint a
     * grid the shopper pressed a button to see: the numbers arrive in Georgia
     * and re-set a moment later. Skipped entirely when the portal origin is
     * unknown, which is the case where the URL would resolve against the
     * merchant's own domain and 404.
     */
    const face = CONFIG.portal
      ? "@font-face{font-family:'Fitzgerald';font-style:normal;font-weight:400;" +
        "font-display:swap;src:url('" + CONFIG.portal + "/fonts/Fitzgerald-Regular.woff2') format('woff2')}"
      : ''

    // The display face last, at the same specificity, so source order settles
    // it — the block above declares the default and this overrides it only when
    // the merchant named one.
    tag.textContent = face + CSS + '.czrd-overlay{--czrd-serif:' + CONFIG.displayFont + '}'
    document.head.appendChild(tag)
  }

  /* ---------------------------------------------------------------------
   * State
   * ------------------------------------------------------------------ */

  const state = {
    chart: null,
    selected: null,
    holding: false,
    overlay: null,
    lastFocus: null,
    tickTimer: 0,
    refreshTimer: 0,
    countdowns: [],
    /**
     * The shopper's OWN hold, ticking on the page. Separate from tickTimer,
     * which drives the other-people's-holds countdowns inside the modal and dies
     * with it — this one has to outlive the popup, because that is the whole
     * period it describes.
     */
    holdTimer: 0,
    /** True between a successful reservation and the modal actually closing. */
    closing: false,
    /**
     * True when the popup was opened by "Add another watch" rather than by
     * "Buy now" — so confirming adds a second cart line instead of
     * replacing the number already in the cart.
     */
    addAnother: false,
    /**
     * The cart line whose number is being changed, when the popup was opened by
     * clicking one of the number tags — `{ key, display, variant, holdToken,
     * quantity }` straight off serialsInCart(). Null for both ordinary modes.
     *
     * It has to be the LINE, not just the serial: with two watches in the cart
     * the two numbers sit on two lines that may be on different variants, and
     * "change this number" means "change it on that line", which nothing else
     * in this file has a way to say. `addAnother` and this are mutually
     * exclusive — one adds a line, the other rewrites one.
     */
    editing: null,
    /**
     * The variant the page was on before a tag borrowed it for an edit, put
     * back when the edit is abandoned. Null outside an edit.
     */
    returnVariant: null,
    /**
     * True unless initWarrantyGate() flips it — which it only does when
     * `requireWarranty` is explicitly on AND this product has a real Warranty
     * option. Starting true means the ordinary page (gate off, One Year
     * preselected by applyDefaultVariant) never sees a disabled button, and a
     * gated one does not flash it disabled while the async product.js fetch
     * finds out whether the gate even applies.
     */
    warrantyChosen: true,
    /**
     * What the shopper has narrowed the grid to. Lives on `state` rather than
     * in the DOM because the chart re-renders itself every thirty seconds while
     * the popup sits open — a filter kept only as markup would be wiped mid-scan
     * by a refresh that exists to update somebody else's countdown.
     */
    view: { tier: 'all', query: '', availableOnly: false },
    /**
     * The custom-number popup's own state. `seq` is the guard that stops a
     * slow reply about "482" repainting the answer about "4821"; `offer` is the
     * numeral the Reserve button is currently promising, and is null whenever
     * that button is disabled, so the two can never disagree.
     */
    custom: { seq: 0, timer: 0, offer: null, returnFocus: null },
    /** The IntersectionObserver keeping the block rail in step with the scroll. */
    blockWatcher: null,
  }

  /* ---------------------------------------------------------------------
   * The modal
   * ------------------------------------------------------------------ */

  /* ---------------------------------------------------------------------
   * Page scroll, while the popup is open
   * ------------------------------------------------------------------ */

  /**
   * The previous inline overflow, so it can be put back exactly as it was.
   *
   * Setting `document.body.style.overflow = ''` on close looks like a reset and
   * is a deletion: it removes whatever inline value was there BEFORE the popup
   * opened. On a site running Lenis — or any theme that locks the body for its
   * own drawer — that silently throws away a value somebody else owned, and the
   * page ends up in a state neither party set.
   */
  let previousBodyOverflow = null

  function lockPageScroll() {
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    /**
     * Ask Lenis to stop, if the theme exposed its instance.
     *
     * `data-lenis-prevent` on the overlay is what actually makes the popup
     * scrollable and is enough on its own. This is the belt to that pair of
     * braces: with the instance stopped, the page underneath cannot drift at
     * all — including from a momentum scroll already in flight when the button
     * was pressed, which the attribute cannot cancel because it started before
     * the overlay existed.
     *
     * Entirely optional. Themes that keep Lenis private simply skip it, which
     * is why every access is guarded rather than assumed.
     */
    withLenis(function (lenis) { lenis.stop() })
  }

  function unlockPageScroll() {
    document.body.style.overflow = previousBodyOverflow || ''
    previousBodyOverflow = null
    withLenis(function (lenis) { lenis.start() })
  }

  /** The handful of places a theme conventionally parks its Lenis instance. */
  function withLenis(fn) {
    const candidates = [window.lenis, window.Lenis && window.Lenis.instance, window.smoothScroll]
    for (let i = 0; i < candidates.length; i++) {
      const instance = candidates[i]
      if (instance && typeof instance.stop === 'function' && typeof instance.start === 'function') {
        try { fn(instance) } catch (e) { /* a theme's scroller is not ours to break */ }
        return
      }
    }
  }

  function openModal() {
    if (state.overlay) return
    injectStyles()
    state.lastFocus = document.activeElement

    const overlay = document.createElement('div')
    overlay.className = 'czrd-overlay'
    /**
     * Lenis opt-out.
     *
     * Lenis implements smooth scrolling by capturing wheel and touch events on
     * the document and translating the page itself, which means a fixed overlay
     * on top of it receives nothing — the grid of a hundred and twenty numbers
     * simply will not scroll, and the page behind it slides instead. Lenis
     * publishes `data-lenis-prevent` for exactly this, and the storefront
     * already uses it on its own details panel.
     *
     * Set on the overlay AND on the scrolling body: the attribute applies to
     * the element and its descendants, and putting it on the overlay also stops
     * a wheel event over the padding around the modal from scrolling the page.
     * Harmless on a site without Lenis, which is why it is unconditional rather
     * than behind a feature check.
     */
    overlay.setAttribute('data-lenis-prevent', '')
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    // The dialog is named for what it DOES, not for the button that opened it.
    // "Buy now" on a screen whose whole purpose is choosing a number would tell
    // a screen-reader user they are somewhere they are not.
    overlay.setAttribute('aria-label', 'Choose your number')
    overlay.innerHTML =
      '<div class="czrd-modal">' +
      '<div class="czrd-drag" aria-hidden="true"></div>' +
      '<div class="czrd-head">' +
      '<button type="button" class="czrd-close" aria-label="Close">&times;</button>' +
      '<p class="czrd-eyebrow"></p>' +
      '<h2 class="czrd-title">Choose your number</h2>' +
      '<p class="czrd-engrave">' +
      '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">' +
      '<circle cx="6.5" cy="6.5" r="6" stroke="#7A5A32" stroke-width="1"></circle>' +
      '<path d="M4 6.5L5.8 8.3L9 5" stroke="#7A5A32" stroke-width="1.2" ' +
      'stroke-linecap="round" stroke-linejoin="round"></path></svg>' +
      'Engraved on the caseback · issued once · never reissued</p>' +
      /**
       * Which watch this popup is about, when it is about one in particular.
       * With two numbers in the cart the grid alone cannot say whether a pick
       * replaces the first, the second, or neither — so the line that opened it
       * is named here, in the header, where it stays visible for the whole
       * scroll. Its own element rather than `.czrd-sub`, which renderChart
       * overwrites with the currency note on every refresh.
       */
      (state.editing
        ? '<p class="czrd-editing">Changing <b>' + escapeHtml(state.editing.display) + '</b>' +
          ' — the number you pick replaces it on that watch. Your other numbers are untouched.</p>'
        : '') +
      /**
       * When the watch ships, in the collection's own words — "Delivery will
       * begin from 30th September onwards", or the pre-order line for a
       * collection sold ahead of production.
       *
       * In the header rather than beside the checkout button because it is
       * context for the whole choice, not a condition of it: somebody deciding
       * between a Crown and an ordinary number is entitled to know the watch is
       * a pre-order before they start, not after they have picked.
       *
       * Rendered empty and filled by renderChart, which hides it again when the
       * collection has nothing to say. Its own element rather than `.czrd-sub`,
       * which carries the currency note and is overwritten on every refresh.
       */
      '<p class="czrd-delivery" hidden></p>' +
      '<p class="czrd-sub"></p>' +
      /**
       * The reference-sold-out notice.
       *
       * Rendered hidden and filled by renderChart, like the delivery line, so
       * the header has no gap on the ordinary path. It is a separate element
       * from `.czrd-sub` for the same reason that one is: renderChart rewrites
       * the sub with the currency note on every refresh.
       */
      '<p class="czrd-gone" role="status" hidden></p>' +
      '</div>' +

      // Search and the tier chips. Rendered empty and filled by renderChart,
      // because which bands exist is the chart's answer, not this file's.
      '<div class="czrd-tools">' +
      '<div class="czrd-searchwrap">' +
      '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">' +
      '<circle cx="6" cy="6" r="4.6" stroke="#8A6B42" stroke-width="1.2"></circle>' +
      '<path d="M9.6 9.6L13 13" stroke="#8A6B42" stroke-width="1.2" stroke-linecap="round"></path></svg>' +
      '<input type="text" class="czrd-search" inputmode="numeric" autocomplete="off" ' +
      'placeholder="Search a number" aria-label="Search numbers">' +
      '<span class="czrd-searchmeta" aria-hidden="true"></span>' +
      '<button type="button" class="czrd-searchclear" aria-label="Clear search">&times;</button>' +
      '</div>' +
      /**
       * The way out of the grid, right beside the way through it.
       *
       * Somebody who came for a number that is not in the chapter's run has,
       * until now, had no answer at all - they searched, found nothing, and
       * left. This button is the answer, and it sits next to the search box
       * because that is where they are standing when they discover the number
       * they want is not on offer. It appears a second time inside the empty
       * state, for the shopper who searched before noticing it here.
       */
      '<button type="button" class="czrd-custombtn" data-czrd-custom>' +
      'Customize Number</button>' +
      '<div class="czrd-chips" role="group" aria-label="Filter numbers"></div>' +
      '</div>' +

      '<div class="czrd-body" data-lenis-prevent></div>' +

      '<div class="czrd-foot">' +
      '<div class="czrd-summary" data-show="false">' +
      '<div class="czrd-sumtop">' +
      '<div>' +
      '<p class="czrd-sumtag">Your selection</p>' +
      '<div class="czrd-sumserial">—</div>' +
      '<p class="czrd-sumtier"></p>' +
      '</div>' +
      '<div class="czrd-sumlines">' +
      '<div class="czrd-sumline"><span>Watch</span><span class="czrd-sumbase">—</span></div>' +
      '<div class="czrd-sumline czrd-sumfeerow"><span>Reservation fee</span>' +
      '<span class="czrd-sumfee">—</span></div>' +
      '<div class="czrd-sumline czrd-sumline--total"><span>Total</span>' +
      '<span class="czrd-sumtotal">—</span></div>' +
      '</div></div></div>' +
      '<p class="czrd-status" role="status" aria-live="polite"></p>' +
      '<button type="button" class="czrd-cta czrd-cta--block" disabled>' +
      (state.editing
        ? 'Select the number that replaces ' + escapeHtml(state.editing.display)
        : 'Select a number to reserve') + '</button>' +
      '<p class="czrd-legend">' +
      '<span><i aria-hidden="true"></i>Available</span>' +
      '<span><i class="czrd-legend--held" aria-hidden="true"></i>In someone’s checkout</span>' +
      '<span><i class="czrd-legend--sold" aria-hidden="true"></i>Sold</span>' +
      '</p>' +
      '<span class="czrd-sr czrd-announce" role="status" aria-live="polite"></span>' +
      '</div>' +

      /**
       * The custom-number popup.
       *
       * A layer inside the SAME modal rather than a second overlay on the page.
       * Two stacked overlays would mean two scroll locks, two Escape handlers
       * fighting over which closes first, and a focus trap that can be escaped
       * into the frozen grid behind it. Being inside the modal also means it
       * inherits the fonts and the colour variables for free, so a custom
       * number is set in the same face as every number in the grid - which is
       * the point of it being the same kind of thing.
       *
       * Rendered once and hidden, not built on demand: the input has to be
       * focusable the moment the button is pressed, and building markup first
       * costs a frame during which the focus call lands on nothing.
       */
      '<div class="czrd-custom" data-open="false" role="dialog" aria-modal="true" ' +
      'aria-label="Choose a custom number">' +
      '<div class="czrd-customhead">' +
      '<button type="button" class="czrd-customback" aria-label="Back to the grid">&times;</button>' +
      '<h3>Your own number</h3>' +
      '<p>Any four digits from 1001 to 9999, engraved on the caseback exactly ' +
      'as the chapter\u2019s own numbers are.</p>' +
      '</div>' +
      '<div class="czrd-custombody">' +
      '<input type="text" class="czrd-custominput" inputmode="numeric" ' +
      'autocomplete="off" maxlength="4" placeholder="1234" ' +
      'aria-label="Your four-digit number">' +
      '<p class="czrd-customhint">Sold once across every reference \u2014 ' +
      'once it is yours it is gone from VENI, VIDI and VICI alike.</p>' +
      '<p class="czrd-customsay" role="status" aria-live="polite"></p>' +
      '<div class="czrd-customprice" data-show="false">' +
      '<div class="czrd-customrow"><span>Watch</span>' +
      '<span class="czrd-custombase">\u2014</span></div>' +
      '<div class="czrd-customrow"><span>Reservation fee</span>' +
      '<span class="czrd-customfee">\u2014</span></div>' +
      '<div class="czrd-customrow czrd-customrow--total"><span>Total</span>' +
      '<b class="czrd-customtotal">\u2014</b></div>' +
      '</div>' +
      '<div class="czrd-customalt" data-show="false">' +
      '<p>Still free, and close to it</p>' +
      '<div class="czrd-customalts"></div>' +
      '</div>' +
      '</div>' +
      '<div class="czrd-customfoot">' +
      '<button type="button" class="czrd-cta czrd-cta--block czrd-customcta" disabled>' +
      'Type a number</button>' +
      '</div>' +
      '</div>' +

      '</div>'

    document.body.appendChild(overlay)
    state.overlay = overlay
    lockPageScroll()

    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) closeModal()
    })
    overlay.querySelector('.czrd-close').addEventListener('click', closeModal)
    overlay.querySelector('.czrd-cta').addEventListener('click', confirmSelection)
    bindTools(overlay)
    document.addEventListener('keydown', onKeydown, true)

    loadChart()

    // Refreshed while the modal sits open, because somebody else's twelve
    // minutes can start or end while this shopper is deciding. Thirty seconds
    // rather than per-second: the countdowns tick locally off freeInSeconds, so
    // polling buys correctness, not the clock.
    state.refreshTimer = window.setInterval(function () { loadChart(true) }, 30000)
    state.tickTimer = window.setInterval(tickCountdowns, 1000)
  }

  function closeModal() {
    if (!state.overlay) return
    window.clearInterval(state.refreshTimer)
    window.clearInterval(state.tickTimer)
    document.removeEventListener('keydown', onKeydown, true)
    state.overlay.parentNode.removeChild(state.overlay)
    state.overlay = null
    state.selected = null
    state.countdowns = []
    if (state.blockWatcher) {
      state.blockWatcher.disconnect()
      state.blockWatcher = null
    }
    // A search left in the box would come back with the next open, showing a
    // shopper who pressed "Buy now" a grid of four numbers.
    state.view = { tier: 'all', query: '', availableOnly: false }
    // The hold's own countdown deliberately keeps running — it describes the
    // twelve minutes, not the popup, and most of those minutes are spent with
    // the popup closed.
    state.closing = false
    // Whatever the popup was opened FOR ends with the popup. A shopper who
    // pressed "Add another watch" and then closed without choosing must not
    // find the next ordinary pick silently adding a second line — nor, having
    // opened a number tag and thought better of it, find the next pick
    // rewriting that line instead of their own.
    //
    // `state.editing` still being set here means the edit was ABANDONED — a
    // completed one clears it on the way through finishReservation — so the
    // variant it borrowed goes back with it. See beginEdit.
    if (state.editing) adoptVariant(state.returnVariant)
    state.addAnother = false
    state.editing = null
    state.returnVariant = null
    unlockPageScroll()
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus()
  }

  /**
   * Escape closes; Tab is trapped inside the dialog. A purchase gate that can be
   * tabbed out of leaves a keyboard user typing into a page they cannot see.
   */
  function onKeydown(event) {
    if (!state.overlay) return

    if (event.key === 'Escape') {
      event.preventDefault()
      /**
       * Escape out of the search box empties it rather than closing the popup.
       * A shopper who has typed "13" and cannot see the number they wanted
       * presses Escape to undo the typing; closing the whole picker on them —
       * and losing the number they had already chosen — is not what was asked.
       */
      /**
       * The custom-number popup is a layer ON TOP of the grid, so Escape has to
       * peel it off before it reaches the modal underneath. Without this, one
       * press closes the whole picker from inside a dialog the shopper opened a
       * moment ago, losing the grid position they were at.
       */
      if (customIsOpen()) {
        closeCustom()
        return
      }

      const search = state.overlay.querySelector('.czrd-search')
      if (search && document.activeElement === search && search.value) {
        search.value = ''
        state.view.query = ''
        state.overlay.querySelector('.czrd-searchwrap').setAttribute('data-filled', 'false')
        applyView()
        return
      }
      closeModal()
      return
    }

    if (event.key !== 'Tab') return

    const focusable = state.overlay.querySelectorAll(
      'button:not([disabled]),[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
    )
    if (!focusable.length) return

    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  /* ---------------------------------------------------------------------
   * Rendering
   * ------------------------------------------------------------------ */

  function loadChart(quiet) {
    if (!CONFIG.productId) {
      setStatus('This product is not mapped to a chapter yet.', 'error')
      return
    }

    return api('/api/serials/chart?product=' + encodeURIComponent(CONFIG.productId)).then(
      function (result) {
        if (!result.ok) {
          setStatus(result.data.message || 'The number chart is unavailable right now.', 'error')
          return
        }
        state.chart = result.data
        // Before anything is priced or reconciled: which currency is this
        // shopper in. Re-read on every load rather than once at boot, because
        // a market switch re-renders the page around this script without
        // reloading it, and a popup still quoting the previous currency would
        // disagree with the price sitting directly behind it.
        adoptMarket(state.chart)
        return applyLivePricing(state.chart).then(function () {
          renderChart(quiet)
        })
      },
      function () {
        if (!quiet) setStatus('Could not reach the number chart. Check your connection.', 'error')
      },
    )
  }

  /**
   * Reconciles every quoted row against the price Shopify will ACTUALLY
   * charge for the variant the shopper currently has selected.
   *
   * The split this preserves is the one the shop is built on: the base amount
   * comes from the chosen variant (a warranty choice moves it ₹2,500 on the
   * Compass trio), and the additional amount comes from the chosen number
   * (the VIP reservation fee, which is variant-independent — VIP-NUMBER-FEES.md
   * is explicit that a Crown costs the same premium either way). So the
   * correction is a flat shift of the base across every row, never a
   * re-derivation of the fees on top of it.
   *
   * Deliberately NOT conditional on the product having a warranty option. It
   * used to be, and that was wrong twice over: the Genève trio has no such
   * option and would silently keep whatever base the portal happened to be
   * seeded with, and any new product — the test product included — would do
   * the same. The portal's basePriceInr is a seeded figure; Shopify's variant
   * price is what the customer is actually charged at the till, so where they
   * disagree the till wins and the popup shows the truth.
   *
   * Called fresh on every loadChart() — every popup open, and every
   * 30-second refresh while it sits open — so changing variant and reopening
   * shows the right numbers without this file tracking the moment of the
   * switch.
   *
   * A silent no-op wherever it cannot answer confidently (no matching
   * variant, or the fetch failing). An approximate price the portal already
   * quoted is a far smaller problem than a popup that refuses to open
   * because a pricing nicety could not be confirmed.
   */
  function applyLivePricing(chart) {
    return productJson()
      .then(function (product) {
        if (!product) return

        const base = baseVariantForCurrentOptions(product)
        if (!base) return

        /**
         * Done in the MARKET's currency, not in rupees.
         *
         * `base.price` is what Shopify will charge, which on a market outside
         * India is dollars or euros — so comparing it against the portal's
         * rupee figure produced a delta of about fourteen thousand and shifted
         * every price in the popup by it. The comparison has to happen between
         * two figures in the same money, and the only one both sides have is
         * the shopper's own.
         */
        const active = majorUnits(base.price)
        const quoted = chart.money && chart.money.book && chart.money.book[MARKET.code]
        const was = quoted ? Number(quoted.base || 0) : Number(chart.basePriceInr || 0)
        const delta = active - was
        if (!delta) return

        if (quoted) {
          quoted.base = active
          quoted.total = active + Number(quoted.fee || 0)
        }
        // The rupee fields stay in step only when rupees ARE the market. On any
        // other market they are the portal's Indian list price, which this
        // variant says nothing about — shifting them by a dollar delta would
        // corrupt the one figure on the payload that was still correct.
        if (MARKET.code === 'INR') chart.basePriceInr = active

        /**
         * The same correction, carried into the currency the shopper is being
         * QUOTED in when that is a different one.
         *
         * Without this, choosing Lifetime Warranty moves the price Shopify
         * charges by ₹2,500 and the popup — quoting euros — goes on showing the
         * figure for One Year. The delta is recomputed rather than converted,
         * so it lands on the same round figure the server's own converter would
         * have produced: through rupees, then rounded to the currency's step.
         */
        let quoteDelta = 0
        if (quotingForeign()) {
          const quoteBook = chart.money && chart.money.book && chart.money.book[QUOTE.code]
          if (quoteBook) {
            const wasQuoted = Number(quoteBook.base || 0)
            const nowQuoted = toQuote(active, MARKET.code)
            quoteDelta = nowQuoted - wasQuoted
            quoteBook.base = nowQuoted
            quoteBook.total = nowQuoted + Number(quoteBook.fee || 0)
          }
        }

        for (let i = 0; i < chart.serials.length; i++) {
          const row = chart.serials[i]
          const book = row.prices && row.prices[MARKET.code]
          if (book) {
            book.base = Number(book.base || 0) + delta
            book.total = Number(book.total || 0) + delta
          }
          if (quoteDelta) {
            const shown = row.prices && row.prices[QUOTE.code]
            if (shown) {
              shown.base = Number(shown.base || 0) + quoteDelta
              shown.total = Number(shown.total || 0) + quoteDelta
            }
          }
          if (MARKET.code === 'INR') {
            row.priceInr = Number(row.priceInr || 0) + delta
          }
        }
      })
      .catch(function () {})
  }

  function renderChart(quiet) {
    if (!state.overlay || !state.chart) return
    const chart = state.chart

    // The header: what you are looking at, and the one caveat about the money.
    // No count of how many are left or sold — a shopper is choosing a number,
    // not watching inventory.
    state.overlay.querySelector('.czrd-eyebrow').textContent =
      chart.product.name + ' · ' + chart.chapter.name

    /**
     * The delivery line, shown only when there is one.
     *
     * `hidden` rather than an empty paragraph, so a collection with nothing to
     * say leaves no gap in the header. The text is the shop's, verbatim from
     * the chart payload — this file does not compose a sentence about a
     * shipping date, because the one place that sentence is edited has to be
     * the one place it is written.
     */
    const delivery = state.overlay.querySelector('.czrd-delivery')
    const note = chart.product && chart.product.deliveryNote
    if (delivery) {
      delivery.textContent = note || ''
      delivery.hidden = !note
    }

    /**
     * This reference has run out of watches, while the pool still has numbers.
     *
     * The one state a shared pool creates that nothing else on the page can
     * explain. Every tile is disabled — the portal projects an unsold numeral as
     * taken once a reference stops selling, so the grid is honest — but a wall of
     * a thousand grey tiles reads as a fault rather than as a sell-out, and it
     * says nothing about the two products where those same numbers are still
     * there to be bought.
     *
     * So the notice names both facts: this one is finished, and the numbers are
     * not. `poolAvailable` is carried precisely because `counts.available` reads
     * zero here (see the chart payload) — quoting the grid's own figure would
     * tell a shopper nothing is left anywhere, which is the opposite of true.
     *
     * Absent `reference` on the payload means a portal that predates the shared
     * pool, and the notice simply never shows. Nothing else in this function
     * depends on it.
     */
    const gone = state.overlay.querySelector('.czrd-gone')
    const ref = chart.reference
    if (gone) {
      const soldOut = Boolean(ref && ref.soldOut)
      if (soldOut) {
        const left = Number(ref.poolAvailable) || 0
        const siblings = (chart.siblings || []).filter(Boolean)
        const where = siblings.length === 0
          ? ''
          : siblings.length === 1
            ? ' on <b>' + escapeHtml(siblings[0]) + '</b>'
            : ' on <b>' + siblings.slice(0, -1).map(escapeHtml).join('</b>, <b>') +
              '</b> and <b>' + escapeHtml(siblings[siblings.length - 1]) + '</b>'

        gone.innerHTML =
          '<b>' + escapeHtml(chart.product.name) + '</b> is fully allocated for ' +
          escapeHtml(chart.chapter.name) + '.' +
          // Names WHERE the numbers still are, not how many. The count was the
          // one figure on this notice that had to be right to the minute, and
          // it is also the one nobody needs: a shopper sent to a sibling
          // reference finds out what is left by looking at it.
          (left > 0 && where ? ' Numbers are still available' + where + '.' : '')
      }
      gone.hidden = !soldOut
    }

    // Said once, where a shopper reads the context for every figure below it —
    // rather than repeated against each of five hundred prices.
    state.overlay.querySelector('.czrd-sub').textContent = chargeNote()

    const body = state.overlay.querySelector('.czrd-body')
    if (body) body.setAttribute('data-gone', ref && ref.soldOut ? 'true' : 'false')
    const scrollTop = body.scrollTop

    /**
     * Grouped by tier, one section each.
     *
     * This was a single row of "named numbers" beside the main grid, which was
     * right when the scheme had three of them. The published list has 53, and a
     * reference's slice of it is around two dozen — as one undifferentiated row
     * that is a wall of cards where a Crown at ₹2,999 sits indistinguishable
     * beside a Signature at ₹499. A shopper deciding what to spend needs the
     * bands separated, priced, and counted.
     *
     * Ordered by rank, so the most sought-after are first and the ordinary
     * numbers last — which is also cheapest-to-scan order, because the long
     * grid ends up at the bottom where scrolling is expected.
     */
    const byTier = {}
    const rest = []
    for (let i = 0; i < chart.serials.length; i++) {
      const row = chart.serials[i]
      if (row.tierId && row.tierId !== 'other') {
        if (!byTier[row.tierId]) byTier[row.tierId] = []
        byTier[row.tierId].push(row)
      } else {
        rest.push(row)
      }
    }

    const bands = (chart.tiers || [])
      .filter(function (t) { return t.id !== 'other' })
      .sort(function (a, b) { return a.rank - b.rank })

    let html = ''
    for (let i = 0; i < bands.length; i++) {
      const band = bands[i]
      const rows = byTier[band.id] || []
      if (!rows.length) continue

      html +=
        '<div class="czrd-tiergroup" data-group="' + escapeHtml(band.id) + '">' +
        // The band's own `description` is deliberately not used here: it counts
        // the tier across the whole chapter ("the nine most sought-after
        // numbers"), and a reference sells a slice of it — Jura Grüen's 456–500
        // has three Crowns, so the sentence would be wrong on the page it was
        // describing. The fee is the fact that is true of every row shown.
        tierHeading(band.id, band.label, feeRangeLabel(rows)) +
        '<div class="czrd-band czrd-band--' + escapeHtml(band.id) + '" role="group" aria-label="' +
        escapeHtml(band.label) + ' numbers">' + rows.map(tierCard).join('') + '</div>' +
        '</div>'
    }

    html +=
      '<div class="czrd-tiergroup" data-group="other">' +
      tierHeading('other', 'Every other number', 'No reservation fee') +
      restBody(rest) +
      '</div>'

    html +=
      '<div class="czrd-empty" data-show="false">' +
      '<h3>No numbers match</h3>' +
      '<p>Try a different number, widen the filter \u2014 or have the number ' +
      'you came for made for you.</p>' +
      '<button type="button" data-czrd-reset>Reset filters</button>' +
      // The second placement, and the one that matters most: a shopper reaches
      // this state precisely BECAUSE the number they wanted is not in the run,
      // which is the exact moment a custom number is the right answer.
      '<button type="button" data-czrd-custom>Customize Number</button>' +
      '</div>'

    body.innerHTML = html

    body.scrollTop = quiet ? scrollTop : 0

    renderChips(bands, byTier, rest)
    bindCells(body)
    collectCountdowns(body)
    watchBlocks(body)

    /**
     * The filter and the selection are re-applied AFTER the markup is thrown
     * away and rebuilt, because both live on `state` and neither is the
     * chart's to forget. The thirty-second refresh exists to move somebody
     * else's countdown; before this it also silently cleared the shopper's
     * search and un-highlighted the number they had chosen, while the confirm
     * button went on offering to reserve it.
     */
    applyView()
    if (state.selected != null) markSelected(state.selected)

    if (!quiet) setStatus('')
  }

  /** The sticky band heading: rule, name, what it costs. No sold/left count. */
  function tierHeading(id, label, note) {
    return (
      '<div class="czrd-tierhead">' +
      '<span class="czrd-tierrule czrd-tierrule--' + escapeHtml(id) + '" aria-hidden="true"></span>' +
      '<span class="czrd-tierlabels">' +
      '<span class="czrd-label">' + escapeHtml(label) +
      '<span class="czrd-label__note">' + escapeHtml(note) + '</span></span>' +
      '</span></div>'
    )
  }

  /**
   * The ordinary numbers, cut into hundred-blocks with a rail across the top.
   *
   * A chapter is five hundred numbers and the four hundred and forty-seven that
   * carry no fee are one uninterrupted scroll — long enough that a shopper who
   * wants something in the three hundreds has no way to get there but the
   * wheel. Below a hundred and twenty rows there is nothing to navigate, so the
   * rail is not drawn at all rather than shown with one button in it.
   */
  function restBody(rest) {
    if (rest.length < 120) {
      return '<div class="czrd-grid" role="group" aria-label="Every other number">' +
        rest.map(cell).join('') + '</div>'
    }

    const blocks = []
    const index = {}
    for (let i = 0; i < rest.length; i++) {
      const key = Math.floor((Number(rest[i].n) - 1) / 100)
      if (index[key] === undefined) {
        index[key] = blocks.length
        blocks.push({ key: key, rows: [] })
      }
      blocks[index[key]].rows.push(rest[i])
    }

    let rail = '<div class="czrd-rail" role="group" aria-label="Jump to a block of numbers">'
    let body = ''
    for (let i = 0; i < blocks.length; i++) {
      const rows = blocks[i].rows
      // Labelled from the numbers actually in the block, not from the nominal
      // hundred: the first block of a chapter starts at 002 when 001 is a Crown.
      const label = pad3(rows[0].n) + '–' + pad3(rows[rows.length - 1].n)
      const id = 'czrd-block-' + blocks[i].key
      rail +=
        '<button type="button" data-czrd-jump="' + id + '"' +
        (i === 0 ? ' aria-current="true"' : '') + '>' + label + '</button>'
      body +=
        '<div class="czrd-block" id="' + id + '" data-block="' + id + '">' +
        '<p class="czrd-blockhead">' + label + '</p>' +
        '<div class="czrd-grid" role="group" aria-label="Numbers ' + label + '">' +
        rows.map(cell).join('') + '</div></div>'
    }
    return rail + '</div>' + body
  }

  function pad3(n) {
    return String(n).length >= 3 ? String(n) : ('00' + n).slice(-3)
  }

  /**
   * The tier chips, built from the chart rather than from a list in here — a
   * chapter that has no Signatures must not offer a Signature filter that
   * empties the grid.
   */
  function renderChips(bands, byTier, rest) {
    const host = state.overlay.querySelector('.czrd-chips')
    if (!host) return

    /**
     * No count on the chip.
     *
     * The chips used to carry how many of their band were still free, and the
     * figure is deliberately gone rather than merely hidden: a band is offered
     * because it EXISTS on this reference, not because of how much of it is
     * left, and "3 left" on a Crown chip prices scarcity in a place the shop
     * does not want it priced. `byTier` is still what decides whether a chip
     * appears at all, so a chapter with no Signatures still offers no
     * Signature filter — that is about existence and is unchanged.
     */
    function chip(id, label, mark) {
      return (
        '<button type="button" class="czrd-chip" data-czrd-tier="' + escapeHtml(id) + '"' +
        ' aria-pressed="' + (state.view.tier === id ? 'true' : 'false') + '">' +
        (mark ? '<i class="czrd-chipmark czrd-chipmark--' + escapeHtml(id) + '" aria-hidden="true"></i>' : '') +
        escapeHtml(label) + '</button>'
      )
    }

    let html = ''
    for (let i = 0; i < bands.length; i++) {
      const rows = byTier[bands[i].id] || []
      if (!rows.length) continue
      html += chip(bands[i].id, bands[i].label, true)
    }
    if (rest.length) html += chip('other', 'No fee', true)

    /**
     * All comes LAST, after the four named bands.
     *
     * The bands themselves are already ordered cheapest-first by their rank
     * (see src/lib/reservations/tiers.js), so the row reads Signature, Icon,
     * Crown, Legacy, All — the ladder, and then the way off it. Leading with
     * All, as this used to, put the escape hatch before the thing it is an
     * escape from, and the pressed-by-default chip at the far left is the one
     * least likely to be read.
     */
    host.innerHTML =
      html + chip('all', 'All', false) +
      '<button type="button" class="czrd-chip czrd-chip--avail" data-czrd-available' +
      ' aria-pressed="' + (state.view.availableOnly ? 'true' : 'false') + '">Available only</button>'
  }

  /** "+$15" for one price, "+$35–50" when a band spans several. */
  function feeRangeLabel(rows) {
    let lo = Infinity
    let hi = 0
    for (let i = 0; i < rows.length; i++) {
      const fee = Number(quoteOf(rows[i]).fee) || 0
      if (fee < lo) lo = fee
      if (fee > hi) hi = fee
    }
    if (!hi) return 'No reservation fee'
    return lo === hi ? '+' + money(hi) + ' fee' : '+' + money(lo) + '–' + money(hi) + ' fee'
  }

  /**
   * The state line a disabled tile carries.
   *
   * A live countdown for a number that will come back, the plain word for one
   * that will not — the distinction the grid's colours also draw, said again in
   * text because colour alone is not an accessible way to say it. Kept as its
   * own element so collectCountdowns(), which queries [data-countdown] across
   * the whole popup body, ticks it down like any other.
   *
   * `prefix` is stored on the node rather than baked into the text, because
   * tickCountdowns() rewrites the whole textContent every second and would
   * otherwise drop it on the first tick.
   */
  function stateMeta(row, className, prefix) {
    if (row.status === 'reserved' && row.freeInSeconds) {
      return (
        '<span class="' + className + '" data-countdown="' + row.freeInSeconds + '"' +
        (prefix ? ' data-countdown-prefix="' + escapeHtml(prefix) + '"' : '') + '>' +
        escapeHtml(prefix || '') + clock(row.freeInSeconds) + '</span>'
      )
    }
    if (row.status !== 'available') {
      return '<span class="' + className + '">' + statusWord(row) + '</span>'
    }
    return ''
  }

  /**
   * Shared attributes for both tile shapes.
   *
   * `data-tier` and `data-display` exist for the filter and the search box:
   * both run over the rendered DOM rather than re-deriving from the chart, so
   * that narrowing the grid never has to rebuild it — a rebuild would drop the
   * shopper's scroll position and their selection with it.
   */
  function tileAttrs(row, tierId) {
    return (
      ' data-serial="' + row.n + '" data-status="' + row.status + '"' +
      ' data-tier="' + escapeHtml(tierId || 'other') + '"' +
      ' data-display="' + escapeHtml(String(row.display).toLowerCase()) + '"' +
      ' aria-pressed="false"' + (row.status !== 'available' ? ' disabled' : '')
    )
  }

  function tierCard(row) {
    const tier = tierById(row.tierId)
    const quote = quoteOf(row)
    const band = row.tierId || 'other'

    return (
      '<button type="button" class="czrd-tier czrd-selectable czrd-tier--' + escapeHtml(band) + '"' +
      tileAttrs(row, band) +
      ' aria-label="' + escapeHtml(
        (tier ? tier.label + '. ' : '') + row.display + '. ' + money(quote.total) +
        (quote.fee > 0 ? ', including a ' + money(quote.fee) + ' reservation fee' : ', no reservation fee') +
        '. ' + statusPhrase(row) + '.',
      ) + '">' +
      '<span class="czrd-tiercheck" aria-hidden="true">✓</span>' +
      '<span class="czrd-tier-serial">' + escapeHtml(row.display) + '</span>' +
      '<span class="czrd-tierhr" aria-hidden="true"></span>' +
      '<span class="czrd-tier-price">' + money(quote.total) + '</span>' +
      (quote.fee > 0
        ? '<span class="czrd-tier-fee">incl. ' + money(quote.fee) + ' fee</span>'
        : '') +
      stateMeta(row, 'czrd-tier-meta', 'Free in ') +
      '</button>'
    )
  }

  function cell(row) {
    const quote = quoteOf(row)
    // Sixty-two pixels of tile: the clock goes in bare, without the "Free in"
    // the wider card can afford.
    const meta =
      row.status === 'available'
        ? '<span class="czrd-cell-meta">' + money(quote.total) + '</span>'
        : stateMeta(row, 'czrd-cell-meta', '')

    return (
      '<button type="button" class="czrd-cell czrd-selectable"' +
      tileAttrs(row, 'other') +
      ' aria-label="' + escapeHtml(
        row.display + '. ' + money(quote.total) +
        (quote.fee > 0 ? ', including a ' + money(quote.fee) + ' reservation fee' : ', no reservation fee') +
        '. ' + statusPhrase(row) + '.',
      ) + '">' +
      '<span class="czrd-cell-n">' + escapeHtml(row.display) + '</span>' + meta +
      '</button>'
    )
  }

  function statusWord(row) {
    if (row.status === 'available') return 'Available'
    if (row.status === 'reserved') return 'Not available'
    if (row.status === 'taken') return 'Sold'
    return 'Not available'
  }

  /**
   * The same fact, at the length a label can afford.
   *
   * statusWord() has to fit inside a sixty-two pixel tile, so 'reserved' and
   * 'taken' both come back as something short and neither says which. On the
   * grid that is fine — a dashed amber edge with a clock running in it is not
   * the same object as a hatched-out cell, and a sighted shopper can see the
   * difference. In the accessibility tree there is no dashed edge, so the two
   * were indistinguishable: a screen reader heard "not available" for a number
   * that frees up in ninety seconds and for one that is gone forever.
   */
  function statusPhrase(row) {
    if (row.status === 'reserved') {
      return row.freeInSeconds
        ? 'In someone else’s checkout, free in ' + clock(row.freeInSeconds)
        : 'In someone else’s checkout'
    }
    if (row.status === 'taken') return 'Sold'
    if (row.status === 'available') return 'Available'
    return 'Not available'
  }

  function tierById(id) {
    if (!state.chart || !id) return null
    const list = state.chart.tiers || []
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
    return null
  }

  /* ---------------------------------------------------------------------
   * Narrowing the grid — search, tier chips, the block rail
   *
   * All of it runs over the rendered DOM and none of it re-renders. The chart
   * rebuilds itself every thirty seconds to keep other people's countdowns
   * honest, and a filter that rebuilt the grid would fight that refresh for the
   * shopper's scroll position. Hiding tiles costs one pass over five hundred
   * nodes and keeps the selection, the scroll and the focus exactly where the
   * shopper left them.
   * ------------------------------------------------------------------ */

  function bindTools(overlay) {
    const search = overlay.querySelector('.czrd-search')
    const wrap = overlay.querySelector('.czrd-searchwrap')

    search.addEventListener('input', function () {
      state.view.query = String(search.value).trim().toLowerCase()
      wrap.setAttribute('data-filled', search.value ? 'true' : 'false')
      applyView()
    })

    /**
     * Enter takes the first match. Typing "007" and pressing return is the
     * shortest path a shopper who came for a particular number can take, and
     * without this it stopped one step short of the thing they were after.
     */
    search.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return
      event.preventDefault()
      const first = firstVisibleAvailable()
      if (!first) return
      revealTile(first)
      select(Number(first.getAttribute('data-serial')))
    })

    overlay.querySelector('.czrd-searchclear').addEventListener('click', function () {
      search.value = ''
      state.view.query = ''
      wrap.setAttribute('data-filled', 'false')
      applyView()
      search.focus()
    })

    // Delegated: the chips are rebuilt on every chart load, and the rail and
    // the empty state live inside .czrd-body, which is replaced wholesale.
    overlay.querySelector('.czrd-chips').addEventListener('click', function (event) {
      const chip = event.target.closest ? event.target.closest('.czrd-chip') : null
      if (!chip) return
      if (chip.hasAttribute('data-czrd-available')) {
        state.view.availableOnly = !state.view.availableOnly
        chip.setAttribute('aria-pressed', state.view.availableOnly ? 'true' : 'false')
      } else {
        state.view.tier = chip.getAttribute('data-czrd-tier')
        const chips = overlay.querySelectorAll('.czrd-chip[data-czrd-tier]')
        for (let i = 0; i < chips.length; i++) {
          chips[i].setAttribute('aria-pressed', chips[i] === chip ? 'true' : 'false')
        }
        overlay.querySelector('.czrd-body').scrollTop = 0
      }
      applyView()
    })

    overlay.querySelector('.czrd-body').addEventListener('click', function (event) {
      const target = event.target.closest ? event.target : null
      if (!target) return

      const jump = target.closest('[data-czrd-jump]')
      if (jump) {
        const block = overlay.querySelector('#' + jump.getAttribute('data-czrd-jump'))
        if (block) {
          const body = overlay.querySelector('.czrd-body')
          // Offset by the two sticky rows the block would otherwise slide under.
          body.scrollTop = block.offsetTop - body.offsetTop - 96
        }
        return
      }

      if (target.closest('[data-czrd-reset]')) resetView()

      // The empty state's Customize Number button. Delegated because .czrd-body
      // is replaced wholesale on every chart load, taking its listeners with it.
      if (target.closest('[data-czrd-custom]')) openCustom()
    })

    // The one beside the search box lives in .czrd-tools, which is rendered once
    // and never replaced, so it can be bound directly.
    const customBtn = overlay.querySelector('.czrd-custombtn')
    if (customBtn) customBtn.addEventListener('click', function () { openCustom() })

    bindCustom(overlay)
  }

  /* ---------------------------------------------------------------------
   * The custom number
   *
   * A four-digit numeral the shopper invents, from 1001 to 9999, at one flat
   * reservation fee. Everything below is the popup around a single endpoint —
   * GET /api/serials/custom — plus the handoff to confirmSelection(), which is
   * the same function the grid uses and therefore the same hold, the same fee
   * variant, the same cart line and the same twelve-minute clock.
   *
   * NOTHING HERE PRICES ANYTHING. The fee, the total and whether the number can
   * be had at all are the portal's answers, read off the response. A picker
   * that computed the fee itself would be a second opinion about money, and the
   * first time it disagreed with the portal the shopper would be charged one
   * figure and quoted another.
   * ------------------------------------------------------------------ */

  function customEl(suffix) {
    return state.overlay ? state.overlay.querySelector('.czrd-custom' + suffix) : null
  }

  function customIsOpen() {
    const panel = customEl('')
    return Boolean(panel && panel.getAttribute('data-open') === 'true')
  }

  function openCustom() {
    const panel = customEl('')
    if (!panel) return

    panel.setAttribute('data-open', 'true')
    state.custom.returnFocus = document.activeElement

    /**
     * Carry the search box over when what is in it could plausibly be the
     * number they were looking for.
     *
     * Somebody types 4821 into the search, finds nothing, and presses Customize
     * Number. Making them type it again is the kind of small insult that ends a
     * purchase. Only digits are carried, and only up to four of them — a longer
     * or dirtier query is not a number they can have, and prefilling it would
     * open the popup already showing an error.
     */
    const input = customEl('input')
    const search = state.overlay.querySelector('.czrd-search')
    const carried = search ? String(search.value).replace(/[^0-9]/g, '').slice(0, 4) : ''
    if (input && !input.value && carried) input.value = carried

    if (input) {
      input.focus()
      input.select()
    }
    runCustomCheck()
  }

  function closeCustom() {
    const panel = customEl('')
    if (!panel) return
    panel.setAttribute('data-open', 'false')

    // Every request still in flight is now about a popup nobody is looking at.
    // Bumping the sequence makes their replies land on the floor rather than
    // repainting a closed panel — see runCustomCheck.
    state.custom.seq += 1

    const back = state.custom.returnFocus
    state.custom.returnFocus = null
    if (back && typeof back.focus === 'function' && document.contains(back)) back.focus()
  }

  function customSay(message, tone) {
    const say = customEl('say')
    if (!say) return
    say.textContent = message || ''
    if (tone) say.setAttribute('data-tone', tone)
    else say.removeAttribute('data-tone')
  }

  /** The popup back to the state it opens in: nothing offered, nothing refused. */
  function customIdle(message) {
    const price = customEl('price')
    const alt = customEl('alt')
    const cta = customEl('cta')
    if (price) price.setAttribute('data-show', 'false')
    if (alt) alt.setAttribute('data-show', 'false')
    if (cta) {
      cta.disabled = true
      cta.textContent = 'Type a number'
    }
    state.custom.offer = null
    customSay(message || '', null)
  }

  /**
   * Ask the portal about whatever is in the box.
   *
   * Debounced, and guarded by a sequence number rather than by cancelling the
   * request. Typing 4821 fires four checks; they can come back in any order,
   * and without the guard the answer about "482" can land after the answer
   * about "4821" and tell the shopper their number is a catalogue one. Only the
   * reply whose sequence is still current is allowed to paint.
   */
  function runCustomCheck() {
    const input = customEl('input')
    if (!input) return

    const raw = String(input.value).replace(/[^0-9]/g, '')
    if (raw !== input.value) input.value = raw

    window.clearTimeout(state.custom.timer)
    state.custom.seq += 1

    if (raw.length < 4) {
      customIdle(raw.length ? 'Four digits — keep going.' : '')
      return
    }

    const seq = state.custom.seq
    customSay('Checking…', 'busy')

    state.custom.timer = window.setTimeout(function () {
      api('/api/serials/custom?product=' + encodeURIComponent(CONFIG.productId) +
        '&serial=' + encodeURIComponent(raw))
        .then(function (result) {
          if (seq !== state.custom.seq || !customIsOpen()) return
          paintCustom(result.data || {})
        })
        .catch(function () {
          if (seq !== state.custom.seq || !customIsOpen()) return
          customIdle('')
          customSay('Could not reach the number register. Try again in a moment.', 'bad')
        })
    }, 300)
  }

  function paintCustom(data) {
    const cta = customEl('cta')
    const price = customEl('price')
    const alt = customEl('alt')
    const alts = customEl('alts')

    state.custom.offer = null
    if (price) price.setAttribute('data-show', 'false')
    if (alt) alt.setAttribute('data-show', 'false')
    if (alts) alts.innerHTML = ''
    if (cta) {
      cta.disabled = true
      cta.textContent = 'Type a number'
    }

    // Every refusal the endpoint can give already carries the sentence to show.
    // Reproducing that wording here would be a second copy of it, free to drift.
    if (!data.ok) {
      customSay(data.message || 'That number cannot be reserved.', 'bad')
      return
    }

    const quote = quoteOf(data)

    if (!data.available) {
      const gone =
        data.status === 'reserved'
          ? data.display + ' is in someone’s checkout right now.'
          : data.display + ' has already been taken.'
      customSay(gone, 'bad')

      const list = data.suggestions || []
      if (list.length && alt && alts) {
        let html = ''
        for (let i = 0; i < list.length; i++) {
          html += '<button type="button" data-czrd-alt="' + escapeHtml(String(list[i])) + '">' +
            escapeHtml(String(list[i])) + '</button>'
        }
        alts.innerHTML = html
        alt.setAttribute('data-show', 'true')
      }
      return
    }

    // Yes. Quote both figures apart, because that is how they will be charged:
    // the watch on one cart line and the reservation fee on a second.
    state.custom.offer = { numeral: data.numeral, display: data.display, total: quote.total }
    customSay(data.display + ' is available.', 'ok')

    const base = customEl('base')
    const fee = customEl('fee')
    const total = customEl('total')
    if (base) base.textContent = money(quote.base)
    if (fee) fee.textContent = money(quote.fee)
    if (total) total.textContent = money(quote.total)
    if (price) price.setAttribute('data-show', 'true')

    if (cta) {
      cta.disabled = false
      cta.textContent = 'Reserve ' + data.display + ' · ' + money(quote.total)
    }
  }

  function bindCustom(overlay) {
    const panel = overlay.querySelector('.czrd-custom')
    if (!panel) return

    const input = overlay.querySelector('.czrd-custominput')
    const back = overlay.querySelector('.czrd-customback')
    const cta = overlay.querySelector('.czrd-customcta')

    if (back) back.addEventListener('click', closeCustom)
    if (input) {
      input.addEventListener('input', runCustomCheck)
      input.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return
        event.preventDefault()
        if (cta && !cta.disabled) cta.click()
      })
    }

    // Delegated: the suggestion buttons are rebuilt on every answer.
    const alts = overlay.querySelector('.czrd-customalts')
    if (alts) {
      alts.addEventListener('click', function (event) {
        const button = event.target.closest ? event.target.closest('[data-czrd-alt]') : null
        if (!button || !input) return
        input.value = button.getAttribute('data-czrd-alt')
        input.focus()
        runCustomCheck()
      })
    }

    if (cta) {
      cta.addEventListener('click', function () {
        const offer = state.custom.offer
        if (!offer || state.holding) return

        /**
         * The popup closes BEFORE the hold is attempted, and the handoff is to
         * the same confirmSelection() the grid uses.
         *
         * Closing first is what puts the footer status line back in view —
         * every message confirmSelection has, including the ones about a number
         * being taken in the last second, is written there, and behind an open
         * popup the shopper would watch a button say "Reserving…" forever.
         *
         * Going through select() rather than assigning state.selected keeps the
         * footer summary honest if the hold is refused: the shopper is returned
         * to the grid with the number they tried still named, rather than to a
         * summary showing whatever they had highlighted before.
         */
        closeCustom()
        select(offer.numeral)
        confirmSelection()
      })
    }
  }

  function resetView() {
    state.view = { tier: 'all', query: '', availableOnly: false }
    const overlay = state.overlay
    if (!overlay) return

    const search = overlay.querySelector('.czrd-search')
    search.value = ''
    overlay.querySelector('.czrd-searchwrap').setAttribute('data-filled', 'false')

    const chips = overlay.querySelectorAll('.czrd-chip')
    for (let i = 0; i < chips.length; i++) {
      const isAll = chips[i].getAttribute('data-czrd-tier') === 'all'
      chips[i].setAttribute('aria-pressed', isAll ? 'true' : 'false')
    }
    applyView()
  }

  function firstVisibleAvailable() {
    if (!state.overlay) return null
    const tiles = state.overlay.querySelectorAll('.czrd-selectable')
    for (let i = 0; i < tiles.length; i++) {
      if (!tiles[i].hidden && tiles[i].getAttribute('data-status') === 'available') return tiles[i]
    }
    return null
  }

  /** Scroll a tile into view and ring it, so a jump is visibly a jump. */
  function revealTile(tile) {
    if (!tile) return
    if (tile.scrollIntoView) tile.scrollIntoView({ block: 'center' })
    tile.classList.remove('czrd-flash')
    // Forced reflow, so re-adding the class restarts the animation rather than
    // being coalesced into no change at all.
    void tile.offsetWidth
    tile.classList.add('czrd-flash')
  }

  function applyView() {
    if (!state.overlay) return
    const body = state.overlay.querySelector('.czrd-body')
    const view = state.view
    const narrowed = Boolean(view.query) || view.tier !== 'all' || view.availableOnly

    const tiles = body.querySelectorAll('.czrd-selectable')
    let shown = 0
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]
      let ok = true
      if (view.tier !== 'all' && tile.getAttribute('data-tier') !== view.tier) ok = false
      if (ok && view.availableOnly && tile.getAttribute('data-status') !== 'available') ok = false
      if (ok && view.query && tile.getAttribute('data-display').indexOf(view.query) === -1) ok = false
      tile.hidden = !ok
      if (ok) shown++
    }

    // A heading over an empty band reads as a rendering fault, so the whole
    // group goes with its last tile.
    const groups = body.querySelectorAll('.czrd-tiergroup')
    for (let i = 0; i < groups.length; i++) {
      groups[i].hidden = !groups[i].querySelector('.czrd-selectable:not([hidden])')
    }

    const blocks = body.querySelectorAll('.czrd-block')
    for (let i = 0; i < blocks.length; i++) {
      const has = Boolean(blocks[i].querySelector('.czrd-cell:not([hidden])'))
      blocks[i].hidden = !has
      const jump = body.querySelector('[data-czrd-jump="' + blocks[i].id + '"]')
      if (jump) jump.style.display = has ? '' : 'none'
    }

    const empty = body.querySelector('.czrd-empty')
    if (empty) empty.setAttribute('data-show', shown === 0 ? 'true' : 'false')

    const meta = state.overlay.querySelector('.czrd-searchmeta')
    // Was "N shown". The box still reports NOTHING found — that is a dead end
    // the shopper has to be told about, and it is the empty state's job — but a
    // running tally of how many numbers a filter left is the same scarcity
    // figure the chips no longer carry.
    if (meta) meta.textContent = ''
  }

  /**
   * Which hundred-block the shopper is currently inside, mirrored onto the rail.
   *
   * Scroll-position tracking, not a click handler: the rail has to stay right
   * when the grid is scrolled by hand, which is how it is mostly moved.
   */
  function watchBlocks(body) {
    if (state.blockWatcher) {
      state.blockWatcher.disconnect()
      state.blockWatcher = null
    }
    if (typeof window.IntersectionObserver !== 'function') return

    const blocks = body.querySelectorAll('.czrd-block')
    if (!blocks.length) return

    state.blockWatcher = new window.IntersectionObserver(
      function (entries) {
        for (let i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) continue
          const id = entries[i].target.id
          const buttons = body.querySelectorAll('[data-czrd-jump]')
          for (let j = 0; j < buttons.length; j++) {
            const mine = buttons[j].getAttribute('data-czrd-jump') === id
            if (mine) buttons[j].setAttribute('aria-current', 'true')
            else buttons[j].removeAttribute('aria-current')
          }
        }
      },
      { root: body, rootMargin: '-100px 0px -70% 0px' },
    )
    for (let i = 0; i < blocks.length; i++) state.blockWatcher.observe(blocks[i])
  }

  function bindCells(root) {
    const cells = root.querySelectorAll('.czrd-selectable')
    for (let i = 0; i < cells.length; i++) {
      cells[i].addEventListener('click', onCellClick)
      cells[i].addEventListener('keydown', onCellKeydown)
    }
  }

  function onCellClick(event) {
    const button = event.currentTarget
    const serial = Number(button.getAttribute('data-serial'))
    const status = button.getAttribute('data-status')

    if (status !== 'available') {
      offerQueue(serial, button)
      return
    }
    select(serial)
  }

  /**
   * Arrow-key navigation — it is a grid, so it must behave like one.
   *
   * Scoped to the tile's OWN container rather than to the popup's first
   * .czrd-grid, because there is no longer just one: the ordinary numbers are
   * cut into hundred-blocks and the tier bands are grids in their own right. It
   * also walks past hidden tiles, so arrowing through a filtered grid does not
   * land focus on a number the shopper has filtered away.
   */
  function onCellKeydown(event) {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp']
    if (keys.indexOf(event.key) === -1) return

    const tile = event.currentTarget
    const container = tile.parentNode
    if (!container) return

    const all = []
    const kids = container.children
    for (let i = 0; i < kids.length; i++) {
      if (!kids[i].hidden && kids[i].className.indexOf('czrd-selectable') !== -1) all.push(kids[i])
    }
    const index = all.indexOf(tile)
    if (index === -1) return

    // Derived from the rendered layout rather than assumed, so it stays correct
    // across the auto-fill breakpoints: count the tiles sharing the top edge of
    // the first row.
    let perRow = 0
    const top = all[0].offsetTop
    while (perRow < all.length && all[perRow].offsetTop === top) perRow++
    if (perRow < 1) perRow = 1

    let next = index
    if (event.key === 'ArrowRight') next = index + 1
    if (event.key === 'ArrowLeft') next = index - 1
    if (event.key === 'ArrowDown') next = index + perRow
    if (event.key === 'ArrowUp') next = index - perRow

    if (next < 0 || next >= all.length) return
    event.preventDefault()
    all[next].focus()
  }

  /** Paint the chosen tile, without touching the footer or announcing anything. */
  function markSelected(serial) {
    if (!state.overlay) return
    const cells = state.overlay.querySelectorAll('.czrd-selectable')
    for (let i = 0; i < cells.length; i++) {
      const isIt = Number(cells[i].getAttribute('data-serial')) === serial
      cells[i].setAttribute('aria-pressed', isIt ? 'true' : 'false')
    }
  }

  function select(serial) {
    state.selected = serial
    markSelected(serial)

    const row = serialRow(serial)
    const cta = state.overlay.querySelector('.czrd-cta')
    cta.disabled = false
    // "Swap to" rather than "Reserve" when a tag opened this: the press is
    // about to give a number back as well as take one, and a button that only
    // mentions the taking hides half of what it does.
    const verb = state.editing ? 'Swap to ' : 'Reserve '
    cta.textContent = row
      ? verb + row.display + ' · ' + money(quoteOf(row).total)
      : verb + serial

    /**
     * The two figures, stated separately, because that is how they will be
     * charged: the watch on one cart line and the reservation fee on another.
     * Showing only a combined total would surprise the shopper at checkout with
     * an order that has more lines than they picked.
     *
     * This used to be a sentence in the status line, which is the same line
     * every error and every queue message writes to — so the one piece of
     * information the shopper needed while deciding was also the first thing
     * overwritten. It is a panel of its own now, and the status line is left
     * free for things that are actually transient.
     */
    const quote = row ? quoteOf(row) : null
    const summary = state.overlay.querySelector('.czrd-summary')
    if (row && quote) {
      summary.querySelector('.czrd-sumserial').textContent = row.display
      summary.querySelector('.czrd-sumtier').textContent = row.tierLabel
        ? row.tierLabel + ' · issued once'
        : 'No reservation fee'
      summary.querySelector('.czrd-sumbase').textContent = money(quote.base)
      summary.querySelector('.czrd-sumfee').textContent =
        quote.fee > 0 ? '+ ' + money(quote.fee) : '—'
      summary.querySelector('.czrd-sumfeerow').style.opacity = quote.fee > 0 ? '' : '.55'
      summary.querySelector('.czrd-sumtotal').textContent = money(quote.total)
      summary.setAttribute('data-show', 'true')
    } else {
      summary.setAttribute('data-show', 'false')
    }

    // The panel is not in the accessibility tree's path of announcement, so the
    // same facts go out once, in a sentence, to anyone listening.
    announce(
      !row
        ? ''
        : quote.fee > 0
          ? row.display + ' selected — ' + money(quote.total) + ' total: ' +
            money(quote.base) + ' for the watch, plus a ' + money(quote.fee) + ' ' +
            (row.tierLabel ? row.tierLabel.toLowerCase() + ' ' : '') + 'reservation fee.'
          : row.display + ' selected · ' + money(quote.total) + ' — no reservation fee.',
    )

    // Anything the status line was still holding — a refusal, a queue
    // confirmation — described the previous number, not this one.
    setStatus('')
  }

  function serialRow(serial) {
    if (!state.chart) return null
    for (let i = 0; i < state.chart.serials.length; i++) {
      if (state.chart.serials[i].n === serial) return state.chart.serials[i]
    }
    return null
  }

  /**
   * The reservation fee on a placed hold, in the market's currency.
   *
   * Read off the hold rather than off the chart row it came from, because the
   * hold is the authoritative quote — it was priced server-side at the moment
   * the number was actually taken, and the chart in front of the shopper may be
   * up to thirty seconds old. `feeInr` is the fallback for a portal that has
   * not been deployed with the export prices yet.
   */
  function holdFee(hold, code) {
    const wanted = code || QUOTE.code
    const book = hold && hold.prices && hold.prices[wanted]
    return Number(book ? book.fee : (hold && hold.feeInr)) || 0
  }

  /**
   * The same fee in the currency the cart will charge.
   *
   * This is the one that goes to `attachFee`, and it must never be the quoted
   * figure: the fee line is matched to a Shopify variant BY ITS PRICE, in the
   * shop's own currency. Handing it €40 when the fee product is priced ₹2,499
   * finds no variant and refuses the whole add-to-cart, which is the loudest
   * failure in this file and the reason the two currencies are tracked apart.
   */
  function holdFeeCharged(hold) {
    return holdFee(hold, MARKET.code)
  }

  /* ---------------------------------------------------------------------
   * Taking the hold, and attaching it to the cart
   * ------------------------------------------------------------------ */

  function confirmSelection() {
    if (state.selected == null || state.holding) return
    state.holding = true

    /**
     * The modal is optional here, and that is what lets the checkout button
     * exist.
     *
     * Everything below — taking the hold, releasing the one being given up,
     * choosing variant mode or fee-line mode, pruning stale fees, attaching the
     * watch — is the only correct way to put a numbered watch in the cart, and
     * a second copy of it behind a different button would be a second answer to
     * how a Crown gets charged. So the checkout button sets `state.selected`
     * and calls this, with no overlay open. `setStatus` is already a no-op without one; this was
     * the only line that assumed it.
     */
    let failure = null
    const cta = state.overlay ? state.overlay.querySelector('.czrd-cta') : null
    if (cta) {
      cta.disabled = true
      cta.textContent = 'Reserving…'
    }
    setStatus('Holding that number…')

    const existing = currentHold()
    /**
     * Read once, here, rather than off `state` further down the chain: the flag
     * is cleared when the modal closes, and the closing happens inside the same
     * promise chain that still needs to know which mode it ran in.
     */
    const adding = state.addAnother
    const editing = state.editing

    /**
     * Which number is being given up, and therefore which hold is released and
     * whose fee line goes.
     *
     * Three modes, one question. Editing names its line explicitly, so the
     * answer is that line's number even when it is not the one this browser
     * last held — with two watches in the cart, changing the FIRST one must not
     * release the second one's hold, which is what reading localStorage would
     * do. Adding gives up nothing at all. An ordinary pick gives up whatever
     * this browser held before.
     */
    const surrendered = editing
      ? { display: editing.display, token: editing.holdToken }
      : adding
        ? { display: null, token: null }
        : { display: existing && existing.display, token: existing && existing.token }

    // Returned so a caller can wait for the whole chain — the checkout button
    // has to know the number is actually in the cart before it sends anyone on.
    return api('/api/serials/hold', {
      method: 'POST',
      body: {
        product: CONFIG.productId,
        serial: state.selected,
        variantId: currentVariantId(),
        // Proof, when we have it. The portal refuses to refresh a hold on a
        // session id alone, so re-picking the number this browser already holds
        // needs the token back.
        holdToken: existing && existing.serial === state.selected ? existing.token : null,
      },
    })
      .then(function (result) {
        if (!result.ok) return refused(result.data)

        const hold = result.data.hold
        rememberHold(hold)

        /**
         * The number they just changed their mind about goes back immediately.
         *
         * AFTER the new hold has been granted, never before. Releasing first
         * would be tidier to read and wrong to run: if the number they are
         * moving TO turns out to have gone in the last thirty seconds, they
         * would be left holding neither — having given up a number they still
         * had in exchange for one they could not get.
         *
         * Skipped when the tokens match, which is the refresh case: re-picking
         * the number this browser already holds renews that hold rather than
         * replacing it, and releasing it here would hand back the number the
         * shopper just asked to keep.
         *
         * WHICH number is being given up is `surrendered`'s answer, and it is
         * not always the one in storage: adding a second watch gives up nothing
         * at all, and changing one of several numbers gives up that line's,
         * which on a two-watch cart is as likely to be the older token as the
         * remembered one. See its declaration above.
         */
        if (surrendered.token && surrendered.token !== hold.token) {
          releaseHoldToken(surrendered.token, 'changed_number')
        }

        /**
         * Two ways to charge the fee, and the product decides which.
         *
         * VARIANT MODE — the product has a fee option, so choosing a number
         * selects the variant that carries it. The theme reprices the page
         * itself, the serial goes onto the form as hidden properties, and the
         * shop's own Add to cart / Buy it now do the rest. The picker closes
         * and gets out of the way.
         *
         * FEE-LINE MODE — no such option, so the watch goes in the cart with
         * its properties and the fee follows as a second line.
         */
        /**
         * Rupees here, deliberately, where everything else on this path is in
         * the shopper's currency. A variant OPTION VALUE is a label an operator
         * typed once — "₹2,499" — and Shopify does not translate it per market
         * the way it translates a price, so the digits in it are rupees in
         * every market and matching them against a euro amount would find
         * nothing. The fee-line path below is the opposite case and uses the
         * market amount, because there the key is a price.
         */
        return selectVariantForFee(hold.feeInr).then(function (outcome) {
          if (outcome.mode === 'variant') {
            if (!outcome.ok) {
              // A variant that does not exist is a setup gap, and saying so
              // beats silently charging the wrong amount.
              throw new Error(
                'This number needs the "' + outcome.missing + '" variant, which this product ' +
                  'does not have yet. Nothing has been changed.',
              )
            }

            /**
             * The properties still go on the form, even though the line is
             * about to be added from here. They are what carries the number if
             * the shopper later presses the theme's own Add to cart or Buy it
             * now — the second of which bypasses the cart entirely — and a
             * dynamic checkout with no serial on it is the one failure this
             * whole system exists to prevent.
             */
            injectProperties(result.data.lineItemProperties)
            refreshGates()

            /**
             * The variant id is taken from `outcome`, not from the form, on
             * both paths below. Selecting a fee variant makes the theme
             * re-render its buy block through the Section Rendering API, which
             * is asynchronous — read a moment too early and currentVariantId()
             * is still the variant the shopper had before they chose a number,
             * so the watch would go into the cart at the wrong price.
             */

            /**
             * Editing rewrites one named line and touches nothing else, so it
             * skips both of the tidy-ups below: clearStaleSerialLines would
             * take the OTHER watch's line with it (it removes every numbered
             * line not on the kept variant), and attachToCart's match-by-
             * variant could just as easily land on that other line and
             * overwrite its number instead of this one's.
             */
            if (editing) {
              return replaceCartLine(editing, result.data.lineItemProperties, String(outcome.variant.id))
                .then(function (added) { return finishReservation(hold, added, adding, editing.display) })
            }

            // Adding a second watch must not tidy away the first one's line,
            // which is exactly what clearStaleSerialLines exists to do when a
            // number is being REPLACED.
            return (adding ? Promise.resolve() : clearStaleSerialLines(String(outcome.variant.id)))
              .then(function () {
                return attachToCart(result.data.lineItemProperties, String(outcome.variant.id), {
                  forceNewLine: adding,
                })
              })
              .then(function (added) { return finishReservation(hold, added, adding) })
          }

          /**
           * No fee option on this product: cart-driven, fee as its own line.
           *
           * The prune runs FIRST and is told which serial is being replaced, so
           * the fee for the number being given up goes with it. It used to
           * remove every fee line in the cart, which is correct for one watch
           * and quietly wrong for two: a shopper reserving a Crown on a second
           * reference lost the fee line for the first, checked out paying one
           * premium instead of two, and only orders/paid noticed — as
           * `assigned_underpaid`, after the money had moved.
           */
          let added = null
          // Adding a second watch replaces nothing, so nothing is pruned — the
          // first watch keeps its line AND its fee line, and this number's fee
          // is added alongside. Editing prunes exactly one: the fee for the
          // number that line is giving up, named by `surrendered` rather than
          // read out of localStorage, which on a two-watch cart is as likely to
          // name the other watch's number.
          return pruneFeeLines(surrendered.display)
            .then(function () {
              if (editing) {
                return replaceCartLine(editing, result.data.lineItemProperties, editing.variant)
              }
              return attachToCart(result.data.lineItemProperties, currentVariantId(), {
                forceNewLine: adding,
              })
            })
            .then(function (attached) {
              added = attached
              return attachFee(holdFeeCharged(hold), hold.display)
            })
            .then(function () {
              return finishReservation(hold, added, adding, editing && editing.display)
            })
        })
      })
      .catch(function (error) {
        setStatus(error && error.message ? error.message : 'Something went wrong. Try again.', 'error')
        /**
         * With no modal open, that line said nothing to anybody.
         *
         * setStatus writes into the popup and returns silently when there is
         * none, which is correct for a status line and became a hole the moment
         * this function could be driven without one. The failure this hides is
         * specific and bad: the hold is taken and remembered before the cart is
         * touched, so a shopper whose cart step failed had a number reserved,
         * an empty cart, and a caller that saw a live hold and concluded all was
         * well. That is exactly "it went to checkout without adding anything".
         *
         * So the modal path keeps the quiet status line, and every other caller
         * gets the error — but only AFTER the cleanup below has run. Throwing
         * from here would skip that `.then` and leave `state.holding` true,
         * which is the flag confirmSelection checks on entry: the button would
         * be dead for the rest of the page's life.
         */
        failure = error
      })
      .then(function () {
        state.holding = false

        /**
         * Only put the button back if the shopper is still choosing. On the
         * success path the modal is a few hundred milliseconds from closing and
         * the number is already in the cart, so re-enabling a button that reads
         * "Reserve this number" invites a second press at the one moment it
         * would contradict the confirmation sitting next to it.
         */
        if (!state.closing) {
          const button = state.overlay ? state.overlay.querySelector('.czrd-cta') : null
          if (button) {
            button.disabled = state.selected == null
            button.textContent = state.editing
              ? 'Swap ' + state.editing.display + ' for this number'
              : 'Reserve this number'
          }
        }

        // Cleanup is done; now the caller may be told. The modal has already
        // shown this on its status line.
        if (failure && !state.overlay) throw failure
      })
  }

  /**
   * Everything that happens once the number is held AND in the cart.
   *
   * One function rather than a few lines repeated in each of the two fee modes,
   * because the four steps are a sequence a shopper reads as one action and any
   * of them missing is a visible bug: the page has to say what was reserved,
   * the clock has to start, the grid has to get out of the way, and the cart has
   * to show what just landed in it.
   *
   * The order is deliberate. The notice is written BEFORE the modal closes, so
   * there is never a frame where the popup has gone and nothing has replaced it;
   * the cart is opened LAST, so the drawer slides over a page that already says
   * what happened underneath it.
   */
  function finishReservation(hold, added, adding, replaced) {
    const fee = holdFee(hold)
    const reducedFrom = added && added.reducedFrom
    state.closing = true
    /**
     * The swap went through, so the page keeps the variant it borrowed — that
     * IS the watch the shopper just worked on. Cleared here rather than in
     * closeModal because closeModal cannot tell a finished edit from an
     * abandoned one, and an abandoned one has to put the variant back.
     */
    if (replaced) {
      state.editing = null
      state.returnVariant = null
    }

    updateButtonLabel(hold.display)
    announceSelection(hold, reducedFrom, adding, replaced)
    startHoldTimer()
    /**
     * The tags are the cart, drawn on the page, so they have to be redrawn from
     * it: a swap changes which numbers are in it, and the rail would otherwise
     * still offer the number that was just given back until the next cart
     * event. Deferred past the cart request that is still settling — the same
     * 400ms watchCartForRemoval waits for, and for the same reason.
     */
    window.setTimeout(refreshCartLineUi, 400)
    refreshGates()

    setStatus(
      hold.display +
        (replaced
          ? ' has replaced ' + replaced
          : adding ? ' has been added as a second watch' : ' is in your cart') +
        ', held for ' + Math.round(hold.holdSeconds / 60) +
        ' minutes.' + (fee > 0 ? ' A ' + money(fee) + ' reservation fee has been added.' : '') +
        // Stated first thing, because it changed what was in their cart.
        (reducedFrom
          ? ' That line is now 1 watch rather than ' + reducedFrom +
            ' — each watch carries its own number.'
          : ''),
    )

    // Long enough to read the confirmation, short enough not to feel stuck.
    window.setTimeout(function () {
      state.closing = false
      closeModal()
      openCart()
    }, 900)

    return null
  }

  /* ---------------------------------------------------------------------
   * The cart
   * ------------------------------------------------------------------ */

  /**
   * Show the shopper their cart.
   *
   * There is no cross-theme way to do this, so it is a ladder of increasingly
   * generic attempts and every rung is allowed to fail. In order:
   *
   *   1. A custom element with an open() method — Dawn and every theme derived
   *      from it ship <cart-drawer> / <cart-notification> exactly like this.
   *   2. The events themes bind their own drawers to. Cheap, and several fire
   *      on names nobody else uses, so all of the common ones go out.
   *   3. A visible toggle to click, which is what a theme with no scriptable
   *      drawer still has.
   *
   * None of these can be verified from here — a theme that ignores all three
   * leaves the shopper on the product page — which is why the on-page notice
   * carries a plain link to /cart regardless, and why `data-open-cart="cart"`
   * exists for a shop that would rather be certain than stay put.
   */
  /**
   * Returns whether the cart was DEFINITELY opened.
   *
   * True only where this function did something whose effect it can see: an
   * element whose own `open()` it called, a visible toggle it clicked, or a
   * navigation it started. Dispatching an event returns false, because a theme
   * that ignores the event is indistinguishable from one that handled it — and
   * a caller that needs the shopper to actually reach their cart has to be able
   * to tell those apart. See onBuyClick, which navigates when this is false.
   */
  function openCart() {
    if (CONFIG.openCart === 'none') return false
    if (CONFIG.openCart === 'cart') {
      window.location.href = '../cart.html'
      return true
    }

    const drawers = document.querySelectorAll(
      'cart-drawer,cart-notification,[data-cart-drawer],#CartDrawer,#cart-drawer',
    )
    for (let i = 0; i < drawers.length; i++) {
      const drawer = drawers[i]
      if (typeof drawer.open === 'function') {
        try {
          drawer.open()
          return true
        } catch (e) { /* a theme's drawer is not ours to break */ }
      }
    }

    const events = ['cart:open', 'cart-drawer:open', 'cart:refresh', 'cart:build', 'drawerOpen']
    for (let i = 0; i < events.length; i++) {
      document.dispatchEvent(new CustomEvent(events[i], { bubbles: true }))
    }

    /**
     * Cart-specific toggles only. A theme's header carries several drawers, and
     * a generic `[data-action="open-drawer"]` is as likely to be the menu; the
     * cart icon itself is usually a plain link to /cart, so clicking it would
     * navigate — which is what 'drawer' mode is specifically not meant to do.
     */
    const toggles = document.querySelectorAll(
      '[data-cart-drawer-toggle],[data-cart-toggle],[data-action="open-cart-drawer"],.js-drawer-open-cart',
    )
    // Only a toggle the shopper could have clicked themselves. Clicking a hidden
    // one can trip a theme into a half-open state nothing will close.
    for (let i = 0; i < toggles.length; i++) {
      const toggle = toggles[i]
      if (toggle.offsetParent === null) continue
      try {
        toggle.click()
        return true
      } catch (e) { /* as above */ }
    }

    // Events were dispatched and nothing here can confirm they landed.
    return false
  }

  /* ---------------------------------------------------------------------
   * The hold countdown, on the page
   *
   * The popup has always shown other people's holds ticking down. This is the
   * shopper's own, and it belongs on the page rather than in the modal because
   * the modal is gone by the time it matters: twelve minutes starts at confirm,
   * and everything they do with it — read the description, change a variant,
   * open the cart — happens with the popup closed.
   *
   * Driven off the stored `expiresAt` rather than by counting seconds down from
   * a starting figure, so a backgrounded tab (where browsers throttle timers to
   * once a minute) shows the right number when it comes back rather than a
   * clock that fell behind by however long it was hidden.
   * ------------------------------------------------------------------ */

  function holdSecondsLeft() {
    const held = currentHold()
    if (!held) return 0

    /**
     * The device's own deadline first, the server's instant second.
     *
     * The local one is immune to a skewed device clock (see `localDeadline`);
     * the absolute one is the fallback for a record written before that field
     * existed, which a shopper mid-hold across this deploy will have.
     */
    const local = Number(held.deadlineLocal)
    const deadline = Number.isFinite(local) && local > 0 ? local : Date.parse(held.expiresAt)

    // A deadline neither route could parse leaves the countdown at zero, which
    // is what `startHoldTimer` reads as "nothing to run" — so the notice sits
    // still rather than ticking down to a lapse this cannot actually verify.
    // The server owns expiry either way; nothing here releases a number.
    if (!Number.isFinite(deadline)) return 0

    const left = Math.round((deadline - Date.now()) / 1000)
    return left > 0 ? left : 0
  }

  function startHoldTimer() {
    stopHoldTimer()
    if (!holdSecondsLeft()) return
    state.holdTimer = window.setInterval(tickHold, 1000)
    tickHold()
  }

  function stopHoldTimer() {
    if (state.holdTimer) window.clearInterval(state.holdTimer)
    state.holdTimer = 0
  }

  function tickHold() {
    const node = document.querySelector('.czrd-chosen__clock')
    const left = holdSecondsLeft()

    if (left > 0) {
      if (node) node.textContent = clock(left)
      return
    }

    stopHoldTimer()
    holdLapsed()
  }

  /* ---------------------------------------------------------------------
   * Keeping the hold and the cart in agreement
   * ------------------------------------------------------------------ */

  /**
   * If the number is no longer in the cart, it is no longer wanted.
   *
   * The shopper removes the watch from the cart drawer, or empties the cart
   * entirely, and Shopify tells this script nothing — the line is gone and the
   * hold behind it is still ours for the rest of its twelve minutes, locking a
   * number nobody is buying. On a drop that is the difference between a Crown
   * being available and being invisible for a quarter of an hour because
   * somebody changed their mind in the first thirty seconds.
   *
   * Matched on the hold token rather than on the serial, because the token is
   * the thing being released and matching it exactly cannot free the wrong one.
   *
   * A cart we could not read is not a cart with the line missing. `/cart.js`
   * failing, or answering with something unexpected, returns early and changes
   * nothing — the failure direction has to be "keep the hold", since the other
   * way round means one network blip hands the shopper's number to somebody
   * else while they are still checking out with it.
   */
  function reconcileHoldWithCart() {
    const held = currentHold()
    if (!held || !held.token) return Promise.resolve(false)
    // Mid-reserve the cart legitimately does not have the line yet.
    if (state.holding) return Promise.resolve(false)
    // A lapsed hold is tickHold's business, and releasing it is pointless.
    if (!holdSecondsLeft()) return Promise.resolve(false)

    return cartState().then(function (cart) {
      if (!cart || !cart.items) return false

      for (let i = 0; i < cart.items.length; i++) {
        const props = cart.items[i].properties || {}
        if (props._czard_hold === held.token) return false
      }

      releaseHoldToken(held.token, 'removed_from_cart')
      holdGivenBack(held)
      return true
    })
  }

  /**
   * The events after which the cart may have changed under us.
   *
   * Themes announce a cart update on names nobody agrees on, so several are
   * listened for and the ones a theme never fires cost nothing. `pageshow` and
   * `visibilitychange` are the two that matter most and are not theme-specific:
   * they cover the shopper who left for /cart, removed the line there, and came
   * back — including via the back button, where `pageshow` fires and `load`
   * does not.
   *
   * Debounced, because a single cart update fires several of these and each one
   * would otherwise be its own `/cart.js` request.
   */
  function watchCartForRemoval() {
    let queued = 0
    const check = function () {
      window.clearTimeout(queued)
      // Long enough for the theme to have finished its own cart request. Asking
      // mid-update reads the cart as it was, which for a removal is a cart that
      // still has the line — a false negative, which is the safe direction, but
      // also a pointless request.
      queued = window.setTimeout(reconcileHoldWithCart, 400)
    }

    const events = ['cart:refresh', 'cart:updated', 'cart:change', 'czard:serial-attached']
    for (let i = 0; i < events.length; i++) document.addEventListener(events[i], check)

    window.addEventListener('pageshow', check)
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) check()
    })
  }

  /**
   * The cart drawer is re-rendered wholesale by the theme after every change,
   * which takes the hidden stepper and the "one number, one watch" note with it.
   * So the tidy-up runs on the same signals, plus a frame-coalesced DOM watch —
   * a drawer that opens without firing an event this script knows about would
   * otherwise show the control again.
   */
  function watchCartDom() {
    enforceSingleQuantity()
    refreshCartLineUi()

    const again = function () {
      enforceSingleQuantity()
      refreshCartLineUi()
    }
    const events = ['cart:refresh', 'cart:updated', 'cart:change', 'czard:serial-attached']
    for (let i = 0; i < events.length; i++) document.addEventListener(events[i], again)

    if (!window.MutationObserver) return
    let queued = false
    new MutationObserver(function () {
      if (queued) return
      queued = true
      window.requestAnimationFrame(function () {
        queued = false
        enforceSingleQuantity()
      })
    }).observe(document.body, { childList: true, subtree: true })
  }

  /**
   * The hold is gone and the shopper did not lose anything by it — they removed
   * the line themselves. Said quietly, in the same place the countdown was, so
   * the page does not still claim to be holding a number it has given back.
   */
  /**
   * Is `held` still the hold this page is carrying?
   *
   * Every caller of the two endings below reaches them through at least one
   * network round trip — restoreHold asks the cart and then the portal,
   * reconcileHoldWithCart asks the cart — and a shopper can reserve a different
   * number while those are in flight. The `held` captured before the await is
   * then a hold that has already been replaced, and acting on it wipes the
   * record of the number they just took: storage goes empty, so the countdown
   * reads 0:00 while the notice beside it still names the new serial, because
   * that half came from the hold object in hand rather than from storage.
   *
   * Compared by token rather than by serial. The token is what identifies one
   * reservation; the same numeral re-picked after a lapse is a different hold
   * and must not be mistaken for the one that was being asked about.
   *
   * A null answer means the record has already gone — nothing to clean up, and
   * a second cleanup would only re-announce an ending the shopper has been told
   * about once.
   */
  function stillHolding(held) {
    const now = currentHold()
    return Boolean(now && held && now.token && now.token === held.token)
  }

  function holdGivenBack(held) {
    if (!stillHolding(held)) return
    forgetHold()
    stopHoldTimer()
    pendingProperties = null
    injectProperties(null)
    refreshGates()

    const button = document.querySelector('.czrd-btn')
    if (button) {
      button.textContent = CONFIG.buttonLabel
      button.removeAttribute('data-has-serial')
    }
    // The hold is gone, so "Proceed to cart" is no longer true.
    refreshBuyButton()

    const note = document.querySelector('.czrd-chosen')
    if (!note) return
    note.setAttribute('data-lapsed', 'true')
    note.innerHTML =
      '<strong>' + escapeHtml(held && held.display ? held.display : 'That number') +
      '</strong> has been given back.' +
      '<span class="czrd-chosen__hold">You took it out of your cart, so it is on the grid again ' +
      'for someone else. Buy now whenever you are ready.</span>'
  }

  /**
   * Take the lapsed number's watch out of the cart, and its reservation fee
   * with it.
   *
   * The line is matched on the HOLD TOKEN, not on the serial and not on the
   * variant. The token is unique to one reservation, so it cannot take a
   * different watch carrying the same reference, and on a two-watch cart it
   * cannot take the sibling line whose own hold is still running — which
   * matching on product id would do, and which would be the worst possible
   * version of this feature.
   *
   * The fee follows because a fee line is not a thing anybody bought: it is a
   * premium attached to a number, named on the line as `_czard_fee_for`.
   * Leaving it would charge ₹2,999 for a Crown that is no longer in the cart.
   * Matched on that property rather than through pruneFeeLines(), which needs
   * the fee variant map to be configured — a shop whose map is missing would
   * silently keep the fee, and a charge for nothing is worse than a tidy-up
   * that is one request longer.
   *
   * Best effort, and silent when the cart cannot be read: this runs on a timer
   * with nobody waiting on it, and the checkout gate still refuses a lapsed
   * serial before payment either way.
   */
  function removeLapsedLine(held) {
    if (!held || !held.token) return Promise.resolve(false)

    return cartState().then(function (cart) {
      if (!cart || !cart.items) return false

      const lines = cart.items.filter(function (item) {
        return (item.properties || {})._czard_hold === held.token
      })
      if (!lines.length) return false

      const serials = lines.map(function (item) { return String((item.properties || {}).Serial) })
      const fees = cart.items.filter(function (item) {
        const belongsTo = (item.properties || {})._czard_fee_for
        return belongsTo && serials.indexOf(String(belongsTo)) !== -1
      })

      return removeCartLines(lines.concat(fees)).then(function () {
        // removeCartLines posts to change.js directly rather than through
        // readCartResponse, so nothing has told the theme yet — without this
        // the drawer keeps showing a line that is no longer in the cart, and
        // the header count is wrong until the next navigation.
        document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }))
        return true
      })
    })
  }

  /**
   * What a lapsed hold does to the page, and now to the cart.
   *
   * It used to leave the line alone, on the reasoning that quietly emptying
   * somebody's cart on a timer is worse than a stale line the checkout gate
   * would refuse anyway. The line goes now, by decision: a cart that still
   * offers a number the shop no longer holds is a promise it cannot keep, and
   * the shopper finds out at the checkout button rather than here, where they
   * can still do something about it.
   *
   * Both halves are stated plainly — the number is loose again AND it has been
   * taken out of the cart — because a line vanishing from a cart with no
   * explanation is the one thing worse than either.
   *
   * The reach of this is the product page: nothing else loads this script, so a
   * shopper sitting on /cart when their twelve minutes run out keeps the line
   * until they come back (restoreHold calls this on the way in) or until the
   * checkout gate refuses it. And it only ever covers the hold this browser is
   * counting down — a second watch's expiry is not knowable here, which is why
   * /revalidate re-takes a lapsed hold that is still free rather than leaving
   * either of them to chance.
   */
  function holdLapsed() {
    const held = currentHold()
    forgetHold()
    pendingProperties = null
    injectProperties(null)
    refreshGates()

    const button = document.querySelector('.czrd-btn')
    if (button) {
      button.textContent = CONFIG.buttonLabel
      button.removeAttribute('data-has-serial')
    }
    // The hold is gone, so "Proceed to cart" is no longer true.
    refreshBuyButton()

    // Reads the cart first, so it can only ever remove a line that is still
    // there — and redraws the tags afterwards, since one of them was that line.
    removeLapsedLine(held).then(function (removed) {
      if (removed) refreshCartLineUi()
    })

    const note = document.querySelector('.czrd-chosen')
    if (!note) return
    note.setAttribute('data-lapsed', 'true')
    note.innerHTML =
      '<strong>' + escapeHtml(held && held.display ? held.display : 'Your number') +
      '</strong> is no longer held.' +
      '<span class="czrd-chosen__hold">The twelve minutes ran out, so it has been taken out of ' +
      'your cart and is back on the grid. Reserve it again if it is still there.</span>'
  }

  function refused(data) {
    const alternatives = (data && data.nearestAvailable) || []
    setStatus(data && data.message ? data.message : 'That number is no longer available.', 'error')

    if (alternatives.length) {
      const body = state.overlay.querySelector('.czrd-body')
      const note = document.createElement('div')
      note.className = 'czrd-note'
      note.innerHTML =
        '<strong>Still available nearby</strong>' +
        '<div class="czrd-alts">' +
        alternatives
          .map(function (n) {
            const row = serialRow(n)
            return '<button type="button" class="czrd-alt" data-serial="' + n + '">' +
              escapeHtml(row ? row.display : String(n)) + '</button>'
          })
          .join('') +
        '</div>'
      body.insertBefore(note, body.firstChild)

      const buttons = note.querySelectorAll('.czrd-alt')
      for (let i = 0; i < buttons.length; i++) {
        buttons[i].addEventListener('click', function (event) {
          note.parentNode.removeChild(note)
          select(Number(event.currentTarget.getAttribute('data-serial')))
        })
      }
    }

    // The refusal means the grid we drew is stale by at least one number.
    return loadChart(true)
  }

  /* ---------------------------------------------------------------------
   * The queue
   * ------------------------------------------------------------------ */

  function offerQueue(serial, button) {
    const row = serialRow(serial)
    if (!row || row.status === 'taken' || row.status === 'withheld') {
      setStatus((row ? row.display : serial) + ' has been sold. It will not come back.', 'error')
      return
    }

    const contact = window.prompt(
      'That number is in someone else’s checkout for the next few minutes.\n\n' +
        'Leave an email and we will offer it to you first if it frees up:',
      '',
    )
    if (!contact) return

    api('/api/serials/queue', {
      method: 'POST',
      body: { product: CONFIG.productId, serial: serial, contact: { email: contact } },
    }).then(function (result) {
      if (!result.ok) {
        setStatus(result.data.message || 'Could not join the queue.', 'error')
        return
      }
      const ticket = result.data.ticket
      setStatus(
        'You are number ' + ticket.position + ' in line for ' + (row ? row.display : serial) +
          '. We will email you if it frees up.',
      )
      if (button) button.setAttribute('aria-label', button.getAttribute('aria-label') + '. You are in the queue.')
    })
  }

  /* ---------------------------------------------------------------------
   * Countdowns
   * ------------------------------------------------------------------ */

  function collectCountdowns(root) {
    state.countdowns = Array.prototype.slice.call(root.querySelectorAll('[data-countdown]'))
  }

  function tickCountdowns() {
    for (let i = 0; i < state.countdowns.length; i++) {
      const node = state.countdowns[i]
      const left = Number(node.getAttribute('data-countdown')) - 1
      node.setAttribute('data-countdown', String(left))
      // The label the tile was rendered with — "Free in " on a tier card, and
      // nothing at all on a 62px grid cell. Read back off the node because this
      // function owns the whole textContent and would drop it otherwise.
      const prefix = node.getAttribute('data-countdown-prefix') || ''
      node.textContent = left > 0 ? prefix + clock(left) : 'Free'
    }
  }

  function clock(seconds) {
    const s = Math.max(0, Math.floor(seconds))
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
  }

  /* ---------------------------------------------------------------------
   * The checkout gate — requirement 6
   * ------------------------------------------------------------------ */

  /**
   * Capture phase, on document, so it runs BEFORE any handler the theme has
   * bound to its own checkout button. A bubble-phase listener would fire after
   * the theme had already submitted the form, which is far too late to say no.
   */
  function installCheckoutGate() {
    document.addEventListener('click', onDocumentClick, true)
    document.addEventListener('submit', onDocumentSubmit, true)
  }

  function isCheckoutTrigger(node) {
    if (!node || !node.closest) return false
    return Boolean(
      node.closest('[name="checkout"]') ||
        node.closest('a[href="/checkout"]') ||
        node.closest('a[href*="/checkout"]') ||
        node.closest('[data-czard-checkout]'),
    )
  }

  let gateCleared = false

  function onDocumentClick(event) {
    if (gateCleared) return
    const trigger = isCheckoutTrigger(event.target)
    if (!trigger) return

    const node = event.target.closest(
      '[name="checkout"],a[href="/checkout"],a[href*="/checkout"],[data-czard-checkout]',
    )

    event.preventDefault()
    event.stopPropagation()
    runGate(function () {
      gateCleared = true
      // Re-dispatch rather than navigate, so the theme's own handler still runs
      // (analytics, discount fields, anything else it does on the way out).
      if (node) node.click()
      window.setTimeout(function () { gateCleared = false }, 4000)
    })
  }

  function onDocumentSubmit(event) {
    if (gateCleared) return
    const form = event.target
    if (!form || !form.getAttribute) return
    const action = form.getAttribute('action') || ''
    if (action.indexOf('/cart') === -1 && action.indexOf('/checkout') === -1) return
    // A cart form submitted by the update button is not a checkout.
    if (!form.querySelector('[name="checkout"]')) return

    event.preventDefault()
    event.stopPropagation()
    runGate(function () {
      gateCleared = true
      form.submit()
      window.setTimeout(function () { gateCleared = false }, 4000)
    })
  }

  /**
   * Revalidate everything in the cart, then either let the click through or
   * explain which number went and what is left near it.
   *
   * A network failure lets the shopper through. Blocking checkout because our
   * own endpoint is unreachable turns a portal outage into a storefront outage,
   * and the webhook path still catches a genuine collision at orders/paid —
   * where it becomes a refund rather than a lost sale.
   */
  function runGate(proceed) {
    /**
     * Put back any deleted fee BEFORE revalidating, not after.
     *
     * The order matters. Repairing first means the shopper either goes to
     * checkout paying the right amount, or is told why they cannot — never
     * through the gate with a Crown at the plain price. Doing it after would
     * hand the click through and add the fee to a cart nobody is looking at any
     * more.
     *
     * A failure here does not block: if the fee variants cannot be resolved,
     * that is our configuration being wrong, and taking the storefront down
     * over it is worse than the shortfall. `assigned_underpaid` at orders/paid
     * still catches it, where it is a refund conversation rather than a lost
     * sale.
     */
    ensureFeeLines().catch(function () {}).then(function () {
      return serialsInCart()
    }).then(function (items) {
      if (!items.length) {
        proceed()
        return
      }

      api('/api/serials/revalidate', {
        method: 'POST',
        body: { items: items },
      }).then(
        function (result) {
          if (result.ok && result.data.ok) {
            proceed()
            return
          }
          showGateFailure(result.data, items)
        },
        function () {
          proceed()
        },
      )
    })
  }

  function showGateFailure(data, items) {
    injectStyles()
    const failed = ((data && data.items) || []).filter(function (item) {
      return item.status !== 'held' && item.status !== 'ok'
    })

    /**
     * Two quite different refusals arrive through this one panel, and they need
     * different words and different buttons.
     *
     * A number that has GONE is somebody else's completed checkout: nothing the
     * shopper can undo, and the only way forward is another number.
     *
     * A quantity conflict is the shopper's own cart being impossible — one
     * number, three watches — and it is entirely fixable, in one press, without
     * giving up the number they chose. Offering "own another number" for that
     * would be answering a question nobody asked.
     */
    const quantityRows = failed.filter(function (row) { return row.reason === 'quantity_conflict' })
    const fixableOnly = quantityRows.length === failed.length && quantityRows.length > 0

    // The local cart line behind a server row, matched on product and serial —
    // the server does not echo the line key, and the key is what /cart/change.js
    // needs to put the quantity right.
    const lineFor = function (row) {
      for (let i = 0; i < items.length; i++) {
        if (String(items[i].product) === String(row.product) && Number(items[i].serial) === Number(row.serial)) {
          return items[i]
        }
      }
      return null
    }

    const overlay = document.createElement('div')
    overlay.className = 'czrd-overlay'
    overlay.setAttribute('data-lenis-prevent', '')
    overlay.setAttribute('role', 'alertdialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute(
      'aria-label',
      fixableOnly ? 'One number, one watch' : 'A number is no longer available',
    )

    const rows = failed.length ? failed : items
    overlay.innerHTML =
      '<div class="czrd-modal">' +
      '<div class="czrd-head">' +
      '<button type="button" class="czrd-close" aria-label="Close">&times;</button>' +
      '<h2 class="czrd-title">' +
      (fixableOnly ? 'One number, one watch' : 'That number is no longer available') +
      '</h2>' +
      '<p class="czrd-sub">' +
      escapeHtml(
        (data && data.message) ||
          (fixableOnly
            ? 'A number is engraved on one watch, so a line carrying a number can only be for one. ' +
              'Nothing has been charged.'
            : 'Someone completed their checkout first. Your cart has not been changed.'),
      ) +
      '</p></div>' +
      '<div class="czrd-body" data-lenis-prevent>' +
      rows
        .map(function (item, index) {
          const alts = item.nearestAvailable || []
          const fixable = item.reason === 'quantity_conflict' && lineFor(item)
          return (
            '<div class="czrd-note"><strong>' +
            escapeHtml(String(item.display || item.serial)) +
            '</strong><br>' +
            escapeHtml(item.message || 'No longer available.') +
            (fixable
              ? '<div class="czrd-alts">' +
                '<button type="button" class="czrd-alt" data-czrd-fix="' + index + '">' +
                'Make it 1 watch</button></div>'
              : '') +
            (alts.length
              ? '<div class="czrd-alts">' +
                alts.map(function (n) { return '<span class="czrd-alt">' + n + '</span>' }).join('') +
                '</div>'
              : '') +
            '</div>'
          )
        })
        .join('') +
      '</div>' +
      '<div class="czrd-foot">' +
      '<p class="czrd-status">' +
      (fixableOnly
        ? 'Fix the quantity to carry on, or buy the second watch with a number of its own.'
        : 'Own another number to continue.') +
      '</p>' +
      (fixableOnly
        ? ''
        : '<button type="button" class="czrd-cta" data-czrd-pick>Own another number</button>') +
      '</div></div>'

    document.body.appendChild(overlay)

    function dismiss() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
    }
    overlay.querySelector('.czrd-close').addEventListener('click', dismiss)
    overlay.addEventListener('click', function (event) { if (event.target === overlay) dismiss() })

    const pick = overlay.querySelector('[data-czrd-pick]')
    if (pick) {
      pick.addEventListener('click', function () {
        dismiss()
        forgetHold()
        openModal()
      })
    }

    /**
     * Set the offending line back to one and re-run the gate, so a shopper who
     * fixes the only problem goes straight through to checkout rather than
     * having to find the button again.
     */
    const fixes = overlay.querySelectorAll('[data-czrd-fix]')
    for (let i = 0; i < fixes.length; i++) {
      fixes[i].addEventListener('click', function (event) {
        // Captured now rather than read off the event inside the callbacks:
        // `currentTarget` is only set while the event is being dispatched and is
        // null by the time a promise resolves.
        const button = event.currentTarget
        const row = rows[Number(button.getAttribute('data-czrd-fix'))]
        const line = row && lineFor(row)
        if (!line || !line.key) return

        button.disabled = true
        button.textContent = 'Fixing…'

        fetch('../cart/change.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ id: line.key, quantity: 1 }),
        })
          .then(readCartResponse)
          .then(function () {
            dismiss()
            // Straight back through the gate, so a shopper who has fixed the
            // only problem carries on to checkout rather than having to find
            // the button again.
            runGate(function () { window.location.href = '/checkout' })
          })
          .catch(function () {
            button.disabled = false
            button.textContent = 'Make it 1 watch'
          })
      })
    }
  }

  /* ---------------------------------------------------------------------
   * The button
   * ------------------------------------------------------------------ */

  /**
   * Where the button goes, in order of how much the merchant meant it.
   *
   * The first entry is the one to use. A theme's product page is a stack of
   * blocks the merchant arranges in the editor, and no selector this file could
   * guess will put the button where they actually want it — beside the
   * description, under the price, above the size guide. So the preferred mount
   * is an empty element THEY place: drop a Custom liquid block wherever it
   * belongs and put `<div data-czard-picker></div>` in it. The button lands
   * exactly there and moves when they move the block.
   *
   * The rest are fallbacks so the picker still appears on a page nobody has
   * prepared. They end at the add-to-cart form, which every Shopify theme has
   * because Shopify generates it.
   */
  const MOUNTS = [
    '[data-czard-picker]',
    'form[action*="/cart/add"] [type="submit"]',
    'form[action*="/cart/add"]',
    '.product-form__buttons',
    '.product-form',
    '.product__info-wrapper',
  ]

  /**
   * Tell a one-click checkout provider that this button is already spoken for.
   *
   * GoKwik's storefront snippet walks every button, anchor and input on the
   * page, normalises the label, and CLAIMS anything whose text contains one of
   * its trigger words — "checkout", "buynow", "paynow" and the rest. Claiming
   * means `replaceButton`: it clones the node and swaps the clone in, and a
   * clone does not carry addEventListener handlers. So both of our buttons were
   * being quietly replaced by copies with no listeners on them.
   *
   * The labels are not a coincidence that can be renamed away. Both of ours —
   * the picker's "Buy now" and the second button's "Buy Now" — hit BUYNOW_TEXT,
   * and those are the words the buttons should say: picking worse English to
   * dodge a substring match would be the wrong repair, and the next provider
   * has a different list anyway.
   *
   * `data-gokwik-processed` is the marker its own code checks first and returns
   * on, so setting it means "already handled, leave it". It is provider-
   * specific and named as such; there is no vendor-neutral way to say this.
   *
   * We are not opting OUT of GoKwik — goToCheckout opens it deliberately, after
   * the watch is in the cart. What this prevents is GoKwik opening it INSTEAD,
   * on a click we never saw, with an empty cart: which is exactly what the
   * storefront console showed.
   */
  function keepOurButton(node) {
    try {
      node.dataset.gokwikProcessed = 'true'
    } catch (e) {
      /* a browser without dataset still gets a working button, just a claimable one */
    }
  }

  function injectButton() {
    if (document.querySelector('.czrd-btn')) return
    injectStyles()

    let anchor = null
    if (CONFIG.mount) anchor = document.querySelector(CONFIG.mount)
    for (let i = 0; !anchor && i < MOUNTS.length; i++) anchor = document.querySelector(MOUNTS[i])

    // No known mount point. The theme keeps its own add-to-cart and the shopper
    // simply does not get a picker — never a thrown error that breaks the page.
    if (!anchor) return

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'czrd-btn'
    button.textContent = CONFIG.buttonLabel
    button.addEventListener('click', openModal)
    keepOurButton(button)

    /**
     * The second button, under the first, in two states.
     *
     * Without a number chosen it reads "Buy Now" and takes one —
     * the lowest
     * free, which is what `autoAssignStrategy: 'lowest_available'` already means
     * everywhere else in this system — then goes to checkout. That is the path
     * for the shopper who does not care which number they get, and until now the
     * only way to serve them was the theme's own Add to cart, which attaches no
     * number at all and produces exactly the orders this whole subsystem exists
     * to prevent.
     *
     * With a number held it reads "Proceed to cart" and opens the drawer. Same
     * button, because to the shopper it is the same intention — finish — and
     * splitting it in two would put a checkout button next to a number they
     * chose, which reads as an offer to buy a DIFFERENT one.
     */
    const buy = document.createElement('button')
    buy.type = 'button'
    buy.className = 'czrd-buy'
    buy.addEventListener('click', onBuyClick)
    keepOurButton(buy)

    /**
     * A placeholder is filled; a submit button is preceded; anything else is
     * appended.
     *
     * The middle case is the one worth stating: inserting BEFORE the submit
     * button rather than after it puts "Buy now" above Add to cart, which
     * is the order the shopper needs to do them in. Appending would offer the
     * two as if they were alternatives.
     */
    if (anchor.hasAttribute('data-czard-picker')) {
      anchor.appendChild(button)
      anchor.appendChild(buy)
    } else if (anchor.tagName === 'BUTTON' || anchor.getAttribute('type') === 'submit') {
      anchor.parentNode.insertBefore(button, anchor)
      // After the picker button and still before the theme's submit, so the
      // order down the page is: choose a number, buy, then the shop's own
      // Add to cart.
      anchor.parentNode.insertBefore(buy, anchor)
    } else {
      anchor.appendChild(button)
      anchor.appendChild(buy)
    }

    const held = currentHold()
    if (held && held.display) updateButtonLabel(held.display)

    refreshBuyButton()
    refreshCartLineUi()
  }

  /**
   * Put the second button into the state the page is actually in.
   *
   * Called from everywhere the hold changes rather than left to the click to
   * work out, because the label is a promise about what the button will do and
   * the two must not disagree — a button reading "Buy Now" that
   * opens a drawer,
   * or "Proceed to cart" that silently takes a second number, is worse than
   * either alone.
   */
  function refreshBuyButton() {
    const buy = document.querySelector('.czrd-buy')
    if (!buy) return
    const held = currentHold()
    const has = Boolean(held && held.display && holdSecondsLeft() > 0)
    buy.textContent = has ? 'Proceed to cart' : 'Buy Now'
    buy.setAttribute('data-mode', has ? 'cart' : 'buy')
  }

  /**
   * Checkout, or cart — decided at the click, not at the last redraw.
   *
   * Re-read here because a hold can lapse between the two: the label is
   * refreshed on hold events and on the timer, and a shopper who left the tab
   * open through the last second of a countdown would otherwise press a button
   * that says "Proceed to cart" and be sent to a cart the number has just left.
   */
  function onBuyClick() {
    const held = currentHold()
    if (held && held.display && holdSecondsLeft() > 0) {
      /**
       * The button says "Proceed to cart", so the shopper reaches their cart.
       *
       * openCart() prefers the theme's drawer, and on a theme whose drawer it
       * cannot recognise it did nothing at all — it walks a fixed list of
       * selectors (cart-drawer, #CartDrawer, [data-cart-drawer]), and this shop
       * calls its drawer #MinimogCartDrawer, so every one of them missed and
       * the button was dead. Firing the events is the last thing it tries and
       * no theme is obliged to listen.
       *
       * Navigating is not a lesser outcome here. A button labelled proceed that
       * goes to /cart has kept its promise; one that silently does nothing has
       * not, and the shopper has no way to tell it apart from a broken page.
       */
      // `none` is an operator saying "never take the shopper to the cart", and
      // a fallback that navigated anyway would be this file overruling them.
      if (!openCart() && CONFIG.openCart !== 'none') window.location.href = '../cart.html'
      return
    }
    buyNow()
  }

  /**
   * Where "Buy Now" actually goes.
   *
   * Three answers, best first, because a shop's checkout is not always
   * Shopify's. GoKwik and the other one-click providers replace it, and they do
   * so in two different shapes depending on the install: some hand you a URL,
   * some expose an SDK you call. Hard-coding `/checkout` served neither, and
   * hard-coding GoKwik would serve only one of them.
   *
   *   1. A `czard:checkout` event, cancelable. A theme — or the provider's own
   *      snippet — listens, calls preventDefault(), and takes over. This is the
   *      hook for an SDK, e.g. gokwikSdk.initCheckout(), and it carries the
   *      hold so the handler knows which number is in the cart.
   *   2. `data-checkout-url` on the script tag, for a provider that is just a
   *      URL. `{cart}` in it is replaced with the cart token when there is one.
   *   3. /checkout — Shopify's own, unchanged.
   *
   * The cart is already correct before any of this runs: the watch is in it
   * with its serial attached, and runGate has repaired any missing fee. So a
   * provider that reads the Shopify cart sees exactly what Shopify would have.
   */
  /**
   * Shopify's cart token, from the cookie it sets.
   *
   * Read from the cookie rather than /cart.js because this runs on the way to
   * a redirect and an await here would be a request the browser may abandon
   * mid-flight. An empty answer is fine: a provider that needs the token
   * usually reads the same cookie itself.
   */
  function cartToken() {
    const match = /(?:^|;\s*)cart=([^;]+)/.exec(document.cookie || '')
    return match ? decodeURIComponent(match[1]) : ''
  }

  function goToCheckout() {
    const held = currentHold()
    const detail = {
      serial: held && held.display,
      productId: CONFIG.productId,
      variantId: currentVariantId(),
    }

    const event = new CustomEvent('czard:checkout', { bubbles: true, cancelable: true, detail })
    // A handler that calls preventDefault() has taken responsibility for
    // getting the shopper paid, and navigating underneath it would abandon
    // whatever it just opened.
    if (!document.dispatchEvent(event)) return

    /**
     * A one-click provider that is ON THE PAGE rather than at a URL.
     *
     * GoKwik and its like load an SDK and open their checkout over the
     * storefront, so there is nowhere to navigate to — the whole point is that
     * the shopper does not leave. When one is present it is preferred, because
     * a redirect to /checkout on a store whose checkout has been replaced is
     * the slower version of the same journey at best, and a dead end at worst.
     *
     * ...but only where that provider can actually take the money.
     *
     * GoKwik serves India. Its own snippet knows this — `_initWithCountryCheck`
     * reads /browsing_context_suggestions.json and stands down when the visitor
     * is not in India — and that path only runs when `gokwikIntlFlow` is true.
     * On this storefront the flag is false, so it claims every buy button for
     * every visitor on earth and hands an India-only checkout to shoppers it
     * cannot serve. International payment here is PayPal, which lives behind
     * Shopify's own checkout — the one GoKwik has taken over.
     *
     * So the market decides, from `Shopify.country`, which is Shopify's own
     * answer for the market this visitor resolved to. Outside India the SDK is
     * skipped and the shopper goes to Shopify's checkout, where PayPal is. This
     * does not depend on the theme's flag being corrected; it is correct either
     * way, and correct if the flag is later turned on.
     *
     * Wrapped, and falling through on failure. This calls into somebody else's
     * script whose signature this file cannot verify; if it throws or is a
     * half-loaded stub, the shopper still gets a checkout rather than a button
     * that silently did nothing. The cart is already correct at this point, so
     * every route below leads to the same order.
     */
    const country = String((window.Shopify && window.Shopify.country) || '').toUpperCase()
    // Unknown country is treated as domestic: this storefront's home market is
    // India, and the SDK's own country check is the backstop if it is wrong.
    const sdk = country && country !== 'IN' ? null : window.gokwikSdk
    if (sdk && typeof sdk.initCheckout === 'function') {
      try {
        // `window.merchantInfo` is the argument GoKwik's own OCC snippet passes
        // — read out of the storefront's installed copy rather than guessed.
        // Undefined on a page where the snippet has not set it yet, which the
        // SDK treats the same way it does for its own buttons.
        sdk.initCheckout(window.merchantInfo)
        return
      } catch (e) {
        if (window.console && console.warn) {
          console.warn('[czard] gokwikSdk.initCheckout failed; falling back to the checkout URL', e)
        }
      }
    }

    if (CONFIG.checkoutUrl) {
      window.location.href = CONFIG.checkoutUrl.replace('{cart}', cartToken() || '')
      return
    }
    window.location.href = '../checkouts/cn/hWNH7bM8OalwXjS7rqx0j1wy/en-ina7d2.html'
  }

  /**
   * Take the lowest free number and go to checkout.
   *
   * The number is chosen from the chart the popup already loads, not from a new
   * endpoint: `state.chart` is at most thirty seconds old and the hold request
   * is the authority regardless — if the number goes in that window the portal
   * refuses and the next one is tried. Three attempts, because losing the same
   * race three times running means the chapter is genuinely contended and a
   * fourth silent retry is just a slower failure.
   *
   * Everything after the choice is `confirmSelection`, unchanged, so a number
   * taken this way gets the same reservation fee, the same variant handling and the same cart
   * repair as a number picked by hand.
   */
  let buying = false

  /**
   * Try the next number, or stop and say which way it failed.
   *
   * The two failures want different words. A number taken from under us in the
   * seconds since the chart loaded is a race worth retrying and, if it keeps
   * happening, worth telling somebody to go and choose by hand. A number held
   * but not in the cart is a configuration fault — the variant this number
   * needs does not exist, most often — and retrying a different number will
   * fail identically, so the third attempt is not silence, it is a sentence
   * naming what to look at.
   */
  function retryOrGiveUp(attempt, reason) {
    const next = (Number(attempt) || 0) + 1
    if (next < 3) {
      buying = false
      return buyNow(next)
    }
    throw new Error(
      reason === 'not-in-cart'
        ? 'That number was reserved but would not go into the cart. Open the picker and choose one — ' +
          'it will say what is wrong.'
        : 'That number went while we were taking it. Try choosing one yourself.',
    )
  }

  function buyNow(attempt) {
    if (buying) return Promise.resolve()
    buying = true

    const buy = document.querySelector('.czrd-buy')
    if (buy) {
      buy.disabled = true
      buy.textContent = 'Reserving…'
    }

    // Set when the cart already holds this watch and checkout has been opened
    // without reserving anything. Everything after that point is about a number
    // this click did not take, and would retry its way into adding one.
    let settled = false

    /**
     * The variant is settled BEFORE the number is taken, not after.
     *
     * confirmSelection reads `currentVariantId()` when it attaches the line, so
     * a variant applied afterwards would put the watch in the cart on whatever
     * the page happened to be showing — a Lifetime, if the shopper had clicked
     * it — while the button had promised the basic one. Selecting first also
     * lets the theme reprice the page before anything is added, so the figure
     * on screen is the figure being charged.
     */
    const ready = Promise.all([
      state.chart ? Promise.resolve() : loadChart(true),
      applyDefaultVariant({ force: true }),
    ])

    return Promise.resolve(ready)
      .then(function () {
        /**
         * If this watch is already in the cart, take it to checkout as it is.
         *
         * Between them the last two changes made this the third possible
         * outcome and the only correct one. Replacing the line deleted a watch
         * somebody had chosen by hand; adding a line put two of the same watch
         * in the basket, because `forceNewLine` posts /cart/add.js rather than
         * updating the line for that variant. Neither is what "proceed" means.
         *
         * Scoped to THIS product. Another reference already in the cart is a
         * second watch the shopper wants and this one is a third; only a line
         * for the product whose page they are standing on makes taking a new
         * number redundant.
         */
        return serialsInCart().then(function (items) {
          const already = items.filter(function (item) {
            return String(item.product) === String(CONFIG.productId)
          })
          if (already.length) return 'already'
          return null
        })
      })
      .then(function (already) {
        if (already) {
          settled = true
          return runGate(goToCheckout)
        }

        const rows = (state.chart && state.chart.serials) || []

        /**
         * The lowest FEE-FREE number, not simply the lowest.
         *
         * The lowest available number in a fresh chapter is 001, which is a
         * Crown carrying a ₹2,999 premium. A shopper who presses a button
         * labelled "Buy Now" has said they do not want to choose;
         * handing them the most expensive number in the drop and adding a
         * premium they never saw is not a default, it is an upsell they did not
         * agree to. Anyone who wants a Crown can open the picker and take one.
         *
         * `premiumInr` is the chart's own figure for what the number costs on
         * top of the watch, so this needs no second opinion about which tiers
         * are free.
         */
        const free = rows.filter(function (r) {
          return r.status === 'available' && !(Number(r.premiumInr) > 0)
        })
        if (!free.length) {
          throw new Error(
            rows.some(function (r) { return r.status === 'available' })
              ? 'Only premium numbers are left in this chapter. Open the picker to choose one.'
              : 'Every number in this chapter is taken.',
          )
        }

        // `n` is the numeral on a chart row — `serialNumeral` is the hold API's
        // name for it, and reading that here left `state.selected` undefined,
        // which confirmSelection treats as "nothing chosen" and returns from.
        const skip = Number(attempt) || 0
        const chosen = free[Math.min(skip, free.length - 1)]
        state.selected = chosen.n

        /**
         * Add alongside whatever is already in the cart, never in place of it.
         *
         * This ran as an ordinary pick, which means "the shopper has changed
         * their mind about a number" — and confirmSelection acts on that:
         * clearStaleSerialLines removes every numbered line for this product on
         * another variant, and `surrendered` hands back the hold on the number
         * they had. Correct when somebody reopens the picker to swap a number.
         * Wrong here, where the shopper pressed a button that says proceed:
         * a watch already in their basket was deleted on the way to paying for
         * a different one.
         *
         * `addAnother` is the mode that already means what this needs — keep
         * what is there, force a new line, give up nothing, prune no fee that
         * belongs to another watch. On an empty cart it behaves identically, so
         * this is not a special case, it is the honest description of what the
         * button does.
         */
        state.addAnother = true
        state.editing = null
        return confirmSelection()
      })
      .then(function () {
        /**
         * The test is the CART, not the hold.
         *
         * This used to check that a hold existed and conclude the watch was in
         * the basket. Those are two different facts and the gap between them is
         * where the bug lived: the hold is taken and written to storage before
         * the cart is touched, so a failure in the attach step — a fee variant
         * that does not exist, a theme that re-rendered mid-flight — left a live
         * hold, an empty cart, and this function cheerfully opening checkout.
         *
         * Asking the cart directly costs one /cart.js read on a path that is
         * about to leave the page anyway, and it is the only question worth
         * asking here: checkout is meaningless without a line in it.
         */
        if (settled) return undefined

        const held = currentHold()
        if (!held || holdSecondsLeft() <= 0) return retryOrGiveUp(attempt, 'gone')

        return serialsInCart().then(function (items) {
          const inCart = items.some(function (item) {
            return String(item.display) === String(held.display)
          })
          if (!inCart) return retryOrGiveUp(attempt, 'not-in-cart')
          return runGate(goToCheckout)
        })
      })
      .catch(function (error) {
        window.alert(
          (error && error.message) ||
            'That did not go through. Try Buy now and choose one yourself.',
        )
      })
      .then(function () {
        buying = false
        const el = document.querySelector('.czrd-buy')
        if (el) el.disabled = false
        refreshBuyButton()
      })
  }

  /* ---------------------------------------------------------------------
   * What is already in the cart, on the page
   * ------------------------------------------------------------------ */

  /**
   * The numbered lines for this product, as the tags last drew them.
   *
   * Kept because a tag click has to hand `confirmSelection` the whole LINE —
   * key, variant, hold token — and an attribute on a button can only carry a
   * key. Rewritten on every redraw, so a tag whose line has since gone finds
   * nothing here and does nothing, which is the right answer.
   */
  let cartLines = []

  /**
   * Redraw everything under the picker button that describes the cart.
   *
   * One /cart.js read feeding both renderers, because they are two views of the
   * same answer: which numbers are in the cart. Two reads would also be two
   * chances for them to disagree — a rail of three tags over a button that says
   * two — for no benefit.
   */
  function refreshCartLineUi() {
    if (!document.querySelector('.czrd-btn')) return

    serialsInCart()
      .then(function (items) {
        cartLines = items.filter(function (item) {
          return String(item.product) === String(CONFIG.productId)
        })
        renderNumberTags(cartLines)
        renderAnotherButton(cartLines)
      })
      .catch(function () { /* no cart, no tags and no second button */ })
  }

  /* ---------------------------------------------------------------------
   * The number tags
   * ------------------------------------------------------------------ */

  /**
   * The pencil on each tag — the one thing that says a tag is a control rather
   * than a label. Drawn rather than typed: a "✎" is a font question on a page
   * whose font this file does not choose, and the theme's own face is as likely
   * to render it as a box.
   */
  const TAG_PENCIL =
    '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
    '<path d="M7.6 1.9l2.5 2.5M1.6 7.9l6-6 2.5 2.5-6 6-3.2.7z" ' +
    'stroke="currentColor" stroke-width="1" stroke-linejoin="round"></path></svg>'

  /**
   * Every number in the cart, as a row of tags, each one a way back into the
   * grid to change THAT number.
   *
   * The problem it solves only exists above one watch. With a single number the
   * page already says everything: the button reads "TC-0042 — change number"
   * and pressing it changes that number, because there is nothing else it could
   * mean. Add a second and both of those become ambiguous — the button names
   * one of two numbers, and "change number" silently means the last one
   * reserved. A shopper who bought a Crown for themselves and an ordinary
   * number for their brother had no way to reach the first one again except by
   * emptying the cart.
   *
   * So the tags are drawn only from two up, and each one is the whole
   * affordance: it names a number, and clicking it opens the picker against
   * that watch. Rendered next to the picker button, in the product details
   * block, because that is where a shopper looks for what they have chosen.
   *
   * Rebuilt only when the numbers actually change (`data-signature`) — a cart
   * event fires several times per update and rebuilding on each would take
   * focus out of a tag the moment a keyboard user landed on it.
   */
  function renderNumberTags(mine) {
    const button = document.querySelector('.czrd-btn:not(.czrd-btn--another)')
    const existing = document.querySelector('.czrd-tags')

    if (!button || mine.length < 2) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
      return
    }

    const signature = mine.map(function (item) {
      return String(item.key) + '=' + String(item.display)
    }).join('|')
    if (existing && existing.getAttribute('data-signature') === signature) return

    let html =
      '<span class="czrd-tags__lede">Tap a number to change it</span>' +
      '<span class="czrd-tags__row">'
    for (let i = 0; i < mine.length; i++) {
      const item = mine[i]
      html +=
        '<button type="button" class="czrd-tag" data-czrd-key="' + escapeHtml(item.key) + '" ' +
        'aria-label="Change ' + escapeHtml(item.display) +
        (item.tier ? ', ' + escapeHtml(item.tier) : '') + '">' +
        '<span class="czrd-tag__n">' + escapeHtml(item.display) + '</span>' +
        TAG_PENCIL +
        '</button>'
    }
    html += '</span>'

    if (existing) {
      existing.setAttribute('data-signature', signature)
      existing.innerHTML = html
      return
    }

    const rail = document.createElement('div')
    rail.className = 'czrd-tags'
    rail.setAttribute('role', 'group')
    rail.setAttribute('aria-label', 'Numbers in your cart')
    rail.setAttribute('data-signature', signature)
    rail.innerHTML = html
    // Delegated, so the listener survives every rebuild above rather than being
    // re-attached to each of two to five buttons on every cart event.
    rail.addEventListener('click', onTagClick)

    // After the notice if there is one, so the order reads: what just happened,
    // then everything you hold, then what you may add.
    const anchor = document.querySelector('.czrd-chosen') || button
    anchor.parentNode.insertBefore(rail, anchor.nextSibling)
  }

  function onTagClick(event) {
    const tag = event.target && event.target.closest ? event.target.closest('.czrd-tag') : null
    if (!tag) return

    const key = tag.getAttribute('data-czrd-key')
    const line = cartLines.filter(function (item) { return String(item.key) === String(key) })[0]
    // A tag whose line has gone — removed in another tab, or in the drawer
    // between the last redraw and this click. The next cart event redraws the
    // rail without it; opening the picker against a line that no longer exists
    // would put the number back on nothing.
    if (!line) {
      refreshCartLineUi()
      return
    }

    beginEdit(line)
  }

  /**
   * Open the grid against one particular watch.
   *
   * The variant is adopted BEFORE the popup opens, and that is the whole
   * subtlety here: every price in the grid is quoted against the variant the
   * page currently has selected, and the line being edited is routinely not on
   * it — a second watch is often the other warranty, ₹2,500 away. Opening
   * without this shows the shopper a grid priced for the watch they are not
   * editing, and then leaves the line on its own variant anyway, so the figure
   * they decided on is not the figure they are charged.
   *
   * Adopting it means the page, the popup and the line all describe the same
   * watch for as long as the popup is open. It also moves the theme's warranty
   * control, which is honest rather than surprising: the shopper asked to work
   * on that watch, and this is what that watch is.
   */
  function beginEdit(line) {
    state.addAnother = false
    state.editing = line
    /**
     * Where to put the page back if they change their mind.
     *
     * Adopting the line's variant is right while the edit is happening and
     * wrong the moment it is abandoned: a shopper who opens a tag out of
     * curiosity and presses Escape would be left on a warranty they never
     * chose — and, worse, would then add their NEXT watch on it. closeModal
     * restores this unless the swap actually went through.
     */
    state.returnVariant = currentVariantId()
    adoptVariant(line.variant)
    openModal()
  }

  /**
   * Point the page — form, theme, warranty control — at a variant.
   *
   * Shared by the two directions of an edit: adopting the edited line's variant
   * on the way in, and putting the shopper's own back on the way out.
   */
  function adoptVariant(variantId) {
    if (!variantId || String(variantId) === String(currentVariantId())) return

    // Enough of a variant for applyVariant, which only ever reads `.id` — the
    // form input and the events are the contract, not the object.
    applyVariant({ id: variantId })

    // The visible control, best effort and asynchronous: productJson() is
    // memoised, so on any page where the popup has been opened before this is
    // already resolved and the control moves in the same frame.
    productJson().then(function (product) {
      const idx = warrantyOptionIndex(product)
      if (idx === -1) return
      const variant = product.variants.filter(function (v) {
        return String(v.id) === String(variantId)
      })[0]
      if (variant) syncWarrantyControl(variant.options[idx])
    })
  }

  /* ---------------------------------------------------------------------
   * A second watch, with a second number
   * ------------------------------------------------------------------ */

  /**
   * "Add another watch" — the answer to the question the cart's quantity
   * stepper used to ask badly.
   *
   * A number is engraved on ONE watch, so a line that says TS-0044 and quantity
   * 2 cannot be made: the second watch has no number. The stepper offered that
   * anyway, and the shopper found out at checkout, or not at all.
   *
   * The honest version of what they were reaching for is this: reserve a second
   * number and add it as its own cart line. Shopify keys a line on variant AND
   * properties, so two numbers on the same reference are two lines without
   * anything clever — the whole feature is "do not merge, and do not release the
   * first hold on the way".
   *
   * Only rendered once there is something to add ANOTHER of, because before that
   * it is a second button that does what the first one does.
   */
  function renderAnotherButton(mine) {
    const button = document.querySelector('.czrd-btn:not(.czrd-btn--another)')
    if (!button) return

    const existing = document.querySelector('.czrd-btn--another')

    if (!mine.length) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
      return
    }

    const label =
      'Add another watch — ' + mine.length + ' number' +
      (mine.length === 1 ? '' : 's') + ' in your cart'

    // Last of the three, whichever of them exist. Re-placed rather than only
    // placed, because the tag rail appears on the second number — after this
    // button was already sitting directly under the notice — and a rail drawn
    // below "Add another watch" reads as a list of what that button would add.
    const anchor = document.querySelector('.czrd-tags') ||
      document.querySelector('.czrd-chosen') || button

    if (existing) {
      existing.textContent = label
      if (anchor.nextSibling !== existing) {
        anchor.parentNode.insertBefore(existing, anchor.nextSibling)
      }
      return
    }

    const another = document.createElement('button')
    another.type = 'button'
    another.className = 'czrd-btn czrd-btn--another'
    another.textContent = label
    another.addEventListener('click', function () {
      state.editing = null
      state.addAnother = true
      openModal()
    })

    anchor.parentNode.insertBefore(another, anchor.nextSibling)
  }

  /* ---------------------------------------------------------------------
   * The cart's quantity stepper, on a numbered line
   * ------------------------------------------------------------------ */

  /**
   * Take the quantity control off any cart line that carries a number.
   *
   * The theme cannot know that these lines are different from every other line
   * it renders, so it draws its ordinary − 1 + stepper on them. Pressing + asks
   * for two watches with the same engraved number, which cannot be fulfilled —
   * and the shopper has no way to know that from looking at it.
   *
   * The server already refuses this at the checkout gate, and that refusal is
   * the guarantee. This is the other half: not letting somebody spend the time
   * to reach it. A control that cannot lead anywhere good is better removed than
   * explained.
   *
   * Matched on the hold property rather than on a theme class, because the
   * property is ours and the class belongs to whoever installed the theme. The
   * lookup walks up from the property text to the cart line, so it works on any
   * theme that renders line item properties at all — and quietly does nothing on
   * one that does not.
   */
  const QUANTITY_SELECTOR = [
    // Theme-specific, kept because they match the wrapper rather than the input
    // and hiding the wrapper also takes the − and + with it.
    'm-quantity-input',
    '.m-quantity',
    '[data-quantity-wrapper]',
    '.quantity',
    '.cart-item__quantity-wrapper',
    'quantity-input',
    /**
     * Shopify's own, which every theme has to use whatever it calls its CSS.
     *
     * `updates[]` is the field name a cart form posts, `quantity` is the AJAX
     * equivalent, and the ± controls are almost always links to /cart/change.
     * Matching these means the rule survives a theme change; matching only the
     * class names above meant it worked on exactly one theme and failed
     * silently everywhere else, which is indistinguishable from not being
     * installed.
     */
    'input[name^="updates"]',
    'input[name="quantity"]',
    'a[href*="/cart/change"]',
  ].join(',')

  /**
   * The property that identifies a numbered line, and why it is not the obvious one.
   *
   * This used to look for `_czard_hold`. Shopify HIDES line item properties
   * whose name begins with an underscore from every customer-facing surface,
   * and most themes filter them explicitly, so that string is never in the cart
   * markup — the search matched nothing and the stepper stayed. `Serial` is the
   * customer-facing property, deliberately named so it prints on the
   * confirmation and the packing slip, which is exactly why it is also the one
   * visible to look for here.
   *
   * `_czard_hold` is kept as a fallback for a theme that does render hidden
   * properties.
   */
  const NUMBERED_LINE_MARKERS = ['Serial', '_czard_hold']

  function enforceSingleQuantity() {
    const labels = document.querySelectorAll('[data-cart-item-property-name], .m-cart-item__property, [data-cart-item-property], .product-option, .cart-item__name + *, dl, .properties')
    for (let i = 0; i < labels.length; i++) {
      const text = String(labels[i].textContent || '')
      let marked = false
      for (let m = 0; m < NUMBERED_LINE_MARKERS.length; m++) {
        if (text.indexOf(NUMBERED_LINE_MARKERS[m]) !== -1) { marked = true; break }
      }
      if (!marked) continue

      /**
       * Up to the cart ROW — the element that holds the property AND the
       * quantity control, which are usually in different columns.
       *
       * This was a manual walk testing /cart-item/ against className, and it
       * stopped three levels early on Minimog: `m-cart-item__info` CONTAINS the
       * substring "cart-item", so the regex matched a container that holds the
       * property and not the stepper. The search then found nothing, silently,
       * and the stepper stayed — which looks exactly like the code not running.
       *
       * closest() with a class selector cannot make that mistake: class
       * selectors match whole tokens, so `.m-cart-item` does not match
       * `m-cart-item__info`. The attribute forms are listed first because a
       * theme that sets them means them.
       */
      const line = labels[i].closest(
        '[data-cart-item],[data-cart-drawer-item],.m-cart-item,.cart-item,.cart-drawer-item,.cart__row,tr',
      )
      if (!line || line === document.body) continue

      const steppers = line.querySelectorAll(QUANTITY_SELECTOR)
      for (let q = 0; q < steppers.length; q++) {
        if (steppers[q].getAttribute('data-czard-qty-hidden') === 'true') continue
        steppers[q].setAttribute('data-czard-qty-hidden', 'true')
        steppers[q].style.display = 'none'

        // Say why, once per line, where the stepper was. Removing a control
        // people expect and leaving a gap reads as a broken cart.
        const note = document.createElement('span')
        note.className = 'czrd-qty-note'
        note.textContent = 'One number, one watch'
        steppers[q].parentNode.insertBefore(note, steppers[q])
      }
    }
  }

  /**
   * Say what happened, on the page, after the popup has gone.
   *
   * The popup closes on confirm — the shopper asked for a number and got one,
   * and keeping the grid open afterwards makes them find the close button to
   * reach the buy button. But a modal that vanishes takes its own confirmation
   * with it, so the page has to carry the news: which number, what it costs,
   * and how long it is held for.
   *
   * Rendered next to the picker button rather than as a toast, because it is
   * not a transient notice — it is the current state of the order, and it
   * belongs where the shopper will look when they wonder what they picked.
   */
  function announceSelection(hold, reducedFrom, adding, replaced) {
    const button = document.querySelector('.czrd-btn')
    if (!button) return

    let note = document.querySelector('.czrd-chosen')
    if (!note) {
      note = document.createElement('p')
      note.className = 'czrd-chosen'
      note.setAttribute('role', 'status')
      note.setAttribute('aria-live', 'polite')
      button.parentNode.insertBefore(note, button.nextSibling)
    }
    note.removeAttribute('data-lapsed')

    /**
     * Two shapes reach this function: a hold straight off the API, which prices
     * itself through `prices`, and one read back out of storage after a reload,
     * which carries the figure that was quoted at the time. The stored figure is
     * only shown while the market still matches — a shopper who switched country
     * mid-hold is better told nothing about the fee than told last country's
     * number.
     */
    const fee = hold.prices
      ? holdFee(hold)
      : (hold.currency && hold.currency !== QUOTE.code ? 0 : Number(hold.fee) || 0)

    note.innerHTML =
      '<strong>' + escapeHtml(hold.display) + '</strong>' +
      (replaced
        ? ' has replaced ' + escapeHtml(replaced) + ' on that watch'
        : adding ? ' has been added as a second watch' : ' is in your cart') +
      (fee > 0
        ? ' — includes a ' + escapeHtml(money(fee)) + ' ' +
          escapeHtml(String(hold.tierLabel || hold.tierId || '')) + ' reservation fee.'
        : '.') +
      // The clock is the point of this notice now. Rendered with the current
      // figure rather than an empty box so it is right for the frame before the
      // first tick, and updated in place by tickHold() every second after that.
      ' <span class="czrd-chosen__hold">Held for ' +
      '<b class="czrd-chosen__clock">' + escapeHtml(clock(holdSecondsLeft())) + '</b>' +
      ' — complete checkout to keep it. ' +
      '<a class="czrd-chosen__link" href="/cart">View cart</a></span>' +
      // The popup carried this line at the top; it closes, and the shopper is
      // left with this notice and a cart about to charge a different currency.
      // It has to survive the modal or it was never a warning, only a caption.
      (chargeNote() ? '<span class="czrd-chosen__hold">' + escapeHtml(chargeNote()) + '</span>' : '') +
      /**
       * The one change this makes to a cart the shopper filled themselves, so
       * it stays on the page rather than only in the popup's status line — which
       * is about to close. Buying two of the same reference is a real thing to
       * want; it needs a second number, and saying so is the difference between
       * a shopper who asks for one and a shopper who thinks we lost their watch.
       */
      (reducedFrom
        ? '<span class="czrd-chosen__hold">That line is now 1 watch rather than ' +
          escapeHtml(String(reducedFrom)) + ' — a number belongs to one watch. For a second, ' +
          'reserve a second number.</span>'
        : '')
  }

  function updateButtonLabel(display) {
    const button = document.querySelector('.czrd-btn')
    if (!button) return
    button.textContent = display + ' — change number'
    button.setAttribute('data-has-serial', 'true')
    // The one place a hold becomes current — finishReservation, restoreHold and
    // injectButton all arrive here — so it is the one place the button below
    // has to be told.
    refreshBuyButton()
  }

  /* ---------------------------------------------------------------------
   * Misc
   * ------------------------------------------------------------------ */

  function setStatus(message, tone) {
    if (!state.overlay) return
    const node = state.overlay.querySelector('.czrd-status')
    node.textContent = message || ''
    if (tone) node.setAttribute('data-tone', tone)
    else node.removeAttribute('data-tone')
  }

  /**
   * Said to a screen reader and to nobody else.
   *
   * The selection panel shows the number, the split and the total as a piece of
   * layout — three columns and a rule — which is the right shape for reading it
   * and no shape at all for hearing it. This is the same facts as one sentence.
   * Separate from setStatus because the visible status line is for things that
   * go wrong, and the two must not overwrite each other.
   */
  function announce(message) {
    if (!state.overlay) return
    const node = state.overlay.querySelector('.czrd-announce')
    if (node) node.textContent = message || ''
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  /* ---------------------------------------------------------------------
   * Boot
   * ------------------------------------------------------------------ */

  function boot() {
    injectButton()
    installCheckoutGate()
    watchForRemount()

    /**
     * The fee option is machinery, not a choice. Hidden as soon as the page is
     * up so it never flashes into view, and re-hidden by the remount observer
     * when the theme re-renders the block.
     */
    hideFeeOption()

    /**
     * The variant is settled before anything is priced: One Year, and no
     * reservation fee, unless the shopper's own URL says otherwise (see
     * `defaultWarranty` and `defaultFeeFree`). So the price on the page at the
     * moment it opens is the watch with an ordinary number on it — the figure
     * every premium in the popup is quoted as an addition to.
     *
     * Both of these are no-ops on a product with no such option, and the
     * warranty half is mutually exclusive with the gate below — that only arms
     * when `requireWarranty` is explicitly on, and the default only applies
     * when it is not.
     *
     * With the gate off (the default), the "Buy now" button is open from
     * the first paint; the only thing that can still hold it is `requireNumber`
     * against the buy buttons. refreshGates() reads currentHold() itself, so a
     * shopper returning to the page with a live hold is not asked to choose a
     * number again.
     */
    applyDefaultVariant()
    initWarrantyGate()
    /**
     * The warranty control is watched on every product, gate or no gate: a
     * shopper who changes it after reserving has to take their cart line with
     * them, and a shopper arriving with one already in the cart has to find
     * the page showing the warranty they picked last time rather than the
     * default this boot just applied.
     */
    bindWarrantyGroup()
    watchVariantForWarranty()
    adoptCartWarranty()
    restoreHold()
    watchCartForRemoval()
    watchCartDom()
    /**
     * Once on boot as well as on every cart event, because the removal may have
     * happened on a page this script was not running on — the cart page, or
     * another tab. Storage says a number is held; the cart is the authority on
     * whether it is still wanted.
     */
    reconcileHoldWithCart()
    refreshGates()

    if (CONFIG.autoOpen) openModal()
  }

  /**
   * Put a live hold back on the page after a reload.
   *
   * A reservation is twelve minutes of wall clock, not twelve minutes of this
   * page staying open, and a shopper who refreshes — or comes back from the cart
   * — must find the same countdown rather than a page that has forgotten what
   * they picked. Nothing is re-held here: the hold is the server's, this only
   * redraws it.
   *
   * A hold that lapsed while the tab was closed goes straight to the lapsed
   * notice, which is the honest thing to show and is also what stops a stale
   * localStorage entry from silently satisfying the requireNumber gate.
   */
  /**
   * The hold this browser is counting down, as it stands NOW rather than as
   * localStorage last saw it.
   *
   * The stored record has exactly one fact in it that ages: `expiresAt`. That
   * was treated as the whole truth, and it is not — a hold also ends when the
   * number is BOUGHT, and nothing on a product page is told when that happens.
   * Checkout is a different template; this script does not load there, so the
   * order completes, Shopify empties the cart, the shopper comes back to look
   * at the watch they have just paid for, and the popup is still counting down
   * the number as though it were sitting in a basket.
   *
   * Then it gets worse on its own. The countdown reaches zero, holdLapsed()
   * fires, and a customer who has paid is told their number is loose again and
   * has been taken out of their cart. Both halves of that are false, and it is
   * the last thing the site says to them.
   *
   * So the cart is the first question, because it is local and free: a stored
   * hold whose serial is still on a line is live, and that is the ordinary
   * case. Only when the line has gone does this ask the portal what became of
   * the number, and the answer splits two situations that look identical from
   * here — 'taken' means it sold, anything else means the shopper removed the
   * line themselves, which holdGivenBack already has words for.
   *
   * Failures leave the countdown alone. A cart read that fails, a portal that
   * cannot be reached, a serial that will not parse — none of those are
   * evidence the hold has ended, and stopping a live countdown on a network
   * hiccup would lose somebody a number they still hold.
   */
  function restoreHold() {
    const held = currentHold()
    if (!held || !held.display) return

    if (!holdSecondsLeft()) {
      announceSelection(held)
      holdLapsed()
      return
    }

    updateButtonLabel(held.display)
    announceSelection(held)
    startHoldTimer()

    serialsInCart()
      .then(function (items) {
        const stillInCart = items.some(function (item) {
          return String(item.display) === String(held.display)
        })
        if (stillInCart) return null

        // Only the numeral travels; the portal wants 42, not TC-0042.
        const numeral = Number(String(held.serial ?? held.display).replace(/^.*-/, '').replace(/[^0-9]/g, ''))
        if (!Number.isFinite(numeral)) return null

        return api(
          '/api/serials/check?product=' + encodeURIComponent(CONFIG.productId) +
            '&serial=' + encodeURIComponent(numeral),
        )
      })
      .then(function (result) {
        if (!result || !result.ok) return

        /**
         * Only a number that is genuinely FREE means the shopper let it go.
         *
         * This used to read "taken means sold, anything else means released",
         * and `anything else` quietly included 'reserved' — which is what the
         * portal answers about a number under a live hold, INCLUDING the hold
         * this very browser is counting down. So the picker asked about its own
         * number, was told it was reserved, and concluded the shopper had taken
         * it out of the cart: forgetHold wiped the record and the countdown fell
         * to 0:00 on a hold that had twelve minutes left.
         *
         * It fires on the ordinary path rather than in some rare race, because
         * choosing a fee variant re-renders the buy block through Shopify's
         * Section Rendering API, that takes the notice with it, and the observer
         * which redraws the notice calls restoreHold again — while the number is
         * freshly held and /cart.js has not yet caught up with the line being
         * added. serialsInCart() therefore finds nothing, and this is the branch
         * that decides what that means.
         *
         * The statuses are 'available', 'reserved', 'taken' and 'withheld'.
         * Sold is 'taken'. Released is 'available' and nothing else. 'reserved'
         * is somebody's live hold and 'withheld' is ops pulling a number back;
         * neither is the shopper giving one up, and treating them as evidence of
         * it is what this whole function's closing comment warns against — no
         * answer is not an answer.
         */
        const status = result.data && result.data.status
        if (status === 'taken') holdSold(held)
        else if (status === 'available') holdGivenBack(held)
      })
      .catch(function () {
        /* see above: no answer is not an answer */
      })
  }

  /**
   * The number was bought — by this shopper, in all but the rarest case, since
   * it left their cart and was sold in the same window.
   *
   * Deliberately worded as an outcome rather than a warning. holdGivenBack sits
   * next to this and says the number is back on the grid, which is the right
   * thing to tell somebody who emptied their cart and the wrong thing to tell
   * somebody who has just paid for it.
   */
  function holdSold(held) {
    if (!stillHolding(held)) return
    forgetHold()
    stopHoldTimer()
    pendingProperties = null
    injectProperties(null)
    refreshGates()

    const button = document.querySelector('.czrd-btn')
    if (button) {
      button.textContent = CONFIG.buttonLabel
      button.removeAttribute('data-has-serial')
    }
    // The hold is gone, so "Proceed to cart" is no longer true.
    refreshBuyButton()

    const note = document.querySelector('.czrd-chosen')
    if (!note) return
    // Not `data-lapsed`: that attribute is the styling for a number somebody
    // lost, and this is the opposite outcome wearing the same markup.
    note.removeAttribute('data-lapsed')
    note.innerHTML =
      '<strong>' + escapeHtml(held && held.display ? held.display : 'That number') +
      '</strong> is yours.' +
      '<span class="czrd-chosen__hold">It sold to you and is recorded against your order. ' +
      'Buy now again whenever you like.</span>'
  }

  /**
   * Put the button back when the theme takes it away.
   *
   * Injecting once on DOMContentLoaded assumes the product block is rendered
   * once and left alone, and on a modern theme that is not true. Shopify's
   * Section Rendering API is how a variant switch updates the price, the
   * availability and the buy form — the theme fetches the section's HTML and
   * replaces the subtree wholesale. Any element the theme did not put there,
   * including this button and the placeholder it mounts into, is gone.
   *
   * The symptom is worse than losing it on load: the button appears, works,
   * and then vanishes the first time somebody changes a variant. So instead of
   * trusting one pass, watch the document and re-inject whenever the button is
   * missing. `injectButton` already returns immediately when one exists, so
   * this is a cheap check rather than repeated work.
   *
   * Also covers the ordinary race: a section rendered after this script boots —
   * lazily, or by an app — gets its button when it arrives rather than never.
   */
  function watchForRemount() {
    if (!window.MutationObserver) return

    let queued = false
    const observer = new MutationObserver(function () {
      // Coalesced into one check per frame. A section swap is hundreds of
      // mutations, and re-querying the DOM for each would be the slowest thing
      // on the page during the one moment it is trying to feel instant.
      if (queued) return
      queued = true
      window.requestAnimationFrame(function () {
        queued = false
        if (!document.querySelector('.czrd-btn')) injectButton()
        // A re-rendered block brings back the theme's own markup, so the fee
        // option reappears and the buy button is enabled again.
        hideFeeOption()
        // Same reasoning: a re-render can bring back an unbound warranty
        // group, or replace an already-bound one with a fresh node. No-ops
        // once a warranty has been chosen or the product has no such option.
        bindWarrantyGroup()

        if (currentHold()) {
          // Selecting a variant re-renders the form, which discards the hidden
          // property inputs. Put them back, or the shop's own Add to cart posts
          // an order with no serial on it.
          if (pendingProperties && !document.querySelector('[data-czard-prop]')) {
            injectProperties(null)
          }
          // And the notice goes with the block, taking the countdown with it.
          // Redrawn from the stored hold, which is the same thing a reload does.
          if (!document.querySelector('.czrd-chosen')) restoreHold()
        }
        refreshGates()
      })
    })

    observer.observe(document.body, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }

  /**
   * A one-line answer to "why is there no button", for a console.
   *
   * Every cause is a different fix and they are indistinguishable by looking at
   * the page: the script can be absent, present on the wrong template, present
   * with no product id, or present with nowhere to mount. Guessing between them
   * is the slowest part of installing this on a theme nobody here wrote.
   */
  /**
   * Why is there no buy button.
   *
   * Three causes look identical on screen and have different fixes: the shop
   * has no stock so the theme rendered "Notify me" instead; this script
   * disabled the button and has not re-enabled it; or something is hiding the
   * container it lives in. Reporting which one it is turns a stare at the page
   * into a decision.
   */
  function buyButtons() {
    const found = document.querySelectorAll(
      'form[action*="/cart/add"] [type="submit"], form[action*="/cart/add"] [name="add"], .shopify-payment-button__button',
    )
    const out = []
    for (let i = 0; i < found.length; i++) {
      const b = found[i]
      const style = window.getComputedStyle(b)
      let hiddenBy = null
      // Walk up looking for whatever is hiding it, so the answer names a node.
      for (let node = b; node && node !== document.body; node = node.parentElement) {
        const s2 = window.getComputedStyle(node)
        if (s2.display === 'none' || s2.visibility === 'hidden') {
          hiddenBy = node === b ? 'itself' : (node.className || node.tagName)
          break
        }
      }
      out.push({
        label: String(b.textContent || '').trim().slice(0, 40),
        disabled: b.disabled,
        disabledByPicker: b.hasAttribute('data-czard-disabled'),
        hidden: Boolean(hiddenBy),
        hiddenBy: hiddenBy,
        opacity: style.opacity,
      })
    }

    const notify = document.querySelector('xflow-bis-button, [class*="notify"], [class*="bis-"]')
    return {
      count: out.length,
      buttons: out,
      themeShowsNotifyMe: Boolean(notify),
      verdict: out.length === 0
        ? (notify
            ? 'No buy button because the theme rendered "Notify me" — the variant is out of stock in Shopify.'
            : 'No buy button in the product form at all. The theme may render it only when a variant is available.')
        : out.some(function (b) { return b.hidden })
          ? 'A buy button exists but something is hiding it — see hiddenBy.'
          : out.some(function (b) { return b.disabled })
            ? (out.some(function (b) { return b.disabledByPicker })
                ? 'Disabled by the picker — own a number, or set data-require-number="false".'
                : 'Disabled by the theme, not by the picker. Usually out of stock.')
            : 'Buy button present and enabled.',
    }
  }

  function diagnose() {
    const mounted = MOUNTS.filter(function (sel) { return document.querySelector(sel) })
    const report = {
      loaded: true,
      portal: CONFIG.portal,
      productId: CONFIG.productId || '(MISSING — the tag is not in a product template)',
      variantId: currentVariantId() || '(none)',
      placeholderFound: Boolean(document.querySelector('[data-czard-picker]')),
      feeHandle: CONFIG.feeHandle,
      feeVariants: 'call CzardSerialPicker.fees() — resolved asynchronously',
      mountsAvailable: mounted,
      buttonRendered: Boolean(document.querySelector('.czrd-btn')),
      requireNumber: CONFIG.requireNumber,
      holdOnThisBrowser: Boolean(currentHold()),
      /**
       * The number tags, as last drawn. `numbersInCart: 1` with no tags is
       * correct rather than broken — one number needs no rail to disambiguate
       * it. Both zero on a page where /cart.js could not be read.
       */
      numbersInCart: cartLines.length,
      tagsRendered: document.querySelectorAll('.czrd-tag').length,
      propertiesOnForm: document.querySelectorAll('[data-czard-prop]').length,
      warranty: {
        option: CONFIG.warrantyOption,
        required: CONFIG.requireWarranty,
        preselected: CONFIG.defaultWarranty || '(none — whatever Shopify served)',
        chosen: state.warrantyChosen,
        groupsFound: findOptionGroups(CONFIG.warrantyOption).length,
      },
      /**
       * The fee half of the boot-time variant decision. `option` present with
       * `pinnedToNone: true` is the case that does something: the page opens on
       * the fee-free variant, so its price is the watch with an ordinary number
       * on it. On all six live products the option is absent and this is inert —
       * the fee is a separate cart line there and the variant price already is
       * the fee-free price.
       */
      fee: {
        option: CONFIG.feeOption,
        noneValue: CONFIG.feeNoneValue,
        pinnedToNone: CONFIG.defaultFeeFree,
      },
      buy: buyButtons(),
    }
    if (!CONFIG.productId) {
      report.fix = 'The script has no data-product. It must be in a section that renders a product.'
    } else if (!mounted.length) {
      report.fix = 'Nowhere to mount. Add <div data-czard-picker></div> where you want the button.'
    } else if (!report.buttonRendered) {
      report.fix = 'Mount exists but no button — call CzardSerialPicker.mount() and report what happens.'
    } else if (!report.warranty.chosen && !report.warranty.groupsFound) {
      report.fix = 'data-require-warranty="true" is set and this product has a Warranty option, but its ' +
        'group could not be found on the page, so the button stays disabled with no way to satisfy it. ' +
        'Set data-warranty-option to match the exact label text, or drop data-require-warranty and let ' +
        'data-default-warranty preselect One Year instead (the default).'
    } else if (!report.warranty.chosen) {
      report.fix = 'Working as intended: data-require-warranty="true" is set and the shopper has not ' +
        'touched the warranty yet. Click a warranty choice, then diagnose() again.'
    } else {
      report.fix = 'Nothing wrong here. If you cannot see it, it is CSS: check for display:none on an ancestor.'
    }
    return report
  }

  window.CzardSerialPicker = {
    open: openModal,
    close: closeModal,
    mount: injectButton,
    diagnose: diagnose,
    buy: buyButtons,
    /** The amount → variant id map, however it was resolved. */
    fees: feeVariantMap,
    config: CONFIG,
    variantId: currentVariantId,
    session: sessionId,
    /**
     * Which currency this shopper is being quoted in, and which one the till
     * will actually charge.
     *
     * The first thing to run when somebody reports "it is showing rupees in
     * Berlin". `quote` comes from the country the portal resolved off the
     * request; `charge` is Shopify's own active currency. `foreign: true` means
     * the two disagree, which is legal and disclosed — and the fix for it is a
     * market in Shopify, not a change to this file.
     */
    market: marketReport,
    /**
     * Quote in a named currency, overriding geolocation until it is cleared.
     * `quoteIn('EUR')`; `quoteIn(null)` hands the decision back.
     *
     * This is how a euro or dollar popup gets checked from a desk in India,
     * which is otherwise only reachable through a VPN — the case that let
     * "rupees in Berlin" ship in the first place.
     *
     * Not persisted, and that is the point. It changes what a shopper is SHOWN
     * and never what the till CHARGES, so a sticky copy left in localStorage
     * would quietly widen the gap the charge note discloses, on a machine
     * nobody remembers setting it on. It lasts as long as the page.
     *
     * Resolves once the chart has been re-read, because the figures are the
     * server's in every currency and the popup re-renders from them.
     */
    quoteIn: function (code) {
      QUOTE.chosen = code ? String(code).trim().toUpperCase() : ''
      return Promise.resolve(loadChart(true)).then(marketReport)
    },
    /** Re-read the chart, and with it the currency decision. */
    reload: loadChart,
    /**
     * Open the picker to add a SECOND watch with its own number, rather than to
     * replace the number already in the cart. What the "Add another watch"
     * button does — exposed so a theme can put that action anywhere it likes.
     */
    addAnother: function () {
      state.editing = null
      state.addAnother = true
      openModal()
    },
    /**
     * The numbers this cart holds for THIS product, as the tags draw them.
     * Resolves after one /cart.js read; `[]` on a cart that could not be read.
     */
    numbers: function () {
      return serialsInCart().then(function (items) {
        return items.filter(function (item) {
          return String(item.product) === String(CONFIG.productId)
        })
      })
    },
    /**
     * Open the picker against one number already in the cart — what clicking
     * its tag does. Takes the display form ("TC-0042"); resolves to false when
     * no line in the cart carries it, so a theme wiring its own control can say
     * so rather than opening an ordinary picker the shopper did not ask for.
     */
    change: function (display) {
      return this.numbers().then(function (mine) {
        const line = mine.filter(function (item) {
          return String(item.display) === String(display)
        })[0]
        if (!line) return false
        beginEdit(line)
        return true
      })
    },
    /**
     * Re-hide the quantity steppers on numbered cart lines. Runs itself on
     * every cart event and DOM change; exposed for a theme whose drawer renders
     * through a mechanism this script cannot see.
     */
    tidyCart: function () {
      enforceSingleQuantity()
      return refreshCartLineUi()
    },
    hold: currentHold,
    /** Seconds left on this browser's hold. 0 when there is none, or it lapsed. */
    holdSecondsLeft: holdSecondsLeft,
    /**
     * Open the cart the way Reserve does. Exposed so a theme whose drawer
     * answers to none of the conventional hooks can wire its own:
     * `document.addEventListener('czard:serial-attached', myDrawer.open)`.
     */
    openCart: openCart,
    revalidate: runGate,
    version: '1.0.0',
  }
})()
