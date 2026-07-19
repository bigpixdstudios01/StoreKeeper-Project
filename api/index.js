// ═══════════════════════════════════════════════════════════════════════════════
// api/index.js — StoreKeeper360 Backend (single file, all routes)
//
// This ONE file contains the entire backend: the Supabase admin client, the
// auth middleware, and every API route (auth/profile, products, sales,
// reports, settings). It works both as a local dev server (run directly with
// `node api/index.js` or `npm start`) and as a Vercel serverless function
// (Vercel automatically picks up any file inside /api).
//
// Why one file: fewer files/folders means far less chance of upload or
// folder-structure mistakes when pushing from a phone or via GitHub's web UI.
// ═══════════════════════════════════════════════════════════════════════════════

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const crypto  = require("crypto");
const { createClient } = require("@supabase/supabase-js");

// ═══════════════════════════════════════════════ SUPABASE ADMIN CLIENT ══════════
// Uses the SERVICE ROLE key, which bypasses Row Level Security — this is safe
// ONLY on the server, never exposed to the frontend.
const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.warn(
    "\n⚠  SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing. " +
    "Set these in your .env (local) or Vercel environment variables.\n"
  );
}

const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ═══════════════════════════════════════════════ PAGINATION HELPER ═════════════
// Supabase caps any single request at 1000 rows by default. This helper pages
// through in batches of 1000 until every row is retrieved — no practical limit,
// so a growing product catalog or full sales history never gets truncated.
const PAGE_SIZE = 1000;

async function fetchAllRows(buildQuery) {
  let allRows = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return allRows;
}

// ═══════════════════════════════════════════════ AUTH MIDDLEWARE ═══════════════
// Verifies the Supabase session token sent from the frontend on every request
// to a protected route.
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer "))
    return res.status(401).json({ error: "No session token provided. Please log in." });

  const token = header.slice(7);
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user)
      return res.status(401).json({ error: "Your session is invalid or has expired. Please log in again." });

    req.userId    = data.user.id;
    req.userEmail = data.user.email;
    next();
  } catch {
    return res.status(401).json({ error: "Your session is invalid or has expired. Please log in again." });
  }
}

// ═══════════════════════════════════════════════ EXPRESS APP SETUP ═════════════
const app = express();
app.use(cors());
app.use(express.json());

const api = express.Router();

// ─────────────────────────────────────────────── AUTH / PROFILE ────────────────
// NOTE: Signup, login, logout, and password reset are handled directly by the
// frontend via the Supabase client. This backend only manages the `profiles`
// table (name, store name, currency) since that data lives outside Supabase's
// built-in auth.users table.

