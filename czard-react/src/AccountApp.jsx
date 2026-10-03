import { useEffect, useRef, useState } from 'react'
import './AccountApp.css'

const STORAGE_KEY = 'czard-local-account'
const CART_STORAGE_KEY = 'czard-local-cart'
const navigation = [
  { path: '/account/profile', label: 'Profile', icon: 'profile' },
  { path: '/account/addresses', label: 'Addresses', icon: 'pin' },
  { path: '/account/orders', label: 'Orders', icon: 'bag' },
]
const addressTypes = [
  { value: 'Home', icon: 'home' },
  { value: 'Office', icon: 'briefcase' },
  { value: 'Apartment', icon: 'building' },
  { value: 'Warehouse', icon: 'box' },
  { value: 'Location', icon: 'pin' },
]

function emptyAccount(email = '') {
  return {
    email,
    name: '',
    phone: '',
    addresses: [],
    orders: [],
    preferences: { email: false, sms: false },
  }
}

function readAccount() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return emptyAccount()
    const parsed = JSON.parse(stored)
    return {
      ...emptyAccount(),
      ...parsed,
      preferences: { email: false, sms: false, ...parsed.preferences },
    }
  } catch {
    return emptyAccount()
  }
}

function readCart() {
  try {
    const stored = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || '[]')
    return Array.isArray(stored) ? stored : Array.isArray(stored.items) ? stored.items : []
  } catch {
    return []
  }
}

function cartItemKey(item, index) {
  return item.key || item.id || item.variant_id || `${item.title || item.product_title || 'item'}-${index}`
}

function cartItemPrice(item) {
  const rawPrice = item.priceAmount ?? item.price ?? item.final_price ?? 0
  const parsedPrice = typeof rawPrice === 'number' ? rawPrice : Number(String(rawPrice).replace(/[^\d.]/g, ''))
  return Number.isFinite(parsedPrice) ? parsedPrice / (item.final_price != null && item.priceAmount == null && item.price == null ? 100 : 1) : 0
}

function formatCartPrice(amount) {
  return `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} INR`
}

function Icon({ name, size = 20 }) {
  const paths = {
    profile: <><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-1.5a7 7 0 0 1 14 0V21" /></>,
    pin: <><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    bag: <><path d="M5 8h14l1 13H4L5 8Z" /><path d="M9 9V6a3 3 0 0 1 6 0v3" /></>,
    logout: <><path d="M10 17l5-5-5-5" /><path d="M15 12H3" /><path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7" /></>,
    home: <><path d="m3 11 9-8 9 8" /><path d="M5 10v11h14V10M9 21v-7h6v7" /></>,
    briefcase: <><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V4h8v3M3 12h18m-11 0v2h4v-2" /></>,
    building: <><path d="M4 21V5l8-3 8 3v16M2 21h20M8 8h1m6 0h1M8 12h1m6 0h1M10 21v-4h4v4" /></>,
    box: <><path d="m3 7 9-4 9 4v11l-9 4-9-4V7Z" /><path d="m3 7 9 4 9-4m-9 4v11" /></>,
    receipt: <><path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3Z" /><path d="M8 8h8M8 12h8M8 16h4" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    cart: <><path d="M3 4h2l2.2 11.2a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 1.9-1.4L22 9H7" /><circle cx="10" cy="21" r="1" /><circle cx="18" cy="21" r="1" /></>,
    edit: <><path d="m15 5 4 4M4 20l4-.8L19 8a2.1 2.1 0 0 0-3-3L5 16l-1 4Z" /></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
  }
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}

