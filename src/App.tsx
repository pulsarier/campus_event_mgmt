import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import './App.css'

type EventItem = { id: number; title: string; category: string; date: string; venue: string; host: string; attendees: number; image: string }
type Account = { name: string; email: string; department: string; role: string; reminders: boolean; announcements: boolean }
type AuthUser = Omit<Pick<Account, 'name' | 'email' | 'department' | 'role'>, 'department'> & { department: string | null; event_reminders_enabled: boolean; announcements_enabled: boolean }
type ApiEvent = { id: number | string; title: string; category: string; starts_at: string; venue: string; organizer: string; registrations: number }
type CreateEventPayload = { title: string; description: string; category: string; starts_at: string; ends_at: string; registration_deadline: string; venue_id: number; capacity: number }
type VenueOption = { id: number; name: string; location: string; capacity: number }
type ApiListItem = { id: number | string; status?: string }
type NotificationItem = { id: number; event_id: number | null; message: string; notification_type: string; is_read: boolean; created_at: string }
type PendingEvent = { id: number; title: string; description: string; category: string; starts_at: string; ends_at: string; registration_deadline: string; capacity: number; venue: string; location: string; organizer: string; organizer_email: string }
type ManagedEvent = { id: number; title: string; description: string; category: string; starts_at: string; ends_at: string; registration_deadline: string; capacity: number; status: string; venue_id: number; venue: string; location: string; participant_count: number }
type ApiResult<T> = { data: T; token?: string; error?: string }
const apiBase = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001'
const fallbackImage = 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1000&q=80'

async function apiRequest<T>(path: string, options: RequestInit = {}, token?: string): Promise<ApiResult<T>> {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  const result = await response.json().catch(() => ({})) as ApiResult<T>
  if (!response.ok) throw new Error(result.error ?? 'The request could not be completed')
  return result
}

function mapApiEvent(event: ApiEvent): EventItem {
  return { id: Number(event.id), title: event.title, category: event.category, date: new Date(event.starts_at).toLocaleString(), venue: event.venue, host: event.organizer, attendees: Number(event.registrations), image: fallbackImage }
}
const navItems = [['◈', 'Overview'], ['▦', 'Discover'], ['◷', 'My registrations'], ['♢', 'Saved events']]
const modules = ['Overview', 'Discover', 'My registrations', 'Saved events', 'Create an event', 'Manage events', 'Insights', 'Approvals', 'Notifications', 'Account info']

function moduleFromHash() { const value = decodeURIComponent(window.location.hash.slice(1)); return modules.includes(value) ? value : 'Overview' }