api.get("/auth/profile", authMiddleware, async (req, res) => {
  let { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id, name, store_name, currency, created_at")
    .eq("id", req.userId)
    .single();

  // Self-heal: if the database trigger that normally creates this row on
  // signup didn't fire for some reason, create it now instead of failing.
  if (error || !data) {
    const { data: userData } = await supabaseAdmin.auth.admin.getUserById(req.userId);
    const meta = userData?.user?.user_metadata || {};

    const { data: created, error: createError } = await supabaseAdmin
      .from("profiles")
      .insert({
        id: req.userId,
        name: meta.name || "",
        store_name: meta.store_name || "My Store",
        currency: meta.currency || "₦",
      })
      .select("id, name, store_name, currency, created_at")
      .single();

    if (createError) return res.status(404).json({ error: "Profile not found and could not be created: " + createError.message });
    data = created;

    // Also backfill default categories if they're missing for the same reason
    const { data: existingCats } = await supabaseAdmin.from("categories").select("id").eq("user_id", req.userId).limit(1);
    if (!existingCats || existingCats.length === 0) {
      const defaultCategories = ["Electronics", "Food & Beverages", "Clothing", "Household", "Others"];
      await supabaseAdmin.from("categories").insert(
        defaultCategories.map((name) => ({ user_id: req.userId, name }))
      );
    }
  }

  res.json({ ...data, email: req.userEmail });
});

api.put("/auth/profile", authMiddleware, async (req, res) => {
  const { name, store_name, currency } = req.body;
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ name, store_name, currency })
    .eq("id", req.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─────────────────────────────────────────────── PRODUCTS ──────────────────────

api.get("/products", authMiddleware, async (req, res) => {
  const { search, category, low_stock } = req.query;

  let data;
  try {
    data = await fetchAllRows((rangeFrom, rangeTo) => {
      let q = supabaseAdmin
        .from("products")
        .select("*, categories(name)")
        .eq("user_id", req.userId)
        .order("name", { ascending: true })
        .range(rangeFrom, rangeTo);
      if (search)   q = q.or(`name.ilike.%${search}%,sku.ilike.%${search}%,barcode.ilike.%${search}%`);
      if (category) q = q.eq("category_id", category);
      return q;
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  let products = data.map((p) => ({
    ...p,
    category_name: p.categories?.name || null,
    categories: undefined,
  }));

  if (low_stock === "1") {
    products = products.filter((p) => p.quantity <= p.restock_level);
  }

  res.json(products);
});

api.get("/products/meta/categories", authMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("categories")
    .select("*")
    .eq("user_id", req.userId)
    .order("name");

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

api.post("/products/meta/categories", authMiddleware, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Category name is required." });

  const { data, error } = await supabaseAdmin
    .from("categories")
    .insert({ user_id: req.userId, name })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Category already exists." });
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// Must come before /products/:id so "barcode" isn't mistaken for a product ID
api.get("/products/barcode/:code", authMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("*, categories(name)")
    .eq("barcode", req.params.code)
    .eq("user_id", req.userId)
    .single();

  if (error || !data) return res.status(404).json({ error: "No product found with that barcode." });
  res.json({ ...data, category_name: data.categories?.name || null, categories: undefined });
});

api.get("/products/:id", authMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("*, categories(name)")
    .eq("id", req.params.id)
    .eq("user_id", req.userId)
    .single();

  if (error || !data) return res.status(404).json({ error: "Product not found." });
  res.json({ ...data, category_name: data.categories?.name || null, categories: undefined });
});

api.post("/products", authMiddleware, async (req, res) => {
  const { name, sku, barcode, category_id, purchase_price, selling_price, quantity, restock_level, unit, description } = req.body;
  if (!name) return res.status(400).json({ error: "Product name is required." });

  const openingQty = Number(quantity) || 0;

  const { data: product, error } = await supabaseAdmin
    .from("products")
    .insert({
      user_id: req.userId,
      name,
      sku: sku || null,
      barcode: barcode || null,
      category_id: category_id || null,
      purchase_price: purchase_price || 0,
      selling_price: selling_price || 0,
      quantity: 0,
      restock_level: restock_level || 5,
      unit: unit || "pcs",
      description: description || null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That barcode is already assigned to another product." });
    return res.status(500).json({ error: error.message });
  }

  if (openingQty > 0) {
    await supabaseAdmin.from("stock_adjustments").insert({
      user_id: req.userId,
      product_id: product.id,
      delta: openingQty,
      reason: "initial",
      note: "Initial stock entry",
    });
  }

  res.json({ id: product.id, success: true });
});

api.put("/products/:id", authMiddleware, async (req, res) => {
  const { name, sku, barcode, category_id, purchase_price, selling_price, restock_level, unit, description } = req.body;

  const { data: existing } = await supabaseAdmin
    .from("products")
    .select("id")
    .eq("id", req.params.id)
    .eq("user_id", req.userId)
    .single();

  if (!existing) return res.status(404).json({ error: "Product not found." });

  const { error } = await supabaseAdmin
    .from("products")
    .update({
      name, sku: sku || null, barcode: barcode || null, category_id: category_id || null,
      purchase_price, selling_price, restock_level: restock_level || 5,
      unit: unit || "pcs", description: description || null,
    })
    .eq("id", req.params.id)
    .eq("user_id", req.userId);

  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That barcode is already assigned to another product." });
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true });
});

api.delete("/products/:id", authMiddleware, async (req, res) => {
  const { data: existing } = await supabaseAdmin
    .from("products")
    .select("id")
    .eq("id", req.params.id)
    .eq("user_id", req.userId)
    .single();

  if (!existing) return res.status(404).json({ error: "Product not found." });

  const { data: hasSales } = await supabaseAdmin
    .from("sales")
    .select("id")
    .eq("product_id", req.params.id)
    .limit(1);

  if (hasSales && hasSales.length > 0)
    return res.status(400).json({ error: "Cannot delete a product with recorded sales. Archive it instead." });

  const { error } = await supabaseAdmin
    .from("products")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

api.post("/products/:id/restock", authMiddleware, async (req, res) => {
  const { quantity, note } = req.body;
  if (!quantity || quantity <= 0)
    return res.status(400).json({ error: "Quantity must be a positive number." });

  const { data: product } = await supabaseAdmin
    .from("products")
    .select("id")
    .eq("id", req.params.id)
    .eq("user_id", req.userId)
    .single();

  if (!product) return res.status(404).json({ error: "Product not found." });

  const { error } = await supabaseAdmin.from("stock_adjustments").insert({
    user_id: req.userId,
    product_id: req.params.id,
    delta: quantity,
    reason: "restock",
    note: note || "Manual restock",
  });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─────────────────────────────────────────────── SALES ─────────────────────────

const VALID_PAYMENT_METHODS = ["cash", "transfer", "card"];

function validatePayment(payment_method, bank_account_id, pos_terminal_id) {
  const method = payment_method || "cash";
  if (!VALID_PAYMENT_METHODS.includes(method)) {
    return { error: `Payment method must be one of: ${VALID_PAYMENT_METHODS.join(", ")}.` };
  }
  if (method === "transfer" && !bank_account_id) {
    return { error: "Please select which bank account the transfer was paid into." };
  }
  if (method === "card" && !pos_terminal_id) {
    return { error: "Please select which POS terminal was used." };
  }
  return { method };
}

api.post("/sales", authMiddleware, async (req, res) => {
  const { product_id, quantity_sold, unit_price, note, sale_date, payment_method, bank_account_id, pos_terminal_id } = req.body;
  if (!product_id || !quantity_sold || quantity_sold <= 0)
    return res.status(400).json({ error: "Product and valid quantity are required." });

  const paymentCheck = validatePayment(payment_method, bank_account_id, pos_terminal_id);
  if (paymentCheck.error) return res.status(400).json({ error: paymentCheck.error });

  const { data: product } = await supabaseAdmin
    .from("products")
    .select("*")
    .eq("id", product_id)
    .eq("user_id", req.userId)
    .single();

  if (!product) return res.status(404).json({ error: "Product not found." });
  if (product.quantity < quantity_sold)
    return res.status(400).json({ error: `Insufficient stock. Only ${product.quantity} ${product.unit} available.` });

  const price    = unit_price !== undefined ? unit_price : product.selling_price;
  const revenue  = price * quantity_sold;
  const cost     = product.purchase_price * quantity_sold;
  const profit   = revenue - cost;
  const saleDate = sale_date || new Date().toISOString().split("T")[0];

  const { data: sale, error } = await supabaseAdmin
    .from("sales")
    .insert({
      user_id: req.userId, product_id, quantity_sold, unit_price: price,
      purchase_price: product.purchase_price, total_revenue: revenue,
      total_cost: cost, profit, note: note || null, sale_date: saleDate,
      payment_method: paymentCheck.method,
      bank_account_id: paymentCheck.method === "transfer" ? bank_account_id : null,
      pos_terminal_id: paymentCheck.method === "card" ? pos_terminal_id : null,
      transaction_group: null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    id: sale.id, product_name: product.name, quantity_sold, unit_price: price,
    total_revenue: revenue, profit, remaining_stock: product.quantity - quantity_sold,
    payment_method: paymentCheck.method, success: true,
  });
});

api.post("/sales/bulk", authMiddleware, async (req, res) => {
  const { items, note, sale_date, payment_method, bank_account_id, pos_terminal_id, customer_id } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "Items array is required." });

  const paymentCheck = validatePayment(payment_method, bank_account_id, pos_terminal_id);
  if (paymentCheck.error) return res.status(400).json({ error: paymentCheck.error });

  const saleDate = sale_date || new Date().toISOString().split("T")[0];
  const transactionGroup = items.length > 1 ? crypto.randomUUID() : null;

  const productChecks = [];
  for (const item of items) {
    const { data: product } = await supabaseAdmin
      .from("products")
      .select("*")
      .eq("id", item.product_id)
      .eq("user_id", req.userId)
      .single();

    if (!product) return res.status(400).json({ error: `Product ID ${item.product_id} not found.` });
    if (product.quantity < item.quantity_sold)
      return res.status(400).json({ error: `Insufficient stock for "${product.name}". Have ${product.quantity}, need ${item.quantity_sold}.` });

    productChecks.push({ item, product });
  }

  const results = [];
  for (const { item, product } of productChecks) {
    const price     = item.unit_price !== undefined ? item.unit_price : product.selling_price;
    const grossRevenue = price * item.quantity_sold;
    const itemDiscount = Number(item.discount_amount) || 0; // this item's share of the cart-level discount, computed by the frontend
    const revenue   = grossRevenue - itemDiscount;
    const cost      = product.purchase_price * item.quantity_sold;
    const profit    = revenue - cost;

    const { data: sale, error } = await supabaseAdmin
      .from("sales")
      .insert({
        user_id: req.userId, product_id: item.product_id, quantity_sold: item.quantity_sold,
        unit_price: price, purchase_price: product.purchase_price, total_revenue: revenue,
        total_cost: cost, profit, note: note || null, sale_date: saleDate,
        payment_method: paymentCheck.method,
        bank_account_id: paymentCheck.method === "transfer" ? bank_account_id : null,
        pos_terminal_id: paymentCheck.method === "card" ? pos_terminal_id : null,
        transaction_group: transactionGroup,
        customer_id: customer_id || null,
        discount_amount: itemDiscount,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    results.push({
      id: sale.id, product_id: item.product_id, product_name: product.name,
      quantity_sold: item.quantity_sold, unit_price: price, total_revenue: revenue, profit,
      unit: product.unit,
    });
  }

  let bankAccount = null, posTerminal = null;
  if (paymentCheck.method === "transfer" && bank_account_id) {
    const { data } = await supabaseAdmin.from("bank_accounts").select("*").eq("id", bank_account_id).single();
    bankAccount = data || null;
  }
  if (paymentCheck.method === "card" && pos_terminal_id) {
    const { data } = await supabaseAdmin.from("pos_terminals").select("*").eq("id", pos_terminal_id).single();
    posTerminal = data || null;
  }

  res.json({
    success: true,
    transaction_group: transactionGroup,
    payment_method: paymentCheck.method,
    bank_account: bankAccount,
    pos_terminal: posTerminal,
    sale_date: saleDate,
    sales: results,
  });
});

api.get("/sales", authMiddleware, async (req, res) => {
  const { from, to, product_id, limit = 200, offset = 0, export: isExport } = req.query;
  const baseSelect = "*, products(name, unit, categories(name)), bank_accounts(bank_name, account_number, account_name), pos_terminals(terminal_name, provider), customers(name, phone)";

  let rows;
  try {
    if (isExport === "1") {
      rows = await fetchAllRows((rangeFrom, rangeTo) => {
        let q = supabaseAdmin.from("sales").select(baseSelect).eq("user_id", req.userId)
          .order("created_at", { ascending: false }).range(rangeFrom, rangeTo);
        if (from)       q = q.gte("sale_date", from);
        if (to)         q = q.lte("sale_date", to);
        if (product_id) q = q.eq("product_id", product_id);
        return q;
      });
    } else {
      let query = supabaseAdmin
        .from("sales")
        .select(baseSelect)
        .eq("user_id", req.userId)
        .order("created_at", { ascending: false })
        .range(Number(offset), Number(offset) + Number(limit) - 1);

      if (from)       query = query.gte("sale_date", from);
      if (to)         query = query.lte("sale_date", to);
      if (product_id) query = query.eq("product_id", product_id);

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      rows = data;
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const sales = rows.map((s) => ({
    ...s,
    product_name: s.products?.name,
    unit: s.products?.unit,
    category_name: s.products?.categories?.name || null,
    bank_account_name: s.bank_accounts ? `${s.bank_accounts.bank_name} — ${s.bank_accounts.account_number}` : null,
    pos_terminal_name: s.pos_terminals?.terminal_name || null,
    customer_name: s.customers?.name || null,
    customer_phone: s.customers?.phone || null,
    products: undefined,
    bank_accounts: undefined,
    pos_terminals: undefined,
    customers: undefined,
  }));

  res.json(sales);
});

api.delete("/sales/:id", authMiddleware, async (req, res) => {
  const { data: sale } = await supabaseAdmin
    .from("sales")
    .select("*")
    .eq("id", req.params.id)
    .eq("user_id", req.userId)
    .single();

  if (!sale) return res.status(404).json({ error: "Sale not found." });

  const { error } = await supabaseAdmin
    .from("sales")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─────────────────────────────────────────────── REPORTS ───────────────────────

const todayISO = () => new Date().toISOString().split("T")[0];

api.get("/reports/dashboard", authMiddleware, async (req, res) => {
  const uid = req.userId;
  const today = todayISO();
  const monthStart = today.slice(0, 7) + "-01";

  const [todayRows, monthRows, products] = await Promise.all([
    fetchAllRows((from, to) =>
      supabaseAdmin.from("sales").select("total_revenue, total_cost, profit").eq("user_id", uid).eq("sale_date", today).range(from, to)
    ),
    fetchAllRows((from, to) =>
      supabaseAdmin.from("sales").select("total_revenue, profit").eq("user_id", uid).gte("sale_date", monthStart).range(from, to)
    ),
    fetchAllRows((from, to) =>
      supabaseAdmin.from("products").select("id, name, quantity, restock_level, unit, purchase_price, selling_price").eq("user_id", uid).range(from, to)
    ),
  ]);

  const sum = (rows, key) => rows.reduce((s, r) => s + Number(r[key] || 0), 0);

  const todaySales = {
    revenue: sum(todayRows, "total_revenue"), cost: sum(todayRows, "total_cost"),
    profit: sum(todayRows, "profit"), transactions: todayRows.length,
  };
  const monthSales = {
    revenue: sum(monthRows, "total_revenue"), profit: sum(monthRows, "profit"), transactions: monthRows.length,
  };
  const inventoryValue = {
    cost_value: products.reduce((s, p) => s + p.quantity * p.purchase_price, 0),
    retail_value: products.reduce((s, p) => s + p.quantity * p.selling_price, 0),
    total_units: products.reduce((s, p) => s + p.quantity, 0),
    product_count: products.length,
  };
  const lowStock = products
    .filter((p) => p.quantity <= p.restock_level)
    .sort((a, b) => a.quantity - b.quantity)
    .slice(0, 10)
    .map(({ id, name, quantity, restock_level, unit }) => ({ id, name, quantity, restock_level, unit }));

  const allSales = await fetchAllRows((from, to) =>
    supabaseAdmin.from("sales").select("product_id, quantity_sold, total_revenue, profit, products(name)").eq("user_id", uid).range(from, to)
  );

  const byProduct = {};
  for (const s of allSales || []) {
    const key = s.product_id;
    if (!byProduct[key]) byProduct[key] = { name: s.products?.name, units_sold: 0, revenue: 0, profit: 0 };
    byProduct[key].units_sold += s.quantity_sold;
    byProduct[key].revenue += Number(s.total_revenue);
    byProduct[key].profit += Number(s.profit);
  }
  const topProducts = Object.values(byProduct).sort((a, b) => b.units_sold - a.units_sold).slice(0, 5);

  res.json({ todaySales, monthSales, inventoryValue, lowStock, topProducts });
});

api.get("/reports/daily", authMiddleware, async (req, res) => {
  const { from, to } = req.query;
  const defaultFrom = (() => { const d = new Date(); d.setDate(d.getDate() - 29); return d.toISOString().split("T")[0]; })();
  const fromDate = from || defaultFrom;
  const toDate   = to || todayISO();

  let data;
  try {
    data = await fetchAllRows((from2, to2) =>
      supabaseAdmin.from("sales").select("sale_date, total_revenue, total_cost, profit")
        .eq("user_id", req.userId).gte("sale_date", fromDate).lte("sale_date", toDate).range(from2, to2)
    );
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const byDate = {};
  for (const s of data) {
    if (!byDate[s.sale_date]) byDate[s.sale_date] = { sale_date: s.sale_date, revenue: 0, cost: 0, profit: 0, transactions: 0 };
    byDate[s.sale_date].revenue += Number(s.total_revenue);
    byDate[s.sale_date].cost += Number(s.total_cost);
    byDate[s.sale_date].profit += Number(s.profit);
    byDate[s.sale_date].transactions += 1;
  }

  res.json(Object.values(byDate).sort((a, b) => a.sale_date.localeCompare(b.sale_date)));
});

api.get("/reports/monthly", authMiddleware, async (req, res) => {
  const year = req.query.year || new Date().getFullYear();

  let data;
  try {
    data = await fetchAllRows((from, to) =>
      supabaseAdmin.from("sales").select("sale_date, total_revenue, total_cost, profit")
        .eq("user_id", req.userId).gte("sale_date", `${year}-01-01`).lte("sale_date", `${year}-12-31`).range(from, to)
    );
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const byMonth = {};
  for (const s of data) {
    const m = s.sale_date.slice(5, 7);
    if (!byMonth[m]) byMonth[m] = { month: m, revenue: 0, cost: 0, profit: 0, transactions: 0 };
    byMonth[m].revenue += Number(s.total_revenue);
    byMonth[m].cost += Number(s.total_cost);
    byMonth[m].profit += Number(s.profit);
    byMonth[m].transactions += 1;
  }

  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
  res.json(months.map((m) => byMonth[m] || { month: m, revenue: 0, cost: 0, profit: 0, transactions: 0 }));
});

api.get("/reports/products", authMiddleware, async (req, res) => {
  const { from, to, limit = 20 } = req.query;

  let data;
  try {
    data = await fetchAllRows((rangeFrom, rangeTo) => {
      let q = supabaseAdmin.from("sales")
        .select("product_id, quantity_sold, unit_price, total_revenue, total_cost, profit, sale_date, products(name, sku, categories(name))")
        .eq("user_id", req.userId).range(rangeFrom, rangeTo);
      if (from) q = q.gte("sale_date", from);
      if (to)   q = q.lte("sale_date", to);
      return q;
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const byProduct = {};
  for (const s of data) {
    const key = s.product_id;
    if (!byProduct[key]) {
      byProduct[key] = {
        id: key, name: s.products?.name, sku: s.products?.sku, category: s.products?.categories?.name || null,
        units_sold: 0, revenue: 0, cost: 0, profit: 0, priceSum: 0, priceCount: 0, last_sale: s.sale_date,
      };
    }
    const p = byProduct[key];
    p.units_sold += s.quantity_sold;
    p.revenue += Number(s.total_revenue);
    p.cost += Number(s.total_cost);
    p.profit += Number(s.profit);
    p.priceSum += Number(s.unit_price);
    p.priceCount += 1;
    if (s.sale_date > p.last_sale) p.last_sale = s.sale_date;
  }

  const rows = Object.values(byProduct)
    .map((p) => ({ ...p, avg_price: p.priceSum / p.priceCount, priceSum: undefined, priceCount: undefined }))
    .sort((a, b) => b.units_sold - a.units_sold)
    .slice(0, Number(limit));

  res.json(rows);
});

api.get("/reports/categories", authMiddleware, async (req, res) => {
  const { from, to } = req.query;

  let data;
  try {
    data = await fetchAllRows((rangeFrom, rangeTo) => {
      let q = supabaseAdmin.from("sales")
        .select("quantity_sold, total_revenue, profit, sale_date, products(categories(name))")
        .eq("user_id", req.userId).range(rangeFrom, rangeTo);
      if (from) q = q.gte("sale_date", from);
      if (to)   q = q.lte("sale_date", to);
      return q;
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const byCategory = {};
  for (const s of data) {
    const name = s.products?.categories?.name || "Uncategorised";
    if (!byCategory[name]) byCategory[name] = { category: name, revenue: 0, profit: 0, units_sold: 0 };
    byCategory[name].revenue += Number(s.total_revenue);
    byCategory[name].profit += Number(s.profit);
    byCategory[name].units_sold += s.quantity_sold;
  }

  res.json(Object.values(byCategory).sort((a, b) => b.revenue - a.revenue));
});

api.get("/reports/stock-history", authMiddleware, async (req, res) => {
  const { product_id, from, to, limit = 50, export: isExport } = req.query;

  let data;
  try {
    if (isExport === "1") {
      data = await fetchAllRows((rangeFrom, rangeTo) => {
        let q = supabaseAdmin.from("stock_adjustments").select("*, products(name)")
          .eq("user_id", req.userId).order("created_at", { ascending: false }).range(rangeFrom, rangeTo);
        if (product_id) q = q.eq("product_id", product_id);
        if (from) q = q.gte("created_at", from);
        if (to)   q = q.lte("created_at", to);
        return q;
      });
    } else {
      let query = supabaseAdmin.from("stock_adjustments").select("*, products(name)")
        .eq("user_id", req.userId).order("created_at", { ascending: false }).limit(Number(limit));
      if (product_id) query = query.eq("product_id", product_id);
      if (from) query = query.gte("created_at", from);
      if (to)   query = query.lte("created_at", to);

      const { data: rows, error } = await query;
      if (error) throw new Error(error.message);
      data = rows;
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  res.json(data.map((r) => ({ ...r, product_name: r.products?.name, products: undefined })));
});

// ─────────────────────────────────────────────── CUSTOMERS ─────────────────────

api.get("/customers", authMiddleware, async (req, res) => {
  const { search } = req.query;
  let query = supabaseAdmin.from("customers").select("*").eq("user_id", req.userId).order("name");
  if (search) query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

api.get("/customers/:id", authMiddleware, async (req, res) => {
  const { data: customer, error } = await supabaseAdmin
    .from("customers").select("*").eq("id", req.params.id).eq("user_id", req.userId).single();
  if (error || !customer) return res.status(404).json({ error: "Customer not found." });

  // Purchase history + simple lifetime stats, computed on the fly (no fragile triggers needed)
  const { data: sales } = await supabaseAdmin
    .from("sales")
    .select("id, sale_date, total_revenue, profit, quantity_sold, products(name)")
    .eq("customer_id", req.params.id)
    .eq("user_id", req.userId)
    .order("sale_date", { ascending: false });

  const totalSpent = (sales || []).reduce((s, r) => s + Number(r.total_revenue), 0);
  const visitDates = new Set((sales || []).map((r) => r.sale_date));

  res.json({
    ...customer,
    total_spent: totalSpent,
    visit_count: visitDates.size,
    purchase_history: (sales || []).map((s) => ({ ...s, product_name: s.products?.name, products: undefined })),
  });
});

api.post("/customers", authMiddleware, async (req, res) => {
  const { name, phone, email, notes } = req.body;
  if (!name) return res.status(400).json({ error: "Customer name is required." });

  const { data, error } = await supabaseAdmin
    .from("customers")
    .insert({ user_id: req.userId, name, phone: phone || null, email: email || null, notes: notes || null })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

api.put("/customers/:id", authMiddleware, async (req, res) => {
  const { name, phone, email, notes } = req.body;
  const { error } = await supabaseAdmin
    .from("customers")
    .update({ name, phone: phone || null, email: email || null, notes: notes || null })
    .eq("id", req.params.id)
    .eq("user_id", req.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

api.delete("/customers/:id", authMiddleware, async (req, res) => {
  const { error } = await supabaseAdmin
    .from("customers").delete().eq("id", req.params.id).eq("user_id", req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─────────────────────────────────────────────── BACKUP / EXPORT ───────────────

api.get("/backup/export", authMiddleware, async (req, res) => {
  const uid = req.userId;
  try {
    const [profile, categories, products, sales, stockAdjustments, bankAccounts, posTerminals, customers] = await Promise.all([
      supabaseAdmin.from("profiles").select("*").eq("id", uid).single().then((r) => r.data),
      fetchAllRows((f, t) => supabaseAdmin.from("categories").select("*").eq("user_id", uid).range(f, t)),
      fetchAllRows((f, t) => supabaseAdmin.from("products").select("*").eq("user_id", uid).range(f, t)),
      fetchAllRows((f, t) => supabaseAdmin.from("sales").select("*").eq("user_id", uid).range(f, t)),
      fetchAllRows((f, t) => supabaseAdmin.from("stock_adjustments").select("*").eq("user_id", uid).range(f, t)),
      fetchAllRows((f, t) => supabaseAdmin.from("bank_accounts").select("*").eq("user_id", uid).range(f, t)),
      fetchAllRows((f, t) => supabaseAdmin.from("pos_terminals").select("*").eq("user_id", uid).range(f, t)),
      fetchAllRows((f, t) => supabaseAdmin.from("customers").select("*").eq("user_id", uid).range(f, t)),
    ]);

    res.json({
      exported_at: new Date().toISOString(),
      profile, categories, products, sales,
      stock_adjustments: stockAdjustments, bank_accounts: bankAccounts,
      pos_terminals: posTerminals, customers,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────── SETTINGS ──────────────────────

api.get("/settings/bank-accounts", authMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("bank_accounts").select("*").eq("user_id", req.userId).order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

api.post("/settings/bank-accounts", authMiddleware, async (req, res) => {
  const { bank_name, account_number, account_name } = req.body;
  if (!bank_name || !account_number || !account_name)
    return res.status(400).json({ error: "Bank name, account number, and account name are all required." });

  const { data, error } = await supabaseAdmin
    .from("bank_accounts").insert({ user_id: req.userId, bank_name, account_number, account_name }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

api.delete("/settings/bank-accounts/:id", authMiddleware, async (req, res) => {
  const { error } = await supabaseAdmin
    .from("bank_accounts").delete().eq("id", req.params.id).eq("user_id", req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

api.get("/settings/pos-terminals", authMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("pos_terminals").select("*").eq("user_id", req.userId).order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

api.post("/settings/pos-terminals", authMiddleware, async (req, res) => {
  const { terminal_name, provider, terminal_id } = req.body;
  if (!terminal_name) return res.status(400).json({ error: "Terminal name is required." });

  const { data, error } = await supabaseAdmin
    .from("pos_terminals")
    .insert({ user_id: req.userId, terminal_name, provider: provider || null, terminal_id: terminal_id || null })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

api.delete("/settings/pos-terminals/:id", authMiddleware, async (req, res) => {
  const { error } = await supabaseAdmin
    .from("pos_terminals").delete().eq("id", req.params.id).eq("user_id", req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─────────────────────────────────────────────── HEALTH CHECK ──────────────────
api.get("/health", (_, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

// ═══════════════════════════════════════════════ MOUNT + STATIC FRONTEND ═══════
app.use("/api", api);

// Everything (CSS, JS, logo) is inlined inside index.html, so there are no
// other static asset files to serve — every non-API request just gets that
// one file.
// ── SERVICE WORKER (served directly, no separate file needed) ──────────────────
// Registering a real same-origin /sw.js URL is more reliable across browsers
// than the alternative "blob URL" trick, and this keeps the project at just
// two files. A basic network-first strategy: try the network, fall back to
// cache only when offline. This is what makes the site installable as an app.
app.get("/sw.js", (_, res) => {
  res.set("Content-Type", "application/javascript");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.send(`
    const CACHE_NAME = "storekeeper360-shell-v1";

    self.addEventListener("install", (event) => {
      self.skipWaiting();
    });

    self.addEventListener("activate", (event) => {
      event.waitUntil(
        caches.keys().then((keys) =>
          Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
      );
      self.clients.claim();
    });

    self.addEventListener("fetch", (event) => {
      // Never intercept API calls — those must always hit the network live.
      if (event.request.url.includes("/api/")) return;

      event.respondWith(
        fetch(event.request)
          .then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            return response;
          })
          .catch(() => caches.match(event.request))
      );
    });
  `);
});

app.get("*", (_, res) => {
  // Prevent browsers and any intermediary CDN from caching this page. Without
  // this, updates can appear not to take effect because an old cached copy
  // keeps getting served instead of the freshly deployed file.
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.sendFile(path.join(__dirname, "..", "index.html"));
});

// ═══════════════════════════════════════════════ EXPORT / LOCAL LISTEN ═════════
// On Vercel, this file is picked up automatically as a serverless function
// because it exports the Express app. Locally, running `node api/index.js`
// (or `npm start`) starts a normal listening server.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n🚀  StoreKeeper360 running at http://localhost:${PORT}`);
    console.log(`🗄️   Database: Supabase (${process.env.SUPABASE_URL || "NOT CONFIGURED"})\n`);
  });
}

module.exports = app;
