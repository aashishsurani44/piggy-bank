// ============================================================
// Split-Rupee — App logic (single-page app, one file)
// ============================================================

// ------------------------------------------------------------
// Firebase configuration
// Replace every value below with the config object from:
// Firebase Console → Project Settings → General → Your apps → SDK setup
// ------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyBBvRNKV3e9ZPgBoduT2HNr2xnAEY4dlbg",
  authDomain: "split-rupee.firebaseapp.com",
  databaseURL: "https://split-rupee-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "split-rupee",
  storageBucket: "split-rupee.firebasestorage.app",
  messagingSenderId: "802313510158",
  appId: "1:802313510158:web:6a5f26fa88b388a3240b5f"
};

const FIREBASE_NOT_CONFIGURED = !firebaseConfig || firebaseConfig.apiKey === 'YOUR_API_KEY';

if (!FIREBASE_NOT_CONFIGURED) {
  firebase.initializeApp(firebaseConfig);
}
const auth = FIREBASE_NOT_CONFIGURED ? null : firebase.auth();
const db = FIREBASE_NOT_CONFIGURED ? null : firebase.database();

// ---------- Global state ----------
let currentUser = null;
let currentUserData = null;

// Brute-force login protection (persisted in localStorage, per email)
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes
let lockoutInterval = null;

// Dashboard realtime state
let groupListeners = {};    // groupId -> { groupRef, expensesRef }
let groupsSnapshot = {};    // groupId -> group data
let expensesSnapshot = {};  // groupId -> expenses object
let allUsersCache = {};
let selectedMembers = new Set();

// Group screen state
let currentGroupId = null;
let groupReturnScreen = 'dashboard';
let groupData = null;
let groupMembersData = {};
let categoriesCache = {};
let expensesCache = {};
let currentSplitType = 'equal';
let editingExpenseId = null;
let currentDetailExpenseId = null;
let selectedNewMembers = new Set();
let groupDataRef = null;
let groupExpensesRef = null;
let groupCategoriesRef = null;

// Admin screen state
let adminCategoriesRef = null;
let adminGroupsRef = null;

// Personal expenses state
let categoriesRef = null;
let personalExpensesCache = {};
let personalExpensesRef = null;
let editingPersonalExpenseId = null;
let currentPersonalDetailId = null;
let personalSplitGroupMembersData = {};
let walletRef = null;
let walletData = null; // null = wallet not set up

// ============================================================
// Boot
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  if (FIREBASE_NOT_CONFIGURED) {
    showScreen('setup');
    return;
  }

  wireStaticEvents();

  auth.onAuthStateChanged(user => {
    if (!user) {
      teardownListeners();
      currentUser = null;
      currentUserData = null;
      showScreen('login');
      return;
    }
    db.ref('users/' + user.uid).once('value').then(snap => {
      const userData = snap.val();
      if (!userData) { showScreen('login'); return; }
      currentUser = user;
      currentUserData = userData;
      initAppShell(userData);
      showScreen('dashboard');
      loadDashboardData();
      loadCategoriesGlobal();
      loadPersonalExpenses();
      loadWallet();
    }).catch(() => showScreen('login'));
  });
});

// ============================================================
// Screen router
// ============================================================

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');

  const showNav = ['dashboard', 'group', 'account', 'admin', 'personal'].includes(name);
  document.getElementById('bottomNav').classList.toggle('hidden', !showNav);
  document.querySelectorAll('.nav-item[data-screen]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.screen === name);
  });
  window.scrollTo(0, 0);
}

// ============================================================
// Shared helpers
// ============================================================

function formatCurrency(amount) {
  const num = Number(amount) || 0;
  const sign = num < 0 ? '-' : '';
  return sign + '₹' + Math.abs(num).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateShort(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function showToast(msg, isError) {
  let toast = document.getElementById('toast');
  if (!toast) { toast = document.createElement('div'); toast.id = 'toast'; document.body.appendChild(toast); }
  toast.textContent = msg;
  toast.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(window._toastTimeout);
  window._toastTimeout = setTimeout(() => { toast.className = 'toast'; }, 3000);
}

function colorIndexForString(str) {
  let hash = 0;
  const s = str || '?';
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return hash % 8;
}
function avatarHtml(name, sizeClass) {
  const idx = colorIndexForString(name);
  return `<div class="avatar-circle avatar-c${idx} ${sizeClass || ''}">${escapeHtml((name || '?').charAt(0).toUpperCase())}</div>`;
}
function bannerClass(name) { return 'banner-c' + colorIndexForString(name); }

function calculateBalances(expenses, memberIds) {
  const balances = {};
  (memberIds || []).forEach(id => { balances[id] = 0; });
  Object.values(expenses || {}).forEach(exp => {
    if (!exp || !exp.splitAmong || !exp.paidBy) return;
    if (balances[exp.paidBy] === undefined) balances[exp.paidBy] = 0;
    balances[exp.paidBy] += Number(exp.amount) || 0;
    Object.entries(exp.splitAmong).forEach(([uid, share]) => {
      if (balances[uid] === undefined) balances[uid] = 0;
      balances[uid] -= Number(share) || 0;
    });
  });
  return balances;
}

function simplifyDebts(balances) {
  const creditors = [], debtors = [];
  Object.entries(balances).forEach(([uid, amt]) => {
    const rounded = Math.round(amt * 100) / 100;
    if (rounded > 0.01) creditors.push({ uid, amt: rounded });
    else if (rounded < -0.01) debtors.push({ uid, amt: -rounded });
  });
  creditors.sort((a, b) => b.amt - a.amt);
  debtors.sort((a, b) => b.amt - a.amt);

  const transactions = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i], creditor = creditors[j];
    const amount = Math.round(Math.min(debtor.amt, creditor.amt) * 100) / 100;
    if (amount > 0.01) transactions.push({ from: debtor.uid, to: creditor.uid, amount });
    debtor.amt = Math.round((debtor.amt - amount) * 100) / 100;
    creditor.amt = Math.round((creditor.amt - amount) * 100) / 100;
    if (debtor.amt <= 0.01) i++;
    if (creditor.amt <= 0.01) j++;
  }
  return transactions;
}

function hideModal(id) { document.getElementById(id).classList.add('hidden'); }
function showModal(id) { document.getElementById(id).classList.remove('hidden'); }

function teardownListeners() {
  Object.values(groupListeners).forEach(l => { l.groupRef.off(); l.expensesRef.off(); });
  groupListeners = {}; groupsSnapshot = {}; expensesSnapshot = {};
  if (groupDataRef) { groupDataRef.off(); groupDataRef = null; }
  if (groupExpensesRef) { groupExpensesRef.off(); groupExpensesRef = null; }
  if (groupCategoriesRef) { groupCategoriesRef.off(); groupCategoriesRef = null; }
  if (adminCategoriesRef) { adminCategoriesRef.off(); adminCategoriesRef = null; }
  if (adminGroupsRef) { adminGroupsRef.off(); adminGroupsRef = null; }
  if (categoriesRef) { categoriesRef.off(); categoriesRef = null; }
  if (personalExpensesRef) { personalExpensesRef.off(); personalExpensesRef = null; }
  personalExpensesCache = {};
  if (walletRef) { walletRef.off(); walletRef = null; }
  walletData = null;
}

// ============================================================
// Static event wiring (runs once)
// ============================================================

