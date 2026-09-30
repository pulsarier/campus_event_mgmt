import bcrypt from 'bcryptjs'
import { rateLimit } from 'express-rate-limit'
import express from 'express'
import jwt from 'jsonwebtoken'

const roles = new Set(['student', 'faculty', 'organizer', 'admin'])
const jwtIssuer = 'campus-events'

export function createAuthRouter(pool, jwtSecret) {
  if (typeof jwtSecret !== 'string' || Buffer.byteLength(jwtSecret) < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes')
  }

  const router = express.Router()
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts. Try again later.' },
  })

  const issueToken = (userId) => jwt.sign(
    { sub: String(userId) },
    jwtSecret,
    { algorithm: 'HS256', expiresIn: '1h', issuer: jwtIssuer, audience: jwtIssuer },
  )

  async function authenticate(request, response, next) {
    const authorization = request.get('authorization') ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(authorization)
    if (!match) return response.status(401).json({ error: 'Authentication required' })

    try {
      const claims = jwt.verify(match[1], jwtSecret, {
        algorithms: ['HS256'],
        issuer: jwtIssuer,
        audience: jwtIssuer,
      })
      if (typeof claims === 'string' || !/^\d+$/.test(claims.sub ?? '')) {
        return response.status(401).json({ error: 'Invalid access token' })
      }

      const result = await pool.query(
        'SELECT user_id, name, email, role, department FROM users WHERE user_id = $1',
        [claims.sub],
      )
      if (result.rowCount !== 1) return response.status(401).json({ error: 'Invalid access token' })
      request.user = result.rows[0]
      return next()
    } catch {
      return response.status(401).json({ error: 'Invalid or expired access token' })
    }
  }

  const authorize = (...allowedRoles) => (request, response, next) => {
    if (!request.user || !roles.has(request.user.role) || !allowedRoles.includes(request.user.role)) {
      return response.status(403).json({ error: 'Insufficient permissions' })
    }
    return next()
  }

  router.post('/register', authLimiter, async (request, response) => {
    const { name, email, password, role = 'student', department = '' } = request.body ?? {}
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : ''
    const cleanName = typeof name === 'string' ? name.trim() : ''
    const passwordBytes = typeof password === 'string' ? Buffer.byteLength(password, 'utf8') : 0

    if (cleanName.length < 2 || cleanName.length > 120) {
      return response.status(400).json({ error: 'Name must be between 2 and 120 characters' })
    }
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return response.status(400).json({ error: 'A valid email address is required' })
    }
    if (passwordBytes < 12 || passwordBytes > 72) {
      return response.status(400).json({ error: 'Password must be between 12 and 72 UTF-8 bytes' })
    }
    if (!['student', 'faculty'].includes(role)) {
      return response.status(403).json({ error: 'This role cannot be self-registered' })
    }
    if (typeof department !== 'string' || department.length > 120) {
      return response.status(400).json({ error: 'Invalid department' })
    }

    try {
      const passwordHash = await bcrypt.hash(password, 12)
      const result = await pool.query(
        `INSERT INTO users (name, email, password_hash, role, department)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING user_id, name, email, role, department`,
        [cleanName, normalizedEmail, passwordHash, role, department.trim()],
      )
      const user = result.rows[0]
      return response.status(201).json({ data: user, token: issueToken(user.user_id) })
    } catch (error) {
      if (error.code === '23505') return response.status(409).json({ error: 'An account with this email already exists' })
      throw error
    }
  })

  router.post('/login', authLimiter, async (request, response) => {
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : ''
    const password = typeof request.body?.password === 'string' ? request.body.password : ''
    if (!email || !password) return response.status(400).json({ error: 'Email and password are required' })

    const result = await pool.query(
      'SELECT user_id, name, email, role, department, password_hash FROM users WHERE email = $1',
      [email],
    )
    const user = result.rows[0]
    const passwordMatches = user ? await bcrypt.compare(password, user.password_hash) : false
    if (!passwordMatches) return response.status(401).json({ error: 'Email or password is incorrect' })

    const { password_hash: _passwordHash, ...safeUser } = user
    return response.json({ data: safeUser, token: issueToken(user.user_id) })
  })

  router.get('/me', authenticate, (request, response) => response.json({ data: request.user }))
  router.get('/admin/users', authenticate, authorize('admin'), async (_request, response) => {
    const result = await pool.query(
      'SELECT user_id, name, email, role, department, created_at FROM users ORDER BY created_at DESC',
    )
    return response.json({ data: result.rows })
  })

  return router
}
