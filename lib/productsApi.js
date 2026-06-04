import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/+$/, "");
const BULK_POLL_INTERVAL_MS = 1500;
const BULK_POLL_MAX_ATTEMPTS = 600;
export const BULK_UPLOAD_CHUNK_SIZE = Number(
  process.env.NEXT_PUBLIC_BULK_UPLOAD_CHUNK_SIZE || 10,
);

function normalizeProduct(product) {
  return {
    id: product._id ?? product.id,
    name: product.name,
    description: product.description ?? "",
    price: product.price,
  };
}

const rawBaseQuery = fetchBaseQuery({
  baseUrl: `${API_BASE}/api/products`,
});

async function baseQuery(args, api, extraOptions) {
  const result = await rawBaseQuery(args, api, extraOptions);

  if (result.error) {
    const { status, data } = result.error;
    const message =
      (typeof data === "object" && data?.message) ||
      (status === 413
        ? "Upload too large. Use a smaller file or fewer products."
        : "Request failed");

    return { error: { status, data: { message } } };
  }

  return result;
}

export const productsApi = createApi({
  reducerPath: "productsApi",
  baseQuery,
  tagTypes: ["Product"],
  endpoints: (builder) => ({
    getProducts: builder.query({
      query: () => "",
      transformResponse: (response) =>
        Array.isArray(response) ? response.map(normalizeProduct) : [],
      providesTags: (result) =>
        result?.length
          ? [
              ...result.map(({ id }) => ({ type: "Product", id })),
              { type: "Product", id: "LIST" },
            ]
          : [{ type: "Product", id: "LIST" }],
    }),

    createProduct: builder.mutation({
      query: (body) => ({
        url: "",
        method: "POST",
        body,
      }),
      transformResponse: normalizeProduct,
      invalidatesTags: [{ type: "Product", id: "LIST" }],
    }),
    updateProduct: builder.mutation({
      query: ({ id, ...body }) => ({
        url: `/${id}`,
        method: "PUT",
        body,
      }),
      transformResponse: normalizeProduct,
      invalidatesTags: (_result, _error, { id }) => [
        { type: "Product", id },
        { type: "Product", id: "LIST" },
      ],
    }),
    deleteProduct: builder.mutation({
      query: (id) => ({
        url: `/${id}`,
        method: "DELETE",
      }),
      invalidatesTags: (_result, _error, id) => [
        { type: "Product", id },
        { type: "Product", id: "LIST" },
      ],
    }),
    bulkCreateProducts: builder.mutation({
      query: (products) => ({
        url: "/bulk",
        method: "POST",
        body: { products },
      }),
      invalidatesTags: [{ type: "Product", id: "LIST" }],
    }),
    bulkDeleteProducts: builder.mutation({
      query: () => ({
        url: "/bulk",
        method: "DELETE",
      }),
      // Do not invalidate here — delete runs in queue; refetch too early shows partial list.
    }),
  }),
});

export const {
  useGetProductsQuery,
  useCreateProductMutation,
  useUpdateProductMutation,
  useDeleteProductMutation,
  useBulkCreateProductsMutation,
  useBulkDeleteProductsMutation,
} = productsApi;

export function getApiErrorMessage(error, fallback = "Something went wrong") {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  if ("data" in error && error.data?.message) return error.data.message;
  if ("message" in error && error.message) return error.message;
  if ("status" in error && error.status === "FETCH_ERROR") {
    return "Connection lost. Import may still be running — refresh the list shortly.";
  }
  if ("status" in error && error.status === 503) {
    return "Queue service unavailable. Check Redis and try again.";
  }
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollBulkJob(jobId, onProgress) {
  for (let attempt = 0; attempt < BULK_POLL_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${API_BASE}/api/products/jobs/${jobId}`);

    if (response.status === 404) {
      throw new Error("Import job not found");
    }

    if (response.status === 503) {
      throw new Error("Queue service unavailable. Check Redis and try again.");
    }

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || "Failed to check import status");
    }

    const data = await response.json();

    if (typeof onProgress === "function" && typeof data.progress === "number") {
      onProgress(data.progress);
    }

    if (data.status === "completed") {
      return data;
    }

    if (data.status === "failed") {
      throw new Error(data.message || "Bulk import failed");
    }

    await sleep(BULK_POLL_INTERVAL_MS);
  }

  throw new Error(
    "Import is still running. Refresh the product list in a few minutes.",
  );
}