function wireStaticEvents() {
  // --- Auth ---
  document.querySelectorAll('.auth-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('mode-login').classList.toggle('hidden', btn.dataset.mode !== 'login');
      document.getElementById('mode-signup').classList.toggle('hidden', btn.dataset.mode !== 'signup');
      clearAuthError();
    });
  });
  document.getElementById('loginBtn').addEventListener('click', loginWithEmail);
  document.getElementById('signupBtn').addEventListener('click', signUpWithEmail);
  document.getElementById('loginEmail').addEventListener('blur', () => {
    checkLockoutForEmail(document.getElementById('loginEmail').value.trim().toLowerCase());
  });
  document.getElementById('loginPassword').addEventListener('keypress', e => { if (e.key === 'Enter') loginWithEmail(); });
  document.getElementById('signupPassword').addEventListener('keypress', e => { if (e.key === 'Enter') signUpWithEmail(); });
  document.getElementById('openWalletModalBtn').addEventListener('click', openWalletModal);
  document.getElementById('setupWalletBtn').addEventListener('click', openWalletModal);
  document.getElementById('closeWalletModal').addEventListener('click', () => hideModal('walletModal'));
  document.getElementById('confirmWalletAddBtn').addEventListener('click', confirmWalletAdd);

  // --- Bottom nav ---
  document.querySelectorAll('.nav-item[data-screen]').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.screen));
  });
  document.getElementById('navAddBtn').addEventListener('click', () => {
    const active = document.querySelector('.screen.active').id;
    if (active === 'screen-group') openAddExpenseModal();
    else if (active === 'screen-personal') openAddPersonalExpenseModal();
    else {
      showScreen('dashboard');
      resetGroupModal();
      showModal('createGroupModal');
      loadAllUsersForSelection();
    }
  });

  // --- Create group modal ---
  document.getElementById('closeGroupModal').addEventListener('click', () => { hideModal('createGroupModal'); resetGroupModal(); });
  document.getElementById('memberSearchInput').addEventListener('input', renderMembersList);
  document.getElementById('createGroupBtn').addEventListener('click', createGroup);

  // --- Group screen ---
  document.getElementById('groupBackBtn').addEventListener('click', leaveGroupScreen);
  document.getElementById('groupDeniedBackBtn').addEventListener('click', leaveGroupScreen);
  document.getElementById('groupMembersBtn').addEventListener('click', () => {
    document.getElementById('addMembersSection').classList.add('hidden');
    showModal('membersModal');
  });
  document.getElementById('closeMembersModal').addEventListener('click', () => hideModal('membersModal'));
  document.getElementById('showAddMembersBtn').addEventListener('click', openAddMembersPicker);
  document.getElementById('addMembersSearchInput').addEventListener('input', renderAddMembersList);
  document.getElementById('confirmAddMembersBtn').addEventListener('click', confirmAddMembers);
  document.getElementById('settleBtn').addEventListener('click', openSettleModal);
  document.getElementById('closeSettleModal').addEventListener('click', () => hideModal('settleModal'));

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const scope = btn.closest('.screen') || document;
      scope.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      scope.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      scope.querySelector('#tab-' + btn.dataset.tab).classList.remove('hidden');
    });
  });

  // --- Add expense modal ---
  document.getElementById('closeExpenseModal').addEventListener('click', () => hideModal('addExpenseModal'));
  document.getElementById('saveExpenseBtn').addEventListener('click', saveExpense);
  document.getElementById('expAmount').addEventListener('input', renderSplitMembers);
  document.querySelectorAll('.split-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.split-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSplitType = btn.dataset.split;
      renderSplitMembers();
    });
  });

  // --- Expense detail modal ---
  document.getElementById('closeDetailModal').addEventListener('click', () => hideModal('expenseDetailModal'));
  document.getElementById('editExpenseBtn').addEventListener('click', () => {
    if (currentDetailExpenseId) { hideModal('expenseDetailModal'); openEditExpenseModal(currentDetailExpenseId); }
  });
  document.getElementById('deleteExpenseBtn').addEventListener('click', () => {
    if (currentDetailExpenseId) deleteExpense(currentDetailExpenseId);
  });

  // --- Account screen ---
  document.getElementById('logoutBtn').addEventListener('click', () => {
    teardownListeners();
    auth.signOut();
  });

  // --- Admin screen ---
  document.getElementById('adminBackBtn').addEventListener('click', () => showScreen('account'));
  document.getElementById('addCategoryBtn').addEventListener('click', addCategory);

  // --- Personal expense modal ---
  document.getElementById('closePersonalExpenseModal').addEventListener('click', () => hideModal('addPersonalExpenseModal'));
  document.getElementById('savePersonalExpenseBtn').addEventListener('click', savePersonalExpense);
  document.getElementById('pExpSplitToggle').addEventListener('change', e => {
    document.getElementById('pExpSplitSection').classList.toggle('hidden', !e.target.checked);
    if (e.target.checked) populatePersonalSplitGroupSelect();
  });
  document.getElementById('pExpSplitGroup').addEventListener('change', e => loadPersonalSplitGroupMembers(e.target.value));

  // --- Personal expense detail modal ---
  document.getElementById('closePersonalDetailModal').addEventListener('click', () => hideModal('personalExpenseDetailModal'));
  document.getElementById('editPersonalExpenseBtn').addEventListener('click', () => {
    if (currentPersonalDetailId) { hideModal('personalExpenseDetailModal'); openEditPersonalExpenseModal(currentPersonalDetailId); }
  });
  document.getElementById('deletePersonalExpenseBtn').addEventListener('click', () => {
    if (currentPersonalDetailId) deletePersonalExpense(currentPersonalDetailId);
  });
}

function initAppShell(userData) {
  document.getElementById('accountName').textContent = userData.name;
  document.getElementById('accountEmail').textContent = userData.email;
  const avatarEl = document.getElementById('accountAvatar');
  avatarEl.className = 'avatar-circle avatar-lg avatar-c' + colorIndexForString(userData.name);
  avatarEl.textContent = (userData.name || '?').charAt(0).toUpperCase();

  const adminBtn = document.getElementById('adminPanelBtn');
  adminBtn.classList.toggle('hidden', !userData.isAdmin);
  adminBtn.onclick = () => { showScreen('admin'); loadAdminData(); };
}

// ============================================================
// Auth (email + password, with brute-force lockout)
// ============================================================

function showAuthError(msg) { const el = document.getElementById('authError'); el.textContent = msg; el.classList.remove('hidden'); }
function clearAuthError() { document.getElementById('authError').classList.add('hidden'); }

function mapAuthError(err) {
  const map = {
    'auth/email-already-in-use': 'An account already exists with this email.',
    'auth/invalid-email': 'That email address looks invalid.',
    'auth/weak-password': 'Password should be at least 6 characters.',
    'auth/user-not-found': 'Incorrect email or password.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.'
  };
  return (err && map[err.code]) || (err && err.message) || 'Something went wrong.';
}

// ---------- Brute-force protection (5 attempts, stored in localStorage) ----------

function attemptsKey(email) { return 'sr_login_attempts_' + email.toLowerCase().trim(); }

function getLoginAttempts(email) {
  try {
    const raw = localStorage.getItem(attemptsKey(email));
    return raw ? JSON.parse(raw) : { count: 0, lockedUntil: 0 };
  } catch (e) {
    return { count: 0, lockedUntil: 0 };
  }
}

function saveLoginAttempts(email, data) {
  try { localStorage.setItem(attemptsKey(email), JSON.stringify(data)); } catch (e) { /* storage unavailable */ }
}

function clearLoginAttempts(email) {
  try { localStorage.removeItem(attemptsKey(email)); } catch (e) { /* storage unavailable */ }
}

function recordFailedAttempt(email) {
  const data = getLoginAttempts(email);
  data.count = (data.count || 0) + 1;
  if (data.count >= MAX_LOGIN_ATTEMPTS) {
    data.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    data.count = 0;
  }
  saveLoginAttempts(email, data);
  return data;
}

