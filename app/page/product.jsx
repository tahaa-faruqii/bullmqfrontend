"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useDispatch } from "react-redux";
import {
  BULK_UPLOAD_CHUNK_SIZE,
  getApiErrorMessage,
  pollBulkJob,
  productsApi,
  useBulkCreateProductsMutation,
  useBulkDeleteProductsMutation,
  useCreateProductMutation,
  useDeleteProductMutation,
  useGetProductsQuery,
  useUpdateProductMutation,
} from "@/lib/productsApi";
import {
  BULK_LIMITS_HINT,
  formatFileSize,
  MAX_BULK_FILE_BYTES,
  MAX_BULK_FILE_GB,
} from "@/lib/limits";

const emptyForm = {
  name: "",
  description: "",
  price: "",
};

function formatPrice(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

export default function ProductPage() {
  const dispatch = useDispatch();
  const {
    data: products = [],
    isLoading: loading,
    error: productsError,
  } = useGetProductsQuery();
  const productTotal = products.length;
  const [createProduct, { isLoading: isCreating }] = useCreateProductMutation();
  const [updateProduct, { isLoading: isUpdating }] = useUpdateProductMutation();
  const [deleteProduct] = useDeleteProductMutation();
  const [bulkCreateProducts] = useBulkCreateProductsMutation();
  const [bulkDeleteProducts, { isLoading: bulkDeleting }] =
    useBulkDeleteProductsMutation();

  const saving = isCreating || isUpdating;
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [bulkFile, setBulkFile] = useState(null);
  const [bulkFileName, setBulkFileName] = useState("");
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkPhase, setBulkPhase] = useState("idle");
  const [bulkProgress, setBulkProgress] = useState({
    done: 0,
    total: 0,
    failed: 0,
  });
  const [bulkError, setBulkError] = useState("");
  const [bulkMessage, setBulkMessage] = useState("");
  const bulkImportLockRef = useRef(false);

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
    setError("");
  }

  function startEdit(product) {
    setEditingId(product.id);
    setForm({
      name: product.name,
      description: product.description,
      price: String(product.price),
    });
    setError("");
  }

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      price: Number(form.price),
    };

    try {
      if (editingId) {
        await updateProduct({ id: editingId, ...payload }).unwrap();
      } else {
        await createProduct(payload).unwrap();
      }

      resetForm();
    } catch (err) {
      setError(getApiErrorMessage(err));
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("Delete this product?")) return;

    setError("");
    try {
      await deleteProduct(id).unwrap();

      if (editingId === id) resetForm();
    } catch (err) {
      setError(getApiErrorMessage(err));
    }
  }

  function handleBulkFileChange(e) {
    const file = e.target.files?.[0];
    setBulkError("");
    setBulkMessage("");
    setBulkFile(null);
    setBulkFileName("");
    setBulkPhase("idle");
    setBulkProgress({ done: 0, total: 0, failed: 0 });

    if (!file) return;

    if (file.size > MAX_BULK_FILE_BYTES) {
      setBulkError(
        `File too large (${formatFileSize(file.size)}). Maximum is ${MAX_BULK_FILE_GB} GB.`,
      );
      return;
    }

    setBulkFile(file);
    setBulkFileName(file.name);
    e.target.value = "";
  }

  async function handleBulkImport() {
    if (!bulkFile) {
      setBulkError("Choose a CSV or JSON file first.");
      return;
    }

    if (bulkImportLockRef.current) return;

    bulkImportLockRef.current = true;
    setBulkImporting(true);
    setBulkError("");
    setBulkMessage("");
    setBulkPhase("reading");
    setBulkProgress({ done: 0, total: 0, failed: 0 });

    try {
      const text = await readFileAsText(bulkFile);

      setBulkPhase("preparing");
      const rawRows = getRawProductRows(text, bulkFile.name);
      const rowTotal = rawRows.length;
      setBulkProgress({ done: 0, total: rowTotal, failed: 0 });

      const prepared = [];
      for (let i = 0; i < rawRows.length; i += BULK_UPLOAD_CHUNK_SIZE) {
        const chunk = rawRows.slice(i, i + BULK_UPLOAD_CHUNK_SIZE);
        for (const row of chunk) {
          const normalized = normalizeBulkRow(row);
          if (isValidProductRow(normalized)) prepared.push(normalized);
        }
        setBulkProgress({
          done: Math.min(i + BULK_UPLOAD_CHUNK_SIZE, rowTotal),
          total: rowTotal,
          failed: 0,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      if (prepared.length === 0) {
        setBulkError("No valid products found.");
        return;
      }

      // One HTTP POST → one BullMQ job (worker batches inserts internally)
      setBulkPhase("uploading");
      setBulkProgress({
        done: 0,
        total: prepared.length,
        failed: 0,
      });

      const queued = await bulkCreateProducts(prepared).unwrap();

      const jobId = queued.jobId ?? queued.jobIds?.[0] ?? null;

      let totalCreated = 0;
      let allFailed = [];

      if (queued.status === "processing" && jobId) {
        setBulkPhase("processing");

        const result = await pollBulkJob(jobId, (progress) => {
          setBulkProgress({
            done: Math.round((progress / 100) * prepared.length),
            total: prepared.length,
            failed: allFailed.length,
          });
        });

        totalCreated = result.createdCount ?? 0;
        if (Array.isArray(result.failed)) allFailed = result.failed;
      } else {
        totalCreated =
          queued.createdCount ?? queued.created?.length ?? prepared.length;
        if (Array.isArray(queued.failed)) allFailed = queued.failed;
      }

      setBulkProgress({
        done: prepared.length,
        total: prepared.length,
        failed: allFailed.length,
      });

      setBulkMessage(
        allFailed.length === 0
          ? `${totalCreated} product${totalCreated === 1 ? "" : "s"} created successfully.`
          : `${totalCreated} created, ${allFailed.length} failed.`,
      );

      setBulkFile(null);
      setBulkFileName("");
      setBulkPhase("idle");
    } catch (err) {
      setBulkError(getApiErrorMessage(err, "Bulk import failed"));
      setBulkPhase("idle");
    } finally {
      setBulkImporting(false);
      bulkImportLockRef.current = false;
    }
  }

  async function handleBulkDelete() {
    if (productTotal === 0) return;
    if (
      !window.confirm(
        `Delete all ${productTotal} product${productTotal === 1 ? "" : "s"}? This cannot be undone.`,
      )
    ) {
      return;
    }

    setBulkError("");
    setBulkMessage("");

    try {
      const queued = await bulkDeleteProducts().unwrap();

      if (queued.jobId) {
        const result = await pollBulkJob(queued.jobId);
        const count = result.deletedCount ?? productTotal;
        if (editingId) resetForm();
        dispatch(
          productsApi.util.updateQueryData("getProducts", undefined, () => []),
        );
        setBulkMessage(`${count} product${count === 1 ? "" : "s"} deleted.`);
      } else {
        if (editingId) resetForm();
        dispatch(
          productsApi.util.updateQueryData("getProducts", undefined, () => []),
        );
        setBulkMessage(queued.message ?? "All products deleted.");
      }
    } catch (err) {
      setBulkError(getApiErrorMessage(err, "Bulk delete failed"));
    }
  }
  return (
    <div className="min-h-full bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <header className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Link
              href="/"
              className="text-sm font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300"
            >
              ← Back to home
            </Link>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              Product catalog
            </h1>
            <p className="mt-1 text-zinc-600 dark:text-zinc-400">
              Add, update, and remove products via your Express backend.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleBulkDelete}
              disabled={bulkDeleting || loading || productTotal === 0}
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-50 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-950/60"
            >
              {bulkDeleting ? "Deleting…" : "Delete all products"}
            </button>
            <p className="text-sm text-zinc-500">
              {productTotal} product{productTotal === 1 ? "" : "s"}
            </p>
          </div>
        </header>

        <div className="flex flex-col gap-8">
          <div className="grid gap-8 md:grid-cols-2">
            <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-lg font-medium">
                {editingId ? "Edit product" : "Add product"}
              </h2>
              <form onSubmit={handleSubmit} className="mt-5 space-y-4">
                <Field label="Name" required>
                  <input
                    name="name"
                    value={form.name}
                    onChange={handleChange}
                    required
                    className={inputClass}
                    placeholder="Product name"
                  />
                </Field>
                <Field label="Description" required>
                  <textarea
                    name="description"
                    value={form.description}
                    onChange={handleChange}
                    rows={3}
                    required
                    className={inputClass}
                    placeholder="Short description"
                  />
                </Field>
                <Field label="Price ($)" required>
                  <input
                    name="price"
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.price}
                    onChange={handleChange}
                    required
                    className={inputClass}
                    placeholder="0.00"
                  />
                </Field>

                {error && (
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
                    {error}
                  </p>
                )}

                <div className="flex gap-3 pt-1">
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex-1 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  >
                    {saving
                      ? "Saving…"
                      : editingId
                        ? "Update product"
                        : "Add product"}
                  </button>
                  {editingId && (
                    <button
                      type="button"
                      onClick={resetForm}
                      className="rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium transition hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            </section>

            <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-lg font-medium">Bulk upload</h2>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                Upload CSV or JSON. Click Done to import all products in one
                request.
              </p>
              <p className="mt-2 text-xs text-zinc-500">{BULK_LIMITS_HINT}</p>

              <label className="mt-5 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-300 px-4 py-8 transition hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-600 dark:hover:border-zinc-500 dark:hover:bg-zinc-800/50">
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Choose file
                </span>
                <span className="mt-1 text-xs text-zinc-500">
                  .csv or .json
                </span>
                <input
                  type="file"
                  accept=".csv,.json,application/json,text/csv"
                  onChange={handleBulkFileChange}
                  disabled={bulkImporting}
                  className="sr-only"
                />
              </label>

              {bulkFileName && (
                <p className="mt-3 truncate text-sm text-zinc-600 dark:text-zinc-400">
                  <span className="font-medium text-zinc-800 dark:text-zinc-200">
                    {bulkFileName}
                  </span>
                  {" · "}
                  ready — click Done to load and upload
                </p>
              )}

              <details className="mt-4 text-xs text-zinc-500">
                <summary className="cursor-pointer font-medium text-zinc-600 dark:text-zinc-400">
                  File format
                </summary>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-100 p-3 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {`CSV:
name,price,description
Widget,19.99,Short desc

JSON:
[
  { "name": "Widget", "price": 19.99, "description": "Short desc" }
]`}
                </pre>
              </details>

              {bulkError && (
                <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
                  {bulkError}
                </p>
              )}

              {/* {bulkMessage && (
                <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                  {bulkMessage}
                </p>
              )} */}

              {bulkImporting && (
                <div className="mt-4">
                  <div className="mb-1 flex justify-between text-xs text-zinc-500">
                    <span>
                      {bulkPhase === "reading" && "Reading file…"}
                      {bulkPhase === "preparing" &&
                        `Loading data… ${bulkProgress.done}/${bulkProgress.total}`}
                      {bulkPhase === "uploading" &&
                        `Queuing batch… ${bulkProgress.done}/${bulkProgress.total}`}
                      {bulkPhase === "processing" &&
                        `Creating products… ${bulkProgress.done}/${bulkProgress.total}`}
                    </span>
                    {bulkProgress.total > 0 && bulkPhase !== "reading" && (
                      <span>
                        {bulkPhase === "uploading"
                          ? bulkProgress.total
                          : `${bulkProgress.done}/${bulkProgress.total}`}
                      </span>
                    )}
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                    <div
                      className={`h-full bg-zinc-900 transition-all dark:bg-zinc-100 ${
                        bulkPhase === "reading" ? "w-1/4 animate-pulse" : ""
                      } ${
                        bulkPhase === "uploading" ? "w-full animate-pulse" : ""
                      }`}
                      style={
                        (bulkPhase === "preparing" ||
                          bulkPhase === "uploading" ||
                          bulkPhase === "processing") &&
                        bulkProgress.total > 0
                          ? {
                              width: `${(bulkProgress.done / bulkProgress.total) * 100}%`,
                            }
                          : undefined
                      }
                    />
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={handleBulkImport}
                disabled={bulkImporting || bulkDeleting || !bulkFile}
                className="mt-5 w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                {bulkImporting ? "Importing…" : "Done — create all"}
              </button>

              <button
                type="button"
                onClick={handleBulkDelete}
                disabled={
                  bulkDeleting || bulkImporting || loading || productTotal === 0
                }
                className="mt-3 w-full rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-50 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-950/60"
              >
                {bulkDeleting ? "Deleting all…" : "Delete all products"}
              </button>
            </section>
          </div>

          <section>
            <h2 className="mb-4 text-lg font-medium">Products</h2>
            {loading ? (
              <p className="text-zinc-500">Loading products…</p>
            ) : productsError ? (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
                {getApiErrorMessage(productsError, "Failed to load products")}
              </p>
            ) : products.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-zinc-300 p-12 text-center dark:border-zinc-700">
                <p className="text-zinc-600 dark:text-zinc-400">
                  No products yet. Add your first product using the form.
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-4">
                {products.map((product) => (
                  <li
                    key={product.id}
                    className="flex flex-col rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <h3 className="font-semibold">{product.name}</h3>
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                      {product.description || "No description"}
                    </p>
                    <span className="mt-3 text-lg font-semibold">
                      {formatPrice(product.price)}
                    </span>
                    <div className="mt-4 flex gap-2">
                      <button
                        type="button"
                        onClick={() => startEdit(product)}
                        className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium transition hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(product.id)}
                        className="flex-1 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-zinc-400 focus:ring-2 dark:border-zinc-600 dark:bg-zinc-950";

function Field({ label, required, children }) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block font-medium text-zinc-700 dark:text-zinc-300">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      {children}
    </label>
  );
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsText(file);
  });
}

function isValidProductRow(row) {
  return row.name && !Number.isNaN(row.price);
}

function getRawProductRows(text, fileName) {
  const ext = fileName.split(".").pop()?.toLowerCase();
  return ext === "json" ? parseJsonProducts(text) : parseCsvProducts(text);
}

function parseJsonProducts(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) {
    throw new Error("JSON must be an array of products.");
  }
  return data;
}

function parseCsvProducts(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const nameIdx = headers.indexOf("name");
  const priceIdx = headers.indexOf("price");
  const descIdx = headers.indexOf("description");

  if (nameIdx === -1 || priceIdx === -1) {
    throw new Error('CSV must include "name" and "price" columns.');
  }

  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    return {
      name: cols[nameIdx]?.trim(),
      price: cols[priceIdx]?.trim(),
      description: descIdx >= 0 ? cols[descIdx]?.trim() : "",
    };
  });
}

function splitCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  result.push(current.trim());
  return result;
}

function normalizeBulkRow(row) {
  return {
    name: String(row.name ?? "").trim(),
    description: String(row.description ?? "").trim(),
    price: Number(row.price),
  };
}
