import { describe, it, expect } from "vitest"
import {
  radixAddress,
  transactionId,
  paginationSchema,
  sortOrder,
  idParam,
  xrdAmount,
} from "@/lib/hardening/schemas/common"
import { createTaskInput, updateTaskInput, listTasksQuery } from "@/lib/hardening/schemas/tasks"

describe("radixAddress", () => {
  it("accepts account address", () => {
    const addr = "account_rdx1" + "a".repeat(54)
    expect(radixAddress.safeParse(addr).success).toBe(true)
  })

  it("accepts component address", () => {
    const addr = "component_rdx1" + "a".repeat(54)
    expect(radixAddress.safeParse(addr).success).toBe(true)
  })

  it("accepts resource address", () => {
    const addr = "resource_rdx1" + "a".repeat(54)
    expect(radixAddress.safeParse(addr).success).toBe(true)
  })

  it("accepts package address", () => {
    const addr = "package_rdx1" + "a".repeat(54)
    expect(radixAddress.safeParse(addr).success).toBe(true)
  })

  it("accepts identity address", () => {
    const addr = "identity_rdx1" + "a".repeat(54)
    expect(radixAddress.safeParse(addr).success).toBe(true)
  })

  it("rejects invalid prefix", () => {
    expect(radixAddress.safeParse("invalid_rdx1aaa").success).toBe(false)
  })

  it("rejects too short address", () => {
    expect(radixAddress.safeParse("account_rdx1abc").success).toBe(false)
  })
})

describe("transactionId", () => {
  it("accepts valid txid", () => {
    expect(transactionId.safeParse("txid_rdx1abc123").success).toBe(true)
  })

  it("rejects invalid format", () => {
    expect(transactionId.safeParse("invalid").success).toBe(false)
  })
})

describe("paginationSchema", () => {
  it("provides defaults", () => {
    const result = paginationSchema.parse({})
    expect(result.limit).toBe(20)
    expect(result.cursor).toBeUndefined()
  })

  it("rejects limit above 100", () => {
    expect(paginationSchema.safeParse({ limit: 101 }).success).toBe(false)
  })

  it("rejects limit below 1", () => {
    expect(paginationSchema.safeParse({ limit: 0 }).success).toBe(false)
  })

  it("coerces string limit", () => {
    const result = paginationSchema.parse({ limit: "50" })
    expect(result.limit).toBe(50)
  })
})

describe("sortOrder", () => {
  it("accepts valid values", () => {
    for (const val of ["newest", "oldest", "reward", "deadline"]) {
      expect(sortOrder.safeParse(val).success).toBe(true)
    }
  })

  it("defaults to newest", () => {
    expect(sortOrder.parse(undefined)).toBe("newest")
  })

  it("rejects invalid value", () => {
    expect(sortOrder.safeParse("random").success).toBe(false)
  })
})

describe("idParam", () => {
  it("accepts positive integer", () => {
    expect(idParam.safeParse(1).success).toBe(true)
  })

  it("rejects zero", () => {
    expect(idParam.safeParse(0).success).toBe(false)
  })

  it("coerces string to number", () => {
    expect(idParam.parse("42")).toBe(42)
  })
})

describe("xrdAmount", () => {
  it("accepts whole number", () => {
    expect(xrdAmount.safeParse("100").success).toBe(true)
  })

  it("accepts decimal with up to 8 places", () => {
    expect(xrdAmount.safeParse("1.12345678").success).toBe(true)
  })

  it("rejects more than 8 decimal places", () => {
    expect(xrdAmount.safeParse("1.123456789").success).toBe(false)
  })

  it("rejects negative", () => {
    expect(xrdAmount.safeParse("-10").success).toBe(false)
  })

  it("rejects non-numeric", () => {
    expect(xrdAmount.safeParse("abc").success).toBe(false)
  })
})

describe("createTaskInput", () => {
  const valid = {
    title: "Fix bug",
    description: "Fix the auth bug",
    reward_amount: "100",
  }

  it("accepts valid input", () => {
    expect(createTaskInput.safeParse(valid).success).toBe(true)
  })

  it("accepts with optional fields", () => {
    expect(
      createTaskInput.safeParse({
        ...valid,
        deadline: "2026-06-01T00:00:00.000Z",
        requirements: "Must know TypeScript",
      }).success,
    ).toBe(true)
  })

  it("rejects missing title", () => {
    const { title, ...rest } = valid
    expect(createTaskInput.safeParse(rest).success).toBe(false)
  })
})

describe("updateTaskInput", () => {
  it("accepts partial update", () => {
    expect(updateTaskInput.safeParse({ title: "New" }).success).toBe(true)
  })

  it("accepts empty object", () => {
    expect(updateTaskInput.safeParse({}).success).toBe(true)
  })
})

describe("listTasksQuery", () => {
  it("accepts empty query with defaults", () => {
    const result = listTasksQuery.parse({})
    expect(result.limit).toBe(20)
    expect(result.sort).toBe("newest")
  })

  it("accepts valid status filter", () => {
    expect(listTasksQuery.safeParse({ status: "open" }).success).toBe(true)
  })

  it("rejects invalid status", () => {
    expect(listTasksQuery.safeParse({ status: "invalid" }).success).toBe(false)
  })
})
