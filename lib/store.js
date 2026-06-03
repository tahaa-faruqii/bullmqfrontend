import { configureStore } from "@reduxjs/toolkit";
import { productsApi } from "./productsApi";

export function makeStore() {
  return configureStore({
    reducer: {
      [productsApi.reducerPath]: productsApi.reducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().concat(productsApi.middleware),
  });
}
