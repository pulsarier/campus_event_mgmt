ALTER TABLE users
    ADD COLUMN IF NOT EXISTS event_reminders_enabled BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS announcements_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS notification_type TEXT NOT NULL DEFAULT 'system',
    ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'notifications_type_check'
           AND conrelid = 'notifications'::regclass
    ) THEN
        ALTER TABLE notifications
            ADD CONSTRAINT notifications_type_check
            CHECK (notification_type IN ('event_update', 'event_cancelled', 'event_approval', 'event_reminder', 'system'));
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key_idx
    ON notifications(dedupe_key);
