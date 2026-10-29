import { Schema, model, Document, Types } from "mongoose";

export const ACCOUNT_DATA_GUARD_STATES = [
  "deleting",
  "deleted",
  "anonymizing",
  "anonymized",
] as const;

export type AccountDataGuardState = (typeof ACCOUNT_DATA_GUARD_STATES)[number];

/**
 * Tiny durable marker for destructive account maintenance. Support creation
 * checks it before and after persistence, so a request that raced a hard
 * delete/anonymization cannot leave fresh support PII or calendar reservations
 * behind. The marker is keyed by the user id (`_id`) and needs no extra index.
 */
export interface IAccountDataGuard extends Document {
  _id: Types.ObjectId;
  state: AccountDataGuardState;
  startedAt: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IAccountDataGuard>(
  {
    _id: { type: Schema.Types.ObjectId, ref: "User", required: true },
    state: { type: String, enum: ACCOUNT_DATA_GUARD_STATES, required: true },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date },
  },
  { timestamps: true, _id: false },
);

const AccountDataGuard = model<IAccountDataGuard>("AccountDataGuard", schema);
export default AccountDataGuard;
