import { Request, Response } from "express";
import mongoose from "mongoose";
import Booking from "../../models/booking";
import Payment from "../../models/payment";
import CancellationRequest from "../../models/cancellationRequest";

export const getAdminBookingDetail = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }

    const booking = await Booking.findById(id)
      .populate("customer", "name email phone role")
      .populate("professional", "name email username role")
      .populate("project", "title category service")
      .populate("rescheduleHistory.requestedBy", "name email")
      .populate("rescheduleHistory.respondedBy", "name email")
      .populate("dispute.raisedBy", "name email")
      .populate("dispute.resolvedBy", "name email")
      .lean();

    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    const [payment, cancellationRequests] = await Promise.all([
      Payment.findOne({ booking: id })
        .populate("customer", "name email")
        .populate("professional", "name email")
        .lean(),
      CancellationRequest.find({ booking: id })
        .sort({ createdAt: -1 })
        .populate("requestedBy", "name email")
        .populate("resolvedBy", "name email")
        .lean(),
    ]);

    return res.json({
      success: true,
      data: {
        booking,
        payment,
        cancellationRequests,
      },
    });
  } catch (error: any) {
    console.error("Admin booking detail error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load booking detail" });
  }
};
