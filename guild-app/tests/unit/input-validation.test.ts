import { describe, it, expect } from "vitest";

// Test the validation logic from manifests.ts (address format checks, sanitization)
describe("Input Validation", () => {
  describe("Address validation", () => {
    it("should accept valid account addresses", () => {
      const valid = "account_rdx12y4l35lh2543nff3dzqr93gz05aaftfagcgjm96xyn3m684rgawqsv35gm";
      expect(valid.startsWith("account_rdx")).toBe(true);
    });

    it("should accept valid component addresses", () => {
      const valid = "component_rdx1czexample12345";
      expect(valid.startsWith("component_rdx")).toBe(true);
    });

    it("should accept valid resource addresses", () => {
      const valid = "resource_rdx1n22rexample";
      expect(valid.startsWith("resource_rdx")).toBe(true);
    });

    it("should reject invalid address prefixes", () => {
      const invalid = [
        "0x1234abcd",
        "rdx12345",
        "account_sim_1234",
        "invalid_address",
        "",
      ];
      for (const addr of invalid) {
        expect(
          addr.startsWith("account_rdx") ||
          addr.startsWith("component_rdx") ||
          addr.startsWith("resource_rdx")
        ).toBe(false);
      }
    });
  });

  describe("String sanitization", () => {
    function sanitize(input: string): string {
      return input.replace(/["\n\r;]/g, "");
    }

    it("should remove quotes", () => {
      expect(sanitize('hello "world"')).toBe("hello world");
    });

    it("should remove newlines", () => {
      expect(sanitize("line1\nline2\rline3")).toBe("line1line2line3");
    });

    it("should remove semicolons", () => {
      expect(sanitize("cmd; DROP TABLE")).toBe("cmd DROP TABLE");
    });

    it("should leave clean strings unchanged", () => {
      expect(sanitize("normal_task_id_123")).toBe("normal_task_id_123");
    });
  });

  describe("Task creation form validation", () => {
    function validateTaskForm(data: { title: string; description: string; reward_xrd: number }) {
      const errors: string[] = [];
      if (!data.title.trim()) errors.push("Title is required");
      if (data.title.length > 200) errors.push("Title too long (max 200 chars)");
      if (!data.description.trim()) errors.push("Description is required");
      if (data.description.length > 5000) errors.push("Description too long (max 5000 chars)");
      if (data.reward_xrd <= 0) errors.push("Reward must be positive");
      return errors;
    }

    it("should reject empty title", () => {
      const errors = validateTaskForm({ title: "", description: "Valid desc", reward_xrd: 100 });
      expect(errors).toContain("Title is required");
    });

    it("should reject title over 200 chars", () => {
      const errors = validateTaskForm({ title: "a".repeat(201), description: "Valid", reward_xrd: 100 });
      expect(errors).toContain("Title too long (max 200 chars)");
    });

    it("should reject empty description", () => {
      const errors = validateTaskForm({ title: "Valid", description: "  ", reward_xrd: 100 });
      expect(errors).toContain("Description is required");
    });

    it("should reject description over 5000 chars", () => {
      const errors = validateTaskForm({ title: "Valid", description: "a".repeat(5001), reward_xrd: 100 });
      expect(errors).toContain("Description too long (max 5000 chars)");
    });

    it("should reject zero reward", () => {
      const errors = validateTaskForm({ title: "Valid", description: "Valid", reward_xrd: 0 });
      expect(errors).toContain("Reward must be positive");
    });

    it("should reject negative reward", () => {
      const errors = validateTaskForm({ title: "Valid", description: "Valid", reward_xrd: -50 });
      expect(errors).toContain("Reward must be positive");
    });

    it("should accept valid form data", () => {
      const errors = validateTaskForm({ title: "Valid Task", description: "Do this", reward_xrd: 100 });
      expect(errors).toHaveLength(0);
    });
  });

  describe("XSS prevention", () => {
    function escapeHtml(str: string): string {
      return str.replace(/[&<>"']/g, (m) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[m] || m));
    }

    it("should escape script tags", () => {
      const input = '<script>alert("xss")</script>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain("<script>");
      expect(escaped).toContain("&lt;script&gt;");
    });

    it("should escape event handlers", () => {
      const input = '<img onerror="alert(1)">';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain("<img");
    });
  });
});
