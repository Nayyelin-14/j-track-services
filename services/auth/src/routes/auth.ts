// services/authservice/src/routes/auth.routes.ts
import { Router } from "express";
import {
  changePassword,
  forgotPassword,
  getMe,
  login,
  logout,
  register,
  resendVerification,
  resetPassword,
  verifyEmail,
} from "../controllers/auth.js";
import uploadFile from "../middleware/multer.midd.js";
import { isAuthenticated } from "@jtrack/shared/isauthenticated";

const router = Router();

router.post("/register", uploadFile, register);
router.post("/login", login);
router.post("/logout", isAuthenticated, logout);
router.get("/me", isAuthenticated, getMe);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password/:token", resetPassword);
router.post("/verify-email", verifyEmail);
router.post("/resend-verification", resendVerification);
router.patch("/change-password", isAuthenticated, changePassword);

export default router;