function formatCountdown(untilTs) {
  const ms = Math.max(0, untilTs - Date.now());
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

// Checks (and live-updates) lockout state for the email currently in the field.
function checkLockoutForEmail(email) {
  if (lockoutInterval) { clearInterval(lockoutInterval); lockoutInterval = null; }
  const btn = document.getElementById('loginBtn');
  if (!email) { btn.disabled = false; return; }

  const data = getLoginAttempts(email);
  if (!data.lockedUntil || Date.now() >= data.lockedUntil) { btn.disabled = false; return; }

  btn.disabled = true;
  const tick = () => {
    if (Date.now() >= data.lockedUntil) {
      clearInterval(lockoutInterval); lockoutInterval = null;
      btn.disabled = false;
      clearAuthError();
      return;
    }
    showAuthError(`Too many failed attempts. Try again in ${formatCountdown(data.lockedUntil)}.`);
  };
  tick();
  lockoutInterval = setInterval(tick, 1000);
}

// ---------- Log in ----------

function loginWithEmail() {
  clearAuthError();
  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;
  if (!email || !password) return showAuthError('Enter your email and password');

  const existing = getLoginAttempts(email);
  if (existing.lockedUntil && Date.now() < existing.lockedUntil) {
    checkLockoutForEmail(email);
    return;
  }

  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = 'Logging in...';

  auth.signInWithEmailAndPassword(email, password)
    .then(() => { clearLoginAttempts(email); })
    .catch(err => {
      const data = recordFailedAttempt(email);
      if (data.lockedUntil && Date.now() < data.lockedUntil) {
        checkLockoutForEmail(email);
      } else {
        const remaining = MAX_LOGIN_ATTEMPTS - data.count;
        showAuthError(`${mapAuthError(err)} (${remaining} attempt${remaining !== 1 ? 's' : ''} left before lockout)`);
      }
    })
    .finally(() => { btn.disabled = false; btn.textContent = 'Log In'; });
}

// ---------- Sign up ----------

function signUpWithEmail() {
  clearAuthError();
  const name = document.getElementById('signupName').value.trim();
  const email = document.getElementById('signupEmail').value.trim().toLowerCase();
  const password = document.getElementById('signupPassword').value;

  if (!name) return showAuthError('Please enter your name');
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return showAuthError('Enter a valid email address');
  if (!password || password.length < 6) return showAuthError('Password must be at least 6 characters');

  const btn = document.getElementById('signupBtn');
  btn.disabled = true; btn.textContent = 'Creating account...';

  auth.createUserWithEmailAndPassword(email, password)
    .then(result => db.ref('users/' + result.user.uid).set({
      name, email, isAdmin: false, createdAt: firebase.database.ServerValue.TIMESTAMP
    }))
    .catch(err => showAuthError(mapAuthError(err)))
    .finally(() => { btn.disabled = false; btn.textContent = 'Create Account'; });
}

// ============================================================
// Dashboard
// ============================================================

function loadDashboardData() {
  db.ref('userGroups/' + currentUser.uid).on('value', snap => {
    syncGroupListeners(Object.keys(snap.val() || {}));
  });
}

function syncGroupListeners(groupIds) {
  Object.keys(groupListeners).forEach(id => {
    if (!groupIds.includes(id)) {
      groupListeners[id].groupRef.off();
      groupListeners[id].expensesRef.off();
      delete groupListeners[id]; delete groupsSnapshot[id]; delete expensesSnapshot[id];
    }
  });
  groupIds.forEach(id => {
    if (groupListeners[id]) return;
    const groupRef = db.ref('groups/' + id);
    const expensesRef = db.ref('expenses/' + id);
    groupRef.on('value', s => { groupsSnapshot[id] = s.val(); refreshDashboardUI(); });
    expensesRef.on('value', s => { expensesSnapshot[id] = s.val() || {}; refreshDashboardUI(); });
    groupListeners[id] = { groupRef, expensesRef };
  });
  if (groupIds.length === 0) refreshDashboardUI();
}

function refreshDashboardUI() {
  const myGroups = Object.entries(groupsSnapshot).filter(([, g]) => g);
  renderGroupsList(myGroups);

  let totalOwe = 0, totalOwed = 0;
  myGroups.forEach(([id, group]) => {
    const memberIds = Object.keys(group.members || {});
    const balances = calculateBalances(expensesSnapshot[id] || {}, memberIds);
    const myBalance = balances[currentUser.uid] || 0;
    if (myBalance > 0) totalOwed += myBalance; else totalOwe += Math.abs(myBalance);
  });
  updateSummary(totalOwe, totalOwed);
}

function renderGroupsList(myGroups) {
  const listEl = document.getElementById('groupsList');
  const emptyEl = document.getElementById('groupsEmpty');
  if (myGroups.length === 0) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); return; }
  emptyEl.classList.add('hidden');

  listEl.innerHTML = myGroups
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0))
    .map(([id, group]) => {
      const memberIds = Object.keys(group.members || {});
      const balances = calculateBalances(expensesSnapshot[id] || {}, memberIds);
      const myBalance = balances[currentUser.uid] || 0;

      let cls = 'settled', amtHtml = '<span class="amt">Settled</span>';
      if (myBalance > 0.01) { cls = 'owed'; amtHtml = `<span class="amt">${formatCurrency(myBalance)}</span><span class="lbl">you are owed</span>`; }
      else if (myBalance < -0.01) { cls = 'owe'; amtHtml = `<span class="amt">${formatCurrency(Math.abs(myBalance))}</span><span class="lbl">you owe</span>`; }

      return `
        <div class="list-row" data-group-id="${id}">
          ${avatarHtml(group.name)}
          <div class="list-row-info">
            <strong>${escapeHtml(group.name)}</strong>
            <span>${memberIds.length} member${memberIds.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="list-row-amount ${cls}">${amtHtml}</div>
        </div>`;
    }).join('');

  listEl.querySelectorAll('.list-row').forEach(row => {
    row.addEventListener('click', () => openGroup(row.dataset.groupId, 'dashboard'));
  });
}

function updateSummary(owe, owed) {
  document.getElementById('totalOwe').textContent = formatCurrency(owe);
  document.getElementById('totalOwed').textContent = formatCurrency(owed);
  const net = owed - owe;
  const netEl = document.getElementById('netBalance');
  netEl.textContent = formatCurrency(Math.abs(net));
  netEl.style.color = net > 0.01 ? 'var(--owed)' : (net < -0.01 ? 'var(--owe)' : 'var(--text)');
}

// ---------- Create group ----------

function resetGroupModal() {
  document.getElementById('groupNameInput').value = '';
  document.getElementById('memberSearchInput').value = '';
  selectedMembers = new Set(currentUser ? [currentUser.uid] : []);
}

function loadAllUsersForSelection() {
  selectedMembers = new Set([currentUser.uid]);
  db.ref('users').once('value').then(snap => { allUsersCache = snap.val() || {}; renderMembersList(); });
}

function renderMembersList() {
  const container = document.getElementById('membersListContainer');
  const search = document.getElementById('memberSearchInput').value.toLowerCase();
  const others = Object.entries(allUsersCache).filter(([uid]) => uid !== currentUser.uid);

  if (others.length === 0) { container.innerHTML = '<p class="empty-state-sm">No other users registered yet.</p>'; return; }

  container.innerHTML = others.map(([uid, u]) => {
    if (search && !((u.name || '').toLowerCase().includes(search) || (u.email || '').toLowerCase().includes(search))) return '';
    return `
      <label class="member-row">
        <input type="checkbox" data-uid="${uid}" ${selectedMembers.has(uid) ? 'checked' : ''} />
        ${avatarHtml(u.name)}
        <div class="list-row-info"><strong>${escapeHtml(u.name)}</strong><span>${escapeHtml(u.email || '')}</span></div>
      </label>`;
  }).join('');

  container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', e => {
      if (e.target.checked) selectedMembers.add(e.target.dataset.uid);
      else selectedMembers.delete(e.target.dataset.uid);
    });
  });
}

function createGroup() {
  const name = document.getElementById('groupNameInput').value.trim();
  if (!name) return showToast('Please enter a group name', true);
  if (selectedMembers.size < 1) return showToast('Select at least one member', true);

  const btn = document.getElementById('createGroupBtn');
  btn.disabled = true; btn.textContent = 'Creating...';

  const groupId = db.ref('groups').push().key;
  const membersObj = {};
  selectedMembers.forEach(uid => { membersObj[uid] = true; });
  const memberUids = Array.from(selectedMembers);

  // Step 1: create the group itself.
  db.ref('groups/' + groupId).set({
    name, createdBy: currentUser.uid, members: membersObj, createdAt: firebase.database.ServerValue.TIMESTAMP
  })
    .then(() => {
      // Step 2: fan the group id out into every member's own index, now
      // that the group genuinely exists server-side.
      const indexUpdates = {};
      memberUids.forEach(uid => { indexUpdates['userGroups/' + uid + '/' + groupId] = true; });
      return db.ref().update(indexUpdates);
    })
    .then(() => { hideModal('createGroupModal'); resetGroupModal(); openGroup(groupId, 'dashboard'); })
    .catch(err => showToast(err.message, true))
    .finally(() => { btn.disabled = false; btn.textContent = 'Create Group'; });
}

// ============================================================
// Group screen
// ============================================================

