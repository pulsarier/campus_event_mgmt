import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import QRCode from 'qrcode'
import './App.css'

type EventItem = { id: number; title: string; category: string; date: string; venue: string; host: string; attendees: number; image: string; starts_at: string; ends_at: string }
type Account = { name: string; email: string; department: string; role: string; reminders: boolean; announcements: boolean }
type AuthUser = Omit<Pick<Account, 'name' | 'email' | 'department' | 'role'>, 'department'> & { department: string | null; event_reminders_enabled: boolean; announcements_enabled: boolean }
type ApiEvent = { id: number | string; title: string; category: string; starts_at: string; ends_at: string; venue: string; organizer: string; registrations: number }
type FeedbackItem = { id: number; user_id: number; user_name: string; rating: number; comment: string; created_at: string }
type FeedbackSummary = { event_id: number; event_title: string; average_rating: number; total_reviews: number; items: FeedbackItem[] }
type CreateEventPayload = { title: string; description: string; category: string; starts_at: string; ends_at: string; registration_deadline: string; venue_id: number; capacity: number }
type VenueOption = { id: number; name: string; location: string; capacity: number }
type AdminUser = { id: number | string; name: string; email: string; role: string; department: string | null; created_at: string }
type AdminVenue = { id: number | string; name: string; location: string; capacity: number; availability: boolean }
type ApiListItem = { id: number | string; status?: string; attended?: boolean }
type NotificationItem = { id: number; event_id: number | null; message: string; notification_type: string; is_read: boolean; created_at: string }
type AttendancePass = { value: string; event_id: number; expires_at: string }
type AttendanceReport = { id: number; title: string; confirmed_count: number; attended_count: number; attendance_percentage: number; participants: Array<{ id: number; name: string; email: string; marked_at: string | null; attended: boolean }> }
type PendingEvent = { id: number; title: string; description: string; category: string; starts_at: string; ends_at: string; registration_deadline: string; capacity: number; venue: string; location: string; organizer: string; organizer_email: string }
type ManagedEvent = { id: number; title: string; description: string; category: string; starts_at: string; ends_at: string; registration_deadline: string; capacity: number; status: string; venue_id: number; venue: string; location: string; participant_count: number }
type ApiResult<T> = { data: T; token?: string; error?: string }
type RegistrationConflict = {
  conflicts: Array<{ id: number | string; title: string; starts_at: string; ends_at: string }>
  alternatives: Array<{ id: number | string; title: string; category: string; starts_at: string; ends_at: string; venue: string }>
}

class ApiError extends Error {
  data: unknown

  constructor(message: string, data: unknown) {
    super(message)
    this.data = data
  }
}
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
  if (!response.ok) throw new ApiError(result.error ?? 'The request could not be completed', result.data)
  return result
}

function mapApiEvent(event: ApiEvent): EventItem {
  return {
    id: Number(event.id),
    title: event.title,
    category: event.category,
    date: new Date(event.starts_at).toLocaleString(),
    venue: event.venue,
    host: event.organizer,
    attendees: Number(event.registrations),
    image: fallbackImage,
    starts_at: event.starts_at,
    ends_at: event.ends_at,
  }
}
const baseNavItems = [['◈', 'Overview'], ['▦', 'Discover'], ['◷', 'My registrations'], ['♢', 'Saved events']]
const modules = ['Overview', 'Discover', 'My registrations', 'Saved events', 'Create an event', 'Manage events', 'Insights', 'Approvals', 'Users', 'Venues', 'Notifications', 'Account info']

function moduleFromHash() { const value = decodeURIComponent(window.location.hash.slice(1)); return modules.includes(value) ? value : 'Overview' }