function App() {
  const [requestedNav, setRequestedNav] = useState(moduleFromHash)
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem('campus-event-token'))
  const [validatedToken, setValidatedToken] = useState<string | null>(null)
  const [authError, setAuthError] = useState('')
  const [events, setEvents] = useState<EventItem[]>([])
  const [eventsReload, setEventsReload] = useState(0)
  const [eventRequest, setEventRequest] = useState({ key: '', error: '' })
  const [activityError, setActivityError] = useState('')
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [notificationReload, setNotificationReload] = useState(0)
  const [notificationRequest, setNotificationRequest] = useState({ key: '', error: '' })
  const [registered, setRegistered] = useState<number[]>([])
  const [saved, setSaved] = useState<number[]>([])
  const [query, setQuery] = useState('')
  const [activeFilter, setActiveFilter] = useState('All events')
  const [toast, setToast] = useState('')
  const [account, setAccount] = useState<Account | null>(null)
  useEffect(() => { const syncModule = () => setRequestedNav(moduleFromHash()); window.addEventListener('hashchange', syncModule); window.addEventListener('popstate', syncModule); return () => { window.removeEventListener('hashchange', syncModule); window.removeEventListener('popstate', syncModule) } }, [])
  useEffect(() => {
    let cancelled = false
    if (!token) return () => { cancelled = true }
    apiRequest<AuthUser>('/api/auth/me', {}, token)
      .then(({ data }) => { if (!cancelled) { const { event_reminders_enabled: reminders, announcements_enabled: announcements, ...profile } = data; setAccount({ ...profile, department: data.department ?? '', reminders, announcements }); setValidatedToken(token) } })
      .catch((error: Error) => { if (!cancelled) { sessionStorage.removeItem('campus-event-token'); setAccount(null); setToken(null); setAuthError(error.message) } })
    return () => { cancelled = true }
  }, [token])
  useEffect(() => {
    let cancelled = false
    if (!token) return () => { cancelled = true }
    const key = `${token}:${notificationReload}`
    apiRequest<{ items: NotificationItem[]; unread_count: number }>('/api/notifications/me', {}, token)
      .then(({ data }) => { if (!cancelled) { setNotifications(data.items); setNotificationRequest({ key, error: '' }) } })
      .catch((error: Error) => { if (!cancelled) setNotificationRequest({ key, error: error.message }) })
    return () => { cancelled = true }
  }, [token, notificationReload])
  useEffect(() => {
    let cancelled = false
    if (!token) return () => { cancelled = true }
    const requestKey = `${token}:${eventsReload}`
    apiRequest<ApiEvent[]>('/api/events', {}, token)
      .then(({ data }) => { if (!cancelled) { setEvents(data.map(mapApiEvent)); setEventRequest({ key: requestKey, error: '' }) } })
      .catch((error: Error) => { if (!cancelled) setEventRequest({ key: requestKey, error: error.message }) })
    return () => { cancelled = true }
  }, [token, eventsReload])
  useEffect(() => {
    let cancelled = false
    if (!token) return () => { cancelled = true }
    Promise.all([
      apiRequest<ApiListItem[]>('/api/registrations/me', {}, token),
      apiRequest<ApiListItem[]>('/api/saved-events', {}, token),
    ]).then(([registrationsResult, savedResult]) => {
      if (!cancelled) {
        setRegistered(registrationsResult.data.map((item) => Number(item.id)))
        setSaved(savedResult.data.map((item) => Number(item.id)))
        setActivityError('')
      }
    }).catch((error: Error) => { if (!cancelled) setActivityError(error.message) })
    return () => { cancelled = true }
  }, [token])
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2500) }
  const filteredEvents = useMemo(() => events.filter((event) => `${event.title} ${event.category} ${event.venue} ${event.host}`.toLowerCase().includes(query.toLowerCase()) && (activeFilter === 'All events' || event.category === activeFilter)), [activeFilter, events, query])
  const toggleRegistration = async (event: EventItem) => {
    if (!token) return
    try {
      if (registered.includes(event.id)) {
        await apiRequest(`/api/events/${event.id}/registrations/me`, { method: 'DELETE' }, token)
        notify(`Registration cancelled for ${event.title}`)
      } else {
        const result = await apiRequest<{ status: string }>(`/api/events/${event.id}/registrations`, { method: 'POST', body: JSON.stringify({}) }, token)
        notify(result.data.status === 'waitlisted' ? `Added to the waitlist for ${event.title}` : `Registered for ${event.title}`)
      }
      const result = await apiRequest<ApiListItem[]>('/api/registrations/me', {}, token)
      setRegistered(result.data.map((item) => Number(item.id)))
      setEventsReload((value) => value + 1)
    } catch (error) { notify(error instanceof Error ? error.message : 'Registration could not be updated') }
  }
  const toggleSaved = async (event: EventItem) => {
    if (!token) return
    try {
      if (saved.includes(event.id)) {
        await apiRequest(`/api/saved-events/${event.id}`, { method: 'DELETE' }, token)
        setSaved((current) => current.filter((id) => id !== event.id))
        notify('Removed from saved events')
      } else {
        await apiRequest(`/api/saved-events/${event.id}`, { method: 'POST', body: JSON.stringify({}) }, token)
        setSaved((current) => [...current, event.id])
        notify('Event saved')
      }
    } catch (error) { notify(error instanceof Error ? error.message : 'Saved events could not be updated') }
  }
  const markNotificationRead = async (notificationId: number) => {
    if (!token) return
    try {
      await apiRequest(`/api/notifications/${notificationId}/read`, { method: 'PATCH', body: JSON.stringify({}) }, token)
      setNotifications((current) => current.map((item) => item.id === notificationId ? { ...item, is_read: true } : item))
    } catch (error) { notify(error instanceof Error ? error.message : 'Notification could not be updated') }
  }
  const markAllNotificationsRead = async () => {
    if (!token) return
    try {
      await apiRequest('/api/notifications/read-all', { method: 'PATCH', body: JSON.stringify({}) }, token)
      setNotifications((current) => current.map((item) => ({ ...item, is_read: true })))
    } catch (error) { notify(error instanceof Error ? error.message : 'Notifications could not be updated') }
  }
  const unreadNotifications = notifications.filter((item) => !item.is_read).length
  const canManageEvents = account !== null && ['faculty', 'organizer', 'admin'].includes(account.role)
  const isAdmin = account?.role === 'admin'
  const activeNav = (!canManageEvents && ['Create an event', 'Manage events', 'Insights'].includes(requestedNav)) || (!isAdmin && requestedNav === 'Approvals') ? 'Overview' : requestedNav
  const openModule = (label: string) => { const destination = ((!canManageEvents && ['Create an event', 'Manage events', 'Insights'].includes(label)) || (!isAdmin && label === 'Approvals')) ? 'Overview' : label; setRequestedNav(destination); setQuery(''); setActiveFilter('All events'); if (destination === 'Notifications') setNotificationReload((value) => value + 1); window.history.pushState({}, '', `#${encodeURIComponent(destination)}`) }
  const signOut = () => { sessionStorage.removeItem('campus-event-token'); setToken(null); setValidatedToken(null); setAccount(null); setRegistered([]); setSaved([]); setEvents([]); setNotifications([]); openModule('Overview') }
  const authLoading = Boolean(token && validatedToken !== token)
  const requestKey = `${token ?? ''}:${eventsReload}`
  const eventsLoading = Boolean(token && eventRequest.key !== requestKey)
  const eventsError = eventRequest.key === requestKey ? eventRequest.error : ''

  if (authLoading) return <div className="auth-screen"><p>Checking your session…</p></div>
  if (!token || !account) return <AuthScreen initialError={authError} onAuthenticated={(nextToken) => { sessionStorage.setItem('campus-event-token', nextToken); setEvents([]); setAuthError(''); setToken(nextToken) }} />

  return <MotionConfig reducedMotion="user"><div className="app-shell sidebar-collapsed">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">✳</span><span>Campus events</span></div><div className="sidebar-label">Workspace</div><nav>{navItems.map(([icon, label]) => <button key={label} className={activeNav === label ? 'nav-item active' : 'nav-item'} onClick={() => openModule(label)}><span className="nav-icon">{icon}</span><span className="nav-label">{label}</span>{label === 'My registrations' && <span className="nav-count">{registered.length}</span>}</button>)}</nav>{canManageEvents && <><div className="sidebar-label lower-label">Manage</div><nav><button className={activeNav === 'Create an event' ? 'nav-item active' : 'nav-item'} onClick={() => openModule('Create an event')}><span className="nav-icon">＋</span><span className="nav-label">Create an event</span></button><button className={activeNav === 'Manage events' ? 'nav-item active' : 'nav-item'} onClick={() => openModule('Manage events')}><span className="nav-icon">▤</span><span className="nav-label">Manage events</span></button><button className={activeNav === 'Insights' ? 'nav-item active' : 'nav-item'} onClick={() => openModule('Insights')}><span className="nav-icon">↗</span><span className="nav-label">Insights</span></button>{isAdmin && <button className={activeNav === 'Approvals' ? 'nav-item active' : 'nav-item'} onClick={() => openModule('Approvals')}><span className="nav-icon">✓</span><span className="nav-label">Approvals</span></button>}</nav></>}<div className="sidebar-bottom"><div className="help-card"><span className="help-icon">?</span><div><strong>Need a hand?</strong><span>Visit the help center</span></div><span>→</span></div><button className={activeNav === 'Account info' ? 'profile active' : 'profile'} onClick={() => openModule('Account info')}><span className="avatar">{account.name.split(' ').map((part) => part[0]).join('')}</span><span className="profile-copy"><strong>{account.name}</strong><small>{account.role} · {account.department}</small></span><span>⌄</span></button></div></aside>
    <main className="main-content"><header className="topbar"><div className="breadcrumb"><span>Workspace</span><span>/</span><strong>{activeNav}</strong></div><div className="top-actions"><button className="icon-button notification-trigger" aria-label={`Notifications${unreadNotifications ? `, ${unreadNotifications} unread` : ''}`} onClick={() => openModule('Notifications')}>♧{unreadNotifications > 0 && <span className="unread-count">{unreadNotifications > 99 ? '99+' : unreadNotifications}</span>}</button><button className="user-avatar" aria-label="Open account info" onClick={() => openModule('Account info')}>{account.name.split(' ').map((part) => part[0]).join('')}</button></div></header><div className="content-wrap"><AnimatePresence mode="wait" initial={false}><motion.div className="module-transition" key={activeNav} initial={{ opacity: 0, y: 9 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.18, ease: 'easeOut' }}>
      {eventsError && <div className="api-alert" role="alert">Events couldn’t be loaded: {eventsError}<button onClick={() => setEventsReload((value) => value + 1)}>Retry</button></div>}
      {activityError && <div className="api-alert" role="alert">Your registrations and saved events couldn’t be loaded: {activityError}</div>}
      {eventsLoading && <p className="api-status" role="status">Loading events…</p>}
      {activeNav === 'Overview' && <Overview name={account.name} allowCreate={canManageEvents} events={events} registered={registered} saved={saved} onRegister={toggleRegistration} onSave={toggleSaved} onDiscover={() => openModule('Discover')} onCreate={() => openModule('Create an event')} />}
      {activeNav === 'Discover' && <EventBrowser title="Discover events" subtitle="Search the full campus calendar." events={filteredEvents} query={query} setQuery={setQuery} activeFilter={activeFilter} setActiveFilter={setActiveFilter} registered={registered} saved={saved} onRegister={toggleRegistration} onSave={toggleSaved} />}
      {activeNav === 'My registrations' && <EventBrowser title="My registrations" subtitle="Your confirmed and upcoming campus events." events={events.filter((event) => registered.includes(event.id))} query={query} setQuery={setQuery} activeFilter="All events" setActiveFilter={setActiveFilter} registered={registered} saved={saved} onRegister={toggleRegistration} onSave={toggleSaved} />}
      {activeNav === 'Saved events' && <EventBrowser title="Saved events" subtitle="Events you want to come back to." events={events.filter((event) => saved.includes(event.id))} query={query} setQuery={setQuery} activeFilter="All events" setActiveFilter={setActiveFilter} registered={registered} saved={saved} onRegister={toggleRegistration} onSave={toggleSaved} />}
      {activeNav === 'Create an event' && <CreateEvent token={token} onCreate={async (event) => { await apiRequest('/api/events', { method: 'POST', body: JSON.stringify(event) }, token); notify('Event submitted for admin approval'); openModule('Discover') }} />}
      {activeNav === 'Manage events' && <ManageEvents token={token} notify={notify} />}
      {activeNav === 'Insights' && <Insights events={events} registered={registered} saved={saved} />}
      {activeNav === 'Approvals' && <Approvals token={token} notify={notify} />}
      {activeNav === 'Notifications' && <Notifications items={notifications} loading={notificationRequest.key !== `${token}:${notificationReload}`} error={notificationRequest.key === `${token}:${notificationReload}` ? notificationRequest.error : ''} onReload={() => setNotificationReload((value) => value + 1)} onRead={markNotificationRead} onReadAll={markAllNotificationsRead} />}
      {activeNav === 'Account info' && <AccountInfo account={account} onSave={async (nextAccount) => { const result = await apiRequest<AuthUser>('/api/auth/me/preferences', { method: 'PATCH', body: JSON.stringify({ name: nextAccount.name, email: nextAccount.email, department: nextAccount.department, event_reminders_enabled: nextAccount.reminders, announcements_enabled: nextAccount.announcements }) }, token); setAccount({ name: result.data.name, email: result.data.email, department: result.data.department ?? '', role: result.data.role, reminders: result.data.event_reminders_enabled, announcements: result.data.announcements_enabled }); notify('Account information updated') }} onLogout={signOut} />}
    </motion.div></AnimatePresence></div></main><AnimatePresence>{toast && <motion.div className="toast" role="status" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }} transition={{ duration: 0.18, ease: 'easeOut' }}>{toast}<button onClick={() => setToast('')}>×</button></motion.div>}</AnimatePresence>
  </div></MotionConfig>
}