function openGroup(id, returnScreen) {
  currentGroupId = id;
  groupReturnScreen = returnScreen || 'dashboard';
  showScreen('group');
  loadGroupScreen();
}

function leaveGroupScreen() {
  if (groupDataRef) { groupDataRef.off(); groupDataRef = null; }
  if (groupExpensesRef) { groupExpensesRef.off(); groupExpensesRef = null; }
  if (groupCategoriesRef) { groupCategoriesRef.off(); groupCategoriesRef = null; }
  currentGroupId = null;
  showScreen(groupReturnScreen);
}

function loadGroupScreen() {
  if (groupDataRef) groupDataRef.off();
  if (groupExpensesRef) groupExpensesRef.off();
  if (groupCategoriesRef) groupCategoriesRef.off();

  groupDataRef = db.ref('groups/' + currentGroupId);
  groupDataRef.on('value', snap => {
    groupData = snap.val();
    if (!groupData) { showGroupAccessDenied(); return; }
    showGroupContent();
    loadGroupMembers();
    loadGroupCategories();
    loadGroupExpenses();
  }, () => showGroupAccessDenied());
}

function showGroupAccessDenied() {
  document.getElementById('groupAccessDenied').classList.remove('hidden');
  document.getElementById('groupContentWrap').classList.add('hidden');
}

function showGroupContent() {
  document.getElementById('groupAccessDenied').classList.add('hidden');
  document.getElementById('groupContentWrap').classList.remove('hidden');
  document.getElementById('groupTitle').textContent = groupData.name;
  document.getElementById('groupBanner').className = 'group-banner ' + bannerClass(groupData.name);
  document.getElementById('groupAvatar').textContent = (groupData.name || '?').charAt(0).toUpperCase();

  const isMember = !!(groupData.members && groupData.members[currentUser.uid]);
  document.getElementById('settleBtn').classList.toggle('hidden', !isMember);
  if (!isMember) document.getElementById('groupBalanceLine').textContent = 'Viewing as admin (read-only)';
}

function loadGroupMembers() {
  const memberIds = Object.keys(groupData.members || {});
  Promise.all(memberIds.map(uid => db.ref('users/' + uid).once('value').then(s => ({ uid, data: s.val() }))))
    .then(results => {
      groupMembersData = {};
      results.forEach(r => { if (r.data) groupMembersData[r.uid] = r.data; });
      renderMembersModalList();
      populatePaidBySelect();
      renderSplitMembers();
      computeGroupBalance();
    });
}

function renderMembersModalList() {
  document.getElementById('groupMembersList').innerHTML = Object.entries(groupMembersData).map(([uid, u]) => `
    <div class="member-row">
      ${avatarHtml(u.name)}
      <div class="list-row-info"><strong>${escapeHtml(u.name)}${uid === currentUser.uid ? ' (You)' : ''}</strong><span>${escapeHtml(u.email || '')}</span></div>
    </div>`).join('');

  const isMember = !!(groupData && groupData.members && groupData.members[currentUser.uid]);
  document.getElementById('showAddMembersBtn').classList.toggle('hidden', !isMember);
}

// ---------- Add members to an existing group ----------

function openAddMembersPicker() {
  selectedNewMembers = new Set();
  document.getElementById('addMembersSearchInput').value = '';
  document.getElementById('addMembersSection').classList.remove('hidden');
  db.ref('users').once('value').then(snap => { allUsersCache = snap.val() || {}; renderAddMembersList(); });
}

function renderAddMembersList() {
  const container = document.getElementById('addMembersListContainer');
  const search = document.getElementById('addMembersSearchInput').value.toLowerCase();
  const candidates = Object.entries(allUsersCache).filter(([uid]) => !groupMembersData[uid]);

  if (candidates.length === 0) { container.innerHTML = '<p class="empty-state-sm">Everyone is already in this group.</p>'; return; }

  container.innerHTML = candidates.map(([uid, u]) => {
    if (search && !((u.name || '').toLowerCase().includes(search) || (u.email || '').toLowerCase().includes(search))) return '';
    return `
      <label class="member-row">
        <input type="checkbox" data-uid="${uid}" ${selectedNewMembers.has(uid) ? 'checked' : ''} />
        ${avatarHtml(u.name)}
        <div class="list-row-info"><strong>${escapeHtml(u.name)}</strong><span>${escapeHtml(u.email || '')}</span></div>
      </label>`;
  }).join('');

  container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', e => {
      if (e.target.checked) selectedNewMembers.add(e.target.dataset.uid);
      else selectedNewMembers.delete(e.target.dataset.uid);
    });
  });
}

function confirmAddMembers() {
  if (selectedNewMembers.size === 0) return showToast('Select at least one person to add', true);

  const btn = document.getElementById('confirmAddMembersBtn');
  btn.disabled = true; btn.textContent = 'Adding...';

  const newUids = Array.from(selectedNewMembers);
  const memberUpdates = {};
  newUids.forEach(uid => { memberUpdates['groups/' + currentGroupId + '/members/' + uid] = true; });

  // Step 1: add them to the group's own member list.
  db.ref().update(memberUpdates)
    .then(() => {
      // Step 2: fan out into each new member's own index, now that the
      // group genuinely reflects their membership server-side.
      const indexUpdates = {};
      newUids.forEach(uid => { indexUpdates['userGroups/' + uid + '/' + currentGroupId] = true; });
      return db.ref().update(indexUpdates);
    })
    .then(() => {
      document.getElementById('addMembersSection').classList.add('hidden');
      showToast('Members added');
    })
    .catch(err => showToast(err.message, true))
    .finally(() => { btn.disabled = false; btn.textContent = 'Add Selected'; });
}

function loadGroupCategories() {
  if (groupCategoriesRef) groupCategoriesRef.off();
  groupCategoriesRef = db.ref('categories');
  groupCategoriesRef.on('value', snap => { categoriesCache = snap.val() || {}; populateCategorySelect(); });
}

function populateCategorySelect() {
  const sel = document.getElementById('expCategory');
  const keys = Object.keys(categoriesCache);
  sel.innerHTML = keys.length === 0
    ? '<option value="General">General</option>'
    : keys.map(k => `<option value="${escapeHtml(categoriesCache[k].name)}">${escapeHtml(categoriesCache[k].name)}</option>`).join('');
}

function populatePaidBySelect() {
  document.getElementById('expPaidBy').innerHTML = Object.entries(groupMembersData).map(([uid, u]) =>
    `<option value="${uid}" ${uid === currentUser.uid ? 'selected' : ''}>${escapeHtml(u.name)}${uid === currentUser.uid ? ' (You)' : ''}</option>`
  ).join('');
}

// ---------- Expenses list ----------

function loadGroupExpenses() {
  if (groupExpensesRef) groupExpensesRef.off();
  groupExpensesRef = db.ref('expenses/' + currentGroupId);
  groupExpensesRef.on('value', snap => {
    expensesCache = snap.val() || {};
    renderExpensesList();
    computeGroupBalance();
    renderAnalysisTab();
  });
}