function resetTokenFromHash() {
  const hash = window.location.hash
  if (!hash.startsWith('#reset-password?')) return ''
  return new URLSearchParams(hash.slice(hash.indexOf('?') + 1)).get('token') ?? ''
}

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
  const [confirmedRegistrations, setConfirmedRegistrations] = useState<number[]>([])
  const [attendedRegistrations, setAttendedRegistrations] = useState<number[]>([])
  const [saved, setSaved] = useState<number[]>([])
  const [query, setQuery] = useState('')
  const [activeFilter, setActiveFilter] = useState('All events')
  const [toast, setToast] = useState('')
  const [now, setNow] = useState<number>(() => Date.now())
  const [account, setAccount] = useState<Account | null>(null)
  const [attendancePassEvent, setAttendancePassEvent] = useState<EventItem | null>(null)
  const [feedbackEvent, setFeedbackEvent] = useState<EventItem | null>(null)
  const [feedbackSummaryEvent, setFeedbackSummaryEvent] = useState<ManagedEvent | null>(null)
  const [registrationConflict, setRegistrationConflict] = useState<RegistrationConflict | null>(null)
  useEffect(() => { const syncModule = () => setRequestedNav(moduleFromHash()); window.addEventListener('hashchange', syncModule); window.addEventListener('popstate', syncModule); return () => { window.removeEventListener('hashchange', syncModule); window.removeEventListener('popstate', syncModule) } }, [])
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60000); return () => window.clearInterval(timer) }, [])
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
        setConfirmedRegistrations(registrationsResult.data.filter((item) => item.status === 'confirmed').map((item) => Number(item.id)))
        setAttendedRegistrations(registrationsResult.data.filter((item) => item.attended).map((item) => Number(item.id)))
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
      setConfirmedRegistrations(result.data.filter((item) => item.status === 'confirmed').map((item) => Number(item.id)))
      setAttendedRegistrations(result.data.filter((item) => item.attended).map((item) => Number(item.id)))
      setEventsReload((value) => value + 1)
    } catch (error) {
      if (error instanceof ApiError && error.data && typeof error.data === 'object' && 'conflicts' in error.data && 'alternatives' in error.data) {
        setRegistrationConflict(error.data as RegistrationConflict)
      } else notify(error instanceof Error ? error.message : 'Registration could not be updated')
    }
  }
  const registerAlternative = async (event: RegistrationConflict['alternatives'][number]) => {
    if (!token) return
    try {
      const result = await apiRequest<{ status: string }>(`/api/events/${event.id}/registrations`, { method: 'POST', body: JSON.stringify({}) }, token)
      const registrationsResult = await apiRequest<ApiListItem[]>('/api/registrations/me', {}, token)
      setRegistered(registrationsResult.data.map((item) => Number(item.id)))
      setConfirmedRegistrations(registrationsResult.data.filter((item) => item.status === 'confirmed').map((item) => Number(item.id)))
      setAttendedRegistrations(registrationsResult.data.filter((item) => item.attended).map((item) => Number(item.id)))
      setEventsReload((value) => value + 1)
      setRegistrationConflict(null)
      notify(result.data.status === 'waitlisted' ? `Added to the waitlist for ${event.title}` : `Registered for ${event.title}`)
    } catch (error) {
      if (error instanceof ApiError && error.data && typeof error.data === 'object' && 'conflicts' in error.data && 'alternatives' in error.data) {
        setRegistrationConflict(error.data as RegistrationConflict)
      } else notify(error instanceof Error ? error.message : 'Alternative registration could not be completed')
    }
  }
  const downloadCertificate = async (event: EventItem) => {
    if (!token) return
    try {
      const response = await fetch(`${apiBase}/api/events/${event.id}/certificate`, { headers: { Authorization: `Bearer ${token}` } })
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as ApiResult<unknown>
        throw new Error(result.error ?? 'Certificate could not be downloaded')
      }
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = `attendance-certificate-${event.id}.pdf`
      link.click()
      URL.revokeObjectURL(url)
    } catch (error) { notify(error instanceof Error ? error.message : 'Certificate could not be downloaded') }
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
  const navItems = isAdmin ? [...baseNavItems, ['♙', 'Users'], ['⌂', 'Venues']] : baseNavItems
  const activeNav = (!canManageEvents && ['Create an event', 'Manage events', 'Insights'].includes(requestedNav)) || (!isAdmin && ['Approvals', 'Users', 'Venues'].includes(requestedNav)) ? 'Overview' : requestedNav
  const openModule = (label: string) => { const destination = ((!canManageEvents && ['Create an event', 'Manage events', 'Insights'].includes(label)) || (!isAdmin && ['Approvals', 'Users', 'Venues'].includes(label))) ? 'Overview' : label; setRequestedNav(destination); setQuery(''); setActiveFilter('All events'); if (destination === 'Notifications') setNotificationReload((value) => value + 1); window.history.pushState({}, '', `#${encodeURIComponent(destination)}`) }
  const signOut = () => { sessionStorage.removeItem('campus-event-token'); setToken(null); setValidatedToken(null); setAccount(null); setRegistered([]); setSaved([]); setEvents([]); setNotifications([]); openModule('Overview') }
  const authLoading = Boolean(token && validatedToken !== token)
  const requestKey = `${token ?? ''}:${eventsReload}`
  const eventsLoading = Boolean(token && eventRequest.key !== requestKey)
  const eventsError = eventRequest.key === requestKey ? eventRequest.error : ''
  const resetToken = resetTokenFromHash()

  if (resetToken) return <AuthScreen initialError="" initialResetToken={resetToken} onAuthenticated={(nextToken) => { sessionStorage.setItem('campus-event-token', nextToken); setToken(nextToken) }} />
  if (authLoading) return <div className="auth-screen"><p>Checking your session…</p></div>
  if (!token || !account) return <AuthScreen initialError={authError} onAuthenticated={(nextToken) => { sessionStorage.setItem('campus-event-token', nextToken); setEvents([]); setAuthError(''); setToken(nextToken) }} />

  return <MotionConfig reducedMotion="user"><div className="app-shell sidebar-collapsed">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">✳</span><span>Campus events</span></div><div className="sidebar-label">Workspace</div><nav>{navItems.map(([icon, label]) => <button key={label} className={activeNav === label ? 'nav-item active' : 'nav-item'} onClick={() => openModule(label)}><span className="nav-icon">{icon}</span><span className="nav-label">{label}</span>{label === 'My registrations' && <span className="nav-count">{registered.length}</span>}</button>)}</nav>{canManageEvents && <><div className="sidebar-label lower-label">Manage</div><nav><button className={activeNav === 'Create an event' ? 'nav-item active' : 'nav-item'} onClick={() => openModule('Create an event')}><span className="nav-icon">＋</span><span className="nav-label">Create an event</span></button><button className={activeNav === 'Manage events' ? 'nav-item active' : 'nav-item'} onClick={() => openModule('Manage events')}><span className="nav-icon">▤</span><span className="nav-label">Manage events</span></button><button className={activeNav === 'Insights' ? 'nav-item active' : 'nav-item'} onClick={() => openModule('Insights')}><span className="nav-icon">↗</span><span className="nav-label">Insights</span></button>{isAdmin && <button className={activeNav === 'Approvals' ? 'nav-item active' : 'nav-item'} onClick={() => openModule('Approvals')}><span className="nav-icon">✓</span><span className="nav-label">Approvals</span></button>}</nav></>}<div className="sidebar-bottom"><div className="help-card"><span className="help-icon">?</span><div><strong>Need a hand?</strong><span>Visit the help center</span></div><span>→</span></div><button className={activeNav === 'Account info' ? 'profile active' : 'profile'} onClick={() => openModule('Account info')}><span className="avatar">{account.name.split(' ').map((part) => part[0]).join('')}</span><span className="profile-copy"><strong>{account.name}</strong><small>{account.role} · {account.department}</small></span><span>⌄</span></button></div></aside>
    <main className="main-content"><header className="topbar"><div className="breadcrumb"><span>Workspace</span><span>/</span><strong>{activeNav}</strong></div><div className="top-actions"><button className="icon-button notification-trigger" aria-label={`Notifications${unreadNotifications ? `, ${unreadNotifications} unread` : ''}`} onClick={() => openModule('Notifications')}>♧{unreadNotifications > 0 && <span className="unread-count">{unreadNotifications > 99 ? '99+' : unreadNotifications}</span>}</button><button className="user-avatar" aria-label="Open account info" onClick={() => openModule('Account info')}>{account.name.split(' ').map((part) => part[0]).join('')}</button></div></header><div className="content-wrap"><AnimatePresence mode="wait" initial={false}><motion.div className="module-transition" key={activeNav} initial={{ opacity: 0, y: 9 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.18, ease: 'easeOut' }}>
      {eventsError && <div className="api-alert" role="alert">Events couldn’t be loaded: {eventsError}<button onClick={() => setEventsReload((value) => value + 1)}>Retry</button></div>}
      {activityError && <div className="api-alert" role="alert">Your registrations and saved events couldn’t be loaded: {activityError}</div>}
      {eventsLoading && <p className="api-status" role="status">Loading events…</p>}
      {activeNav === 'Overview' && <Overview name={account.name} allowCreate={canManageEvents} events={events} registered={registered} confirmed={confirmedRegistrations} attended={attendedRegistrations} saved={saved} onRegister={toggleRegistration} onSave={toggleSaved} onShowPass={setAttendancePassEvent} onFeedback={setFeedbackEvent} onCertificate={downloadCertificate} now={now} onDiscover={() => openModule('Discover')} onCreate={() => openModule('Create an event')} />}
      {activeNav === 'Discover' && <EventBrowser title="Discover events" subtitle="Search the full campus calendar." events={filteredEvents} query={query} setQuery={setQuery} activeFilter={activeFilter} setActiveFilter={setActiveFilter} registered={registered} confirmed={confirmedRegistrations} attended={attendedRegistrations} saved={saved} onRegister={toggleRegistration} onSave={toggleSaved} onShowPass={setAttendancePassEvent} onFeedback={setFeedbackEvent} onCertificate={downloadCertificate} now={now} />}
      {activeNav === 'My registrations' && <EventBrowser title="My registrations" subtitle="Your confirmed and upcoming campus events." events={events.filter((event) => registered.includes(event.id))} query={query} setQuery={setQuery} activeFilter="All events" setActiveFilter={setActiveFilter} registered={registered} confirmed={confirmedRegistrations} attended={attendedRegistrations} saved={saved} onRegister={toggleRegistration} onSave={toggleSaved} onShowPass={setAttendancePassEvent} onFeedback={setFeedbackEvent} onCertificate={downloadCertificate} now={now} />}
      {activeNav === 'Saved events' && <EventBrowser title="Saved events" subtitle="Events you want to come back to." events={events.filter((event) => saved.includes(event.id))} query={query} setQuery={setQuery} activeFilter="All events" setActiveFilter={setActiveFilter} registered={registered} confirmed={confirmedRegistrations} attended={attendedRegistrations} saved={saved} onRegister={toggleRegistration} onSave={toggleSaved} onShowPass={setAttendancePassEvent} onFeedback={setFeedbackEvent} onCertificate={downloadCertificate} now={now} />}
      {activeNav === 'Create an event' && <CreateEvent token={token} onCreate={async (event) => { await apiRequest('/api/events', { method: 'POST', body: JSON.stringify(event) }, token); notify('Event submitted for admin approval'); openModule('Discover') }} />}
      {activeNav === 'Manage events' && <ManageEvents token={token} notify={notify} onViewFeedback={setFeedbackSummaryEvent} />}
      {activeNav === 'Insights' && <Insights events={events} registered={registered} saved={saved} />}
      {activeNav === 'Approvals' && <Approvals token={token} notify={notify} />}
      {activeNav === 'Users' && <AdminUsers token={token} currentEmail={account.email} notify={notify} />}
      {activeNav === 'Venues' && <AdminVenues token={token} notify={notify} />}
      {activeNav === 'Notifications' && <Notifications items={notifications} loading={notificationRequest.key !== `${token}:${notificationReload}`} error={notificationRequest.key === `${token}:${notificationReload}` ? notificationRequest.error : ''} onReload={() => setNotificationReload((value) => value + 1)} onRead={markNotificationRead} onReadAll={markAllNotificationsRead} />}
      {activeNav === 'Account info' && <AccountInfo account={account} onSave={async (nextAccount) => { const result = await apiRequest<AuthUser>('/api/auth/me/preferences', { method: 'PATCH', body: JSON.stringify({ name: nextAccount.name, email: nextAccount.email, department: nextAccount.department, event_reminders_enabled: nextAccount.reminders, announcements_enabled: nextAccount.announcements }) }, token); setAccount({ name: result.data.name, email: result.data.email, department: result.data.department ?? '', role: result.data.role, reminders: result.data.event_reminders_enabled, announcements: result.data.announcements_enabled }); notify('Account information updated') }} onLogout={signOut} />}
    </motion.div></AnimatePresence></div></main><AnimatePresence>{toast && <motion.div className="toast" role="status" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }} transition={{ duration: 0.18, ease: 'easeOut' }}>{toast}<button onClick={() => setToast('')}>×</button></motion.div>}</AnimatePresence>
  </div>{attendancePassEvent && <AttendancePassModal event={attendancePassEvent} token={token} onClose={() => setAttendancePassEvent(null)} />}{feedbackEvent && <FeedbackModal event={feedbackEvent} token={token} onClose={() => setFeedbackEvent(null)} onSubmitted={() => setEventsReload((value) => value + 1)} />}{feedbackSummaryEvent && <FeedbackSummaryModal event={feedbackSummaryEvent} token={token} onClose={() => setFeedbackSummaryEvent(null)} />}{registrationConflict && <RegistrationConflictModal data={registrationConflict} onClose={() => setRegistrationConflict(null)} onSelect={registerAlternative} />}</MotionConfig>
}

