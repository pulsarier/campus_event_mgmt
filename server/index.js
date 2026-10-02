import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import pg from 'pg'
import jwt from 'jsonwebtoken'
import PDFDocument from 'pdfkit'
import { createAccessControl, createAuthRouter } from './auth.js'
import { sendRegisteredNotificationEmails, sendUserNotificationEmail } from './mailer.js'
import { startReminderScheduler } from './reminders.js'

const { Pool } = pg
const port = Number(process.env.API_PORT ?? 3001)
const allowedOrigins = (process.env.CLIENT_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174').split(',')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const app = express()
const { authenticate, authorize } = createAccessControl(pool, process.env.JWT_SECRET)
const attendanceIssuer = 'campus-events'

function escapeCalendarText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

function foldCalendarLine(line) {
  let folded = ''
  let byteLength = 0
  for (const character of line) {
    const characterBytes = Buffer.byteLength(character)
    if (byteLength + characterBytes > 75) {
      folded += '\r\n '
      byteLength = 1
    }
    folded += character
    byteLength += characterBytes
  }
  return folded
}

function calendarTimestamp(value) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)) }))
app.use(express.json({ limit: '32kb' }))
app.use('/api/auth', createAuthRouter(pool, process.env.JWT_SECRET))

app.get('/api/notifications/me', authenticate, async (request, response) => {
  const [notifications, unreadCount] = await Promise.all([
    pool.query(
      `SELECT notification_id AS id, event_id, message, notification_type, is_read, created_at
         FROM notifications
        WHERE user_id = $1
        ORDER BY created_at DESC, notification_id DESC
        LIMIT 100`,
      [request.user.user_id],
    ),
    pool.query('SELECT COUNT(*)::INTEGER AS count FROM notifications WHERE user_id = $1 AND is_read = false', [request.user.user_id]),
  ])
  response.json({ data: { items: notifications.rows, unread_count: unreadCount.rows[0].count } })
})

app.patch('/api/notifications/read-all', authenticate, async (request, response) => {
  const result = await pool.query(
    'UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false',
    [request.user.user_id],
  )
  response.json({ data: { updated: result.rowCount } })
})

app.patch('/api/notifications/:notificationId/read', authenticate, async (request, response) => {
  const notificationId = Number(request.params.notificationId)
  if (!Number.isSafeInteger(notificationId) || notificationId < 1) return response.status(400).json({ error: 'Invalid notification ID' })
  const result = await pool.query(
    `UPDATE notifications SET is_read = true
      WHERE notification_id = $1 AND user_id = $2
      RETURNING notification_id AS id, is_read`,
    [notificationId, request.user.user_id],
  )
  if (result.rowCount !== 1) return response.status(404).json({ error: 'Notification not found' })
  response.json({ data: result.rows[0] })
})

app.get('/api/health', async (_request, response) => {
  await pool.query('SELECT 1')
  response.json({ status: 'ok', database: 'connected' })
})

app.get('/api/venues', async (_request, response) => {
  const result = await pool.query(
    `SELECT venue_id AS id, venue_name AS name, location, capacity
       FROM venues
      WHERE availability = true
      ORDER BY venue_name`,
  )
  response.json({ data: result.rows })
})

app.get('/api/admin/venues', authenticate, authorize('admin'), async (_request, response) => {
  const result = await pool.query(
    `SELECT venue_id AS id, venue_name AS name, location, capacity, availability
       FROM venues ORDER BY venue_name`,
  )
  response.json({ data: result.rows })
})

app.post('/api/admin/venues', authenticate, authorize('admin'), async (request, response) => {
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
  const location = typeof request.body?.location === 'string' ? request.body.location.trim() : ''
  const capacity = Number(request.body?.capacity)
  if (name.length < 2 || name.length > 120) return response.status(400).json({ error: 'Venue name must be between 2 and 120 characters' })
  if (location.length < 2 || location.length > 240) return response.status(400).json({ error: 'Location must be between 2 and 240 characters' })
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 50000) return response.status(400).json({ error: 'Capacity must be between 1 and 50000' })
  const result = await pool.query(
    `INSERT INTO venues (venue_name, location, capacity, availability)
     VALUES ($1, $2, $3, true)
     RETURNING venue_id AS id, venue_name AS name, location, capacity, availability`,
    [name, location, capacity],
  )
  return response.status(201).json({ data: result.rows[0] })
})

app.patch('/api/admin/venues/:venueId', authenticate, authorize('admin'), async (request, response) => {
  const venueId = Number(request.params.venueId)
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
  const location = typeof request.body?.location === 'string' ? request.body.location.trim() : ''
  const capacity = Number(request.body?.capacity)
  const availability = request.body?.availability
  if (!Number.isSafeInteger(venueId) || venueId < 1) return response.status(400).json({ error: 'Invalid venue ID' })
  if (name.length < 2 || name.length > 120) return response.status(400).json({ error: 'Venue name must be between 2 and 120 characters' })
  if (location.length < 2 || location.length > 240) return response.status(400).json({ error: 'Location must be between 2 and 240 characters' })
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 50000) return response.status(400).json({ error: 'Capacity must be between 1 and 50000' })
  if (typeof availability !== 'boolean') return response.status(400).json({ error: 'Availability must be true or false' })

  const activeEvents = await pool.query(
    `SELECT COUNT(*)::INTEGER AS count, MAX(capacity)::INTEGER AS max_capacity
       FROM events
      WHERE venue_id = $1 AND status IN ('pending', 'approved') AND ends_at > now()`,
    [venueId],
  )
  if (activeEvents.rowCount !== 1) return response.status(404).json({ error: 'Venue not found' })
  if (!availability && activeEvents.rows[0].count > 0) {
    return response.status(409).json({ error: 'This venue has active events; cancel or reschedule them before making it unavailable' })
  }
  if (capacity < Number(activeEvents.rows[0].max_capacity ?? 0)) {
    return response.status(409).json({ error: 'Capacity cannot be lower than an active event capacity' })
  }

  const result = await pool.query(
    `UPDATE venues
        SET venue_name = $2, location = $3, capacity = $4, availability = $5
      WHERE venue_id = $1
      RETURNING venue_id AS id, venue_name AS name, location, capacity, availability`,
    [venueId, name, location, capacity, availability],
  )
  if (result.rowCount !== 1) return response.status(404).json({ error: 'Venue not found' })
  return response.json({ data: result.rows[0] })
})