function renderExpensesList() {
  const listEl = document.getElementById('expensesList');
  const emptyEl = document.getElementById('expensesEmpty');
  const entries = Object.entries(expensesCache).sort((a, b) =>
    (b[1].date || '').localeCompare(a[1].date || '') || (b[1].createdAt || 0) - (a[1].createdAt || 0));

  if (entries.length === 0) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); return; }
  emptyEl.classList.add('hidden');

  listEl.innerHTML = entries.map(([expId, exp]) => {
    const payer = groupMembersData[exp.paidBy];
    const isSettlement = exp.type === 'settlement';
    return `
      <div class="list-row" data-exp-id="${expId}">
        <div class="expense-date-badge"><span>${formatDateShort(exp.date)}</span></div>
        <div class="list-row-info">
          <strong>${isSettlement ? '🤝 ' : ''}${escapeHtml(exp.description)}</strong>
          <span>${isSettlement ? 'Settlement' : (payer ? escapeHtml(payer.name) + ' paid' : 'Unknown')} · ${escapeHtml(exp.category || 'General')}</span>
        </div>
        <div class="list-row-amount"><span class="amt">${formatCurrency(exp.amount)}</span></div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.list-row').forEach(row => row.addEventListener('click', () => openExpenseDetail(row.dataset.expId)));
}

function computeGroupBalance() {
  if (!groupData) return;
  const memberIds = Object.keys(groupData.members || {});
  const balances = calculateBalances(expensesCache, memberIds);
  const isMember = !!(groupData.members && groupData.members[currentUser.uid]);
  const transactions = simplifyDebts(balances);
  const breakdown = document.getElementById('balanceBreakdown');

  if (isMember) {
    const myBalance = balances[currentUser.uid] || 0;
    const lineEl = document.getElementById('groupBalanceLine');
    if (Math.abs(myBalance) < 0.01) lineEl.textContent = "You're all settled up";
    else if (myBalance > 0) lineEl.textContent = `You are owed ${formatCurrency(myBalance)}`;
    else lineEl.textContent = `You owe ${formatCurrency(Math.abs(myBalance))}`;

    const myTx = transactions.filter(t => t.from === currentUser.uid || t.to === currentUser.uid);
    breakdown.innerHTML = myTx.length === 0 ? '<p class="settled-msg">You are all settled up 🎉</p>' : myTx.map(balanceLineHtml).join('');
  } else {
    breakdown.innerHTML = transactions.length === 0 ? '<p class="settled-msg">Everyone is settled up 🎉</p>' : transactions.map(balanceLineHtml).join('');
  }
}

function balanceLineHtml(t) {
  const fromName = groupMembersData[t.from] ? groupMembersData[t.from].name : '...';
  const toName = groupMembersData[t.to] ? groupMembersData[t.to].name : '...';
  if (t.from === currentUser.uid) {
    return `<div class="list-row"><div class="list-row-info"><span>You owe <strong>${escapeHtml(toName)}</strong></span></div><div class="list-row-amount owe"><span class="amt">${formatCurrency(t.amount)}</span></div></div>`;
  }
  if (t.to === currentUser.uid) {
    return `<div class="list-row"><div class="list-row-info"><span><strong>${escapeHtml(fromName)}</strong> owes you</span></div><div class="list-row-amount owed"><span class="amt">${formatCurrency(t.amount)}</span></div></div>`;
  }
  return `<div class="list-row"><div class="list-row-info"><span><strong>${escapeHtml(fromName)}</strong> owes <strong>${escapeHtml(toName)}</strong></span></div><div class="list-row-amount"><span class="amt">${formatCurrency(t.amount)}</span></div></div>`;
}

// ---------- Analysis (spend by category) ----------

function computeCategoryAnalysis() {
  const totals = {};
  let grandTotal = 0;
  Object.values(expensesCache).forEach(exp => {
    if (!exp || exp.type === 'settlement') return;
    const cat = exp.category || 'General';
    const amt = Number(exp.amount) || 0;
    totals[cat] = (totals[cat] || 0) + amt;
    grandTotal += amt;
  });
  return { totals, grandTotal };
}

function renderAnalysisTab() {
  const { totals, grandTotal } = computeCategoryAnalysis();
  document.getElementById('analysisTotalAmount').textContent = formatCurrency(grandTotal);

  const listEl = document.getElementById('categoryAnalysisList');
  const emptyEl = document.getElementById('analysisEmpty');
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); return; }
  emptyEl.classList.add('hidden');

  listEl.innerHTML = entries.map(([cat, amt]) => {
    const pct = grandTotal > 0 ? Math.round((amt / grandTotal) * 100) : 0;
    const idx = colorIndexForString(cat);
    return `
      <div class="list-row">
        <div class="list-row-info">
          <strong>${escapeHtml(cat)}</strong>
          <div class="category-bar-track"><div class="category-bar-fill avatar-c${idx}" style="width:${pct}%"></div></div>
        </div>
        <div class="list-row-amount"><span class="amt">${formatCurrency(amt)}</span><span class="lbl">${pct}%</span></div>
      </div>`;
  }).join('');
}

// ---------- Add expense ----------

function openAddExpenseModal() {
  const isMember = !!(groupData && groupData.members && groupData.members[currentUser.uid]);
  if (!isMember) return showToast('Only group members can add expenses', true);

  editingExpenseId = null;
  document.getElementById('expenseModalTitle').textContent = 'Add Expense';
  document.getElementById('expDescription').value = '';
  document.getElementById('expAmount').value = '';
  document.getElementById('expDate').value = new Date().toISOString().split('T')[0];
  currentSplitType = 'equal';
  document.querySelectorAll('.split-toggle-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.split-toggle-btn[data-split="equal"]').classList.add('active');
  populatePaidBySelect();
  renderSplitMembers();
  showModal('addExpenseModal');
}

function openEditExpenseModal(expId) {
  const exp = expensesCache[expId];
  if (!exp) return;
  const isMember = !!(groupData && groupData.members && groupData.members[currentUser.uid]);
  if (!isMember) return showToast('Only group members can edit expenses', true);

  editingExpenseId = expId;
  document.getElementById('expenseModalTitle').textContent = 'Edit Expense';
  document.getElementById('expDescription').value = exp.description || '';
  document.getElementById('expAmount').value = exp.amount || '';
  document.getElementById('expDate').value = exp.date || new Date().toISOString().split('T')[0];
  populatePaidBySelect();
  document.getElementById('expPaidBy').value = exp.paidBy;
  populateCategorySelect();
  document.getElementById('expCategory').value = exp.category || 'General';

  currentSplitType = 'custom';
  document.querySelectorAll('.split-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.split === 'custom'));
  renderSplitMembers();
  showModal('addExpenseModal');
}

function renderSplitMembers() {
  const container = document.getElementById('splitMembersContainer');
  const amount = parseFloat(document.getElementById('expAmount').value) || 0;
  const entries = Object.entries(groupMembersData);
  const editingSplit = (editingExpenseId && expensesCache[editingExpenseId]) ? (expensesCache[editingExpenseId].splitAmong || {}) : null;

  if (currentSplitType === 'equal') {
    const share = entries.length ? amount / entries.length : 0;
    container.innerHTML = entries.map(([uid, u]) => `
      <div class="split-member-row">
        <input type="checkbox" class="split-checkbox" data-uid="${uid}" checked />
        <span>${escapeHtml(u.name)}${uid === currentUser.uid ? ' (You)' : ''}</span>
        <span class="split-share-amount">${formatCurrency(share)}</span>
      </div>`).join('');
    container.querySelectorAll('.split-checkbox').forEach(cb => cb.addEventListener('change', recalcEqualSplit));
  } else {
    container.innerHTML = entries.map(([uid, u]) => {
      const prefill = editingSplit && editingSplit[uid] !== undefined ? editingSplit[uid] : '';
      return `
      <div class="split-member-row">
        <span>${escapeHtml(u.name)}${uid === currentUser.uid ? ' (You)' : ''}</span>
        <div class="custom-split-input"><span class="currency-prefix-sm">₹</span><input type="number" class="custom-split-field" data-uid="${uid}" min="0" step="0.01" placeholder="0.00" value="${prefill}" /></div>
      </div>`;
    }).join('');
  }
}

function recalcEqualSplit() {
  const amount = parseFloat(document.getElementById('expAmount').value) || 0;
  const checked = Array.from(document.querySelectorAll('.split-checkbox:checked'));
  const share = checked.length ? amount / checked.length : 0;
  document.querySelectorAll('.split-member-row').forEach(row => {
    const cb = row.querySelector('.split-checkbox');
    const amtEl = row.querySelector('.split-share-amount');
    if (cb && amtEl) amtEl.textContent = cb.checked ? formatCurrency(share) : formatCurrency(0);
  });
}

function saveExpense() {
  const description = document.getElementById('expDescription').value.trim();
  const amount = parseFloat(document.getElementById('expAmount').value);
  const category = document.getElementById('expCategory').value;
  const date = document.getElementById('expDate').value;
  const paidBy = document.getElementById('expPaidBy').value;

  if (!description) return showToast('Enter a description', true);
  if (!amount || amount <= 0) return showToast('Enter a valid amount', true);
  if (!date) return showToast('Select a date', true);

  const splitAmong = {};
  if (currentSplitType === 'equal') {
    const checked = Array.from(document.querySelectorAll('.split-checkbox:checked')).map(cb => cb.dataset.uid);
    if (checked.length === 0) return showToast('Select at least one member to split with', true);
    const share = Math.round((amount / checked.length) * 100) / 100;
    checked.forEach((uid, idx) => {
      splitAmong[uid] = (idx === checked.length - 1) ? Math.round((amount - share * (checked.length - 1)) * 100) / 100 : share;
    });
  } else {
    const fields = Array.from(document.querySelectorAll('.custom-split-field'));
    let sum = 0;
    fields.forEach(f => { const val = parseFloat(f.value) || 0; if (val > 0) { splitAmong[f.dataset.uid] = val; sum += val; } });
    if (Object.keys(splitAmong).length === 0) return showToast('Enter split amounts', true);
    if (Math.abs(sum - amount) > 0.05) return showToast('Split amounts must add up to the total amount', true);
  }

  const btn = document.getElementById('saveExpenseBtn');
  btn.disabled = true; btn.textContent = 'Saving...';

  const payload = { description, amount, category, date, paidBy, splitAmong, type: 'expense' };

  const writeOp = editingExpenseId
    ? db.ref('expenses/' + currentGroupId + '/' + editingExpenseId).update(payload)
    : db.ref('expenses/' + currentGroupId).push().set({
        ...payload, createdBy: currentUser.uid, createdAt: firebase.database.ServerValue.TIMESTAMP
      });

  writeOp.then(() => {
    hideModal('addExpenseModal');
    showToast(editingExpenseId ? 'Expense updated' : 'Expense added');
    editingExpenseId = null;
  }).catch(err => showToast(err.message, true))
    .finally(() => { btn.disabled = false; btn.textContent = 'Save Expense'; });
}

// ---------- Expense detail + comments ----------

function openExpenseDetail(expId) {
  const exp = expensesCache[expId];
  if (!exp) return;
  currentDetailExpenseId = expId;
  const isMember = !!(groupData && groupData.members && groupData.members[currentUser.uid]);
  document.getElementById('editExpenseBtn').classList.toggle('hidden', !isMember);
  document.getElementById('deleteExpenseBtn').classList.toggle('hidden', !isMember);

  const payer = groupMembersData[exp.paidBy];
  const splitRows = Object.entries(exp.splitAmong || {}).map(([uid, share]) => {
    const u = groupMembersData[uid];
    return `<div class="detail-split-row"><span>${u ? escapeHtml(u.name) : 'Unknown'}</span><span>${formatCurrency(share)}</span></div>`;
  }).join('');

  document.getElementById('expenseDetailBody').innerHTML = `
    <div class="detail-header"><h4>${escapeHtml(exp.description)}</h4><div class="detail-amount">${formatCurrency(exp.amount)}</div></div>
    <div class="detail-meta">
      <div><span>Paid by</span><strong>${payer ? escapeHtml(payer.name) : 'Unknown'}</strong></div>
      <div><span>Category</span><strong>${escapeHtml(exp.category || 'General')}</strong></div>
      <div><span>Date</span><strong>${formatDateShort(exp.date)}</strong></div>
    </div>
    <div class="detail-section-title">Split Details</div>
    <div class="detail-split-list">${splitRows}</div>
    <div class="detail-section-title">Comments</div>
    <div id="commentsList" class="comments-list"></div>
    <div class="comment-input-group">
      <input type="text" id="commentInput" class="input-field" placeholder="Add a comment..." />
      <button id="postCommentBtn" class="btn btn-primary btn-sm">Post</button>
    </div>`;

  document.getElementById('postCommentBtn').addEventListener('click', () => postComment(expId));
  document.getElementById('commentInput').addEventListener('keypress', e => { if (e.key === 'Enter') postComment(expId); });

  loadComments(expId);
  showModal('expenseDetailModal');
}

function deleteExpense(expId) {
  if (!confirm('Delete this expense? This cannot be undone.')) return;
  db.ref('expenses/' + currentGroupId + '/' + expId).remove()
    .then(() => { hideModal('expenseDetailModal'); showToast('Expense deleted'); })
    .catch(err => showToast(err.message, true));
}

function loadComments(expId) {
  db.ref('expenses/' + currentGroupId + '/' + expId + '/comments').on('value', snap => {
    const listEl = document.getElementById('commentsList');
    if (!listEl) return;
    const entries = Object.entries(snap.val() || {}).sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
    listEl.innerHTML = entries.length === 0 ? '<p class="empty-state-sm">No comments yet.</p>' : entries.map(([, c]) => {
      const u = groupMembersData[c.uid];
      return `<div class="comment-row">${avatarHtml(u ? u.name : '?', 'avatar-sm')}<div class="comment-body"><strong>${u ? escapeHtml(u.name) : 'Unknown'}</strong><p>${escapeHtml(c.text)}</p></div></div>`;
    }).join('');
  });
}

function postComment(expId) {
  const input = document.getElementById('commentInput');
  const text = input.value.trim();
  if (!text) return;
  db.ref('expenses/' + currentGroupId + '/' + expId + '/comments').push().set({
    uid: currentUser.uid, text, createdAt: firebase.database.ServerValue.TIMESTAMP
  }).then(() => { input.value = ''; }).catch(err => showToast(err.message, true));
}

// ---------- Settle up ----------

function openSettleModal() {
  const memberIds = Object.keys(groupData.members || {});
  const balances = calculateBalances(expensesCache, memberIds);
  const transactions = simplifyDebts(balances);
  const container = document.getElementById('settleSuggestions');

  if (transactions.length === 0) {
    container.innerHTML = '<p class="settled-msg">Everyone is settled up 🎉</p>';
  } else {
    container.innerHTML = transactions.map(t => {
      const fromName = groupMembersData[t.from] ? groupMembersData[t.from].name : '...';
      const toName = groupMembersData[t.to] ? groupMembersData[t.to].name : '...';
      const canRecord = t.from === currentUser.uid || t.to === currentUser.uid;
      return `
        <div class="settle-row">
          <div class="settle-avatars">${avatarHtml(fromName, 'avatar-sm')}<span class="settle-arrow">→</span>${avatarHtml(toName, 'avatar-sm')}</div>
          <div class="settle-text"><strong>${escapeHtml(fromName)}</strong> pays <strong>${escapeHtml(toName)}</strong></div>
          <div class="settle-amount">${formatCurrency(t.amount)}</div>
          ${canRecord ? `<button class="btn btn-settle btn-sm record-settle-btn" data-from="${t.from}" data-to="${t.to}" data-amount="${t.amount}">Mark as Paid</button>` : ''}
        </div>`;
    }).join('');
    container.querySelectorAll('.record-settle-btn').forEach(btn => {
      btn.addEventListener('click', () => recordSettlement(btn.dataset.from, btn.dataset.to, parseFloat(btn.dataset.amount)));
    });
  }
  showModal('settleModal');
}

function recordSettlement(fromUid, toUid, amount) {
  const fromName = groupMembersData[fromUid] ? groupMembersData[fromUid].name : 'Someone';
  const toName = groupMembersData[toUid] ? groupMembersData[toUid].name : 'Someone';
  db.ref('expenses/' + currentGroupId).push().set({
    description: `Settlement: ${fromName} \u2192 ${toName}`,
    amount, category: 'Settlement', date: new Date().toISOString().split('T')[0],
    paidBy: fromUid, splitAmong: { [toUid]: amount }, type: 'settlement',
    createdBy: currentUser.uid, createdAt: firebase.database.ServerValue.TIMESTAMP
  }).then(() => { hideModal('settleModal'); showToast('Settlement recorded'); })
    .catch(err => showToast(err.message, true));
}

// ============================================================
// Admin
// ============================================================

function loadAdminData() {
  const isAdmin = !!(currentUserData && currentUserData.isAdmin);
  document.getElementById('notAdmin').classList.toggle('hidden', isAdmin);
  document.getElementById('adminContent').classList.toggle('hidden', !isAdmin);
  if (!isAdmin) return;

  if (!adminCategoriesRef) {
    adminCategoriesRef = db.ref('categories');
    adminCategoriesRef.on('value', snap => { categoriesCache = snap.val() || {}; renderAdminCategories(); });
  }
  if (!adminGroupsRef) {
    adminGroupsRef = db.ref('groups');
    adminGroupsRef.on('value', snap => renderAdminGroupsList(snap.val() || {}));
  }
}

function renderAdminCategories() {
  const listEl = document.getElementById('categoriesList');
  const entries = Object.entries(categoriesCache);
  listEl.innerHTML = entries.length === 0
    ? '<p class="empty-state-sm">No categories yet — add one below.</p>'
    : entries.map(([id, c]) => `<div class="category-chip"><span>${escapeHtml(c.name)}</span><button class="chip-remove" data-id="${id}">✕</button></div>`).join('');
  listEl.querySelectorAll('.chip-remove').forEach(btn => btn.addEventListener('click', () => deleteCategory(btn.dataset.id)));
}

function addCategory() {
  const input = document.getElementById('newCategoryInput');
  const name = input.value.trim();
  if (!name) return showToast('Enter a category name', true);
  db.ref('categories').push().set({ name, createdAt: firebase.database.ServerValue.TIMESTAMP })
    .then(() => { input.value = ''; showToast('Category added'); })
    .catch(err => showToast(err.message, true));
}

function deleteCategory(id) {
  db.ref('categories/' + id).remove().then(() => showToast('Category removed')).catch(err => showToast(err.message, true));
}

function renderAdminGroupsList(groups) {
  const listEl = document.getElementById('allGroupsList');
  const entries = Object.entries(groups);
  if (entries.length === 0) { listEl.innerHTML = '<p class="empty-state-sm">No groups created yet.</p>'; return; }

  listEl.innerHTML = entries.map(([id, g]) => {
    const memberCount = Object.keys(g.members || {}).length;
    return `
      <div class="list-row" data-group-id="${id}">
        ${avatarHtml(g.name)}
        <div class="list-row-info"><strong>${escapeHtml(g.name)}</strong><span>${memberCount} member${memberCount !== 1 ? 's' : ''}</span></div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.list-row').forEach(row => row.addEventListener('click', () => openGroup(row.dataset.groupId, 'admin')));
}

// ============================================================
// Personal Expenses
// ============================================================

// Categories are shared with group expenses (admin-managed), loaded once
// at login so they're ready everywhere, not just inside a group screen.
function loadCategoriesGlobal() {
  if (categoriesRef) return;
  categoriesRef = db.ref('categories');
  categoriesRef.on('value', snap => { categoriesCache = snap.val() || {}; });
}

function loadPersonalExpenses() {
  if (personalExpensesRef) personalExpensesRef.off();
  personalExpensesRef = db.ref('personalExpenses/' + currentUser.uid);
  personalExpensesRef.on('value', snap => {
    personalExpensesCache = snap.val() || {};
    renderPersonalExpensesList();
    renderPersonalAnalysis();
  });
}

function currentMonthKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function renderPersonalExpensesList() {
  const listEl = document.getElementById('personalExpensesList');
  const emptyEl = document.getElementById('personalExpensesEmpty');
  const entries = Object.entries(personalExpensesCache).sort((a, b) =>
    (b[1].date || '').localeCompare(a[1].date || '') || (b[1].createdAt || 0) - (a[1].createdAt || 0));

  const monthKey = currentMonthKey();
  let monthTotal = 0;
  entries.forEach(([, e]) => { if ((e.date || '').startsWith(monthKey)) monthTotal += Number(e.amount) || 0; });
  document.getElementById('personalMonthTotal').textContent = formatCurrency(monthTotal);
  document.getElementById('personalMonthLabel').textContent = new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  if (entries.length === 0) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); return; }
  emptyEl.classList.add('hidden');

  listEl.innerHTML = entries.map(([id, e]) => `
    <div class="list-row" data-pexp-id="${id}">
      <div class="expense-date-badge"><span>${formatDateShort(e.date)}</span></div>
      <div class="list-row-info">
        <strong>${escapeHtml(e.description)}</strong>
        <span>${escapeHtml(e.category || 'General')} · ${escapeHtml(e.paymentMode || '')}${e.splitGroupId ? ' · Split' : ''}</span>
      </div>
      <div class="list-row-amount"><span class="amt">${formatCurrency(e.amount)}</span></div>
    </div>`).join('');

  listEl.querySelectorAll('.list-row').forEach(row => row.addEventListener('click', () => openPersonalExpenseDetail(row.dataset.pexpId)));
}

