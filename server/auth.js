import bcrypt from 'bcryptjs'
import { createHash, randomBytes } from 'node:crypto'
import { rateLimit } from 'express-rate-limit'
import express from 'express'
import jwt from 'jsonwebtoken'
import nodemailer from 'nodemailer'

const roles = new Set(['student', 'faculty', 'organizer', 'admin'])
const jwtIssuer = 'campus-events'

export function createAccessControl(pool, jwtSecret) {
  if (typeof jwtSecret !== 'string' || Buffer.byteLength(jwtSecret) < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes')
  }
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
        'SELECT user_id, name, email, role, department, event_reminders_enabled, announcements_enabled FROM users WHERE user_id = $1',
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

  return { authenticate, authorize }
}

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
  const resetRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many password reset requests. Try again later.' },
  })
  const smtpHost = process.env.SMTP_HOST
  const resetMailer = smtpHost ? nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  }) : null
  const clientAppUrl = (process.env.CLIENT_APP_URL ?? 'http://127.0.0.1:5174').replace(/\/$/, '')
  const resetEmailFrom = process.env.SMTP_FROM ?? 'Campus Events <no-reply@example.com>'
  const { authenticate, authorize } = createAccessControl(pool, jwtSecret)
  const issueToken = (userId) => jwt.sign(
    { sub: String(userId) },
    jwtSecret,
    { algorithm: 'HS256', expiresIn: '1h', issuer: jwtIssuer, audience: jwtIssuer },
  )

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
    if (role !== 'student') {
      return response.status(403).json({ error: 'Only student accounts can self-register; staff roles must be assigned by an administrator' })
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
      'SELECT user_id, name, email, role, department, event_reminders_enabled, announcements_enabled, password_hash FROM users WHERE email = $1',
      [email],
    )
    const user = result.rows[0]
    const passwordMatches = user ? await bcrypt.compare(password, user.password_hash) : false
    if (!passwordMatches) return response.status(401).json({ error: 'Email or password is incorrect' })

    const { password_hash: _passwordHash, ...safeUser } = user
    return response.json({ data: safeUser, token: issueToken(user.user_id) })
  })

  router.post('/forgot-password', resetRequestLimiter, async (request, response) => {
    if (!resetMailer) return response.status(503).json({ error: 'Password reset is temporarily unavailable' })
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : ''
    const genericResponse = { data: { message: 'If an account exists for that email, a password reset link will be sent.' } }
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.json(genericResponse)

    const result = await pool.query('SELECT user_id, name, email FROM users WHERE email = $1', [email])
    if (result.rowCount !== 1) return response.json(genericResponse)

    const user = result.rows[0]
    const token = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    await pool.query('DELETE FROM password_reset_tokens WHERE expires_at <= now() OR user_id = $1', [user.user_id])
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 minutes')`,
      [user.user_id, tokenHash],
    )

    const resetUrl = `${clientAppUrl}/#reset-password?token=${token}`
    try {
      await resetMailer.sendMail({
        from: resetEmailFrom,
        to: user.email,
        subject: 'Reset your Campus Events password',
        text: `Hello,\n\nUse this link to reset your password within 30 minutes:\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
        html: `<p>Hello,</p><p>Use this link to reset your password within 30 minutes:</p><p><a href="${resetUrl}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`,
      })
    } catch (error) {
      await pool.query('DELETE FROM password_reset_tokens WHERE token_hash = $1', [tokenHash])
      console.error('Password reset email delivery failed:', error.message)
    }
    return response.json(genericResponse)
  })

  router.post('/reset-password', authLimiter, async (request, response) => {
    const token = typeof request.body?.token === 'string' ? request.body.token : ''
    const password = typeof request.body?.password === 'string' ? request.body.password : ''
    const passwordBytes = Buffer.byteLength(password, 'utf8')
    if (!/^[a-f\d]{64}$/i.test(token)) return response.status(400).json({ error: 'This password reset link is invalid or expired' })
    if (passwordBytes < 12 || passwordBytes > 72) {
      return response.status(400).json({ error: 'Password must be between 12 and 72 UTF-8 bytes' })
    }

    const passwordHash = await bcrypt.hash(password, 12)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const tokenHash = createHash('sha256').update(token).digest('hex')
      const reset = await client.query(
        `SELECT user_id FROM password_reset_tokens
          WHERE token_hash = $1 AND expires_at > now()
          FOR UPDATE`,
        [tokenHash],
      )
      if (reset.rowCount !== 1) {
        await client.query('ROLLBACK')
        return response.status(400).json({ error: 'This password reset link is invalid or expired' })
      }

      await client.query('UPDATE users SET password_hash = $2 WHERE user_id = $1', [reset.rows[0].user_id, passwordHash])
      await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [reset.rows[0].user_id])
      await client.query('COMMIT')
      return response.json({ data: { message: 'Password updated. Sign in with your new password.' } })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  router.get('/me', authenticate, (request, response) => response.json({ data: request.user }))
  router.patch('/me/preferences', authenticate, async (request, response) => {
    const { name, email, department, event_reminders_enabled: remindersEnabled, announcements_enabled: announcementsEnabled } = request.body ?? {}
    const cleanName = typeof name === 'string' ? name.trim() : ''
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : ''
    if (cleanName.length < 2 || cleanName.length > 120) return response.status(400).json({ error: 'Name must be between 2 and 120 characters' })
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return response.status(400).json({ error: 'A valid email address is required' })
    if (typeof department !== 'string' || department.length > 120) return response.status(400).json({ error: 'Invalid department' })
    if (typeof remindersEnabled !== 'boolean' || typeof announcementsEnabled !== 'boolean') {
      return response.status(400).json({ error: 'Notification preferences must be boolean values' })
    }
    try {
      const result = await pool.query(
        `UPDATE users
            SET name = $2, email = $3, department = $4,
                event_reminders_enabled = $5, announcements_enabled = $6
          WHERE user_id = $1
          RETURNING user_id, name, email, role, department,
                    event_reminders_enabled, announcements_enabled`,
        [request.user.user_id, cleanName, normalizedEmail, department.trim(), remindersEnabled, announcementsEnabled],
      )
      return response.json({ data: result.rows[0] })
    } catch (error) {
      if (error.code === '23505') return response.status(409).json({ error: 'An account with this email already exists' })
      throw error
    }
  })
  router.get('/admin/users', authenticate, authorize('admin'), async (_request, response) => {
    const result = await pool.query(
      'SELECT user_id, name, email, role, department, created_at FROM users ORDER BY created_at DESC',
    )
    return response.json({ data: result.rows })
  })

  return router
}
