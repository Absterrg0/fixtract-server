import { Request,Response,NextFunction } from "express";
import User from "../../../../models/user";
import twilio from 'twilio'

function twilioConfig() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
    return { accountSid, authToken, verifyServiceSid };
}

function resolveAccountPhone(user: { phone?: string } | undefined, phone: unknown): { error: { status: number; msg: string } } | { phone: string } {
    if (!user) {
        return { error: { status: 401, msg: "Authentication required" } };
    }

    const requestedPhone = typeof phone === 'string' ? phone.trim() : '';
    const targetPhone = requestedPhone || user.phone;

    if (!targetPhone) {
        return { error: { status: 400, msg: "Phone number is required" } };
    }

    if (requestedPhone && requestedPhone !== user.phone) {
        return { error: { status: 400, msg: "Phone number does not match this account" } };
    }

    return { phone: targetPhone };
}

export const VerifyPhone = async (req:Request,res:Response,next:NextFunction)=>{
    try{
        const {phone} = req.body;
        const { accountSid, authToken, verifyServiceSid } = twilioConfig();
        
        // Check if Twilio is properly configured
        if (!accountSid || !authToken || !verifyServiceSid) {
            return res.status(500).json({
                success: false,
                msg: "SMS service is not configured. Please contact support."
            });
        }

        const resolved = resolveAccountPhone(req.user, phone);
        if ('error' in resolved) {
            return res.status(resolved.error.status).json({
                success: false,
                msg: resolved.error.msg
            });
        }

        const twilioClient = twilio(accountSid, authToken);

        await twilioClient.verify.v2.services(verifyServiceSid).verifications.create({
            channel:"sms",
            to:resolved.phone
        });


        return res.status(200).json({
            success: true,
            msg:"OTP sent to your phone number"
        })    
    }
    catch(e){
        console.error("Twilio verification error:", e);
        next(e);
    }
}



export const VerifyPhoneCheck = async(req:Request,res:Response,next:NextFunction)=>{
    try{
        const {phone,otp} = req.body;
        const { accountSid, authToken, verifyServiceSid } = twilioConfig();
        
        // Check if Twilio is properly configured
        if (!accountSid || !authToken || !verifyServiceSid) {
            return res.status(500).json({
                success: false,
                msg: "SMS service is not configured. Please contact support."
            });
        }

        if(!otp){
            return res.status(400).json({
                success: false,
                msg:"Phone number and OTP are required"
            });
        }

        const resolved = resolveAccountPhone(req.user, phone);
        if ('error' in resolved) {
            return res.status(resolved.error.status).json({
                success: false,
                msg: resolved.error.msg
            });
        }

        const twilioClient = twilio(accountSid, authToken);

        const service = await twilioClient.verify.v2.services(verifyServiceSid).verificationChecks.create({
            code:otp,
            to:resolved.phone
        });
        
        if(service.status==="approved"){
            await User.findByIdAndUpdate(req.user!._id,{isPhoneVerified:true});
            return res.status(200).json({
                success: true,
                msg:"Phone number verified successfully"
            });
        }else{
            return res.status(400).json({
                success: false,
                msg:"Invalid OTP"
            });
        }
    }
    catch(e){
        console.error("Twilio verification check error:", e);
        next(e);
    }
}
