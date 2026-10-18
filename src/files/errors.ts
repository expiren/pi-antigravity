/** Stable validation codes; /file keeps its existing localized messages. */
export type FileValidationCode =
  | "UNSUPPORTED_TYPE"
  | "NOT_REGULAR_FILE"
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "FILE_CHANGED"
  | "INVALID_UTF8"
  | "BINARY_TEXT"
  | "INVALID_HEADER";

export class FileValidationError extends Error {
  constructor(
    readonly code: FileValidationCode,
    message: string,
  ) {
    super(message);
  }
}