function renderPersonalAnalysis() {
  const totals = {};
  let grandTotal = 0;
  Object.values(personalExpensesCache).forEach(e => {
    const cat = e.category || 'General';
    const amt = Number(e.amount) || 0;
    totals[cat] = (totals[cat] || 0) + amt;
    grandTotal += amt;
  });
  document.getElementById('personalAnalysisTotalAmount').textContent = formatCurrency(grandTotal);

  const listEl = document.getElementById('personalCategoryAnalysisList');
  const emptyEl = document.getElementById('personalAnalysisEmpty');
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) { listEl.innerHTML = ''; emptyEl.classList.remove('hidden'); return; }
  emptyEl.classList.add('hidden');

  listEl.innerHTML = entries.map(([cat, amt]) => {
    const pct = grandTotal > 0 ? Math.round((amt / grandTotal) * 100) : 0;
    const idx = colorIndexForString(cat);
    return `
      <div class="list-row">
        <div class="list-row-info">
          <strong>${escapeHtml(cat)}</strong>
          <div class="category-bar-track"><div class="category-bar-fill avatar-c${idx}" style="width:${pct}%"></div></div>
        </div>
        <div class="list-row-amount"><span class="amt">${formatCurrency(amt)}</span><span class="lbl">${pct}%</span></div>
      </div>`;
  }).join('');
}