function Overview({ name, allowCreate, events, registered, confirmed, attended, saved, onRegister, onSave, onShowPass, onFeedback, onCertificate, now, onDiscover, onCreate }: { name: string; allowCreate: boolean; events: EventItem[]; registered: number[]; confirmed: number[]; attended: number[]; saved: number[]; onRegister: (event: EventItem) => void; onSave: (event: EventItem) => void; onShowPass: (event: EventItem) => void; onFeedback: (event: EventItem) => void; onCertificate: (event: EventItem) => void; now: number; onDiscover: () => void; onCreate: () => void }) {
  const featured = events[0]
  return <><section className="welcome-row"><div><p className="eyebrow">Campus events</p><h1>Welcome, {name.split(' ')[0]}</h1><p className="welcome-copy">Find events, register, and keep your campus schedule in one place.</p></div>{allowCreate && <button className="primary-button" onClick={onCreate}><span>＋</span> Create an event</button>}</section>{featured ? <section className="hero-banner"><div className="hero-copy"><span className="tag">Featured event</span><h2>{featured.title}</h2><p>{featured.date} · {featured.venue}</p><button className="text-button" onClick={onDiscover}>View all events <span>↗</span></button></div><div className="hero-stat"><strong>{events.length}</strong><span>published events</span></div></section> : <div className="empty-state">No approved events are available yet.</div>}<section className="stats-row"><div className="stat-card"><div className="stat-icon green">◷</div><div><span>My upcoming</span><strong>{String(registered.length).padStart(2, '0')} <small>events</small></strong></div></div><div className="stat-card"><div className="stat-icon yellow">♢</div><div><span>Saved events</span><strong>{String(saved.length).padStart(2, '0')} <small>to revisit</small></strong></div></div><div className="stat-card"><div className="stat-icon blue">✦</div><div><span>Campus events</span><strong>{events.length} <small>published</small></strong></div></div></section><section className="section-heading"><div><h2>Happening around campus</h2><p>Discover something worth showing up for.</p></div><button className="view-link" onClick={onDiscover}>View all events <span>↗</span></button></section>{events.length > 0 && <EventGrid events={events.slice(0, 3)} registered={registered} confirmed={confirmed} attended={attended} saved={saved} onRegister={onRegister} onSave={onSave} onShowPass={onShowPass} onFeedback={onFeedback} onCertificate={onCertificate} now={now} />}</>
}

