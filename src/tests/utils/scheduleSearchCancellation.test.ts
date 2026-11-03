import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

/**
 * Cooperative cancellation and the wall-clock budget of the real schedule
 * day search. Only the database reads are stand-ins (no team blocks, no
 * bookings; shared-calendar intervals per test), so the search itself runs
 * for real. `Date` is pinned for every test; timers and `performance.now()`
 * stay real.
 */

const db = vi.hoisted(() => ({
  busy: new Map<string, Array<{ start: Date; end: Date }>>(),
  project: null as any,
  professional: null as any,
}));

vi.mock("../../models/user", () => ({
  default: {
    find: () => ({ select: async () => [] }),
    findById: () => ({
      select: () => {
        const result: any = Promise.resolve(db.professional);
        result.lean = async () => db.professional;
        return result;
      },
    }),
  },
}));
vi.mock("../../models/booking", () => ({
  default: { find: () => ({ select: async () => [] }) },
}));
vi.mock("../../models/project", () => ({
  default: { findOne: async () => null, findById: () => ({ lean: async () => db.project }) },
}));
vi.mock("../../utils/support/calendarBusy", () => ({
  loadSharedCalendarBusy: async (ids: string[]) => ({
    byUser: new Map(ids.filter((id) => db.busy.has(id)).map((id) => [id, db.busy.get(id)!])),
    sources: [],
  }),
}));

import {
  ScheduleSearchAbortedError,
  buildProjectScheduleProposalsWithData,
} from "../../utils/scheduleEngine";
import { computeQuoteFirstPossibleStartBounded } from "../../utils/bookingDetails/quoteFirstStart";

