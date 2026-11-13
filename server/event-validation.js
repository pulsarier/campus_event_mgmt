const allowedCategories = new Set(['Talks', 'Workshops', 'Sports', 'Exhibitions'])

export function validateEventInput(input, { requireDescription = false } = {}) {
  const {
    title,
    description = requireDescription ? undefined : '',
    category,
    starts_at: startsAt,
    ends_at: endsAt,
    registration_deadline: deadline,
    venue_id: venueId,
    capacity,
  } = input ?? {}
  const cleanTitle = typeof title === 'string' ? title.trim() : ''
  const cleanDescription = typeof description === 'string' ? description.trim() : null
  const startDate = new Date(startsAt)
  const endDate = new Date(endsAt)
  const deadlineDate = new Date(deadline)
  const numericVenueId = Number(venueId)
  const numericCapacity = Number(capacity)

  if (cleanTitle.length < 3 || cleanTitle.length > 180) return { error: 'Title must be between 3 and 180 characters' }
  if (cleanDescription === null || cleanDescription.length > 10000) return { error: 'Description must be 10000 characters or fewer' }
  if (!allowedCategories.has(category)) return { error: 'Invalid event category' }
  if (![startDate, endDate, deadlineDate].every((date) => Number.isFinite(date.getTime())) || endDate <= startDate || deadlineDate > startDate) {
    return { error: 'Provide valid event times and a registration deadline no later than the start time' }
  }
  if (!Number.isSafeInteger(numericVenueId) || numericVenueId < 1 || !Number.isSafeInteger(numericCapacity) || numericCapacity < 1) {
    return { error: 'Select a valid venue and positive event capacity' }
  }

  return {
    value: {
      title: cleanTitle,
      description: cleanDescription,
      category,
      starts_at: startDate.toISOString(),
      ends_at: endDate.toISOString(),
      registration_deadline: deadlineDate.toISOString(),
      venue_id: numericVenueId,
      capacity: numericCapacity,
    },
  }
}