function AuthScreen({ initialError, initialResetToken = '', onAuthenticated }: { initialError: string; initialResetToken?: string; onAuthenticated: (token: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset'>(initialResetToken ? 'reset' : 'login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [resetToken, setResetToken] = useState(initialResetToken)
  const [department, setDepartment] = useState('')
  const [error, setError] = useState(initialError)
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    setNotice('')
    try {
      if (mode === 'forgot') {
        await apiRequest('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) })
        setNotice('If an account exists for that email, a password reset link will be sent.')
      } else if (mode === 'reset') {
        if (password !== confirmPassword) throw new Error('Passwords do not match')
        await apiRequest('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: resetToken, password }) })
        setResetToken('')
        window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`)
        setMode('login')
        setPassword('')
        setConfirmPassword('')
        setNotice('Password updated. Sign in with your new password.')
      } else {
        const body = mode === 'login' ? { email, password } : { name, email, password, department }
        const result = await apiRequest<AuthUser>(`/api/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body: JSON.stringify(body) })
        if (!result.token) throw new Error('The server did not return an access token')
        onAuthenticated(result.token)
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to connect to the campus event service')
    } finally {
      setSubmitting(false)
    }
  }
  const changeMode = (nextMode: 'login' | 'register' | 'forgot') => {
    setMode(nextMode)
    setError('')
    setNotice('')
    if (resetToken) {
      setResetToken('')
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`)
    }
  }
  const heading = mode === 'login' ? 'Sign in to your account' : mode === 'register' ? 'Create your account' : mode === 'forgot' ? 'Reset your password' : 'Choose a new password'
  const intro = mode === 'login' ? 'Use your campus account to continue.' : mode === 'register' ? 'Register with your campus email.' : mode === 'forgot' ? 'Enter your campus email and we will send a reset link if an account matches.' : 'Choose a new password for your campus account.'
  return <main className="auth-screen"><section className="auth-panel"><div className="auth-brand"><span>✳</span> Campus events</div><p className="eyebrow">Campus event management</p><h1>{heading}</h1><p className="auth-intro">{intro}</p>{(mode === 'login' || mode === 'register') && <div className="auth-tabs"><button type="button" className={mode === 'login' ? 'selected' : ''} onClick={() => changeMode('login')}>Sign in</button><button type="button" className={mode === 'register' ? 'selected' : ''} onClick={() => changeMode('register')}>Register</button></div>}<form className="auth-form" onSubmit={submit}>{mode === 'register' && <><label>Full name<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={120} /></label><label>Department<input value={department} onChange={(event) => setDepartment(event.target.value)} maxLength={120} /></label></>}{mode !== 'reset' && <label>Campus email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} /></label>}{(mode === 'login' || mode === 'register' || mode === 'reset') && <label>{mode === 'reset' ? 'New password' : 'Password'}<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={mode === 'login' ? 1 : 12} maxLength={72} /></label>}{mode === 'reset' && <label>Confirm new password<input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength={12} maxLength={72} /></label>}{mode === 'register' && <small className="password-note">Use at least 12 characters.</small>}{mode === 'reset' && <small className="password-note">Use 12 to 72 UTF-8 bytes.</small>}{error && <p className="auth-error" role="alert">{error}</p>}{notice && <p className="auth-notice" role="status">{notice}</p>}<button className="primary-button auth-submit" type="submit" disabled={submitting}>{submitting ? 'Please wait…' : mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Update password'}</button></form>{mode === 'login' && <button className="auth-link" type="button" onClick={() => changeMode('forgot')}>Forgot your password?</button>}{(mode === 'forgot' || mode === 'reset') && <button className="auth-link" type="button" onClick={() => changeMode('login')}>Back to sign in</button>}{(mode === 'login' || mode === 'register') && <p className="auth-footnote">Faculty, organizers, and administrators must sign in with an assigned account.</p>}</section></main>
}

function EventBrowser({ title, subtitle, events, query, setQuery, activeFilter, setActiveFilter, registered, confirmed, attended, saved, onRegister, onSave, onShowPass, onFeedback, onCertificate, now }: { title: string; subtitle: string; events: EventItem[]; query: string; setQuery: (value: string) => void; activeFilter: string; setActiveFilter: (value: string) => void; registered: number[]; confirmed: number[]; attended: number[]; saved: number[]; onRegister: (event: EventItem) => void; onSave: (event: EventItem) => void; onShowPass: (event: EventItem) => void; onFeedback: (event: EventItem) => void; onCertificate: (event: EventItem) => void; now: number }) {
  return <><section className="welcome-row"><div><p className="eyebrow">Campus calendar</p><h1>{title}</h1><p className="welcome-copy">{subtitle}</p></div></section><div className="toolbar"><div className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search events, people, places..." /></div><div className="filter-group">{['All events', 'Talks', 'Workshops', 'Sports'].map((filter) => <button key={filter} className={activeFilter === filter ? 'filter active' : 'filter'} onClick={() => setActiveFilter(filter)}>{filter}</button>)}</div></div>{events.length ? <EventGrid events={events} registered={registered} confirmed={confirmed} attended={attended} saved={saved} onRegister={onRegister} onSave={onSave} onShowPass={onShowPass} onFeedback={onFeedback} onCertificate={onCertificate} now={now} /> : <div className="empty-state">No events here yet.</div>}</>
}

function Notifications({ items, loading, error, onReload, onRead, onReadAll }: { items: NotificationItem[]; loading: boolean; error: string; onReload: () => void; onRead: (id: number) => void; onReadAll: () => void }) {
  const unreadCount = items.filter((item) => !item.is_read).length
  const typeLabels: Record<string, string> = { event_update: 'Event update', event_cancelled: 'Cancellation', event_approval: 'Approval update', event_reminder: 'Event reminder', system: 'Notification' }
  return <><section className="welcome-row"><div><p className="eyebrow">Your activity</p><h1>Notifications</h1><p className="welcome-copy">Event updates, approvals, and reminders for your account.</p></div><div className="notification-actions"><button className="secondary-button" type="button" onClick={onReload} disabled={loading}>Refresh</button><button className="secondary-button" type="button" onClick={onReadAll} disabled={loading || unreadCount === 0}>Mark all read</button></div></section>{error && <div className="api-alert" role="alert">Notifications couldn’t be loaded: {error}<button type="button" onClick={onReload}>Retry</button></div>}{loading ? <p className="api-status" role="status">Loading notifications…</p> : items.length === 0 ? <div className="empty-state">You have no notifications.</div> : <section className="notification-list">{items.map((item) => <article key={item.id} className={item.is_read ? 'notification-item read' : 'notification-item unread'}><span className="notification-mark" aria-hidden="true">{item.notification_type === 'event_reminder' ? '◷' : item.notification_type === 'event_cancelled' ? '!' : '•'}</span><div className="notification-copy"><div className="notification-meta"><span>{typeLabels[item.notification_type] ?? 'Notification'}</span><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time></div><p>{item.message}</p></div>{!item.is_read && <button className="mark-read" type="button" onClick={() => onRead(item.id)}>Mark read</button>}</article>)}</section>}</>
}

function RegistrationConflictModal({ data, onClose, onSelect }: { data: RegistrationConflict; onClose: () => void; onSelect: (event: RegistrationConflict['alternatives'][number]) => void }) {
  return <div className="modal-backdrop" onClick={onClose}><section className="attendance-modal registration-conflict-modal" role="dialog" aria-modal="true" aria-labelledby="registration-conflict-title" onClick={(event) => event.stopPropagation()}>
    <button className="modal-close" type="button" aria-label="Close schedule conflict" onClick={onClose}>×</button>
    <p className="eyebrow">Registration conflict</p>
    <h2 id="registration-conflict-title">This event overlaps your schedule</h2>
    <p className="pass-event-title">You’re already confirmed for an event during this time:</p>
    <div className="conflict-list">{data.conflicts.map((event) => <article className="conflict-item" key={event.id}><strong>{event.title}</strong><span>{new Date(event.starts_at).toLocaleString()} – {new Date(event.ends_at).toLocaleTimeString()}</span></article>)}</div>
    <h3>Other events that fit your schedule</h3>
    {data.alternatives.length === 0 ? <p className="api-status">No open events in this category currently fit your schedule.</p> : <div className="conflict-list">{data.alternatives.map((event) => <article className="conflict-item conflict-alternative" key={event.id}><div><strong>{event.title}</strong><span>{event.category} · {new Date(event.starts_at).toLocaleString()} · {event.venue}</span></div><button className="secondary-button" type="button" onClick={() => onSelect(event)}>Register</button></article>)}</div>}
  </section></div>
}

function FeedbackModal({ event, token, onClose, onSubmitted }: { event: EventItem; token: string; onClose: () => void; onSubmitted: () => void }) {
  const [rating, setRating] = useState(5)
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async (formEvent: FormEvent) => {
    formEvent.preventDefault()
    setSaving(true)
    setError('')
    try {
      await apiRequest(`/api/events/${event.id}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ rating, comment }),
      }, token)
      onSubmitted()
      onClose()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Feedback could not be saved')
    } finally {
      setSaving(false)
    }
  }

  return <div className="modal-backdrop" onClick={onClose}><div className="attendance-modal feedback-modal" onClick={(eventClick) => eventClick.stopPropagation()}>
    <button className="modal-close" type="button" aria-label="Close feedback form" onClick={onClose}>×</button>
    <h2>Leave feedback</h2>
    <p className="pass-event-title">{event.title}</p>
    <form className="event-form" onSubmit={submit}>
      <label>
        Your rating
        <select value={rating} onChange={(inputEvent) => setRating(Number(inputEvent.target.value))}>
          {[5,4,3,2,1].map((value) => <option key={value} value={value}>{value} / 5</option>)}
        </select>
      </label>
      <label>
        Comment
        <textarea value={comment} onChange={(inputEvent) => setComment(inputEvent.target.value)} rows={6} minLength={3} maxLength={1500} placeholder="Share what went well or what could be improved." required />
      </label>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="primary-button" type="submit" disabled={saving}>{saving ? 'Submitting…' : 'Submit feedback'}</button>
    </form>
  </div></div>
}

