import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

/**
 * Cooperative cancellation of the real schedule day search. Only the
 * database reads are stand-ins (no team blocks, no bookings, no shared
 * calendar), so the 181-day search itself runs for real.
 */

vi.mock("../../models/user", () => ({
  default: { find: () => ({ select: async () => [] }), findById: () => ({ select: async () => null }) },
}));
vi.mock("../../models/booking", () => ({
  default: { find: () => ({ select: async () => [] }) },
}));
vi.mock("../../models/project", () => ({ default: { findOne: async () => null } }));
vi.mock("../../utils/support/calendarBusy", () => ({
  loadSharedCalendarBusy: async () => ({ byUser: new Map(), sources: [] }),
}));

import {
  ScheduleSearchAbortedError,
  buildProjectScheduleProposalsWithData,
} from "../../utils/scheduleEngine";

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
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
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
    vi.useRealTimers();
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
});
