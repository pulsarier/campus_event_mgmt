import assert from 'node:assert/strict'
import test from 'node:test'
import { validateEventInput } from '../server/event-validation.js'

const validInput = {
  title: '  Campus Research Forum  ',
  description: '  Student research presentations  ',
  category: 'Talks',
  starts_at: '2027-03-10T10:00:00-05:00',
  ends_at: '2027-03-10T12:00:00-05:00',
  registration_deadline: '2027-03-09T10:00:00-05:00',
  venue_id: '12',
  capacity: '180',
}

test('normalizes valid event details for persistence', () => {
  const result = validateEventInput(validInput)

  assert.equal(result.error, undefined)
  assert.deepEqual(result.value, {
    title: 'Campus Research Forum',
    description: 'Student research presentations',
    category: 'Talks',
    starts_at: '2027-03-10T15:00:00.000Z',
    ends_at: '2027-03-10T17:00:00.000Z',
    registration_deadline: '2027-03-09T15:00:00.000Z',
    venue_id: 12,
    capacity: 180,
  })
})

test('accepts each supported event category', () => {
  for (const category of ['Talks', 'Workshops', 'Sports', 'Exhibitions']) {
    assert.equal(validateEventInput({ ...validInput, category }).value.category, category)
  }
})

test('defaults an omitted description to an empty string', () => {
  const { description: _description, ...input } = validInput
  assert.equal(validateEventInput(input).value.description, '')
  assert.equal(validateEventInput(input, { requireDescription: true }).error, 'Description must be 10000 characters or fewer')
})

test('rejects invalid titles and descriptions', () => {
  const cases = [
    [{ title: '  ' }, 'Title must be between 3 and 180 characters'],
    [{ title: 'x'.repeat(181) }, 'Title must be between 3 and 180 characters'],
    [{ description: null }, 'Description must be 10000 characters or fewer'],
    [{ description: 'x'.repeat(10001) }, 'Description must be 10000 characters or fewer'],
  ]

  for (const [overrides, error] of cases) {
    assert.equal(validateEventInput({ ...validInput, ...overrides }).error, error)
  }
})

test('rejects unsupported categories and malformed dates', () => {
  assert.equal(validateEventInput({ ...validInput, category: 'Hackathon' }).error, 'Invalid event category')
  assert.equal(
    validateEventInput({ ...validInput, starts_at: 'not-a-date' }).error,
    'Provide valid event times and a registration deadline no later than the start time',
  )
})

test('requires a positive event duration and deadline no later than the start', () => {
  assert.equal(
    validateEventInput({ ...validInput, ends_at: validInput.starts_at }).error,
    'Provide valid event times and a registration deadline no later than the start time',
  )
  assert.equal(
    validateEventInput({ ...validInput, registration_deadline: '2027-03-11T10:00:00-05:00' }).error,
    'Provide valid event times and a registration deadline no later than the start time',
  )
})

test('requires positive safe-integer venue IDs and capacities', () => {
  const cases = [
    [{ venue_id: 0 }, 'Select a valid venue and positive event capacity'],
    [{ venue_id: Number.MAX_SAFE_INTEGER + 1 }, 'Select a valid venue and positive event capacity'],
    [{ capacity: 0 }, 'Select a valid venue and positive event capacity'],
    [{ capacity: 1.5 }, 'Select a valid venue and positive event capacity'],
  ]

  for (const [overrides, error] of cases) {
    assert.equal(validateEventInput({ ...validInput, ...overrides }).error, error)
  }
})

test('rejects a missing event body', () => {
  assert.equal(validateEventInput().error, 'Title must be between 3 and 180 characters')
})
