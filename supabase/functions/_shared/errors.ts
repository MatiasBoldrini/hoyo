export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function safeError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return {
    status: 500,
    code: "internal_error",
    message: "The payment request could not be processed.",
  };
}
