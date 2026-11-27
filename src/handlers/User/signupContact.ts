import { Request, Response } from "express";
import twilio from "twilio";
import { PhoneNumberUtil, PhoneNumberFormat } from "google-libphonenumber";
import User from "../../models/user";
import connecToDatabase from "../../config/db";
import { generateOTP, sendOTPEmail } from "../../utils/emailService";
import { sendHandlerError } from "../../utils/handlerErrors";
import { withAnonymizationWriteFence } from "../../utils/support/accountGuard";

const phoneUtil = PhoneNumberUtil.getInstance();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
/** Minimum wait between two email changes, so the endpoint can't be used to mail arbitrary addresses in a loop. */
export const SIGNUP_EMAIL_CHANGE_COOLDOWN_MS = 60 * 1000;

const SIGNUP_CONTACT_ROLES = new Set(["customer", "professional"]);

/** E.164 for a "+<country><number>" signup phone, or null when invalid. */
export function normalizeSignupPhone(raw: string): string | null {
  const phone = raw.trim();
  if (!phone.startsWith("+")) return null;
  try {
    const parsed = phoneUtil.parseAndKeepRawInput(phone, "");
    if (!phoneUtil.isValidNumber(parsed)) return null;
    return phoneUtil.format(parsed, PhoneNumberFormat.E164);
  } catch {
    return null;
  }
}

/**
 * FT2-6C: the "back" step of signup verification. The account already exists
 * when the email/phone OTP page shows (signup creates it and signs the user
 * in), so resubmitting the signup form failed with "email already exists" or
 * left a second account behind. This lets the signed-in, not yet verified
 * user correct the email and/or phone of THEIR OWN account: a changed channel
 * becomes unverified again and gets a fresh code. A channel that is already
 * verified cannot be changed here (profile settings own that).
 */
export const updateSignupContact = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const rawEmail = typeof req.body?.email === "string" ? req.body.email : undefined;
    const rawPhone = typeof req.body?.phone === "string" ? req.body.phone : undefined;
    if (rawEmail === undefined && rawPhone === undefined) {
      return res.status(400).json({ success: false, msg: "Please provide an email address or phone number to update" });
    }

    await connecToDatabase();
    // verificationCodeExpires is select:false on the schema; the cooldown and the
    // conditional write below both need the stored value.
    const user = await User.findById(userId).select("+verificationCodeExpires");
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }
    if (!SIGNUP_CONTACT_ROLES.has(user.role)) {
      return res.status(403).json({ success: false, msg: "Contact details can only be changed here during signup" });
    }
    if (user.isEmailVerified && user.isPhoneVerified) {
      return res.status(409).json({ success: false, msg: "Your account is already verified. Change your contact details in your profile." });
    }

    let emailChanged = false;
    let phoneChanged = false;
    let emailOtp: string | null = null;
    // The write is conditional on what was read: a channel verified (or
    // changed) by a concurrent request since then makes it miss instead of
    // carrying a stale verification flag over to the new address.
    const filter: Record<string, unknown> = { _id: user._id };
    const set: Record<string, unknown> = {};

    if (rawEmail !== undefined) {
      const email = rawEmail.toLowerCase().trim();
      if (!EMAIL_RE.test(email)) {
        return res.status(400).json({ success: false, msg: "Please provide a valid email address" });
      }
      if (email !== user.email) {
        if (user.isEmailVerified) {
          return res.status(409).json({ success: false, msg: "Your email address is already verified. Change it in your profile." });
        }
        const lastIssuedAt = user.verificationCodeExpires
          ? new Date(user.verificationCodeExpires).getTime() - EMAIL_OTP_TTL_MS
          : 0;
        if (Date.now() - lastIssuedAt < SIGNUP_EMAIL_CHANGE_COOLDOWN_MS) {
          return res.status(429).json({ success: false, msg: "Please wait a minute before changing your email address again" });
        }
        const taken = await User.findOne({ email, _id: { $ne: user._id } }).select("_id").lean();
        if (taken) {
          return res.status(409).json({ success: false, msg: "An account with this email already exists" });
        }
        emailOtp = generateOTP();
        filter.email = user.email;
        filter.isEmailVerified = false;
        filter.verificationCodeExpires = user.verificationCodeExpires ?? null;
        set.email = email;
        set.isEmailVerified = false;
        set.verificationCode = emailOtp;
        set.verificationCodeExpires = new Date(Date.now() + EMAIL_OTP_TTL_MS);
        emailChanged = true;
      }
    }

    if (rawPhone !== undefined) {
      const phone = normalizeSignupPhone(rawPhone);
      if (!phone) {
        return res.status(400).json({ success: false, msg: "Invalid phone number. Please include your country code (e.g. +1 for US, +31 for NL)." });
      }
      if (phone !== user.phone) {
        if (user.isPhoneVerified) {
          return res.status(409).json({ success: false, msg: "Your phone number is already verified. Change it in your profile." });
        }
        filter.phone = user.phone ?? null;
        filter.isPhoneVerified = false;
        set.phone = phone;
        set.isPhoneVerified = false;
        phoneChanged = true;
      }
    }

    let current = {
      email: user.email,
      phone: user.phone,
      isEmailVerified: user.isEmailVerified,
      isPhoneVerified: user.isPhoneVerified,
    };
    if (emailChanged || phoneChanged) {
      const updated = await withAnonymizationWriteFence([String(user._id)], async (session) =>
        User.findOneAndUpdate(filter, { $set: set }, {
          new: true,
          projection: "email phone isEmailVerified isPhoneVerified",
          ...(session ? { session } : {}),
        }).lean(),
      );
      if (!updated) {
        return res.status(409).json({ success: false, msg: "Your contact details changed meanwhile. Please reload and try again." });
      }
      current = {
        email: updated.email,
        phone: updated.phone,
        isEmailVerified: updated.isEmailVerified,
        isPhoneVerified: updated.isPhoneVerified,
      };
    }

    let emailOtpSent = false;
    if (emailChanged && emailOtp) {
      try {
        emailOtpSent = await sendOTPEmail(current.email, emailOtp, user.name);
      } catch (error) {
        console.error("Error sending email OTP after signup contact change:", error);
      }
    }

    let phoneOtpSent = false;
    if (phoneChanged) {
      try {
        const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID } = process.env;
        if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_VERIFY_SERVICE_SID) {
          await twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
            .verify.v2.services(TWILIO_VERIFY_SERVICE_SID)
            .verifications.create({ channel: "sms", to: current.phone as string });
          phoneOtpSent = true;
        }
      } catch (error) {
        console.error("Error sending phone OTP after signup contact change:", error);
      }
    }

    return res.status(200).json({
      success: true,
      msg: "Contact details updated",
      data: {
        email: current.email,
        phone: current.phone,
        isEmailVerified: Boolean(current.isEmailVerified),
        isPhoneVerified: Boolean(current.isPhoneVerified),
        emailChanged,
        phoneChanged,
        emailOtpSent,
        phoneOtpSent,
      },
    });
  } catch (error) {
    console.error("Update signup contact error:", error);
    return sendHandlerError(res, error, "We couldn't update your contact details. Please try again.");
  }
};