function FeedbackSummaryModal({ event, token, onClose }: { event: ManagedEvent; token: string; onClose: () => void }) {
  const [summary, setSummary] = useState<FeedbackSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    apiRequest<FeedbackSummary>(`/api/managed-events/${event.id}/feedback`, {}, token)
      .then(({ data }) => {
        if (!cancelled) {
          setSummary(data)
          setError('')
        }
      })
      .catch((requestError: Error) => {
        if (!cancelled) setError(requestError.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [event.id, token])

  return <div className="modal-backdrop" onClick={onClose}><div className="attendance-modal attendance-checkin-modal" onClick={(eventClick) => eventClick.stopPropagation()}>
    <button className="modal-close" type="button" aria-label="Close feedback summary" onClick={onClose}>×</button>
    <h2>Feedback summary</h2>
    <p className="pass-event-title">{event.title}</p>
    {loading ? <p className="api-status" role="status">Loading feedback…</p> : error ? <div className="api-alert" role="alert">{error}</div> : summary && <>
      <div className="feedback-summary-header">
        <div>
          <span className="feedback-metric-label">Average rating</span>
          <strong>{summary.average_rating.toFixed(summary.average_rating % 1 === 0 ? 0 : 2)} / 5</strong>
        </div>
        <div>
          <span className="feedback-metric-label">Reviews</span>
          <strong>{summary.total_reviews}</strong>
        </div>
      </div>
      {summary.items.length === 0 ? <div className="empty-state">No feedback has been submitted for this event yet.</div> : <div className="feedback-list">{summary.items.map((item) => <article key={item.id} className="feedback-item"><div className="feedback-header"><span>{item.user_name}</span><strong>{item.rating}/5</strong></div><p>{item.comment}</p><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time></article>)}</div>}
    </>}
  </div></div>
}

function localDateTime(value: string) {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

function ManageEvents({ token, notify, onViewFeedback }: { token: string; notify: (message: string) => void; onViewFeedback: (event: ManagedEvent) => void }) {
  const [managedEvents, setManagedEvents] = useState<ManagedEvent[]>([])
  const [loadedKey, setLoadedKey] = useState('')
  const [loadError, setLoadError] = useState({ key: '', message: '' })
  const [reload, setReload] = useState(0)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [attendanceEvent, setAttendanceEvent] = useState<ManagedEvent | null>(null)
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

  return <><section className="welcome-row"><div><p className="eyebrow">Organizer tools</p><h1>Manage events</h1><p className="welcome-copy">Edit event details or cancel an event. Participants receive schedule and cancellation notices.</p></div><button className="secondary-button" type="button" disabled={loading} onClick={() => setReload((value) => value + 1)}>Refresh</button></section>{error && <div className="api-alert" role="alert">{error}<button type="button" onClick={() => setReload((value) => value + 1)}>Retry</button></div>}{loading ? <p className="api-status" role="status">Loading your events…</p> : managedEvents.length === 0 ? <div className="empty-state">You have no events to manage.</div> : <section className="managed-event-list">{managedEvents.map((event) => <article className="managed-event" key={event.id}><div className="managed-event-heading"><div><span className={`status-pill status-${event.status}`}>{event.status}</span><h2>{event.title}</h2></div><div className="managed-actions">{event.status === 'approved' && <><button className="secondary-button" type="button" onClick={() => setAttendanceEvent(event)}>Scan attendance</button><button className="secondary-button" type="button" onClick={() => onViewFeedback(event)}>Feedback</button></>}{event.status !== 'cancelled' && event.status !== 'rejected' && <><button className="secondary-button" type="button" disabled={processingId !== null} onClick={() => setEditingId(editingId === event.id ? null : event.id)}>{editingId === event.id ? 'Close editor' : 'Edit'}</button><button className="reject-button" type="button" disabled={processingId !== null} onClick={() => cancelEvent(event)}>{processingId === event.id ? 'Cancelling…' : 'Cancel event'}</button></>}</div></div><p className="managed-summary">{event.category} · {new Date(event.starts_at).toLocaleString()} · {event.venue}, {event.location} · {event.participant_count} participants</p>{editingId === event.id && <EventEditForm event={event} token={token} onSave={(payload) => saveEvent(event.id, payload)} onCancel={() => setEditingId(null)} />}</article>)}</section>}{attendanceEvent && <AttendanceCheckIn eventId={attendanceEvent.id} title={attendanceEvent.title} token={token} onClose={() => setAttendanceEvent(null)} notify={notify} />}</>
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

function AdminUsers({ token, currentEmail, notify }: { token: string; currentEmail: string; notify: (message: string) => void }) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [draftRoles, setDraftRoles] = useState<Record<string, string>>({})
  const [loadedKey, setLoadedKey] = useState('')
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [processingId, setProcessingId] = useState<string | null>(null)
  const requestKey = `${token}:${reload}`
  const loading = loadedKey !== requestKey

  useEffect(() => {
    let cancelled = false
    apiRequest<AdminUser[]>('/api/auth/admin/users', {}, token)
      .then(({ data }) => { if (!cancelled) { setUsers(data); setError(''); setLoadedKey(requestKey) } })
      .catch((requestError: Error) => { if (!cancelled) { setError(requestError.message); setLoadedKey(requestKey) } })
    return () => { cancelled = true }
  }, [token, requestKey])

  const saveRole = async (user: AdminUser) => {
    const role = draftRoles[String(user.id)]
    if (!role || role === user.role) return
    setProcessingId(String(user.id))
    setError('')
    try {
      const { data } = await apiRequest<AdminUser>(`/api/auth/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ role }) }, token)
      setUsers((current) => current.map((item) => String(item.id) === String(user.id) ? data : item))
      setDraftRoles((current) => { const next = { ...current }; delete next[String(user.id)]; return next })
      notify(`Updated ${user.name}'s role`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'User role could not be updated')
    } finally {
      setProcessingId(null)
    }
  }

  return <><section className="welcome-row"><div><p className="eyebrow">Administrator tools</p><h1>User management</h1><p className="welcome-copy">Assign account roles for campus staff and event organizers.</p></div><button className="secondary-button" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}>Refresh</button></section>{error && <div className="api-alert" role="alert">{error}<button type="button" onClick={() => setReload((value) => value + 1)}>Retry</button></div>}{loading ? <p className="api-status" role="status">Loading accounts…</p> : users.length === 0 ? <div className="empty-state">No accounts were found.</div> : <section className="admin-record-list">{users.map((user) => { const isCurrentUser = user.email.toLowerCase() === currentEmail.toLowerCase(); const role = draftRoles[String(user.id)] ?? user.role; return <article className="admin-record" key={user.id}><div className="admin-record-copy"><h2>{user.name}</h2><p>{user.email}</p><span>{user.department || 'No department'} · Joined {new Date(user.created_at).toLocaleDateString()}</span></div><div className="admin-record-actions"><label className="admin-role-field">Role<select value={role} disabled={isCurrentUser || processingId !== null} onChange={(event) => setDraftRoles((current) => ({ ...current, [String(user.id)]: event.target.value }))}><option value="student">Student</option><option value="faculty">Faculty</option><option value="organizer">Organizer</option><option value="admin">Administrator</option></select></label><button className="secondary-button" type="button" disabled={isCurrentUser || role === user.role || processingId !== null} onClick={() => saveRole(user)}>{processingId === String(user.id) ? 'Saving…' : 'Save role'}</button></div></article> })}</section>}</>
}

function AdminVenues({ token, notify }: { token: string; notify: (message: string) => void }) {
  const [venues, setVenues] = useState<AdminVenue[]>([])
  const [draft, setDraft] = useState({ name: '', location: '', capacity: 100, availability: true })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const requestKey = `${token}:${reload}`
  const loading = loadedKey !== requestKey

  useEffect(() => {
    let cancelled = false
    apiRequest<AdminVenue[]>('/api/admin/venues', {}, token)
      .then(({ data }) => { if (!cancelled) { setVenues(data); setError(''); setLoadedKey(requestKey) } })
      .catch((requestError: Error) => { if (!cancelled) { setError(requestError.message); setLoadedKey(requestKey) } })
    return () => { cancelled = true }
  }, [token, requestKey])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    const payload = { ...draft, name: draft.name.trim(), location: draft.location.trim(), capacity: Number(draft.capacity) }
    try {
      const path = editingId ? `/api/admin/venues/${editingId}` : '/api/admin/venues'
      const method = editingId ? 'PATCH' : 'POST'
      const { data } = await apiRequest<AdminVenue>(path, { method, body: JSON.stringify(payload) }, token)
      setVenues((current) => editingId ? current.map((venue) => String(venue.id) === editingId ? data : venue) : [...current, data].sort((left, right) => left.name.localeCompare(right.name)))
      setDraft({ name: '', location: '', capacity: 100, availability: true })
      setEditingId(null)
      notify(editingId ? 'Venue updated' : 'Venue added')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Venue could not be saved')
    } finally {
      setSaving(false)
    }
  }

  const toggleAvailability = async (venue: AdminVenue) => {
    setError('')
    try {
      const { data } = await apiRequest<AdminVenue>(`/api/admin/venues/${venue.id}`, { method: 'PATCH', body: JSON.stringify({ ...venue, availability: !venue.availability }) }, token)
      setVenues((current) => current.map((item) => String(item.id) === String(venue.id) ? data : item))
      notify(data.availability ? 'Venue is available for new events' : 'Venue marked unavailable')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Venue availability could not be changed')
    }
  }

  return <><section className="welcome-row"><div><p className="eyebrow">Administrator tools</p><h1>Venue management</h1><p className="welcome-copy">Maintain campus event spaces, capacities, and booking availability.</p></div><button className="secondary-button" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}>Refresh</button></section>{error && <div className="api-alert" role="alert">{error}<button type="button" onClick={() => setReload((value) => value + 1)}>Retry</button></div>}<form className="event-form admin-venue-form" onSubmit={submit}><h2>{editingId ? 'Edit venue' : 'Add venue'}</h2><label>Venue name<input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} required minLength={2} maxLength={120} /></label><label>Location<input value={draft.location} onChange={(event) => setDraft((current) => ({ ...current, location: event.target.value }))} required minLength={2} maxLength={240} /></label><label>Maximum capacity<input type="number" min="1" max="50000" value={draft.capacity} onChange={(event) => setDraft((current) => ({ ...current, capacity: Number(event.target.value) }))} required /></label>{editingId && <label className="admin-availability-field"><input type="checkbox" checked={draft.availability} onChange={(event) => setDraft((current) => ({ ...current, availability: event.target.checked }))} /> Available for new events</label>}<div className="managed-actions"><button className="primary-button" type="submit" disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save venue' : 'Add venue'}</button>{editingId && <button className="secondary-button" type="button" onClick={() => { setEditingId(null); setDraft({ name: '', location: '', capacity: 100, availability: true }) }}>Cancel</button>}</div></form>{loading ? <p className="api-status" role="status">Loading venues…</p> : venues.length === 0 ? <div className="empty-state">No venues have been added.</div> : <section className="admin-record-list">{venues.map((venue) => <article className="admin-record" key={venue.id}><div className="admin-record-copy"><h2>{venue.name}</h2><p>{venue.location} · Capacity {venue.capacity}</p><span className={venue.availability ? 'venue-status available' : 'venue-status unavailable'}>{venue.availability ? 'Available' : 'Unavailable'}</span></div><div className="admin-record-actions"><button className="secondary-button" type="button" onClick={() => { setEditingId(String(venue.id)); setDraft(venue) }}>Edit</button><button className="secondary-button" type="button" disabled={editingId === String(venue.id)} onClick={() => toggleAvailability(venue)}>{venue.availability ? 'Mark unavailable' : 'Make available'}</button></div></article>)}</section>}</>
}

