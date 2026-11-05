import mongoose from 'mongoose';
import User from '../models/user';
import Project from '../models/project';
import { getProfessionalId } from './bookingHelpers';
import { buildPerResourceBlockedDays, getResourcePolicy, resolveEffectiveScheduleTimeZone } from './scheduleEngine';
import { computeMinExecutionResourceDays, planKeyToDate, rebuildResourcePlanForNewStart,
  resolveDayModeExecutionDays, toPlanDayKeyInTimeZone } from './reschedulePlanning';

/**
 * Client bug list #9b (day-mode only): a rescheduled start date overrules
 * earlier manual planning. All planned dates before the new start date become
 * unplanned for every resource, planning on/after the new start is kept, and
 * when the kept plan is shorter than the minimum execution duration
 * (executionTime + executionTime * (resourceCount - 1) * overlapFraction),
 * days are added across the assigned resources so the booking duration stays
 * as short as possible. The professional can still adjust planning afterwards.
 * Hour-mode bookings are left untouched (owned by another workstream).
 */
export const applyReschedulePlanReset = async (booking: any, updatedBy: unknown) => {
  const newStart = booking.scheduledStartDate ? new Date(booking.scheduledStartDate) : null;
  if (!newStart || Number.isNaN(newStart.getTime())) return;

  // Resolve the professional (and timezone) before deriving the plan day key:
  // scheduledStartDate is stored as a real local-midnight instant, so the key
  // must be derived in the professional's timezone — a plain UTC key points at
  // the previous calendar day for UTC+ timezones.
  const professionalRef = await getProfessionalId(booking);
  const professionalId = professionalRef?._id || professionalRef;
  const professional = professionalId
    ? await User.findById(professionalId).select(
      'companyAvailability availability companyBlockedDates companyBlockedRanges businessInfo'
    )
    : null;
  const timeZone = resolveEffectiveScheduleTimeZone((professional as any) || undefined);
  const newStartKey = toPlanDayKeyInTimeZone(newStart, timeZone);
  if (!newStartKey) return;

  const projectId = (booking.project as any)?._id?.toString?.() || String(booking.project || '');
  const projectDoc = projectId && mongoose.isValidObjectId(projectId)
    ? await Project.findById(projectId).select('executionDuration subprojects minResources minOverlapPercentage resources')
    : null;

  const executionDays = resolveDayModeExecutionDays({
    scheduleSnapshot: booking.scheduleSnapshot,
    project: projectDoc,
    selectedSubprojectIndex: booking.selectedSubprojectIndex,
  });
  if (executionDays == null) return;

  const assignedIds = (Array.isArray(booking.assignedTeamMembers) ? booking.assignedTeamMembers : [])
    .map((member: any) => (member?._id || member)?.toString?.())
    .filter((id: unknown): id is string => typeof id === 'string' && mongoose.isValidObjectId(id));

  const policy = projectDoc
    ? getResourcePolicy(projectDoc)
    : { minResources: 1, minOverlapPercentage: 90, totalResources: assignedIds.length };
  const minResourceDays = computeMinExecutionResourceDays({
    executionDays,
    resourceCount: Math.max(1, assignedIds.length),
    overlapFraction: policy.minOverlapPercentage / 100,
  });

  let blockedByResource: Map<string, Set<string>> | undefined;
  try {
    if (professional && assignedIds.length > 0) {
      const windowFromReal = new Date(newStart);
      const windowToReal = new Date(newStart.getTime() + (minResourceDays + 60) * 24 * 60 * 60 * 1000);
      blockedByResource = await buildPerResourceBlockedDays(
        (projectDoc || { _id: projectId }) as any,
        professional,
        assignedIds,
        windowFromReal,
        windowToReal,
        timeZone,
        String(booking._id),
        booking.customerBlocks
      );
    }
  } catch (blockedError: any) {
    console.error('Failed to load blocked days for reschedule plan reset:', blockedError?.message || blockedError);
  }

  const currentPlan = (Array.isArray(booking.resourcePlan) ? booking.resourcePlan : []).map((entry: any) => ({
    resourceId: ((entry?.resourceId?._id || entry?.resourceId)?.toString?.()) || '',
    days: Array.isArray(entry?.days) ? entry.days : [],
  }));

  const rebuilt = rebuildResourcePlanForNewStart({
    resourcePlan: currentPlan,
    newStartKey,
    assignedResourceIds: assignedIds,
    blockedByResource,
    minResourceDays,
    executionDays,
    minResourcesPerDay: policy.minResources,
  });

  if (rebuilt.removedDays === 0 && rebuilt.addedDays.length === 0) return;

  booking.resourcePlan = rebuilt.resourcePlan
    .filter((entry) => mongoose.isValidObjectId(entry.resourceId))
    .map((entry) => ({
      resourceId: new mongoose.Types.ObjectId(entry.resourceId),
      days: entry.days
        .map((key) => planKeyToDate(key))
        .filter((date): date is Date => date instanceof Date),
    }));

  if (rebuilt.maxDayKey) {
    const maxPlanned = planKeyToDate(rebuilt.maxDayKey);
    const currentEnd = booking.scheduledExecutionEndDate ? new Date(booking.scheduledExecutionEndDate) : null;
    if (maxPlanned && (!currentEnd || Number.isNaN(currentEnd.getTime()) || maxPlanned > currentEnd)) {
      booking.scheduledExecutionEndDate = maxPlanned;
      const bufferStart = booking.scheduledBufferStartDate ? new Date(booking.scheduledBufferStartDate) : null;
      if (bufferStart && !Number.isNaN(bufferStart.getTime()) && maxPlanned >= bufferStart) {
        // Keep the execution <= buffer invariant (mirrors manual planning,
        // which clears the buffer when the plan changes).
        booking.scheduledBufferStartDate = undefined;
        booking.scheduledBufferEndDate = undefined;
        booking.scheduledBufferUnit = undefined;
      }
    }
  }

  booking.statusHistory = booking.statusHistory || [];
  booking.statusHistory.push(
    { status: 'booked', timestamp: new Date(), updatedBy,
      note: `Planning updated: rescheduled start ${newStartKey} overrules earlier planning (${rebuilt.keptDays} day(s) kept, ${rebuilt.addedDays.length} added)` }
  );
};