function Overview({ name, allowCreate, events, registered, saved, onRegister, onSave, onDiscover, onCreate }: { name: string; allowCreate: boolean; events: EventItem[]; registered: number[]; saved: number[]; onRegister: (event: EventItem) => void; onSave: (event: EventItem) => void; onDiscover: () => void; onCreate: () => void }) {
  const featured = events[0]
  return <><section className="welcome-row"><div><p className="eyebrow">Campus events</p><h1>Welcome, {name.split(' ')[0]}</h1><p className="welcome-copy">Find events, register, and keep your campus schedule in one place.</p></div>{allowCreate && <button className="primary-button" onClick={onCreate}><span>＋</span> Create an event</button>}</section>{featured ? <section className="hero-banner"><div className="hero-copy"><span className="tag">Featured event</span><h2>{featured.title}</h2><p>{featured.date} · {featured.venue}</p><button className="text-button" onClick={onDiscover}>View all events <span>↗</span></button></div><div className="hero-stat"><strong>{events.length}</strong><span>published events</span></div></section> : <div className="empty-state">No approved events are available yet.</div>}<section className="stats-row"><div className="stat-card"><div className="stat-icon green">◷</div><div><span>My upcoming</span><strong>{String(registered.length).padStart(2, '0')} <small>events</small></strong></div></div><div className="stat-card"><div className="stat-icon yellow">♢</div><div><span>Saved events</span><strong>{String(saved.length).padStart(2, '0')} <small>to revisit</small></strong></div></div><div className="stat-card"><div className="stat-icon blue">✦</div><div><span>Campus events</span><strong>{events.length} <small>published</small></strong></div></div></section><section className="section-heading"><div><h2>Happening around campus</h2><p>Discover something worth showing up for.</p></div><button className="view-link" onClick={onDiscover}>View all events <span>↗</span></button></section>{events.length > 0 && <EventGrid events={events.slice(0, 3)} registered={registered} saved={saved} onRegister={onRegister} onSave={onSave} />}</>
}

