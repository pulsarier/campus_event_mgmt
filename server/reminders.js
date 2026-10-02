import { sendNotificationEmail } from './mailer.js'

export function startReminderScheduler(pool, intervalMs = 15 * 60 * 1000) {
  let stopped = false
  const run = async () => {
    if (stopped) return
    try {
      const reminders = await pool.query(
        `WITH inserted_notifications AS (
           INSERT INTO notifications (user_id, event_id, message, notification_type, dedupe_key)
           SELECT r.user_id,
                  e.event_id,
                  'Reminder: "' || e.title || '" starts within 24 hours.',
                  'event_reminder',
                  'event-reminder:' || e.event_id || ':' || r.user_id || ':' || extract(epoch FROM e.starts_at)::BIGINT
             FROM registrations r
             JOIN events e ON e.event_id = r.event_id
             JOIN users u ON u.user_id = r.user_id
            WHERE r.status = 'confirmed'
              AND u.event_reminders_enabled = true
              AND e.status = 'approved'
              AND e.starts_at > now()
              AND e.starts_at <= now() + interval '24 hours'
           ON CONFLICT (dedupe_key) DO NOTHING
           RETURNING user_id, event_id, message
         )
         SELECT u.email, n.message
           FROM inserted_notifications n
           JOIN users u ON u.user_id = n.user_id`,
      )
      await Promise.all(reminders.rows.map((reminder) => sendNotificationEmail(
        reminder.email,
        'Campus Events: event reminder',
        reminder.message,
      )))
    } catch (error) {
      console.error('Event reminder task failed:', error.message)
    }
  }

  void run()
  const timer = setInterval(run, intervalMs)
  timer.unref()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
