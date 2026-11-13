import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'

const { Client } = pg
const databaseUrl = process.env.TEST_DATABASE_URL

describe('PostgreSQL event constraints', { skip: !databaseUrl }, () => {
  let client
  let organizerId
  let secondOrganizerId
  let studentId
  let firstVenueId
  let secondVenueId

  before(async () => {
    client = new Client({ connectionString: databaseUrl })
    await client.connect()
    await client.query('BEGIN')
    const schema = await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8')
    await client.query(schema)

    const organizer = await client.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ('Test Organizer', 'organizer@integration.test', 'not-used', 'organizer')
       RETURNING user_id`,
    )
    const secondOrganizer = await client.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ('Second Test Organizer', 'organizer2@integration.test', 'not-used', 'organizer')
       RETURNING user_id`,
    )
    const student = await client.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ('Test Student', 'student@integration.test', 'not-used', 'student')
       RETURNING user_id`,
    )
    const firstVenue = await client.query(
      `INSERT INTO venues (venue_name, location, capacity)
       VALUES ('Integration Hall', 'Test Campus', 100)
       RETURNING venue_id`,
    )
    const secondVenue = await client.query(
      `INSERT INTO venues (venue_name, location, capacity)
       VALUES ('Integration Lab', 'Test Campus', 100)
       RETURNING venue_id`,
    )

    organizerId = organizer.rows[0].user_id
    secondOrganizerId = secondOrganizer.rows[0].user_id
    studentId = student.rows[0].user_id
    firstVenueId = firstVenue.rows[0].venue_id
    secondVenueId = secondVenue.rows[0].venue_id
  })

  after(async () => {
    if (!client) return
    await client.query('ROLLBACK')
    await client.end()
  })

  it('allows valid events and rejects schedule, capacity, and organizer violations', async () => {
    const eventStart = '2030-04-10T10:00:00Z'
    const eventEnd = '2030-04-10T11:00:00Z'

    const insertEvent = (venueId, eventOrganizerId, startsAt, endsAt, capacity = 80) => client.query(
      `INSERT INTO events (
         title, category, starts_at, ends_at, registration_deadline,
         venue_id, organizer_id, capacity
       )
       VALUES ('Integration Event', 'Talks', $1, $2, $3, $4, $5, $6)
       RETURNING status`,
      [startsAt, endsAt, startsAt, venueId, eventOrganizerId, capacity],
    )

    const firstEvent = await insertEvent(firstVenueId, organizerId, eventStart, eventEnd)
    assert.equal(firstEvent.rows[0].status, 'pending')

    const assertConstraintFailure = async (startsAt, endsAt, venueId, eventOrganizerId, capacity, code) => {
      await client.query('SAVEPOINT expected_constraint_failure')
      await assert.rejects(
        insertEvent(venueId, eventOrganizerId, startsAt, endsAt, capacity),
        (error) => error.code === code,
      )
      await client.query('ROLLBACK TO SAVEPOINT expected_constraint_failure')
      await client.query('RELEASE SAVEPOINT expected_constraint_failure')
    }

    await assertConstraintFailure(
      '2030-04-10T10:30:00Z',
      '2030-04-10T11:30:00Z',
      firstVenueId,
      secondOrganizerId,
      80,
      '23P01',
    )
    await assertConstraintFailure(
      eventStart,
      eventEnd,
      secondVenueId,
      organizerId,
      80,
      '23P01',
    )
    await assertConstraintFailure(
      '2030-04-11T10:00:00Z',
      '2030-04-11T11:00:00Z',
      firstVenueId,
      secondOrganizerId,
      101,
      'P0001',
    )
    await assertConstraintFailure(
      '2030-04-11T12:00:00Z',
      '2030-04-11T13:00:00Z',
      secondVenueId,
      studentId,
      80,
      'P0001',
    )

    const independentEvent = await insertEvent(
      secondVenueId,
      secondOrganizerId,
      eventStart,
      eventEnd,
    )
    assert.equal(independentEvent.rows[0].status, 'pending')
  })
})