function AuthScreen({ initialError, onAuthenticated }: { initialError: string; onAuthenticated: (token: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [department, setDepartment] = useState('')
  const [error, setError] = useState(initialError)
  const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const body = mode === 'login' ? { email, password } : { name, email, password, department }
      const result = await apiRequest<AuthUser>(`/api/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body: JSON.stringify(body) })
      if (!result.token) throw new Error('The server did not return an access token')
      onAuthenticated(result.token)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to connect to the campus event service')
    } finally {
      setSubmitting(false)
    }
  }
  return <main className="auth-screen"><section className="auth-panel"><div className="auth-brand"><span>✳</span> Campus events</div><p className="eyebrow">Campus event management</p><h1>{mode === 'login' ? 'Sign in to your account' : 'Create your account'}</h1><p className="auth-intro">{mode === 'login' ? 'Use your campus account to continue.' : 'Register with your campus email.'}</p><div className="auth-tabs"><button className={mode === 'login' ? 'selected' : ''} onClick={() => { setMode('login'); setError('') }}>Sign in</button><button className={mode === 'register' ? 'selected' : ''} onClick={() => { setMode('register'); setError('') }}>Register</button></div><form className="auth-form" onSubmit={submit}>{mode === 'register' && <><label>Full name<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={120} /></label><label>Department<input value={department} onChange={(event) => setDepartment(event.target.value)} maxLength={120} /></label></>}<label>Campus email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} /></label><label>Password<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={mode === 'register' ? 12 : 1} maxLength={72} /></label>{mode === 'register' && <small className="password-note">Use at least 12 characters.</small>}{error && <p className="auth-error" role="alert">{error}</p>}<button className="primary-button auth-submit" type="submit" disabled={submitting}>{submitting ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button></form><p className="auth-footnote">Faculty, organizers, and administrators must sign in with an assigned account.</p></section></main>
}

function EventBrowser({ title, subtitle, events, query, setQuery, activeFilter, setActiveFilter, registered, saved, onRegister, onSave }: { title: string; subtitle: string; events: EventItem[]; query: string; setQuery: (value: string) => void; activeFilter: string; setActiveFilter: (value: string) => void; registered: number[]; saved: number[]; onRegister: (event: EventItem) => void; onSave: (event: EventItem) => void }) {
  return <><section className="welcome-row"><div><p className="eyebrow">Campus calendar</p><h1>{title}</h1><p className="welcome-copy">{subtitle}</p></div></section><div className="toolbar"><div className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search events, people, places..." /></div><div className="filter-group">{['All events', 'Talks', 'Workshops', 'Sports'].map((filter) => <button key={filter} className={activeFilter === filter ? 'filter active' : 'filter'} onClick={() => setActiveFilter(filter)}>{filter}</button>)}</div></div>{events.length ? <EventGrid events={events} registered={registered} saved={saved} onRegister={onRegister} onSave={onSave} /> : <div className="empty-state">No events here yet.</div>}</>
}

function Notifications({ items, loading, error, onReload, onRead, onReadAll }: { items: NotificationItem[]; loading: boolean; error: string; onReload: () => void; onRead: (id: number) => void; onReadAll: () => void }) {
  const unreadCount = items.filter((item) => !item.is_read).length
  const typeLabels: Record<string, string> = { event_update: 'Event update', event_cancelled: 'Cancellation', event_approval: 'Approval update', event_reminder: 'Event reminder', system: 'Notification' }
  return <><section className="welcome-row"><div><p className="eyebrow">Your activity</p><h1>Notifications</h1><p className="welcome-copy">Event updates, approvals, and reminders for your account.</p></div><div className="notification-actions"><button className="secondary-button" type="button" onClick={onReload} disabled={loading}>Refresh</button><button className="secondary-button" type="button" onClick={onReadAll} disabled={loading || unreadCount === 0}>Mark all read</button></div></section>{error && <div className="api-alert" role="alert">Notifications couldn’t be loaded: {error}<button type="button" onClick={onReload}>Retry</button></div>}{loading ? <p className="api-status" role="status">Loading notifications…</p> : items.length === 0 ? <div className="empty-state">You have no notifications.</div> : <section className="notification-list">{items.map((item) => <article key={item.id} className={item.is_read ? 'notification-item read' : 'notification-item unread'}><span className="notification-mark" aria-hidden="true">{item.notification_type === 'event_reminder' ? '◷' : item.notification_type === 'event_cancelled' ? '!' : '•'}</span><div className="notification-copy"><div className="notification-meta"><span>{typeLabels[item.notification_type] ?? 'Notification'}</span><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time></div><p>{item.message}</p></div>{!item.is_read && <button className="mark-read" type="button" onClick={() => onRead(item.id)}>Mark read</button>}</article>)}</section>}</>
}

function localDateTime(value: string) {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

function ManageEvents({ token, notify }: { token: string; notify: (message: string) => void }) {
  const [managedEvents, setManagedEvents] = useState<ManagedEvent[]>([])
  const [loadedKey, setLoadedKey] = useState('')
  const [loadError, setLoadError] = useState({ key: '', message: '' })
  const [reload, setReload] = useState(0)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [processingId, setProcessingId] = useState<number | null>(null)
  const requestKey = `${token}:${reload}`
  const loading = loadedKey !== requestKey
  const error = loadError.key === requestKey ? loadError.message : ''

  useEffect(() => {
    let cancelled = false
    apiRequest<ManagedEvent[]>('/api/managed-events', {}, token)
      .then(({ data }) => { if (!cancelled) { setManagedEvents(data); setLoadedKey(requestKey); setLoadError({ key: requestKey, message: '' }) } })
      .catch((requestError: Error) => { if (!cancelled) { setLoadedKey(requestKey); setLoadError({ key: requestKey, message: requestError.message }) } })
    return () => { cancelled = true }
  }, [token, reload, requestKey])

  const cancelEvent = async (event: ManagedEvent) => {
    if (!window.confirm(`Cancel “${event.title}”? Registered participants will be notified.`)) return
    setProcessingId(event.id)
    setLoadError({ key: '', message: '' })
    try {
      await apiRequest(`/api/managed-events/${event.id}/cancel`, { method: 'PATCH', body: JSON.stringify({}) }, token)
      setManagedEvents((current) => current.map((item) => item.id === event.id ? { ...item, status: 'cancelled' } : item))
      notify('Event cancelled; participants have been notified')
    } catch (requestError) {
      setLoadError({ key: requestKey, message: requestError instanceof Error ? requestError.message : 'Event cancellation failed' })
    } finally {
      setProcessingId(null)
    }
  }

  const saveEvent = async (eventId: number, payload: CreateEventPayload) => {
    const { data } = await apiRequest<ManagedEvent>(`/api/managed-events/${eventId}`, { method: 'PATCH', body: JSON.stringify(payload) }, token)
    setManagedEvents((current) => current.map((item) => item.id === eventId ? { ...item, ...data, venue: item.venue, location: item.location } : item))
    setEditingId(null)
    notify('Event changes saved')
  }

  return <><section className="welcome-row"><div><p className="eyebrow">Organizer tools</p><h1>Manage events</h1><p className="welcome-copy">Edit event details or cancel an event. Participants receive schedule and cancellation notices.</p></div><button className="secondary-button" type="button" disabled={loading} onClick={() => setReload((value) => value + 1)}>Refresh</button></section>{error && <div className="api-alert" role="alert">{error}<button type="button" onClick={() => setReload((value) => value + 1)}>Retry</button></div>}{loading ? <p className="api-status" role="status">Loading your events…</p> : managedEvents.length === 0 ? <div className="empty-state">You have no events to manage.</div> : <section className="managed-event-list">{managedEvents.map((event) => <article className="managed-event" key={event.id}><div className="managed-event-heading"><div><span className={`status-pill status-${event.status}`}>{event.status}</span><h2>{event.title}</h2></div>{event.status !== 'cancelled' && event.status !== 'rejected' && <div className="managed-actions"><button className="secondary-button" type="button" disabled={processingId !== null} onClick={() => setEditingId(editingId === event.id ? null : event.id)}>{editingId === event.id ? 'Close editor' : 'Edit'}</button><button className="reject-button" type="button" disabled={processingId !== null} onClick={() => cancelEvent(event)}>{processingId === event.id ? 'Cancelling…' : 'Cancel event'}</button></div>}</div><p className="managed-summary">{event.category} · {new Date(event.starts_at).toLocaleString()} · {event.venue}, {event.location} · {event.participant_count} participants</p>{editingId === event.id && <EventEditForm event={event} token={token} onSave={(payload) => saveEvent(event.id, payload)} onCancel={() => setEditingId(null)} />}</article>)}</section>}</>
}

function EventEditForm({ event, token, onSave, onCancel }: { event: ManagedEvent; token: string; onSave: (payload: CreateEventPayload) => Promise<void>; onCancel: () => void }) {
  const [venues, setVenues] = useState<VenueOption[]>([])
  const [values, setValues] = useState<CreateEventPayload>({ title: event.title, description: event.description, category: event.category, starts_at: localDateTime(event.starts_at), ends_at: localDateTime(event.ends_at), registration_deadline: localDateTime(event.registration_deadline), venue_id: event.venue_id, capacity: event.capacity })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let cancelled = false
    apiRequest<VenueOption[]>('/api/venues', {}, token)
      .then(({ data }) => { if (!cancelled) setVenues(data) })
      .catch((requestError: Error) => { if (!cancelled) setError(requestError.message) })
    return () => { cancelled = true }
  }, [token])
  const update = (field: keyof CreateEventPayload, value: string) => setValues((current) => ({ ...current, [field]: field === 'venue_id' || field === 'capacity' ? Number(value) : value }))
  const submit = async (formEvent: FormEvent) => {
    formEvent.preventDefault()
    setSaving(true)
    setError('')
    const selectedVenue = venues.find((venue) => venue.id === values.venue_id)
    if (!selectedVenue) { setError('Select an available venue'); setSaving(false); return }
    if (values.capacity > selectedVenue.capacity) { setError(`Capacity exceeds this venue’s limit of ${selectedVenue.capacity}`); setSaving(false); return }
    if (new Date(values.ends_at) <= new Date(values.starts_at) || new Date(values.registration_deadline) > new Date(values.starts_at)) { setError('Check the event start/end times and registration deadline'); setSaving(false); return }
    try { await onSave({ ...values, starts_at: new Date(values.starts_at).toISOString(), ends_at: new Date(values.ends_at).toISOString(), registration_deadline: new Date(values.registration_deadline).toISOString() }) }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Event update failed') }
    finally { setSaving(false) }
  }
  return <form className="event-form inline-event-editor" onSubmit={submit}><label>Title<input value={values.title} onChange={(inputEvent) => update('title', inputEvent.target.value)} required minLength={3} maxLength={180} /></label><label>Description<textarea value={values.description} onChange={(inputEvent) => update('description', inputEvent.target.value)} maxLength={10000} rows={3} required /></label><div className="form-row"><label>Category<select value={values.category} onChange={(inputEvent) => update('category', inputEvent.target.value)}><option>Talks</option><option>Workshops</option><option>Sports</option><option>Exhibitions</option></select></label><label>Venue<select value={values.venue_id} onChange={(inputEvent) => update('venue_id', inputEvent.target.value)}>{venues.map((venue) => <option key={venue.id} value={venue.id}>{venue.name} · {venue.location} · max {venue.capacity}</option>)}</select></label></div><div className="form-row"><label>Starts<input type="datetime-local" value={values.starts_at} onChange={(inputEvent) => update('starts_at', inputEvent.target.value)} required /></label><label>Ends<input type="datetime-local" value={values.ends_at} onChange={(inputEvent) => update('ends_at', inputEvent.target.value)} required /></label></div><div className="form-row"><label>Registration deadline<input type="datetime-local" value={values.registration_deadline} onChange={(inputEvent) => update('registration_deadline', inputEvent.target.value)} required /></label><label>Capacity<input type="number" min="1" max="5000" value={values.capacity} onChange={(inputEvent) => update('capacity', inputEvent.target.value)} required /></label></div>{error && <p className="auth-error" role="alert">{error}</p>}<div className="managed-actions"><button className="primary-button" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save event'}</button><button className="secondary-button" type="button" onClick={onCancel}>Discard</button></div></form>
}

function Approvals({ token, notify }: { token: string; notify: (message: string) => void }) {
  const [pendingEvents, setPendingEvents] = useState<PendingEvent[]>([])
  const [loadResult, setLoadResult] = useState({ key: '', error: '' })
  const [reviewError, setReviewError] = useState('')
  const [processingId, setProcessingId] = useState<number | null>(null)
  const [reload, setReload] = useState(0)
  const requestKey = `${token}:${reload}`
  const loading = loadResult.key !== requestKey
  const error = reviewError || (loadResult.key === requestKey ? loadResult.error : '')

  useEffect(() => {
    let cancelled = false
    apiRequest<PendingEvent[]>('/api/admin/events/pending', {}, token)
      .then(({ data }) => { if (!cancelled) { setPendingEvents(data); setLoadResult({ key: requestKey, error: '' }) } })
      .catch((requestError: Error) => { if (!cancelled) setLoadResult({ key: requestKey, error: requestError.message }) })
    return () => { cancelled = true }
  }, [token, reload, requestKey])

  const review = async (eventId: number, decision: 'approved' | 'rejected') => {
    setProcessingId(eventId)
    setReviewError('')
    try {
      await apiRequest(`/api/admin/events/${eventId}/review`, { method: 'PATCH', body: JSON.stringify({ decision }) }, token)
      setPendingEvents((current) => current.filter((event) => event.id !== eventId))
      notify(decision === 'approved' ? 'Event approved and published' : 'Event rejected')
    } catch (requestError) {
      setReviewError(requestError instanceof Error ? requestError.message : 'Review action failed')
    } finally {
      setProcessingId(null)
    }
  }

  return <><section className="welcome-row"><div><p className="eyebrow">Administrator tools</p><h1>Event approvals</h1><p className="welcome-copy">Review event submissions before they appear in the campus calendar.</p></div><button className="secondary-button" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}>Refresh</button></section>{error && <div className="api-alert" role="alert">{error}<button type="button" onClick={() => setReload((value) => value + 1)}>Retry</button></div>}{loading ? <p className="api-status" role="status">Loading pending submissions…</p> : pendingEvents.length === 0 ? <div className="empty-state">There are no events waiting for approval.</div> : <section className="approval-list">{pendingEvents.map((event) => <article className="approval-item" key={event.id}><div className="approval-main"><div className="approval-title"><div><span className="category-pill static-pill">{event.category}</span><span className="pending-label">Pending review</span></div><h2>{event.title}</h2></div><p>{event.description}</p><dl><div><dt>Organizer</dt><dd>{event.organizer} · {event.organizer_email}</dd></div><div><dt>When</dt><dd>{new Date(event.starts_at).toLocaleString()} to {new Date(event.ends_at).toLocaleTimeString()}</dd></div><div><dt>Venue</dt><dd>{event.venue} · {event.location}</dd></div><div><dt>Registration deadline</dt><dd>{new Date(event.registration_deadline).toLocaleString()}</dd></div><div><dt>Capacity</dt><dd>{event.capacity}</dd></div></dl></div><div className="approval-actions"><button className="approve-button" disabled={processingId !== null} onClick={() => review(event.id, 'approved')}>{processingId === event.id ? 'Saving…' : 'Approve'}</button><button className="reject-button" disabled={processingId !== null} onClick={() => review(event.id, 'rejected')}>Reject</button></div></article>)}</section>}</>
}

function EventGrid({ events, registered, saved, onRegister, onSave }: { events: EventItem[]; registered: number[]; saved: number[]; onRegister: (event: EventItem) => void; onSave: (event: EventItem) => void }) { return <motion.section className="event-grid" initial="hidden" animate="visible" variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.055 } } }}>{events.map((event) => <motion.article className="event-card" key={event.id} variants={{ hidden: { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0, transition: { duration: 0.24, ease: 'easeOut' } } }} whileHover={{ y: -4 }} whileTap={{ scale: 0.99 }}><div className="event-image" style={{ backgroundImage: `url(${event.image})` }}><span className="category-pill">{event.category}</span><button className={saved.includes(event.id) ? 'save-button saved' : 'save-button'} onClick={() => onSave(event)}>{saved.includes(event.id) ? '♥' : '♡'}</button></div><div className="event-info"><div className="event-date">{event.date}</div><h3>{event.title}</h3><div className="event-meta"><span>⌖ {event.venue}</span><span>◉ {event.host}</span></div><div className="event-footer"><div className="attendee-row"><span className="mini-avatar avatar-a">JL</span><span className="mini-avatar avatar-b">SK</span><span className="mini-avatar avatar-c">+{event.attendees - 2}</span></div><button className={registered.includes(event.id) ? 'register registered' : 'register'} onClick={() => onRegister(event)}>{registered.includes(event.id) ? 'Registered ✓' : 'Register'}</button></div></div></motion.article>)}</motion.section> }

function CreateEvent({ token, onCreate }: { token: string; onCreate: (event: CreateEventPayload) => Promise<void> }) {
  const [venues, setVenues] = useState<VenueOption[]>([])
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('Talks')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [deadline, setDeadline] = useState('')
  const [venueId, setVenueId] = useState('')
  const [capacity, setCapacity] = useState('')
  const [loadingVenues, setLoadingVenues] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    apiRequest<VenueOption[]>('/api/venues', {}, token)
      .then(({ data }) => { if (!cancelled) setVenues(data) })
      .catch((requestError: Error) => { if (!cancelled) setError(requestError.message) })
      .finally(() => { if (!cancelled) setLoadingVenues(false) })
    return () => { cancelled = true }
  }, [token])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    const selectedVenue = venues.find((venue) => venue.id === Number(venueId))
    if (!selectedVenue) { setError('Select an available venue'); setSubmitting(false); return }
    if (Number(capacity) > selectedVenue.capacity) { setError(`Capacity exceeds this venue’s limit of ${selectedVenue.capacity}`); setSubmitting(false); return }
    try {
      await onCreate({
        title: title.trim(), description: description.trim(), category,
        starts_at: new Date(startsAt).toISOString(), ends_at: new Date(endsAt).toISOString(),
        registration_deadline: new Date(deadline).toISOString(), venue_id: selectedVenue.id, capacity: Number(capacity),
      })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Event submission failed')
    } finally {
      setSubmitting(false)
    }
  }

  return <><section className="welcome-row"><div><p className="eyebrow">Organizer tools</p><h1>Create an event</h1><p className="welcome-copy">Submit a new event for admin approval and campus publishing.</p></div></section><form className="event-form" onSubmit={submit}><label>Event title<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Robotics club open lab" required minLength={3} maxLength={180} /></label><label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What should attendees know?" rows={4} maxLength={10000} required /></label><div className="form-row"><label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option>Talks</option><option>Workshops</option><option>Sports</option><option>Exhibitions</option></select></label><label>Venue<select value={venueId} onChange={(event) => setVenueId(event.target.value)} required disabled={loadingVenues || venues.length === 0}><option value="">{loadingVenues ? 'Loading venues…' : 'Select a venue'}</option>{venues.map((venue) => <option key={venue.id} value={venue.id}>{venue.name} · {venue.location} · max {venue.capacity}</option>)}</select></label></div><div className="form-row"><label>Starts<input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required /></label><label>Ends<input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} required /></label></div><div className="form-row"><label>Registration deadline<input type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} required /></label><label>Maximum participants<input type="number" min="1" max="5000" value={capacity} onChange={(event) => setCapacity(event.target.value)} required /></label></div>{error && <p className="auth-error" role="alert">{error}</p>}<button className="primary-button" type="submit" disabled={submitting || loadingVenues || venues.length === 0}>{submitting ? 'Submitting…' : 'Submit for approval'}</button></form></>
}

function Insights({ events, registered, saved }: { events: EventItem[]; registered: number[]; saved: number[] }) { const totalAttendees = events.reduce((sum, event) => sum + event.attendees, 0); return <><section className="welcome-row"><div><p className="eyebrow">Workspace analytics</p><h1>Insights</h1><p className="welcome-copy">A quick view of event activity across campus.</p></div></section><section className="stats-row"><div className="stat-card"><div className="stat-icon green">◉</div><div><span>Published events</span><strong>{events.length}</strong></div></div><div className="stat-card"><div className="stat-icon yellow">♧</div><div><span>Total attendance</span><strong>{totalAttendees}</strong></div></div><div className="stat-card"><div className="stat-icon blue">◷</div><div><span>Your activity</span><strong>{registered.length + saved.length}</strong></div></div></section><div className="insight-panel"><h2>Event performance</h2>{events.map((event) => <div className="insight-row" key={event.id}><span>{event.title}</span><div className="progress"><i style={{ width: `${Math.min(100, event.attendees / 5)}%` }}></i></div><strong>{event.attendees}</strong></div>)}</div></> }

function AccountInfo({ account, onSave, onLogout }: { account: Account; onSave: (account: Account) => void; onLogout: () => void }) {
  const [draft, setDraft] = useState(account)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const update = (field: keyof typeof draft, value: string | boolean) => setDraft((current) => ({ ...current, [field]: value }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setSaveError('')
    try { await onSave(draft) }
    catch (error) { setSaveError(error instanceof Error ? error.message : 'Account information could not be saved') }
    finally { setSaving(false) }
  }
  return <><section className="welcome-row"><div><p className="eyebrow">Personal settings</p><h1>Account info</h1><p className="welcome-copy">Manage your profile and the notifications you receive.</p></div><button className="secondary-button" type="button" onClick={onLogout}>Sign out</button></section><form className="account-layout" onSubmit={submit}><div className="account-form"><div className="account-header"><span className="large-avatar">{draft.name.split(' ').map((part) => part[0]).join('')}</span><div><strong>{draft.name}</strong><span>{draft.role} · {draft.department}</span></div></div><div className="form-row"><label>Full name<input value={draft.name} onChange={(event) => update('name', event.target.value)} required /></label><label>Email address<input type="email" value={draft.email} onChange={(event) => update('email', event.target.value)} required /></label></div><div className="form-row"><label>Department<select value={draft.department} onChange={(event) => update('department', event.target.value)}><option>Engineering</option><option>Arts and Design</option><option>Business</option><option>Sciences</option></select></label><label>Role<input value={draft.role} readOnly /></label></div>{saveError && <p className="auth-error" role="alert">{saveError}</p>}<button className="primary-button" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button></div><div className="preference-panel"><h2>Notifications</h2><p>Choose what you want to hear about.</p><label className="toggle-row"><span><strong>Event reminders</strong><small>Get a reminder before registered events.</small></span><input type="checkbox" checked={draft.reminders} onChange={(event) => update('reminders', event.target.checked)} /></label><label className="toggle-row"><span><strong>Campus announcements</strong><small>Receive important venue and schedule updates.</small></span><input type="checkbox" checked={draft.announcements} onChange={(event) => update('announcements', event.target.checked)} /></label></div></form></>
}

export default App
