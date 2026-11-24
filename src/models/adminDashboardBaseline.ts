import mongoose, { Model, Schema } from 'mongoose';

/**
 * Per-dashboard "counting since" baseline for admin dashboards and counters.
 *
 * Resetting a dashboard never deletes or edits source records. It only moves
 * `resetAt` forward: the dashboard's counter then counts only work that became
 * actionable since that instant (src/utils/adminWorkCounters.ts), and booking
 * dashboards hide finished history from before it (src/utils/adminDashboardBaselines.ts).
 *
 * `AdminDashboardBaseline` holds the current value per dashboard (one document
 * per key). `AdminDashboardBaselineEvent` is the append-only history of resets
 * and undos.
 */

export const ADMIN_DASHBOARD_BASELINE_IDS = Object.freeze({
  disputes: 'disputes',
  cancellations: 'cancellations',
  supportTickets: 'supportTickets',
  chatReports: 'chatReports',
  reviewModeration: 'reviewModeration',
  bookingKpis: 'bookingKpis',
} as const);

export type AdminDashboardBaselineKey = keyof typeof ADMIN_DASHBOARD_BASELINE_IDS;

/**
 * Dashboards that could be reset before and no longer can. Their old history
 * events stay valid and listed. `warrantyClaims` had no counter of its own:
 * escalated warranty claims are counted (and reset) under `disputes`.
 */
export const RETIRED_DASHBOARD_BASELINE_KEYS = Object.freeze(['warrantyClaims'] as const);

export interface IAdminDashboardBaseline {
  _id: string;
  resetAt: Date | null;
  resetBy: mongoose.Types.ObjectId | null;
  resetByName: string;
  note: string;
  /** Value before the latest reset; restored by undo. */
  previousResetAt: Date | null;
  updatedAt: Date;
}

const baselineSchema = new Schema<IAdminDashboardBaseline>(
  {
    _id: { type: String, required: true },
    resetAt: { type: Date, default: null },
    resetBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resetByName: { type: String, default: '', maxlength: 200 },
    note: { type: String, default: '', maxlength: 500 },
    previousResetAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'admin_dashboard_baselines' },
);

export interface IAdminDashboardBaselineEvent {
  dashboardKey: string;
  action: 'reset' | 'undo';
  /** Baseline value after this event (null after an undo to "no baseline"). */
  resetAt: Date | null;
  /** Baseline value before this event. */
  previousResetAt: Date | null;
  actor: mongoose.Types.ObjectId | null;
  actorName: string;
  note: string;
  /** Shared by the dashboards of one "Reset all" request. */
  batchId: string | null;
  createdAt: Date;
}

const baselineEventSchema = new Schema<IAdminDashboardBaselineEvent>(
  {
    dashboardKey: {
      type: String,
      required: true,
      enum: [...Object.keys(ADMIN_DASHBOARD_BASELINE_IDS), ...RETIRED_DASHBOARD_BASELINE_KEYS],
    },
    action: { type: String, required: true, enum: ['reset', 'undo'] },
    resetAt: { type: Date, default: null },
    previousResetAt: { type: Date, default: null },
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: '', maxlength: 200 },
    note: { type: String, default: '', maxlength: 500 },
    batchId: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'admin_dashboard_baseline_events' },
);
baselineEventSchema.index({ dashboardKey: 1, createdAt: -1 });
baselineEventSchema.index({ createdAt: -1 });

export const AdminDashboardBaseline: Model<IAdminDashboardBaseline> =
  mongoose.models.AdminDashboardBaseline as Model<IAdminDashboardBaseline>
  || mongoose.model<IAdminDashboardBaseline>('AdminDashboardBaseline', baselineSchema);

export const AdminDashboardBaselineEvent: Model<IAdminDashboardBaselineEvent> =
  mongoose.models.AdminDashboardBaselineEvent as Model<IAdminDashboardBaselineEvent>
  || mongoose.model<IAdminDashboardBaselineEvent>('AdminDashboardBaselineEvent', baselineEventSchema);

export default AdminDashboardBaseline;