// ---------- Add / edit personal expense ----------

function populatePersonalCategorySelect() {
  const sel = document.getElementById('pExpCategory');
  const keys = Object.keys(categoriesCache);
  sel.innerHTML = keys.length === 0
    ? '<option value="General">General</option>'
    : keys.map(k => `<option value="${escapeHtml(categoriesCache[k].name)}">${escapeHtml(categoriesCache[k].name)}</option>`).join('');
}

function openAddPersonalExpenseModal() {
  editingPersonalExpenseId = null;
  document.getElementById('personalExpenseModalTitle').textContent = 'Add Expense';
  document.getElementById('pExpDescription').value = '';
  document.getElementById('pExpAmount').value = '';
  document.getElementById('pExpDate').value = new Date().toISOString().split('T')[0];
  document.getElementById('pExpMode').value = 'Cash';
  populatePersonalCategorySelect();
  document.getElementById('pExpSplitToggleRow').classList.remove('hidden');
  document.getElementById('pExpSplitToggle').checked = false;
  document.getElementById('pExpSplitSection').classList.add('hidden');
  showModal('addPersonalExpenseModal');
}

function openEditPersonalExpenseModal(id) {
  const exp = personalExpensesCache[id];
  if (!exp) return;

  editingPersonalExpenseId = id;
  document.getElementById('personalExpenseModalTitle').textContent = 'Edit Expense';
  document.getElementById('pExpDescription').value = exp.description || '';
  document.getElementById('pExpAmount').value = exp.amount || '';
  document.getElementById('pExpDate').value = exp.date || new Date().toISOString().split('T')[0];
  document.getElementById('pExpMode').value = exp.paymentMode || 'Cash';
  populatePersonalCategorySelect();
  document.getElementById('pExpCategory').value = exp.category || 'General';

  // Split linkage is a one-time, create-time decision — hide it on edit.
  document.getElementById('pExpSplitToggleRow').classList.toggle('hidden', !!exp.splitGroupId);
  document.getElementById('pExpSplitToggle').checked = false;
  document.getElementById('pExpSplitSection').classList.add('hidden');

  showModal('addPersonalExpenseModal');
}

function populatePersonalSplitGroupSelect() {
  const sel = document.getElementById('pExpSplitGroup');
  const myGroups = Object.entries(groupsSnapshot).filter(([, g]) => g);

  if (myGroups.length === 0) {
    sel.innerHTML = '<option value="">No groups available</option>';
    document.getElementById('pExpSplitMembersContainer').innerHTML = '<p class="empty-state-sm">Join or create a group first.</p>';
    return;
  }
  sel.innerHTML = myGroups.map(([id, g]) => `<option value="${id}">${escapeHtml(g.name)}</option>`).join('');
  loadPersonalSplitGroupMembers(sel.value);
}

