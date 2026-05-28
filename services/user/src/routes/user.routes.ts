import { Router } from "express";
import multer from "multer";
import {
  getMe,
  getUserById,
  updateUser,
  updateBio,
} from "../controllers/profile.controller.js";
import {
  uploadProfilePic,
  uploadResume,
} from "../controllers/uploads.controller.js";
import {
  addSkills,
  removeSkills,
  getAllSkills,
} from "../controllers/skills.controller.js";
import { isAuthenticated } from "@jtrack/shared/isauthenticated";
const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only JPEG, PNG, WEBP, PDF allowed."));
    }
  },
});

// ── Protected ─────────────────────────────────────────────────────────────────
router.get("/me", isAuthenticated, getMe);
router.put("/update", isAuthenticated, updateUser);
router.put("/bio", isAuthenticated, updateBio);

router.post(
  "/profile-pic",
  isAuthenticated,
  upload.single("profile_pic"),
  uploadProfilePic,
);

router.post("/resume", isAuthenticated, upload.single("resume"), uploadResume);

router.post("/add-skill", isAuthenticated, addSkills);
router.delete("/remove-skill", isAuthenticated, removeSkills);
// ── Public ────────────────────────────────────────────────────────────────────
router.get("/skills", getAllSkills);
router.get("/:id", getUserById);

export default router;