function EventGrid({ events, registered, confirmed, attended, saved, onRegister, onSave, onShowPass, onFeedback, onCertificate, now }: { events: EventItem[]; registered: number[]; confirmed: number[]; attended: number[]; saved: number[]; onRegister: (event: EventItem) => void; onSave: (event: EventItem) => void; onShowPass: (event: EventItem) => void; onFeedback: (event: EventItem) => void; onCertificate: (event: EventItem) => void; now: number }) {
  return <motion.section className="event-grid" initial="hidden" animate="visible" variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.055 } } }}>
    {events.map((event) => <motion.article className="event-card" key={event.id} variants={{ hidden: { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0, transition: { duration: 0.24, ease: 'easeOut' } } }} whileHover={{ y: -4 }} whileTap={{ scale: 0.99 }}>
      <div className="event-image" style={{ backgroundImage: `url(${event.image})` }}><span className="category-pill">{event.category}</span><button className={saved.includes(event.id) ? 'save-button saved' : 'save-button'} aria-label={saved.includes(event.id) ? 'Remove saved event' : 'Save event'} onClick={() => onSave(event)}>{saved.includes(event.id) ? '♥' : '♡'}</button></div>
      <div className="event-info"><div className="event-date">{event.date}</div><h3>{event.title}</h3><div className="event-meta"><span>⌖ {event.venue}</span><span>◉ {event.host}</span></div>
        <div className="event-footer"><div className="attendee-row"><span className="mini-avatar avatar-a">JL</span><span className="mini-avatar avatar-b">SK</span><span className="mini-avatar avatar-c">+{event.attendees - 2}</span></div>
          <div className="registration-actions">{confirmed.includes(event.id) && <button className="show-pass" onClick={() => onShowPass(event)}>Show QR</button>}{confirmed.includes(event.id) && new Date(event.ends_at).getTime() < now && <button className="show-pass" onClick={() => onFeedback(event)}>Feedback</button>}{attended.includes(event.id) && new Date(event.ends_at).getTime() < now && <button className="show-pass" onClick={() => onCertificate(event)}>Certificate</button>}<button className={registered.includes(event.id) ? 'register registered' : 'register'} onClick={() => onRegister(event)}>{confirmed.includes(event.id) ? 'Registered ✓' : registered.includes(event.id) ? 'Waitlisted' : 'Register'}</button></div>
        </div>
      </div>
    </motion.article>)}
  </motion.section>
}

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