function loadPersonalSplitGroupMembers(groupId) {
  const container = document.getElementById('pExpSplitMembersContainer');
  if (!groupId) { container.innerHTML = ''; return; }
  const group = groupsSnapshot[groupId];
  if (!group) { container.innerHTML = ''; return; }
  const memberIds = Object.keys(group.members || {});

  Promise.all(memberIds.map(uid => db.ref('users/' + uid).once('value').then(s => ({ uid, data: s.val() }))))
    .then(results => {
      personalSplitGroupMembersData = {};
      results.forEach(r => { if (r.data) personalSplitGroupMembersData[r.uid] = r.data; });
      container.innerHTML = memberIds.map(uid => {
        const u = personalSplitGroupMembersData[uid];
        if (!u) return '';
        return `
          <div class="split-member-row">
            <input type="checkbox" class="personal-split-checkbox" data-uid="${uid}" checked />
            <span>${escapeHtml(u.name)}${uid === currentUser.uid ? ' (You)' : ''}</span>
          </div>`;
      }).join('');
    });
}

function savePersonalExpense() {
  const description = document.getElementById('pExpDescription').value.trim();
  const amount = parseFloat(document.getElementById('pExpAmount').value);
  const category = document.getElementById('pExpCategory').value;
  const date = document.getElementById('pExpDate').value;
  const paymentMode = document.getElementById('pExpMode').value;
  const splitEnabled = !document.getElementById('pExpSplitToggleRow').classList.contains('hidden') && document.getElementById('pExpSplitToggle').checked;

  if (!description) return showToast('Enter a description', true);
  if (!amount || amount <= 0) return showToast('Enter a valid amount', true);
  if (!date) return showToast('Select a date', true);

  let splitGroupId = null;
  let splitAmong = null;

  if (splitEnabled) {
    splitGroupId = document.getElementById('pExpSplitGroup').value;
    if (!splitGroupId) return showToast('Select a group to split with', true);
    const checked = Array.from(document.querySelectorAll('.personal-split-checkbox:checked')).map(cb => cb.dataset.uid);
    if (checked.length === 0) return showToast('Select at least one member to split with', true);
    const share = Math.round((amount / checked.length) * 100) / 100;
    splitAmong = {};
    checked.forEach((uid, idx) => {
      splitAmong[uid] = (idx === checked.length - 1) ? Math.round((amount - share * (checked.length - 1)) * 100) / 100 : share;
    });
  }

  const btn = document.getElementById('savePersonalExpenseBtn');
  btn.disabled = true; btn.textContent = 'Saving...';

  const previousImpact = editingPersonalExpenseId && personalExpensesCache[editingPersonalExpenseId]
    ? personalExpensesCache[editingPersonalExpenseId].walletImpact
    : undefined;
  const walletTracked = typeof previousImpact === 'number';
  const walletActive = walletData !== null;

  const groupWrite = splitEnabled
    ? db.ref('expenses/' + splitGroupId).push().set({
        description, amount, category, date, paidBy: currentUser.uid, splitAmong,
        type: 'expense', createdBy: currentUser.uid, createdAt: firebase.database.ServerValue.TIMESTAMP
      })
    : Promise.resolve();

  groupWrite.then(() => {
    const payload = { date, description, category, paymentMode, amount, splitGroupId: splitGroupId || null };
    if (!editingPersonalExpenseId && walletActive) payload.walletImpact = amount;
    if (editingPersonalExpenseId && walletTracked) payload.walletImpact = amount;

    return editingPersonalExpenseId
      ? db.ref('personalExpenses/' + currentUser.uid + '/' + editingPersonalExpenseId).update(payload)
      : db.ref('personalExpenses/' + currentUser.uid).push().set({ ...payload, createdAt: firebase.database.ServerValue.TIMESTAMP });
  })
    .then(() => {
      if (!editingPersonalExpenseId && walletActive) {
        return db.ref('wallets/' + currentUser.uid + '/balance').transaction(current =>
          Math.round(((typeof current === 'number' ? current : 0) - amount) * 100) / 100
        );
      }
      if (editingPersonalExpenseId && walletTracked) {
        const delta = previousImpact - amount;
        return db.ref('wallets/' + currentUser.uid + '/balance').transaction(current =>
          Math.round(((typeof current === 'number' ? current : 0) + delta) * 100) / 100
        );
      }
      return Promise.resolve();
    })
    .then(() => {
      hideModal('addPersonalExpenseModal');
      showToast(editingPersonalExpenseId ? 'Expense updated' : 'Expense added');
      editingPersonalExpenseId = null;
    })
    .catch(err => showToast(err.message, true))
    .finally(() => { btn.disabled = false; btn.textContent = 'Save Expense'; });
}

// ---------- Personal expense detail ----------

function openPersonalExpenseDetail(id) {
  const exp = personalExpensesCache[id];
  if (!exp) return;
  currentPersonalDetailId = id;

  const splitGroup = exp.splitGroupId ? groupsSnapshot[exp.splitGroupId] : null;

  document.getElementById('personalExpenseDetailBody').innerHTML = `
    <div class="detail-header"><h4>${escapeHtml(exp.description)}</h4><div class="detail-amount">${formatCurrency(exp.amount)}</div></div>
    <div class="detail-meta">
      <div><span>Category</span><strong>${escapeHtml(exp.category || 'General')}</strong></div>
      <div><span>Payment mode</span><strong>${escapeHtml(exp.paymentMode || '-')}</strong></div>
      <div><span>Date</span><strong>${formatDateShort(exp.date)}</strong></div>
      ${splitGroup ? `<div><span>Split with</span><strong>${escapeHtml(splitGroup.name)}</strong></div>` : ''}
    </div>`;

  showModal('personalExpenseDetailModal');
}

function deletePersonalExpense(id) {
  if (!confirm('Delete this expense? This cannot be undone.')) return;
  const exp = personalExpensesCache[id];
  const impact = exp && typeof exp.walletImpact === 'number' ? exp.walletImpact : null;

  db.ref('personalExpenses/' + currentUser.uid + '/' + id).remove()
    .then(() => {
      if (impact === null) return Promise.resolve();
      return db.ref('wallets/' + currentUser.uid + '/balance').transaction(current =>
        Math.round(((typeof current === 'number' ? current : 0) + impact) * 100) / 100
      );
    })
    .then(() => { hideModal('personalExpenseDetailModal'); showToast('Expense deleted'); })
    .catch(err => showToast(err.message, true));
}

function loadWallet() {
  if (walletRef) walletRef.off();
  walletRef = db.ref('wallets/' + currentUser.uid + '/balance');
  walletRef.on('value', snap => {
    walletData = snap.exists() ? snap.val() : null;
    renderWalletCard();
  });
}

function renderWalletCard() {
  const card = document.getElementById('walletCard');
  const setupBtn = document.getElementById('setupWalletBtn');
  if (walletData === null) {
    card.classList.add('hidden');
    setupBtn.classList.remove('hidden');
    return;
  }
  setupBtn.classList.add('hidden');
  card.classList.remove('hidden');
  const balance = Number(walletData) || 0;
  const amtEl = document.getElementById('walletBalanceAmount');
  amtEl.textContent = formatCurrency(balance);
  amtEl.style.color = balance < 0 ? 'var(--owe)' : 'var(--text)';
}

function openWalletModal() {
  document.getElementById('walletAddAmount').value = '';
  document.getElementById('walletModalTitle').textContent = walletData === null ? 'Set Up Wallet' : 'Add to Wallet';
  showModal('walletModal');
}

function confirmWalletAdd() {
  const amount = parseFloat(document.getElementById('walletAddAmount').value);
  if (!amount || amount <= 0) return showToast('Enter a valid amount', true);

  const btn = document.getElementById('confirmWalletAddBtn');
  btn.disabled = true; btn.textContent = 'Adding...';

  db.ref('wallets/' + currentUser.uid + '/balance').transaction(current =>
    Math.round(((typeof current === 'number' ? current : 0) + amount) * 100) / 100
  ).then(() => { hideModal('walletModal'); showToast('Wallet updated'); })
    .catch(err => showToast(err.message, true))
    .finally(() => { btn.disabled = false; btn.textContent = 'Add to Wallet'; });
}
