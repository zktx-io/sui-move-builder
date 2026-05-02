export class StructuredBuildError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string, cause?: unknown) {
    super(message);
    this.name = "StructuredBuildError";
    this.code = code;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export function structuredErrorCode(error: unknown): string | undefined {
  return error instanceof StructuredBuildError ? error.code : undefined;
}
