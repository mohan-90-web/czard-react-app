import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import './MediaManagerApp.css'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null
const mediaAdminRpc = 'is_czard_media_admin'
const maximumUploadBytes = 150 * 1024 * 1024
const filters = [
  { value: 'pending', label: 'Pending' },
  { value: 'uploaded', label: 'Uploaded' },
  { value: 'all', label: 'All' },
]

function MediaManagerApp() {
  const [session, setSession] = useState(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [admin, setAdmin] = useState(null)
  const [assets, setAssets] = useState([])
  const [filter, setFilter] = useState('pending')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!supabase) return undefined

    let active = true
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return
      setSession(data.session)
      if (error) setMessage(error.message)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setAdmin(null)
      setAssets([])
      setMessage('')
    })

    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!supabase || !session) return undefined

    let active = true
    supabase.rpc(mediaAdminRpc).then(({ data, error }) => {
      if (!active) return
      if (error) {
        setAdmin(false)
        setMessage('Apply the media security migration before using this admin tool.')
        return
      }
      setAdmin(data === true)
      if (data !== true) setMessage('This account does not have media-admin access.')
    })

    return () => {
      active = false
    }
  }, [session])

  useEffect(() => {
    if (!supabase || !session || admin !== true) return undefined

    let active = true
    async function fetchAssets() {
      setLoading(true)
      let query = supabase
        .from('media_assets')
        .select('id, original_path, storage_bucket, storage_path, public_url, asset_type, status')
        .order('original_path')
        .limit(500)

      if (filter !== 'all') query = query.eq('status', filter)
      const { data, error } = await query
      if (!active) return
      if (error) {
        setMessage(error.message)
        setAssets([])
      } else {
        setAssets(data || [])
        setMessage('')
      }
      setLoading(false)
    }

    fetchAssets()
    return () => {
      active = false
    }
  }, [admin, filter, session])

  async function signIn(event) {
    event.preventDefault()
    if (!supabase) return
    setMessage('')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) setMessage(error.message)
  }

  async function uploadFile(asset, file) {
    if (!supabase) return
    if (file.size > maximumUploadBytes) {
      setMessage('File exceeds the configured 150 MB upload limit.')
      return
    }

    setUploading(asset.id)
    setMessage('')
    const { error: uploadError } = await supabase.storage
      .from(asset.storage_bucket)
      .upload(asset.storage_path, file, {
        upsert: true,
        contentType: file.type || 'application/octet-stream',
      })

    if (uploadError) {
      setMessage(uploadError.message)
      setUploading(null)
      return
    }

    const { data } = supabase.storage.from(asset.storage_bucket).getPublicUrl(asset.storage_path)
    const { error: updateError } = await supabase
      .from('media_assets')
      .update({ status: 'uploaded', public_url: data.publicUrl, updated_at: new Date().toISOString() })
      .eq('id', asset.id)

    if (updateError) {
      setMessage(`File uploaded, but its database record was not updated: ${updateError.message}`)
    } else {
      setAssets((current) => current.map((item) => item.id === asset.id
        ? { ...item, status: 'uploaded', public_url: data.publicUrl }
        : item))
      setMessage(`Uploaded ${asset.original_path}`)
    }
    setUploading(null)
  }

  const filteredAssets = search.trim()
    ? assets.filter((asset) => asset.original_path.toLowerCase().includes(search.trim().toLowerCase()))
    : assets

  if (!supabase) {
    return (
      <main className="media-admin">
        <section className="media-admin__panel">
          <h1>Media assets</h1>
          <p>Supabase client configuration is missing.</p>
        </section>
      </main>
    )
  }

  if (!session) {
    return (
      <main className="media-admin">
        <form className="media-admin__signin" onSubmit={signIn}>
          <h1>Media admin</h1>
          <label>Email<input autoComplete="username" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label>
          <label>Password<input autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
          {message && <p className="media-admin__message" role="alert">{message}</p>}
          <button type="submit">Sign in</button>
        </form>
      </main>
    )
  }

  return (
    <main className="media-admin">
      <div className="media-admin__shell">
        <header className="media-admin__header">
          <div><h1>Media assets</h1><p>{session.user.email}</p></div>
          <button onClick={() => supabase.auth.signOut()} type="button">Sign out</button>
        </header>
        {message && <p className="media-admin__message" role="status">{message}</p>}
        {admin === null ? (
          <p className="media-admin__empty">Checking admin access…</p>
        ) : admin ? (
          <>
            <div className="media-admin__toolbar">
              <input aria-label="Search asset paths" onChange={(event) => setSearch(event.target.value)} placeholder="Search paths" value={search} />
              <div aria-label="Asset status" className="media-admin__filters" role="group">
                {filters.map((option) => (
                  <button aria-pressed={filter === option.value} key={option.value} onClick={() => setFilter(option.value)} type="button">{option.label}</button>
                ))}
              </div>
            </div>
            {loading ? <p className="media-admin__empty">Loading assets…</p> : (
              <div className="media-admin__table-wrap">
                <table>
                  <thead><tr><th>Type</th><th>Original path</th><th>Bucket</th><th>Status</th><th>Upload</th></tr></thead>
                  <tbody>
                    {filteredAssets.length === 0 ? (
                      <tr><td className="media-admin__empty" colSpan="5">No assets found.</td></tr>
                    ) : filteredAssets.map((asset) => (
                      <tr key={asset.id}>
                        <td>{asset.asset_type}</td>
                        <td className="media-admin__path">{asset.original_path}</td>
                        <td>{asset.storage_bucket}</td>
                        <td>{asset.status}</td>
                        <td>
                          <label className="media-admin__upload">
                            {uploading === asset.id ? 'Uploading…' : 'Choose file'}
                            <input
                              accept={asset.asset_type === 'video' ? 'video/*' : asset.asset_type === 'audio' ? 'audio/*' : 'image/*'}
                              disabled={uploading === asset.id}
                              onChange={(event) => {
                                const file = event.target.files?.[0]
                                if (file) uploadFile(asset, file)
                                event.target.value = ''
                              }}
                              type="file"
                            />
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </div>
    </main>
  )
}

export default MediaManagerApp