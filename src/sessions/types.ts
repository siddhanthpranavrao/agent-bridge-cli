import { z } from "zod";

export const SessionSchema = z.object({
  sessionId: z.string().min(1),
  pid: z.number().int().positive(),
  workingDirectory: z.string().min(1),
  group: z.string().min(1),
  name: z.string().min(1),
  connectedAt: z.number(),
});

export const RegisterRequestSchema = z.object({
  sessionId: z.string().min(1),
  pid: z.number().int().positive(),
  workingDirectory: z.string().min(1),
  group: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});

export const DeregisterRequestSchema = z.object({
  sessionId: z.string().min(1),
});

export type Session = z.infer<typeof SessionSchema>;
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type DeregisterRequest = z.infer<typeof DeregisterRequestSchema>;
