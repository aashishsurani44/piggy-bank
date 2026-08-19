/* =========================================================
   PIGGY-BANK — app.js

   Fill in firebaseConfig below with your Firebase project's
   web config. Everyone who uses the app (name, email, role)
   lives in the Realtime Database at /users — see the shape
   required in database.rules.json. Add them manually in the
   Firebase console; nothing here needs their details.
--------------------------------------------------------- */
const firebaseConfig = {
  apiKey: "AIzaSyCCwzgEy9nss_3LFHF20z8FzNf88RPDWLc",
  authDomain: "piggy-bank-b9765.firebaseapp.com",
  databaseURL: "https://piggy-bank-b9765-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "piggy-bank-b9765",
  storageBucket: "piggy-bank-b9765.firebasestorage.app",
  messagingSenderId: "537258140781",
  appId: "1:537258140781:web:2853b6c4909357c23fcb64"
};


const CURRENCY = "₹";
const DATA_RETENTION_DAYS = 366; // ~1 year; expenses & fund ledger entries older than this are pruned

// Stable palette used to color categories consistently across charts & badges.
const CHART_COLORS = [
  "#17B897", "#F2994A", "#EB5757", "#5B6EE1", "#BB6BD9",
  "#2F9E44", "#F2C94C", "#EE6C9E", "#3F7CAC", "#9B51E0",
  "#E8590C", "#0CA678"
];

// One gradient per calendar month (Jan..Dec) for the dashboard hero banner.
const MONTH_COLORS = [
  ["#3B2F63", "#8B5CF6"], ["#1E3A5F", "#3B82F6"], ["#0F3D3E", "#14B8A6"],
  ["#1B4332", "#22C55E"], ["#4D5A0A", "#84CC16"], ["#5C4A0A", "#EAB308"],
  ["#5C2E0A", "#F97316"], ["#5C1A1A", "#EF4444"], ["#5C0A3D", "#EC4899"],
  ["#3D0A5C", "#A855F7"], ["#0A2E5C", "#0EA5E9"], ["#0F332C", "#17B897"]
];

/* =========================================================
   FIREBASE INIT
   ========================================================= */
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});

/* =========================================================
   STATE
   ========================================================= */
let currentUser = null;      // { uid, name, email, role }
let usersDirectory = {};     // { uid: { name, email, role } } — loaded live from /users
let categoriesCache = {};    // { id: { name, createdAt } }
let expensesCache = {};      // { id: { amount, description, date, month, paidByUid, paidByName, categoryId, categoryName, paymentMode, fromWallet, comments, createdAt } }
let fundsCache = { bank: 0, cash: 0 };
let walletsCache = {};       // { uid: number }
let fundLedgerCache = {};    // { id: { type, amount, date, month, isCarryForward, isWalletTransfer, note, createdBy, createdAt } }

let selectedMonth = todayStr().slice(0, 7); // "YYYY-MM"
let currentView = "dashboard";
let charts = {};             // Chart.js instances keyed by canvas id
let listenersAttached = false;
let rolloverChecked = false;
let pruneScheduled = false;

/* =========================================================
   HELPERS
   ========================================================= */
function todayStr() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function currentMonthStr() { return todayStr().slice(0, 7); }

function formatCurrency(amount) {
  const n = Number(amount) || 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return sign + CURRENCY + abs.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 0 });
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function monthLabel(yyyymm) {
  const [y, m] = yyyymm.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("default", { month: "long", year: "numeric" });
}

function shiftMonth(yyyymm, delta) {
  const [y, m] = yyyymm.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}


function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colorForCategory(catId) {
  if (!catId) return "#9CA3AF";
  let hash = 0;
  for (let i = 0; i < catId.length; i++) hash = (hash * 31 + catId.charCodeAt(i)) >>> 0;
  return CHART_COLORS[hash % CHART_COLORS.length];
}

function categoryBadgeHtml(catId, name, small) {
  const cls = small ? "cat-badge cat-badge-sm" : "cat-badge";
  const letter = (name || "?").trim().charAt(0).toUpperCase() || "?";
  return `<span class="${cls}" style="background:${colorForCategory(catId)}">${letter}</span>`;
}

function userNameForUid(uid) {
  return (usersDirectory[uid] && usersDirectory[uid].name) || "Unknown";
}

function sortedUserIds() {
  return Object.keys(usersDirectory).sort((a, b) =>
    (usersDirectory[a].name || "").localeCompare(usersDirectory[b].name || ""));
}

let toastTimer = null;
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2400);
}

/* =========================================================
   LOGIN BRUTE-FORCE LOCKOUT (client-side, localStorage)
   ========================================================= */
const LOGIN_ATTEMPTS_KEY = "pb_login_attempts";
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