const NOW = new Date("2026-11-03T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const resourceId = new Types.ObjectId().toHexString();

const project = () => ({ _id: new Types.ObjectId(), resources: [resourceId] });
const openProfessional = () => ({ _id: new Types.ObjectId(), businessInfo: { timezone: "Europe/Brussels" } });
// Every day of the 180-day horizon is company-blocked, so an uncancelled
// search visits all 181 days and ends on the no-slot fallback.
const fullyBlockedProfessional = () => ({
  ...openProfessional(),
  companyBlockedRanges: [{ startDate: new Date(NOW.getTime() - DAY_MS), endDate: new Date(NOW.getTime() + 400 * DAY_MS) }],
});
const daysOverride = {
  execution: { value: 2, unit: "days" as const },
  preparation: { value: 0, unit: "hours" as const },
  buffer: { value: 0, unit: "hours" as const },
};
const hoursOverride = {
  execution: { value: 3, unit: "hours" as const },
  preparation: { value: 0, unit: "hours" as const },
  buffer: { value: 0, unit: "hours" as const },
};

/** Signal wrapper that counts how often the engine checks it. */
const countingSignal = (isAborted: () => boolean) => {
  const state = { reads: 0 };
  const signal = {
    get aborted() {
      state.reads += 1;
      return isAborted();
    },
  };
  return { signal, state };
};

describe("schedule search cooperative cancellation", () => {
  beforeEach(() => {
    // Only Date is faked: setTimeout, setImmediate and performance.now() are real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    db.busy.clear();
    db.project = null;
    db.professional = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the same proposals with a live signal as without one", async () => {
    for (const override of [daysOverride, hoursOverride]) {
      const proj = project();
      const pro = openProfessional();
      const baseline = await buildProjectScheduleProposalsWithData(proj, pro, undefined, override, undefined, 1);
      const { signal, state } = countingSignal(() => false);
      const withSignal = await buildProjectScheduleProposalsWithData(proj, pro, undefined, override, undefined, 1, { signal });
      expect(baseline?.earliestProposal).toBeTruthy();
      expect(withSignal).toEqual(baseline);
      expect(state.reads).toBeGreaterThan(0);
    }
    // The no-slot fallback is unchanged too.
    const proj = project();
    const pro = fullyBlockedProfessional();
    const baseline = await buildProjectScheduleProposalsWithData(proj, pro, undefined, daysOverride);
    const { signal, state } = countingSignal(() => false);
    const withSignal = await buildProjectScheduleProposalsWithData(proj, pro, undefined, daysOverride, undefined, 1, { signal });
    expect(baseline?._debug?.usedFallback).toBe(true);
    expect(withSignal).toEqual(baseline);
    // Setup checks plus one per searched day: all 181 days were visited.
    expect(state.reads).toBeGreaterThanOrEqual(181);
    expect(state.reads).toBeLessThanOrEqual(181 + 3);
  });

  it("stops the day search at the next day once the signal is aborted", async () => {
    let abortAfter = 7;
    const { signal, state } = countingSignal(() => state.reads > abortAfter);
    await expect(
      buildProjectScheduleProposalsWithData(project(), fullyBlockedProfessional(), undefined, daysOverride, undefined, 1, { signal }),
    ).rejects.toBeInstanceOf(ScheduleSearchAbortedError);
    // The first aborted check ended the search: no further days were searched.
    expect(state.reads).toBe(abortAfter + 1);

    abortAfter = 0;
    state.reads = 0;
    await expect(
      buildProjectScheduleProposalsWithData(project(), fullyBlockedProfessional(), undefined, daysOverride, undefined, 1, { signal }),
    ).rejects.toBeInstanceOf(ScheduleSearchAbortedError);
    // Already aborted: nothing was loaded or searched.
    expect(state.reads).toBe(1);
  });

  it("lets a caller timer fire during the synchronous search and abort it", async () => {
    // The pinned clock stays in force (the 181-day window must stay inside
    // the fixed blocked range whatever today's real date is); only timers
    // are real.
    expect(Date.now()).toBe(NOW.getTime());
    const controller = new AbortController();
    const { signal, state } = countingSignal(() => controller.signal.aborted);
    const search = buildProjectScheduleProposalsWithData(
      project(), fullyBlockedProfessional(), undefined, daysOverride, undefined, 1, { signal },
    );
    let timerFiredAtRead = -1;
    setTimeout(() => {
      timerFiredAtRead = state.reads;
      controller.abort();
    }, 0);
    await expect(search).rejects.toBeInstanceOf(ScheduleSearchAbortedError);
    // The timer ran while days were still left to search, and the search
    // stopped at the next check instead of finishing in the background.
    expect(timerFiredAtRead).toBeGreaterThan(0);
    expect(timerFiredAtRead).toBeLessThan(181);
    expect(state.reads).toBe(timerFiredAtRead + 1);
    const readsAtAbort = state.reads;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.reads).toBe(readsAtAbort);
  });
  describe("multi-resource worst case within one day", () => {
    // 14 resources, minResources 7: C(14,7) = 3,432 subsets. Every member is
    // free on the first search day (so it passes the start-day check) and
    // busy for the next 2,000 days, so no subset can complete a 2-day
    // execution and each one scans the full 1,830-day overlap guard. All of
    // it is synchronous work inside the first searched day.
    const members = Array.from({ length: 14 }, () => new Types.ObjectId().toHexString());
    const blockedProject = () => ({
      _id: new Types.ObjectId(),
      professionalId: new Types.ObjectId(),
      resources: members,
      minResources: 7,
      minOverlapPercentage: 100,
    });
    const utcProfessional = () => ({ _id: new Types.ObjectId(), businessInfo: { timezone: "UTC" } });
    const blockAfterFirstDay = () => {
      const start = new Date("2026-11-04T00:00:00.000Z");
      const end = new Date(start.getTime() + 2000 * DAY_MS);
      for (const member of members) db.busy.set(member, [{ start, end }]);
    };

    it("stops at the wall-clock deadline inside the first day's subset search", async () => {
      blockAfterFirstDay();
      const started = performance.now();
      const error = await buildProjectScheduleProposalsWithData(
        blockedProject(), utcProfessional(), undefined, daysOverride, undefined, 1, { deadlineAt: started + 50 },
      ).then(() => null, (caught) => caught);
      const elapsed = performance.now() - started;
      expect(error).toBeInstanceOf(ScheduleSearchAbortedError);
      expect(error.reason).toBe("deadline");
      // Stopped inside day 0, i.e. inside the subset/overlap loops, not at a
      // later per-day check.
      expect(error.dayOffset).toBe(0);
      // Generous bound: the unbounded day takes many seconds of CPU.
      expect(elapsed).toBeLessThan(2000);
      expect(Date.now()).toBe(NOW.getTime());
    });

    it("bounds the quote first-start call even though its timer cannot fire during the day", async () => {
      blockAfterFirstDay();
      db.project = blockedProject();
      db.professional = utcProfessional();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const booking = { _id: new Types.ObjectId(), project: String(db.project._id) };
      const durations = { executionDuration: { value: 2, unit: "days" } };
      const started = performance.now();
      await expect(computeQuoteFirstPossibleStartBounded(booking, durations, 50)).resolves.toBeNull();
      const elapsed = performance.now() - started;
      // The race's timer can only run once the synchronous day work ends, so
      // returning this early means the engine itself stopped at the
      // forwarded deadline.
      expect(elapsed).toBeLessThan(2000);
      // A deadline stop is not logged as a failure.
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("returns identical multi-resource proposals with and without a generous budget", async () => {
      const team = members.slice(0, 4);
      // Partial personal blocks so subset selection and overlap matter.
      db.busy.set(team[0], [{ start: new Date("2026-11-04T00:00:00.000Z"), end: new Date("2026-11-10T00:00:00.000Z") }]);
      db.busy.set(team[1], [{ start: new Date("2026-11-03T00:00:00.000Z"), end: new Date("2026-11-06T00:00:00.000Z") }]);
      for (const [override, minOverlapPercentage] of [[daysOverride, 100], [daysOverride, 50], [hoursOverride, 100]] as const) {
        const proj = { ...blockedProject(), resources: team, minResources: 2, minOverlapPercentage };
        const pro = utcProfessional();
        const baseline = await buildProjectScheduleProposalsWithData(proj, pro, undefined, override, undefined, 1);
        const withBudget = await buildProjectScheduleProposalsWithData(
          proj, pro, undefined, override, undefined, 1, { deadlineAt: performance.now() + 60_000 },
        );
        expect(baseline?.earliestProposal).toBeTruthy();
        expect(withBudget).toEqual(baseline);
      }
    });
  });
});