function AccountApp() {
  const [account, setAccount] = useState(readAccount)
  const [path, setPath] = useState(window.location.pathname)
  const [menuOpen, setMenuOpen] = useState(false)
  const [soundOn, setSoundOn] = useState(false)
  const [email, setEmail] = useState(() => new URLSearchParams(window.location.search).get('email') || readAccount().email)
  const [notice, setNotice] = useState('')
  const [addressOpen, setAddressOpen] = useState(false)
  const [cartOpen, setCartOpen] = useState(false)
  const [cartItems, setCartItems] = useState(readCart)
  const [editingProfile, setEditingProfile] = useState(false)
  const [preferences, setPreferences] = useState(() => readAccount().preferences)
  const ambientAudio = useRef(null)
  const storeMenuArea = useRef(null)
  const menuToggle = useRef(null)
  const [orderFilter, setOrderFilter] = useState('Current')
  const page = path.split('/').filter(Boolean).at(-1) || 'profile'
  const signedInLocally = Boolean(account.email)
  const displayName = account.name || account.email

  useEffect(() => {
    const updatePath = () => setPath(window.location.pathname)
    window.addEventListener('popstate', updatePath)
    return () => window.removeEventListener('popstate', updatePath)
  }, [])

  useEffect(() => () => ambientAudio.current?.pause(), [])

  useEffect(() => {
    if (!menuOpen) return undefined

    function closeOnOutside(event) {
      if (!storeMenuArea.current?.contains(event.target)) setMenuOpen(false)
    }

    function closeOnEscape(event) {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      menuToggle.current?.focus()
    }

    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!cartOpen) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function closeOnEscape(event) {
      if (event.key === 'Escape') setCartOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [cartOpen])

  useEffect(() => {
    function syncCart(event) {
      if (event.key === CART_STORAGE_KEY) setCartItems(readCart())
    }
    window.addEventListener('storage', syncCart)
    return () => window.removeEventListener('storage', syncCart)
  }, [])

  function navigate(nextPath, replace = false) {
    window.history[replace ? 'replaceState' : 'pushState']({}, '', nextPath)
    setPath(nextPath)
    setNotice('')
    window.scrollTo(0, 0)
  }

  async function toggleAmbientSound() {
    const audio = ambientAudio.current
    if (!audio) return

    if (audio.paused) {
      try {
        await audio.play()
        setSoundOn(true)
      } catch {
        setSoundOn(false)
        setNotice('Ambient sound could not be played.')
      }
      return
    }

    audio.pause()
    setSoundOn(false)
  }

  function saveAccount(nextAccount) {
    setAccount(nextAccount)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextAccount))
    } catch {
      setNotice('Could not save changes in this browser.')
    }
  }

  function saveCart(nextItems) {
    setCartItems(nextItems)
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(nextItems))
    } catch {
      setNotice('Could not save your cart in this browser.')
    }
  }

  function changeCartQuantity(index, quantity) {
    if (quantity < 1) {
      saveCart(cartItems.filter((_, itemIndex) => itemIndex !== index))
      return
    }
    saveCart(cartItems.map((item, itemIndex) => itemIndex === index ? { ...item, quantity } : item))
  }

  function signIn(event) {
    event.preventDefault()
    const normalizedEmail = email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setNotice('Enter a valid email address.')
      return
    }
    saveAccount({ ...account, email: normalizedEmail })
    navigate('/account/profile')
  }

  function signOut() {
    ambientAudio.current?.pause()
    setSoundOn(false)
    saveAccount(emptyAccount())
    setPreferences({ email: false, sms: false })
    setEmail('')
    navigate('/account/login')
  }

  function updateProfile(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    saveAccount({
      ...account,
      name: String(form.get('name') || '').trim(),
      phone: String(form.get('phone') || '').trim(),
    })
    setEditingProfile(false)
    setNotice('Profile saved in this browser.')
  }

  function savePreferences() {
    saveAccount({ ...account, preferences })
    setNotice('Preferences saved in this browser.')
  }

  function saveAddress(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const isDefault = form.get('default') === 'on'
    const address = Object.fromEntries(
      ['label', 'type', 'line1', 'line2', 'city', 'region', 'postal', 'country', 'phone'].map((field) => [
        field,
        String(form.get(field) || '').trim(),
      ]),
    )
    address.name = [form.get('firstName'), form.get('lastName')].map((part) => String(part || '').trim()).filter(Boolean).join(' ')
    address.isDefault = isDefault || account.addresses.length === 0
    const addresses = account.addresses.map((saved) => ({ ...saved, isDefault: isDefault ? false : saved.isDefault }))
    saveAccount({ ...account, addresses: [...addresses, address] })
    setAddressOpen(false)
    setNotice('Address saved in this browser.')
  }

  function deleteAddress(index) {
    saveAccount({ ...account, addresses: account.addresses.filter((_, addressIndex) => addressIndex !== index) })
    setNotice('Address removed.')
  }

  const showLocalSignIn = page === 'login' || !signedInLocally
  const cartCount = cartItems.reduce((total, item) => total + Math.max(1, Number(item.quantity) || 1), 0)
  const cartSubtotal = cartItems.reduce((total, item) => total + cartItemPrice(item) * Math.max(1, Number(item.quantity) || 1), 0)

  return (
    <main className="local-account">
      <audio ref={ambientAudio} loop preload="none" src="/www.czard.com/cdn/shop/t/9/assets/czard-ambientb25a.mp3" />
      {showLocalSignIn ? (
        <section className="local-signin" aria-labelledby="account-title">
          <a className="local-account__brand" href="/" aria-label="CZARD home">CZARD</a>
          <h1 id="account-title">Sign in</h1>
          <p className="local-signin__copy">Enter your email to open your local account.</p>
          <form className="local-signin__form" onSubmit={signIn}>
            <div className="local-signin__field">
              <input autoComplete="email" aria-label="Email address" id="account-email" onChange={(event) => setEmail(event.target.value)} placeholder="Email" required type="email" value={email} />
              <button aria-label="Continue" type="submit"><Icon name="arrow" /></button>
            </div>
            <p className="local-signin__note">Account details are saved only in this browser.</p>
          </form>
          {notice && <p className="local-account__notice" role="status">{notice}</p>}
        </section>
      ) : (
        <div className="local-account__layout">
          <aside className="local-account__sidebar">
            <div className="local-account__navigation-shell" ref={storeMenuArea}>
              <div className="local-account__side-brand">
                <button aria-controls="store-navigation" aria-expanded={menuOpen} aria-label={menuOpen ? 'Close store navigation' : 'Open store navigation'} className="local-account__menu-toggle" onClick={() => setMenuOpen((open) => !open)} ref={menuToggle} type="button">
                  <span className="local-account__menu-mark" aria-hidden="true">{menuOpen ? '×' : '☰'}</span>
                </button>
                <button aria-label={soundOn ? 'Pause ambient sound' : 'Play ambient sound'} aria-pressed={soundOn} className="local-account__sound-toggle" onClick={toggleAmbientSound} type="button"><span className="local-account__sound-mark" aria-hidden="true"><i /><span>SOUND</span></span></button>
              </div>
              {menuOpen && (
                <nav aria-label="Store navigation" className="local-account__main-menu" id="store-navigation">
                  <ol>
                    <li><a href="/"> <span>01</span>HOME</a></li>
                    <li><a href="/www.czard.com/collections/all.html"><span>02</span>ALL WATCHES</a></li>
                    <li><a href="/www.czard.com/collections/all.html"><span>03</span>ACCESSORIES</a></li>
                    <li><a href="/www.czard.com/pages/about-us.html"><span>04</span>ABOUT CZARD</a></li>
                    <li><a href="/www.czard.com/pages/contact.html"><span>05</span>CONTACT US</a></li>
                    <li><a href="/www.czard.com/pages/faqs.html"><span>06</span>FAQs</a></li>
                  </ol>
                  <p>CZARD</p>
                </nav>
              )}
            </div>
            <nav aria-label="Account pages" className="local-account__nav">
              {navigation.map((item) => (
                <a aria-current={page === item.path.split('/').at(-1) ? 'page' : undefined} className={page === item.path.split('/').at(-1) ? 'is-active' : ''} href={item.path} key={item.path} onClick={(event) => { event.preventDefault(); navigate(item.path) }}>
                  <Icon name={item.icon} />{item.label}
                </a>
              ))}
            </nav>
            <button className="local-account__signout" onClick={signOut} type="button"><Icon name="logout" />Log out</button>
          </aside>

          <section className="local-account__content">
            <div className="local-account__utility">
              <span className="local-account__utility-avatar" aria-label={displayName}>{(account.name?.[0] || account.email[0]).toUpperCase()}</span>
              <button aria-expanded={cartOpen} aria-label={`Shopping cart, ${cartCount} items`} className="local-account__cart" onClick={() => setCartOpen(true)} type="button"><Icon name="bag" /><span>{cartCount}</span></button>
            </div>

            {page === 'profile' && (
              <>
                <div className="local-account__page-heading"><h1>My profile</h1><p>Manage your account information and preferences.</p></div>
                <section className="profile-welcome">
                  <span className="profile-welcome__avatar">{(account.name?.[0] || account.email[0]).toLowerCase()}</span>
                  <div><strong className="profile-welcome__eyebrow">CUSTOMER ACCOUNT</strong><h2>Welcome back, {displayName}</h2><p>Manage your account details, addresses and preferences.</p></div>
                </section>
                <div className="profile-stats">
                  <article className="profile-stat"><span className="profile-stat__icon"><Icon name="bag" /></span><p>Total orders</p><strong>{account.orders.length}</strong><button onClick={() => navigate('/account/orders')} type="button">View orders <Icon name="arrow" size={15} /></button></article>
                  <article className="profile-stat"><span className="profile-stat__icon"><Icon name="receipt" /></span><p>Total spent</p><strong>₹0.00</strong><button onClick={() => navigate('/account/orders')} type="button">View orders <Icon name="arrow" size={15} /></button></article>
                </div>
                <section className="account-panel profile-information">
                  <div className="account-panel__heading"><div><h2>Profile information</h2><p>Your primary account details for this store.</p></div><button className="account-edit" onClick={() => setEditingProfile((value) => !value)} type="button"><Icon name="edit" size={15} />{editingProfile ? 'Cancel' : 'Edit profile'}</button></div>
                  {editingProfile ? (
                    <form className="profile-edit-form" onSubmit={updateProfile}>
                      <label>Full name<input autoComplete="name" defaultValue={account.name} name="name" placeholder="Full name" /></label>
                      <label>Email<input disabled type="email" value={account.email} /></label>
                      <label>Phone number<input autoComplete="tel" defaultValue={account.phone} name="phone" placeholder="Phone number" type="tel" /></label>
                      <button className="account-save" type="submit">Save profile</button>
                    </form>
                  ) : (
                    <div className="profile-information__rows">
                      <div><Icon name="profile" size={15} /><span>Full name</span><strong>{account.name || account.email}</strong></div>
                      <div><Icon name="receipt" size={15} /><span>Email</span><strong>{account.email}</strong></div>
                      <div><Icon name="profile" size={15} /><span>Phone number</span><strong>{account.phone || '-'}</strong></div>
                      <div><Icon name="receipt" size={15} /><span>Email subscription</span><strong>{preferences.email ? 'Subscribed' : 'Not subscribed'}</strong></div>
                      <div><Icon name="receipt" size={15} /><span>SMS subscription</span><strong>{preferences.sms ? 'Subscribed' : 'Not subscribed'}</strong></div>
                    </div>
                  )}
                </section>
                <section className="account-panel preferences-panel">
                  <div className="account-panel__heading"><div><h2>Preferences</h2><p>Choose how you want to hear from us. Changes save together.</p></div></div>
                  <label className="preference-row"><span className="profile-stat__icon"><Icon name="receipt" size={16} /></span><span><strong>Email updates</strong><small>Receive order updates, offers and news via email.</small></span><input checked={preferences.email} onChange={(event) => setPreferences({ ...preferences, email: event.target.checked })} type="checkbox" /></label>
                  <label className="preference-row"><span className="profile-stat__icon"><Icon name="profile" size={16} /></span><span><strong>SMS updates</strong><small>Receive order updates and important alerts via SMS.</small></span><input checked={preferences.sms} onChange={(event) => setPreferences({ ...preferences, sms: event.target.checked })} type="checkbox" /></label>
                  <div className="preferences-actions"><button className="account-cancel" onClick={() => setPreferences(account.preferences)} type="button">Cancel</button><button className="account-save" onClick={savePreferences} type="button">Save</button></div>
                </section>
                <section className="quick-actions"><div className="account-panel__heading"><div><h2>Quick actions</h2><p>Jump to the parts of your account you use most.</p></div></div><div className="quick-actions__grid">
                  <button onClick={() => navigate('/account/addresses')} type="button"><Icon name="pin" /><span><strong>Manage addresses</strong><small>View and edit saved addresses.</small></span><Icon name="arrow" size={15} /></button>
                  <button onClick={() => navigate('/account/orders')} type="button"><Icon name="bag" /><span><strong>Order history</strong><small>Track and manage orders.</small></span><Icon name="arrow" size={15} /></button>
                  <a href="/" onClick={(event) => { event.preventDefault(); window.location.assign('/') }}><Icon name="receipt" /><span><strong>Recently viewed</strong><small>Continue shopping items.</small></span><Icon name="arrow" size={15} /></a>
                  <a href="mailto:support@czard.com"><Icon name="profile" /><span><strong>Help center</strong><small>Get support for your account.</small></span><Icon name="arrow" size={15} /></a>
                </div></section>
                <section className="account-panel recent-orders"><div className="account-panel__heading"><div><h2>Recent orders</h2><p>Your latest order activity.</p></div><button onClick={() => navigate('/account/orders')} type="button">View all <Icon name="arrow" size={14} /></button></div><p>No recent orders yet.</p></section>
              </>
            )}

            {page === 'addresses' && (
              <>
                <div className="local-account__page-heading"><h1>Addresses</h1><p>Manage your saved delivery locations.</p></div>
                <button className="add-address-card" onClick={() => setAddressOpen(true)} type="button"><span><Icon name="plus" size={24} /></span><strong>Add new address</strong><small>Save another delivery location</small></button>
                {account.addresses.length > 0 && <div className="local-addresses">{account.addresses.map((address, index) => <article className="local-address" key={`${address.line1}-${index}`}><div><h2>{address.label || address.name || 'Address'}{address.isDefault && <span className="address-default">Default</span>}</h2><p>{[address.name, address.line1, address.line2, address.city, address.region, address.postal, address.country].filter(Boolean).join(', ')}</p>{address.phone && <p>{address.phone}</p>}</div><button aria-label={`Remove address ${index + 1}`} onClick={() => deleteAddress(index)} type="button">Remove</button></article>)}</div>}
                <div className="address-help"><span><Icon name="check" size={18} /></span>You can set any of these addresses as your default delivery address.</div>
              </>
            )}

            {page === 'orders' && (
              <>
                <div className="local-account__page-heading"><h1>Orders</h1><p>View and manage your order history.</p></div>
                <div aria-label="Order status" className="order-tabs" role="tablist">{['Current', 'Unpaid', 'All orders'].map((filter) => <button aria-selected={orderFilter === filter} className={orderFilter === filter ? 'is-active' : ''} key={filter} onClick={() => setOrderFilter(filter)} role="tab" type="button">{filter}</button>)}</div>
                {account.orders.length ? account.orders.map((order) => <article className="local-order" key={order.id}><strong>{order.id}</strong><span>{order.date}</span><span>{order.total}</span></article>) : <div className="local-orders-empty"><span><Icon name="bag" size={28} /></span><h2>No orders to show</h2><p>Orders you place with this store will appear here.</p></div>}
              </>
            )}
            {notice && <p className="local-account__notice" role="status">{notice}</p>}
          </section>
        </div>
      )}

      {addressOpen && <div className="address-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAddressOpen(false) }}>
        <section aria-labelledby="address-modal-title" aria-modal="true" className="address-modal" role="dialog">
          <div className="address-modal__heading"><div><h2 id="address-modal-title">Add new address</h2><p>Save a delivery location.</p></div><button aria-label="Close" onClick={() => setAddressOpen(false)} type="button">×</button></div>
          <form onSubmit={saveAddress}>
            <label className="address-label">Address label<input defaultValue="Home, Office, Mumbai Address" name="label" /></label>
            <fieldset className="address-type-picker"><legend>Choose an icon</legend>{addressTypes.map((type) => <label key={type.value}><input defaultChecked={type.value === 'Location'} name="type" type="radio" value={type.value} /><span><Icon name={type.icon} size={17} />{type.value}</span></label>)}</fieldset>
            <p className="address-type-hint">We automatically suggest an icon based on the address label. You can change it anytime.</p>
            <div className="address-modal__fields">
              <label>First name<input autoComplete="given-name" name="firstName" required /></label><label>Last name<input autoComplete="family-name" name="lastName" /></label>
              <label>Address<input autoComplete="address-line1" name="line1" required /></label><label>Apartment, suite, etc.<input autoComplete="address-line2" name="line2" /></label>
              <label>City<input autoComplete="address-level2" name="city" required /></label><label>Country<select autoComplete="country-name" defaultValue=""><option disabled value="">Select country</option><option>India</option><option>United States</option><option>United Kingdom</option><option>Switzerland</option><option>Finland</option></select></label>
              <label>State / Province<input autoComplete="address-level1" name="region" /></label><label>Postal / ZIP code<input autoComplete="postal-code" name="postal" required /></label>
              <label className="address-modal__phone">Phone number<input autoComplete="tel" name="phone" type="tel" /></label>
            </div>
            <label className="address-default-toggle"><input name="default" type="checkbox" /><span><strong>Set as default address</strong><small>This will be used as your primary delivery address.</small></span></label>
            <div className="address-modal__actions"><button className="account-cancel" onClick={() => setAddressOpen(false)} type="button">Cancel</button><button className="account-save" type="submit">Add address</button></div>
          </form>
        </section>
      </div>}

      {cartOpen && <div className="local-cart-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCartOpen(false) }}>
        <aside aria-label="Shopping Cart" aria-modal="true" className="local-cart-drawer" role="dialog">
          <header className="local-cart-drawer__header"><h2>Shopping Cart</h2><button aria-label="Close cart" onClick={() => setCartOpen(false)} type="button">×</button></header>
          {cartItems.length ? <div className="local-cart-drawer__items">{cartItems.map((item, index) => {
            const quantity = Math.max(1, Number(item.quantity) || 1)
            const image = item.image || item.featured_image?.url || item.featured_image || item.images?.[0]
            const title = item.title || item.product_title || item.name || 'CZARD watch'
            return <article className="local-cart-item" key={cartItemKey(item, index)}>
              <div className="local-cart-item__image">{image ? <img alt={title} src={image} /> : <Icon name="bag" size={26} />}</div>
              <div className="local-cart-item__details"><h3>{title}</h3>{item.variant && <p>{item.variant}</p>}{(item.serial || item.sku) && <p>Serial: {item.serial || item.sku}</p>}<strong>{formatCartPrice(cartItemPrice(item))}</strong><div className="local-cart-item__actions"><div className="local-cart-quantity"><button aria-label={`Decrease quantity of ${title}`} onClick={() => changeCartQuantity(index, quantity - 1)} type="button">−</button><span>{quantity}</span><button aria-label={`Increase quantity of ${title}`} onClick={() => changeCartQuantity(index, quantity + 1)} type="button">+</button></div><button className="local-cart-item__remove" onClick={() => changeCartQuantity(index, 0)} type="button">Remove</button></div></div>
            </article>
          })}</div> : <div className="local-cart-drawer__empty"><span><Icon name="bag" size={27} /></span><h3>Your cart is empty</h3><p>Items you add while shopping will appear here.</p><button onClick={() => { setCartOpen(false); window.location.assign('/') }} type="button">Continue shopping</button></div>}
          <footer className="local-cart-drawer__footer"><div><span>Subtotal</span><strong>{formatCartPrice(cartSubtotal)}</strong></div><a aria-disabled={!cartItems.length} className={!cartItems.length ? 'is-disabled' : ''} href={cartItems.length ? '/cart.html' : undefined} onClick={(event) => { if (!cartItems.length) event.preventDefault() }}>Checkout</a></footer>
        </aside>
      </div>}
    </main>
  )
}

export default AccountApp