export class AppError extends Error {
  constructor(
    public override message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message)
  }
}

export class AuthError extends AppError {
  constructor(message = "Authentication required") {
    super(message, "AUTH_ERROR", 401)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, "FORBIDDEN", 403)
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, "NOT_FOUND", 404)
  }
}

export class ValidationError extends AppError {
  constructor(
    message = "Validation failed",
    public details?: unknown,
  ) {
    super(message, "VALIDATION_ERROR", 400)
  }
}
