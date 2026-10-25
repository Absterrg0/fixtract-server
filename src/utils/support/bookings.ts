import mongoose, { Types } from "mongoose";
import Booking from "../../models/booking";
import Project from "../../models/project";
import type { IUser } from "../../models/user";
import { UserFacingError } from "../appErrors";

type PopulatedUser = {
  _id?: Types.ObjectId | string;
  name?: string;
  username?: string;
  businessInfo?: { companyName?: string };
};

type PopulatedProject = {
  _id?: Types.ObjectId | string;
  title?: string;
};

export type SupportBookingOption = {
  bookingId: string;
  bookingNumber: string;
  projectTitle: string;
  counterpartyName: string;
  label: string;
};

type BookingLike = {
  _id: Types.ObjectId | string;
  bookingNumber?: string;
  customer?: PopulatedUser | Types.ObjectId | string | null;
  professional?: PopulatedUser | Types.ObjectId | string | null;
  project?: PopulatedProject | Types.ObjectId | string | null;
  rfqData?: { serviceType?: string };
};

const idString = (value: unknown): string => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (typeof value === "object" && "_id" in (value as Record<string, unknown>)) {
    return idString((value as { _id?: unknown })._id);
  }
  return String(value);
};

export function professionalDisplayName(user: PopulatedUser | null | undefined): string {
  const company = user?.businessInfo?.companyName?.trim();
  if (company) return company;
  const name = user?.name?.trim();
  if (name) return name;
  const username = user?.username?.trim();
  if (username) return username;
  return "Professional";
}

export function customerDisplayName(user: PopulatedUser | null | undefined): string {
  return user?.name?.trim() || "Customer";
}

export function supportProjectTitle(booking: BookingLike): string {
  const title = (booking.project as PopulatedProject | undefined)?.title?.trim();
  if (title) return title;
  const serviceType = booking.rfqData?.serviceType?.trim();
  if (serviceType) return serviceType;
  return "Booking";
}

/**
 * Ownership is based on actual booking participation, not only the account's
 * current role: a user whose role changed still sees bookings they are part of.
 * Customers never match another user's rows.
 */
export async function buildSupportBookingOwnershipFilter(
  userId: Types.ObjectId | string,
): Promise<Record<string, unknown>> {
  const ownedProjects = await Project.find({ professionalId: userId }).select("_id").lean();
  const projectIds = ownedProjects.map((project) => project._id);
  return {
    $or: [
      { customer: userId },
      { professional: userId },
      ...(projectIds.length > 0 ? [{ project: { $in: projectIds } }] : []),
    ],
  };
}

export function buildSupportBookingSnapshot(
  booking: BookingLike,
  requesterId: Types.ObjectId | string,
): SupportBookingOption {
  const requester = requesterId.toString();
  const isCustomerParticipant = idString(booking.customer) === requester;
  const counterpartyName = isCustomerParticipant
    ? professionalDisplayName(booking.professional as PopulatedUser | null)
    : customerDisplayName(booking.customer as PopulatedUser | null);
  const projectTitle = supportProjectTitle(booking);
  const bookingNumber = booking.bookingNumber?.trim() || String(booking._id);
  const label = `${bookingNumber} - ${projectTitle} - ${counterpartyName}`;
  return {
    bookingId: String(booking._id),
    bookingNumber: bookingNumber.slice(0, 100),
    projectTitle: projectTitle.slice(0, 300),
    counterpartyName: counterpartyName.slice(0, 300),
    label: label.slice(0, 700),
  };
}

function bookingPopulate() {
  return [
    { path: "customer", select: "name username businessInfo" },
    { path: "professional", select: "name username businessInfo" },
    { path: "project", select: "title" },
  ];
}

export async function listSupportBookingOptions(
  userId: Types.ObjectId | string,
): Promise<SupportBookingOption[]> {
  const filter = await buildSupportBookingOwnershipFilter(userId);
  const bookings = await Booking.find(filter)
    .populate(bookingPopulate())
    .sort({ createdAt: -1 })
    .lean();
  return (bookings as unknown as BookingLike[]).map((booking) =>
    buildSupportBookingSnapshot(booking, userId),
  );
}

export async function resolveSupportBooking(
  bookingId: string,
  userId: Types.ObjectId | string,
): Promise<SupportBookingOption> {
  if (!mongoose.Types.ObjectId.isValid(bookingId)) {
    throw new UserFacingError(404, "Booking not found.", "NOT_FOUND");
  }
  const filter = await buildSupportBookingOwnershipFilter(userId);
  const booking = await Booking.findOne({ _id: bookingId, ...filter })
    .populate(bookingPopulate())
    .lean();
  if (!booking) {
    throw new UserFacingError(404, "Booking not found.", "NOT_FOUND");
  }
  return buildSupportBookingSnapshot(booking as unknown as BookingLike, userId);
}

export function supportUserTypeForRole(role: IUser["role"] | undefined): "customer" | "professional" {
  return role === "professional" ? "professional" : "customer";
}
