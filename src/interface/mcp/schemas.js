import { z } from "zod";

const acceptanceFailureRecord = z.object({
  test_id: z.string().min(1), kind: z.enum(["failure", "error"]), signature: z.string().min(1)
}).strict();
export const acceptanceCheck = z.union([
  z.string().min(1),
  z.object({
    command: z.string().min(1), reportPath: z.string().min(1),
    baseline: z.object({
      identity: z.object({ base_commit: z.string().min(1) }).catchall(z.string().min(1)),
      failures: z.array(acceptanceFailureRecord), required: z.array(z.string().min(1))
    }).strict()
  }).strict()
]);
export const acceptanceInput = z.union([z.string().min(1), z.array(acceptanceCheck).max(10)]);
export const workspaceSetupInput = z.object({
  links: z.array(z.object({
    path: z.string().min(1),
    source: z.string().min(1)
  }).strict()).max(20).optional(),
  submodules: z.boolean().optional(),
  commands: z.array(z.string().min(1)).max(20).optional()
}).strict();
