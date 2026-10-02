import nodemailer from 'nodemailer'

const smtpHost = process.env.SMTP_HOST
const transporter = smtpHost ? nodemailer.createTransport({
  host: smtpHost,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
}) : null
const from = process.env.SMTP_FROM ?? 'Campus Events <no-reply@example.com>'
let missingConfigLogged = false

export async function sendNotificationEmail(to, subject, text) {
  if (!transporter) {
    if (!missingConfigLogged) {
      console.warn('Email notifications are disabled because SMTP_HOST is not configured')
      missingConfigLogged = true
    }
    return false
  }

  try {
    await transporter.sendMail({ from, to, subject, text })
    return true
  } catch (error) {
    console.error('Email notification delivery failed:', error.message)
    return false
  }
}

export async function sendRegisteredNotificationEmails(pool, eventId, statuses, subject, text) {
  try {
    const recipients = await pool.query(
      `SELECT DISTINCT u.email
         FROM registrations r
         JOIN users u ON u.user_id = r.user_id
        WHERE r.event_id = $1 AND r.status = ANY($2::TEXT[])
          AND u.announcements_enabled = true`,
      [eventId, statuses],
    )
    await Promise.all(recipients.rows.map((recipient) => sendNotificationEmail(recipient.email, subject, text)))
  } catch (error) {
    console.error('Could not load event email recipients:', error.message)
  }
}

export async function sendUserNotificationEmail(pool, userId, subject, text) {
  try {
    const recipient = await pool.query(
      'SELECT email FROM users WHERE user_id = $1 AND announcements_enabled = true',
      [userId],
    )
    if (recipient.rowCount === 1) await sendNotificationEmail(recipient.rows[0].email, subject, text)
  } catch (error) {
    console.error('Could not load notification email recipient:', error.message)
  }
}