import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

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
      invalidatesTags: [{ type: "Product", id: "LIST" }],
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
  return fallback;
}
