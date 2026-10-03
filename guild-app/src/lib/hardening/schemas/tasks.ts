import { z } from "zod";
import { xrdAmount, paginationSchema, radixAddress, sortOrder } from "./common";

export const createTaskInput = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  reward_amount: xrdAmount,
  requirements: z.string().max(5000).optional(),
  deadline: z.string().datetime().optional(),
});

export const updateTaskInput = createTaskInput.partial();

export const taskStatusFilter = z
  .enum(["open", "assigned", "submitted", "paid", "cancelled", "disputed", "refunded"])
  .optional();

export const listTasksQuery = paginationSchema.extend({
  status: taskStatusFilter,
  creator: radixAddress.optional(),
  sort: sortOrder,
});

export type CreateTaskInput = z.infer<typeof createTaskInput>;
export type UpdateTaskInput = z.infer<typeof updateTaskInput>;
export type ListTasksQuery = z.infer<typeof listTasksQuery>;
