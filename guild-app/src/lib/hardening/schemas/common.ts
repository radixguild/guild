import { z } from "zod";

export const radixAddress = z
  .string()
  .regex(
    /^(account|component|resource|package|identity)_rdx1[a-z0-9]{50,}$/,
    "Invalid Radix address",
  );

export const transactionId = z
  .string()
  .regex(/^txid_rdx1[a-z0-9]+$/, "Invalid transaction ID");

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const sortOrder = z
  .enum(["newest", "oldest", "reward", "deadline"])
  .default("newest");

export const idParam = z.coerce.number().int().positive();

export const xrdAmount = z
  .string()
  .regex(/^\d+(\.\d{1,8})?$/, "Invalid XRD amount");
