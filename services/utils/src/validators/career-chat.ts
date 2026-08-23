import { z } from "zod";

/**
 * Contract for POST /ai/chat (Career AI conversation).
 *
 * The client may ONLY send user/assistant turns plus an optional model
 * override and optional profile hints. The system instruction, runtime
 * context and final message assembly are owned by the backend.
 */

export const MAX_CHAT_MESSAGES = 40;
export const MAX_CHAT_MESSAGE_LENGTH = 4000;

export const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1, "Message content cannot be empty").max(MAX_CHAT_MESSAGE_LENGTH),
});

export const careerChatSchema = z.object({
  /** Requested NIM model override. Validated against the live catalog. */
  model: z.string().trim().min(1).max(200).optional(),

  /** Optional stable seeker profile hints rendered into the system prompt.
   * Purely additive — Career AI works without it. */
  profile: z
    .object({
      skills: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
      targetRole: z.string().trim().max(200).optional(),
      experienceLevel: z.enum(["junior", "mid", "senior"]).optional(),
    })
    .optional(),

  /** Conversation history for this session; MUST end with a user turn. */
  messages: z.array(chatMessageSchema).min(1).max(MAX_CHAT_MESSAGES),
});

export type CareerChatInput = z.infer<typeof careerChatSchema>;
export type ChatTurn = z.infer<typeof chatMessageSchema>;

export const validateCareerChat = (body: unknown): CareerChatInput => {
  const input = careerChatSchema.parse(body);
  if (input.messages[input.messages.length - 1]?.role !== "user") {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["messages"],
        message: "The last message must come from the user",
      },
    ]);
  }
  return input;
};
