export const logger = {
  info(message: string, details?: unknown) {
    console.info(`[S3Marks] ${message}`, details ?? "");
  },
  error(message: string, details?: unknown) {
    console.error(`[S3Marks] ${message}`, details ?? "");
  }
};