function AttendancePassModal({ event, token, onClose }: { event: EventItem; token: string; onClose: () => void }) {
  const [passResult, setPassResult] = useState<{ eventId: number; image: string; expiresAt: string; error: string } | null>(null)
  const loading = passResult?.eventId !== event.id
  useEffect(() => {
    let cancelled = false
    apiRequest<AttendancePass>(`/api/events/${event.id}/attendance-pass`, {}, token)
      .then(async ({ data }) => {
        const image = await QRCode.toDataURL(data.value, { width: 280, margin: 2, errorCorrectionLevel: 'M' })
        if (!cancelled) setPassResult({ eventId: event.id, image, expiresAt: data.expires_at, error: '' })
      })
      .catch((error: Error) => { if (!cancelled) setPassResult({ eventId: event.id, image: '', expiresAt: '', error: error.message }) })
    return () => { cancelled = true }
  }, [event.id, token])
  return <div className="modal-backdrop" onMouseDown={(pointerEvent) => { if (pointerEvent.target === pointerEvent.currentTarget) onClose() }}><section className="attendance-modal" role="dialog" aria-modal="true" aria-labelledby="attendance-pass-title"><button className="modal-close" aria-label="Close QR pass" onClick={onClose}>×</button><p className="eyebrow">Event check-in</p><h2 id="attendance-pass-title">Your attendance QR</h2><p className="pass-event-title">{event.title}</p>{loading ? <p className="api-status">Creating your secure pass…</p> : passResult.error ? <p className="auth-error" role="alert">{passResult.error}</p> : <><img className="attendance-qr" src={passResult.image} alt={`Attendance QR code for ${event.title}`} /><p className="pass-expiry">Pass expires {new Date(passResult.expiresAt).toLocaleString()}</p></>}</section></div>
}

