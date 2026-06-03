/** Keep in sync with backend config/limits.js */
export const MAX_BULK_PRODUCTS = Number(
  process.env.NEXT_PUBLIC_MAX_BULK_PRODUCTS || 10000,
);

export const MAX_BULK_FILE_GB = Number(
  process.env.NEXT_PUBLIC_MAX_BULK_FILE_GB || 1,
);
export const MAX_BULK_FILE_BYTES = MAX_BULK_FILE_GB * 1024 * 1024 * 1024;

export function formatFileSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const BULK_LIMITS_HINT = `Max ${MAX_BULK_FILE_GB} GB file, up to ${MAX_BULK_PRODUCTS} products per upload. Large imports may take up to ~5 minutes.`;
