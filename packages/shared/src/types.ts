import { Request } from "express";

export interface UserPayload {
  user_id: number;
  name: string;
  email: string;
  password: string;
  phone_number: string;
  role: string;
  bio: string | null;
  resume: string | null;
  refresh_token: string | null;
  resume_public_id: string | null;
  profile_pic: string | null;
  profile_pic_public_id: string | null;
  created_at: Date;
  subscription: Date | null;
}

export interface AuthRequest extends Request {
  user?: UserPayload;
}
