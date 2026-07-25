import { Router } from "express";
import { LogIn, SignUp, LogOut, getMe } from "../../handlers/Auth";
import { acceptAdminInvite, getAdminInviteDetails } from "../../handlers/Auth/adminStaffInvite";
import { protect } from "../../middlewares/auth";

const authRouter = Router();

authRouter.route('/signup').post(SignUp);
authRouter.route('/login').post(LogIn);
authRouter.route('/logout').post(LogOut);
authRouter.route('/me').get(protect,getMe);
authRouter.route('/admin-invite').get(getAdminInviteDetails);
authRouter.route('/admin-invite/accept').post(acceptAdminInvite);

export default authRouter