function getLoginAttemptState() {
  try {
    return JSON.parse(localStorage.getItem(LOGIN_ATTEMPTS_KEY)) || { count: 0, lockedUntil: 0 };
  } catch (e) { return { count: 0, lockedUntil: 0 }; }
}
function setLoginAttemptState(state) {
  try { localStorage.setItem(LOGIN_ATTEMPTS_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}
function recordFailedLogin() {
  const state = getLoginAttemptState();
  state.count = (state.count || 0) + 1;
  if (state.count >= MAX_LOGIN_ATTEMPTS) {
    state.lockedUntil = Date.now() + LOCKOUT_MS;
    state.count = 0;
  }
  setLoginAttemptState(state);
}
function clearLoginAttempts() { setLoginAttemptState({ count: 0, lockedUntil: 0 }); }
function loginLockoutRemainingMs() {
  const state = getLoginAttemptState();
  return Math.max(0, (state.lockedUntil || 0) - Date.now());
}
function lockoutMessage(remainingMs) {
  const mins = Math.max(1, Math.ceil(remainingMs / 60000));
  return `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
}

/* =========================================================
   USER DIRECTORY (public, read-only from the client)
   ========================================================= */
db.ref("users").on("value", snap => {
  usersDirectory = snap.val() || {};
  populateLoginDropdown();
  populateUserDropdowns();
  if (currentUser) {
    renderDashboard();
    if (currentView === "wallet") renderWalletPage();
  }
});

function populateLoginDropdown() {
  const sel = document.getElementById("loginUserSelect");
  const prev = sel.value;
  const ids = sortedUserIds();

  sel.innerHTML = `<option value="" disabled ${prev ? "" : "selected"}>Select your name</option>` +
    ids.map(uid => `<option value="${uid}">${escapeHtml(usersDirectory[uid].name)}</option>`).join("");

  if (ids.length === 0) {
    sel.insertAdjacentHTML("beforeend", `<option value="" disabled>No users found in /users yet</option>`);
  }
  if (ids.includes(prev)) sel.value = prev;
}

function populateUserDropdowns() {
  const ids = sortedUserIds();

  const paidBySel = document.getElementById("expensePaidBy");
  const prevPaidBy = paidBySel.value;
  paidBySel.innerHTML = ids.map(uid => `<option value="${uid}">${escapeHtml(usersDirectory[uid].name)}</option>`).join("");
  if (ids.includes(prevPaidBy)) paidBySel.value = prevPaidBy;

  const filterSel = document.getElementById("filterPaidBy");
  const prevFilter = filterSel.value;
  filterSel.innerHTML = `<option value="">All people</option>` +
    ids.map(uid => `<option value="${uid}">${escapeHtml(usersDirectory[uid].name)}</option>`).join("");
  filterSel.value = ids.includes(prevFilter) ? prevFilter : "";
}

/* =========================================================
   LOGIN
   ========================================================= */
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";

  const remaining = loginLockoutRemainingMs();
  if (remaining > 0) { errEl.textContent = lockoutMessage(remaining); return; }

  const uid = document.getElementById("loginUserSelect").value;
  const password = document.getElementById("loginPassword").value;

  if (!uid) { errEl.textContent = "Select who is signing in."; return; }
  const profile = usersDirectory[uid];
  if (!profile || !profile.email) { errEl.textContent = "No email on file for this user. Check /users in Firebase."; return; }

  const btn = document.getElementById("loginBtn");
  btn.disabled = true;
  btn.textContent = "Signing in…";

  try {
    await auth.signInWithEmailAndPassword(profile.email, password);
    clearLoginAttempts();
  } catch (err) {
    recordFailedLogin();
    const stillRemaining = loginLockoutRemainingMs();
    errEl.textContent = stillRemaining > 0 ? lockoutMessage(stillRemaining) : friendlyAuthError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});

function friendlyAuthError(err) {
  switch (err.code) {
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect password.";
    case "auth/user-not-found":
      return "No Firebase Auth account for this email yet.";
    case "auth/too-many-requests":
      return "Too many attempts. Try again in a bit.";
    default:
      return "Could not sign in. " + (err.message || "");
  }
}

document.getElementById("logoutBtn").addEventListener("click", () => auth.signOut());

auth.onAuthStateChanged(async (fbUser) => {
  if (fbUser) {
    let profile = usersDirectory[fbUser.uid];
    if (!profile) {
      try {
        const snap = await db.ref("users/" + fbUser.uid).once("value");
        profile = snap.val();
      } catch (e) { /* handled below */ }
    }
    if (!profile) {
      document.getElementById("loginError").textContent =
        "No profile found for this account. Add it under /users in Firebase (name, email, role).";
      await auth.signOut();
      return;
    }
    currentUser = { uid: fbUser.uid, name: profile.name, email: profile.email, role: profile.role === "admin" ? "admin" : "member" };
    enterApp();
  } else {
    currentUser = null;
    detachDataListeners();
    document.getElementById("appShell").classList.add("hidden");
    document.getElementById("loginView").classList.remove("hidden");
    document.getElementById("loginPassword").value = "";
  }
});

function enterApp() {
  document.getElementById("loginView").classList.add("hidden");
  document.getElementById("appShell").classList.remove("hidden");
  document.getElementById("headerUserName").textContent = currentUser.name;
  document.getElementById("navAdminBtn").classList.toggle("hidden", currentUser.role !== "admin");

  switchView("dashboard");
  attachDataListeners();
  loadMonthNotes();
  setTimeout(pruneOldData, 2500);
}

/* =========================================================
   VIEW SWITCHING
   ========================================================= */
const VIEW_LABELS = { dashboard: "Dashboard", analysis: "Analysis", wallet: "My Wallet", forecast: "Forecast", admin: "Admin" };

function switchView(view) {
  if (view === "admin" && currentUser.role !== "admin") view = "dashboard";
  currentView = view;
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-" + view).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  document.getElementById("headerViewLabel").textContent = VIEW_LABELS[view];

  if (view === "dashboard") renderDashboard();
  if (view === "analysis") { populateFilterYearOptions(); applyFilters(); }
  if (view === "wallet") renderWalletPage();
  if (view === "admin") { renderCategoryManageList(); renderFundsUI(); renderFundActivity(); }
}

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});
document.querySelectorAll(".hero-pill").forEach(btn => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

/* =========================================================
   DATA LISTENERS (realtime)
   ========================================================= */
function attachDataListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  db.ref("categories").on("value", snap => {
    categoriesCache = snap.val() || {};
    populateCategoryDropdowns();
    renderCategoryManageList();
    renderDashboard();
    if (currentView === "analysis") applyFilters();
  });

  db.ref("expenses").on("value", snap => {
  expensesCache = snap.val() || {};
  renderDashboard();
  populateFilterYearOptions();
  if (currentView === "analysis") applyFilters();
  if (!document.getElementById("allExpensesOverlay").classList.contains("hidden")) renderAllExpensesList();
  });

  db.ref("funds").on("value", snap => {
    fundsCache = snap.val() || { bank: 0, cash: 0 };
    renderDashboard();
    renderFundsUI();
    if (!rolloverChecked) {
      rolloverChecked = true;
      checkMonthRollover();
    }
  });

  db.ref("wallets").on("value", snap => {
    walletsCache = snap.val() || {};
    renderDashboard();
    renderWalletUI();
    renderWalletPage();
  });

  db.ref("fundLedger").on("value", snap => {
    fundLedgerCache = snap.val() || {};
    renderDashboard();
    renderFundActivity();
  });
}

function detachDataListeners() {
  if (!listenersAttached) return;
  db.ref("categories").off();
  db.ref("expenses").off();
  db.ref("funds").off();
  db.ref("wallets").off();
  db.ref("fundLedger").off();
  listenersAttached = false;
  rolloverChecked = false;
}

/* =========================================================
   MONTH-END CARRY FORWARD (automatic, once per real month)
   ========================================================= */
async function checkMonthRollover() {
  const nowMonth = currentMonthStr();
  let previousMonth = null;
  try {
    const result = await db.ref("systemState/lastFundMonth").transaction(current => {
      previousMonth = current;
      if (current === null) return nowMonth;
      if (current >= nowMonth) return; // already up to date — abort
      return nowMonth;
    });

    if (result.committed && previousMonth && previousMonth < nowMonth) {
      const label = monthLabel(previousMonth);

      const bankSpentPrev = Object.values(expensesCache)
        .filter(e => e.month === previousMonth && !e.fromWallet && e.paymentMode === "Bank")
        .reduce((s, e) => s + Number(e.amount || 0), 0);
      const cashSpentPrev = Object.values(expensesCache)
        .filter(e => e.month === previousMonth && !e.fromWallet && e.paymentMode === "Cash")
        .reduce((s, e) => s + Number(e.amount || 0), 0);

      // Leftover = whatever carried INTO that month + that month's own top-ups - that month's spend.
      const bankLeftover = carryForwardForMonth(previousMonth, "bank") + fundNetForMonth("bank", previousMonth) - bankSpentPrev;
      const cashLeftover = carryForwardForMonth(previousMonth, "cash") + fundNetForMonth("cash", previousMonth) - cashSpentPrev;

      const updates = {};
      if (bankLeftover !== 0) {
        const k = db.ref("fundLedger").push().key;
        updates["fundLedger/" + k] = {
          type: "bank", amount: bankLeftover, date: nowMonth + "-01", month: nowMonth,
          isCarryForward: true, note: "Carried forward from " + label,
          createdBy: currentUser.uid, createdAt: Date.now()
        };
      }
      if (cashLeftover !== 0) {
        const k = db.ref("fundLedger").push().key;
        updates["fundLedger/" + k] = {
          type: "cash", amount: cashLeftover, date: nowMonth + "-01", month: nowMonth,
          isCarryForward: true, note: "Carried forward from " + label,
          createdBy: currentUser.uid, createdAt: Date.now()
        };
      }
      if (Object.keys(updates).length) await db.ref().update(updates);
    }
  } catch (err) { /* non-critical background task */ }
}

/* =========================================================
   1-YEAR DATA RETENTION (prune older records client-side)
   ========================================================= */
function pruneOldData() {
  if (pruneScheduled) return;
  pruneScheduled = true;

  const cutoff = new Date(todayStr() + "T00:00:00");
  cutoff.setDate(cutoff.getDate() - DATA_RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const updates = {};
  Object.entries(expensesCache).forEach(([id, e]) => {
    if (e.date && e.date < cutoffStr) updates["expenses/" + id] = null;
  });
  Object.entries(fundLedgerCache).forEach(([id, r]) => {
    if (r.date && r.date < cutoffStr) updates["fundLedger/" + id] = null;
  });

  if (Object.keys(updates).length) {
    db.ref().update(updates).catch(() => {});
  }
}

/* =========================================================
   CATEGORY DROPDOWNS
   ========================================================= */
function populateCategoryDropdowns() {
  const ids = Object.keys(categoriesCache).sort((a, b) =>
    (categoriesCache[a].name || "").localeCompare(categoriesCache[b].name || ""));

  const expSel = document.getElementById("expenseCategory");
  const prevExp = expSel.value;
  expSel.innerHTML = ids.map(id => `<option value="${id}">${escapeHtml(categoriesCache[id].name)}</option>`).join("");
  if (ids.includes(prevExp)) expSel.value = prevExp;

  const filterSel = document.getElementById("filterCategory");
  const prevFilter = filterSel.value;
  filterSel.innerHTML = `<option value="">All categories</option>` +
    ids.map(id => `<option value="${id}">${escapeHtml(categoriesCache[id].name)}</option>`).join("");
  filterSel.value = prevFilter;
}

/* =========================================================
   DASHBOARD (month-scoped)
   ========================================================= */
document.getElementById("prevMonthBtn").addEventListener("click", () => {
  selectedMonth = shiftMonth(selectedMonth, -1);
  renderDashboard();
  loadMonthNotes();
});
document.getElementById("nextMonthBtn").addEventListener("click", () => {
  const candidate = shiftMonth(selectedMonth, 1);
  if (candidate > currentMonthStr()) return; // never go into the future
  selectedMonth = candidate;
  renderDashboard();
  loadMonthNotes();
});

function updateMonthNavButtons() {
  document.getElementById("nextMonthBtn").disabled = selectedMonth === currentMonthStr();
}

function applyHeroColor() {
  const idx = parseInt(selectedMonth.split("-")[1], 10) - 1;
  const [from, to] = MONTH_COLORS[((idx % 12) + 12) % 12];
  const el = document.getElementById("heroBanner");
  if (el) el.style.background = `linear-gradient(155deg, ${from}, ${to})`;
}

function setStatValue(elId, value) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = formatCurrency(value);
  el.classList.toggle("negative", value < 0);
}

// Net ledger activity (top-ups/corrections/wallet-transfers, excluding carry-forward markers) for one month.
function fundNetForMonth(type, yyyymm) {
  let total = 0;
  Object.values(fundLedgerCache).forEach(r => {
    if (r.type === type && !r.isCarryForward && r.month === yyyymm) total += Number(r.amount);
  });
  return total;
}

// Amount automatically carried in at the start of a month (from the previous month's leftover).
// Pass a type ("bank"/"cash") to get just that fund's carry-in, or omit for the combined total.
function carryForwardForMonth(yyyymm, type) {
  let total = 0;
  Object.values(fundLedgerCache).forEach(r => {
    if (r.isCarryForward && r.month === yyyymm && (!type || r.type === type)) total += Number(r.amount);
  });
  return total;
}

// DELETE the monthEndDate() and fundBalanceAsOfMonthEnd() functions entirely — no longer used.

// REPLACE renderDashboard() with:
function renderDashboard() {
  if (!currentUser) return;
  document.getElementById("currentMonthLabel").textContent = monthLabel(selectedMonth);
  updateMonthNavButtons();
  applyHeroColor();

  const spentThisMonth = Object.values(expensesCache)
    .filter(e => e.month === selectedMonth)
    .reduce((sum, e) => sum + Number(e.amount || 0), 0);
  document.getElementById("statTotalExpense").textContent = formatCurrency(spentThisMonth);

  const bankAdded = fundNetForMonth("bank", selectedMonth);
  const cashAdded = fundNetForMonth("cash", selectedMonth);
  setStatValue("statBank", bankAdded);
  setStatValue("statCash", cashAdded);

// Available for this month: whatever carried in from last month, plus this month's
  // own added amounts, minus this month's spend.
  const carriedIn = carryForwardForMonth(selectedMonth);
  const available = carriedIn + bankAdded + cashAdded - spentThisMonth;
  setStatValue("statTotalAvailable", available);

  const walletBal = Number((walletsCache && walletsCache[currentUser.uid]) || 0);
  setStatValue("statWallet", walletBal);

  renderRecentExpenses();
}

function renderRecentExpenses() {
  const all = Object.entries(expensesCache)
    .sort((a, b) => (b[1].date + (b[1].createdAt || 0)).localeCompare(a[1].date + (a[1].createdAt || 0)))
    .slice(0, 8);

  const container = document.getElementById("recentExpensesList");
  if (all.length === 0) {
    container.innerHTML = `<p class="empty-hint">No expenses logged yet — tap + to add one.</p>`;
    return;
  }
  container.innerHTML = all.map(([id, e]) => expenseRowHtml(id, e)).join("");
  container.querySelectorAll(".expense-row").forEach(row => {
    row.addEventListener("click", () => openExpenseForm("edit", row.dataset.id));
  });
}

document.getElementById("viewAllExpensesBtn").addEventListener("click", () => {
  renderAllExpensesList();
  document.getElementById("allExpensesOverlay").classList.remove("hidden");
});
document.getElementById("closeAllExpensesBtn").addEventListener("click", () => {
  document.getElementById("allExpensesOverlay").classList.add("hidden");
});
document.getElementById("allExpensesOverlay").addEventListener("click", (e) => {
  if (e.target.id === "allExpensesOverlay") document.getElementById("allExpensesOverlay").classList.add("hidden");
});

function renderAllExpensesList() {
  const all = Object.entries(expensesCache)
    .sort((a, b) => (b[1].date + (b[1].createdAt || 0)).localeCompare(a[1].date + (a[1].createdAt || 0)));

  const container = document.getElementById("allExpensesList");
  if (all.length === 0) {
    container.innerHTML = `<p class="empty-hint">No expenses logged yet.</p>`;
    return;
  }
  container.innerHTML = all.map(([id, e]) => expenseRowHtml(id, e)).join("");
  container.querySelectorAll(".expense-row").forEach(row => {
    row.addEventListener("click", () => {
      document.getElementById("allExpensesOverlay").classList.add("hidden");
      openExpenseForm("edit", row.dataset.id);
    });
  });
}

function expenseRowHtml(id, e) {
  const walletTag = e.fromWallet ? " · Wallet" : "";
  return `
    <button type="button" class="expense-row" data-id="${id}">
      ${categoryBadgeHtml(e.categoryId, e.categoryName)}
      <span class="expense-info">
        <span class="expense-desc">${escapeHtml(e.description)}</span>
        <span class="expense-meta">${escapeHtml(e.categoryName)} · ${escapeHtml(e.paidByName)} · ${formatDate(e.date)}${walletTag}</span>
      </span>
      <span class="expense-amount">${formatCurrency(e.amount)}</span>
    </button>`;
}

/* =========================================================
   MONTH NOTES
   ========================================================= */
function loadMonthNotes() {
  document.getElementById("notesMonthLabel").textContent = monthLabel(selectedMonth);
  db.ref("monthlyNotes/" + selectedMonth).once("value").then(snap => {
    const data = snap.val();
    document.getElementById("monthNotesInput").value = data ? (data.text || "") : "";
  });
}

document.getElementById("saveMonthNotesBtn").addEventListener("click", () => {
  const text = document.getElementById("monthNotesInput").value.trim();
  db.ref("monthlyNotes/" + selectedMonth).set({
    text, updatedAt: Date.now(), updatedBy: currentUser.uid
  }).then(() => toast("Note saved")).catch(() => toast("Could not save note"));
});

/* =========================================================
   EXPENSE FORM (add / edit / delete)
   ========================================================= */
const expenseOverlay = document.getElementById("expenseOverlay");

function poolPathFor(paidByUid, paymentMode, fromWallet) {
  if (fromWallet) return "wallets/" + paidByUid;
  return paymentMode === "Cash" ? "funds/cash" : "funds/bank";
}

function openExpenseForm(mode, id) {
  document.getElementById("expenseFormError").textContent = "";
  const deleteBtn = document.getElementById("deleteExpenseBtn");

  if (mode === "add") {
    document.getElementById("expenseFormTitle").textContent = "Add expense";
    document.getElementById("expenseId").value = "";
    document.getElementById("expenseAmount").value = "";
    document.getElementById("expenseDescription").value = "";
    document.getElementById("expenseDate").value = todayStr();
    document.getElementById("expensePaidBy").value = currentUser.uid;
    document.getElementById("expensePaymentMode").value = "Cash";
    document.getElementById("expenseFromWallet").checked = false;
    document.getElementById("expenseComments").value = "";
    if (document.getElementById("expenseCategory").options.length > 0) {
      document.getElementById("expenseCategory").selectedIndex = 0;
    }
    deleteBtn.classList.add("hidden");
  } else {
    const e = expensesCache[id];
    if (!e) return;
    document.getElementById("expenseFormTitle").textContent = "Edit expense";
    document.getElementById("expenseId").value = id;
    document.getElementById("expenseAmount").value = e.amount;
    document.getElementById("expenseDescription").value = e.description;
    document.getElementById("expenseDate").value = e.date;
    document.getElementById("expensePaidBy").value = e.paidByUid;
    document.getElementById("expenseCategory").value = e.categoryId;
    document.getElementById("expensePaymentMode").value = e.paymentMode;
    document.getElementById("expenseFromWallet").checked = !!e.fromWallet;
    document.getElementById("expenseComments").value = e.comments || "";
    deleteBtn.classList.remove("hidden");
  }

  expenseOverlay.classList.remove("hidden");
}

function closeExpenseForm() { expenseOverlay.classList.add("hidden"); }

document.getElementById("fabAddExpense").addEventListener("click", () => {
  if (Object.keys(categoriesCache).length === 0) {
    toast("Ask the admin to add a category first");
    return;
  }
  openExpenseForm("add");
});
document.getElementById("closeExpenseFormBtn").addEventListener("click", closeExpenseForm);
expenseOverlay.addEventListener("click", (e) => { if (e.target === expenseOverlay) closeExpenseForm(); });

document.getElementById("expenseForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("expenseFormError");
  errEl.textContent = "";

  const id = document.getElementById("expenseId").value;
  const amount = parseFloat(document.getElementById("expenseAmount").value);
  const description = document.getElementById("expenseDescription").value.trim();
  const date = document.getElementById("expenseDate").value;
  const paidByUid = document.getElementById("expensePaidBy").value;
  const categoryId = document.getElementById("expenseCategory").value;
  const paymentMode = document.getElementById("expensePaymentMode").value;
  const fromWallet = document.getElementById("expenseFromWallet").checked;
  const comments = document.getElementById("expenseComments").value.trim();

  if (!amount || amount <= 0) { errEl.textContent = "Enter an amount greater than 0."; return; }
  if (!description) { errEl.textContent = "Enter a description."; return; }
  if (!date) { errEl.textContent = "Pick a date."; return; }
  if (!categoryId) { errEl.textContent = "Pick a category."; return; }
  if (!paidByUid) { errEl.textContent = "Pick who paid."; return; }

  const saveBtn = document.getElementById("saveExpenseBtn");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";

  const expenseObj = {
    amount,
    description,
    date,
    month: date.slice(0, 7),
    paidByUid,
    paidByName: userNameForUid(paidByUid),
    categoryId,
    categoryName: categoriesCache[categoryId] ? categoriesCache[categoryId].name : "Uncategorized",
    paymentMode,
    fromWallet,
    comments,
    createdBy: currentUser.uid,
    createdAt: id && expensesCache[id] ? expensesCache[id].createdAt : Date.now(),
    updatedAt: Date.now()
  };

  const newPool = poolPathFor(paidByUid, paymentMode, fromWallet);
  const updates = {};

  try {
    if (id) {
      const old = expensesCache[id];
      const oldPool = poolPathFor(old.paidByUid, old.paymentMode, !!old.fromWallet);
      updates["expenses/" + id] = expenseObj;
      if (oldPool === newPool) {
        updates[oldPool] = firebase.database.ServerValue.increment(Number(old.amount) - amount);
      } else {
        updates[oldPool] = firebase.database.ServerValue.increment(Number(old.amount));
        updates[newPool] = firebase.database.ServerValue.increment(-amount);
      }
    } else {
      const newKey = db.ref("expenses").push().key;
      updates["expenses/" + newKey] = expenseObj;
      updates[newPool] = firebase.database.ServerValue.increment(-amount);
    }

    await db.ref().update(updates);
    toast(id ? "Expense updated" : "Expense added");
    closeExpenseForm();
  } catch (err) {
    errEl.textContent = "Could not save. " + (err.message || "");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
  }
});

document.getElementById("deleteExpenseBtn").addEventListener("click", async () => {
  const id = document.getElementById("expenseId").value;
  if (!id) return;
  if (!confirm("Delete this expense? The amount will be added back to its fund or wallet.")) return;

  const e = expensesCache[id];
  const pool = poolPathFor(e.paidByUid, e.paymentMode, !!e.fromWallet);
  const updates = {};
  updates["expenses/" + id] = null;
  updates[pool] = firebase.database.ServerValue.increment(Number(e.amount));

  try {
    await db.ref().update(updates);
    toast("Expense deleted");
    closeExpenseForm();
  } catch (err) {
    toast("Could not delete expense");
  }
});

/* =========================================================
   ANALYSIS (filters + spend-by-category only)
   ========================================================= */
function populateFilterYearOptions() {
  const years = new Set(Object.values(expensesCache).map(e => e.date.slice(0, 4)));
  years.add(String(new Date().getFullYear()));
  const sorted = Array.from(years).sort((a, b) => b.localeCompare(a));

  const sel = document.getElementById("filterYear");
  const prev = sel.value;
  sel.innerHTML = `<option value="">All years</option>` +
    sorted.map(y => `<option value="${y}">${y}</option>`).join("");
  sel.value = sorted.includes(prev) ? prev : "";
}

document.getElementById("applyFiltersBtn").addEventListener("click", applyFilters);

function getFilteredExpenses() {
  const year = document.getElementById("filterYear").value;
  const month = document.getElementById("filterMonth").value;
  const categoryId = document.getElementById("filterCategory").value;
  const paymentMode = document.getElementById("filterPaymentMode").value;
  const paidByUid = document.getElementById("filterPaidBy").value;

  return Object.entries(expensesCache).filter(([, e]) => {
    if (year && e.date.slice(0, 4) !== year) return false;
    if (month && e.date.slice(5, 7) !== month) return false;
    if (categoryId && e.categoryId !== categoryId) return false;
    if (paymentMode && e.paymentMode !== paymentMode) return false;
    if (paidByUid && e.paidByUid !== paidByUid) return false;
    return true;
  });
}

function applyFilters() {
  renderCategoryBreakdown(getFilteredExpenses());
}

function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

function renderCategoryBreakdown(list) {
  const totals = {};
  list.forEach(([, e]) => {
    if (!totals[e.categoryId]) totals[e.categoryId] = { name: e.categoryName, total: 0 };
    totals[e.categoryId].total += Number(e.amount);
  });
  const rows = Object.entries(totals).sort((a, b) => b[1].total - a[1].total);
  const grand = rows.reduce((s, [, v]) => s + v.total, 0);

  const listEl = document.getElementById("categoryBreakdownList");
  destroyChart("categoryPieChart");

  if (rows.length === 0) {
    listEl.innerHTML = `<p class="empty-hint">No expenses match these filters.</p>`;
    return;
  }

  listEl.innerHTML = rows.map(([catId, v]) => `
    <div class="breakdown-row">
      ${categoryBadgeHtml(catId, v.name, true)}
      <span class="breakdown-name">${escapeHtml(v.name)}</span>
      <span class="breakdown-pct">${grand ? Math.round((v.total / grand) * 100) : 0}%</span>
      <span class="breakdown-amount">${formatCurrency(v.total)}</span>
    </div>`).join("");

  const ctx = document.getElementById("categoryPieChart").getContext("2d");
  charts.categoryPieChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: rows.map(([, v]) => v.name),
      datasets: [{ data: rows.map(([, v]) => v.total), backgroundColor: rows.map(([id]) => colorForCategory(id)), borderWidth: 0 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });
}

/* =========================================================
   FORECAST
   ========================================================= */
document.getElementById("generateForecastBtn").addEventListener("click", () => {
  const errEl = document.getElementById("forecastError");
  errEl.textContent = "";

  const lookback = document.getElementById("forecastLookback").value;
  const amount = parseFloat(document.getElementById("forecastAmount").value);

  if (!amount || amount <= 0) { errEl.textContent = "Enter an amount greater than 0."; return; }

  let fromDate = null;
  if (lookback !== "all") {
    const months = parseInt(lookback, 10);
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    fromDate = d.toISOString().slice(0, 10);
  }

  const relevant = Object.values(expensesCache).filter(e => !fromDate || e.date >= fromDate);
  if (relevant.length === 0) {
    document.getElementById("forecastResultCard").classList.add("hidden");
    errEl.textContent = "Not enough expense history yet for this period.";
    return;
  }

  const catTotals = {};
  let grandTotal = 0;
  relevant.forEach(e => {
    catTotals[e.categoryId] = (catTotals[e.categoryId] || 0) + Number(e.amount);
    grandTotal += Number(e.amount);
  });

  const breakdown = Object.entries(catTotals).map(([catId, total]) => {
    const pct = grandTotal ? total / grandTotal : 0;
    return {
      catId,
      name: (categoriesCache[catId] && categoriesCache[catId].name) || "Uncategorized",
      pct,
      amount: pct * amount
    };
  }).sort((a, b) => b.pct - a.pct);

  renderForecastResult(breakdown);
});

function renderForecastResult(breakdown) {
  document.getElementById("forecastResultCard").classList.remove("hidden");

  const listEl = document.getElementById("forecastBreakdownList");
  listEl.innerHTML = breakdown.map(b => `
    <div class="breakdown-row">
      ${categoryBadgeHtml(b.catId, b.name, true)}
      <span class="breakdown-name">${escapeHtml(b.name)}</span>
      <span class="breakdown-pct">${Math.round(b.pct * 100)}%</span>
      <span class="breakdown-amount">${formatCurrency(b.amount)}</span>
    </div>`).join("");

  destroyChart("forecastChart");
  const ctx = document.getElementById("forecastChart").getContext("2d");
  charts.forecastChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: breakdown.map(b => b.name),
      datasets: [{ data: breakdown.map(b => b.amount), backgroundColor: breakdown.map(b => colorForCategory(b.catId)), borderWidth: 0 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });
}

/* =========================================================
   WALLET PAGE (self top-up moves money out of shared cash)
   ========================================================= */
// REPLACE the walletSelfAdjustBtn click handler's opening lines — add the admin guard:
document.getElementById("walletSelfAdjustBtn").addEventListener("click", async () => {
  if (currentUser.role !== "admin") { toast("Only admin can edit wallet amounts"); return; }
  const input = document.getElementById("walletSelfAdjustInput");
  const delta = parseFloat(input.value);
  if (!delta) { toast("Enter a non-zero amount"); return; }
  try {
    const ledgerKey = db.ref("fundLedger").push().key;
    const updates = {};
    updates["wallets/" + currentUser.uid] = firebase.database.ServerValue.increment(delta);
    updates["funds/cash"] = firebase.database.ServerValue.increment(-delta);
    updates["fundLedger/" + ledgerKey] = {
      type: "cash", amount: -delta, date: todayStr(), month: currentMonthStr(),
      isCarryForward: false, isWalletTransfer: true,
      note: (delta > 0 ? "Wallet top-up — " : "Wallet withdrawal — ") + currentUser.name,
      createdBy: currentUser.uid, createdAt: Date.now()
    };
    await db.ref().update(updates);
    input.value = "";
    toast("Wallet updated");
  } catch (err) {
    toast("Could not update wallet");
  }
});

// REPLACE the start of renderWalletPage() — add the show/hide toggle:
function renderWalletPage() {
  if (!currentUser) return;
  const isAdmin = currentUser.role === "admin";
  document.getElementById("walletSelfEditWrap").classList.toggle("hidden", !isAdmin);
  document.getElementById("walletAdminOnlyNote").classList.toggle("hidden", isAdmin);

  const mine = Number((walletsCache && walletsCache[currentUser.uid]) || 0);
  document.getElementById("myWalletBalance").textContent = formatCurrency(mine);

  const ids = sortedUserIds();
  const listEl = document.getElementById("allWalletsList");
  listEl.innerHTML = ids.length
    ? ids.map(uid => `
        <div class="wallet-row">
          <span class="wallet-name">${escapeHtml(usersDirectory[uid].name)}${uid === currentUser.uid ? " (you)" : ""}</span>
          <span class="wallet-balance">${formatCurrency((walletsCache && walletsCache[uid]) || 0)}</span>
        </div>`).join("")
    : `<p class="empty-hint">No users found in /users yet.</p>`;
}

/* =========================================================
   ADMIN — categories
   ========================================================= */
document.getElementById("addCategoryBtn").addEventListener("click", async () => {
  const input = document.getElementById("newCategoryInput");
  const name = input.value.trim();
  if (!name) return;

  const exists = Object.values(categoriesCache).some(c => (c.name || "").toLowerCase() === name.toLowerCase());
  if (exists) { toast("That category already exists"); return; }

  try {
    await db.ref("categories").push({ name, createdAt: Date.now() });
    input.value = "";
    toast("Category added");
  } catch (err) {
    toast("Could not add category");
  }
});

function renderCategoryManageList() {
  const el = document.getElementById("categoryManageList");
  const ids = Object.keys(categoriesCache).sort((a, b) => (categoriesCache[a].name || "").localeCompare(categoriesCache[b].name || ""));

  el.innerHTML = ids.length
    ? ids.map(id => `
        <div class="manage-row">
          ${categoryBadgeHtml(id, categoriesCache[id].name, true)}
          <span class="manage-row-name">${escapeHtml(categoriesCache[id].name)}</span>
          <button type="button" class="manage-row-remove" data-id="${id}" aria-label="Delete category">✕</button>
        </div>`).join("")
    : `<p class="empty-hint">No categories yet — add the first one above.</p>`;

  el.querySelectorAll(".manage-row-remove").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm(`Delete category "${categoriesCache[btn.dataset.id].name}"? Past expenses keep their category name.`)) return;
      try {
        await db.ref("categories/" + btn.dataset.id).remove();
        toast("Category deleted");
      } catch (err) {
        toast("Could not delete category");
      }
    });
  });
}

/* =========================================================
   ADMIN — funds (dated top-ups, logged to fundLedger)
   ========================================================= */
function renderFundsUI() {
  document.getElementById("adminBankBalance").textContent = formatCurrency(fundsCache.bank || 0);
}

document.getElementById("updateBankBtn").addEventListener("click", () => adjustFund("bank", "bankAdjustInput", "bankAdjustDate"));
document.getElementById("updateCashBtn").addEventListener("click", () => adjustFund("cash", "cashAdjustInput", "cashAdjustDate"));

async function adjustFund(path, inputId, dateInputId) {
  const input = document.getElementById(inputId);
  const dateInput = document.getElementById(dateInputId);
  const delta = parseFloat(input.value);
  const date = dateInput.value || todayStr();
  if (!delta) { toast("Enter a non-zero amount"); return; }

  try {
    const ledgerKey = db.ref("fundLedger").push().key;
    const updates = {};
    updates["funds/" + path] = firebase.database.ServerValue.increment(delta);
    updates["fundLedger/" + ledgerKey] = {
      type: path, amount: delta, date, month: date.slice(0, 7),
      isCarryForward: false, isWalletTransfer: false,
      createdBy: currentUser.uid, createdAt: Date.now()
    };
    await db.ref().update(updates);
    input.value = "";
    toast((path === "bank" ? "Bank" : "Cash") + " balance updated");
  } catch (err) {
    toast("Could not update balance");
  }
}

function renderFundActivity() {
  const el = document.getElementById("fundActivityList");
  if (!el) return;

  const rows = Object.entries(fundLedgerCache)
    .sort((a, b) => (b[1].date + b[1].createdAt).localeCompare(a[1].date + a[1].createdAt))
    .slice(0, 30);

  if (rows.length === 0) {
    el.innerHTML = `<p class="empty-hint">No fund activity yet.</p>`;
    return;
  }

  el.innerHTML = rows.map(([id, r]) => {
    const label = r.note || `${r.type === "bank" ? "Bank" : "Cash"} ${Number(r.amount) >= 0 ? "top-up" : "correction"}`;
    const positive = Number(r.amount) >= 0;
    return `
      <div class="expense-row fund-row-static">
        ${categoryBadgeHtml(r.type, r.type === "bank" ? "Bank" : "Cash", false)}
        <span class="expense-info">
          <span class="expense-desc">${escapeHtml(label)}</span>
          <span class="expense-meta">${r.type === "bank" ? "Bank" : "Cash"} · ${formatDate(r.date)}</span>
        </span>
        <span class="expense-amount" style="color:${positive ? "var(--primary)" : "var(--negative)"}">${positive ? "+" : "-"}${formatCurrency(Math.abs(r.amount))}</span>
      </div>`;
  }).join("");
}

/* =========================================================
   ADMIN — wallets (admin can adjust anyone's, also moves cash)
   ========================================================= */
function renderWalletUI() {
  const el = document.getElementById("walletManageList");
  const ids = sortedUserIds();

  el.innerHTML = ids.length
    ? ids.map(uid => `
      <div class="wallet-row">
        <span class="wallet-name">${escapeHtml(usersDirectory[uid].name)}</span>
        <span class="wallet-balance">${formatCurrency((walletsCache && walletsCache[uid]) || 0)}</span>
        <div class="inline-form">
          <input type="text" step="0.01" placeholder="Amount (+/-)" id="walletInput-${uid}" inputmode="decimal">
          <button type="button" class="btn-secondary" data-uid="${uid}" data-action="wallet-update">Update</button>
        </div>
      </div>`).join("")
    : `<p class="empty-hint">No users found in /users yet.</p>`;

  el.querySelectorAll('[data-action="wallet-update"]').forEach(btn => {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.uid;
      const input = document.getElementById("walletInput-" + uid);
      const delta = parseFloat(input.value);
      if (!delta) { toast("Enter a non-zero amount"); return; }
      try {
        const ledgerKey = db.ref("fundLedger").push().key;
        const updates = {};
        updates["wallets/" + uid] = firebase.database.ServerValue.increment(delta);
        updates["funds/cash"] = firebase.database.ServerValue.increment(-delta);
        updates["fundLedger/" + ledgerKey] = {
          type: "cash", amount: -delta, date: todayStr(), month: currentMonthStr(),
          isCarryForward: false, isWalletTransfer: true,
          note: (delta > 0 ? "Wallet top-up — " : "Wallet withdrawal — ") + userNameForUid(uid),
          createdBy: currentUser.uid, createdAt: Date.now()
        };
        await db.ref().update(updates);
        input.value = "";
        toast("Wallet updated");
      } catch (err) {
        toast("Could not update wallet");
      }
    });
  });
}

/* =========================================================
   BOOT
   ========================================================= */
populateLoginDropdown();
document.getElementById("bankAdjustDate").value = todayStr();
document.getElementById("cashAdjustDate").value = todayStr();

(function initLockoutNotice() {
  const remaining = loginLockoutRemainingMs();
  if (remaining > 0) document.getElementById("loginError").textContent = lockoutMessage(remaining);
})();
