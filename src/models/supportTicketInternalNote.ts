import { Schema, model, Document, Types } from "mongoose";

/**
 * Private admin notes live in a separate collection on purpose: they can never
 * be returned accidentally by a user ticket serializer, data export or email.
 */
export interface ISupportTicketInternalNote extends Document {
  _id: Types.ObjectId;
  ticketId: Types.ObjectId;
  adminId: Types.ObjectId;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

const supportTicketInternalNoteSchema = new Schema<ISupportTicketInternalNote>(
  {
    ticketId: { type: Schema.Types.ObjectId, ref: "SupportTicket", required: true, index: true },
    adminId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
  },
  { timestamps: true },
);

supportTicketInternalNoteSchema.index({ ticketId: 1, createdAt: 1 });

const SupportTicketInternalNote = model<ISupportTicketInternalNote>(
  "SupportTicketInternalNote",
  supportTicketInternalNoteSchema,
);
export default SupportTicketInternalNote;
