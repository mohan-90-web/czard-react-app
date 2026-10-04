import { useRef } from 'react'
import AccountApp from './AccountApp.jsx'
import MediaManagerApp from './MediaManagerApp.jsx'
import './App.css'

const LOCAL_CART_KEY = 'czard-local-cart'

function isShopifyRuntimeReference(value = '') {
  return /(cdn\.shopify\.com|shopifycloud|fonts\.shopifycdn\.com|checkout\.shopify|shopify\.com)/i.test(value)
}

function stripShopifyRuntime(documentRef) {
  if (!documentRef) return

  const shopifySelectors = [
    'script[src*="shopify"]',
    'script[src*="shopifycloud"]',
    'script[data-source-attribution*="shopify"]',
    'script#shopify-features',
    'script#shop-js-analytics',
    'script#__st',
    'script#form-persister',
    'meta[id*="shopify"]',
    'meta[name*="shopify"]',
    'link[href*="shopify"]',
    'link[href*="fonts.shopifycdn"]',
  ]

  shopifySelectors.forEach((selector) => {
    documentRef.querySelectorAll(selector).forEach((node) => node.remove())
  })

  Array.from(documentRef.scripts).forEach((script) => {
    const text = (script.textContent || '').trim()
    if (/Shopify\.|shopify/i.test(text)) {
      script.remove()
    }
  })

  try {
    documentRef.defaultView.Shopify = undefined
    documentRef.defaultView.window = documentRef.defaultView
  } catch {
    // no-op: keep local app behavior strict
  }
}

function App() {
  const storefrontFrame = useRef(null)

  if (window.location.pathname.startsWith('/admin/media')) {
    return <MediaManagerApp />
  }

  if (window.location.pathname.startsWith('/account')) {
    return <AccountApp />
  }

  function handleStorefrontLoad() {
    const document = storefrontFrame.current?.contentDocument
    if (!document) return

    if (document.defaultView) {
      document.defaultView.CZARD_SERIAL_API_BASE = import.meta.env.VITE_CZARD_SERIAL_API_BASE || ''
    }

    stripShopifyRuntime(document)

    function capturedRoute(link) {
      const url = new URL(link.href)
      if (url.origin !== window.location.origin) return

      const routePrefixes = ['/products/', '/collections/', '/pages/', '/blogs/', '/cart']
      const routePath = url.pathname.startsWith('/www.czard.com/')
        ? url.pathname.slice('/www.czard.com'.length)
        : url.pathname
      if (!routePrefixes.some((prefix) => routePath.startsWith(prefix))) return
      if (routePath.endsWith('.html') || routePath.endsWith('/')) return

      return `/www.czard.com${routePath}.html${url.search}${url.hash}`
    }

    Array.from(document.querySelectorAll('a, img, script, source, link')).forEach((node) => {
      const candidate = node.href || node.src || node.getAttribute('src') || ''
      if (isShopifyRuntimeReference(candidate)) {
        node.remove()
      }
    })

    document.querySelectorAll('a').forEach((link) => {
      const route = capturedRoute(link)
      if (route) link.href = route
    })

    document.defaultView?.addEventListener('submit', (event) => {
      const form = event.target
      if (form?.tagName !== 'FORM') return

      const actionUrl = form.action || ''
      if (isShopifyRuntimeReference(actionUrl)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (window.confirm('Shopify fallback is disabled. This storefront must use the local app flow only.')) {
          return
        }
        return
      }

      if (!actionUrl.includes('/cart/add')) return

      event.preventDefault()
      event.stopImmediatePropagation()

      const formData = new document.defaultView.FormData(form)
      const variantId = String(formData.get('id') || '')
      const quantity = Math.max(1, Number(formData.get('quantity')) || 1)
      const variantPrices = Array.from(document.scripts).find((script) =>
        Array.from(script.attributes).some((attribute) => attribute.name.startsWith('data-czard-variant-prices')),
      )
      let priceText = ''
      try {
        priceText = variantPrices ? JSON.parse(variantPrices.textContent)[variantId] || '' : ''
      } catch {
        priceText = ''
      }
      const priceMatch = priceText.match(/[\d,]+(?:\.\d{1,2})?/)
      const priceAmount = Number(priceMatch?.[0].replace(/,/g, '') || 0)
      const title = document.querySelector('h1')?.textContent.trim() || 'CZARD watch'
      const selectedVariant = form.querySelector('[name="id"]')
      const variant = selectedVariant?.selectedOptions[0]?.textContent.trim() || ''
      const image = Array.from(document.images)
        .filter((productImage) => productImage.currentSrc.includes('/cdn/shop/'))
        .sort((left, right) => right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight)[0]?.currentSrc || ''
      let cartItems = []
      try {
        const storedCart = JSON.parse(localStorage.getItem(LOCAL_CART_KEY) || '[]')
        cartItems = Array.isArray(storedCart) ? storedCart : []
      } catch {
        cartItems = []
      }

      const matchingIndex = cartItems.findIndex((item) => String(item.id) === variantId)
      if (matchingIndex >= 0) {
        cartItems[matchingIndex] = { ...cartItems[matchingIndex], quantity: (Number(cartItems[matchingIndex].quantity) || 1) + quantity }
      } else {
        cartItems.push({ id: variantId || `${title}-${Date.now()}`, title, variant, priceAmount: Number.isFinite(priceAmount) ? priceAmount : 0, quantity, image })
      }
      localStorage.setItem(LOCAL_CART_KEY, JSON.stringify(cartItems))

      const message = form.querySelector('[data-ld-msg]')
      if (message) {
        message.textContent = 'Added to your local cart.'
        message.hidden = false
      }
    }, true)

    document.addEventListener('click', (event) => {
      const link = event.target.closest('a')
      if (!link) return

      const href = link.getAttribute('href') || ''
      if (isShopifyRuntimeReference(href)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }

      const route = capturedRoute(link)
      if (!route) return
      event.preventDefault()
      event.stopImmediatePropagation()
      storefrontFrame.current.src = route
    }, true)
  }

  return (
    <main className="storefront-shell">
      <iframe
        className="storefront-frame"
        ref={storefrontFrame}
        src="/www.czard.com/index.html"
        title="House of CZARD storefront"
        onLoad={handleStorefrontLoad}
      />
    </main>
  )
}

export default App
