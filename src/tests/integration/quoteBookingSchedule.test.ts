import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = testUri && /test/i.test(testUri) ? describe : describe.skip;
vi.mock('../../utils/notifications/notify', () => ({ notify: vi.fn() }));

import Booking from '../../models/booking';
import CalendarReservation from '../../models/calendarReservation';
import { buildScheduleUpdatePayload, setBookingSchedule } from '../../handlers/Booking/payment-integration';
import { buildMilestoneChargePlan } from '../../utils/milestoneCharges';
import { getBookingScheduleOptions, getQuoteScheduleDurationOverride } from '../../utils/scheduleEngine';
import { reserveBookingCalendar } from '../../utils/support/bookingCalendar';

// FT3-19y: Q1 on staging — RFQ package, quotation with 2 days preparation and
// 3 days execution; after the deposit the booking had no execution end, no
// time zone and blocked nothing in the professional's calendar.
describeDb('quote bookings are scheduled with the accepted quotation durations', () => {
  const professional = new Types.ObjectId();
  const customer = new Types.ObjectId();
  const project = new Types.ObjectId();
  const bookingId = new Types.ObjectId();
  const optionId = new Types.ObjectId();

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T09:00:00Z'));
    await mongoose.connect(testUri!, { dbName: `quote_schedule_${process.pid}_${Date.now().toString(36)}`, autoCreate: false, autoIndex: false });
    const availability = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map(key => [key, { available: true, startTime: '08:00', endTime: '17:00' }]));
    await mongoose.connection.collection('users').insertMany([
      { _id: professional, name: 'Quote Pro', email: 'quote-pro@test.example', role: 'professional', professionalStatus: 'approved', businessInfo: { timezone: 'Europe/Brussels' }, companyAvailability: availability },
      { _id: customer, name: 'Quote Customer', email: 'quote-customer@test.example', role: 'customer' },
    ]);
    await mongoose.connection.collection('projects').insertOne({
      _id: project, professionalId: professional, title: 'Kitchen RFQ', status: 'published', resources: [String(professional)], timeMode: 'days',
      subprojects: [{ name: 'Kitchen', pricing: { type: 'rfq' }, executionDuration: { range: { min: 1, max: 10 }, unit: 'days' } }],
      extraOptions: [{ _id: optionId, name: 'Integrated Lighting', price: 450 }],
    });
    await mongoose.connection.collection('bookings').insertOne({
      _id: bookingId, bookingNumber: 'QS-1', customer, professional, project, bookingType: 'project', status: 'quote_accepted', selectedSubprojectIndex: 0,
      rfqData: { serviceType: 'Kitchen', description: 'Quote' }, assignedTeamMembers: [professional],
      currentQuoteVersion: 1, acceptedQuoteVersion: 1,
      location: { type: 'Point', coordinates: [4.37, 50.85], country: 'BE' },
      vatDecision: { action: 'standard_rate', country: 'BE', standardRate: 21, appliedRate: 21 },
      quoteVersions: [{ version: 1, quotationNumber: 'QT-2027-000001-v1', scope: 'Kitchen renovation works', description: 'Kitchen renovation with new cabinets',
        warrantyDuration: { value: 12, unit: 'months' }, validUntil: new Date('2027-02-01T00:00:00Z'), createdAt: new Date('2027-01-01T00:00:00Z'),
        totalAmount: 8000, currency: 'EUR', preparationDuration: { value: 2, unit: 'days' }, executionDuration: { value: 3, unit: 'days' } }],
      quote: { amount: 8000, currency: 'EUR' },
      milestonePayments: [
        { title: 'Deposit', amount: 3000, order: 0, status: 'pending', dueCondition: 'on_start' },
        { title: 'Cabinets installed', amount: 5000, order: 1, status: 'pending', dueCondition: 'on_milestone_completion' },
      ],
      statusHistory: [],
    });
    await CalendarReservation.createCollection();
    await CalendarReservation.createIndexes();
  });
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); vi.useRealTimers(); });

  it('uses the quotation durations as the schedule override', async () => {
    const booking = await Booking.findById(bookingId).lean();
    expect(getQuoteScheduleDurationOverride(booking)).toEqual({
      execution: { value: 3, unit: 'days' }, preparation: { value: 2, unit: 'days' }, buffer: { value: 0, unit: 'hours' },
    });
    expect(getBookingScheduleOptions(booking).durationOverride?.execution).toEqual({ value: 3, unit: 'days' });
    expect(getQuoteScheduleDurationOverride({ quoteVersions: [{ version: 1 }], currentQuoteVersion: 1 })).toBeUndefined();
  });

  it('plans an execution end, time zone and resource plan, and reserves the calendar', async () => {
    const booking = await Booking.findById(bookingId);
    const update = await buildScheduleUpdatePayload({ booking, scheduledStartDate: '2027-01-11' });
    expect(update.success).toBe(true);
    const data = (update as any).data;
    expect(data.scheduledExecutionEndDate).toBeInstanceOf(Date);
    expect(data.scheduleTimeZone).toBe('Europe/Brussels');
    // Mon 11 Jan (Brussels midnight) → three working days, ending Wed 13 Jan.
    expect(new Date(data.scheduledStartDate).toISOString()).toBe('2027-01-10T23:00:00.000Z');
    expect(new Date(data.scheduledExecutionEndDate).toISOString().slice(0, 10)).toBe('2027-01-13');
    const candidate = { _id: bookingId, professional, assignedTeamMembers: [professional], ...data };
    await reserveBookingCalendar(candidate as any);
    expect(await CalendarReservation.countDocuments({ sourceType: 'booking', sourceId: bookingId })).toBeGreaterThan(0);
  });

  // FT3-19b: options on a quote booking are charged in full with the first milestone.
  it('lets the customer add project options to an accepted quotation before the first milestone is paid', async () => {
    const res: any = { statusCode: 200, body: undefined, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
    await setBookingSchedule({ user: { _id: customer }, params: { bookingId: String(bookingId) },
      body: { scheduledStartDate: '2027-01-18', selectedExtraOptions: [0] } } as any, res);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const stored: any = await Booking.findById(bookingId).lean();
    expect(stored.selectedExtraOptions).toEqual([expect.objectContaining({ extraOptionId: String(optionId), bookedPrice: 450 })]);
    const plan = buildMilestoneChargePlan(stored, 0);
    expect(plan.map((entry) => entry.expectedCustomerGross)).toEqual([3450, 5000]);
    expect(plan[0].includesSelectedOptions).toBe(true);
  });

  it('keeps the options locked once a milestone is paid', async () => {
    await Booking.updateOne({ _id: bookingId }, { $set: { 'milestonePayments.0.status': 'paid' } });
    const res: any = { statusCode: 200, body: undefined, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
    await setBookingSchedule({ user: { _id: customer }, params: { bookingId: String(bookingId) },
      body: { scheduledStartDate: '2027-01-18', selectedExtraOptions: [] } } as any, res);
    expect(res.statusCode).toBe(409);
  });
});
