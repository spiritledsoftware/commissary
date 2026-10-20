/**
 * A session's file operations' failures as the model reads them (#222): what went wrong with which path, and the
 * Durable Object's storage limit in words.
 */

/** What a file operation was doing, for its failure's words. */
export type FileOperation = "read" | "write" | "list";

/** A file operation's failure, as a session answers it over RPC. */
export interface FileFailure {
  readonly ok: false;
  readonly reason: "file";
  readonly message: string;
}

/**
 * The storage limit's failure: a SQLite-backed Durable Object past its limit fails writes with `database or disk is
 * full: SQLITE_FULL`.
 */
const STORAGE_FULL = /\bSQLITE_FULL\b|database or disk is full/;

const failed = (message: string): FileFailure => ({ ok: false, reason: "file", message });

/** A file operation's failure as the model reads it: what went wrong with which path. */
export const fileFailure = (error: Error, path: string, operation: FileOperation): FileFailure => {
  const { message } = error;
  const code = "code" in error ? String(error.code) : "";

  if (STORAGE_FULL.test(message))
    return failed(
      operation === "write"
        ? `The sandbox's storage is full (its Durable Object's storage limit): ${path} was not written. Delete files to make room.`
        : "The sandbox's storage is full (its Durable Object's storage limit). Delete files to make room.",
    );

  switch (code) {
    case "ENOENT":
      return failed(`No such file or directory: ${path}`);
    case "EISDIR":
      return failed(`${path} is a directory`);
    case "ENOTDIR":
      return failed(`Not a directory: ${path}`);
    default:
      return failed(`${path}: ${message}`);
  }
};
