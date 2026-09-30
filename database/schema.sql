CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE users (
    user_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student', 'faculty', 'organizer', 'admin')),
    department TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE venues (
    venue_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_name TEXT NOT NULL CHECK (length(trim(venue_name)) > 0),
    location TEXT NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    availability BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE events (
    event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    registration_deadline TIMESTAMPTZ NOT NULL,
    venue_id BIGINT NOT NULL REFERENCES venues(venue_id) ON DELETE RESTRICT,
    organizer_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at),
    CHECK (registration_deadline <= starts_at),
    EXCLUDE USING gist (
        venue_id WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
    ) WHERE (status IN ('pending', 'approved')),
    EXCLUDE USING gist (
        organizer_id WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
    ) WHERE (status IN ('pending', 'approved'))
);

CREATE FUNCTION validate_event_setup() RETURNS trigger AS $$
DECLARE
    venue_capacity INTEGER;
    venue_is_available BOOLEAN;
    organizer_role TEXT;
BEGIN
    SELECT capacity, availability
      INTO venue_capacity, venue_is_available
      FROM venues
     WHERE venue_id = NEW.venue_id;

    IF NOT venue_is_available THEN
        RAISE EXCEPTION 'Venue % is unavailable', NEW.venue_id;
    END IF;

    IF NEW.capacity > venue_capacity THEN
        RAISE EXCEPTION 'Event capacity % exceeds venue capacity %', NEW.capacity, venue_capacity;
    END IF;

    SELECT role INTO organizer_role
      FROM users
     WHERE user_id = NEW.organizer_id;

    IF organizer_role NOT IN ('faculty', 'organizer', 'admin') THEN
        RAISE EXCEPTION 'User % is not permitted to organize events', NEW.organizer_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_validate_setup
BEFORE INSERT OR UPDATE OF venue_id, organizer_id, capacity ON events
FOR EACH ROW EXECUTE FUNCTION validate_event_setup();

CREATE TABLE registrations (
    registration_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id BIGINT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    registration_date TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'confirmed'
        CHECK (status IN ('confirmed', 'waitlisted', 'cancelled')),
    UNIQUE (event_id, user_id)
);

CREATE TABLE attendance (
    attendance_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id BIGINT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent')),
    UNIQUE (event_id, user_id)
);

CREATE TABLE feedback (
    feedback_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id BIGINT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (event_id, user_id)
);

CREATE TABLE notifications (
    notification_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    event_id BIGINT REFERENCES events(event_id) ON DELETE SET NULL,
    message TEXT NOT NULL CHECK (length(trim(message)) > 0),
    is_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX events_status_start_idx ON events(status, starts_at);
CREATE INDEX events_category_idx ON events(category);
CREATE INDEX registrations_user_status_idx ON registrations(user_id, status);
CREATE INDEX attendance_event_idx ON attendance(event_id);
CREATE INDEX feedback_event_idx ON feedback(event_id);
CREATE INDEX notifications_user_unread_idx ON notifications(user_id, is_read) WHERE (is_read = false);