function AttendanceCheckIn({ eventId, title, token, onClose, notify }: { eventId: number; title: string; token: string; onClose: () => void; notify: (message: string) => void }) {
  const [report, setReport] = useState<AttendanceReport | null>(null)
  const [reportError, setReportError] = useState('')
  const [scanError, setScanError] = useState('')
  const [scanning, setScanning] = useState(false)
  const [reload, setReload] = useState(0)
  const requestKey = `${eventId}:${reload}`
  const [reportKey, setReportKey] = useState('')
  const reportLoading = reportKey !== requestKey
  const scanLocked = useRef(false)
  useEffect(() => {
    let cancelled = false
    apiRequest<AttendanceReport>(`/api/managed-events/${eventId}/attendance`, {}, token)
      .then(({ data }) => { if (!cancelled) { setReport(data); setReportKey(requestKey); setReportError('') } })
      .catch((error: Error) => { if (!cancelled) { setReportKey(requestKey); setReportError(error.message) } })
    return () => { cancelled = true }
  }, [eventId, reload, requestKey, token])
  const submitPass = async (pass: string) => {
    if (scanLocked.current) return
    scanLocked.current = true
    setScanning(true)
    setScanError('')
    try {
      const result = await apiRequest<{ participant: { name: string }; marked_at: string }>(`/api/events/${eventId}/attendance/scan`, { method: 'POST', body: JSON.stringify({ pass }) }, token)
      notify(`Checked in ${result.data.participant.name}`)
      setReload((value) => value + 1)
    } catch (error) { setScanError(error instanceof Error ? error.message : 'Attendance could not be recorded') }
    finally { setScanning(false); scanLocked.current = false }
  }
  return <div className="modal-backdrop"><section className="attendance-modal attendance-checkin-modal" role="dialog" aria-modal="true" aria-labelledby="attendance-checkin-title"><button className="modal-close" aria-label="Close attendance scanner" onClick={onClose}>×</button><p className="eyebrow">Organizer check-in</p><h2 id="attendance-checkin-title">{title}</h2><div id={`attendance-camera-${eventId}`} className="attendance-camera"></div><p className="scanner-hint">Point the camera at a participant’s event QR pass.</p>{scanError && <p className="auth-error" role="alert">{scanError}</p>}{scanning && <p className="api-status" role="status">Recording attendance…</p>}<div className="attendance-report"><div className="attendance-report-heading"><h3>Attendance</h3><span>{report ? `${report.attended_count} / ${report.confirmed_count} · ${report.attendance_percentage}%` : 'Loading…'}</span></div>{reportError && <p className="auth-error" role="alert">{reportError}</p>}{reportLoading ? <p className="api-status">Loading attendance report…</p> : report && report.participants.length === 0 ? <p className="scanner-hint">No confirmed participants.</p> : report && <ul>{report.participants.map((participant) => <li key={participant.id}><span>{participant.name}</span><span>{participant.attended && participant.marked_at ? `Present · ${new Date(participant.marked_at).toLocaleTimeString()}` : 'Not checked in'}</span></li>)}</ul>}</div></section><AttendanceCameraScanner elementId={`attendance-camera-${eventId}`} onDecoded={submitPass} onError={setScanError} /></div>
}

function AttendanceCameraScanner({ elementId, onDecoded, onError }: { elementId: string; onDecoded: (value: string) => Promise<void>; onError: (message: string) => void }) {
  const onDecodedRef = useRef(onDecoded)
  const onErrorRef = useRef(onError)
  const scanLock = useRef(false)
  useEffect(() => { onDecodedRef.current = onDecoded; onErrorRef.current = onError }, [onDecoded, onError])
  useEffect(() => {
    let cancelled = false
    let scanner: import('html5-qrcode').Html5Qrcode | null = null
    void import('html5-qrcode').then(({ Html5Qrcode }) => {
      if (cancelled) return
      scanner = new Html5Qrcode(elementId, { verbose: false })
      return scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 230, height: 230 } }, (value) => {
        if (scanLock.current) return
        scanLock.current = true
        void onDecodedRef.current(value).finally(() => { scanLock.current = false })
      }, () => {}).then(() => {
        if (cancelled && scanner?.isScanning) void scanner.stop().then(() => scanner?.clear()).catch(() => undefined)
      })
    }).catch((error: Error) => { if (!cancelled) onErrorRef.current(error.message || 'Camera access is unavailable') })
    return () => {
      cancelled = true
      if (scanner?.isScanning) void scanner.stop().then(() => scanner?.clear()).catch(() => undefined)
    }
  }, [elementId])
  return null
}

export default App
