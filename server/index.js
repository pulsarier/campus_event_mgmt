import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import pg from 'pg'
import { createAuthRouter } from './auth.js'

const { Pool } = pg
const port = Number(process.env.API_PORT ?? 3001)
const allowedOrigins = (process.env.CLIENT_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174').split(',')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const app = express()

app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)) }))
app.use(express.json({ limit: '32kb' }))
app.use('/api/auth', createAuthRouter(pool, process.env.JWT_SECRET))

app.get('/api/health', async (_request, response) => {
  await pool.query('SELECT 1')
  response.json({ status: 'ok', database: 'connected' })
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

app.use((error, _request, response, _next) => {
  console.error('API request failed:', error.message)
  response.status(500).json({ error: 'Internal server error' })
})

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Campus Events API listening on http://127.0.0.1:${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(async () => {
    await pool.end()
    process.exit(0)
  }))
}