app.get('/api/events', async (request, response) => {
  const search = typeof request.query.search === 'string' ? request.query.search.trim() : ''
  const values = search ? [`%${search}%`] : []
  const result = await pool.query(
    `SELECT e.event_id AS id, e.title, e.description, e.category,
            e.starts_at, e.ends_at, e.registration_deadline, e.capacity,
            e.status, v.venue_name AS venue, v.location,
            u.name AS organizer, COUNT(r.registration_id) FILTER (WHERE r.status = 'confirmed')::INTEGER AS registrations
       FROM events e
       JOIN venues v ON v.venue_id = e.venue_id
       JOIN users u ON u.user_id = e.organizer_id
       LEFT JOIN registrations r ON r.event_id = e.event_id
      WHERE e.status = 'approved'
        AND ($1 = '' OR e.title ILIKE $2 OR e.category ILIKE $2 OR v.venue_name ILIKE $2 OR u.name ILIKE $2)
      GROUP BY e.event_id, v.venue_name, v.location, u.name
      ORDER BY e.starts_at ASC`,
    search ? [search, values[0]] : ['', ''],
  )
  response.json({ data: result.rows })
})

app.get('/api/events/:eventId/calendar.ics', async (request, response) => {
  const eventId = Number(request.params.eventId)
  if (!Number.isSafeInteger(eventId) || eventId < 1) return response.status(400).json({ error: 'Invalid event ID' })
  const result = await pool.query(
    `SELECT e.title, e.description, e.starts_at, e.ends_at,
            v.venue_name AS venue, v.location, u.name AS organizer
       FROM events e
       JOIN venues v ON v.venue_id = e.venue_id
       JOIN users u ON u.user_id = e.organizer_id
      WHERE e.event_id = $1 AND e.status = 'approved'`,
    [eventId],
  )
  if (result.rowCount !== 1) return response.status(404).json({ error: 'Event not found' })

  const event = result.rows[0]
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Campus Events//Calendar Export//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:event-${eventId}@campus-events`,
    `DTSTAMP:${calendarTimestamp(new Date())}`,
    `DTSTART:${calendarTimestamp(event.starts_at)}`,
    `DTEND:${calendarTimestamp(event.ends_at)}`,
    `SUMMARY:${escapeCalendarText(event.title)}`,
    `DESCRIPTION:${escapeCalendarText(event.description || `Hosted by ${event.organizer}`)}`,
    `LOCATION:${escapeCalendarText(`${event.venue}, ${event.location}`)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  response.setHeader('Content-Type', 'text/calendar; charset=utf-8')
  response.setHeader('Content-Disposition', `attachment; filename="campus-event-${eventId}.ics"`)
  response.setHeader('Cache-Control', 'no-store')
  return response.send(`${lines.map(foldCalendarLine).join('\r\n')}\r\n`)
})

app.get('/api/recommendations/me', authenticate, async (request, response) => {
  const result = await pool.query(
    `WITH preference_signals AS (
       SELECT e.category, 1::NUMERIC AS weight
         FROM registrations r
         JOIN events e ON e.event_id = r.event_id
        WHERE r.user_id = $1 AND r.status = 'confirmed'
       UNION ALL
       SELECT e.category, 2::NUMERIC AS weight
         FROM saved_events s
         JOIN events e ON e.event_id = s.event_id
        WHERE s.user_id = $1
       UNION ALL
       SELECT e.category, f.rating::NUMERIC AS weight
         FROM feedback f
         JOIN events e ON e.event_id = f.event_id
        WHERE f.user_id = $1 AND f.rating >= 4
     ), category_scores AS (
       SELECT category, SUM(weight) AS score
         FROM preference_signals
        GROUP BY category
     ), event_popularity AS (
       SELECT e.event_id,
              COUNT(r.registration_id) FILTER (WHERE r.status = 'confirmed')::INTEGER AS confirmed_count
         FROM events e
         LEFT JOIN registrations r ON r.event_id = e.event_id
        GROUP BY e.event_id
     ), event_ratings AS (
       SELECT event_id, AVG(rating)::NUMERIC AS average_rating
         FROM feedback
        GROUP BY event_id
     )
     SELECT e.event_id AS id, e.title, e.category, e.starts_at, e.ends_at,
            v.venue_name AS venue, u.name AS organizer,
            popularity.confirmed_count AS registrations,
            CASE WHEN category_scores.category IS NOT NULL
                 THEN 'Based on your activity'
                 WHEN popularity.confirmed_count > 0 THEN 'Popular with attendees'
                 ELSE 'Upcoming on campus'
            END AS recommendation_reason
       FROM events e
       JOIN venues v ON v.venue_id = e.venue_id
       JOIN users u ON u.user_id = e.organizer_id
       JOIN event_popularity popularity ON popularity.event_id = e.event_id
       LEFT JOIN category_scores ON category_scores.category = e.category
       LEFT JOIN event_ratings ratings ON ratings.event_id = e.event_id
      WHERE e.status = 'approved' AND e.starts_at > now()
        AND e.registration_deadline >= now()
        AND popularity.confirmed_count < e.capacity
        AND NOT EXISTS (
          SELECT 1 FROM registrations r
           WHERE r.event_id = e.event_id AND r.user_id = $1
             AND r.status <> 'cancelled'
        )
        AND NOT EXISTS (
          SELECT 1 FROM saved_events s
           WHERE s.event_id = e.event_id AND s.user_id = $1
        )
      ORDER BY COALESCE(category_scores.score, 0) DESC,
               COALESCE(ratings.average_rating, 0) DESC,
               popularity.confirmed_count DESC,
               e.starts_at
      LIMIT 8`,
    [request.user.user_id],
  )
  return response.json({ data: result.rows })
})

app.post('/api/events', authenticate, authorize('faculty', 'organizer', 'admin'), async (request, response) => {
  const { title, description = '', category, starts_at: startsAt, ends_at: endsAt, registration_deadline: deadline, venue_id: venueId, capacity } = request.body ?? {}
  const cleanTitle = typeof title === 'string' ? title.trim() : ''
  const cleanDescription = typeof description === 'string' ? description.trim() : null
  const allowedCategories = new Set(['Talks', 'Workshops', 'Sports', 'Exhibitions'])
  const startDate = new Date(startsAt)
  const endDate = new Date(endsAt)
  const deadlineDate = new Date(deadline)
  const numericVenueId = Number(venueId)
  const numericCapacity = Number(capacity)

  if (cleanTitle.length < 3 || cleanTitle.length > 180) return response.status(400).json({ error: 'Title must be between 3 and 180 characters' })
  if (cleanDescription === null || cleanDescription.length > 10000) return response.status(400).json({ error: 'Description must be 10000 characters or fewer' })
  if (!allowedCategories.has(category)) return response.status(400).json({ error: 'Invalid event category' })
  if (![startDate, endDate, deadlineDate].every((date) => Number.isFinite(date.getTime())) || endDate <= startDate || deadlineDate > startDate) {
    return response.status(400).json({ error: 'Provide valid event times and a registration deadline no later than the start time' })
  }
  if (!Number.isSafeInteger(numericVenueId) || numericVenueId < 1 || !Number.isSafeInteger(numericCapacity) || numericCapacity < 1) {
    return response.status(400).json({ error: 'Select a valid venue and positive event capacity' })
  }

  const result = await pool.query(
    `INSERT INTO events (title, description, category, starts_at, ends_at, registration_deadline, venue_id, organizer_id, capacity, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
     RETURNING event_id AS id, title, description, category, starts_at, ends_at,
               registration_deadline, venue_id AS venue_id, capacity, status`,
    [cleanTitle, cleanDescription, category, startDate.toISOString(), endDate.toISOString(), deadlineDate.toISOString(), numericVenueId, request.user.user_id, numericCapacity],
  )
  response.status(201).json({ data: result.rows[0] })
})

app.get('/api/managed-events', authenticate, authorize('faculty', 'organizer', 'admin'), async (request, response) => {
  const isAdmin = request.user.role === 'admin'
  const result = await pool.query(
    `SELECT e.event_id AS id, e.title, e.description, e.category,
            e.starts_at, e.ends_at, e.registration_deadline, e.capacity,
            e.status, e.venue_id, v.venue_name AS venue, v.location,
            COUNT(r.registration_id) FILTER (WHERE r.status IN ('confirmed', 'waitlisted'))::INTEGER AS participant_count
       FROM events e
       JOIN venues v ON v.venue_id = e.venue_id
       LEFT JOIN registrations r ON r.event_id = e.event_id
      WHERE ($1::BOOLEAN OR e.organizer_id = $2)
      GROUP BY e.event_id, v.venue_name, v.location
      ORDER BY e.starts_at DESC`,
    [isAdmin, request.user.user_id],
  )
  response.json({ data: result.rows })
})

app.get('/api/analytics/me', authenticate, authorize('faculty', 'organizer', 'admin'), async (request, response) => {
  const result = await pool.query(
    `WITH event_metrics AS (
       SELECT e.event_id,
              COUNT(r.registration_id) FILTER (WHERE r.status = 'confirmed')::INTEGER AS confirmed_count,
              COUNT(r.registration_id) FILTER (WHERE r.status = 'waitlisted')::INTEGER AS waitlisted_count,
              COUNT(a.attendance_id) FILTER (WHERE a.status = 'present')::INTEGER AS attended_count
         FROM events e
         LEFT JOIN registrations r ON r.event_id = e.event_id
         LEFT JOIN attendance a ON a.event_id = r.event_id AND a.user_id = r.user_id
        GROUP BY e.event_id
     ), feedback_metrics AS (
       SELECT event_id, ROUND(AVG(rating)::NUMERIC, 2) AS average_rating,
              COUNT(*)::INTEGER AS feedback_count
         FROM feedback
        GROUP BY event_id
     )
     SELECT e.event_id AS id, e.title, e.category, e.status, e.starts_at,
            em.confirmed_count, em.waitlisted_count, em.attended_count,
            COALESCE(ROUND(100.0 * em.attended_count / NULLIF(em.confirmed_count, 0), 1), 0) AS attendance_percentage,
            COALESCE(fm.average_rating, 0) AS average_rating,
            COALESCE(fm.feedback_count, 0) AS feedback_count
       FROM events e
       JOIN event_metrics em ON em.event_id = e.event_id
       LEFT JOIN feedback_metrics fm ON fm.event_id = e.event_id
      WHERE ($1::BOOLEAN OR e.organizer_id = $2)
      ORDER BY e.starts_at DESC, e.event_id DESC`,
    [request.user.role === 'admin', request.user.user_id],
  )
  return response.json({ data: result.rows })
})

app.patch('/api/managed-events/:eventId', authenticate, authorize('faculty', 'organizer', 'admin'), async (request, response) => {
  const eventId = Number(request.params.eventId)
  const { title, description, category, starts_at: startsAt, ends_at: endsAt, registration_deadline: deadline, venue_id: venueId, capacity } = request.body ?? {}
  const cleanTitle = typeof title === 'string' ? title.trim() : ''
  const cleanDescription = typeof description === 'string' ? description.trim() : null
  const allowedCategories = new Set(['Talks', 'Workshops', 'Sports', 'Exhibitions'])
  const startDate = new Date(startsAt)
  const endDate = new Date(endsAt)
  const deadlineDate = new Date(deadline)
  const numericVenueId = Number(venueId)
  const numericCapacity = Number(capacity)
  if (!Number.isSafeInteger(eventId) || eventId < 1) return response.status(400).json({ error: 'Invalid event ID' })
  if (cleanTitle.length < 3 || cleanTitle.length > 180) return response.status(400).json({ error: 'Title must be between 3 and 180 characters' })
  if (cleanDescription === null || cleanDescription.length > 10000) return response.status(400).json({ error: 'Description must be 10000 characters or fewer' })
  if (!allowedCategories.has(category)) return response.status(400).json({ error: 'Invalid event category' })
  if (![startDate, endDate, deadlineDate].every((date) => Number.isFinite(date.getTime())) || endDate <= startDate || deadlineDate > startDate) return response.status(400).json({ error: 'Provide valid event times and a registration deadline no later than the start time' })
  if (!Number.isSafeInteger(numericVenueId) || numericVenueId < 1 || !Number.isSafeInteger(numericCapacity) || numericCapacity < 1) return response.status(400).json({ error: 'Select a valid venue and positive event capacity' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const existing = await client.query(
      `SELECT event_id, organizer_id, status, starts_at, ends_at, venue_id
         FROM events WHERE event_id = $1 FOR UPDATE`,
      [eventId],
    )
    if (existing.rowCount !== 1 || (request.user.role !== 'admin' && String(existing.rows[0].organizer_id) !== String(request.user.user_id))) {
      await client.query('ROLLBACK')
      return response.status(404).json({ error: 'Event not found' })
    }
    const current = existing.rows[0]
    if (!['pending', 'approved'].includes(current.status)) {
      await client.query('ROLLBACK')
      return response.status(409).json({ error: 'This event can no longer be edited' })
    }
    const confirmedCount = await client.query(
      `SELECT COUNT(*)::INTEGER AS count FROM registrations
        WHERE event_id = $1 AND status = 'confirmed'`,
      [eventId],
    )
    if (numericCapacity < confirmedCount.rows[0].count) {
      await client.query('ROLLBACK')
      return response.status(409).json({ error: 'Capacity cannot be lower than the number of confirmed participants' })
    }
    const scheduleChanged = current.status === 'approved' && (
      new Date(current.starts_at).getTime() !== startDate.getTime() ||
      new Date(current.ends_at).getTime() !== endDate.getTime() ||
      Number(current.venue_id) !== numericVenueId
    )
    const updated = await client.query(
      `UPDATE events
          SET title = $2, description = $3, category = $4,
              starts_at = $5, ends_at = $6, registration_deadline = $7,
              venue_id = $8, capacity = $9
        WHERE event_id = $1
        RETURNING event_id AS id, title, description, category, starts_at,
                  ends_at, registration_deadline, venue_id, capacity, status`,
      [eventId, cleanTitle, cleanDescription, category, startDate.toISOString(), endDate.toISOString(), deadlineDate.toISOString(), numericVenueId, numericCapacity],
    )
    if (scheduleChanged) {
      await client.query(
        `DELETE FROM notifications
          WHERE event_id = $1 AND notification_type = 'event_reminder'`,
        [eventId],
      )
      const notification = `The time or venue for "${cleanTitle}" has changed. Please check the updated event details.`
      await client.query(
        `INSERT INTO notifications (user_id, event_id, message, notification_type)
         SELECT user_id, $1, $2, 'event_update' FROM registrations
          JOIN users USING (user_id)
          WHERE event_id = $1 AND status IN ('confirmed', 'waitlisted')
            AND announcements_enabled = true`,
        [eventId, notification],
      )
    }
    await client.query('COMMIT')
    if (scheduleChanged) {
      void sendRegisteredNotificationEmails(
        pool,
        eventId,
        ['confirmed', 'waitlisted'],
        'Campus Events: event schedule updated',
        `The schedule for "${cleanTitle}" has changed. The event now starts at ${startDate.toLocaleString()} and ends at ${endDate.toLocaleString()}. Sign in to Campus Events for the latest details.`,
      )
    }
    return response.json({ data: updated.rows[0] })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

app.patch('/api/managed-events/:eventId/cancel', authenticate, authorize('faculty', 'organizer', 'admin'), async (request, response) => {
  const eventId = Number(request.params.eventId)
  if (!Number.isSafeInteger(eventId) || eventId < 1) return response.status(400).json({ error: 'Invalid event ID' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const event = await client.query(
      `UPDATE events
          SET status = 'cancelled'
        WHERE event_id = $1 AND status IN ('pending', 'approved')
          AND ($2::BOOLEAN OR organizer_id = $3)
        RETURNING event_id, title, status`,
      [eventId, request.user.role === 'admin', request.user.user_id],
    )
    if (event.rowCount !== 1) {
      await client.query('ROLLBACK')
      return response.status(404).json({ error: 'Event not found or already closed' })
    }
    const cancelledEvent = event.rows[0]
    await client.query(
      `DELETE FROM notifications
        WHERE event_id = $1 AND notification_type = 'event_reminder'`,
      [cancelledEvent.event_id],
    )
    await client.query(
      `INSERT INTO notifications (user_id, event_id, message, notification_type)
       SELECT user_id, $1, $2, 'event_cancelled' FROM registrations
        JOIN users USING (user_id)
        WHERE event_id = $1 AND status IN ('confirmed', 'waitlisted')
          AND announcements_enabled = true`,
      [cancelledEvent.event_id, `The event "${cancelledEvent.title}" has been cancelled.`],
    )
    await client.query('COMMIT')
    void sendRegisteredNotificationEmails(
      pool,
      cancelledEvent.event_id,
      ['confirmed', 'waitlisted'],
      'Campus Events: event cancelled',
      `The event "${cancelledEvent.title}" has been cancelled. Sign in to Campus Events for more information.`,
    )
    return response.json({ data: { id: cancelledEvent.event_id, status: cancelledEvent.status } })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

app.get('/api/admin/events/pending', authenticate, authorize('admin'), async (_request, response) => {
  const result = await pool.query(
    `SELECT e.event_id AS id, e.title, e.description, e.category,
            e.starts_at, e.ends_at, e.registration_deadline, e.capacity,
            v.venue_name AS venue, v.location, u.name AS organizer,
            u.email AS organizer_email
       FROM events e
       JOIN venues v ON v.venue_id = e.venue_id
       JOIN users u ON u.user_id = e.organizer_id
      WHERE e.status = 'pending'
      ORDER BY e.created_at, e.event_id`,
  )
  response.json({ data: result.rows })
})

app.patch('/api/admin/events/:eventId/review', authenticate, authorize('admin'), async (request, response) => {
  const eventId = Number(request.params.eventId)
  const decision = request.body?.decision
  if (!Number.isSafeInteger(eventId) || eventId < 1) return response.status(400).json({ error: 'Invalid event ID' })
  if (!['approved', 'rejected'].includes(decision)) return response.status(400).json({ error: 'Decision must be approved or rejected' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const event = await client.query(
      `UPDATE events
          SET status = $2
        WHERE event_id = $1 AND status = 'pending'
        RETURNING event_id, organizer_id, title, status`,
      [eventId, decision],
    )
    if (event.rowCount !== 1) {
      await client.query('ROLLBACK')
      return response.status(409).json({ error: 'Event is no longer pending review or does not exist' })
    }

    const reviewed = event.rows[0]
    const message = decision === 'approved'
      ? `Your event "${reviewed.title}" has been approved and published.`
      : `Your event "${reviewed.title}" was not approved.`
    await client.query(
      `INSERT INTO notifications (user_id, event_id, message, notification_type)
       SELECT user_id, $2, $3, $4 FROM users
        WHERE user_id = $1 AND announcements_enabled = true`,
      [reviewed.organizer_id, reviewed.event_id, message, 'event_approval'],
    )
    await client.query('COMMIT')
    void sendUserNotificationEmail(pool, reviewed.organizer_id, 'Campus Events: event review update', message)
    return response.json({ data: { id: reviewed.event_id, status: reviewed.status } })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

app.get('/api/events/:eventId', async (request, response) => {
  const eventId = Number(request.params.eventId)
  if (!Number.isSafeInteger(eventId) || eventId < 1) {
    return response.status(400).json({ error: 'Invalid event ID' })
  }
  const result = await pool.query(
    `SELECT e.event_id AS id, e.title, e.description, e.category,
            e.starts_at, e.ends_at, e.registration_deadline, e.capacity,
            e.status, v.venue_name AS venue, v.location, u.name AS organizer,
            COUNT(r.registration_id) FILTER (WHERE r.status = 'confirmed')::INTEGER AS registrations
       FROM events e
       JOIN venues v ON v.venue_id = e.venue_id
       JOIN users u ON u.user_id = e.organizer_id
       LEFT JOIN registrations r ON r.event_id = e.event_id
      WHERE e.event_id = $1 AND e.status = 'approved'
      GROUP BY e.event_id, v.venue_name, v.location, u.name`,
    [eventId],
  )
  if (result.rowCount === 0) return response.status(404).json({ error: 'Event not found' })
  response.json({ data: result.rows[0] })
})

app.get('/api/events/:eventId/feedback', authenticate, async (request, response) => {
  const eventId = Number(request.params.eventId)
  if (!Number.isSafeInteger(eventId) || eventId < 1) return response.status(400).json({ error: 'Invalid event ID' })

  const eventResult = await pool.query(
    `SELECT e.event_id AS id, e.title, e.organizer_id,
            EXISTS (
              SELECT 1
              FROM registrations r
              WHERE r.event_id = e.event_id
                AND r.user_id = $2
                AND r.status = 'confirmed'
            ) AS is_attendee
       FROM events e
      WHERE e.event_id = $1`,
    [eventId, request.user.user_id],
  )
  if (eventResult.rowCount !== 1) return response.status(404).json({ error: 'Event not found' })

  const event = eventResult.rows[0]
  const authorized = request.user.role === 'admin' || String(event.organizer_id) === String(request.user.user_id) || event.is_attendee
  if (!authorized) return response.status(403).json({ error: 'Feedback is available only to the event organizer, admin staff, or confirmed attendees' })

  const summaryResult = await pool.query(
    `SELECT COALESCE(ROUND(AVG(rating)::NUMERIC, 2), 0) AS average_rating,
            COUNT(*)::INTEGER AS total_reviews
       FROM feedback
      WHERE event_id = $1`,
    [eventId],
  )
  const itemsResult = await pool.query(
    `SELECT f.feedback_id AS id, f.user_id, u.name AS user_name, f.rating, f.comment, f.created_at
       FROM feedback f
       JOIN users u ON u.user_id = f.user_id
      WHERE f.event_id = $1
      ORDER BY f.created_at DESC, f.feedback_id DESC`,
    [eventId],
  )
  response.json({
    data: {
      event_id: eventId,
      event_title: event.title,
      average_rating: Number(summaryResult.rows[0].average_rating ?? 0),
      total_reviews: Number(summaryResult.rows[0].total_reviews ?? 0),
      items: itemsResult.rows,
    },
  })
})

app.post('/api/events/:eventId/feedback', authenticate, authorize('student', 'faculty'), async (request, response) => {
  const eventId = Number(request.params.eventId)
  const rating = Number(request.body?.rating)
  const comment = typeof request.body?.comment === 'string' ? request.body.comment.trim() : ''

  if (!Number.isSafeInteger(eventId) || eventId < 1) return response.status(400).json({ error: 'Invalid event ID' })
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return response.status(400).json({ error: 'Rating must be between 1 and 5' })
  if (comment.length < 3 || comment.length > 1500) return response.status(400).json({ error: 'Feedback comments must be between 3 and 1500 characters long' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const event = await client.query(
      `SELECT event_id, ends_at, status
         FROM events
        WHERE event_id = $1
        FOR UPDATE`,
      [eventId],
    )
    if (event.rowCount !== 1 || event.rows[0].status !== 'approved') {
      await client.query('ROLLBACK')
      return response.status(404).json({ error: 'Event not found or not available for feedback' })
    }
    if (Date.now() < new Date(event.rows[0].ends_at).getTime()) {
      await client.query('ROLLBACK')
      return response.status(409).json({ error: 'Feedback can only be submitted after the event has ended' })
    }

    const registration = await client.query(
      `SELECT 1
         FROM registrations
        WHERE event_id = $1 AND user_id = $2 AND status = 'confirmed'`,
      [eventId, request.user.user_id],
    )
    if (registration.rowCount !== 1) {
      await client.query('ROLLBACK')
      return response.status(403).json({ error: 'Only confirmed attendees can submit feedback' })
    }

    const result = await client.query(
      `INSERT INTO feedback (event_id, user_id, rating, comment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id, user_id) DO NOTHING
       RETURNING feedback_id AS id, rating, comment, created_at`,
      [eventId, request.user.user_id, rating, comment],
    )
    if (result.rowCount !== 1) {
      await client.query('ROLLBACK')
      return response.status(409).json({ error: 'You have already submitted feedback for this event' })
    }
    await client.query('COMMIT')
    response.status(201).json({ data: result.rows[0] })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

app.get('/api/managed-events/:eventId/feedback', authenticate, authorize('faculty', 'organizer', 'admin'), async (request, response) => {
  const eventId = Number(request.params.eventId)
  if (!Number.isSafeInteger(eventId) || eventId < 1) return response.status(400).json({ error: 'Invalid event ID' })

  const eventResult = await pool.query(
    `SELECT event_id AS id, title, organizer_id
       FROM events
      WHERE event_id = $1`,
    [eventId],
  )
  if (eventResult.rowCount !== 1) return response.status(404).json({ error: 'Event not found' })

  const event = eventResult.rows[0]
  if (request.user.role !== 'admin' && String(event.organizer_id) !== String(request.user.user_id)) {
    return response.status(403).json({ error: 'You are not authorized to view feedback for this event' })
  }

  const summaryResult = await pool.query(
    `SELECT COALESCE(ROUND(AVG(rating)::NUMERIC, 2), 0) AS average_rating,
            COUNT(*)::INTEGER AS total_reviews
       FROM feedback
      WHERE event_id = $1`,
    [eventId],
  )
  const itemsResult = await pool.query(
    `SELECT f.feedback_id AS id, u.name AS user_name, f.rating, f.comment, f.created_at
       FROM feedback f
       JOIN users u ON u.user_id = f.user_id
      WHERE f.event_id = $1
      ORDER BY f.created_at DESC, f.feedback_id DESC`,
    [eventId],
  )

  response.json({
    data: {
      event_id: eventId,
      event_title: event.title,
      average_rating: Number(summaryResult.rows[0].average_rating ?? 0),
      total_reviews: Number(summaryResult.rows[0].total_reviews ?? 0),
      items: itemsResult.rows,
    },
  })
})

app.get('/api/registrations/me', authenticate, async (request, response) => {
  const result = await pool.query(
    `SELECT r.event_id AS id, r.status,
            e.title, e.category, e.starts_at, e.ends_at, e.capacity,
            CASE WHEN a.attendance_id IS NULL THEN false ELSE true END AS attended,
            v.venue_name AS venue, u.name AS organizer
       FROM registrations r
       JOIN events e ON e.event_id = r.event_id
       JOIN venues v ON v.venue_id = e.venue_id
       JOIN users u ON u.user_id = e.organizer_id
       LEFT JOIN attendance a ON a.event_id = r.event_id AND a.user_id = r.user_id AND a.status = 'present'
      WHERE r.user_id = $1 AND r.status IN ('confirmed', 'waitlisted')
      ORDER BY e.starts_at`,
    [request.user.user_id],
  )
  response.json({ data: result.rows })
})

app.get('/api/events/:eventId/certificate', authenticate, authorize('student', 'faculty'), async (request, response) => {
  const eventId = Number(request.params.eventId)
  if (!Number.isSafeInteger(eventId) || eventId < 1) return response.status(400).json({ error: 'Invalid event ID' })
  const result = await pool.query(
    `SELECT e.title, e.starts_at, e.ends_at, u.name AS attendee_name, a.marked_at
       FROM events e
       JOIN registrations r ON r.event_id = e.event_id AND r.user_id = $2 AND r.status = 'confirmed'
       JOIN attendance a ON a.event_id = e.event_id AND a.user_id = r.user_id AND a.status = 'present'
       JOIN users u ON u.user_id = r.user_id
      WHERE e.event_id = $1 AND e.status = 'approved' AND e.ends_at <= now()`,
    [eventId, request.user.user_id],
  )
  if (result.rowCount !== 1) return response.status(403).json({ error: 'A completed event and recorded attendance are required for a certificate' })

  const certificate = result.rows[0]
  const document = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 54, info: { Title: `Certificate of Attendance: ${certificate.title}`, Author: 'Campus Events' } })
  response.setHeader('Content-Type', 'application/pdf')
  response.setHeader('Content-Disposition', `attachment; filename="attendance-certificate-${eventId}.pdf"`)
  document.pipe(response)
  document.rect(34, 34, 774, 534).lineWidth(2).strokeColor('#416b4c').stroke()
  document.rect(43, 43, 756, 516).lineWidth(0.7).strokeColor('#9cb59f').stroke()
  document.fillColor('#416b4c').font('Helvetica-Bold').fontSize(12).text('CAMPUS EVENTS', 65, 82, { align: 'center', characterSpacing: 2 })
  document.moveDown(1.7)
  document.fillColor('#293c31').font('Helvetica-Bold').fontSize(30).text('CERTIFICATE OF ATTENDANCE', { align: 'center' })
  document.moveDown(1.2)
  document.fillColor('#65756a').font('Helvetica').fontSize(14).text('This certifies that', { align: 'center' })
  document.moveDown(0.55)
  document.fillColor('#2e5038').font('Helvetica-Bold').fontSize(27).text(certificate.attendee_name, { align: 'center' })
  document.moveDown(0.65)
  document.fillColor('#65756a').font('Helvetica').fontSize(14).text('attended', { align: 'center' })
  document.moveDown(0.45)
  document.fillColor('#293c31').font('Helvetica-Bold').fontSize(20).text(certificate.title, { align: 'center', width: 660, lineGap: 5 })
  document.moveDown(0.55)
  document.fillColor('#65756a').font('Helvetica').fontSize(12).text(
    `${new Date(certificate.starts_at).toLocaleDateString()} - ${new Date(certificate.ends_at).toLocaleDateString()}`,
    { align: 'center' },
  )
  document.moveTo(300, 472).lineTo(542, 472).lineWidth(0.7).strokeColor('#9cb59f').stroke()
  document.fillColor('#416b4c').font('Helvetica-Bold').fontSize(10).text('CAMPUS EVENT OFFICE', 300, 482, { width: 242, align: 'center', characterSpacing: 1 })
  document.fillColor('#829087').font('Helvetica').fontSize(9).text(`Attendance verified ${new Date(certificate.marked_at).toLocaleDateString()}`, 65, 526, { align: 'center' })
  document.end()
})

app.get('/api/events/:eventId/attendance-pass', authenticate, authorize('student', 'faculty'), async (request, response) => {
  const eventId = Number(request.params.eventId)
  if (!Number.isSafeInteger(eventId) || eventId < 1) return response.status(400).json({ error: 'Invalid event ID' })
  const result = await pool.query(
    `SELECT e.event_id, e.starts_at, e.ends_at, e.status, r.status AS registration_status
       FROM events e
       JOIN registrations r ON r.event_id = e.event_id AND r.user_id = $2
      WHERE e.event_id = $1`,
    [eventId, request.user.user_id],
  )
  if (result.rowCount !== 1 || result.rows[0].status !== 'approved' || result.rows[0].registration_status !== 'confirmed') {
    return response.status(403).json({ error: 'A confirmed registration is required for this event' })
  }
  const event = result.rows[0]
  const checkInOpensAt = new Date(event.starts_at).getTime() - 60 * 60 * 1000
  if (Date.now() < checkInOpensAt) return response.status(409).json({ error: 'Attendance QR passes are available one hour before the event starts' })
  const expiresAt = Math.floor((new Date(event.ends_at).getTime() + 2 * 60 * 60 * 1000) / 1000)
  if (expiresAt <= Math.floor(Date.now() / 1000)) return response.status(409).json({ error: 'The attendance window has closed' })
  const pass = jwt.sign(
    { purpose: 'attendance', event_id: Number(event.event_id), participant_id: Number(request.user.user_id) },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', issuer: attendanceIssuer, audience: attendanceIssuer, expiresIn: expiresAt - Math.floor(Date.now() / 1000) },
  )
  response.json({ data: { value: `campus-events-attendance:${pass}`, event_id: Number(event.event_id), expires_at: new Date(expiresAt * 1000).toISOString() } })
})

app.post('/api/events/:eventId/attendance/scan', authenticate, authorize('faculty', 'organizer', 'admin'), async (request, response) => {
  const eventId = Number(request.params.eventId)
  const encodedPass = typeof request.body?.pass === 'string' ? request.body.pass : ''
  const passMatch = /^campus-events-attendance:(.+)$/.exec(encodedPass)
  if (!Number.isSafeInteger(eventId) || eventId < 1) return response.status(400).json({ error: 'Invalid event ID' })
  if (!passMatch) return response.status(400).json({ error: 'Invalid attendance QR code' })

  let claims
  try {
    claims = jwt.verify(passMatch[1], process.env.JWT_SECRET, {
      algorithms: ['HS256'], issuer: attendanceIssuer, audience: attendanceIssuer,
    })
  } catch {
    return response.status(400).json({ error: 'Attendance QR code is invalid or expired' })
  }
  if (typeof claims === 'string' || claims.purpose !== 'attendance' || Number(claims.event_id) !== eventId || !Number.isSafeInteger(Number(claims.participant_id))) {
    return response.status(400).json({ error: 'QR code does not belong to this event' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const event = await client.query(
      `SELECT event_id, organizer_id, starts_at, ends_at, status
         FROM events WHERE event_id = $1 FOR UPDATE`,
      [eventId],
    )
    if (event.rowCount !== 1 || event.rows[0].status !== 'approved' || (request.user.role !== 'admin' && String(event.rows[0].organizer_id) !== String(request.user.user_id))) {
      await client.query('ROLLBACK')
      return response.status(404).json({ error: 'Event not found' })
    }
    const current = event.rows[0]
    const now = Date.now()
    if (now < new Date(current.starts_at).getTime() - 60 * 60 * 1000 || now > new Date(current.ends_at).getTime() + 2 * 60 * 60 * 1000) {
      await client.query('ROLLBACK')
      return response.status(409).json({ error: 'Check-in is outside the event attendance window' })
    }
    const registration = await client.query(
      `SELECT 1 FROM registrations
        WHERE event_id = $1 AND user_id = $2 AND status = 'confirmed'`,
      [eventId, claims.participant_id],
    )
    if (registration.rowCount !== 1) {
      await client.query('ROLLBACK')
      return response.status(403).json({ error: 'Participant does not have a confirmed registration' })
    }
    const participant = await client.query(
      'SELECT name, email FROM users WHERE user_id = $1',
      [claims.participant_id],
    )
    const attendance = await client.query(
      `INSERT INTO attendance (event_id, user_id, status)
       VALUES ($1, $2, 'present')
       ON CONFLICT (event_id, user_id) DO NOTHING
       RETURNING attendance_id, marked_at`,
      [eventId, claims.participant_id],
    )
    if (attendance.rowCount !== 1) {
      await client.query('ROLLBACK')
      return response.status(409).json({ error: 'Attendance was already recorded' })
    }
    await client.query('COMMIT')
    return response.status(201).json({ data: { participant: participant.rows[0], marked_at: attendance.rows[0].marked_at } })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

app.get('/api/managed-events/:eventId/attendance', authenticate, authorize('faculty', 'organizer', 'admin'), async (request, response) => {
  const eventId = Number(request.params.eventId)
  if (!Number.isSafeInteger(eventId) || eventId < 1) return response.status(400).json({ error: 'Invalid event ID' })
  const result = await pool.query(
    `SELECT e.event_id AS id, e.title, e.organizer_id,
            COUNT(r.registration_id) FILTER (WHERE r.status = 'confirmed')::INTEGER AS confirmed_count,
            COUNT(a.attendance_id)::INTEGER AS attended_count,
            COALESCE(ROUND(100.0 * COUNT(a.attendance_id) / NULLIF(COUNT(r.registration_id) FILTER (WHERE r.status = 'confirmed'), 0), 1), 0) AS attendance_percentage
       FROM events e
       LEFT JOIN registrations r ON r.event_id = e.event_id AND r.status = 'confirmed'
       LEFT JOIN attendance a ON a.event_id = e.event_id AND a.user_id = r.user_id AND a.status = 'present'
      WHERE e.event_id = $1 AND ($2::BOOLEAN OR e.organizer_id = $3)
      GROUP BY e.event_id`,
    [eventId, request.user.role === 'admin', request.user.user_id],
  )
  if (result.rowCount !== 1) return response.status(404).json({ error: 'Event not found' })
  const participants = await pool.query(
    `SELECT u.user_id AS id, u.name, u.email, a.marked_at,
            CASE WHEN a.attendance_id IS NULL THEN false ELSE true END AS attended
       FROM registrations r
       JOIN users u ON u.user_id = r.user_id
       LEFT JOIN attendance a ON a.event_id = r.event_id AND a.user_id = r.user_id AND a.status = 'present'
      WHERE r.event_id = $1 AND r.status = 'confirmed'
      ORDER BY u.name`,
    [eventId],
  )
  response.json({ data: { ...result.rows[0], participants: participants.rows } })
})

app.post('/api/events/:eventId/registrations', authenticate, authorize('student', 'faculty'), async (request, response) => {
  const eventId = Number(request.params.eventId)
  if (!Number.isSafeInteger(eventId) || eventId < 1) return response.status(400).json({ error: 'Invalid event ID' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE', [request.user.user_id])
    const eventResult = await client.query(
      'SELECT event_id, title, category, starts_at, ends_at, capacity, registration_deadline FROM events WHERE event_id = $1 AND status = $2 FOR UPDATE',
      [eventId, 'approved'],
    )
    if (eventResult.rowCount !== 1) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'Event not found' }) }
    const event = eventResult.rows[0]
    if (new Date(event.registration_deadline).getTime() < Date.now()) { await client.query('ROLLBACK'); return response.status(409).json({ error: 'Registration deadline has passed' }) }

    const existing = await client.query(
      'SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2 FOR UPDATE',
      [eventId, request.user.user_id],
    )
    if (existing.rowCount === 1 && existing.rows[0].status !== 'cancelled') {
      await client.query('ROLLBACK')
      return response.status(409).json({ error: 'You are already registered for this event' })
    }

    const conflicts = await client.query(
      `SELECT e.event_id AS id, e.title, e.starts_at, e.ends_at
         FROM registrations r
         JOIN events e ON e.event_id = r.event_id
        WHERE r.user_id = $1 AND r.status = 'confirmed'
          AND e.status = 'approved' AND e.event_id <> $2
          AND e.starts_at < $4 AND e.ends_at > $3
        ORDER BY e.starts_at`,
      [request.user.user_id, eventId, event.starts_at, event.ends_at],
    )
    if (conflicts.rowCount > 0) {
      const alternatives = await client.query(
        `SELECT e.event_id AS id, e.title, e.category, e.starts_at, e.ends_at,
                v.venue_name AS venue
           FROM events e
           JOIN venues v ON v.venue_id = e.venue_id
          WHERE e.status = 'approved' AND e.category = $2 AND e.event_id <> $3
            AND e.starts_at > now() AND e.registration_deadline >= now()
            AND NOT EXISTS (
              SELECT 1 FROM registrations r
               WHERE r.event_id = e.event_id AND r.user_id = $1
                 AND r.status <> 'cancelled'
            )
            AND (SELECT COUNT(*) FROM registrations r
                  WHERE r.event_id = e.event_id AND r.status = 'confirmed') < e.capacity
            AND NOT EXISTS (
              SELECT 1 FROM registrations r
              JOIN events booked ON booked.event_id = r.event_id
               WHERE r.user_id = $1 AND r.status = 'confirmed'
                 AND booked.status = 'approved'
                 AND booked.starts_at < e.ends_at AND booked.ends_at > e.starts_at
            )
          ORDER BY ABS(EXTRACT(EPOCH FROM (e.starts_at - $4::TIMESTAMPTZ))), e.starts_at
          LIMIT 3`,
        [request.user.user_id, event.category, eventId, event.starts_at],
      )
      await client.query('ROLLBACK')
      return response.status(409).json({
        error: `This event overlaps with ${conflicts.rows.map((conflict) => conflict.title).join(', ')}`,
        data: { conflicts: conflicts.rows, alternatives: alternatives.rows },
      })
    }

    const confirmed = await client.query(
      `SELECT COUNT(*)::INTEGER AS count FROM registrations
        WHERE event_id = $1 AND status = 'confirmed'`,
      [eventId],
    )
    const status = confirmed.rows[0].count < event.capacity ? 'confirmed' : 'waitlisted'
    const registration = existing.rowCount === 1
      ? await client.query(
        `UPDATE registrations SET status = $3, registration_date = now()
          WHERE event_id = $1 AND user_id = $2
          RETURNING registration_id, event_id, user_id, registration_date, status`,
        [eventId, request.user.user_id, status],
      )
      : await client.query(
        `INSERT INTO registrations (event_id, user_id, status)
         VALUES ($1, $2, $3)
         RETURNING registration_id, event_id, user_id, registration_date, status`,
        [eventId, request.user.user_id, status],
      )
    await client.query('COMMIT')
    return response.status(201).json({ data: registration.rows[0] })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

app.delete('/api/events/:eventId/registrations/me', authenticate, authorize('student', 'faculty'), async (request, response) => {
  const eventId = Number(request.params.eventId)
  if (!Number.isSafeInteger(eventId) || eventId < 1) return response.status(400).json({ error: 'Invalid event ID' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const event = await client.query('SELECT event_id FROM events WHERE event_id = $1 FOR UPDATE', [eventId])
    if (event.rowCount !== 1) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'Event not found' }) }
    const registration = await client.query(
      'SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2 FOR UPDATE',
      [eventId, request.user.user_id],
    )
    if (registration.rowCount !== 1 || registration.rows[0].status === 'cancelled') {
      await client.query('ROLLBACK')
      return response.status(404).json({ error: 'Registration not found' })
    }

    const wasConfirmed = registration.rows[0].status === 'confirmed'
    await client.query(
      `UPDATE registrations SET status = 'cancelled'
        WHERE event_id = $1 AND user_id = $2`,
      [eventId, request.user.user_id],
    )
    let promoted = false
    if (wasConfirmed) {
      const next = await client.query(
        `SELECT registration_id FROM registrations
          WHERE event_id = $1 AND status = 'waitlisted'
          ORDER BY registration_date, registration_id
          LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [eventId],
      )
      if (next.rowCount === 1) {
        await client.query(`UPDATE registrations SET status = 'confirmed' WHERE registration_id = $1`, [next.rows[0].registration_id])
        promoted = true
      }
    }
    await client.query('COMMIT')
    return response.json({ data: { status: 'cancelled', waitlistedParticipantPromoted: promoted } })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

app.get('/api/saved-events', authenticate, async (request, response) => {
  const result = await pool.query(
    `SELECT e.event_id AS id, e.title, e.category, e.starts_at,
            v.venue_name AS venue, u.name AS organizer
       FROM saved_events s
       JOIN events e ON e.event_id = s.event_id
       JOIN venues v ON v.venue_id = e.venue_id
       JOIN users u ON u.user_id = e.organizer_id
      WHERE s.user_id = $1 AND e.status = 'approved'
      ORDER BY s.saved_at DESC`,
    [request.user.user_id],
  )
  response.json({ data: result.rows })
})

app.post('/api/saved-events/:eventId', authenticate, authorize('student', 'faculty'), async (request, response) => {
  const eventId = Number(request.params.eventId)
  if (!Number.isSafeInteger(eventId) || eventId < 1) return response.status(400).json({ error: 'Invalid event ID' })
  const result = await pool.query(
    `INSERT INTO saved_events (event_id, user_id)
     SELECT event_id, $2 FROM events WHERE event_id = $1 AND status = 'approved'
     ON CONFLICT (event_id, user_id) DO NOTHING
     RETURNING event_id AS id`,
    [eventId, request.user.user_id],
  )
  if (result.rowCount === 0) {
    const exists = await pool.query('SELECT 1 FROM events WHERE event_id = $1 AND status = $2', [eventId, 'approved'])
    if (exists.rowCount === 0) return response.status(404).json({ error: 'Event not found' })
  }
  response.status(201).json({ data: { id: eventId, saved: true } })
})

app.delete('/api/saved-events/:eventId', authenticate, authorize('student', 'faculty'), async (request, response) => {
  const eventId = Number(request.params.eventId)
  if (!Number.isSafeInteger(eventId) || eventId < 1) return response.status(400).json({ error: 'Invalid event ID' })
  await pool.query('DELETE FROM saved_events WHERE event_id = $1 AND user_id = $2', [eventId, request.user.user_id])
  response.status(204).end()
})

app.use((error, _request, response, _next) => {
  console.error('API request failed:', error.message)
  if (error.code === '23P01') return response.status(409).json({ error: 'The venue or organizer already has an event at that time' })
  if (error.code === 'P0001') return response.status(400).json({ error: error.message })
  if (error.code === '23503' || error.code === '23514') return response.status(400).json({ error: 'The submitted event data is invalid' })
  response.status(500).json({ error: 'Internal server error' })
})

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Campus Events API listening on http://127.0.0.1:${port}`)
})
const stopReminderScheduler = startReminderScheduler(pool)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(async () => {
    stopReminderScheduler()
    await pool.end()
    process.exit(0)
  }))
}
