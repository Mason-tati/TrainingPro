// ============================================================
// TrainTrack Web App - Frontend JS
// ============================================================

let currentUser = null;
let editingId = {};
let currentLookupType = 'dept';
let currentRosterId = null;
let cache = { staff: [], certs: [], jobs: [], depts: [], locs: [], shifts: [], emptypes: [], traintypes: [], classlocs: [] };

// ---- Application page registry (used for per-user page access control) ----
const APP_PAGES = [
  { section: 'Core', pages: [
    ['dashboard','📊 Dashboard'], ['my-training','🙋 My Training'] ] },
  { section: 'Records', pages: [
    ['employees','👥 Employees'], ['emp-report','👤 Employee Report'],
    ['training','🎓 Training Courses'], ['classes','📅 Classes'],
    ['calendar','🗓️ Calendar'], ['trainers','👨‍🏫 Trainers'], ['roster','🗂️ Shift Roster'],
    ['onboarding','🧑‍💼 Employee Onboarding'], ['disciplinary','⚖️ HR Disciplinary Action'], ['hr-forms','📋 HR Form Builder'],
    ['attendance','✅ Attendance'], ['leave-types','🏖️ Leave Types'], ['equipment','🚜 Equipment'], ['assignment','👷 Employee Assignment'],
    ['records','📋 Training Records'], ['requirements','✅ Requirements'], ['exams','📝 Online Exams'],
    ['exam-builder','🔨 Exam Builder'], ['field-assess','📋 Field Assessment'], ['forms','🧰 Form Builder'] ] },
  { section: 'Data', pages: [
    ['documents','📎 Document Library'], ['training-standards','📐 Training Standards'],
    ['training-material','🗂️ Training Material'], ['training-covers','🖼️ Training Material Covers'],
    ['translator','🌐 AI Translator'], ['content-studio','🤖 AI Content Studio'], ['template-forms','📋 Template Forms'], ['powerpoints','🎞️ Training PowerPoint Developer'], ['import','📤 Import / Export'] ] },
  { section: 'Knowledge', pages: [
    ['knowledge-base','📚 Knowledge Base'], ['competency','📊 Competency Management'], ['competency-builder','🏗️ Competency Builder'],
    ['competency-certificates','🎖️ Competency Certificates'] ] },
  { section: 'Insights', pages: [
    ['analytics','📈 Analytics'], ['matrix','🔲 Training Matrix'], ['notifications','🔔 Reminders'] ] },
  { section: 'Reports', pages: [
    ['rpt-expiring','⚠️ Expiring Soon'], ['rpt-expired','🔴 Expired'], ['rpt-missing','❌ Missing Training'],
    ['rpt-history','📈 Training History'], ['rpt-compliance','📑 Compliance'], ['rpt-workforce','🧑‍🤝‍🧑 Workforce / Gender'] ] },
  { section: 'Admin', pages: [
    ['admin-lookup','⚙️ Setup Lists'], ['admin-users','🔑 User Accounts'],
    ['admin-email','✉️ Email Settings'], ['workflows','🔀 Workflow Assignment'], ['admin-audit','🛡️ Audit Trail'] ] }
];
const ALL_PAGE_KEYS = APP_PAGES.flatMap(s => s.pages.map(p => p[0]));
// Pages every signed-in user may always reach (so nobody is fully locked out)
const ALWAYS_ALLOWED = ['dashboard','my-training'];

// ---- API helpers ----
async function api(method, url, body) {
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    if (r.status === 401) { showLogin(); return null; }
    const text = await r.text();
    try { return JSON.parse(text); }
    catch { return { error: `Server error ${r.status}: ${text.slice(0,120)}` }; }
  } catch (e) {
    return { error: 'Network error — ' + e.message };
  }
}
const GET = url => api('GET', url);
const POST = (url, b) => api('POST', url, b);
const PUT = (url, b) => api('PUT', url, b);
const DEL = url => api('DELETE', url);

// Robust file download — trigger a browser download of a Blob across browsers/environments. Tries the
// legacy msSaveBlob, then an <a download> click (dispatched as a real mouse event, kept in the DOM long
// enough to register), and finally opens the content in a new tab so the user can save it manually.
// Returns true if a download/open was initiated.
function downloadBlob(blob, filename) {
  try {
    if (window.navigator && window.navigator.msSaveOrOpenBlob) { window.navigator.msSaveOrOpenBlob(blob, filename); return true; }
  } catch {}
  let url;
  try {
    url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'download'; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a);
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    setTimeout(() => { try { a.remove(); } catch {} try { URL.revokeObjectURL(url); } catch {} }, 4000);
    return true;
  } catch (e) {
    // Last resort: open in a new tab (user can Save As). Keep the URL alive a while for the new tab.
    try { if (!url) url = URL.createObjectURL(blob); const w = window.open(url, '_blank'); setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 15000); return !!w; }
    catch { return false; }
  }
}
// Decode a base64 payload to a Blob of the given MIME type.
function b64ToBlob(b64, mime) {
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}
// Trigger a download of a real same-origin URL (served with Content-Disposition: attachment). Uses a hidden
// iframe, which triggers the browser's native download for an attachment response without navigating the
// app or being treated as a popup — the most reliable method in embedded / in-app browsers where a
// client-side blob download or a programmatic <a> click is blocked. Falls back to an <a download> click,
// then to top-level navigation.
function downloadViaUrl(url, filename) {
  try {
    let ifr = document.getElementById('__dl_iframe');
    if (!ifr) { ifr = document.createElement('iframe'); ifr.id = '__dl_iframe'; ifr.style.display = 'none'; document.body.appendChild(ifr); }
    ifr.src = url;
    return true;
  } catch {}
  try {
    const a = document.createElement('a');
    a.href = url; if (filename) a.download = filename; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a);
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    setTimeout(() => { try { a.remove(); } catch {} }, 4000);
    return true;
  } catch { try { window.location.href = url; return true; } catch { return false; } }
}
// Finish an export: prefer the server download URL (reliable everywhere); fall back to a client-side blob.
function finishDownload(r, fallbackBlob, label) {
  const name = (r && r.filename) || 'download';
  let okDl = false;
  if (r && r.downloadUrl) okDl = downloadViaUrl(r.downloadUrl, name);
  if (!okDl && fallbackBlob) okDl = downloadBlob(fallbackBlob, name);
  toast(okDl ? (label || 'File') + ' downloaded.' : 'Could not start the download — check your browser’s download settings.', okDl ? 'success' : 'error');
  return okDl;
}

// ---- Auth ----
async function doLogin() {
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  if (!username || !password) return showLoginError('Please enter username and password.');
  const r = await POST('/api/auth/login', { username, password });
  if (!r || r.error) return showLoginError(r ? r.error : 'Login failed');
  currentUser = r.user;
  showApp();
}
function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
async function doLogout() {
  await POST('/api/auth/logout');
  showLogin();
}
function showLogin() {
  document.getElementById('login-page').style.display = 'flex';
  document.getElementById('app').classList.add('hidden');
  currentUser = null;
}
async function showApp() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('sidebar-username').textContent = currentUser.username;
  document.getElementById('sidebar-role').textContent = currentUser.admin ? 'Administrator' : currentUser.examOnly ? 'Exam User' : 'Standard User';
  document.getElementById('sidebar-avatar').textContent = (currentUser.username || 'U').charAt(0).toUpperCase();
  document.getElementById('topbar-date').textContent = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  // Hide admin nav if not admin
  document.querySelectorAll('.admin-only').forEach(el => el.style.display = currentUser.admin ? '' : 'none');
  // Apply per-user page access (admins see everything)
  applyPageAccess();
  // Setup keyboard enter on login (already handled)
  await loadLookupCache();
  await populateAllDropdowns();
  initTenantSwitcher();
  navigateTo('dashboard');
  refreshNotifBadge();
}

// ── Tenant switcher + organisation management (scoped multi-tenant slice) ──────
async function initTenantSwitcher() {
  const wrap = document.getElementById('tenant-switch');
  if (!wrap) return;
  const r = await GET('/api/tenants/current');
  if (!r || r.error || !Array.isArray(r.tenants)) { wrap.style.display = 'none'; return; }
  const sel = document.getElementById('tenant-select');
  const many = r.tenants.length > 1;
  // Show the switcher when there is more than one org, or the user is an admin (to manage/create).
  if (!r.canSwitch && !many) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const curId = (r.current && r.current.TenantID) || 1;
  sel.innerHTML = r.tenants.map(t => `<option value="${t.TenantID}"${t.TenantID === curId ? ' selected' : ''}>${esc(t.Name)}${t.Status && t.Status !== 'Active' ? ' (inactive)' : ''}</option>`).join('');
  sel.disabled = !r.canSwitch;
  const gear = document.getElementById('tenant-manage');
  if (gear) gear.style.display = (currentUser && currentUser.admin) ? '' : 'none';
}
async function tenantSwitch(tenantId) {
  const r = await POST('/api/tenants/switch', { tenantId: parseInt(tenantId, 10) });
  if (!r || r.error) { toast((r && r.error) || 'Switch failed', 'error'); return; }
  toast('Now viewing: ' + (r.current ? r.current.Name : 'organisation'));
  // Reload the current page so tenant-scoped lists refresh under the new context.
  const active = document.querySelector('.page.active');
  const key = active && active.id ? active.id.replace(/^page-/, '') : 'dashboard';
  navigateTo(key);
}
async function openTenantManager() {
  const body = document.getElementById('tenant-modal-body');
  if (body) body.innerHTML = '<p class="text-soft">Loading…</p>';
  showModal('tenant-modal');
  const [tenants, users] = await Promise.all([GET('/api/tenants'), GET('/api/tenants/users')]);
  if (!Array.isArray(tenants)) { if (body) body.innerHTML = `<p class="cs-ver-empty">${esc((tenants && tenants.error) || 'Failed to load.')}</p>`; return; }
  _tenantList = tenants;
  const tRows = tenants.map(t => `
    <tr>
      <td><input class="tn-name" data-id="${t.TenantID}" value="${esc(t.Name)}" ${t.TenantID === 1 ? 'title="Primary organisation"' : ''}></td>
      <td class="cell-sub">${esc(t.Slug || '')}</td>
      <td style="text-align:center">${t.UserCount || 0}</td>
      <td style="text-align:center">${t.DocCount || 0}</td>
      <td>${t.TenantID === 1 ? '<span class="cs-status-badge cs-status-approved sm">Primary</span>'
            : `<select class="tn-status" data-id="${t.TenantID}"><option value="Active"${t.Status !== 'Inactive' ? ' selected' : ''}>Active</option><option value="Inactive"${t.Status === 'Inactive' ? ' selected' : ''}>Inactive</option></select>`}</td>
      <td><button class="btn btn-outline btn-sm" onclick="tenantSaveRow(${t.TenantID})">Save</button></td>
    </tr>`).join('');
  const tOpt = (sel) => tenants.map(t => `<option value="${t.TenantID}"${sel === t.TenantID ? ' selected' : ''}>${esc(t.Name)}</option>`).join('');
  const uRows = (Array.isArray(users) ? users : []).map(u => `
    <tr>
      <td>${esc(u.UserName)}${u.Admin ? ' <span class="cs-status-badge cs-status-published sm">admin</span>' : ''}</td>
      <td><select class="tn-user-assign" data-uid="${u.PSWDID}">${tOpt(u.TenantID)}</select></td>
      <td><button class="btn btn-outline btn-sm" onclick="tenantAssignUser(${u.PSWDID})">Assign</button></td>
    </tr>`).join('');
  body.innerHTML = `
    <div class="cs-map-section">
      <div class="cs-map-h">Organisations</div>
      <div class="table-responsive"><table class="cs-map-tbl"><thead><tr><th>Name</th><th>Slug</th><th>Users</th><th>Docs</th><th>Status</th><th></th></tr></thead><tbody>${tRows}</tbody></table></div>
      <div class="flex gap-2 mt-2">
        <input id="tn-new-name" placeholder="New organisation name" style="flex:1">
        <button class="btn btn-accent btn-sm" onclick="tenantCreate()">➕ Add organisation</button>
      </div>
    </div>
    <div class="cs-map-section">
      <div class="cs-map-h">Assign users to an organisation</div>
      <p class="text-soft" style="font-size:12px;margin-top:0">A user sees only their organisation's documents, knowledge base, exams and forms. Changes take effect at their next login.</p>
      <div class="table-responsive"><table class="cs-map-tbl"><thead><tr><th>User</th><th>Organisation</th><th></th></tr></thead><tbody>${uRows}</tbody></table></div>
    </div>`;
}
let _tenantList = [];
async function tenantSaveRow(id) {
  const nameEl = document.querySelector(`.tn-name[data-id="${id}"]`);
  const statusEl = document.querySelector(`.tn-status[data-id="${id}"]`);
  const r = await api('PATCH', '/api/tenants/' + id, { name: nameEl ? nameEl.value.trim() : undefined, status: statusEl ? statusEl.value : undefined });
  if (r && r.success) { toast('Organisation saved.'); initTenantSwitcher(); } else toast((r && r.error) || 'Save failed', 'error');
}
async function tenantCreate() {
  const el = document.getElementById('tn-new-name');
  const name = el ? el.value.trim() : '';
  if (!name) return toast('Enter an organisation name.', 'error');
  const r = await POST('/api/tenants', { name });
  if (r && r.success) { toast('Organisation created.'); openTenantManager(); initTenantSwitcher(); } else toast((r && r.error) || 'Create failed', 'error');
}
async function tenantAssignUser(userId) {
  const sel = document.querySelector(`.tn-user-assign[data-uid="${userId}"]`);
  if (!sel) return;
  const r = await POST('/api/tenants/assign', { userId, tenantId: parseInt(sel.value, 10) });
  if (r && r.success) { toast('User reassigned.'); openTenantManager(); } else toast((r && r.error) || 'Assign failed', 'error');
}

// ---- Per-user page access ----
function allowedPagesForUser() {
  if (!currentUser) return new Set(ALL_PAGE_KEYS);
  if (currentUser.admin) return new Set(ALL_PAGE_KEYS); // admins see everything
  const raw = (currentUser.pageAccess || '').trim();
  const chosen = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  // If nothing was configured, fall back to a minimal self-service set
  const base = chosen.length ? chosen : ['dashboard','my-training','exams'];
  ALWAYS_ALLOWED.forEach(p => { if (!base.includes(p)) base.push(p); });
  // emp-report is a sub-page of employees — grant it whenever employees is granted
  if (base.includes('employees') && !base.includes('emp-report')) base.push('emp-report');
  return new Set(base);
}
function canAccessPage(page) { return allowedPagesForUser().has(page); }
function applyPageAccess() {
  const allowed = allowedPagesForUser();
  document.querySelectorAll('.nav-link').forEach(a => {
    const pg = a.dataset.page;
    if (!pg) return;
    // admin-only links are already hidden for non-admins; respect that
    const adminBlocked = a.classList.contains('admin-only') && !currentUser.admin;
    a.style.display = (!adminBlocked && allowed.has(pg)) ? '' : 'none';
  });
  // Hide section headers that have no visible links under them
  document.querySelectorAll('.nav-section').forEach(sec => {
    let el = sec.nextElementSibling, anyVisible = false;
    while (el && !el.classList.contains('nav-section')) {
      if (el.classList.contains('nav-link') && el.style.display !== 'none') anyVisible = true;
      el = el.nextElementSibling;
    }
    sec.style.display = anyVisible ? '' : 'none';
  });
}

// ---- Navigation ----
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    navigateTo(link.dataset.page);
  });
});
function navigateTo(page) {
  // Enforce per-user page access (admins bypass)
  if (currentUser && !currentUser.admin && ALL_PAGE_KEYS.includes(page) && !canAccessPage(page)) {
    toast('You do not have access to that page.', 'error');
    page = 'dashboard';
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const pg = document.getElementById('page-' + page);
  if (pg) pg.classList.add('active');
  const link = document.querySelector(`.nav-link[data-page="${page}"]`);
  if (link) link.classList.add('active');
  const titles = {
    dashboard:'Dashboard', employees:'Employees', training:'Training Courses',
    classes:'Scheduled Classes', records:'Training Records', requirements:'Training Requirements',
    'rpt-expiring':'Expiring Soon', 'rpt-expired':'Expired Training',
    'rpt-missing':'Missing Training', 'rpt-history':'Training History',
    'rpt-compliance':'Compliance Report', 'rpt-workforce':'Workforce / Gender',
    'matrix':'Training Matrix', 'notifications':'Reminders & Alerts', 'exam-builder':'Exam Builder',
    'trainers':'Trainers / Instructors', 'calendar':'Training Calendar', 'roster':'Shift Roster',
    'forms':'Assessment Form Builder', 'field-assess':'Field Assessment',
    'my-training':'My Training', 'exams':'Online Exams',
    'admin-email':'Email Settings', 'admin-audit':'Audit Trail', 'documents':'Document Library', 'emp-report':'Employee Report',
    'admin-lookup':'Setup Lists', 'admin-users':'User Accounts', 'import':'Import / Export', 'workflows':'Workflow Assignment', 'translator':'AI Document Translator', 'content-studio':'AI Content Studio', 'training-standards':'Training Standards',
    'analytics':'Analytics', 'competency':'Competency Management', 'competency-builder':'Competency Builder', 'knowledge-base':'Knowledge Base',
    'training-material':'Training Material', 'training-covers':'Training Material Covers',
    'competency-certificates':'Competency Certificates', 'template-forms':'Template Forms',
    'powerpoints':'Training PowerPoint Developer',
    'onboarding':'Employee Onboarding',
    'attendance':'Attendance',
    'leave-types':'Leave Types & Bookings',
    'equipment':'Mobile Equipment',
    'assignment':'Employee Assignment',
    'disciplinary':'HR Disciplinary Action',
    'hr-forms':'HR Form Builder'
  };
  document.getElementById('page-title').textContent = titles[page] || page;
  // Load data for page
  const loaders = {
    dashboard: loadDashboard, employees: loadStaff, training: loadCerts,
    classes: loadClasses, records: loadRecords, requirements: loadRqd,
    'rpt-expiring': loadExpiring, 'rpt-expired': loadExpired,
    'rpt-missing': loadMissing, 'rpt-history': loadHistory,
    'rpt-compliance': loadCompliance, 'rpt-workforce': loadWorkforce,
    'matrix': loadMatrix, 'notifications': loadNotifications, 'exam-builder': loadExamBuilder,
    'trainers': loadTrainers, 'calendar': loadCalendar, 'roster': loadRoster,
    'forms': loadForms, 'field-assess': loadFieldAssess,
    'my-training': loadMyTraining, 'exams': loadExams,
    'admin-email': loadEmailSettings, 'admin-audit': () => { switchAuditTab('changes'); loadAudit(); },
    'documents': loadDocuments,
    'admin-lookup': () => loadLookupTab('dept'),
    'admin-users': loadUsers, 'import': resetImport, 'workflows': loadWorkflows, 'translator': loadTranslator, 'content-studio': loadContentStudio, 'training-standards': loadTrainingStandards, 'training-material': loadTrainingMaterial, 'training-covers': loadTrainingCovers, 'competency-certificates': loadCompetencyCerts,
    'analytics': loadAnalytics, 'competency': loadCompetency, 'competency-builder': loadCompetencyBuilder, 'knowledge-base': loadKnowledgeBase,
    'template-forms': loadTemplateForms,
    'powerpoints': loadPowerpoints,
    'onboarding': loadOnboarding,
    'attendance': loadAttendance,
    'leave-types': loadLeaveTypes,
    'equipment': loadEquipment,
    'assignment': loadAssignment,
    'disciplinary': loadDisciplinary,
    'hr-forms': loadHrForms,
    'emp-report': () => {}
  };
  if (loaders[page]) loaders[page]();
}

// ---- Lookup Cache ----
async function loadLookupCache() {
  const [staff, certs, jobs, depts, locs, shifts, emptypes, traintypes, classlocs, company] = await Promise.all([
    GET('/api/staff'), GET('/api/certs'), GET('/api/lookup/jobs'),
    GET('/api/lookup/depts'), GET('/api/lookup/locations'), GET('/api/lookup/shifts'),
    GET('/api/lookup/emptypes'), GET('/api/lookup/traintypes'), GET('/api/lookup/classlocs'),
    GET('/api/settings/company')
  ]);
  cache.staff = staff || [];
  cache.certs = certs || [];
  cache.jobs = jobs || [];
  cache.depts = depts || [];
  cache.locs = locs || [];
  cache.shifts = shifts || [];
  cache.emptypes = emptypes || [];
  cache.traintypes = traintypes || [];
  cache.classlocs = classlocs || [];
  cache.company = company ? { name: company.name || '', logo: company.logo || '' } : { name: '', logo: '' };
}

function populateSelect(id, items, valKey, labelKey, includeBlank) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const blank = includeBlank !== false ? `<option value="">-- Select --</option>` : '';
  sel.innerHTML = blank + items.map(i => `<option value="${i[valKey]}">${i[labelKey]}</option>`).join('');
}

// Like populateSelect but keeps the current value and uses a custom "all" label
function setSelectOptions(id, blankLabel, items, valKey, labelKey) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = `<option value="">${blankLabel}</option>` +
    (items||[]).map(i => `<option value="${i[valKey]}">${esc(i[labelKey]||'')}</option>`).join('');
  sel.value = cur;
}

async function populateAllDropdowns() {
  // Staff dropdowns
  populateSelect('staff-dept', cache.depts, 'DeptID', 'Department');
  populateSelect('s-DeptID', cache.depts, 'DeptID', 'Department');
  populateSelect('s-JobID', cache.jobs, 'JobID', 'Title');
  populateSelect('s-LocID', cache.locs, 'LocID', 'Location');
  populateSelect('s-ShiftID', cache.shifts, 'ShiftID', 'Shift');
  populateSelect('s-empTypeID', cache.emptypes, 'empTypeID', 'empType');
  // Cert dropdowns
  populateSelect('c-TrainTypeID', cache.traintypes, 'TrainTypeID', 'TrainType');
  // Parent course dropdown — only top-level (no parent) courses are valid parents
  const parentSel = document.getElementById('c-ParentCertID');
  if (parentSel) {
    const topLevel = (cache.certs || []).filter(c => !c.ParentCertID);
    parentSel.innerHTML = '<option value="">— None (this is a main course) —</option>' +
      topLevel.map(c => `<option value="${c.CertID}">${esc(c.CertName)}${c.CertNum?' ('+esc(c.CertNum)+')':''}</option>`).join('');
  }
  populateSelect('cert-type', [...new Set(cache.certs.map(c=>c.CertType).filter(Boolean))].map(t=>({v:t,l:t})), 'v', 'l');
  // Class dropdowns
  populateSelect('cl-CertID', cache.certs, 'CertID', 'CertName');
  populateSelect('cl-ClassLocID', cache.classlocs, 'ClassLocID', 'ClassLoc');
  // Record dropdowns
  const staffOpts = cache.staff.map(s => ({ v: s.StaffID, l: `${s.LastName}, ${s.FirstName}` })).sort((a,b)=>a.l.localeCompare(b.l));
  populateSelect('r-StaffID', staffOpts, 'v', 'l');
  populateSelect('rec-staff', staffOpts, 'v', 'l');
  populateSelect('hist-staff', staffOpts, 'v', 'l');
  populateSelect('u-staffID', staffOpts, 'v', 'l');
  populateSelect('r-CertID', cache.certs, 'CertID', 'CertName');
  populateSelect('rec-cert', cache.certs, 'CertID', 'CertName');
  populateSelect('hist-cert', cache.certs, 'CertID', 'CertName');
  // Record dept + shift filters
  setSelectOptions('rec-dept', 'All Departments', cache.depts, 'DeptID', 'Department');
  setSelectOptions('rec-shift', 'All Shift Patterns', cache.shifts, 'ShiftID', 'Shift');
  // Class dropdown in records
  const classes = await GET('/api/classes');
  const classOpts = (classes||[]).map(c=>({ v:c.ClassID, l:`${c.ClassName||c.CertName||''} ${c.ClassDate?'('+c.ClassDate+')':''}` }));
  populateSelect('r-ClassID', classOpts, 'v', 'l');
  // Requirements dropdowns
  populateSelect('rqd-cert', cache.certs, 'CertID', 'CertName');
  populateSelect('rqd-job', cache.jobs, 'JobID', 'Title');
  populateSelect('rqd-dept', cache.depts, 'DeptID', 'Department');
  populateSelect('rq-CertID', cache.certs, 'CertID', 'CertName');
  populateSelect('rq-JobID', cache.jobs, 'JobID', 'Title');
  populateSelect('rq-DeptID', cache.depts, 'DeptID', 'Department');
  populateSelect('rq-StaffID', staffOpts, 'v', 'l');
  // Reports
  populateSelect('hist-dept', cache.depts, 'DeptID', 'Department');
  const matrixDept = document.getElementById('matrix-dept');
  if (matrixDept) matrixDept.innerHTML = '<option value="">All Departments</option>' + cache.depts.map(d => `<option value="${d.DeptID}">${esc(d.Department)}</option>`).join('');
  // Users
  populateSelect('u-DeptID', cache.depts, 'DeptID', 'Department');
  populateSelect('u-LocID', cache.locs, 'LocID', 'Location');
  // Roster staff add
  populateSelect('roster-add-staff', staffOpts, 'v', 'l');
  // Exams (modal + builder)
  populateSelect('t-CertID', cache.certs, 'CertID', 'CertName');
  // If exam builder is open, refresh it
  if (ebCurrentId) GET('/api/exams/tests/' + ebCurrentId).then(t => { if (t) ebRenderPanel(t); });
  // Trainers
  cache.trainers = await GET('/api/trainers') || [];
  populateSelect('trainer-cert', cache.certs, 'CertID', 'CertName');
  const trCertSel = document.getElementById('trainer-cert');
  if (trCertSel) trCertSel.options[0].text = 'Qualified in any course';
  populateSelect('tr-StaffID', staffOpts, 'v', 'l');
  populateSelect('cl-TrainerID', cache.trainers.map(t => ({ v: t.TrainerID, l: `${t.LastName}, ${t.FirstName}` })), 'v', 'l');
}

// ---- Dashboard ----
let dashCharts = {};
async function loadDashboard() {
  const d = await GET('/api/reports/dashboard');
  if (!d) return;
  const card = (icon, cls, num, label) => `
    <div class="stat-card"><div class="stat-top"><div class="stat-icon ${cls}">${icon}</div></div>
    <div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`;
  const rateCls = d.complianceRate >= 90 ? 'green' : d.complianceRate >= 70 ? 'amber' : 'red';
  document.getElementById('dash-stats').innerHTML =
    card('📊', rateCls, d.complianceRate + '%', `Compliance Rate (${d.okReq}/${d.totalReq})`) +
    card('👥','indigo', d.totalStaff, 'Active Employees') +
    card('🎓','sky', d.totalCerts, 'Active Courses') +
    card('📅','violet', d.upcomingClasses, 'Upcoming Classes') +
    card('✅','green', d.completedThisMonth, 'Completed This Month') +
    card('⚠️','amber', d.expiringIn30, 'Expiring in 30 Days') +
    card('🔴','red', d.expiredTraining, 'Expired Records');

  document.getElementById('dash-expiring').innerHTML = d.expiringRecords.length ? `
    <div class="table-responsive"><table><thead><tr><th>Employee</th><th>Course</th><th>Expires</th></tr></thead>
    <tbody>${d.expiringRecords.map(r=>`<tr><td class="cell-strong">${r.LastName}, ${r.FirstName}</td><td>${r.CertName}</td><td><span class="badge badge-expiring">${fmtDate(r.Exp)}</span></td></tr>`).join('')}</tbody></table></div>
  ` : '<div class="empty-state"><div class="icon">✅</div><p>No training expiring soon</p></div>';
  document.getElementById('dash-recent').innerHTML = d.recentCompletions.length ? `
    <div class="table-responsive"><table><thead><tr><th>Employee</th><th>Course</th><th>Date</th></tr></thead>
    <tbody>${d.recentCompletions.map(r=>`<tr><td class="cell-strong">${r.LastName}, ${r.FirstName}</td><td>${r.CertName}</td><td>${fmtDate(r.Complete)}</td></tr>`).join('')}</tbody></table></div>
  ` : '<div class="empty-state"><div class="icon">📋</div><p>No recent completions</p></div>';

  renderDashCharts(d);
}

function renderDashCharts(d) {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.color = '#5a6072';

  // Bar chart: key metrics
  const ctx1 = document.getElementById('chart-status');
  if (ctx1) {
    if (dashCharts.status) dashCharts.status.destroy();
    dashCharts.status = new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: ['Completed\n(month)', 'Upcoming\nClasses', 'Expiring\n30d', 'Expired'],
        datasets: [{
          label: 'Records',
          data: [d.completedThisMonth, d.upcomingClasses, d.expiringIn30, d.expiredTraining],
          backgroundColor: ['#10b981', '#F58220', '#0ea5e9', '#ef4444'],
          borderRadius: 10, barThickness: 46
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, grid: { color: '#eef0f5' }, ticks: { precision: 0 } }, x: { grid: { display: false } } }
      }
    });
  }

  // Doughnut: compliance snapshot
  const ctx2 = document.getElementById('chart-compliance');
  if (ctx2) {
    if (dashCharts.compliance) dashCharts.compliance.destroy();
    const current = Math.max(0, d.completedThisMonth);
    dashCharts.compliance = new Chart(ctx2, {
      type: 'doughnut',
      data: {
        labels: ['Completed (month)', 'Expiring soon', 'Expired'],
        datasets: [{
          data: [current, d.expiringIn30, d.expiredTraining],
          backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
          borderWidth: 0, hoverOffset: 8
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: { legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true, pointStyle: 'circle' } } }
      }
    });
  }
}

// ---- Workforce / Gender ----
let wfCharts = {};
async function loadWorkforce() {
  const d = await GET('/api/reports/gender');
  if (!d) return;
  const total = d.overall.reduce((a, x) => a + x.n, 0);
  const male = (d.overall.find(x => x.Gender === 'Male') || {}).n || 0;
  const female = (d.overall.find(x => x.Gender === 'Female') || {}).n || 0;
  const pct = n => total ? Math.round(n / total * 100) : 0;
  const card = (icon, cls, num, label) => `
    <div class="stat-card"><div class="stat-top"><div class="stat-icon ${cls}">${icon}</div></div>
    <div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`;
  document.getElementById('wf-stats').innerHTML =
    card('👥','indigo', total, 'Total Active Workforce') +
    card('👨','sky', `${male} <span style="font-size:15px;color:var(--text-faint)">(${pct(male)}%)</span>`, 'Male Employees') +
    card('👩','violet', `${female} <span style="font-size:15px;color:var(--text-faint)">(${pct(female)}%)</span>`, 'Female Employees');

  document.getElementById('wf-tbody').innerHTML = d.bySite.length ? d.bySite.map(s => `
    <tr>
      <td class="cell-strong">${esc(s.Site)}</td>
      <td>${s.Male}</td><td>${s.Female}</td><td>${s.Other}</td>
      <td class="cell-strong">${s.Total}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty-state">No workforce data yet</td></tr>`;

  renderWorkforceCharts(d);
}

function renderWorkforceCharts(d) {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.font.family = "'Inter', sans-serif";
  const palette = { Male: '#0ea5e9', Female: '#a855f7', 'Not Specified': '#cbd5e1', Other: '#94a3b8' };

  const ctx1 = document.getElementById('chart-gender');
  if (ctx1) {
    if (wfCharts.gender) wfCharts.gender.destroy();
    wfCharts.gender = new Chart(ctx1, {
      type: 'doughnut',
      data: {
        labels: d.overall.map(x => x.Gender),
        datasets: [{ data: d.overall.map(x => x.n),
          backgroundColor: d.overall.map(x => palette[x.Gender] || '#f59e0b'),
          borderWidth: 0, hoverOffset: 8 }]
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '62%',
        plugins: { legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true, pointStyle: 'circle' } } } }
    });
  }

  const ctx2 = document.getElementById('chart-site-gender');
  if (ctx2) {
    if (wfCharts.site) wfCharts.site.destroy();
    wfCharts.site = new Chart(ctx2, {
      type: 'bar',
      data: {
        labels: d.bySite.map(s => s.Site),
        datasets: [
          { label: 'Male', data: d.bySite.map(s => s.Male), backgroundColor: '#0ea5e9', borderRadius: 6 },
          { label: 'Female', data: d.bySite.map(s => s.Female), backgroundColor: '#a855f7', borderRadius: 6 }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, pointStyle: 'circle' } } },
        scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#eef0f5' } } } }
    });
  }
}

// ---- Employees ----
async function loadStaff() {
  const params = new URLSearchParams({
    status: val('staff-status'), search: val('staff-search'), deptID: val('staff-dept')
  });
  const data = await GET('/api/staff?' + params);
  if (!data) return;
  document.getElementById('staff-tbody').innerHTML = data.length ? data.map(s => {
    const leaveBadge = s.OnLeaveType
      ? ` <span class="badge" style="background:${esc(s.OnLeaveColor||'#3b82f6')}1a;color:${esc(s.OnLeaveColor||'#3b82f6')};border:1px solid ${esc(s.OnLeaveColor||'#3b82f6')}40;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600" title="Approved leave until ${esc(s.OnLeaveEnd||'')}">🏖️ ${esc(s.OnLeaveType)}</span>`
      : '';
    return `
    <tr>
      <td><strong>${s.LastName}, ${s.FirstName}</strong>${leaveBadge}</td>
      <td>${s.FileNum||''}</td>
      <td>${s.Department||''}</td>
      <td>${s.JobTitle||''}</td>
      <td><span class="badge ${s.Status==='Active'?'badge-active':'badge-inactive'}">${s.Status||''}</span></td>
      <td>${fmtDate(s.StartDate)}</td>
      <td>${s.Email||''}</td>
      <td class="actions">
        <button class="btn btn-success btn-sm btn-icon" onclick="openEmployeeReport(${s.StaffID})" title="Full Report">📊</button>
        <button class="btn btn-outline btn-sm btn-icon" onclick="viewTranscript(${s.StaffID})" title="Transcript">📜</button>
        <button class="btn btn-primary btn-sm btn-icon" onclick="editStaff(${s.StaffID})" title="Edit">✏️</button>
        <button class="btn btn-danger btn-sm btn-icon" onclick="deleteStaff(${s.StaffID},'${esc(s.LastName)}, ${esc(s.FirstName)}')" title="Delete">🗑️</button>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" class="empty-state">No employees found</td></tr>`;
}

function openStaffModal(data) {
  editingId.staff = null;
  clearForm(['s-LastName','s-FirstName','s-FileNum','s-Status','s-Gender','s-DeptID','s-JobID','s-LocID','s-ShiftID','s-empTypeID','s-Supervisor','s-StartDate','s-EndDate','s-Note','s-Email','s-extension','s-HomePhone','s-CellPhone','s-Address']);
  document.getElementById('staff-modal-title').textContent = 'Add Employee';
  document.querySelectorAll('.staff-edit-only').forEach(el => el.classList.add('hidden'));
  switchTab('staff-tab-info', document.querySelector('.tab'));
  showModal('staff-modal');
}

async function editStaff(id) {
  editingId.staff = id;
  const s = await GET('/api/staff/' + id);
  if (!s) return;
  document.getElementById('staff-modal-title').textContent = `Edit: ${s.LastName}, ${s.FirstName}`;
  setVal('s-LastName', s.LastName); setVal('s-FirstName', s.FirstName);
  setVal('s-FileNum', s.FileNum); setVal('s-Status', s.Status);
  setVal('s-Gender', s.Gender);
  setVal('s-DeptID', s.DeptID); setVal('s-JobID', s.JobID);
  setVal('s-LocID', s.LocID); setVal('s-ShiftID', s.ShiftID);
  setVal('s-empTypeID', s.empTypeID); setVal('s-Supervisor', s.Supervisor);
  setVal('s-StartDate', s.StartDate); setVal('s-EndDate', s.EndDate);
  setVal('s-Note', s.Note); setVal('s-Email', s.Email);
  setVal('s-extension', s.extension); setVal('s-HomePhone', s.HomePhone);
  setVal('s-CellPhone', s.CellPhone); setVal('s-Address', s.Address);
  document.querySelectorAll('.staff-edit-only').forEach(el => el.classList.remove('hidden'));
  showModal('staff-modal');
  loadStaffTraining(id);
  loadStaffNotes(id);
  renderAttachments('staff', id, 'staff-docs');
  loadStaffRoles(id);
}

async function loadStaffTraining(id) {
  const data = await GET(`/api/staff/${id}/training`);
  if (!data) return;
  document.getElementById('staff-training-list').innerHTML = data.length ? `
    <table><thead><tr><th>Course</th><th>Completed</th><th>Expires</th><th>State</th><th>Score</th></tr></thead>
    <tbody>${data.map(r=>`
      <tr>
        <td>${r.CertName||''}</td>
        <td>${fmtDate(r.Complete)}</td>
        <td>${expBadge(r.Exp)}</td>
        <td>${r.State||''}</td>
        <td>${r.Score!=null?r.Score+'%':''}</td>
      </tr>`).join('')}
    </tbody></table>
  ` : '<div class="empty-state"><p>No training records found</p></div>';
}

async function loadStaffNotes(id) {
  const data = await GET(`/api/staff/${id}/notes`);
  if (!data) return;
  document.getElementById('staff-notes-list').innerHTML = data.map(n => `
    <div class="card mb-1"><div class="card-body" style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;">
      <div><strong>${fmtDate(n.Date)}</strong> — ${esc(n.Note)}</div>
      <button class="btn btn-danger btn-sm" onclick="deleteNote(${n.NoteID})">🗑️</button>
    </div></div>`).join('') || '<p class="text-muted">No notes.</p>';
}

async function addStaffNote() {
  if (!editingId.staff) return;
  const note = val('new-note-text');
  if (!note) return;
  await POST(`/api/staff/${editingId.staff}/notes`, { Note: note });
  setVal('new-note-text', '');
  loadStaffNotes(editingId.staff);
}

async function deleteNote(id) {
  if (!confirm('Delete this note?')) return;
  await DEL('/api/staff/notes/' + id);
  loadStaffNotes(editingId.staff);
}

async function saveStaff() {
  const d = {
    LastName: val('s-LastName'), FirstName: val('s-FirstName'), FileNum: val('s-FileNum'),
    Status: val('s-Status'), Gender: val('s-Gender'), DeptID: val('s-DeptID'), JobID: val('s-JobID'),
    LocID: val('s-LocID'), ShiftID: val('s-ShiftID'), empTypeID: val('s-empTypeID'),
    Supervisor: val('s-Supervisor'), StartDate: val('s-StartDate'), EndDate: val('s-EndDate'),
    Note: val('s-Note'), Email: val('s-Email'), extension: val('s-extension'),
    HomePhone: val('s-HomePhone'), CellPhone: val('s-CellPhone'), Address: val('s-Address')
  };
  if (!d.LastName || !d.FirstName) return toast('Last Name and First Name are required.', 'error');
  const editing = editingId.staff;
  const r = editing ? await PUT('/api/staff/' + editing, d) : await POST('/api/staff', d);
  if (!ok(r)) return;
  closeModal('staff-modal');
  toast(editing ? 'Employee updated.' : 'Employee added.');
  try { await loadLookupCache(); await populateAllDropdowns(); } catch (e) { /* refresh must not mask a successful save */ }
  loadStaff();
}

async function deleteStaff(id, name) {
  if (!confirm(`Remove employee "${name}"?`)) return;
  await DEL('/api/staff/' + id);
  loadStaff();
}

// ---- Training Courses ----
async function loadCerts() {
  const params = new URLSearchParams({ status: val('cert-status'), search: val('cert-search') });
  const data = await GET('/api/certs?' + params);
  if (!data) return;

  // Group into parent courses and their sub-courses
  const parents = data.filter(c => !c.ParentCertID);
  const childrenMap = {};
  data.filter(c => c.ParentCertID).forEach(c => {
    (childrenMap[c.ParentCertID] = childrenMap[c.ParentCertID] || []).push(c);
  });

  const certRow = (c, isChild) => `
    <tr class="${isChild ? 'subcourse-row' : ''}">
      <td>
        ${isChild ? '<span class="subcourse-indent">↳</span>' : ''}
        <strong>${esc(c.CertName)}</strong>
        ${!isChild && childrenMap[c.CertID] ? `<span class="badge badge-pending badge-plain" style="margin-left:6px">${childrenMap[c.CertID].length} sub-course${childrenMap[c.CertID].length>1?'s':''}</span>` : ''}
      </td>
      <td>${esc(c.CertNum||'')}</td>
      <td>${esc(c.CertType||'')}</td>
      <td>${c.TrHours||''}</td>
      <td>${c.Months ? c.Months+' mo' : 'No Expiry'}</td>
      <td>${c.Exam?'<span class="badge badge-active">Yes</span>':'No'}</td>
      <td><span class="badge ${c.Status==='Active'?'badge-active':'badge-inactive'}">${c.Status}</span></td>
      <td class="actions">
        ${!isChild ? `<button class="btn btn-success btn-sm btn-icon" onclick="openCertModal(${c.CertID},'${esc(c.CertName)}')" title="Add sub-course">＋</button>` : ''}
        <button class="btn btn-primary btn-sm btn-icon" onclick="editCert(${c.CertID})" title="Edit">✏️</button>
        <button class="btn btn-danger btn-sm btn-icon" onclick="deleteCert(${c.CertID},'${esc(c.CertName)}')" title="Delete">🗑️</button>
      </td>
    </tr>`;

  let rows = '';
  if (parents.length) {
    parents.forEach(p => {
      rows += certRow(p, false);
      (childrenMap[p.CertID] || []).forEach(child => { rows += certRow(child, true); });
    });
    // orphaned sub-courses (parent filtered out by search/status)
    data.filter(c => c.ParentCertID && !parents.find(p => p.CertID === c.ParentCertID))
        .forEach(c => { rows += certRow(c, false); });
  } else {
    rows = `<tr><td colspan="8" class="empty-state">No courses found</td></tr>`;
  }
  document.getElementById('cert-tbody').innerHTML = rows;
}

function openCertModal(parentId, parentName) {
  editingId.cert = null;
  clearForm(['c-CertName','c-CertNum','c-CertType','c-TrainTypeID','c-Status','c-TrHours','c-Months','c-CurrentRev','c-ReleaseDate','c-Exam','c-StandardBased','c-LinkDoc','c-TrainDesc','c-AltText','c-ParentCertID']);
  document.getElementById('cert-modal-title').textContent = parentId ? `Add Sub-Course under: ${esc(parentName||'')}` : 'Add Training Course';
  if (parentId) setVal('c-ParentCertID', parentId);
  document.getElementById('cert-docs-section').classList.add('hidden');
  showModal('cert-modal');
}

async function editCert(id) {
  editingId.cert = id;
  const c = await GET('/api/certs/' + id);
  if (!c) return;
  document.getElementById('cert-modal-title').textContent = 'Edit: ' + c.CertName;
  setVal('c-CertName', c.CertName); setVal('c-CertNum', c.CertNum);
  setVal('c-CertType', c.CertType); setVal('c-TrainTypeID', c.TrainTypeID);
  setVal('c-Status', c.Status); setVal('c-TrHours', c.TrHours);
  setVal('c-Months', c.Months); setVal('c-CurrentRev', c.CurrentRev);
  setVal('c-ReleaseDate', c.ReleaseDate); setVal('c-Exam', c.Exam);
  setVal('c-StandardBased', c.StandardBased); setVal('c-LinkDoc', c.LinkDoc);
  setVal('c-TrainDesc', c.TrainDesc); setVal('c-AltText', c.AltText);
  setVal('c-ParentCertID', c.ParentCertID || '');
  document.getElementById('cert-docs-section').classList.remove('hidden');
  renderAttachments('cert', id, 'cert-docs');
  showModal('cert-modal');
}

async function saveCert() {
  const d = {
    CertName: val('c-CertName'), CertNum: val('c-CertNum'), CertType: val('c-CertType'),
    TrainTypeID: val('c-TrainTypeID'), Status: val('c-Status'), TrHours: val('c-TrHours'),
    Months: val('c-Months'), CurrentRev: val('c-CurrentRev'), ReleaseDate: val('c-ReleaseDate'),
    Exam: val('c-Exam'), StandardBased: val('c-StandardBased'), LinkDoc: val('c-LinkDoc'),
    TrainDesc: val('c-TrainDesc'), AltText: val('c-AltText'), ExpPeriod: 'M',
    ParentCertID: val('c-ParentCertID') || null
  };
  if (!d.CertName) return toast('Course Name is required.', 'error');
  const editing = editingId.cert;
  const r = editing ? await PUT('/api/certs/' + editing, d) : await POST('/api/certs', d);
  if (!ok(r)) return;
  closeModal('cert-modal');
  toast(editing ? 'Course updated.' : 'Course added.');
  try { await loadLookupCache(); await populateAllDropdowns(); } catch (e) { /* refresh must not mask a successful save */ }
  loadCerts();
}

async function deleteCert(id, name) {
  if (!confirm(`Delete course "${name}"?`)) return;
  await DEL('/api/certs/' + id);
  loadCerts();
}

// ---- Classes ----
async function loadClasses() {
  const params = new URLSearchParams({ search: val('class-search'), upcoming: val('class-upcoming') });
  const data = await GET('/api/classes?' + params);
  if (!data) return;
  document.getElementById('class-tbody').innerHTML = data.length ? data.map(c => `
    <tr>
      <td><strong>${c.ClassName||c.CertName||''}</strong></td>
      <td>${c.CertName||''}</td>
      <td>${fmtDate(c.ClassDate)}</td>
      <td>${c.TimeStart||''} ${c.TimeEnd?'- '+c.TimeEnd:''}</td>
      <td>${c.ClassLoc||c.ClassLocation||''}</td>
      <td>${c.OfferedBy||''}</td>
      <td>${c.Enrolled||0}${c.ClassCapacity?' / '+c.ClassCapacity:''}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick="viewRoster(${c.ClassID},'${esc(c.ClassName||c.CertName||'')}')" title="Roster">👥</button>
        <button class="btn btn-primary btn-sm btn-icon" onclick="editClass(${c.ClassID})" title="Edit">✏️</button>
        <button class="btn btn-danger btn-sm btn-icon" onclick="deleteClass(${c.ClassID})" title="Delete">🗑️</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="8" class="empty-state">No classes found</td></tr>`;
}

function openClassModal() {
  editingId.cls = null;
  clearForm(['cl-CertID','cl-ClassName','cl-ClassNum','cl-OfferedBy','cl-ClassDate','cl-TimeStart','cl-TimeEnd','cl-ClassLocID','cl-ClassLocation','cl-EstCost','cl-TrainerID','cl-MaxSeats']);
  filterTrainersForCourse();
  document.getElementById('class-modal-title').textContent = 'Schedule a Class';
  showModal('class-modal');
}

async function editClass(id) {
  editingId.cls = id;
  const c = await GET('/api/classes/' + id);
  if (!c) return;
  document.getElementById('class-modal-title').textContent = 'Edit Class';
  setVal('cl-CertID', c.CertID); setVal('cl-ClassName', c.ClassName);
  setVal('cl-ClassNum', c.ClassNum); setVal('cl-OfferedBy', c.OfferedBy);
  setVal('cl-ClassDate', c.ClassDate); setVal('cl-TimeStart', c.TimeStart);
  setVal('cl-TimeEnd', c.TimeEnd); setVal('cl-ClassLocID', c.ClassLocID);
  setVal('cl-ClassLocation', c.ClassLocation); setVal('cl-EstCost', c.EstCost);
  setVal('cl-MaxSeats', c.MaxSeats);
  filterTrainersForCourse(); setVal('cl-TrainerID', c.TrainerID);
  showModal('class-modal');
}

// Restrict the trainer dropdown to those qualified for the chosen course
async function filterTrainersForCourse() {
  const certID = val('cl-CertID');
  const sel = document.getElementById('cl-TrainerID');
  if (!sel) return;
  const cur = sel.value;
  // Qualified trainers if a course is chosen; otherwise all trainers
  const list = certID ? (await GET('/api/trainers?certID=' + certID) || []) : (cache.trainers || []);
  sel.innerHTML = '<option value="">-- Select trainer --</option>' +
    list.map(t => `<option value="${t.TrainerID}">${esc(t.LastName)}, ${esc(t.FirstName)}${t.Status!=='Active'?' (inactive)':''}</option>`).join('');
  if (cur) sel.value = cur;
}

async function saveClass() {
  const d = {
    CertID: val('cl-CertID'), ClassName: val('cl-ClassName'), ClassNum: val('cl-ClassNum'),
    OfferedBy: val('cl-OfferedBy'), ClassDate: val('cl-ClassDate'), TimeStart: val('cl-TimeStart'),
    TimeEnd: val('cl-TimeEnd'), ClassLocID: val('cl-ClassLocID'), TrainerID: val('cl-TrainerID'),
    MaxSeats: val('cl-MaxSeats'), ClassLocation: val('cl-ClassLocation'), EstCost: val('cl-EstCost'),
    ClassID: editingId.cls
  };
  if (!d.CertID) return toast('Please select a course.', 'error');
  // Conflict pre-check (trainer / room double-booking)
  const conflicts = await POST('/api/classes/check-conflicts', d);
  if (Array.isArray(conflicts) && conflicts.length) {
    if (!confirm('⚠️ Scheduling conflict:\n\n' + conflicts.map(c => '• ' + c.message).join('\n') + '\n\nSchedule anyway?')) return;
  }
  const editing = editingId.cls;
  const r = editing ? await PUT('/api/classes/' + editing, d) : await POST('/api/classes', d);
  if (!ok(r)) return;
  closeModal('class-modal');
  toast(editing ? 'Class updated.' : 'Class scheduled.');
  loadClasses();
  if (document.getElementById('page-calendar').classList.contains('active')) loadCalendar();
}

async function deleteClass(id) {
  if (!confirm('Delete this class?')) return;
  await DEL('/api/classes/' + id);
  loadClasses();
}

// ---- Class Roster / Booking ----
let rosterClass = null;
async function viewRoster(classId, name) {
  currentRosterId = classId;
  rosterClass = await GET('/api/classes/' + classId);
  document.getElementById('roster-title').textContent = 'Roster: ' + (name || (rosterClass && rosterClass.ClassName) || '');
  await loadRoster();
  showModal('roster-modal');
}

async function loadRoster() {
  const data = await GET('/api/classes/' + currentRosterId + '/roster');
  if (!data) return;
  const cap = rosterClass ? rosterClass.Capacity : null;
  const active = data.filter(r => !['Waitlisted','Cancelled'].includes(r.State));
  const wait = data.filter(r => r.State === 'Waitlisted');
  const pct = cap ? Math.min(100, Math.round(active.length / cap * 100)) : 0;
  document.getElementById('roster-capacity').innerHTML = `
    <div class="flex items-center gap-2" style="justify-content:space-between">
      <div><strong>${active.length}</strong>${cap ? ' / ' + cap : ''} booked${wait.length ? ` · <span class="badge badge-expiring badge-plain">${wait.length} waitlisted</span>` : ''}</div>
      ${rosterClass && rosterClass.ClassDate ? `<div class="cell-sub">${fmtDate(rosterClass.ClassDate)} ${rosterClass.TimeStart||''}${rosterClass.TimeEnd?'–'+rosterClass.TimeEnd:''} ${rosterClass.TrainerLast?'· '+esc(rosterClass.TrainerFirst+' '+rosterClass.TrainerLast):''}</div>` : ''}
    </div>
    ${cap ? `<div class="capacity-bar mt-1"><div class="capacity-fill" style="width:${pct}%;background:${pct>=100?'var(--danger)':pct>=80?'var(--warning)':'var(--success)'}"></div></div>` : ''}`;

  const stBadge = s => {
    const m = { Registered:'badge-pending', Confirmed:'badge-current', Attended:'badge-active', 'No-Show':'badge-expired', Cancelled:'badge-inactive', Waitlisted:'badge-expiring' };
    return `<span class="badge ${m[s]||'badge-inactive'} badge-plain">${s||'Registered'}</span>`;
  };
  let n = 0;
  document.getElementById('roster-tbody').innerHTML = data.length ? data.map(r => {
    const wl = r.State === 'Waitlisted';
    if (!wl) n++;
    return `<tr ${wl?'style="opacity:.7"':''}>
      <td>${wl ? 'WL' : n}</td>
      <td class="cell-strong">${esc(r.LastName)}, ${esc(r.FirstName)}</td>
      <td>${esc(r.FileNum||'')}</td>
      <td>${esc(r.Department||'')}</td>
      <td>${stBadge(r.State)}</td>
      <td class="actions">
        ${!wl ? `<button class="btn btn-success btn-sm" onclick="setBookingStatus(${r.RegisterID},'Attended')" title="Mark attended">✅</button>
        <button class="btn btn-warning btn-sm" onclick="setBookingStatus(${r.RegisterID},'No-Show')" title="No-show">🚫</button>` : ''}
        <button class="btn btn-danger btn-sm btn-icon" onclick="setBookingStatus(${r.RegisterID},'Cancelled')" title="Cancel booking">✕</button>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" class="empty-state">No bookings yet</td></tr>`;
}

async function addToRoster() {
  const staffID = val('roster-add-staff');
  if (!staffID) return toast('Please select an employee.', 'error');
  let r = await POST(`/api/classes/${currentRosterId}/book`, { staffId: staffID });
  // 409 conflict → confirm and force
  if (r && r.conflict) {
    if (!confirm('⚠️ ' + r.conflict + '\n\nBook anyway?')) return;
    r = await POST(`/api/classes/${currentRosterId}/book`, { staffId: staffID, force: true });
  }
  if (!ok(r)) return;
  toast(r.waitlisted ? 'Class full — added to waitlist.' : 'Employee booked.', r.waitlisted ? 'info' : 'success');
  loadRoster();
}

async function setBookingStatus(regId, status) {
  if (status === 'Cancelled' && !confirm('Cancel this booking?')) return;
  const r = await PUT(`/api/classes/booking/${regId}/status`, { status });
  if (!ok(r)) return;
  toast(status === 'Attended' ? 'Marked attended — completion recorded.' : 'Booking ' + status.toLowerCase() + '.');
  if (r.promoted) toast('A waitlisted employee was promoted to the class.', 'info');
  loadRoster();
}

function printSignInSheet() {
  GET('/api/classes/' + currentRosterId + '/roster').then(data => {
    const c = rosterClass || {};
    const active = (data || []).filter(r => !['Cancelled','Waitlisted'].includes(r.State));
    const rows = active.map((r, i) => `<tr><td>${i+1}</td><td>${esc(r.LastName)}, ${esc(r.FirstName)}</td><td>${esc(r.FileNum||'')}</td><td style="width:200px"></td></tr>`).join('');
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Sign-In Sheet</title><style>
      body{font-family:Arial,sans-serif;padding:36px;color:#1a1d28}h1{font-size:20px}
      .meta{margin:8px 0 18px;color:#555;font-size:13px}
      table{width:100%;border-collapse:collapse}th,td{border:1px solid #999;padding:9px 10px;text-align:left;font-size:13px}
      th{background:#eee}</style></head><body>
      <h1>Training Sign-In Sheet</h1>
      <div class="meta"><strong>${esc(c.ClassName||c.CertName||'')}</strong><br>
      Date: ${fmtDate(c.ClassDate)||'__________'} &nbsp; Time: ${c.TimeStart||'____'}–${c.TimeEnd||'____'}<br>
      Trainer: ${c.TrainerLast?esc(c.TrainerFirst+' '+c.TrainerLast):'__________'} &nbsp; Location: ${esc(c.ClassLoc||c.ClassLocation||'__________')}</div>
      <table><thead><tr><th>#</th><th>Name</th><th>File #</th><th>Signature</th></tr></thead><tbody>${rows||'<tr><td colspan=4>No attendees</td></tr>'}</tbody></table>
      </body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
  });
}

// ---- Training Records ----
async function loadRecords() {
  const params = new URLSearchParams({ staffID: val('rec-staff'), certID: val('rec-cert'), state: val('rec-state'), deptID: val('rec-dept'), shiftID: val('rec-shift') });
  const data = await GET('/api/register?' + params);
  if (!data) return;
  document.getElementById('rec-tbody').innerHTML = data.length ? data.map(r => `
    <tr>
      <td>${r.LastName||''}, ${r.FirstName||''}</td>
      <td>${r.CertName||''}</td>
      <td>${fmtDate(r.Complete)}</td>
      <td>${expBadge(r.Exp)}</td>
      <td>${r.State||''}</td>
      <td>${r.Score!=null?r.Score+'%':''}</td>
      <td>${r.Pass!=null?(r.Pass?'<span class="badge badge-active">Pass</span>':'<span class="badge badge-expired">Fail</span>'):''}</td>
      <td class="actions">
        ${r.SignBy ? `<span class="badge badge-active badge-plain" title="Signed by ${esc(r.SignBy)} on ${fmtDate(r.SignDate)}">✍️ ${esc(r.SignBy)}</span>`
          : `<button class="btn btn-outline btn-sm btn-icon" onclick="openSign(${r.RegisterID})" title="Sign off">✍️</button>`}
        <button class="btn btn-primary btn-sm btn-icon" onclick="editRecord(${r.RegisterID})" title="Edit">✏️</button>
        <button class="btn btn-danger btn-sm btn-icon" onclick="deleteRecord(${r.RegisterID})" title="Delete">🗑️</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="8" class="empty-state">No records found</td></tr>`;
}

function openRecordModal() {
  editingId.rec = null;
  clearForm(['r-StaffID','r-CertID','r-ClassID','r-State','r-Complete','r-Exp','r-Score','r-Pass','r-Rev','r-DueBy']);
  setVal('r-State', 'Completed');
  document.getElementById('rec-modal-title').textContent = 'Add Training Record';
  showModal('record-modal');
}

async function editRecord(id) {
  const data = await GET('/api/register?staffID=');
  // get by fetching all and find — simpler approach
  const all = await GET('/api/register');
  const r = all && all.find(x => x.RegisterID == id);
  if (!r) return;
  editingId.rec = id;
  document.getElementById('rec-modal-title').textContent = 'Edit Training Record';
  setVal('r-StaffID', r.StaffID); setVal('r-CertID', r.CertID);
  setVal('r-ClassID', r.ClassID); setVal('r-State', r.State);
  setVal('r-Complete', r.Complete); setVal('r-Exp', r.Exp);
  setVal('r-Score', r.Score); setVal('r-Pass', r.Pass);
  setVal('r-Rev', r.Rev); setVal('r-DueBy', r.DueBy);
  showModal('record-modal');
}

async function recalcExp() {
  const certID = val('r-CertID');
  const complete = val('r-Complete');
  if (!certID || !complete) return;
  const cert = cache.certs.find(c => c.CertID == certID);
  if (cert && cert.Months) {
    const d = new Date(complete);
    d.setMonth(d.getMonth() + parseInt(cert.Months));
    setVal('r-Exp', d.toISOString().split('T')[0]);
  }
}

async function saveRecord() {
  const d = {
    StaffID: val('r-StaffID'), CertID: val('r-CertID'), ClassID: val('r-ClassID'),
    State: val('r-State'), Complete: val('r-Complete'), Exp: val('r-Exp'),
    Score: val('r-Score'), Pass: val('r-Pass'), Rev: val('r-Rev'), DueBy: val('r-DueBy')
  };
  if (!d.StaffID || !d.CertID) return toast('Employee and Course are required.', 'error');
  const editing = editingId.rec;
  const r = editing ? await PUT('/api/register/' + editing, d) : await POST('/api/register', d);
  if (!ok(r)) return;
  closeModal('record-modal');
  toast(editing ? 'Record updated.' : 'Training record added.');
  loadRecords();
}

async function deleteRecord(id) {
  if (!confirm('Delete this training record?')) return;
  await DEL('/api/register/' + id);
  loadRecords();
}

// ---- Requirements ----
async function loadRqd() {
  const params = new URLSearchParams({ certID: val('rqd-cert'), jobID: val('rqd-job'), deptID: val('rqd-dept') });
  const data = await GET('/api/requirements?' + params);
  if (!data) return;
  document.getElementById('rqd-tbody').innerHTML = data.length ? data.map(r => `
    <tr>
      <td><strong>${r.CertName||''}</strong> ${r.CertNum?'<small>('+r.CertNum+')</small>':''}</td>
      <td>${r.Title?'Job: <strong>'+r.Title+'</strong>':''} ${r.Department?'Dept: <strong>'+r.Department+'</strong>':''} ${r.LastName?r.LastName+', '+r.FirstName:''}</td>
      <td>${r.ReqTypeID||'Required'}</td>
      <td>${fmtDate(r.DueByDate)}</td>
      <td class="actions">
        <button class="btn btn-danger btn-sm btn-icon" onclick="deleteRqd(${r.RqdID})" title="Remove">🗑️</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty-state">No requirements defined</td></tr>`;
}

function openRqdModal() {
  clearForm(['rq-CertID','rq-JobID','rq-DeptID','rq-StaffID','rq-DueByDate']);
  showModal('rqd-modal');
}

async function saveRqd() {
  const d = {
    CertID: val('rq-CertID'), JobID: val('rq-JobID'),
    DeptID: val('rq-DeptID'), StaffID: val('rq-StaffID'),
    DueByDate: val('rq-DueByDate')
  };
  if (!d.CertID) return toast('Course is required.', 'error');
  if (!d.JobID && !d.DeptID && !d.StaffID) return toast('Select a Job Title, Department, or Employee.', 'error');
  const r = await POST('/api/requirements', d);
  if (!ok(r)) return;
  closeModal('rqd-modal');
  toast('Requirement added.');
  loadRqd();
}

async function deleteRqd(id) {
  if (!confirm('Remove this requirement?')) return;
  await DEL('/api/requirements/' + id);
  loadRqd();
}

// ---- Reports ----
async function loadExpiring() {
  const days = val('exp-days') || 60;
  const data = await GET('/api/reports/expiring?days=' + days);
  if (!data) return;
  const today = new Date();
  document.getElementById('exp-tbody').innerHTML = data.length ? data.map(r => {
    const exp = new Date(r.Exp);
    const daysLeft = Math.ceil((exp - today) / 86400000);
    return `<tr>
      <td>${r.LastName}, ${r.FirstName}</td><td>${r.FileNum||''}</td>
      <td>${r.Department||''}</td><td>${r.CertName}</td>
      <td>${fmtDate(r.Complete)}</td>
      <td><span class="badge badge-expiring">${fmtDate(r.Exp)}</span></td>
      <td><strong>${daysLeft}</strong> days</td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" class="empty-state">No expiring records in this period</td></tr>`;
}

async function loadExpired() {
  const data = await GET('/api/reports/expired');
  if (!data) return;
  const today = new Date();
  document.getElementById('expired-tbody').innerHTML = data.length ? data.map(r => {
    const exp = new Date(r.Exp);
    const overdue = Math.ceil((today - exp) / 86400000);
    return `<tr>
      <td>${r.LastName}, ${r.FirstName}</td><td>${r.FileNum||''}</td>
      <td>${r.Department||''}</td><td>${r.CertName}</td>
      <td>${fmtDate(r.Complete)}</td>
      <td><span class="badge badge-expired">${fmtDate(r.Exp)}</span></td>
      <td><strong>${overdue}</strong> days</td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" class="empty-state">No expired records</td></tr>`;
}

async function loadMissing() {
  const data = await GET('/api/reports/missing');
  if (!data) return;
  document.getElementById('missing-tbody').innerHTML = data.length ? data.map(r => `
    <tr>
      <td>${r.LastName}, ${r.FirstName}</td><td>${r.FileNum||''}</td>
      <td>${r.Department||''}</td><td>${r.JobTitle||''}</td>
      <td><strong>${r.CertName}</strong></td><td>${r.CertNum||''}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty-state">✅ All required training is complete!</td></tr>`;
}

async function loadHistory() {
  const params = new URLSearchParams({
    staffID: val('hist-staff'), certID: val('hist-cert'),
    deptID: val('hist-dept'), from: val('hist-from'), to: val('hist-to')
  });
  const data = await GET('/api/reports/history?' + params);
  if (!data) return;
  document.getElementById('hist-tbody').innerHTML = data.length ? data.map(r => `
    <tr>
      <td>${r.LastName}, ${r.FirstName}</td><td>${r.FileNum||''}</td>
      <td>${r.Department||''}</td><td>${r.CertName||''}</td>
      <td>${r.ClassName||''} ${r.ClassDate?'('+fmtDate(r.ClassDate)+')':''}</td>
      <td>${fmtDate(r.Complete)}</td><td>${expBadge(r.Exp)}</td>
      <td>${r.Score!=null?r.Score+'%':''}</td>
      <td>${r.Pass!=null?(r.Pass?'<span class="badge badge-active">Pass</span>':'<span class="badge badge-expired">Fail</span>'):''}</td>
    </tr>`).join('') : `<tr><td colspan="9" class="empty-state">No records found</td></tr>`;
}

async function loadCompliance() {
  const data = await GET('/api/requirements/compliance');
  if (!data) return;
  document.getElementById('comp-tbody').innerHTML = data.length ? data.map(r => `
    <tr>
      <td>${r.LastName}, ${r.FirstName}</td><td>${r.FileNum||''}</td>
      <td>${r.Department||''}</td><td>${r.JobTitle||''}</td>
      <td>${r.CertName}</td>
      <td>${r.IsComplete ? '<span class="badge badge-current">Current</span>' : r.Expiration && new Date(r.Expiration)<new Date() ? '<span class="badge badge-expired">Expired</span>' : '<span class="badge badge-inactive">Missing</span>'}</td>
      <td>${fmtDate(r.LastCompleted)}</td>
      <td>${expBadge(r.Expiration)}</td>
    </tr>`).join('') : `<tr><td colspan="8" class="empty-state">No compliance data — add requirements first</td></tr>`;
}

// ---- Admin: Lookup Tables ----
const lookupConfig = {
  dept:       { title:'Departments',    api:'/api/lookup/depts',     pk:'DeptID',      label:'Department' },
  jobs:       { title:'Job Titles',     api:'/api/lookup/jobs',      pk:'JobID',       label:'Title' },
  locations:  { title:'Locations',      api:'/api/lookup/locations', pk:'LocID',       label:'Location' },
  shifts:     { title:'Shifts',         api:'/api/lookup/shifts',    pk:'ShiftID',     label:'Shift' },
  emptypes:   { title:'Employee Types', api:'/api/lookup/emptypes',  pk:'empTypeID',   label:'empType' },
  traintypes: { title:'Training Types', api:'/api/lookup/traintypes',pk:'TrainTypeID', label:'TrainType' },
  classlocs:  { title:'Class Rooms',    api:'/api/lookup/classlocs', pk:'ClassLocID',  label:'ClassLoc' }
};

function switchLookupTab(type, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  currentLookupType = type;
  const isCompany = type === 'company';
  document.getElementById('lookup-list-card').classList.toggle('hidden', isCompany);
  document.getElementById('lookup-company-card').classList.toggle('hidden', !isCompany);
  if (isCompany) { loadCompanySettings(); return; }
  loadLookupTab(type);
}

async function loadLookupTab(type) {
  currentLookupType = type;
  const cfg = lookupConfig[type];
  document.getElementById('lookup-title').textContent = cfg.title;
  const data = await GET(cfg.api);
  if (!data) return;
  document.getElementById('lookup-tbody').innerHTML = data.length ? data.map(item => `
    <tr>
      <td><input id="lookup-edit-${item[cfg.pk]}" value="${esc(item[cfg.label]||'')}" style="width:100%;padding:5px 8px;border:1.5px solid #dee2e6;border-radius:4px;font-size:13.5px;"></td>
      <td class="actions">
        <button class="btn btn-success btn-sm" onclick="saveLookupItem(${item[cfg.pk]})">Save</button>
        <button class="btn btn-danger btn-sm" onclick="deleteLookupItem(${item[cfg.pk]})">🗑️</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="2" class="empty-state">No items yet</td></tr>`;
}

async function addLookupItem() {
  const cfg = lookupConfig[currentLookupType];
  const name = prompt(`Enter new ${cfg.title} name:`);
  if (!name) return;
  const body = {};
  body[cfg.label] = name;
  await POST(cfg.api, body);
  await loadLookupCache();
  await populateAllDropdowns();
  loadLookupTab(currentLookupType);
}

async function saveLookupItem(id) {
  const cfg = lookupConfig[currentLookupType];
  const val2 = document.getElementById('lookup-edit-' + id)?.value;
  if (!val2) return;
  const body = {};
  body[cfg.label] = val2;
  await PUT(`${cfg.api}/${id}`, body);
  await loadLookupCache();
  await populateAllDropdowns();
  loadLookupTab(currentLookupType);
}

async function deleteLookupItem(id) {
  if (!confirm('Delete this item?')) return;
  const cfg = lookupConfig[currentLookupType];
  await DEL(`${cfg.api}/${id}`);
  await loadLookupCache();
  await populateAllDropdowns();
  loadLookupTab(currentLookupType);
}

// ---- Company branding ----
let _companyLogoData = ''; // holds current base64 data URL

async function loadCompanySettings() {
  const d = await GET('/api/settings/company');
  if (!d) return;
  document.getElementById('company-name-input').value = d.name || '';
  _companyLogoData = d.logo || '';
  cache.company = { name: d.name || '', logo: d.logo || '' };
  _renderCompanyLogoPreview();
}

function _renderCompanyLogoPreview() {
  const img  = document.getElementById('company-logo-preview');
  const ph   = document.getElementById('company-logo-placeholder');
  const acts = document.getElementById('company-logo-actions');
  if (_companyLogoData) {
    img.src = _companyLogoData; img.style.display = '';
    ph.style.display = 'none';
    acts.classList.remove('hidden');
  } else {
    img.src = ''; img.style.display = 'none';
    ph.style.display = '';
    acts.classList.add('hidden');
  }
}

// Compress a data URL (or File) through canvas — max 400×200, PNG for transparency, JPEG otherwise
// Works on both newly-uploaded File objects and existing data URLs loaded from the DB
function _compressDataUrl(dataUrl, cb) {
  if (!dataUrl) { cb(''); return; }
  const img = new Image();
  img.onload = () => {
    const MAX_W = 400, MAX_H = 200;
    let w = img.naturalWidth, h = img.naturalHeight;
    if (w > MAX_W || h > MAX_H) {
      const scale = Math.min(MAX_W / w, MAX_H / h);
      w = Math.round(w * scale); h = Math.round(h * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    // Detect PNG/WebP (may have transparency) vs JPEG
    const isPng = dataUrl.startsWith('data:image/png') || dataUrl.startsWith('data:image/gif') || dataUrl.startsWith('data:image/webp');
    cb(canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.88));
  };
  img.onerror = () => cb(dataUrl); // pass through on failure
  img.src = dataUrl;
}

function _compressLogo(file, cb) {
  const reader = new FileReader();
  reader.onload = ev => _compressDataUrl(ev.target.result, cb);
  reader.readAsDataURL(file);
}

function companyLogoChosen(input) {
  const file = input.files[0]; input.value = '';
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return toast('Logo must be under 8 MB.', 'error');
  _compressLogo(file, data => { _companyLogoData = data; _renderCompanyLogoPreview(); });
}

function companyLogoDrop(ev) {
  ev.preventDefault();
  const file = (ev.dataTransfer.files || [])[0];
  if (!file || !file.type.startsWith('image/')) return toast('Please drop an image file.', 'error');
  if (file.size > 8 * 1024 * 1024) return toast('Logo must be under 8 MB.', 'error');
  _compressLogo(file, data => { _companyLogoData = data; _renderCompanyLogoPreview(); });
}

function clearCompanyLogo() {
  _companyLogoData = '';
  _renderCompanyLogoPreview();
}

async function saveCompanySettings() {
  const name = (document.getElementById('company-name-input').value || '').trim();
  // Always compress through canvas before sending — handles DB-loaded full-res logos
  _compressDataUrl(_companyLogoData, async compressed => {
    _companyLogoData = compressed;
    const r = await PUT('/api/settings/company', { name, logo: compressed });
    if (!ok(r)) return;
    cache.company = { name, logo: compressed };
    toast('Company details saved.');
  });
}

// ---- Users ----
async function loadUsers() {
  const data = await GET('/api/users');
  if (!data) return;
  document.getElementById('users-tbody').innerHTML = data.length ? data.map(u => `
    <tr>
      <td><strong>${u.UserName}</strong></td>
      <td>${u.LastName?u.LastName+', '+u.FirstName:u.USER||''}</td>
      <td>${u.Admin?'<span class="badge badge-active">Admin</span>':u.ExamOnly?'Exam Only':u.Restricted?'Restricted':'Standard'}</td>
      <td>${u.Department||''}</td>
      <td><span class="badge ${u.UserStatus==='Active'?'badge-active':'badge-inactive'}">${u.UserStatus||''}</span></td>
      <td class="actions">
        <button class="btn btn-primary btn-sm btn-icon" onclick="editUser(${u.PSWDID})" title="Edit">✏️</button>
        <button class="btn btn-danger btn-sm btn-icon" onclick="deleteUser(${u.PSWDID},'${esc(u.UserName)}')" title="Delete">🗑️</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No users found</td></tr>`;
}

// ---- Page-access checkbox grid in the user modal ----
function renderPageAccessGrid(selected) {
  const sel = new Set(selected || []);
  document.getElementById('u-pageaccess').innerHTML = APP_PAGES.map(group => `
    <div class="pa-group">
      <label class="pa-group-head"><input type="checkbox" class="pa-section" onchange="togglePaSection(this,'${group.section}')"> ${group.section}</label>
      ${group.pages.map(([key,label]) => `
        <label class="pa-item"><input type="checkbox" class="pa-page" data-section="${group.section}" value="${key}" ${sel.has(key)?'checked':''} onchange="syncPaSection('${group.section}')"> ${label}</label>`).join('')}
    </div>`).join('');
  APP_PAGES.forEach(g => syncPaSection(g.section));
}
function togglePaSection(box, section) {
  document.querySelectorAll(`.pa-page[data-section="${section}"]`).forEach(cb => cb.checked = box.checked);
}
function syncPaSection(section) {
  const items = [...document.querySelectorAll(`.pa-page[data-section="${section}"]`)];
  const head = document.querySelector(`.pa-section[onchange*="'${section}'"]`);
  if (!head || !items.length) return;
  const checked = items.filter(i => i.checked).length;
  head.checked = checked === items.length;
  head.indeterminate = checked > 0 && checked < items.length;
}
function setAllPageAccess(on) {
  document.querySelectorAll('#u-pageaccess .pa-page').forEach(cb => cb.checked = on);
  APP_PAGES.forEach(g => syncPaSection(g.section));
}
function collectPageAccess() {
  return [...document.querySelectorAll('#u-pageaccess .pa-page:checked')].map(cb => cb.value).join(',');
}
function onAdminToggle() {
  const isAdmin = document.getElementById('u-Admin').checked;
  document.getElementById('u-Admin-note').classList.toggle('hidden', !isAdmin);
  document.getElementById('u-pageaccess').style.display = isAdmin ? 'none' : '';
}

function openUserModal() {
  editingId.user = null;
  clearForm(['u-UserName','u-Password','u-USER','u-staffID','u-UserStatus','u-DeptID','u-LocID','u-Admin','u-Standard','u-Restricted','u-ExamOnly','u-ReadPrint']);
  setVal('u-UserStatus', 'Active');
  document.getElementById('user-modal-title').textContent = 'Add User Account';
  renderPageAccessGrid(['dashboard','my-training']);
  onAdminToggle();
  showModal('user-modal');
}

async function editUser(id) {
  const data = await GET('/api/users');
  const u = data && data.find(x => x.PSWDID == id);
  if (!u) return;
  editingId.user = id;
  document.getElementById('user-modal-title').textContent = 'Edit User: ' + u.UserName;
  setVal('u-UserName', u.UserName); setVal('u-USER', u.USER);
  setVal('u-staffID', u.staffID); setVal('u-UserStatus', u.UserStatus);
  setVal('u-DeptID', u.DeptID); setVal('u-LocID', u.LocID);
  document.getElementById('u-Admin').checked = !!u.Admin;
  document.getElementById('u-Standard').checked = !!u.Standard;
  document.getElementById('u-Restricted').checked = !!u.Restricted;
  document.getElementById('u-ExamOnly').checked = !!u.ExamOnly;
  document.getElementById('u-ReadPrint').checked = !!u.ReadPrint;
  const pages = (u.PageAccess || '').split(',').map(s => s.trim()).filter(Boolean);
  renderPageAccessGrid(pages.length ? pages : ['dashboard','my-training']);
  onAdminToggle();
  showModal('user-modal');
}

async function saveUser() {
  const d = {
    UserName: val('u-UserName'), Password: val('u-Password'), USER: val('u-USER'),
    staffID: val('u-staffID'), UserStatus: val('u-UserStatus'),
    DeptID: val('u-DeptID'), LocID: val('u-LocID'),
    Admin: document.getElementById('u-Admin').checked,
    Standard: document.getElementById('u-Standard').checked,
    Restricted: document.getElementById('u-Restricted').checked,
    ExamOnly: document.getElementById('u-ExamOnly').checked,
    ReadPrint: document.getElementById('u-ReadPrint').checked,
    PageAccess: document.getElementById('u-Admin').checked ? '' : collectPageAccess()
  };
  if (!d.UserName) return toast('Username is required.', 'error');
  if (!editingId.user && !d.Password) return toast('Password is required for new users.', 'error');
  const editing = editingId.user;
  const r = editing ? await PUT('/api/users/' + editing, d) : await POST('/api/users', d);
  if (!ok(r)) return;
  closeModal('user-modal');
  toast(editing ? 'User updated.' : 'User account created.');
  loadUsers();
}

async function deleteUser(id, name) {
  if (!confirm(`Delete user "${name}"?`)) return;
  await DEL('/api/users/' + id);
  loadUsers();
}

// ---- Workflow Assignment ----
let wfEvents = [];
function wfEventLabel(key) { const e = wfEvents.find(x => x.key === key); return e ? e.label : key; }
async function loadWorkflows() {
  if (!wfEvents.length) wfEvents = await GET('/api/workflows/events') || [];
  const data = await GET('/api/workflows');
  if (!data) return;
  document.getElementById('workflows-tbody').innerHTML = data.length ? data.map(w => {
    const targets = [];
    if (w.Recipients) targets.push(esc(w.Recipients));
    if (w.NotifySupervisor) targets.push('👔 Supervisor');
    if (w.NotifyEmployee) targets.push('👤 Employee');
    return `<tr>
      <td class="cell-strong">${esc(w.Name)}</td>
      <td><span class="badge badge-pending badge-plain">${esc(wfEventLabel(w.TriggerEvent))}</span></td>
      <td class="cell-sub">${targets.join(', ')||'<em>none set</em>'}</td>
      <td>${w.Active?'<span class="badge badge-active">Active</span>':'<span class="badge badge-inactive">Disabled</span>'}</td>
      <td class="actions">
        <button class="btn btn-outline btn-sm btn-icon" onclick="testWorkflow(${w.WorkflowID})" title="Send test email">✉️</button>
        <button class="btn btn-primary btn-sm btn-icon" onclick="editWorkflow(${w.WorkflowID})" title="Edit">✏️</button>
        <button class="btn btn-danger btn-sm btn-icon" onclick="deleteWorkflow(${w.WorkflowID},'${esc(w.Name)}')" title="Delete">🗑️</button>
      </td></tr>`;
  }).join('') : `<tr><td colspan="5" class="empty-state">No workflows yet — click “+ New Workflow” to route an event to email.</td></tr>`;
}

function fillWorkflowEvents(selected) {
  const sel = document.getElementById('wf-TriggerEvent');
  sel.innerHTML = '<option value="">-- Select an event --</option>' +
    wfEvents.map(e => `<option value="${e.key}" ${selected===e.key?'selected':''}>${esc(e.label)}</option>`).join('');
  onWorkflowEventChange();
}
function onWorkflowEventChange() {
  const key = val('wf-TriggerEvent');
  const e = wfEvents.find(x => x.key === key);
  document.getElementById('wf-event-desc').textContent = e ? e.desc : '';
}

async function openWorkflowModal() {
  editingId.workflow = null;
  if (!wfEvents.length) wfEvents = await GET('/api/workflows/events') || [];
  clearForm(['wf-Name','wf-Recipients','wf-CcRecipients','wf-SubjectTemplate','wf-Note']);
  document.getElementById('wf-NotifySupervisor').checked = false;
  document.getElementById('wf-NotifyEmployee').checked = false;
  setVal('wf-Active', '1');
  fillWorkflowEvents('');
  document.getElementById('workflow-modal-title').textContent = 'New Workflow';
  showModal('workflow-modal');
}

async function editWorkflow(id) {
  if (!wfEvents.length) wfEvents = await GET('/api/workflows/events') || [];
  const data = await GET('/api/workflows');
  const w = data && data.find(x => x.WorkflowID == id);
  if (!w) return;
  editingId.workflow = id;
  setVal('wf-Name', w.Name); setVal('wf-Recipients', w.Recipients); setVal('wf-CcRecipients', w.CcRecipients);
  setVal('wf-SubjectTemplate', w.SubjectTemplate); setVal('wf-Note', w.Note);
  document.getElementById('wf-NotifySupervisor').checked = !!w.NotifySupervisor;
  document.getElementById('wf-NotifyEmployee').checked = !!w.NotifyEmployee;
  setVal('wf-Active', w.Active ? '1' : '0');
  fillWorkflowEvents(w.TriggerEvent);
  document.getElementById('workflow-modal-title').textContent = 'Edit: ' + w.Name;
  showModal('workflow-modal');
}

async function saveWorkflow() {
  const d = {
    Name: val('wf-Name'), TriggerEvent: val('wf-TriggerEvent'),
    Recipients: val('wf-Recipients'), CcRecipients: val('wf-CcRecipients'),
    NotifySupervisor: document.getElementById('wf-NotifySupervisor').checked,
    NotifyEmployee: document.getElementById('wf-NotifyEmployee').checked,
    SubjectTemplate: val('wf-SubjectTemplate'), Note: val('wf-Note'),
    Active: val('wf-Active') === '1'
  };
  if (!d.Name) return toast('Workflow name is required.', 'error');
  if (!d.TriggerEvent) return toast('Please choose a trigger event.', 'error');
  if (!d.Recipients && !d.NotifySupervisor && !d.NotifyEmployee)
    return toast('Add at least one recipient (email address, supervisor, or employee).', 'error');
  const editing = editingId.workflow;
  const r = editing ? await PUT('/api/workflows/' + editing, d) : await POST('/api/workflows', d);
  if (!ok(r)) return;
  closeModal('workflow-modal');
  toast(editing ? 'Workflow updated.' : 'Workflow created.');
  loadWorkflows();
}

async function deleteWorkflow(id, name) {
  if (!confirm(`Delete workflow "${name}"?`)) return;
  await DEL('/api/workflows/' + id);
  toast('Workflow deleted.');
  loadWorkflows();
}

async function testWorkflow(id) {
  const email = prompt('Send a test notification to which email address?');
  if (!email) return;
  const r = await POST(`/api/workflows/${id}/test`, { testEmail: email });
  if (!ok(r)) return;
  toast('Test email sent to ' + r.sentTo + '.');
}

// ---- AI Content Studio ----
let _csKbArticles = []; // all published KB articles, loaded once per page visit

async function loadContentStudio() {
  const [types, sources, history, kbArticles, tmCats, learnOpts, mappable] = await Promise.all([
    GET('/api/content/types'), GET('/api/content/sources'),
    GET('/api/content/history'), GET('/api/content/kb-context'),
    GET('/api/content/trainmat-cats'), GET('/api/content/learning-options'),
    GET('/api/content/mappable-types')
  ]);
  _csMappableTypes = Array.isArray(mappable) ? mappable : [];
  _csTrainMatCats = tmCats || [];
  if (types) document.getElementById('cs-type').innerHTML = types.map(t => `<option value="${t.key}">${esc(t.label)} → ${esc(t.into)}</option>`).join('');
  csTypeChange(); // set button label / hint for the initially-selected type (also toggles map button)
  csPopulateAudience(learnOpts);
  if (sources) {
    const opts = sources.map(s => `<option value="${s.FileID}">${esc(s.FileName)}</option>`).join('');
    document.getElementById('cs-source').innerHTML = '<option value="">— None (prompt only) —</option>' + opts;
    const c2 = document.getElementById('cs-content-source');
    if (c2) c2.innerHTML = '<option value="">— None —</option>' + opts;
  }
  // If a draft was loaded before navigating here (e.g. from tsEditDoc), render it instead of clearing
  if (csDraft) {
    // Reflect the audience dials the document was generated with (if any).
    const m = (csDraft.data && csDraft.data.meta) || {};
    const lp = document.getElementById('cs-learning-profile'); if (lp && m.learningProfile) lp.value = m.learningProfile;
    const td = document.getElementById('cs-tech-depth'); if (td && m.techDepth) td.value = m.techDepth;
    document.getElementById('cs-result').innerHTML = renderContentPreview(csDraft.type, csDraft.data);
    csLoadGovernance();
    csHydrateImages();      // re-link images saved with the document so they show on edit
    csHydrateFlows();       // …and any flow charts saved with it
    csApplyTransLayout();
  } else {
    document.getElementById('cs-result').innerHTML = '';
  }
  document.getElementById('cs-regen').style.display = 'none';
  renderCSHistory(history || []);

  _csKbArticles = kbArticles || [];
  const panel = document.getElementById('cs-kb-panel');
  if (_csKbArticles.length) {
    panel.style.display = '';
    csKbRender(_csKbArticles);
  } else {
    panel.style.display = 'none';
  }
}

// Populate the Learning Profile × Technical Depth selectors from the server.
// Render the protected-value warning banner at the top of the preview (only when critical values
// from the source are missing/changed in the current draft). Advisory — never blocks saving.
function csShowValueCheck() {
  const host = document.getElementById('cs-result');
  if (!host) return;
  const old = document.getElementById('cs-valuecheck'); if (old) old.remove();
  const vc = _csValueCheck;
  if (!vc || vc.ok || !vc.critical || !vc.critical.length) return;
  const chips = vc.critical.slice(0, 30).map(x => `<span class="cs-vc-chip">${esc(x.value)}</span>`).join('');
  const more = vc.critical.length > 30 ? ` +${vc.critical.length - 30} more` : '';
  const div = document.createElement('div');
  div.id = 'cs-valuecheck';
  div.className = 'cs-valuecheck';
  div.innerHTML = `<div class="cs-vc-head">⚠ Protected-value check — <strong>${vc.critical.length}</strong> source value(s) may be missing or changed. Review before approving.
      <span class="cs-vc-actions">
        <button class="btn btn-outline btn-sm" onclick="csRecheckValues()">🔢 Re-check current draft</button>
        <button class="btn btn-ghost btn-sm" onclick="(document.getElementById('cs-valuecheck')||{}).hidden=true">Dismiss</button>
      </span></div>
    <div class="cs-vc-body">These numbers/units/limits/model codes appear in the source but not in the generated text (or differ). Language may change — values must not: ${chips}${more}</div>`;
  host.insertBefore(div, host.firstChild);
}
// Re-run the value check against the CURRENT edited draft (uses the remembered source).
async function csRecheckValues() {
  if (!csDraft) return;
  const data = collectContentEdits(csDraft.type);
  const r = await POST('/api/content/validate-values', { data, sourceFileId: _csValueSourceId || undefined });
  if (r && r.valueCheck) {
    _csValueCheck = r.valueCheck;
    csShowValueCheck();
    toast(r.valueCheck.ok ? '✅ Value check passed — all source values present.' : `⚠ ${r.valueCheck.critical.length} value(s) still flagged.`, r.valueCheck.ok ? 'success' : 'error');
  } else {
    toast((r && r.error) || 'Value check unavailable.', 'error');
  }
}

// ── §21 — side-by-side change review (original vs generated) with accept/revert ──────────────
function _cmpTokenize(s) { return String(s || '').split(/(\s+)/).filter(x => x.length); }
// Word-level diff → HTML: <del> removed from original, <ins> added in the new version.
function _wordDiffHtml(a, b) {
  const A = _cmpTokenize(a), B = _cmpTokenize(b), n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0; const out = [];
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push(esc(B[j])); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('<del>' + esc(A[i]) + '</del>'); i++; }
    else { out.push('<ins>' + esc(B[j]) + '</ins>'); j++; }
  }
  while (i < n) { out.push('<del>' + esc(A[i]) + '</del>'); i++; }
  while (j < m) { out.push('<ins>' + esc(B[j]) + '</ins>'); j++; }
  return out.join('');
}
let _csCompare = null;
async function csOpenCompare() {
  if (!csDraft) return;
  const body = document.getElementById('cs-compare-body');
  if (body) body.innerHTML = '<p class="text-soft">Loading…</p>';
  showModal('cs-compare-modal');
  const g = csDraft._gov || {};
  const current = collectContentEdits(csDraft.type);
  if (g.MasterFileID) {
    const m = await GET('/api/content/doc-data/' + g.MasterFileID);
    if (!m || m.error || !m.data) { body.innerHTML = `<p class="cs-ver-empty">Could not load the original (master) document.</p>`; return; }
    _csCompare = { mode: 'sections', master: m.data, current };
    csRenderCompareSections();
  } else if (_csValueSourceId) {
    const r = await POST('/api/content/source-text', { sourceFileId: _csValueSourceId });
    if (!r || r.error) { body.innerHTML = `<p class="cs-ver-empty">${esc((r && r.error) || 'Could not read the source.')}</p>`; return; }
    const cur = (current.sections || []).map(s => [s.heading, s.body].filter(Boolean).join('\n')).join('\n\n');
    body.innerHTML = `<p class="text-soft" style="font-size:13px;margin-top:0"><del>struck-through</del> = in the source but not the new document · <ins>underlined</ins> = added/changed in the new document.</p>
      <div class="cs-cmp-diff cs-cmp-whole">${_wordDiffHtml(r.text, cur)}</div>`;
  } else {
    body.innerHTML = `<p class="cs-ver-empty">No original to compare against.</p>`;
  }
}
function csRenderCompareSections() {
  const { master, current } = _csCompare;
  const ms = master.sections || [], cs = current.sections || [];
  const n = Math.max(ms.length, cs.length);
  let changedCount = 0, rows = '';
  for (let i = 0; i < n; i++) {
    const mo = ms[i] || {}, co = cs[i] || {};
    const heading = esc(co.heading || mo.heading || ('Section ' + (i + 1)));
    const changed = (mo.body || '') !== (co.body || '');
    if (changed) changedCount++;
    rows += `<div class="cs-cmp-sec">
      <div class="cs-cmp-head">${heading} ${changed ? '<span class="cs-cmp-badge">reworded</span>' : '<span class="cs-cmp-same">unchanged</span>'}</div>
      ${changed ? `<div class="cs-cmp-diff">${_wordDiffHtml(mo.body || '', co.body || '')}</div>
        <div class="cs-cmp-actions">
          <button class="btn btn-outline btn-sm" onclick="csCmpRevert(${i})" title="Reject this rewrite — restore the original wording for this section">↩ Revert to original</button>
          <span class="text-soft" style="font-size:11px">(leaving it keeps the rewrite)</span>
        </div>` : ''}
    </div>`;
  }
  document.getElementById('cs-compare-body').innerHTML = `
    <p class="text-soft" style="font-size:13px;margin-top:0"><del>struck-through</del> = removed from the original · <ins>underlined</ins> = added in this version. <strong>${changedCount}</strong> section(s) reworded. Revert a section to reject its rewrite; leaving it accepts the change.</p>
    ${rows}`;
}
function csCmpRevert(i) {
  const mo = ((_csCompare.master.sections || [])[i]) || {};
  const secEls = document.querySelectorAll('#cs-result .cs-sec');
  const sec = secEls[i];
  if (sec) { const ta = sec.querySelector('.cs-sec-b'); if (ta) ta.value = mo.body || ''; }
  if (_csCompare.current.sections[i]) _csCompare.current.sections[i].body = mo.body || '';
  toast('Section reverted to the original wording.');
  csRenderCompareSections();
}

function csPopulateAudience(opts) {
  if (!opts) return;
  _csLearnOpts = opts; // cache for the derive dialog
  const lp = document.getElementById('cs-learning-profile');
  const td = document.getElementById('cs-tech-depth');
  if (lp && Array.isArray(opts.learningProfiles)) {
    lp.innerHTML = '<option value="">— Document default —</option>' +
      opts.learningProfiles.map(o => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('');
  }
  if (td && Array.isArray(opts.techDepths)) {
    td.innerHTML = '<option value="">— Document default —</option>' +
      opts.techDepths.map(o => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('');
  }
}

function csKbRender(articles) {
  // Group by category
  const groups = {};
  for (const a of articles) {
    const cat = a.categoryName || 'General';
    if (!groups[cat]) groups[cat] = { icon: a.catIcon || '📄', color: a.catColor || '#4f46e5', items: [] };
    groups[cat].items.push(a);
  }
  let html = '';
  for (const [cat, g] of Object.entries(groups)) {
    html += `<div class="cs-kb-cat">
      <div class="cs-kb-cat-hdr" style="color:${g.color}">${g.icon} ${esc(cat)}</div>`;
    for (const a of g.items) {
      const tags = a.Tags ? `<span class="cs-kb-tags">${esc(a.Tags)}</span>` : '';
      const upd  = a.UpdatedAt ? `<span class="cs-kb-upd" title="Latest version used at generation">updated ${esc(String(a.UpdatedAt).replace('T',' ').slice(0,16))}</span>` : '';
      html += `<label class="cs-kb-item" data-title="${esc(a.Title.toLowerCase())}">
        <input type="checkbox" class="cs-kb-cb" value="${a.ArticleID}">
        <span class="cs-kb-title">${esc(a.Title)}</span>${tags}${upd}
      </label>`;
    }
    html += `</div>`;
  }
  document.getElementById('cs-kb-list').innerHTML = html || '<span class="cell-sub">No published articles.</span>';
}

async function csKbRefresh() {
  // Re-pull the latest published KB articles on demand, preserving the current selection
  const checked = new Set([...document.querySelectorAll('#cs-kb-list .cs-kb-cb:checked')].map(c => c.value));
  const arts = await GET('/api/content/kb-context');
  _csKbArticles = arts || [];
  const panel = document.getElementById('cs-kb-panel');
  if (_csKbArticles.length) {
    panel.style.display = '';
    csKbRender(_csKbArticles);
    document.querySelectorAll('#cs-kb-list .cs-kb-cb').forEach(c => { if (checked.has(c.value)) c.checked = true; });
    toast(`Knowledge Base refreshed — ${_csKbArticles.length} published article(s).`);
  } else { panel.style.display = 'none'; }
}

function csKbFilter(q) {
  const term = q.toLowerCase().trim();
  document.querySelectorAll('#cs-kb-list .cs-kb-item').forEach(el => {
    const title = el.dataset.title || '';
    el.style.display = (!term || title.includes(term)) ? '' : 'none';
  });
  // Show/hide category headers that have no visible items
  document.querySelectorAll('#cs-kb-list .cs-kb-cat').forEach(cat => {
    const anyVisible = [...cat.querySelectorAll('.cs-kb-item')].some(i => i.style.display !== 'none');
    cat.style.display = anyVisible ? '' : 'none';
  });
}

function csKbToggleAll(cb) {
  document.querySelectorAll('#cs-kb-list .cs-kb-cb').forEach(c => { c.checked = cb.checked; });
}

function renderCSHistory(rows) {
  const host = document.getElementById('cs-history');
  if (!host) return;
  if (!rows.length) { host.innerHTML = '<p class="cell-sub">No content generated yet.</p>'; return; }
  const TYPE_LABELS = { exam: 'Exam', form: 'Form', 'record-form': 'Record Form', 'excel-form': 'Excel Form', course: 'Course', sop: 'SOP', 'training-plan': 'Training Plan', induction: 'Induction Pack', 'training-manual': 'Training Manual', 'training-handout': 'Training Handout', 'training-deck': 'Training Deck', swp: 'SWP', jsa: 'JSA', 'safety-alert': 'Safety Alert', 'toolbox-talk': 'Toolbox Talk', 'training-request': 'Training Request', 'transfer-to-training': 'Transfer to Training', 'return-to-ops': 'Return to Operations', 'training-standards': 'Training Standards', policy: 'Policy', standard: 'Standard', plan: 'Plan', 'management-plan': 'Management Plan', 'strategy-plan': 'Strategy Plan', checklist: 'Checklist' };
  const TYPE_ICONS  = { exam: '📝', form: '🧰', 'record-form': '📋', 'excel-form': '📊', course: '🎓', sop: '📋', 'training-plan': '📅', induction: '🏁', 'training-manual': '📘', 'training-handout': '📄', 'training-deck': '🎞️', swp: '⚠️', jsa: '🔍', 'safety-alert': '🚨', 'toolbox-talk': '🧰', 'training-request': '📩', 'transfer-to-training': '🚌', 'return-to-ops': '✅', 'training-standards': '📐', policy: '📜', standard: '🔧', plan: '🗓️', 'management-plan': '📋', 'strategy-plan': '🎯', checklist: '☑️' };
  host.innerHTML = `<div class="table-responsive"><table>
    <thead><tr><th>Date</th><th>Type</th><th>Name</th><th>By</th></tr></thead>
    <tbody>${rows.map(r => {
      const icon  = TYPE_ICONS[r.contentType] || '📄';
      const label = TYPE_LABELS[r.contentType] || r.contentType;
      return `<tr><td class="cell-sub">${esc((r.AuditDate||'').replace('T',' ').slice(0,16))}</td>
        <td><span class="badge badge-info">${icon} ${esc(label)}</span></td>
        <td>${esc(r.itemName||'—')}</td>
        <td>${esc(r.AuditUser||'—')}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

let csDraft = null; // { type, data } awaiting save
let _csLastEditSource = null; // which library opened the current edit (for version-restore reload)
let _csLearnOpts = {}; // { learningProfiles:[], techDepths:[] } for derive dialog
let _csValueCheck = null;    // last protected-value comparison result
let _csValueSourceId = null; // source FileID used for the value check (for re-check)
let _csMappableTypes = [];   // doc types that support semantic mapping
let _csMapResult = null;     // last mapping-preview result
let _csPendingMapping = null;// user-confirmed mapping to apply on the next generate
let _csUploadedFileId = null; // fileId of a document uploaded via the Upload tab

// ── Source document tab switching ────────────────────────────────────────────
function csSrcTab(tab, btn) {
  document.querySelectorAll('.cs-src-tab').forEach(b => b.classList.toggle('active', b === btn));
  document.getElementById('cs-src-library').style.display = tab === 'library' ? '' : 'none';
  document.getElementById('cs-src-upload-panel').style.display = tab === 'upload' ? '' : 'none';
  if (tab === 'library') _csUploadedFileId = null;
  if (typeof csResetForms === 'function') csResetForms(); // source changed → drop stale form list
}

function csSrcFileChosen(input) {
  const file = input.files[0];
  input.value = '';
  if (file) _csSrcUpload(file);
}

function csSrcDrop(e) {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) _csSrcUpload(file);
}

async function _csSrcUpload(file) {
  const status   = document.getElementById('cs-src-upload-status');
  const dropzone = document.getElementById('cs-src-dropzone');
  const fileInfo = document.getElementById('cs-src-file-info');
  const modeRow  = document.getElementById('cs-src-mode-row');
  _csUploadedFileId = null;
  status.textContent = '⏳ Uploading…';
  dropzone.style.display = 'none';
  fileInfo.style.display = 'none';
  modeRow.style.display  = 'none';
  if (typeof csResetForms === 'function') csResetForms(); // new source → drop stale form list
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res  = await fetch('/api/content/upload-source', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) { status.textContent = '❌ ' + (data.error || 'Upload failed'); dropzone.style.display = ''; return; }
    _csUploadedFileId = data.fileId;
    status.textContent = '';
    fileInfo.innerHTML = `<span class="badge badge-success" style="font-size:12px">✓ ${esc(data.name)}</span>
      <button class="btn btn-ghost btn-sm" style="margin-left:8px" onclick="csSrcClear()">✕ Remove</button>`;
    fileInfo.style.display = '';
    modeRow.style.display  = '';
  } catch { status.textContent = '❌ Upload failed'; dropzone.style.display = ''; }
}

function csSrcClear() {
  _csUploadedFileId = null;
  document.getElementById('cs-src-file-info').style.display  = 'none';
  document.getElementById('cs-src-mode-row').style.display   = 'none';
  document.getElementById('cs-src-upload-status').textContent = '';
  document.getElementById('cs-src-dropzone').style.display   = '';
  if (typeof csResetForms === 'function') csResetForms();
}

// ── Document 2 (updated-content source) — same picker, no reference/transform mode ──
// Its role is fixed: the AI keeps Document 1's layout and updates it with this document.
let _csContentFileId = null; // fileId of a document uploaded to the Document 2 slot
function csContentSrcTab(tab, btn) {
  btn.parentElement.querySelectorAll('.cs-content-tab').forEach(b => b.classList.toggle('active', b === btn));
  document.getElementById('cs-content-library').style.display = tab === 'library' ? '' : 'none';
  document.getElementById('cs-content-upload-panel').style.display = tab === 'upload' ? '' : 'none';
  if (tab === 'library') _csContentFileId = null;
}
function csContentFileChosen(input) { const f = input.files[0]; input.value = ''; if (f) _csContentUpload(f); }
function csContentDrop(e) { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) _csContentUpload(f); }
async function _csContentUpload(file) {
  const status = document.getElementById('cs-content-upload-status');
  const dropzone = document.getElementById('cs-content-dropzone');
  const fileInfo = document.getElementById('cs-content-file-info');
  _csContentFileId = null;
  status.textContent = '⏳ Uploading…';
  dropzone.style.display = 'none'; fileInfo.style.display = 'none';
  try {
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch('/api/content/upload-source', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) { status.textContent = '❌ ' + (data.error || 'Upload failed'); dropzone.style.display = ''; return; }
    _csContentFileId = data.fileId;
    status.textContent = '';
    fileInfo.innerHTML = `<span class="badge badge-success" style="font-size:12px">✓ ${esc(data.name)}</span>
      <button class="btn btn-ghost btn-sm" style="margin-left:8px" onclick="csContentClear()">✕ Remove</button>`;
    fileInfo.style.display = '';
  } catch { status.textContent = '❌ Upload failed'; dropzone.style.display = ''; }
}
function csContentClear() {
  _csContentFileId = null;
  document.getElementById('cs-content-file-info').style.display = 'none';
  document.getElementById('cs-content-upload-status').textContent = '';
  document.getElementById('cs-content-dropzone').style.display = '';
}

// ── Additional reference documents (multiple) — the AI reads them ALL to build the document ──
let _csRefDocs = []; // [{ fileId, name }]
function csRefDocsChosen(input){ const files = [...input.files]; input.value = ''; if (files.length) _csRefDocsUpload(files); }
function csRefDocsDrop(e){ e.preventDefault(); const files = [...((e.dataTransfer && e.dataTransfer.files) || [])]; if (files.length) _csRefDocsUpload(files); }
async function _csRefDocsUpload(files){
  const status = document.getElementById('cs-refdocs-status');
  for (const file of files) {
    if (_csRefDocs.length >= 10) { if (status) status.textContent = '⚠ Up to 10 reference documents.'; break; }
    if (status) status.textContent = '⏳ Uploading ' + file.name + '…';
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await fetch('/api/content/upload-source', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) { if (status) status.textContent = '❌ ' + (data.error || ('Upload failed for ' + file.name)); continue; }
      _csRefDocs.push({ fileId: data.fileId, name: data.name || file.name });
    } catch { if (status) status.textContent = '❌ Upload failed for ' + file.name; }
  }
  if (status) status.textContent = _csRefDocs.length ? (_csRefDocs.length + ' reference document(s) added.') : '';
  csRefDocsRender();
}
function csRefDocsRender(){
  const list = document.getElementById('cs-refdocs-list'); if (!list) return;
  list.innerHTML = _csRefDocs.map(d => `<span class="badge badge-success" style="font-size:12px;display:inline-flex;align-items:center;gap:6px">📄 ${esc(d.name)} <button type="button" class="btn btn-ghost btn-sm" style="padding:0 5px" onclick="csRefDocRemove(${d.fileId})" title="Remove">✕</button></span>`).join('');
}
function csRefDocRemove(fileId){
  _csRefDocs = _csRefDocs.filter(d => d.fileId !== fileId);
  csRefDocsRender();
  const s = document.getElementById('cs-refdocs-status'); if (s) s.textContent = _csRefDocs.length ? (_csRefDocs.length + ' reference document(s) added.') : '';
}

// A "generated document" build type: one the AI writes as section content (so per-section image
// suggestions, image style, document control etc. apply). Excludes the form/exam/spreadsheet builders
// and the exact-copy form, which don't generate section content.
function csIsGeneratedDoc(t) {
  return !['exam', 'form', 'training-request', 'record-form', 'excel-form', 'form-doc'].includes(t);
}

let _csPromptPh = null; // original prompt placeholder, restored when leaving the Form (exact copy) type
// React to the "What do you want to build?" selection: the Form (exact copy) option copies an uploaded
// document instead of AI-generating, so surface a hint, relabel the button, and mark the prompt optional.
function csTypeChange() {
  const isFormCopy = val('cs-type') === 'form-doc';
  const hint = document.getElementById('cs-formdoc-hint');
  if (hint) hint.style.display = isFormCopy ? '' : 'none';
  const go = document.getElementById('cs-go');
  if (go) go.textContent = isFormCopy ? '📄 Copy document layout' : '🤖 Generate';
  const promptEl = document.getElementById('cs-prompt');
  if (promptEl) {
    if (_csPromptPh == null) _csPromptPh = promptEl.placeholder;
    promptEl.placeholder = isFormCopy
      ? 'Optional — the uploaded document is copied as-is. Leave blank, or add a note for your own reference.'
      : _csPromptPh;
  }
  csUpdateMapBtn();
  const t = val('cs-type');
  const rp = document.getElementById('cs-recordopts-panel');
  if (rp) rp.style.display = (t === 'record-form') ? '' : 'none';
  // Document / version control is available for every build type except exams, Excel spreadsheets,
  // and the exact-copy form (which must not be altered).
  const dcp = document.getElementById('cs-doccontrol-panel');
  if (dcp) dcp.style.display = ['exam', 'excel-form', 'form-doc'].includes(t) ? 'none' : '';
  // Per-section image suggestions + image style: available for ALL generated document types (not the
  // form/exam/spreadsheet builders or the exact-copy form, which don't generate section content).
  const tmp = document.getElementById('cs-tmopts-panel');
  const genDoc = csIsGeneratedDoc(t);
  if (tmp) tmp.style.display = genDoc ? '' : 'none';
  // Multiple reference documents — available for generated doc types (not the exact-copy form / exam /
  // Excel spreadsheet, which build from a single source or none).
  const refp = document.getElementById('cs-refdocs-panel');
  if (refp) refp.style.display = genDoc ? '' : 'none';
  if (genDoc && typeof csToggleImgStyle === 'function') csToggleImgStyle();
  // Document-analysis chooser: record forms (detect FORMS), SOP/SWP (detect PROCEDURES), and the exact-copy
  // Form (detect FORMS so the user can pick which one to copy first).
  const dp = document.getElementById('cs-detect-panel');
  const canDetect = ['record-form', 'sop', 'swp', 'form-doc'].includes(t);
  if (dp) dp.style.display = canDetect ? '' : 'none';
  if (canDetect) {
    const isProc = (t === 'sop' || t === 'swp');
    const noun = isProc ? 'procedures' : 'forms';
    const lbl = document.getElementById('cs-detect-label');
    const btn = document.getElementById('cs-rf-detect-btn');
    const hint = document.getElementById('cs-detect-hint');
    if (lbl) lbl.textContent = isProc ? 'Analyse the uploaded document for procedures' : 'Analyse the uploaded document for forms';
    if (btn) btn.textContent = `🔍 Analyse document for ${noun}`;
    if (hint) hint.textContent = (t === 'form-doc')
      ? 'Upload a document above, then analyse it — if it holds several forms you can choose which one to copy first.'
      : `Upload a document above, then analyse it — if it holds several ${noun} you can pick which one to create.`;
  }
  if (!canDetect) csResetForms(); // drop any detected selection when the type can't use it
}

// Copy a suggested-image prompt (from its data-copy attribute) to the clipboard, to paste into ChatGPT / DALL·E.
function csCopyText(btn) {
  const txt = (btn && btn.dataset && btn.dataset.copy) ? btn.dataset.copy : '';
  if (!txt) return;
  const done = () => { const o = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = o; }, 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done).catch(() => { try { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); } catch {} });
  else { try { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); } catch {} }
}

// Show/hide the image-style dropdowns with the "Suggest an image" checkbox.
function csToggleImgStyle() {
  const on = !!(document.getElementById('cs-tm-imgsuggest') && document.getElementById('cs-tm-imgsuggest').checked);
  const row = document.getElementById('cs-imgstyle-row');
  if (row) row.style.display = on ? '' : 'none';
}

// Show/hide the document-control function checklist when "Add document control" is toggled.
function csToggleDocControl() {
  const on = !!(document.getElementById('cs-rf-doccontrol') && document.getElementById('cs-rf-doccontrol').checked);
  const box = document.getElementById('cs-rf-dc-opts');
  if (box) box.style.display = on ? '' : 'none';
}

// Export the current Excel form as a downloadable .xlsx file.
async function csExportExcel() {
  if (!csDraft) return;
  const data = collectContentEdits('excel-form');
  const r = await POST('/api/content/excel-form-xlsx', { data });
  if (!r || r.error || !r.b64) { toast((r && r.error) || 'Export failed.', 'error'); return; }
  finishDownload(r, b64ToBlob(r.b64, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'Excel file');
}

// Export the current record form as a downloadable HTML file (with the colour risk matrix if chosen).
async function csExportRecordHtml() {
  if (!csDraft) return;
  const data = collectContentEdits('record-form');
  data.includeRiskMatrix = !!(csDraft.data && csDraft.data.includeRiskMatrix);
  const r = await POST('/api/content/record-form-html', { data, riskMatrix: data.includeRiskMatrix });
  if (!r || r.error || !r.html) { toast((r && r.error) || 'Export failed.', 'error'); return; }
  finishDownload(r, new Blob([r.html], { type: 'text/html' }), 'HTML file');
}

// Read the edited WYSIWYG preview (the iframe) and return clean, downloadable fillable HTML — stripping the
// layout-editing chrome (toolbar, contenteditable, edit script, selection highlight) so the edits the user
// made on the page (typed text, inserted fields, deleted/moved rows) are kept in the download.
function csExtractEditedFormHtml() {
  const ifr = document.getElementById('cs-exact-doc');
  if (!ifr || !ifr.contentDocument || !ifr.contentDocument.documentElement) return null;
  let docEl;
  try { docEl = ifr.contentDocument.documentElement.cloneNode(true); } catch { return null; }
  docEl.querySelectorAll('.fd-ebar').forEach(e => e.remove());
  docEl.querySelectorAll('.fd-rsz').forEach(e => e.remove()); // column-resize handles
  docEl.querySelectorAll('[contenteditable]').forEach(e => e.removeAttribute('contenteditable'));
  docEl.querySelectorAll('.fd-active').forEach(e => e.classList.remove('fd-active'));
  docEl.querySelectorAll('.fd-cb-active').forEach(e => e.classList.remove('fd-cb-active'));
  docEl.querySelectorAll('script').forEach(s => { if (/fd-ebar|data-act|addfield|fd-rsz|addResizers/.test(s.textContent || '')) s.remove(); });
  const note = docEl.querySelector('.fd-note'); if (note) note.textContent = 'This form is fillable — type into the fields, tick the boxes, then Print or Save as PDF.';
  return '<!doctype html>\n' + docEl.outerHTML;
}

// Export a "Form (copy exactly)" draft as a fillable HTML form. If the user edited the layout in the
// preview, download exactly what they see (with their edits); otherwise rebuild from the server.
async function csExportFormDocHtml() {
  if (!csDraft) return;
  const edited = csExtractEditedFormHtml();
  if (edited) {
    const base = ((csDraft.data && (csDraft.data.fileName || csDraft.data.title)) || 'Form').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Form';
    const okDl = downloadBlob(new Blob([edited], { type: 'text/html' }), base + '.html');
    toast(okDl ? 'Fillable HTML form downloaded (with your edits).' : 'Could not start the download — check your browser’s download settings.', okDl ? 'success' : 'error');
    return;
  }
  const data = collectContentEdits('form-doc');
  if (csDraft.data && csDraft.data.formScope) data.formScope = csDraft.data.formScope; // copy only the selected form
  const sourceFileId = (csDraft.data && csDraft.data.sourceFileId) || data.sourceFileId;
  if (!sourceFileId) { toast('This form has no source document to export.', 'error'); return; }
  const r = await POST('/api/content/form-doc-html', { sourceFileId, data });
  if (!r || r.error || !r.html) { toast((r && r.error) || 'Export failed.', 'error'); return; }
  finishDownload(r, new Blob([r.html], { type: 'text/html' }), 'Fillable HTML form');
}

// Export a "Form (copy exactly)" draft as a Word .docx (the exact, re-branded clone) — downloaded directly.
async function csExportFormDocDocx() {
  if (!csDraft) return;
  const data = collectContentEdits('form-doc');
  if (csDraft.data && csDraft.data.formScope) data.formScope = csDraft.data.formScope; // copy only the selected form
  const sourceFileId = (csDraft.data && csDraft.data.sourceFileId) || data.sourceFileId;
  if (!sourceFileId) { toast('This form has no source document to export.', 'error'); return; }
  const r = await POST('/api/content/form-doc-docx', { sourceFileId, data });
  if (!r || r.error || !r.b64) { toast((r && r.error) || 'Export failed.', 'error'); return; }
  finishDownload(r, b64ToBlob(r.b64, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'Word document');
}

// AI Smart Rebuild: the AI reads the uploaded form and rebuilds it CLEAN (correct check-box grouping,
// labelled fields, tables, no blank cells), then downloads a tidy fillable HTML form or Word .docx.
async function csSmartForm(format) {
  if (!csDraft) return;
  const data = collectContentEdits('form-doc');
  if (csDraft.data && csDraft.data.formScope) data.formScope = csDraft.data.formScope; // rebuild only the selected form
  const sourceFileId = (csDraft.data && csDraft.data.sourceFileId) || data.sourceFileId;
  if (!sourceFileId) { toast('This form has no source document to rebuild.', 'error'); return; }
  const btns = [...document.querySelectorAll('button')].filter(b => /AI Smart Rebuild/.test(b.textContent));
  btns.forEach(b => { b.disabled = true; });
  const orig = btns.map(b => b.textContent);
  btns.forEach(b => { b.textContent = '⏳ AI rebuilding…'; });
  try {
    const ep = format === 'docx' ? '/api/content/smart-form-docx' : '/api/content/smart-form-html';
    const r = await POST(ep, { sourceFileId, data });
    if (!r || r.error) { toast((r && r.error) || 'AI rebuild failed.', 'error'); return; }
    if (format === 'docx') {
      if (!r.b64) { toast('AI rebuild failed.', 'error'); return; }
      finishDownload(r, b64ToBlob(r.b64, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'AI Smart Form (Word)');
    } else {
      if (!r.html) { toast('AI rebuild failed.', 'error'); return; }
      finishDownload(r, new Blob([r.html], { type: 'text/html' }), 'AI Smart Form (HTML)');
    }
  } catch (e) { toast('AI rebuild failed: ' + e.message, 'error'); }
  finally { btns.forEach((b, i) => { b.disabled = false; b.textContent = orig[i]; }); }
}

// The forms/procedures the user picked from a multi-item document (drives scoped generation).
// For record forms, several may be selected to COMBINE into one form; procedures are single-select.
let _csSelectedForms = [];
let _csFormsCache = [];
// The analysis kind for the current build type: SOP/SWP → procedures; record form → forms.
function csDetectKind() { const t = val('cs-type'); return (t === 'sop' || t === 'swp') ? 'procedure' : 'form'; }
function csDetectNoun(plural) { return csDetectKind() === 'procedure' ? (plural ? 'procedures' : 'procedure') : (plural ? 'forms' : 'form'); }
// Record forms allow combining several forms; procedures and the exact-copy Form build one at a time.
function csDetectMulti() { return csDetectKind() === 'form' && val('cs-type') !== 'form-doc'; }

// Analyse the uploaded source document and list the distinct forms / procedures it contains.
async function csDetectForms() {
  const sourceFileId = csCurrentSourceId();
  if (!sourceFileId) return toast('Upload or choose a source document first, then analyse it.', 'error');
  const kind = csDetectKind();
  const btn = document.getElementById('cs-rf-detect-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analysing…'; }
  _csSelectedForms = [];
  try {
    const r = await POST('/api/content/detect-forms', { sourceFileId, kind });
    if (!r || r.error) { toast((r && r.error) || 'Analysis failed.', 'error'); return; }
    csRenderFormsList(r.items || r.forms || []);
  } catch (e) { toast('Analysis failed: ' + e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = `🔍 Analyse document for ${csDetectNoun(true)}`; } }
}

// Render the detected-items chooser. Record forms → checkboxes (pick one, or several to COMBINE);
// procedures → radios (build one at a time). 0 → note; 1 → auto-selected.
function csRenderFormsList(items) {
  const list = document.getElementById('cs-forms-list');
  if (!list) return;
  const noun = csDetectNoun(false), nounP = csDetectNoun(true);
  const multi = csDetectMulti();
  list.style.display = '';
  if (!items.length) {
    list.innerHTML = `<div class="cs-forms-empty">No separate ${nounP} were detected — generate as usual with your prompt.</div>`;
    return;
  }
  _csFormsCache = items;
  if (items.length === 1) {
    _csSelectedForms = [items[0]];
    const inp = multi ? 'checkbox' : 'radio';
    list.innerHTML = `<div class="cs-forms-head">1 ${noun} found — it will be built:</div>`
      + `<label class="cs-form-opt selected"><input type="${inp}" name="cs-form-pick" value="0" checked onchange="csPickForm()">`
      + `<span><b>${esc(items[0].title)}</b>${items[0].description ? `<span class="cs-form-desc">${esc(items[0].description)}</span>` : ''}</span></label>`;
    return;
  }
  const head = multi
    ? `📑 ${items.length} ${nounP} found — tick <b>one</b> to build it, or <b>several to combine</b> them into one form:`
    : `📑 ${items.length} ${nounP} found in this document — choose the one to create:`;
  const inp = multi ? 'checkbox' : 'radio';
  list.innerHTML = `<div class="cs-forms-head">${head}</div>`
    + items.map((f, i) => `<label class="cs-form-opt"><input type="${inp}" name="cs-form-pick" value="${i}" onchange="csPickForm()">`
      + `<span><b>${esc(f.title)}</b>${f.description ? `<span class="cs-form-desc">${esc(f.description)}</span>` : ''}</span></label>`).join('')
    + (multi ? `<div class="cs-forms-foot" id="cs-forms-foot"></div>` : '');
  csPickForm();
}
// Recompute the selection from the ticked boxes/radio, update highlight + the combine hint.
function csPickForm() {
  const picks = [...document.querySelectorAll('#cs-forms-list input[name="cs-form-pick"]')];
  _csSelectedForms = picks.filter(p => p.checked).map(p => _csFormsCache[parseInt(p.value, 10)]).filter(Boolean);
  picks.forEach(p => p.closest('.cs-form-opt').classList.toggle('selected', p.checked));
  const foot = document.getElementById('cs-forms-foot');
  if (foot) foot.textContent = _csSelectedForms.length > 1
    ? `✅ ${_csSelectedForms.length} forms will be COMBINED into one record form (each as its own section).`
    : (_csSelectedForms.length === 1 ? 'One form selected.' : '');
}
// Clear any detected-item selection (e.g. when the source or build type changes).
function csResetForms() {
  _csSelectedForms = []; _csFormsCache = [];
  const list = document.getElementById('cs-forms-list');
  if (list) { list.style.display = 'none'; list.innerHTML = ''; }
}

// Show the "Preview mapping" button only when the selected type supports mapping (not form-copy).
function csUpdateMapBtn() {
  const btn = document.getElementById('cs-map-btn');
  if (!btn) return;
  const type = val('cs-type');
  btn.style.display = (type !== 'form-doc' && _csMappableTypes.includes(type)) ? '' : 'none';
}

// Resolve the currently-chosen source FileID (library pick or uploaded file), or null.
function csCurrentSourceId() {
  const activeTab = document.querySelector('.cs-src-tab.active')?.dataset.tab || 'library';
  return activeTab === 'library' ? (val('cs-source') || null) : (_csUploadedFileId || null);
}

// Open the mapping-preview modal for the current source + selected template.
async function csOpenMapPreview() {
  const type = val('cs-type');
  const sourceFileId = csCurrentSourceId();
  if (!sourceFileId) return toast('Choose or upload a source document first (Document 1).', 'error');
  const body = document.getElementById('cs-map-body');
  if (body) body.innerHTML = '<p class="text-soft">⏳ Reading the source and mapping it into the template… (up to ~1 min)</p>';
  showModal('cs-map-modal');
  const r = await POST('/api/content/map-preview', { type, sourceFileId });
  if (!r || r.error) { if (body) body.innerHTML = `<p class="cs-ver-empty">${esc((r && r.error) || 'Mapping failed.')}</p>`; return; }
  _csMapResult = r;
  csRenderMapPreview();
}

function _csTargetOptions(sel) {
  const targets = (_csMapResult && _csMapResult.targets) || [];
  const opts = targets.map(t => { const title = t.title || t; return `<option value="${esc(title)}"${sel === title ? ' selected' : ''}>${esc(title)}${t.required ? ' *' : ''}</option>`; }).join('');
  return opts;
}
const CONF_META = { high: { c: 'approved', l: 'High' }, medium: { c: 'review', l: 'Medium' }, low: { c: 'draft', l: 'Low' } };
function _csConfBadge(conf) { const m = CONF_META[(conf || '').toLowerCase()] || CONF_META.low; return `<span class="cs-status-badge cs-status-${m.c} sm">${m.l}</span>`; }

function csRenderMapPreview() {
  const r = _csMapResult; const body = document.getElementById('cs-map-body');
  if (!r || !body) return;
  const maps = r.mappings || [], unmapped = r.unmapped || [], missing = r.missingRequired || [];
  // Mapping table (source → target, editable target + confidence)
  const mapRows = maps.length ? maps.map((m, i) => `
    <tr>
      <td>${esc(m.source || '')}<div class="cs-map-reason">${esc(m.reason || '')}</div></td>
      <td>→</td>
      <td><select class="cs-map-target" data-i="${i}">${_csTargetOptions(m.target)}</select></td>
      <td>${_csConfBadge(m.confidence)}</td>
    </tr>`).join('') : `<tr><td colspan="4" class="cs-ver-empty">No confident mappings found.</td></tr>`;
  // Unmapped queue — each gets a destination select incl. Additional Information / Exclude
  const unmapRows = unmapped.length ? unmapped.map((u, i) => `
    <tr>
      <td><strong>${esc(u.source || '(untitled)')}</strong><div class="cs-map-reason">${esc(u.excerpt || '')}</div><div class="cs-map-reason">${esc(u.reason || '')}</div></td>
      <td>${_csConfBadge(u.confidence)}</td>
      <td><select class="cs-unmap-target" data-i="${i}" data-source="${esc(u.source || u.excerpt || '')}">
        <option value="__additional__">➕ Additional Information section</option>
        ${_csTargetOptions(u.suggestedTarget)}
        <option value="__exclude__">🚫 Exclude (do not include)</option>
      </select></td>
    </tr>`).join('') : `<tr><td colspan="3" class="cs-ver-empty">Nothing unmapped — all source content fits the template. 👍</td></tr>`;
  const missBlock = missing.length ? `
    <div class="cs-map-section">
      <div class="cs-map-h">⚠ Information required (${missing.length}) — required template sections with no source content</div>
      <ul class="cs-map-missing">${missing.map(m => `<li><strong>${esc(m.target || '')}</strong> — ${esc(m.reason || 'needs information')}</li>`).join('')}</ul>
      <p class="text-soft" style="font-size:12px">These will appear in the document with an <em>[INFORMATION REQUIRED]</em> marker — the AI will not invent them.</p>
    </div>` : '';
  body.innerHTML = `
    <p class="text-soft" style="font-size:13px;margin-top:0">Review how the source maps into the <strong>${esc(val('cs-type'))}</strong> template. Adjust any destination, decide where unmapped content goes, then generate. Nothing is dropped unless you choose “Exclude”.</p>
    <div class="cs-map-section"><div class="cs-map-h">Mapped content (${maps.length})</div>
      <div class="table-responsive"><table class="cs-map-tbl"><thead><tr><th>Source</th><th></th><th>Destination section</th><th>Confidence</th></tr></thead><tbody>${mapRows}</tbody></table></div></div>
    <div class="cs-map-section"><div class="cs-map-h">🗂 Unmapped content queue (${unmapped.length})</div>
      <div class="table-responsive"><table class="cs-map-tbl"><thead><tr><th>Source content</th><th>Conf.</th><th>Send to…</th></tr></thead><tbody>${unmapRows}</tbody></table></div></div>
    ${missBlock}
    <div class="flex gap-2 mt-2">
      <button class="btn btn-accent" onclick="csGenerateWithMapping()">🤖 Generate with this mapping</button>
      <button class="btn btn-outline btn-sm" onclick="closeModal('cs-map-modal')">Cancel</button>
    </div>`;
}

// Collect the reviewer's decisions and run generation with the confirmed mapping applied.
function csGenerateWithMapping() {
  const r = _csMapResult; if (!r) return;
  const mappings = [...document.querySelectorAll('.cs-map-target')].map(sel => ({
    source: (r.mappings[+sel.dataset.i] || {}).source || '', target: sel.value,
  })).filter(m => m.source && m.target);
  const unmappedPlacements = [...document.querySelectorAll('.cs-unmap-target')].map(sel => {
    const u = r.unmapped[+sel.dataset.i] || {};
    return { source: u.source || '', excerpt: u.excerpt || '', target: sel.value };
  });
  _csPendingMapping = { mappings, unmappedPlacements, missingRequired: r.missingRequired || [] };
  closeModal('cs-map-modal');
  toast('Mapping confirmed — generating…');
  runContentGen();
}

async function runContentGen() {
  const type = val('cs-type');
  let prompt = val('cs-prompt');
  const isFormCopy = type === 'form-doc';
  // A form/procedure picked from a multi-item document needs no typed prompt — the chosen item(s) ARE the brief.
  const _picks = (['record-form', 'sop', 'swp', 'form-doc'].includes(type) && Array.isArray(_csSelectedForms)) ? _csSelectedForms.filter(f => f && f.title) : [];
  // form-doc is an exact copy (no AI prompt) — the pick scopes WHICH form to copy, it isn't a brief to write.
  if (!prompt && _picks.length && !isFormCopy) {
    const noun = (type === 'sop' || type === 'swp') ? 'procedure' : 'form';
    prompt = _picks.length > 1
      ? `Create one combined record form from the uploaded document, combining these forms: ${_picks.map(f => `"${f.title}"`).join(', ')}.`
      : `Create the "${_picks[0].title}" ${noun} from the uploaded document.`;
  }
  if (!prompt && !isFormCopy) return toast('Describe what you want the AI to build.', 'error');
  const activeTab  = document.querySelector('.cs-src-tab.active')?.dataset.tab || 'library';
  const sourceFileId = activeTab === 'library' ? (val('cs-source') || undefined) : (_csUploadedFileId || undefined);
  if (isFormCopy && !sourceFileId) return toast('Choose the uploaded document to copy — pick it under “Source document” (Library) or upload one.', 'error');
  const sourceMode   = activeTab === 'upload'
    ? (document.querySelector('input[name="cs-src-mode"]:checked')?.value || 'reference')
    : 'reference';
  // Document 2 — the updated-content source (optional). Keeps Document 1's layout, updates its content.
  const contentActiveTab = document.querySelector('.cs-content-tab.active')?.dataset.tab || 'library';
  const contentFileId = contentActiveTab === 'library' ? (val('cs-content-source') || undefined) : (_csContentFileId || undefined);
  const kbArticleIds = [...document.querySelectorAll('#cs-kb-list .cs-kb-cb:checked')]
    .map(cb => parseInt(cb.value)).filter(Boolean);
  const learningProfile = val('cs-learning-profile') || undefined; // audience literacy dial
  const techDepth = val('cs-tech-depth') || undefined;             // technical depth dial
  const btn = document.getElementById('cs-go'), regen = document.getElementById('cs-regen');
  const status = document.getElementById('cs-status');
  btn.disabled = true; regen.style.display = 'none';
  document.getElementById('cs-result').innerHTML = '';
  // Generating a full document is one large AI write (~60–90s). Show a live elapsed counter so it's clear
  // it's working (not stuck) instead of a static estimate that undersells the wait.
  let genTimer = null;
  if (isFormCopy) {
    status.textContent = '⏳ Copying the document’s layout…';
  } else {
    const t0 = Date.now();
    const tick = () => {
      const s = Math.round((Date.now() - t0) / 1000), m = Math.floor(s / 60);
      status.textContent = s > 120
        ? `⏳ Still writing… ${m}m ${s % 60}s. A typical document is 1–2 min; a very large multi-section document can take up to ~20 min. Keep this tab open — it will finish or report back on its own.`
        : `⏳ Writing your document… ${s}s (a typical document takes 1–2 min — please keep this tab open).`;
    };
    tick(); genTimer = setInterval(tick, 1000);
  }
  try {
    const mapping = _csPendingMapping || undefined; // user-confirmed section mapping (one-shot)
    _csPendingMapping = null;
    const recordOpts = type === 'record-form' ? {
      copyLayout: !!(document.getElementById('cs-rf-copy') && document.getElementById('cs-rf-copy').checked),
      addRiskMatrix: !!(document.getElementById('cs-rf-risk') && document.getElementById('cs-rf-risk').checked),
      removeTraining: !!(document.getElementById('cs-rf-notraining') && document.getElementById('cs-rf-notraining').checked),
    } : undefined;
    // Document / version control (any build type): the chosen control functions, when the option is on
    // and its panel is visible for this type.
    const dcPanel = document.getElementById('cs-doccontrol-panel');
    const dcOn = dcPanel && dcPanel.style.display !== 'none'
      && document.getElementById('cs-rf-doccontrol') && document.getElementById('cs-rf-doccontrol').checked;
    const docControl = dcOn ? [...document.querySelectorAll('#cs-rf-dc-opts .cs-dc-el:checked')].map(c => c.value) : undefined;
    // Items chosen from a multi-item document: one → build that; several (record forms) → COMBINE them.
    const picks = _picks.map(f => ({ title: f.title, description: f.description || '' }));
    const selection = picks.length === 1 ? picks[0] : undefined;      // single build / single form to copy
    const selections = picks.length > 1 ? picks : undefined;          // combine into one form
    // For the exact-copy Form: the full ordered list of detected form titles, so the server can find where
    // the selected form ends (the next form's title) and copy just that one form.
    const detectedTitles = (isFormCopy && Array.isArray(_csFormsCache)) ? _csFormsCache.map(f => f && f.title).filter(Boolean) : undefined;
    // Per-section image suggestions (default on; send false to turn them off) — all generated doc types.
    const imgSuggestEl = document.getElementById('cs-tm-imgsuggest');
    const _genDoc = csIsGeneratedDoc(type);
    const imageSuggest = (_genDoc && imgSuggestEl) ? imgSuggestEl.checked : undefined;
    // Image style for the suggested-image prompts (style / region / gender).
    const _imgOn = _genDoc && imageSuggest !== false;
    const imgStyle  = _imgOn ? (val('cs-img-style') || '') : '';
    const imgRegion = _imgOn ? (val('cs-img-region') || '') : '';
    const imgGender = _imgOn ? (val('cs-img-gender') || '') : '';
    // Use the uploaded document's images in the created document (any build type). Default on.
    const srcImgEl = document.getElementById('cs-srcimg-use');
    const useSourceImages = srcImgEl ? !!srcImgEl.checked : true;
    const refFileIds = _csRefDocs.map(d => d.fileId);
    const r = await POST('/api/content/generate', { type, prompt, sourceFileId, sourceMode, contentFileId, refFileIds, kbArticleIds, learningProfile, techDepth, mapping, recordOpts, selection, selections, detectedTitles, docControl, imageSuggest, imgStyle, imgRegion, imgGender, useSourceImages });
    if (genTimer) { clearInterval(genTimer); genTimer = null; }
    status.textContent = '';
    if (!ok(r)) return;
    csDraft = { type: r.type, data: r.data };
    _csValueCheck = r.valueCheck || null;                 // protected-value check result
    _csValueSourceId = contentFileId || sourceFileId || null; // source used, for re-check
    document.getElementById('cs-result').innerHTML = renderContentPreview(r.type, r.data);
    csShowValueCheck();     // surface any missing/changed source values for review
    csLoadGovernance();
    csHydrateImages();      // re-link any images that came back with the draft
    csHydrateFlows();
    csApplyTransLayout();
    regen.style.display = '';
    if (r.truncated) alert(`This document was too large to generate in one pass, so it was cut short. The ${r.sectionCount || ''} section(s) that completed are shown below — review/save them, then run another generation for the remaining sections (e.g. ask for "sections 15–27 only") and combine.`);
  } catch (e) { status.textContent = ''; toast('Generation failed: ' + e.message, 'error'); }
  finally { if (genTimer) clearInterval(genTimer); btn.disabled = false; }
}
async function regenContent() {
  const confirmRegen = csDraft ? confirm('Regenerate? Your current preview will be replaced.') : true;
  if (!confirmRegen) return;
  await runContentGen();
}

const CS_FIELD_TYPES = ['section','text','textarea','checkbox','competency','yesno','rating','signature','date','number'];
// Tracks per-section images (WeakMap avoids memory leaks when sections are removed)
const _csCardImages = new WeakMap(); // per image-card element → imgData object

// ── Document preview & print ──────────────────────────────────────────────────
function previewDocument() {
  if (!csDraft) return;
  const data = collectContentEdits(csDraft.type);
  document.getElementById('doc-preview-body').innerHTML = buildDocPreviewHtml(data);
  showModal('doc-preview-modal');
}

function buildDocPreviewHtml(data) {
  const e = esc;
  const docTitle = data.title || 'Document';
  const coName   = (cache.company && cache.company.name) ? cache.company.name : '';
  const coLogo   = (cache.company && cache.company.logo) ? cache.company.logo : '';
  const docNum   = data.docNumber || '';
  const m        = data.meta || {};
  const status   = m.status || 'Draft';
  const sections = data.sections || [];
  const transLang = sections.reduce((l, s) => l || (s.translation && s.translation.lang) || null, null);
  const transLayout = data.transLayout || 'below';

  function renderSecBody(body, images, flows, useTrans) {
    if (!body) return '';
    // Build uid → image map
    const imgMap = {};
    if (Array.isArray(images)) for (const img of images) if (img && img.uid) imgMap[img.uid] = img;
    const flowMap = {};
    if (Array.isArray(flows)) for (const fl of flows) if (fl && fl.uid) flowMap[fl.uid] = fl;
    function renderLines(text) {
      let h = '';
      for (const line of text.split('\n')) {
        const t = line.trim(); if (!t) continue;
        if (t.startsWith('- ')||t.startsWith('• ')) h += `<div class="doc-bullet">• ${escMd(t.slice(2).trim())}</div>`;
        else if (/^\d+\.\s/.test(t)) h += `<div class="doc-numbered">${escMd(t)}</div>`;
        else if (/^[a-z]\.\s/.test(t)) h += `<div class="doc-sub-bullet">${escMd(t)}</div>`;
        else if (t.endsWith(':') && !/^[-•]/.test(t)) h += `<div class="doc-label">${e(t)}</div>`;
        else h += `<p class="doc-body">${escMd(t)}</p>`;
      }
      return h;
    }
    // Split on [IMG:uid], [FLOW:uid] and [IMG-SUGGEST: …] markers
    const tokens = body.split(/(\[IMG:[a-z0-9]+\]|\[FLOW:[a-z0-9]+\]|\[IMG-SUGGEST:[\s\S]*?\])/g);
    let h = '';
    for (const token of tokens) {
      const fm = token.match(/^\[FLOW:([a-z0-9]+)\]$/);
      if (fm) {
        const fl = flowMap[fm[1]];
        // Drawn as live SVG in the preview; Word gets the rasterised PNG.
        if (fl) h += `<div class="doc-flowchart">${csDfcSvg(fl, !!useTrans) || ''}</div>`;
        continue;
      }
      const sm = token.match(/^\[IMG-SUGGEST:\s*([\s\S]*?)\]$/i);
      if (sm) {
        const _sg = sm[1].trim();
        h += `<div class="doc-img-suggest"><div class="doc-img-suggest-top"><span class="doc-img-suggest-lbl">🖼 Suggested image — ChatGPT / DALL·E prompt</span><button type="button" class="doc-img-copy" data-copy="${e(_sg)}" onclick="csCopyText(this)">📋 Copy</button></div><div class="doc-img-suggest-txt">${e(_sg)}</div></div>`;
        continue;
      }
      const m = token.match(/^\[IMG:([a-z0-9]+)\]$/);
      if (m) {
        const img = imgMap[m[1]];
        if (img) {
          const L = img.layout || {};
          const wIn = L.docWidth || 3;
          const wPx = Math.round(wIn * 96);
          const wrap = L.wrapping || 'inline';
          let style = `width:${wPx}px;max-width:100%;`;
          if (wrap === 'inline') style += 'display:inline-block;vertical-align:middle;margin:2px 4px;';
          else if (wrap === 'behind') style += 'display:block;opacity:0.5;margin:6px auto;';
          else if (wrap === 'topBottom') style += 'display:block;margin:8px auto;text-align:center;clear:both;';
          else if (L.hAlign === 'right' || L.hAlign === 'center') style += `float:${L.hAlign === 'right' ? 'right' : 'none'};margin:0 0 8px 12px;`;
          else style += 'float:left;margin:0 12px 8px 0;';
          // Callouts are burned into the annotated copy. NUMBERED callouts also get a legend
          // under the image (English + translation); LEADER callouts carry their text on the
          // image itself, so they are not repeated in the legend.
          const cal = Array.isArray(img.callouts) ? img.callouts.filter(c => c && c.text) : [];
          const numbered = cal.filter(c => c.kind !== 'leader');
          const legend = numbered.length
            ? `<div class="doc-img-callouts">${numbered.map(c =>
                (img.calBilingual && c.trans)
                  ? `<div class="doc-img-callout"><b>${c.n}.</b> ${e(c.trans)} <span class="doc-img-callout-sep">·</span> ${e(c.text)}</div>`
                  : `<div class="doc-img-callout"><b>${c.n}.</b> ${e(c.text)}${c.trans ? `<div class="doc-img-callout-tr">${e(c.trans)}</div>` : ''}</div>`).join('')}</div>`
            : '';
          const src = cal.length ? ((useTrans && img.annotatedTr) ? img.annotatedTr : (img.annotated || img.base64)) : img.base64;
          h += `<div class="doc-img-item doc-img-positioned" style="${style}">
            <img src="${src}" style="width:100%;height:auto;display:block" alt="${e(img.caption||'')}">
            ${img.caption ? `<div class="doc-img-caption">${e(img.caption)}</div>` : ''}
            ${legend}
          </div>`;
        }
      } else if (token.trim()) {
        h += renderLines(token);
      }
    }
    return h;
  }
  function renderSecTable(tbl) {
    if (!tbl || !tbl.headers) return '';
    const riskCols = tbl.headers.map(csIsRiskHeader);
    let h = `<table class="doc-tbl"><thead><tr>${tbl.headers.map(x=>`<th>${e(x)}</th>`).join('')}</tr></thead><tbody>`;
    for (const row of (tbl.rows||[])) h += `<tr>${tbl.headers.map((_,i)=>{
      const v=(row||[])[i]||''; const st=csRiskCellStyle(v,riskCols[i]);
      return `<td${st}>${e(v)}</td>`;
    }).join('')}</tr>`;
    return h + `</tbody></table>`;
  }
  // AKARA Risk Rank Matrix banding — mirrors riskBand() in lib/content.js.
  function riskBandCss(score) {
    const n = Number(score);
    if (!isFinite(n) || n < 1) return { fill:'#E8EAF0', text:'#1E3A5F', level:'' };
    if (n <= 5)  return { fill:'#8DC63F', text:'#1A1A1A', level:'Low' };
    if (n <= 10) return { fill:'#3C6FC4', text:'#FFFFFF', level:'Moderate' };
    if (n <= 17) return { fill:'#FFF200', text:'#1A1A1A', level:'High' };
    return { fill:'#E01B1B', text:'#FFFFFF', level:'Critical' };
  }
  const RISK_LIKE = { A:'Almost Certain', B:'Likely', C:'Possible', D:'Unlikely', E:'Rare' };
  const RISK_CONSEQ = { 1:'Insignificant', 2:'Minor', 3:'Moderate', 4:'Major', 5:'Catastrophic' };
  function renderRiskTable(risk) {
    const arr = Array.isArray(risk) ? risk : (risk ? [risk] : []);
    const rows = arr.map(r => {
      if (!r || typeof r !== 'object') return null;
      const score = Number(r.score != null ? r.score : r.initial);
      const residual = (r.residual != null && r.residual !== '') ? Number(r.residual) : null;
      if (!isFinite(score) && !isFinite(residual)) return null;
      return { hazard: r.hazard||'', likelihood: r.likelihood ? String(r.likelihood).trim().toUpperCase().slice(0,1) : '',
        consequence: (r.consequence!=null&&r.consequence!=='')?Number(r.consequence):null,
        score: isFinite(score)?score:null, residual: isFinite(residual)?residual:null };
    }).filter(Boolean);
    if (!rows.length) return '';
    const showHazard = rows.some(x=>x.hazard), showLike = rows.some(x=>x.likelihood),
          showConseq = rows.some(x=>isFinite(x.consequence)), showRes = rows.some(x=>isFinite(x.residual));
    const cols = [
      ...(showHazard?[{k:'hazard',l:'Hazard'}]:[]),
      ...(showLike?[{k:'likelihood',l:'Likelihood'}]:[]),
      ...(showConseq?[{k:'consequence',l:'Consequence'}]:[]),
      {k:'score',l:'Risk Rating'},
      ...(showRes?[{k:'residual',l:'Residual Risk'}]:[]),
    ];
    const cell = (c,x)=>{
      if (c.k==='score'||c.k==='residual') {
        const v = c.k==='score'?x.score:x.residual;
        if (!isFinite(v)) return `<td class="doc-risk-score" style="text-align:center">—</td>`;
        const b = riskBandCss(v);
        return `<td class="doc-risk-score" style="background:${b.fill};color:${b.text}"><span class="doc-risk-num">${v}</span><span class="doc-risk-lvl">${b.level}</span></td>`;
      }
      let t='';
      if (c.k==='hazard') t = x.hazard;
      else if (c.k==='likelihood') t = x.likelihood ? `${x.likelihood}${RISK_LIKE[x.likelihood]?' – '+RISK_LIKE[x.likelihood]:''}` : '';
      else if (c.k==='consequence') t = isFinite(x.consequence) ? `${x.consequence}${RISK_CONSEQ[x.consequence]?' – '+RISK_CONSEQ[x.consequence]:''}` : '';
      return `<td${c.k==='hazard'?'':' style="text-align:center"'}>${e(t)}</td>`;
    };
    let h = `<table class="doc-risk-tbl"><thead><tr><th colspan="${cols.length}" class="doc-risk-title">Risk Assessment</th></tr><tr>${cols.map(c=>`<th>${e(c.l)}</th>`).join('')}</tr></thead><tbody>`;
    for (const x of rows) h += `<tr>${cols.map(c=>cell(c,x)).join('')}</tr>`;
    return h + `</tbody></table>`;
  }
  function renderFlowchart(fc) {
    if (!fc || !Array.isArray(fc.stages) || !fc.stages.length) return '';
    let h = `<div class="doc-flow">`;
    if (fc.title) h += `<div class="doc-flow-title">${e(fc.title)}</div>`;
    h += `<div class="doc-flow-row">`;
    fc.stages.forEach((st, i) => {
      h += `<div class="doc-flow-stage"><div class="doc-flow-stage-h">${e(st.title||'')}</div>`;
      if (Array.isArray(st.items) && st.items.length)
        h += `<ul class="doc-flow-items">${st.items.map(it=>`<li>${e(String(it))}</li>`).join('')}</ul>`;
      h += `</div>`;
      if (i < fc.stages.length - 1) h += `<div class="doc-flow-arrow">→</div>`;
    });
    h += `</div>`;
    if (Array.isArray(fc.notes) && fc.notes.length)
      h += `<div class="doc-flow-notes">${fc.notes.map(nt=>`<div class="doc-callout">${e(String(nt))}</div>`).join('')}</div>`;
    return h + `</div>`;
  }

  let h = `<div class="doc-page">`;

  // ── Running header strip (hidden on screen, position:fixed in print) ─────
  const rhLogoHtml = coLogo ? `<img src="${coLogo}" class="doc-rh-logo" alt="">` : '';
  h += `<div class="doc-running-hdr">
    <div class="doc-rh-brand">${rhLogoHtml}<span class="doc-rh-name">${e(coName)}</span></div>
    <div class="doc-rh-num">${e(docNum)}</div>
  </div>`;

  // ── Cover page wrapper (Fix D: unconditional page-break-after in print) ──
  h += `<div class="doc-cover-page">`;

  // ── Cover header (topbar: logo left | "Company: DocNum" right, faint rule, then title) ──
  const coverLogo = coLogo ? `<img src="${coLogo}" class="doc-cover-logo" alt="${e(coName)}">` : '';
  const coverRef  = `${coName ? `<span class="doc-cover-ref-name">${e(coName)}:</span> ` : ''}${docNum ? `<span class="doc-cover-ref-num">${e(docNum)}</span>` : ''}`;
  h += `<div class="doc-cover-header">
    <div class="doc-cover-topbar">
      <div class="doc-cover-logo-wrap">${coverLogo}</div>
      <div class="doc-cover-ref">${coverRef}</div>
    </div>
    <div class="doc-title">${e(docTitle)}</div>
    ${data.subtitle ? `<div class="doc-sub">${e(data.subtitle)}</div>` : ''}
    ${docNum ? `<div class="doc-cover-docref"><span class="doc-cover-docref-lbl">Document:</span> ${e(docNum)}</div>` : ''}
    ${transLang ? `<div style="margin-top:7px"><span class="doc-bilingual-badge">🌐 Bilingual · ${e(transLang)}</span></div>` : ''}
  </div>`;

  // ── Document control table ───────────────────────────────────────
  const statusRow = ['Draft','Under Review','Approved'].map(s=>`${s===status?'☑':'☐'} ${s}`).join('  &nbsp;&nbsp; ');
  h += `<table class="doc-meta-tbl"><tbody>
    <tr><td>Status</td><td colspan="3">${statusRow}</td></tr>
    <tr><td>Version</td><td colspan="3">${e(m.version||'1.0')}</td></tr>
    <tr><td>Document ID</td><td colspan="3">${e(docNum||'[Auto-generated by TrainingPro]')}</td></tr>
    ${transLang ? `<tr><td>Language</td><td colspan="3">English / ${e(transLang)}</td></tr>` : ''}
    ${transLang && m.transReviewStatus ? `<tr><td>${e(transLang)} Translation</td><td colspan="3" class="doc-trans-status-cell doc-trans-status-${m.transReviewStatus==='Complete'?'complete':'review'}">${m.transReviewStatus==='Complete'?'✅ Complete':'🔄 Under Review'}</td></tr>` : ''}
    <tr class="doc-meta-sig-hdr"><td></td><td>Name &amp; Title</td><td>Signature</td><td class="doc-meta-date">Date</td></tr>
    <tr><td>Prepared By</td><td>${e(m.preparedBy||'')}</td><td class="doc-meta-sig-line"></td><td class="doc-meta-date"></td></tr>
    <tr><td>Reviewed By</td><td>${e(m.reviewedBy||'')}</td><td class="doc-meta-sig-line"></td><td class="doc-meta-date"></td></tr>
    <tr><td>Approved By</td><td>${e(m.approvedBy||'')}</td><td class="doc-meta-sig-line"></td><td class="doc-meta-date"></td></tr>
  </tbody></table>`;

  h += `<div class="doc-page-break">— Document control above · Content begins on page 2 —</div>`;
  h += `</div>`; // end doc-cover-page

  // ── Sections ─────────────────────────────────────────────────────
  for (const s of sections) {
    const lvl = s.level || 1;
    // Build the English (original) content into its own string
    let enHtml = '';
    if (s.heading) enHtml += `<div class="doc-h${lvl}">${e(s.heading)}</div>`;
    if (s.callout) enHtml += `<div class="doc-callout">${e(s.callout)}</div>`;
    enHtml += renderSecBody(s.body, s.images, s.flows, false);
    enHtml += renderFlowchart(s.flowchart);
    enHtml += renderSecTable(s.table);
    enHtml += renderRiskTable(s.risk);
    if (s.checklist) for (const item of s.checklist) enHtml += `<div class="doc-checklist-item">☐ ${e(item)}</div>`;
    // Legacy images (no uid / not placed via marker) — render at end of section
    const sImgs = (Array.isArray(s.images) ? s.images : (s.image && s.image.base64 ? [s.image] : []))
      .filter(si => si && si.base64 && (!si.uid || !(s.body||'').includes(`[IMG:${si.uid}]`)));
    if (sImgs.length) {
      enHtml += `<div class="doc-img-gallery" style="clear:both">`;
      for (const si of sImgs) {
        const wPx = si.layout && si.layout.docWidth ? Math.round(si.layout.docWidth * 96) : 300;
        enHtml += `<div class="doc-img-item" style="width:${wPx}px;max-width:100%"><img src="${si.base64}" class="doc-img" alt="">`;
        if (si.caption) enHtml += `<div class="doc-img-caption">${e(si.caption)}</div>`;
        enHtml += `</div>`;
      }
      enHtml += `</div>`;
    }
    enHtml += `<div style="clear:both"></div>`;
    // Build the translation block into its own string
    let trHtml = '';
    if (s.translation) {
      const tr = s.translation;
      const trBody  = renderSecBody(tr.body, null, s.flows, true);
      const trTable = renderSecTable(tr.table);
      const trFlow  = renderFlowchart(tr.flowchart);
      const hasContent = tr.heading || tr.callout || trBody || trTable || trFlow || (tr.checklist && tr.checklist.length);
      if (hasContent) {
        trHtml += `<div class="doc-trans-block">`;
        trHtml += `<div class="doc-trans-divider"><span class="doc-trans-badge-preview">🌐 ${e(tr.lang||'Translation')}</span></div>`;
        if (tr.heading) trHtml += `<div class="doc-h${lvl} doc-trans-heading">${e(tr.heading)}</div>`;
        if (tr.callout) trHtml += `<div class="doc-callout">${e(tr.callout)}</div>`;
        trHtml += trBody;
        trHtml += trFlow;
        trHtml += trTable;
        if (tr.checklist) for (const item of tr.checklist) trHtml += `<div class="doc-checklist-item">☐ ${e(item)}</div>`;
        trHtml += `</div>`;
      }
    }
    // Emit English + translation in the chosen position
    const enWrap = `<div class="doc-sec-en">${enHtml}</div>`;
    let secInner;
    if (!trHtml) {
      secInner = enHtml;
    } else if (transLayout === 'above') {
      secInner = `<div class="doc-sec-pair doc-sec-above">${trHtml}${enWrap}</div>`;
    } else if (transLayout === 'side') {
      secInner = `<div class="doc-sec-pair doc-sec-side">${enWrap}${trHtml}</div>`;
    } else {
      secInner = `<div class="doc-sec-pair">${enWrap}${trHtml}</div>`;
    }
    // Landscape sections render in a wide rotated band (mirrors the Word landscape page)
    h += s.landscape ? `<div class="doc-landscape">${secInner}</div>` : secInner;
  }

  // ── Footer bar (single-row, Word doc layout: Company·Title | DocNum|Status|Lang | Page X of Y) ──
  const footerLeft   = [e(coName), e(docTitle)].filter(Boolean).join(' · ');
  const footerCenter = [e(docNum), e(status), transLang ? e(transLang) : ''].filter(Boolean).join(' | ');
  h += `<div class="doc-footer-bar">
    <div class="doc-footer-row">
      <span class="doc-footer-left">${footerLeft}</span>
      <span class="doc-footer-center">${footerCenter}</span>
      <span class="doc-footer-right">Page <span class="doc-pg-num"></span></span>
    </div>
  </div>`;
  h += `</div>`;
  return h;
}

function buildDocCheckSummary(data, type) {
  const coName = (cache.company && cache.company.name) ? cache.company.name : '';
  const coLogo = (cache.company && cache.company.logo) ? cache.company.logo : '';
  const docNum = data.docNumber || '';
  const m = data.meta || {};
  const sections = data.sections || [];
  const transLang = sections.reduce((l, s) => l || (s.translation && s.translation.lang) || null, null);
  const footerLeft   = [coName, data.title || ''].filter(Boolean).join(' · ');
  const footerCenter = [docNum, m.status || 'Draft', transLang ? `Bilingual: ${transLang}` : ''].filter(Boolean).join(' | ');
  return {
    type: type || 'document',
    coverPage: {
      companyLogoConfigured: !!coLogo,
      companyNameConfigured: !!coName,
      companyName: coName,
      twoLogosOnCover: !!coLogo,
      documentTitle: data.title || '',
      documentTitlePresent: !!(data.title && data.title.trim()),
      documentNumber: docNum,
      documentNumberPresent: !!docNum,
      subtitle: data.subtitle || '',
      status: m.status || '',
      version: m.version || '',
      preparedBy: m.preparedBy || '',
      reviewedBy: m.reviewedBy || '',
      approvedBy: m.approvedBy || '',
    },
    footer: {
      leftZone: footerLeft,
      centerZone: footerCenter,
      rightZone: 'Page X of Y',
      leftZonePopulated: !!footerLeft,
      centerZonePopulated: !!footerCenter,
    },
    sectionCount: sections.length,
    sections: sections.map((s, i) => ({
      index: i + 1,
      heading: s.heading || '(no heading)',
      hasBody: !!(s.body && s.body.trim()),
      bodyLength: (s.body || '').length,
      hasTable: !!(s.table && s.table.headers && s.table.headers.length),
      hasChecklist: !!(s.checklist && s.checklist.length),
      hasTranslation: !!s.translation,
      translationLang: s.translation ? s.translation.lang : null,
      translationHasHeading: !!(s.translation && s.translation.heading),
      translationHasBody: !!(s.translation && s.translation.body && s.translation.body.trim()),
      translationHasTable: !!(s.translation && s.translation.table && s.translation.table.headers && s.translation.table.headers.length),
      translationHasChecklist: !!(s.translation && s.translation.checklist && s.translation.checklist.length),
    }))
  };
}

async function aiPrePrintCheck() {
  if (!csDraft) return;
  const btn = document.getElementById('ai-check-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Checking…'; }
  try {
    const data = collectContentEdits(csDraft.type);
    const summary = buildDocCheckSummary(data, csDraft.type);
    const r = await POST('/api/ai/doc-check', { summary });
    if (btn) { btn.disabled = false; btn.textContent = '🤖 AI Check'; }
    const issueCount = r.issues ? r.issues.length : 0;
    const icon = issueCount === 0 ? '✅' : '⚠️';
    const issueList = issueCount === 0
      ? '<p style="color:var(--success,#16a34a);font-weight:600;">No layout issues found — document looks good to print.</p>'
      : r.issues.map(iss => `<div style="margin-bottom:10px;padding:10px 12px;background:var(--bg-soft,#f8fafc);border-left:3px solid ${iss.severity==='error'?'#ef4444':'#f59e0b'};border-radius:4px">
          <div style="font-weight:600;font-size:13px;">${esc(iss.title)}</div>
          <div style="font-size:12px;color:var(--text-soft);margin-top:3px;">${esc(iss.detail)}</div>
        </div>`).join('');
    const body = `<div style="max-height:55vh;overflow-y:auto;padding:4px 0">${issueList}${r.summary ? `<p style="margin-top:12px;font-size:12px;color:var(--text-soft)">${esc(r.summary)}</p>` : ''}</div>`;
    showAiCheckResults(`${icon} AI Layout Check`, body);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '🤖 AI Check'; }
    toast('AI check failed: ' + (err.message || 'Unknown error'), 'error');
  }
}

function showAiCheckResults(title, bodyHtml) {
  const existing = document.getElementById('ai-check-result-modal');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'ai-check-result-modal';
  el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center';
  el.innerHTML = `<div style="background:var(--bg,#fff);border-radius:10px;width:520px;max-width:92vw;box-shadow:0 8px 32px rgba(0,0,0,.18);overflow:hidden">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border,#e5e7eb)">
      <h3 style="font-size:15px;font-weight:700;margin:0">${title}</h3>
      <button onclick="document.getElementById('ai-check-result-modal').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-soft,#6b7280);line-height:1">✕</button>
    </div>
    <div style="padding:18px 20px">${bodyHtml}</div>
  </div>`;
  el.addEventListener('click', e => { if (e.target === el) el.remove(); });
  document.body.appendChild(el);
}

function printDocPreview() {
  if (!csDraft) return;
  const data = collectContentEdits(csDraft.type);
  const html = buildDocPreviewHtml(data);
  const e = esc;
  const coName    = (cache.company && cache.company.name) ? cache.company.name : '';
  const coLogo    = (cache.company && cache.company.logo) ? cache.company.logo : '';
  const docNum    = data.docNumber || '';
  const status    = (data.meta && data.meta.status) || 'Draft';
  const docTitle  = data.title || 'Document';
  const sections  = data.sections || [];
  const transLang = sections.reduce((l, s) => l || (s.translation && s.translation.lang) || null, null);
  // Running header/footer text lifted by paged.js into the @page margin boxes
  const footerLeft   = [coName, docTitle].filter(Boolean).join(' · ');
  const footerCenter = [docNum, status, transLang || ''].filter(Boolean).join('  |  ');
  const rhLogo = coLogo ? `<img src="${coLogo}" alt="">` : '';
  const runEls = `
    <div class="pg-rh-brand">${rhLogo}<span>${e(coName)}</span></div>
    <div class="pg-rh-num">${e(docNum)}</div>
    <div class="pg-rf-left">${e(footerLeft)}</div>
    <div class="pg-rf-center">${e(footerCenter)}</div>`;
  const win = window.open('', '_blank', 'width=960,height=820');
  win.document.write(`<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>${e(docTitle)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  html,body{background:#5b5e63;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;font-size:10pt;line-height:1.5;color:#23272f}

  /* ── paged.js page sheets (shown in the popup preview) ── */
  .pagedjs_pages{margin-top:54px;padding:8mm 0}
  .pagedjs_page{background:#fff;margin:0 auto 9mm;box-shadow:0 3px 16px rgba(0,0,0,.4)}

  /* ── Running header/footer source elements lifted into @page margin boxes ── */
  .pg-rh-brand{position:running(rhBrand);display:flex;align-items:center;gap:5pt;font-size:9pt;font-weight:bold;color:#1E3A5F}
  .pg-rh-brand img{max-height:12pt;max-width:42pt;object-fit:contain}
  .pg-rh-num{position:running(rhNum);font-size:8pt;color:#5A6072}
  .pg-rf-left{position:running(rfLeft);font-size:7pt;color:#9CA3AF;white-space:nowrap}
  .pg-rf-center{position:running(rfCenter);font-size:7pt;color:#9CA3AF;white-space:nowrap}

  @page{
    size:A4 portrait;
    margin:24mm 16mm 18mm;
    @top-left{content:element(rhBrand);vertical-align:bottom;border-bottom:0.75pt solid #D7DAE3;padding-bottom:4pt}
    @top-center{content:"";border-bottom:0.75pt solid #D7DAE3;padding-bottom:4pt}
    @top-right{content:element(rhNum);vertical-align:bottom;border-bottom:0.75pt solid #D7DAE3;padding-bottom:4pt;text-align:right}
    @bottom-left{content:element(rfLeft);vertical-align:top;border-top:0.75pt solid #D7DAE3;padding-top:4pt}
    @bottom-center{content:element(rfCenter);vertical-align:top;border-top:0.75pt solid #D7DAE3;padding-top:4pt;text-align:center}
    @bottom-right{content:"Page " counter(page) " of " counter(pages);vertical-align:top;border-top:0.75pt solid #D7DAE3;padding-top:4pt;text-align:right;font-size:7pt;color:#9CA3AF}
  }
  /* Cover page (first): no running header */
  @page:first{
    @top-left{content:none;border:none}
    @top-center{content:none;border:none}
    @top-right{content:none;border:none}
  }

  /* Hide the in-flow header/footer baked into buildDocPreviewHtml — paged.js draws them */
  .doc-running-hdr,.doc-footer-bar{display:none!important}

  /* ── Document body (A4, points) ── */
  .doc-page{padding:0;margin:0;max-width:none;width:auto;background:transparent}
  .doc-cover-page{break-after:page}
  .doc-page-break{display:none}
  .doc-title{font-size:15pt;font-weight:bold;color:#1E3A5F;margin:0 0 3pt;line-height:1.25}
  .doc-sub{font-size:9pt;color:#5A6072;margin:0 0 2pt}
  .doc-rule{border:none;border-bottom:2pt solid #FBC02D;margin:8pt 0 12pt}
  .doc-cover-header{padding-bottom:8pt;border-bottom:2pt solid #FBC02D;text-align:left;break-inside:avoid}
  .doc-cover-topbar{display:flex;align-items:center;justify-content:space-between;gap:14pt;padding-bottom:6pt;margin-bottom:10pt;border-bottom:0.75pt solid #D7DAE3}
  .doc-cover-logo-wrap{flex:0 0 auto}
  .doc-cover-logo{max-height:46pt;max-width:130pt;object-fit:contain;display:block}
  .doc-cover-ref{flex:1 1 auto;text-align:right;font-size:9pt;color:#5A6072;white-space:nowrap}
  .doc-cover-ref-name{font-weight:bold;color:#1E3A5F;margin-right:8pt}
  .doc-cover-ref-num{color:#5A6072}
  .doc-cover-brand{display:flex;align-items:center;gap:6pt;margin-bottom:8pt}
  .doc-cover-coname{font-size:11pt;font-weight:bold;color:#1E3A5F}
  .doc-cover-docref{margin-top:5pt;font-size:8.5pt;color:#5A6072}
  .doc-cover-docref-lbl{font-weight:bold;color:#1E3A5F}
  .doc-h1{font-size:12pt;font-weight:bold;color:#1E3A5F;margin:16pt 0 6pt;border-bottom:1pt solid #E8ECF2;padding-bottom:3pt;break-after:avoid}
  .doc-h2{font-size:10.5pt;font-weight:bold;color:#23272F;margin:12pt 0 5pt;break-after:avoid}
  .doc-h3{font-size:9.5pt;font-weight:bold;color:#5A6072;margin:9pt 0 4pt;break-after:avoid}
  .doc-body{font-size:9.5pt;margin:0 0 5pt}
  .doc-label{font-size:9.5pt;font-weight:bold;margin:7pt 0 2pt;break-after:avoid}
  .doc-bullet{font-size:9.5pt;margin:1.5pt 0;padding-left:1.3em;text-indent:-1.3em}
  .doc-numbered{font-size:9.5pt;margin:2pt 0;padding-left:2.2em;text-indent:-2.2em}
  .doc-sub-bullet{font-size:9.5pt;margin:1.5pt 0 1.5pt 18pt;padding-left:1.3em;text-indent:-1.3em;color:#3a3f4b}
  .doc-meta-tbl{font-size:9pt;break-inside:avoid;width:100%;table-layout:fixed;border-collapse:collapse;margin-top:10pt}
  .doc-meta-tbl td{padding:4pt 8pt;word-break:break-word;vertical-align:top;border:1pt solid #D7DAE3}
  .doc-meta-tbl td:first-child{width:22%;background:#1E3A5F;color:#fff;font-weight:bold}
  .doc-meta-sig-hdr td{background:#F6F7FB;color:#5A6072;font-size:7.5pt;font-weight:bold;text-transform:uppercase;letter-spacing:.04em}
  .doc-meta-sig-hdr td:first-child{background:#1E3A5F;color:#1E3A5F}
  .doc-meta-sig-line{border-bottom:1pt solid #D7DAE3;min-width:80pt}
  .doc-meta-date{width:90pt;white-space:nowrap;color:#374151}
  .doc-tbl{font-size:9pt;margin:6pt 0 10pt;width:100%;table-layout:fixed;border-collapse:collapse}
  .doc-tbl thead{display:table-header-group}
  .doc-tbl th{background:#1E3A5F!important;color:#fff!important;padding:4pt 8pt;text-align:left;font-weight:bold;word-break:break-word;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .doc-tbl td{border:1pt solid #D7DAE3;padding:3pt 8pt;word-break:break-word}
  .doc-tbl tr{break-inside:avoid}
  .doc-tbl tr:nth-child(even) td{background:#F6F7FB}
  .doc-callout{font-size:9pt;break-inside:avoid;background:#FFFBEB;border-left:4pt solid #FBC02D;padding:8pt 12pt;margin:6pt 0;color:#713F12;white-space:pre-wrap;word-break:break-word;border-radius:0 4pt 4pt 0}
  .doc-checklist-item{font-size:9.5pt;padding:2pt 0 2pt 4pt;break-inside:avoid}
  .doc-img-gallery{display:flex;flex-wrap:wrap;gap:8pt;break-inside:avoid;margin:8pt 0}
  .doc-img-item{display:flex;flex-direction:column;align-items:center;flex:1;min-width:120pt}
  .doc-img{max-width:100%;max-height:160pt;object-fit:contain;border:1pt solid #D7DAE3;border-radius:3pt}
  .doc-img-caption{font-size:8pt;color:#5A6072;font-style:italic;margin-top:3pt;text-align:center}
  .doc-img-positioned{break-inside:avoid}
  .doc-trans-block{break-inside:avoid;border-left:3pt solid #3B82F6;padding:6pt 0 6pt 10pt;margin:10pt 0;background:#F0F7FF}
  .doc-sec-side{display:flex;gap:12pt;align-items:flex-start;break-inside:avoid}
  .doc-sec-side .doc-sec-en{flex:1;min-width:0}
  .doc-sec-side .doc-trans-block{flex:1;min-width:0;margin:0}
  .doc-trans-divider{margin-bottom:4pt}
  .doc-trans-badge,.doc-trans-badge-preview{background:#2563EB;color:#fff;font-size:7pt;font-weight:bold;padding:1pt 5pt;border-radius:3pt}
  .doc-trans-heading{color:#1D4ED8;border-color:#BFDBFE}
  .doc-trans-status-cell{font-weight:bold}
  .doc-bilingual-badge{background:#EFF6FF;color:#1D4ED8;font-size:7.5pt;font-weight:bold;padding:2pt 6pt;border-radius:3pt;border:1pt solid #BFDBFE}
  /* Flowchart (process flow) */
  .doc-flow{margin:10pt 0;break-inside:avoid}
  .doc-flow-title{font-weight:bold;color:#1E3A5F;text-align:center;margin-bottom:8pt;font-size:13pt}
  .doc-flow-row{display:flex;align-items:stretch;gap:0;width:100%}
  .doc-flow-stage{flex:1 1 0;min-width:0;border:1pt solid #1E3A5F;border-radius:4pt;overflow:hidden;display:flex;flex-direction:column}
  .doc-flow-stage-h{background:#1E3A5F!important;color:#fff!important;font-weight:bold;font-size:8pt;text-align:center;padding:3pt 4pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .doc-flow-items{list-style:none;margin:0;padding:4pt 6pt;font-size:7.5pt}
  .doc-flow-items li{padding:1pt 0}
  .doc-flow-arrow{display:flex;align-items:center;color:#FBC02D;font-size:16pt;font-weight:bold;padding:0 3pt}
  .doc-flow-notes{margin-top:8pt}
  /* Landscape page — the section gets its own true landscape A4 page (paged.js named page).
     break-before/after isolates it; the Layout Doctor also scales any flow that's still too wide. */
  @page landscape{size:A4 landscape;margin:14mm 14mm 16mm}
  .doc-landscape{page:landscape;break-before:page;break-after:page;margin:0}

  /* ── Layout Doctor approval banner (popup only — never printed) ── */
  #pg-banner{position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;gap:12px;
    padding:9px 18px;background:#1E3A5F;color:#fff;font-family:'Inter',Arial,sans-serif;font-size:13px;box-shadow:0 2px 10px rgba(0,0,0,.35)}
  #pg-banner .pg-b-info{flex:1;line-height:1.4}
  #pg-banner .pg-b-info b{color:#FCD9B6}
  #pg-banner .pg-b-adj{display:block;font-size:11.5px;color:#cbd5e1;margin-top:2px}
  #pg-banner button{font-family:inherit;font-size:12.5px;font-weight:600;border:none;border-radius:6px;padding:7px 16px;cursor:pointer}
  #pg-banner .pg-print{background:#F58220;color:#fff}
  #pg-banner .pg-close{background:transparent;color:#cbd5e1;border:1px solid #475569}
  .pg-spin{display:inline-block;width:14px;height:14px;border:2px solid #ffffff55;border-top-color:#fff;border-radius:50%;animation:pgspin .7s linear infinite;vertical-align:-2px;margin-right:6px}
  @keyframes pgspin{to{transform:rotate(360deg)}}

  @media print{
    #pg-banner{display:none!important}
    html,body{background:#fff}
    .pagedjs_pages{margin-top:0;padding:0}
    .pagedjs_page{margin:0;box-shadow:none}
  }
</style></head><body>
${runEls}${html}
<script>
  window.__pgAdjust=[];
  // Banner lives on <html> (outside <body>) so paged.js auto-pagination never consumes it
  (function(){var b=document.createElement('div');b.id='pg-banner';
    b.innerHTML='<span class="pg-b-info"><span class="pg-spin"></span>Layout Doctor is paginating the document\\u2026</span>';
    document.documentElement.appendChild(b);})();
  window.PagedConfig={auto:true,after:function(flow){
    try{
      var pages=(flow&&flow.total)||document.querySelectorAll('.pagedjs_page').length||0;
      var counts={}; (window.__pgAdjust||[]).forEach(function(a){counts[a]=(counts[a]||0)+1;});
      var adj=Object.keys(counts).map(function(k){return counts[k]>1?(k+' \\u00d7'+counts[k]):k;});
      var adjHtml=adj.length?'<span class="pg-b-adj">\\ud83d\\udd27 Adjusted: '+adj.join(' \\u00b7 ')+'</span>':'<span class="pg-b-adj">\\u2713 No overflow or layout issues found</span>';
      var b=document.getElementById('pg-banner'); if(!b) return; b.dataset.done='1';
      b.innerHTML='<span class="pg-b-info"><b>'+pages+' page'+(pages===1?'':'s')+'</b> laid out \\u00b7 A4 portrait'+adjHtml+'</span>'+
        '<button class="pg-print">\\ud83d\\udda8 Print</button><button class="pg-close">Close</button>';
      b.querySelector('.pg-print').addEventListener('click',function(){window.print();});
      b.querySelector('.pg-close').addEventListener('click',function(){window.close();});
    }catch(err){}
  }};
  // Watchdog: if the layout engine fails to load (e.g. offline), offer a plain print fallback
  setTimeout(function(){
    var b=document.getElementById('pg-banner');
    if(b&&!b.dataset.done&&!document.querySelector('.pagedjs_page')){
      b.innerHTML='<span class="pg-b-info">\\u26a0\\ufe0f Could not load the layout engine (offline?). <button class="pg-print">Print anyway</button></span>';
      var p=b.querySelector('.pg-print'); if(p) p.addEventListener('click',function(){window.print();});
    }
  },10000);
<\/script>
<script src="https://unpkg.com/pagedjs@0.4.3/dist/paged.polyfill.js"><\/script>
<script>
  (function(){
    if(!(window.Paged&&Paged.registerHandlers)) return;
    var Doctor=class extends Paged.Handler{
      afterPageLayout(pageEl){
        try{
          var content=pageEl.querySelector('.pagedjs_page_content'); if(!content) return;
          var avail=content.clientHeight; if(!avail) return;
          var availW=content.clientWidth;
          content.querySelectorAll('img').forEach(function(img){
            var h=img.getBoundingClientRect().height;
            if(h>avail*0.92){ img.style.maxHeight=Math.floor(avail*0.88)+'px'; img.style.width='auto'; window.__pgAdjust.push('Resized an oversized image to fit the page'); }
          });
          // Width-fit wide landscape content (flowcharts AND wide tables): if it's wider than the
          // page content box (e.g. landscape page didn't apply), scale it down so nothing is clipped
          content.querySelectorAll('.doc-flow, .doc-landscape').forEach(function(fl){
            if(fl.style && fl.style.transform) return;
            var fw=fl.scrollWidth || fl.getBoundingClientRect().width;
            if(availW && fw>availW+2){ var sw=Math.max(0.35,(availW/fw)*0.99); fl.style.transformOrigin='top left'; fl.style.transform='scale('+sw.toFixed(3)+')'; window.__pgAdjust.push('Scaled wide content to fit the page width ('+Math.round(sw*100)+'%)'); }
          });
          Array.prototype.slice.call(content.children).forEach(function(el){
            if(el.style && el.style.transform) return; // already scaled (e.g. a flowchart)
            var h=el.getBoundingClientRect().height;
            if(h>avail+2){ var s=Math.max(0.6,(avail/h)*0.97); el.style.transformOrigin='top left'; el.style.transform='scale('+s.toFixed(3)+')'; window.__pgAdjust.push('Shrunk an oversized block to fit ('+Math.round(s*100)+'%)'); }
          });
        }catch(e){}
      }
    };
    Paged.registerHandlers(Doctor);
  })();
<\/script>
</body></html>`);
  win.document.close();
  win.focus();
}

// ── Section image handling ────────────────────────────────────────────────────
let _csLastCursorSec = null;
let _csLastCursorPos = -1;
let _csLayoutTarget  = null; // { card, imgData }

function csTrackCursor(ta) {
  _csLastCursorSec = ta.closest('.cs-sec');
  _csLastCursorPos = ta.selectionStart;
}

// Callout helpers — admin can add a callout to a section without one, or remove an existing one
function csAddCallout(btn) {
  const wrap = btn.closest('.cs-sec-callout-wrap');
  if (!wrap) return;
  // If a callout row already exists (shouldn't, since the Add button hides itself), bail
  if (wrap.querySelector('.cs-sec-callout-row')) return;
  const row = document.createElement('div');
  row.className = 'cs-sec-callout-row';
  row.innerHTML = `<div class="cs-sec-callout" contenteditable="true"></div><button type="button" class="btn btn-danger btn-sm btn-icon cs-callout-del" onclick="csRemoveCallout(this)" title="Remove callout">🗑️</button>`;
  wrap.insertBefore(row, btn);
  btn.style.display = 'none';
  const ed = row.querySelector('.cs-sec-callout');
  // Focus immediately so the admin can start typing
  setTimeout(() => { ed.focus(); }, 0);
}
function csRemoveCallout(btn) {
  const wrap = btn.closest('.cs-sec-callout-wrap');
  const row = btn.closest('.cs-sec-callout-row');
  if (!row || !wrap) return;
  if (!confirm('Remove this callout from the section?')) return;
  row.remove();
  // Restore the "+ Add callout" button so a new one can be added later
  const addBtn = wrap.querySelector('.cs-callout-add');
  if (addBtn) addBtn.style.display = '';
}

function csAddImageClick(btn) {
  const sec = btn.closest('.cs-sec');
  const ta  = sec.querySelector('.cs-sec-b');
  _csLastCursorSec = sec;
  _csLastCursorPos = (document.activeElement === ta) ? ta.selectionStart : (_csLastCursorSec === sec ? _csLastCursorPos : ta.value.length);
  sec.querySelector('.cs-img-input').click();
}

function csImageSelected(input) {
  const sec = input.closest('.cs-sec');
  const files = Array.from(input.files);
  input.value = '';
  if (!files.length) return;
  for (const file of files) {
    const reader = new FileReader();
    reader.onload = function(evt) {
      const base64 = evt.target.result;
      const img = new Image();
      img.onload = function() {
        const uid = Math.random().toString(36).slice(2, 9);
        const marker = `[IMG:${uid}]`;

        // Insert marker at cursor position in the textarea
        const ta  = sec.querySelector('.cs-sec-b');
        const pos = (_csLastCursorSec === sec && _csLastCursorPos >= 0) ? _csLastCursorPos : ta.value.length;
        ta.value  = ta.value.slice(0, pos) + marker + ta.value.slice(pos);
        _csLastCursorPos = pos + marker.length;

        // Default layout — up to 6 inches wide, maintaining natural aspect ratio
        const natW = img.naturalWidth || 300;
        const natH = img.naturalHeight || 200;
        const docW = Math.min(6, Math.max(1, parseFloat((natW / 96).toFixed(2))));
        const docH = parseFloat((docW * natH / natW).toFixed(2));

        const imgData = {
          uid, base64, mimeType: file.type, filename: file.name,
          width: natW, height: natH, caption: '',
          layout: {
            wrapping: 'inline', hAlign: 'left',
            hType: 'align', hAbsolute: 0,
            vType: 'align', vAbsolute: 0,
            docWidth: docW, docHeight: docH, lockAspect: true,
            distTop: 0, distBottom: 0, distLeft: 0.13, distRight: 0.13
          }
        };

        const card = document.createElement('div');
        card.className = 'cs-img-card';
        card.dataset.uid = uid;
        card.innerHTML = `<div class="cs-img-card-wrap">
          <img src="${base64}" class="cs-img-card-thumb" alt="">
          <div class="cs-img-card-actions">
            <button class="btn btn-ghost btn-xs" onclick="csImgMenu('${uid}', this)" title="Image options (keep / enhance / regenerate / replace / remove)">🖼</button>
            <button class="btn btn-ghost btn-xs" onclick="csOpenImageLayout('${uid}')" title="Layout options">⚙️</button>
            <button class="btn btn-ghost btn-xs" onclick="csOpenImageCallouts('${uid}')" title="Add numbered callouts to this image">🏷</button>
            <button class="btn btn-danger btn-xs btn-icon cs-img-card-del" onclick="csRemoveSectionImage(this,'${uid}')" title="Remove">✕</button>
          </div>
        </div>
        <input class="cs-img-name-in" placeholder="Caption" value="">
        <div class="cs-img-layout-badge" data-uid="${uid}">Inline · ${docW}"×${docH}"</div>
        <div class="cs-img-cal-badge" data-uid="${uid}"></div>`;

        sec.querySelector('.cs-img-gallery').append(card);
        _csCardImages.set(card, imgData);
        card.querySelector('.cs-img-name-in').addEventListener('input', function() {
          imgData.caption = this.value.trim();
        });
      };
      img.src = base64;
    };
    reader.readAsDataURL(file);
  }
}

function csRemoveSectionImage(btn, uid) {
  const card = btn.closest('.cs-img-card');
  const sec  = card.closest('.cs-sec');
  const ta   = sec.querySelector('.cs-sec-b');
  if (uid) ta.value = ta.value.replace(`[IMG:${uid}]`, '');
  card.remove();
}

// ── §14 — per-image control menu (Keep / Enhance / Regenerate / Create new / Replace / Remove) ──
let _csImgMenuEl = null;
function csCloseImgMenu() { if (_csImgMenuEl) { _csImgMenuEl.remove(); _csImgMenuEl = null; document.removeEventListener('click', _csImgMenuOutside, true); } }
function _csImgMenuOutside(e) { if (_csImgMenuEl && !_csImgMenuEl.contains(e.target)) csCloseImgMenu(); }
function csImgMenu(uid, btn) {
  if (_csImgMenuEl) { csCloseImgMenu(); return; }
  const items = [
    ['✓ Keep original', `csImgKeep('${uid}')`, 'Default — keep the uploaded image exactly as-is'],
    ['✨ Enhance with AI…', `csImgAi('${uid}','enhance')`, 'Generate a cleaner, clearer version via the AI image generator'],
    ['🔁 Regenerate similar…', `csImgAi('${uid}','similar')`, 'Generate a new image in a similar style via the AI generator'],
    ['🎨 Create new image…', `csImgAi('${uid}','new')`, 'Open the AI image generator for this page'],
    ['📤 Replace with upload…', `csImgReplace('${uid}')`, 'Swap in a picture from your computer'],
    ['🗑 Remove', `csImgRemoveByUid('${uid}')`, 'Remove this image from the document'],
  ];
  const m = document.createElement('div');
  m.className = 'cs-img-menu';
  m.innerHTML = items.map(([label, fn, title]) => `<button type="button" title="${esc(title)}" onclick="csCloseImgMenu();${fn}">${label}</button>`).join('');
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect();
  m.style.top = (r.bottom + 4 + window.scrollY) + 'px';
  m.style.left = Math.max(8, r.left + window.scrollX - 40) + 'px';
  _csImgMenuEl = m;
  setTimeout(() => document.addEventListener('click', _csImgMenuOutside, true), 0);
}
function _csImgCard(uid) { return document.querySelector(`.cs-img-card[data-uid="${uid}"]`); }
function csImgKeep(uid) { toast('Kept the original image.'); }
function csImgRemoveByUid(uid) {
  const card = _csImgCard(uid); if (!card) return;
  const del = card.querySelector('.cs-img-card-del');
  if (del) del.click(); else { const sec = card.closest('.cs-sec'); const ta = sec && sec.querySelector('.cs-sec-b'); if (ta && uid) ta.value = ta.value.replace(`[IMG:${uid}]`, ''); card.remove(); }
}
// Enhance / Regenerate similar / Create new all open the AI image generator (the real capability).
// The mode seeds the generator's intent; after generating you can remove the original to replace it.
function csImgAi(uid, mode) {
  const card = _csImgCard(uid); if (!card) return;
  const note = mode === 'enhance' ? 'Generating a cleaner version — remove the original after if you want to replace it.'
    : mode === 'similar' ? 'Generating a similar image — remove the original after if you want to replace it.'
    : 'Opening the AI image generator for this page.';
  toast(note);
  _csImgAiIntent = mode; // read by the generator to bias the prompt (see §16)
  csImageGenOpen(card); // card is inside the section; the generator reads the page content
}
let _csImgAiIntent = null;
// Replace this image's pixels with an uploaded file (keeps its position, layout and callouts).
function csImgReplace(uid) {
  const card = _csImgCard(uid); if (!card) return;
  const im = _csCardImages.get(card) || (typeof _csPendingImages !== 'undefined' ? _csPendingImages[uid] : null);
  if (!im) return toast('Could not find the image to replace.', 'error');
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp,image/gif';
  inp.onchange = () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const probe = new Image();
      probe.onload = () => {
        im.base64 = dataUrl; im.data = dataUrl; im.mimeType = f.type;
        im.width = probe.naturalWidth; im.height = probe.naturalHeight;
        // A replaced picture invalidates any baked callouts/annotation.
        im.annotated = ''; im.annotatedTr = '';
        const thumb = card.querySelector('.cs-img-card-thumb'); if (thumb) thumb.src = dataUrl;
        toast('Image replaced.');
      };
      probe.src = dataUrl;
    };
    reader.readAsDataURL(f);
  };
  inp.click();
}

// ── Image Layout Modal ────────────────────────────────────────────────────────
const WRAP_LABELS = { inline:'Inline', square:'Square', tight:'Tight', through:'Through', topBottom:'Top & Bottom', behind:'Behind text', inFront:'In front' };

function csOpenImageLayout(uid) {
  const card = document.querySelector(`.cs-img-card[data-uid="${uid}"]`);
  if (!card) return;
  const imgData = _csCardImages.get(card);
  if (!imgData) return;
  _csLayoutTarget = { card, imgData };
  const L = imgData.layout || {};

  // Wrapping tab
  document.querySelectorAll('.img-wrap-opt').forEach(el => el.classList.toggle('active', el.dataset.wrap === (L.wrapping || 'inline')));
  // Show/hide align row based on wrapping
  _imgUpdateWrapUI(L.wrapping || 'inline');
  // Alignment
  const hAlignVal = L.hAlign || 'left';
  document.querySelectorAll('[name="img-h-align"]').forEach(r => { r.checked = (r.value === hAlignVal); });

  // Position tab
  const hType = L.hType || 'align';
  const vType = L.vType || 'align';
  document.querySelector(`[name="img-htype"][value="${hType}"]`).checked = true;
  document.querySelector(`[name="img-vtype"][value="${vType}"]`).checked = true;
  document.getElementById('img-pos-h-align').value = L.hAlign || 'left';
  document.getElementById('img-pos-h-abs').value   = L.hAbsolute || 0;
  document.getElementById('img-pos-v-align').value = L.vAlign || 'top';
  document.getElementById('img-pos-v-abs').value   = L.vAbsolute || 0;
  imgPosTypeChange('h'); imgPosTypeChange('v');

  // Size tab
  document.getElementById('img-size-w').value    = L.docWidth  || 3;
  document.getElementById('img-size-h').value    = L.docHeight || 2;
  document.getElementById('img-size-lock').checked = L.lockAspect !== false;
  // Original size
  const origW = imgData.width  ? (imgData.width  / 96).toFixed(2) : '—';
  const origH = imgData.height ? (imgData.height / 96).toFixed(2) : '—';
  document.getElementById('img-orig-w').textContent = origW !== '—' ? origW + '"' : '—';
  document.getElementById('img-orig-h').textContent = origH !== '—' ? origH + '"' : '—';

  // Reset to first tab
  imgLayoutTab(document.querySelector('.img-lt-tab[data-tab="wrap"]'));
  showModal('img-layout-modal');
}

function csApplyImageLayout() {
  if (!_csLayoutTarget) return;
  const { card, imgData } = _csLayoutTarget;
  const wrapping = (document.querySelector('.img-wrap-opt.active') || {}).dataset?.wrap || 'inline';
  const hAlign   = (document.querySelector('[name="img-h-align"]:checked') || {}).value || 'left';
  const hType    = (document.querySelector('[name="img-htype"]:checked')   || {}).value || 'align';
  const vType    = (document.querySelector('[name="img-vtype"]:checked')   || {}).value || 'align';
  const docW     = parseFloat(document.getElementById('img-size-w').value)  || 3;
  const docH     = parseFloat(document.getElementById('img-size-h').value)  || 2;

  imgData.layout = {
    wrapping, hAlign, hType,
    hAbsolute: parseFloat(document.getElementById('img-pos-h-abs').value) || 0,
    vType,
    vAlign:    document.getElementById('img-pos-v-align').value || 'top',
    vAbsolute: parseFloat(document.getElementById('img-pos-v-abs').value) || 0,
    docWidth: docW, docHeight: docH,
    lockAspect: document.getElementById('img-size-lock').checked,
    distTop: 0, distBottom: 0, distLeft: 0.13, distRight: 0.13
  };

  const badge = card.querySelector('.cs-img-layout-badge');
  if (badge) badge.textContent = `${WRAP_LABELS[wrapping] || wrapping} · ${docW}"×${docH}"`;
  closeModal('img-layout-modal');
}

function imgLayoutTab(btn) {
  document.querySelectorAll('.img-lt-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.img-lt-panel').forEach(p => p.style.display = 'none');
  btn.classList.add('active');
  document.getElementById('img-tab-' + btn.dataset.tab).style.display = '';
}

function imgSelectWrap(btn) {
  document.querySelectorAll('.img-wrap-opt').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _imgUpdateWrapUI(btn.dataset.wrap);
}

function _imgUpdateWrapUI(wrap) {
  const showAlign = (wrap !== 'inline');
  document.getElementById('img-wrap-align-row').style.display = showAlign ? '' : 'none';
  // Disable position tab for inline
  const posTab = document.querySelector('.img-lt-tab[data-tab="pos"]');
  if (posTab) { posTab.disabled = (wrap === 'inline'); posTab.style.opacity = wrap === 'inline' ? '0.4' : '1'; }
}

function imgPosTypeChange(axis) {
  const v = (document.querySelector(`[name="img-${axis}type"]:checked`) || {}).value || 'align';
  if (axis === 'h') {
    document.getElementById('img-pos-h-align').closest('.img-pos-row').style.display = v === 'align'    ? '' : 'none';
    document.getElementById('img-h-abs-row').style.display                           = v === 'absolute' ? '' : 'none';
  } else {
    document.getElementById('img-pos-v-align').closest('.img-pos-row').style.display = v === 'align'    ? '' : 'none';
    document.getElementById('img-v-abs-row').style.display                           = v === 'absolute' ? '' : 'none';
  }
}

function imgSizeChange(changed) {
  if (!document.getElementById('img-size-lock').checked) return;
  if (!_csLayoutTarget) return;
  const { imgData } = _csLayoutTarget;
  const natW = imgData.width || 0, natH = imgData.height || 0;
  if (!natW || !natH) return;
  if (changed === 'w') {
    const w = parseFloat(document.getElementById('img-size-w').value) || 0;
    document.getElementById('img-size-h').value = (w * natH / natW).toFixed(2);
  } else {
    const h = parseFloat(document.getElementById('img-size-h').value) || 0;
    document.getElementById('img-size-w').value = (h * natW / natH).toFixed(2);
  }
}

function renderContentPreview(type, d) {
  let body = '';
  if (type === 'exam') {
    body = `<div class="cs-row"><label>Exam name</label><input id="cs-exam-name" value="${esc(d.testName||'Exam')}">
        <label>Pass %</label><input id="cs-exam-pass" type="number" style="max-width:90px" value="${d.passScore||80}"></div>
      <div id="cs-exam-qs">${(d.questions||[]).map((q,i)=>csExamQHtml(q,i)).join('')}</div>
      <button class="btn btn-outline btn-sm" onclick="csAddExamQ()">+ Add Question</button>`;
  } else if (type === 'excel-form' && (d.layout === 'register' || Array.isArray(d.columns))) {
    // Register / tracker spreadsheet: each row below is a COLUMN in the table.
    const cols = Array.isArray(d.columns) ? d.columns
      : (d.fields || []).filter(f => f && f.type !== 'section').map(f => ({ label: f.label, options: f.options }));
    const prevCols = cols.slice(0, 8);
    const previewTable = `<table class="cs-reg-prev"><thead><tr>${prevCols.map(c=>`<th>${esc(c.label||'')}</th>`).join('')}${cols.length>8?'<th>…</th>':''}</tr></thead>`
      + `<tbody>${[0,1,2].map(()=>`<tr>${prevCols.map(()=>'<td></td>').join('')}${cols.length>8?'<td></td>':''}</tr>`).join('')}</tbody></table>`;
    body = `<div class="cs-row"><label>Register name</label><input id="cs-form-name" value="${esc(d.name||'Register')}"></div>
      <div class="cs-row"><label>Blank rows to provide</label><input id="cs-reg-rows" type="number" min="5" max="200" value="${parseInt(d.rowsToProvide,10)||25}" style="max-width:100px"></div>
      <input type="hidden" id="cs-reg-mode" value="1">
      <input type="hidden" id="cs-reg-desc" value="${esc(d.description||'')}">
      <div class="cs-reg-hint">📊 This is a <b>register</b> — each row below is a <b>column</b> in the spreadsheet. Add comma-separated options for dropdown columns.</div>
      <label class="cs-opt-check" title="Adds a second 'Dashboard' tab with live COUNTIF/COUNTA totals and data bars that update automatically as you type entries into the register"><input type="checkbox" id="cs-reg-dashboard" ${d.dashboard?'checked':''}> 📈 Build a live Dashboard tab (auto-updating totals &amp; breakdowns by dropdown column)</label>
      <div class="cs-reg-hint" style="font-size:11px;opacity:.8">Note: Excel macros (VBA) and multi-user live sharing aren't part of a generated file — the dashboard uses built-in formulas that recalculate the moment data is entered. For shared live editing, save the file to OneDrive/SharePoint.</div>
      <div class="cs-reg-preview">${previewTable}</div>
      <div id="cs-form-fields">${cols.map(csRegColHtml).join('')}</div>
      <button class="btn btn-outline btn-sm" onclick="csAddRegCol()">+ Add Column</button>`;
  } else if (type === 'form' || type === 'training-request' || type === 'record-form' || type === 'excel-form') {
    const riskBlock = (type === 'record-form' && d.includeRiskMatrix)
      ? `<div class="rf-matrix-preview"><div class="cs-map-h">🔢 Risk Assessment Matrix <span class="text-soft" style="font-weight:400">(included in the HTML export)</span></div>${csAkaraMatrixHtml()}</div>`
      : '';
    const submitRow = (type === 'record-form')
      ? `<div class="cs-row"><label>Submit to (email) <span class="text-soft" style="font-weight:400">— adds a ✅ Submit button to the HTML form that emails the completed form here</span></label>
           <input id="cs-rf-submit-email" type="email" value="${esc(d.submitEmail||'')}" placeholder="e.g. hse@akararesources.com"></div>
         <label class="cs-opt-check" title="Print / export the form on a wide landscape page instead of portrait"><input type="checkbox" id="cs-rf-landscape" ${d.orientation==='landscape'?'checked':''}> 🔄 Landscape page (default is portrait)</label>`
      : '';
    body = `<div class="cs-row"><label>Form name</label><input id="cs-form-name" value="${esc(d.name||'Form')}"></div>
      ${submitRow}
      <div id="cs-form-fields">${(d.fields||[]).map(csFormFieldHtml).join('')}</div>
      <div class="flex gap-2 mt-1">
        <button class="btn btn-outline btn-sm" onclick="csAddFormField()">+ Add Field</button>
        <button class="btn btn-accent btn-sm" id="cs-form-assist-btn" onclick="csFormAssist()" title="Describe what this form should capture and the AI adds the fields for you">✨ AI assist — build fields from context</button>
      </div>${riskBlock}`;
  } else {
    const dm = (d.meta || {});
    _csTransLayout = d.transLayout || 'below';  // restore saved translation position
    _csTransSideOrder = d.transSideOrder || 'en-first';  // restore saved side column order
    const hasTranslation = (d.sections||[]).some(s => s.translation && s.translation.lang);
    const transLangLabel = hasTranslation
      ? (((d.sections||[]).find(s => s.translation && s.translation.lang)||{}).translation||{}).lang || 'Translation'
      : '';
    const transStatus    = dm.transReviewStatus || 'Under Review';
    const isApproved     = (dm.status || '') === 'Approved';
    const showTransRow   = hasTranslation && !isApproved;
    body = `<div class="cs-row-2">
        <div class="cs-row-item"><label>Title</label><input id="cs-doc-title" value="${esc(d.title||'Document')}"></div>
        <div class="cs-row-item cs-row-narrow"><label>Save as filename <span class="cell-sub">(no extension)</span></label><input id="cs-doc-filename" value="${esc(d.fileName||d.title||'Document')}" placeholder="e.g. SOP-MINE-001 Haul Truck Pre-start"></div>
      </div>
      ${type==='form-doc' ? '' : `<details class="cs-meta-block" open>
        <summary class="cs-meta-summary">📋 Document Metadata <span class="cs-meta-hint">click to collapse</span></summary>
        <div class="cs-meta-grid">
          <div class="cs-meta-row"><label>Doc Number</label><input id="cs-doc-number" value="${esc(d.docNumber||'')}" placeholder="e.g. SOP-MINE-001"></div>
          <div class="cs-meta-row"><label>Version</label><input id="cs-meta-version" value="${esc(dm.version||'1.0')}" placeholder="1.0"></div>
          <div class="cs-meta-row"><label>Status</label><select id="cs-meta-status" onchange="csOnDocStatusChange(this)">
            <option value="Draft"${(!dm.status||dm.status==='Draft')?' selected':''}>Draft</option>
            <option value="Under Review"${dm.status==='Under Review'?' selected':''}>Under Review</option>
            <option value="Approved"${dm.status==='Approved'?' selected':''}>Approved ✓</option>
          </select></div>
          ${hasTranslation ? `<div class="cs-meta-row cs-trans-status-row" id="cs-trans-status-row"${showTransRow?'':' style="display:none"'}>
            <label>🌐 ${esc(transLangLabel)} Translation</label>
            <div class="cs-trs-toggle">
              <button type="button" class="cs-trs-btn${transStatus!=='Complete'?' active':''}" onclick="csSetTransStatus('Under Review')">🔄 Under Review</button>
              <button type="button" class="cs-trs-btn${transStatus==='Complete'?' active':''}" onclick="csSetTransStatus('Complete')">✅ Complete</button>
            </div>
            <input type="hidden" id="cs-meta-trans-status" value="${esc(transStatus)}">
          </div>` : ''}
          <div class="cs-meta-row"><label>Prepared By</label><input id="cs-meta-prepared-by" value="${esc(dm.preparedBy||'')}" placeholder="Name / Role"></div>
          <div class="cs-meta-row"><label>Reviewed By</label><input id="cs-meta-reviewed-by" value="${esc(dm.reviewedBy||'')}" placeholder="Name / Role"></div>
          <div class="cs-meta-row"><label>Approved By</label><input id="cs-meta-approved-by" value="${esc(dm.approvedBy||'')}" placeholder="Name / Role"></div>
        </div>
        ${type==='training-manual' ? `<div class="cs-tm-opts">
          <label class="cs-opt-check"><input type="checkbox" id="cs-opt-toc" ${d.includeToc!==false?'checked':''}> 📑 Include a Table of Contents page</label>
          <label class="cs-opt-check"><input type="checkbox" id="cs-opt-safety" ${d.includeSafetyPrompts!==false?'checked':''}> ⚠️ Include the Safety Prompts legend page</label>
        </div>` : ''}
      </details>`}
      ${type==='form-doc' && d.exactHtml ? `<div class="cs-exact-wrap">
        <div class="cs-exact-head">
          <div><strong>📄 Exact copy — editable</strong> <span class="cell-sub">— click a cell to type/replace text; use the ✏️ Edit layout bar to insert fields, add/move/delete rows. Your edits are kept when you <b>Download as HTML (fillable)</b>.</span></div>
          <button class="btn btn-outline btn-sm" id="cs-exact-refresh" onclick="csRefreshFormPreview()">🔄 Update preview</button>
        </div>
        <iframe class="cs-exact-doc" id="cs-exact-doc" srcdoc="${esc(d.exactHtml||'')}" style="width:100%;height:640px;border:1px solid #D7DAE3;border-radius:6px;background:#fff"></iframe>
      </div>
      <details class="cs-formedit-block"><summary class="cs-meta-summary">✏️ Edit text &amp; translate <span class="cs-meta-hint">click to expand — changes appear in the copy above after “Update preview” and are applied on save</span></summary>` : ''}
      ${(currentUser && currentUser.admin) ? `<div class="cs-trans-bar">
        <span class="cs-trans-label">🌐 Translate</span>
        <select id="cs-trans-lang"><option value="">— select language —</option>
          ${[['Spanish','Español'],['French','Français'],['Portuguese','Português'],['Mandarin Chinese','中文'],
             ['Arabic','العربية'],['Indonesian','Bahasa Indonesia'],['Malay','Bahasa Melayu'],['Thai','ภาษาไทย'],
             ['Vietnamese','Tiếng Việt'],['Tagalog','Filipino'],['Hindi','हिंदी'],['Japanese','日本語'],
             ['Korean','한국어'],['German','Deutsch'],['Italian','Italiano'],['Russian','Русский'],
             ['Polish','Polski'],['Afrikaans','Afrikaans'],['Zulu','isiZulu'],['Swahili','Kiswahili']]
            .map(([v,l])=>`<option value="${v}">${v} — ${l}</option>`).join('')}
        </select>
        <div class="cs-trans-layout">
          <button class="btn btn-sm${_csTransLayout==='above'?' active':''}" id="cs-tbl-above" onclick="csSetTransLayout('above')">⬆ Above</button>
          <button class="btn btn-sm${_csTransLayout==='below'?' active':''}" id="cs-tbl-below" onclick="csSetTransLayout('below')">⬇ Below</button>
          <button class="btn btn-sm${_csTransLayout==='side'?' active':''}" id="cs-tbl-side" onclick="csSetTransLayout('side')">⇔ Side</button>
          <span class="cs-trans-order" id="cs-trans-order" style="display:${_csTransLayout==='side'?'inline-flex':'none'};gap:4px;margin-left:6px">
            <span class="cell-sub" style="align-self:center">order:</span>
            <button class="btn btn-sm${_csTransSideOrder==='en-first'?' active':''}" id="cs-ord-en" onclick="csSetTransSideOrder('en-first')">English first</button>
            <button class="btn btn-sm${_csTransSideOrder==='lang-first'?' active':''}" id="cs-ord-lang" onclick="csSetTransSideOrder('lang-first')">Translation first</button>
          </span>
        </div>
        <button class="btn btn-accent btn-sm" id="cs-trans-all-btn" onclick="csTranslateAll()">🌐 Translate All</button>
      </div>` : ''}
      <div id="cs-doc-secs">${(d.sections||[]).map(s=>csDocSecHtml(s)).join('')}</div>
      <button class="btn btn-outline btn-sm" onclick="csAddDocSec()">+ Add Section</button>
      <button class="btn btn-outline btn-sm" onclick="csAddDocPage()" title="Add a new page (starts on its own page) — for extra content or a flow chart">📄 Add Page</button>
      ${type==='form-doc' && d.exactHtml ? '</details>' : ''}`;
  }
  const isDoc = !['exam','form','training-request','record-form','excel-form'].includes(type);
  return `<div class="card cs-preview"><div class="card-header"><h3>✏️ Preview — edit anything, then save</h3>
      <div class="flex gap-2">
        <button class="btn btn-success" id="cs-save-btn" onclick="saveContent()">${csDraft && csDraft.tsFileId ? '💾 Update Document' : '✅ Save to ' + (type==='exam'?'Exam Builder':type==='form-doc'||type==='excel-form'?'Template Forms':['form','training-request','record-form'].includes(type)?'Form Builder':['training-standards','policy','standard','plan','management-plan','strategy-plan','checklist'].includes(type)?'Training Standards':'Document Library')}</button>
        ${isDoc?`<button class="btn btn-outline" id="cs-savedraft-btn" onclick="saveDraft()" title="Save your progress now and keep editing — the document doesn't have to be finished. Resume later from the Document Library (📝 Edit).">💾 Save progress</button>`:''}
        ${isDoc?`<button class="btn btn-outline btn-sm" onclick="previewDocument()">👁 Preview</button>`:''}
        ${type==='record-form'?`<button class="btn btn-outline btn-sm" onclick="csExportRecordHtml()" title="Download this record form as an HTML file">⬇ Export as HTML</button>`:''}
        ${type==='excel-form'?`<button class="btn btn-outline btn-sm" onclick="csExportExcel()" title="Download this form as an Excel .xlsx file">⬇ Export as Excel</button>`:''}
        ${type==='form-doc'?`<button class="btn btn-outline btn-sm" onclick="csExportFormDocHtml()" title="Download as a fillable HTML form — type into the fields, tick the boxes, expand the comment boxes, then print or save as PDF">⬇ Download as HTML (fillable)</button>
        <button class="btn btn-outline btn-sm" onclick="csExportFormDocDocx()" title="Download the exact, re-branded copy as a Word .docx document">⬇ Download as Word</button>
        <button class="btn btn-accent btn-sm" onclick="csSmartForm('html')" title="AI reads and understands the form, then rebuilds it CLEAN — one tick box per logical item, proper fields and tables, no blank cells. Downloads a tidy fillable HTML form.">⚡ AI Smart Rebuild (HTML)</button>
        <button class="btn btn-accent btn-sm" onclick="csSmartForm('docx')" title="AI rebuilds the form clean and downloads it as a Word .docx">⚡ AI Smart Rebuild (Word)</button>`:''}
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('cs-result').innerHTML='';csDraft=null">Discard</button>
      </div></div>
      ${(isDoc && csDraft && csDraft.tsFileId) ? `<div class="cs-gov-bar" id="cs-gov-bar"><span class="cs-gov-loading">Loading governance…</span></div>` : ''}
      ${(isDoc && type!=='form-doc' && !(csDraft && csDraft.tsFileId)) ? csDestHtml(type) : ''}
      <div class="card-body">${body}</div></div>`;
}

// Save-destination picker (document types only): Document Library | Training Standards | Training Material(+folder)
let _csTrainMatCats = [];
function csDestHtml(type){
  const tsDefault = ['training-standards','policy','standard','plan','management-plan','strategy-plan','checklist'].includes(type);
  const opts = [['library','📁 Document Library'],['training-standards','📐 Training Standards'],['training-material','🗂️ Training Material']];
  const sel = tsDefault ? 'training-standards' : 'library';
  return `<div class="cs-dest-bar">
    <label class="cs-dest-lbl">Save destination</label>
    <select id="cs-dest" onchange="csDestChange()">${opts.map(([v,l])=>`<option value="${v}" ${v===sel?'selected':''}>${l}</option>`).join('')}</select>
    <span id="cs-dest-cat-wrap" style="display:none">
      <label class="cs-dest-lbl">Folder</label>
      <select id="cs-dest-cat">${_csTrainMatCats.map(c=>`<option value="${esc(c.Name)}">${esc(c.Name)}</option>`).join('')}</select>
      <button type="button" class="btn btn-ghost btn-sm" onclick="csDestAddCat()">+ New folder</button>
    </span>
  </div>`;
}
function csDestChange(){
  const wrap = document.getElementById('cs-dest-cat-wrap');
  if (wrap) wrap.style.display = (val('cs-dest') === 'training-material') ? 'inline-flex' : 'none';
}
async function csDestAddCat(){
  const name = (prompt('New Training Material folder (e.g. CAT793, Dozer Training Material):') || '').trim();
  if (!name) return;
  const r = await POST('/api/content/trainmat-cats', { name });
  if (!ok(r)) return;
  _csTrainMatCats = r.cats || _csTrainMatCats;
  const sel = document.getElementById('cs-dest-cat');
  if (sel) { sel.innerHTML = _csTrainMatCats.map(c=>`<option value="${esc(c.Name)}">${esc(c.Name)}</option>`).join(''); sel.value = name; }
}
function csOptHtml(o){ o=o||{}; return `<label class="cs-opt"><input type="checkbox" class="cs-opt-c" ${o.correct?'checked':''}><input class="cs-opt-t" value="${esc(o.text||'')}" placeholder="Answer option"><button type="button" class="grid-del" onclick="this.closest('.cs-opt').remove()">✕</button></label>`; }
function csExamQHtml(q,i){
  q=q||{};
  return `<div class="cs-q"><div class="cs-q-head"><input class="cs-q-text" value="${esc(q.question||'')}" placeholder="Question text">
    <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="this.closest('.cs-q').remove()" title="Remove question">🗑️</button></div>
    <select class="cs-q-type">${['single','multi','truefalse'].map(t=>`<option ${(/multi/.test(q.type)?'multi':/true/.test(q.type)?'truefalse':'single')===t?'selected':''}>${t}</option>`).join('')}</select>
    <div class="cs-opts">${(q.options||[{},{}]).map(csOptHtml).join('')}</div>
    <button type="button" class="btn btn-ghost btn-sm" onclick="csAddOpt(this)">+ option</button></div>`;
}
function csFormFieldHtml(f){
  f=f||{};
  return `<div class="cs-field"><select class="cs-f-type">${CS_FIELD_TYPES.map(t=>`<option ${f.type===t?'selected':''}>${t}</option>`).join('')}</select>
    <input class="cs-f-label" value="${esc(f.label||'')}" placeholder="Label">
    <input class="cs-f-opts" value="${esc((f.options||[]).join(', '))}" placeholder="options, comma-separated">
    <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="this.closest('.cs-field').remove()" title="Remove field">🗑️</button></div>`;
}
// Conditionally-formatted risk-assessment table (AKARA Risk Rank Matrix banding).
// Mirrors riskBand()/riskTbl() in lib/content.js; used in the section editor and preview.
function csRiskBand(score){
  const n=Number(score);
  if(!isFinite(n)||n<1) return {fill:'#E8EAF0',text:'#1E3A5F',level:''};
  if(n<=5)  return {fill:'#8DC63F',text:'#1A1A1A',level:'Low'};
  if(n<=10) return {fill:'#3C6FC4',text:'#FFFFFF',level:'Moderate'};
  if(n<=17) return {fill:'#FFF200',text:'#1A1A1A',level:'High'};
  return {fill:'#E01B1B',text:'#FFFFFF',level:'Critical'};
}
// True when a table column header names a risk RATING (its 1–25 cells get matrix colours).
function csIsRiskHeader(h){
  const s=String(h||'').toLowerCase().replace(/[^a-z ]/g,' ');
  if(/control|hazard|descrip|manage|matrix|owner|treatment|mitigat|comment|note|action|person|respons|method|step|task|activit/.test(s)) return false;
  return /\brisk\b/.test(s)||/\brr\b/.test(s);
}
// Inline style attribute for a risk-number cell (empty string when not a 1–25 score in a risk column).
function csRiskCellStyle(val, isRiskCol){
  if(!isRiskCol) return '';
  const m=String(val).trim().match(/^(\d{1,2})$/);
  if(!m) return '';
  const n=parseInt(m[1],10);
  if(n<1||n>25) return '';
  const b=csRiskBand(n);
  return ` style="background:${b.fill};color:${b.text};font-weight:700;text-align:center"`;
}
// The fixed AKARA Risk Rank Matrix as a colour-coded HTML table (preview; mirrors the server export).
function csAkaraMatrixHtml(){
  const likelihood=[['A','Almost Certain'],['B','Likely'],['C','Possible'],['D','Unlikely'],['E','Rare']];
  const conseq=['1 - Insignificant','2 - Minor','3 - Moderate','4 - Major','5 - Catastrophic'];
  const grid=[[11,16,20,23,25],[7,12,17,21,24],[4,8,13,18,22],[2,5,9,14,19],[1,3,6,10,15]];
  let h='<table class="akara-matrix"><thead><tr><th class="mx-title" colspan="6">AKARA RISK RANK MATRIX</th></tr><tr><th>Likelihood</th>'+conseq.map(c=>`<th>${esc(c)}</th>`).join('')+'</tr></thead><tbody>';
  grid.forEach((row,i)=>{ h+=`<tr><th class="mx-row">${likelihood[i][0]} - ${esc(likelihood[i][1])}</th>`+row.map(n=>{const b=csRiskBand(n);return `<td style="background:${b.fill};color:${b.text};text-align:center;font-weight:700">${n}</td>`;}).join('')+'</tr>'; });
  h+='</tbody></table>';
  const legend=[['1–5','#8DC63F','Low'],['6–10','#3C6FC4','Moderate'],['11–17','#FFF200','High'],['18–25','#E01B1B','Critical']];
  h+='<div class="mx-legend">'+legend.map(([r,c,l])=>`<span class="mx-leg"><span class="mx-sw" style="background:${c}"></span>${r} ${l}</span>`).join('')+'</div>';
  return h;
}
function csRiskPreviewHtml(risk){
  const LIKE={A:'Almost Certain',B:'Likely',C:'Possible',D:'Unlikely',E:'Rare'};
  const CONSEQ={1:'Insignificant',2:'Minor',3:'Moderate',4:'Major',5:'Catastrophic'};
  const arr=Array.isArray(risk)?risk:(risk?[risk]:[]);
  const rows=arr.map(r=>{
    if(!r||typeof r!=='object') return null;
    const score=Number(r.score!=null?r.score:r.initial);
    const residual=(r.residual!=null&&r.residual!=='')?Number(r.residual):null;
    if(!isFinite(score)&&!isFinite(residual)) return null;
    return {hazard:r.hazard||'',likelihood:r.likelihood?String(r.likelihood).trim().toUpperCase().slice(0,1):'',
      consequence:(r.consequence!=null&&r.consequence!=='')?Number(r.consequence):null,
      score:isFinite(score)?score:null,residual:isFinite(residual)?residual:null};
  }).filter(Boolean);
  if(!rows.length) return '';
  const showHazard=rows.some(x=>x.hazard),showLike=rows.some(x=>x.likelihood),
        showConseq=rows.some(x=>isFinite(x.consequence)),showRes=rows.some(x=>isFinite(x.residual));
  const cols=[...(showHazard?[{k:'hazard',l:'Hazard'}]:[]),...(showLike?[{k:'likelihood',l:'Likelihood'}]:[]),
    ...(showConseq?[{k:'consequence',l:'Consequence'}]:[]),{k:'score',l:'Risk Rating'},...(showRes?[{k:'residual',l:'Residual Risk'}]:[])];
  const cell=(c,x)=>{
    if(c.k==='score'||c.k==='residual'){
      const v=c.k==='score'?x.score:x.residual;
      if(!isFinite(v)) return `<td class="doc-risk-score" style="text-align:center">—</td>`;
      const b=csRiskBand(v);
      return `<td class="doc-risk-score" style="background:${b.fill};color:${b.text}"><span class="doc-risk-num">${v}</span><span class="doc-risk-lvl">${b.level}</span></td>`;
    }
    let t='';
    if(c.k==='hazard') t=x.hazard;
    else if(c.k==='likelihood') t=x.likelihood?`${x.likelihood}${LIKE[x.likelihood]?' – '+LIKE[x.likelihood]:''}`:'';
    else if(c.k==='consequence') t=isFinite(x.consequence)?`${x.consequence}${CONSEQ[x.consequence]?' – '+CONSEQ[x.consequence]:''}`:'';
    return `<td${c.k==='hazard'?'':' style="text-align:center"'}>${esc(t)}</td>`;
  };
  let h=`<table class="doc-risk-tbl"><thead><tr><th colspan="${cols.length}" class="doc-risk-title">Risk Assessment</th></tr><tr>${cols.map(c=>`<th>${esc(c.l)}</th>`).join('')}</tr></thead><tbody>`;
  for(const x of rows) h+=`<tr>${cols.map(c=>cell(c,x)).join('')}</tr>`;
  return h+`</tbody></table>`;
}
function csDocSecHtml(s){
  s=s||{};
  const extra = esc(JSON.stringify({ level: s.level||1, table: s.table||null, checklist: s.checklist||null, callout: s.callout||null, flowchart: s.flowchart||null, landscape: !!s.landscape, pageBreak: !!s.pageBreak, risk: s.risk||null }));
  const lvlCls = s.level===2?'cs-sec-lvl2':s.level===3?'cs-sec-lvl3':'';
  const pgCls = s.pageBreak ? ' cs-sec--pagebreak' : '';
  const isAdmin = currentUser && currentUser.admin;
  const ce = isAdmin ? ' contenteditable="true"' : '';
  let extras='';
  if(s.table && s.table.headers){
    // Table cells track focus so the row/column tools act relative to the clicked cell.
    const tce = isAdmin ? ' contenteditable="true" onfocus="csTblFocus(this)"' : '';
    const riskCols = s.table.headers.map(csIsRiskHeader);
    const hdrs=s.table.headers.map(h=>`<th${tce}>${esc(h)}</th>`).join('');
    const rows=(s.table.rows||[]).map(r=>`<tr>${(s.table.headers||[]).map((_,i)=>{
      const v=(r||[])[i]||''; return `<td${tce}${csRiskCellStyle(v,riskCols[i])}>${esc(v)}</td>`;
    }).join('')}</tr>`).join('');
    // Admins can edit the table structure — insert/delete rows and columns relative to the
    // cell they last clicked. (Works on every section-based document type.)
    const tblTools = isAdmin ? `<div class="cs-tbl-tools">
        <span class="cs-tbl-grp"><span class="cs-tbl-grp-lbl">Row</span>
          <button type="button" class="btn btn-ghost btn-sm" onclick="csTblRow(this,'above')" title="Insert a row above the selected cell">➕ Above</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="csTblRow(this,'below')" title="Insert a row below the selected cell">➕ Below</button>
          <button type="button" class="btn btn-ghost btn-sm cs-tbl-del" onclick="csTblRowDel(this)" title="Delete the selected row">🗑 Row</button></span>
        <span class="cs-tbl-grp"><span class="cs-tbl-grp-lbl">Column</span>
          <button type="button" class="btn btn-ghost btn-sm" onclick="csTblCol(this,'left')" title="Insert a column to the left of the selected cell">➕ Left</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="csTblCol(this,'right')" title="Insert a column to the right of the selected cell">➕ Right</button>
          <button type="button" class="btn btn-ghost btn-sm cs-tbl-del" onclick="csTblColDel(this)" title="Delete the selected column">🗑 Column</button></span>
        <span class="cs-tbl-hint">Click a cell first, then insert/delete relative to it.</span>
      </div>` : '';
    extras+=`<div class="cs-sec-table"><table class="cs-tbl-preview"><thead><tr>${hdrs}</tr></thead><tbody>${rows}</tbody></table>${tblTools}</div>`;
  }
  if(Array.isArray(s.checklist)&&s.checklist.length){
    extras+=`<div class="cs-sec-checklist">${s.checklist.map(i=>`<span class="cs-cl-item">☐ <span class="cs-cl-text"${ce}>${esc(i)}</span></span>`).join('')}</div>`;
  }
  // Callouts: editable when admin, deletable, and add-able even when the section starts without one.
  // (Schema supports one callout per section; the wrapper makes that one slot fully manageable.)
  extras += `<div class="cs-sec-callout-wrap">`;
  if (s.callout) {
    extras += `<div class="cs-sec-callout-row"><div class="cs-sec-callout"${ce}>${esc(s.callout)}</div>${isAdmin ? `<button type="button" class="btn btn-danger btn-sm btn-icon cs-callout-del" onclick="csRemoveCallout(this)" title="Remove callout">🗑️</button>` : ''}</div>`;
  }
  if (isAdmin) {
    extras += `<button type="button" class="btn btn-ghost btn-sm cs-callout-add" onclick="csAddCallout(this)"${s.callout ? ' style="display:none"' : ''}>➕ Add callout</button>`;
  }
  extras += `</div>`;
  // Read-only preview of the conditionally-formatted risk table (values come from the source).
  if (s.risk && (Array.isArray(s.risk) ? s.risk.length : true)) {
    const rhtml = csRiskPreviewHtml(s.risk);
    if (rhtml) extras += `<div class="cs-sec-risk">${rhtml}</div>`;
  }
  extras += csFlowHtml(s.flowchart, s.landscape);
  const assistBtn = isAdmin ? `<button type="button" class="btn btn-ghost btn-sm cs-sec-assist-btn" onclick="csAssistSection(this)" title="AI: fill blank table cells, add missing content, or change the layout to a table view for this page">✨ AI assist</button>` : '';
  const transBtn = isAdmin ? `<button type="button" class="btn btn-ghost btn-sm cs-sec-trans-btn" onclick="csTranslateSection(this)" title="Translate section">🌐</button>` : '';
  const pgBtn = `<button type="button" class="btn btn-ghost btn-sm cs-sec-pgbrk${s.pageBreak?' active':''}" onclick="csTogglePageBreak(this)" title="Start this section on a new page">📄 New page</button>`;
  const insBtns = `<span class="cs-pg-ins-grp"><button type="button" class="btn btn-ghost btn-sm cs-pg-ins" onclick="csAddPageRelative(this,'above')" title="Insert a new page ABOVE this section">＋📄↑</button><button type="button" class="btn btn-ghost btn-sm cs-pg-ins" onclick="csAddPageRelative(this,'below')" title="Insert a new page BELOW this section">＋📄↓</button></span>`;
  return `<div class="cs-sec ${lvlCls}${pgCls}" data-extra="${extra}">
    <div class="cs-sec-pgbrk-tag">📄 Starts on a new page</div>
    <div class="cs-sec-orig">
      <div class="cs-q-head"><input class="cs-sec-h" value="${esc(s.heading||'')}" placeholder="Heading">
        ${assistBtn}${insBtns}${pgBtn}${transBtn}<button type="button" class="btn btn-danger btn-sm btn-icon" onclick="this.closest('.cs-sec').remove()" title="Remove section">🗑️</button>
      </div>
      <textarea class="cs-sec-b" rows="${s.table||s.checklist?2:4}" placeholder="Body text (click here to position cursor, then click 📷 Add image to insert at cursor)" onclick="csTrackCursor(this)" onkeyup="csTrackCursor(this)">${esc(s.body||'')}</textarea>${extras}
      <div class="cs-sec-img-zone">
        <div class="cs-img-gallery">${(Array.isArray(s.images) ? s.images : (s.image && s.image.base64 ? [s.image] : [])).map(csImageCardHtml).join('')}</div>
        <div class="cs-fc-gallery">${(Array.isArray(s.flows) ? s.flows : []).map(csFlowChartCardHtml).join('')}</div>
        <button type="button" class="cs-img-add-btn" onclick="csAddImageClick(this)">📷 Add image at cursor</button>
        <button type="button" class="cs-img-add-btn cs-fc-add-btn" onclick="csAddFlowChart(this)" title="Insert a decision flow chart at the cursor">🔀 Flow chart at cursor</button>
        <button type="button" class="cs-img-add-btn cs-img-gen-btn" onclick="csImageGenOpen(this)" title="Generate an illustration from this page's content">🖼 Generate image</button>
        <input type="file" class="cs-img-input" accept="image/png,image/jpeg,image/gif,image/webp" multiple style="display:none" onchange="csImageSelected(this)">
      </div>
    </div>
  </div>`;
}
function csAddExamQ(){ document.getElementById('cs-exam-qs').insertAdjacentHTML('beforeend', csExamQHtml({},0)); }
function csAddOpt(btn){ btn.previousElementSibling.insertAdjacentHTML('beforeend', csOptHtml({})); }
function csAddFormField(){ document.getElementById('cs-form-fields').insertAdjacentHTML('beforeend', csFormFieldHtml({type:'text'})); }
// AI assist for the record/form editor: the user gives some context and the AI builds/adds the fields.
async function csFormAssist(){
  const context = prompt('Describe what this form should capture and the AI will add the fields.\n\ne.g. "Equipment pre-start inspection — ID, date, operator, tyre/brake/light checks (Yes/No), defects found, sign-off"');
  if (context === null) return;
  const name = (val('cs-form-name')||'').trim();
  const fields = [...document.querySelectorAll('#cs-form-fields .cs-field')].map(f=>{
    const opts=(f.querySelector('.cs-f-opts').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    return { type:f.querySelector('.cs-f-type').value, label:f.querySelector('.cs-f-label').value, options:opts.length?opts:undefined };
  }).filter(f=>f.label.trim());
  const btn = document.getElementById('cs-form-assist-btn');
  if (btn){ btn.disabled=true; btn.textContent='⏳ Building fields…'; }
  try {
    const r = await POST('/api/content/assist-form', { name, context: context.trim(), fields });
    if (!r || r.error || !Array.isArray(r.fields)) { toast((r&&r.error)||'AI assist failed.', 'error'); return; }
    // Replace the editor's field list with the AI's completed set (preserving the form name + options).
    if (r.name && !name) { const ni=document.getElementById('cs-form-name'); if (ni) ni.value=r.name; }
    const host=document.getElementById('cs-form-fields');
    if (host){ host.innerHTML = r.fields.map(csFormFieldHtml).join(''); }
    toast(`AI added/updated ${r.fields.length} field${r.fields.length===1?'':'s'} — review and edit as needed.`);
  } catch(e){ toast('AI assist failed: '+(e&&e.message?e.message:'error'), 'error'); }
  finally { if (btn){ btn.disabled=false; btn.textContent='✨ AI assist — build fields from context'; } }
}
// A single COLUMN of a register/tracker spreadsheet (label + optional dropdown options).
function csRegColHtml(c){
  c=c||{};
  return `<div class="cs-regcol"><span class="cs-rc-grip">⋮⋮</span>
    <input class="cs-rc-label" value="${esc(c.label||'')}" placeholder="Column heading">
    <input class="cs-rc-opts" value="${esc((c.options||[]).join(', '))}" placeholder="dropdown options, comma-separated (optional)">
    <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="this.closest('.cs-regcol').remove()" title="Remove column">🗑️</button></div>`;
}
function csAddRegCol(){ document.getElementById('cs-form-fields').insertAdjacentHTML('beforeend', csRegColHtml({})); }
// Rebuild an image card from a stored section image (so images attached before saving reappear on edit).
// Because csDocSecHtml returns an HTML string, the full image object is stashed by uid in _csPendingImages
// and re-linked to its live card element by csHydrateImages() once the sections are in the DOM.
let _csPendingImages = {};
function csImageCardHtml(im){
  if (!im) return '';
  // Normalise: stored images may use .base64 or (source-extracted) .data
  if (!im.base64 && im.data) im.base64 = im.data;
  if (!im.uid) im.uid = Math.random().toString(36).slice(2, 9);
  const uid = im.uid, src = im.base64 || '';
  const L = im.layout || {};
  const wrapLbl = (typeof WRAP_LABELS !== 'undefined' && WRAP_LABELS[L.wrapping || 'inline']) || 'Inline';
  const dW = (L.docWidth != null) ? L.docWidth : (im.width ? Math.min(6, Math.max(1, +(im.width / 96).toFixed(2))) : 3);
  const dH = (L.docHeight != null) ? L.docHeight : (im.width && im.height ? +(dW * im.height / im.width).toFixed(2) : 2);
  im.layout = im.layout || { wrapping: 'inline', hAlign: 'left', hType: 'align', vType: 'align', docWidth: dW, docHeight: dH, lockAspect: true, distTop: 0, distBottom: 0, distLeft: 0.13, distRight: 0.13 };
  _csPendingImages[uid] = im;
  const nCal = Array.isArray(im.callouts) ? im.callouts.length : 0;
  return `<div class="cs-img-card" data-uid="${uid}"><div class="cs-img-card-wrap">
      <img src="${src}" class="cs-img-card-thumb" alt="">
      <div class="cs-img-card-actions">
        <button class="btn btn-ghost btn-xs" onclick="csImgMenu('${uid}', this)" title="Image options (keep / enhance / regenerate / replace / remove)">🖼</button>
        <button class="btn btn-ghost btn-xs" onclick="csOpenImageLayout('${uid}')" title="Layout options">⚙️</button>
        <button class="btn btn-ghost btn-xs" onclick="csOpenImageCallouts('${uid}')" title="Add numbered callouts to this image">🏷</button>
        <button class="btn btn-danger btn-xs btn-icon cs-img-card-del" onclick="csRemoveSectionImage(this,'${uid}')" title="Remove">✕</button>
      </div></div>
      <input class="cs-img-name-in" placeholder="Caption" value="${esc(im.caption || '')}">
      <div class="cs-img-layout-badge" data-uid="${uid}">${wrapLbl} · ${dW}"×${dH}"</div>
      <div class="cs-img-cal-badge" data-uid="${uid}">${nCal ? `🏷 ${nCal} callout${nCal > 1 ? 's' : ''}` : ''}</div></div>`;
}
// After the preview HTML is in the DOM, link each rebuilt image card back to its image object so the layout
// editor and Save (collectContentEdits) see it exactly like a freshly-added image.
function csHydrateImages(){
  const host = document.getElementById('cs-doc-secs');
  if (!host) { _csPendingImages = {}; return; }
  host.querySelectorAll('.cs-img-card').forEach(card => {
    const im = _csPendingImages[card.dataset.uid];
    if (!im) return;
    _csCardImages.set(card, im);
    const ni = card.querySelector('.cs-img-name-in');
    if (ni) ni.addEventListener('input', function(){ im.caption = this.value.trim(); });
  });
  _csPendingImages = {};
}
function csAddDocSec(){ document.getElementById('cs-doc-secs').insertAdjacentHTML('beforeend', csDocSecHtml({})); }

// Edit a section's table structure. Cells are contenteditable and remember which one was
// last focused (csTblFocus), so inserts/deletes act relative to it. collectContentEdits reads
// headers/rows straight from the DOM, so every change is saved and exported automatically.
function csTblFocus(cell){ const t = cell.closest('.cs-tbl-preview'); if (t) t._csActiveCell = cell; }
// Build a section's table block (table + admin row/column tools). Mirrors the inline render in csSecHtml
// and is reused by AI assist when it converts a prose section into a table view.
function csTableBlockHtml(table, isAdmin){
  if(!table || !Array.isArray(table.headers) || !table.headers.length) return '';
  const tce = isAdmin ? ' contenteditable="true" onfocus="csTblFocus(this)"' : '';
  const riskCols = table.headers.map(csIsRiskHeader);
  const hdrs = table.headers.map(h=>`<th${tce}>${esc(h)}</th>`).join('');
  const rows = (table.rows||[]).map(r=>`<tr>${table.headers.map((_,i)=>{
    const v=(r||[])[i]||''; return `<td${tce}${csRiskCellStyle(v,riskCols[i])}>${esc(v)}</td>`;
  }).join('')}</tr>`).join('');
  const tblTools = isAdmin ? `<div class="cs-tbl-tools">
        <span class="cs-tbl-grp"><span class="cs-tbl-grp-lbl">Row</span>
          <button type="button" class="btn btn-ghost btn-sm" onclick="csTblRow(this,'above')" title="Insert a row above the selected cell">➕ Above</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="csTblRow(this,'below')" title="Insert a row below the selected cell">➕ Below</button>
          <button type="button" class="btn btn-ghost btn-sm cs-tbl-del" onclick="csTblRowDel(this)" title="Delete the selected row">🗑 Row</button></span>
        <span class="cs-tbl-grp"><span class="cs-tbl-grp-lbl">Column</span>
          <button type="button" class="btn btn-ghost btn-sm" onclick="csTblCol(this,'left')" title="Insert a column to the left of the selected cell">➕ Left</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="csTblCol(this,'right')" title="Insert a column to the right of the selected cell">➕ Right</button>
          <button type="button" class="btn btn-ghost btn-sm cs-tbl-del" onclick="csTblColDel(this)" title="Delete the selected column">🗑 Column</button></span>
        <span class="cs-tbl-hint">Click a cell first, then insert/delete relative to it.</span>
      </div>` : '';
  return `<div class="cs-sec-table"><table class="cs-tbl-preview"><thead><tr>${hdrs}</tr></thead><tbody>${rows}</tbody></table>${tblTools}</div>`;
}
function _csTbl(btn){ return btn.closest('.cs-sec-table')?.querySelector('.cs-tbl-preview'); }
function _csNewCell(tag){ const c = document.createElement(tag); c.contentEditable = 'true'; c.setAttribute('onfocus', 'csTblFocus(this)'); return c; }

// Insert a row above/below the selected cell's row (appends if no cell is selected).
function csTblRow(btn, where){
  const tbl = _csTbl(btn); if (!tbl) return;
  const nCols = tbl.querySelectorAll('thead th').length || 1;
  const tr = document.createElement('tr');
  for (let i = 0; i < nCols; i++) tr.appendChild(_csNewCell('td'));
  const refRow = tbl._csActiveCell ? tbl._csActiveCell.closest('tbody tr') : null;
  if (refRow) refRow.insertAdjacentElement(where === 'above' ? 'beforebegin' : 'afterend', tr);
  else tbl.querySelector('tbody').appendChild(tr);
  tr.querySelector('td')?.focus();
}
// Delete the selected cell's row.
function csTblRowDel(btn){
  const tbl = _csTbl(btn); if (!tbl) return;
  const row = tbl._csActiveCell ? tbl._csActiveCell.closest('tbody tr') : null;
  if (!row) return toast('Click a cell in the row you want to delete first.', 'error');
  if (tbl.querySelectorAll('tbody tr').length <= 1) return toast('A table needs at least one row.', 'error');
  row.remove(); tbl._csActiveCell = null;
}
// Insert a column to the left/right of the selected cell (appends if none selected).
function csTblCol(btn, side){
  const tbl = _csTbl(btn); if (!tbl) return;
  const nCols = tbl.querySelectorAll('thead th').length;
  const cur = tbl._csActiveCell ? tbl._csActiveCell.cellIndex : nCols - 1;
  const at = Math.max(0, (side === 'left' ? cur : cur + 1));
  const headRow = tbl.querySelector('thead tr');
  const th = _csNewCell('th');
  if (at >= headRow.children.length) headRow.appendChild(th); else headRow.insertBefore(th, headRow.children[at]);
  tbl.querySelectorAll('tbody tr').forEach(tr => {
    const td = _csNewCell('td');
    if (at >= tr.children.length) tr.appendChild(td); else tr.insertBefore(td, tr.children[at]);
  });
  th.focus();
}
// Delete the selected cell's column.
function csTblColDel(btn){
  const tbl = _csTbl(btn); if (!tbl) return;
  if (!tbl._csActiveCell) return toast('Click a cell in the column you want to delete first.', 'error');
  const idx = tbl._csActiveCell.cellIndex;
  if (tbl.querySelectorAll('thead th').length <= 1) return toast('A table needs at least one column.', 'error');
  const th = tbl.querySelectorAll('thead th')[idx]; if (th) th.remove();
  tbl.querySelectorAll('tbody tr').forEach(tr => { const c = tr.children[idx]; if (c) c.remove(); });
  tbl._csActiveCell = null;
}

// Toggle whether a section starts on a new page in the built document.
function csTogglePageBreak(btn){
  const sec = btn.closest('.cs-sec');
  const on = sec.classList.toggle('cs-sec--pagebreak');
  btn.classList.toggle('active', on);
}

// Add an additional PAGE to the developed document: a new section that starts on its own
// page. The end user can then type a heading/body and use "🔀 Flow chart at cursor" on it
// (the flow-chart builder takes a title). Scrolls to the new page and focuses its heading.
function csAddDocPage(){
  const host = document.getElementById('cs-doc-secs');
  if (!host) return;
  host.insertAdjacentHTML('beforeend', csDocSecHtml({ pageBreak: true }));
  csHydrateImages(); csHydrateFlows();
  const secs = host.querySelectorAll('.cs-sec');
  const last = secs[secs.length - 1];
  if (last) { last.scrollIntoView({ behavior: 'smooth', block: 'center' }); last.querySelector('.cs-sec-h')?.focus(); }
  toast('New page added — add a heading/body, then use 🔀 Flow chart at cursor to insert a flow chart.');
}

// Insert a new PAGE directly above or below a given section (rather than at the end).
function csAddPageRelative(btn, where){
  const sec = btn.closest('.cs-sec');
  if (!sec) return;
  sec.insertAdjacentHTML(where === 'above' ? 'beforebegin' : 'afterend', csDocSecHtml({ pageBreak: true }));
  csHydrateImages(); csHydrateFlows();
  const newSec = where === 'above' ? sec.previousElementSibling : sec.nextElementSibling;
  if (newSec) { newSec.scrollIntoView({ behavior: 'smooth', block: 'center' }); newSec.querySelector('.cs-sec-h')?.focus(); }
  toast(`New page added ${where === 'above' ? 'above' : 'below'} this section.`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE CALLOUTS — numbered points on an image, each with the text that explains it.
//
// A point is stored as a PERCENTAGE of the image (not pixels), so it stays on the thing
// it labels at any render size — screen preview, Word, or a resized image.
//
// The numbered markers are burned into a COPY of the image (`im.annotated`) with a canvas
// at save time. Word gets exactly what was positioned on screen without any server-side
// image work, and the original `im.base64` is left untouched so the callouts stay editable
// and can be repositioned later.
//
// Shape:  im.callouts = [{ n, xPct, yPct, text, trans }]
// `trans` is filled in by csTranslateSection, so the explanations are translated along
// with the rest of the section rather than being left in English.
// ═══════════════════════════════════════════════════════════════════════════════
let _calTarget = null;      // { card, imgData, list } — the image being edited
let _calActive = -1;        // index of the highlighted callout
let _calKind = 'number';    // style for NEW callouts: 'number' (dot + legend) | 'leader' (dot + line + text box)

// A callout is either 'number' (numbered dot, text listed under the image) or 'leader'
// (a dot on the part, a leader line, and a text box ON the image — like a parts diagram).
// 'leader' callouts carry lx,ly (the text-box position, % of image). Numbers are assigned
// to numbered callouts only, in order.
function _calSetKind(k) {
  _calKind = k === 'leader' ? 'leader' : 'number';
  document.getElementById('cal-kind-number')?.classList.toggle('active', _calKind === 'number');
  document.getElementById('cal-kind-leader')?.classList.toggle('active', _calKind === 'leader');
}
function _calSetKindOf(i, k) {
  const c = _calTarget && _calTarget.list[i];
  if (!c) return;
  c.kind = k === 'leader' ? 'leader' : 'number';
  if (c.kind === 'leader' && (c.lx == null || c.ly == null)) {
    const b = _calAutoBox(c.xPct, c.yPct); c.lx = b.lx; c.ly = b.ly;
  }
  _calRender();
}
function _calNums(list) { let k = 0; return list.map(c => c.kind === 'leader' ? null : (++k)); }
// Auto-place a leader text box near the dot but comfortably INSIDE the image and CLEAR of
// the dot, so a wide box (e.g. "Isolation Point") is never clipped at the edge nor drawn
// on top of its own dot. Kept within [16, 84] × [9, 91] with ≥12% separation from the dot.
function _calAutoBox(x, y) {
  let lx = x < 50 ? x - 22 : x + 22;                 // first choice: outward, into the margin
  if (lx < 16 || lx > 84) lx = x < 50 ? x + 22 : x - 22;   // would clip → place it inward instead
  lx = Math.max(16, Math.min(84, lx));
  if (Math.abs(lx - x) < 12) lx = Math.max(16, Math.min(84, x < 50 ? x + 24 : x - 24));
  const ly = Math.max(9, Math.min(91, y));
  return { lx: +lx.toFixed(2), ly: +ly.toFixed(2) };
}

function csOpenImageCallouts(uid) {
  const card = document.querySelector(`.cs-img-card[data-uid="${uid}"]`);
  if (!card) return;
  const imgData = _csCardImages.get(card);
  if (!imgData || !imgData.base64) return toast('This image is still loading — try again in a moment.', 'error');
  // Work on a copy so Cancel really cancels. Coordinates are sanitised (finite, 0–100) so
  // any earlier bad data — e.g. a NaN saved from a click before the image had decoded —
  // renders somewhere visible instead of piling in the top-left corner.
  const sc = (v, d) => { const n = +v; return isFinite(n) ? Math.max(0, Math.min(100, n)) : d; };
  _calTarget = { card, imgData, list: (imgData.callouts || []).map(c => {
    const kind = c.kind === 'leader' ? 'leader' : 'number';
    const xPct = sc(c.xPct, 50), yPct = sc(c.yPct, 50);
    const o = { kind, xPct, yPct, text: c.text || '', trans: c.trans || '', lx: null, ly: null };
    if (kind === 'leader') {
      const auto = _calAutoBox(xPct, yPct);   // sensible box position when lx/ly are missing or invalid
      o.lx = (c.lx != null && isFinite(+c.lx)) ? sc(c.lx, auto.lx) : auto.lx;
      o.ly = (c.ly != null && isFinite(+c.ly)) ? sc(c.ly, auto.ly) : auto.ly;
    }
    return o;
  }) };
  _calActive = -1;
  _calSetKind(_calKind);
  _calPopulateLangs();
  const biCb = document.getElementById('cal-bilingual'); if (biCb) biCb.checked = !!imgData.calBilingual;
  const st = document.getElementById('cal-trans-status'); if (st) st.textContent = '';
  const el = document.getElementById('cal-img');
  if (el) { el.onload = () => _calRender(); el.src = imgData.base64; }
  _calRender();
  showModal('img-callout-modal');
}

// Languages offered for translating callouts (same set as the section translate bar).
const CS_TRANS_LANGS = [['Spanish','Español'],['French','Français'],['Portuguese','Português'],['Mandarin Chinese','中文'],
  ['Arabic','العربية'],['Indonesian','Bahasa Indonesia'],['Malay','Bahasa Melayu'],['Thai','ภาษาไทย'],
  ['Vietnamese','Tiếng Việt'],['Tagalog','Filipino'],['Hindi','हिंदी'],['Japanese','日本語'],
  ['Korean','한국어'],['German','Deutsch'],['Italian','Italiano'],['Russian','Русский'],
  ['Polish','Polski'],['Afrikaans','Afrikaans'],['Zulu','isiZulu'],['Swahili','Kiswahili']];
function _calPopulateLangs() {
  const sel = document.getElementById('cal-trans-lang');
  if (!sel) return;
  const cur = sel.value || val('cs-trans-lang') || '';   // default to the section's chosen language
  sel.innerHTML = '<option value="">— select language —</option>' +
    CS_TRANS_LANGS.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${v} — ${l}</option>`).join('');
}
function _calSetTrans(i, v) { if (_calTarget && _calTarget.list[i]) _calTarget.list[i].trans = v; }

// Translate every callout's text into the chosen language, in place, keeping each editable.
async function csCalTranslate() {
  if (!_calTarget) return;
  const lang = val('cal-trans-lang');
  if (!lang) return toast('Pick a language to translate the callouts into.', 'error');
  const list = _calTarget.list.filter(c => String(c.text || '').trim());
  if (!list.length) return toast('Add some callout text first.', 'error');
  const status = document.getElementById('cal-trans-status');
  const texts = list.map(c => c.text.trim());
  if (status) status.textContent = `⏳ Translating ${texts.length} callout(s) to ${lang}…`;
  try {
    const kbArticleIds = [...document.querySelectorAll('#cs-kb-list .cs-kb-cb:checked')].map(c => parseInt(c.value, 10)).filter(Boolean);
    // Reuse the section translator: translateSection translates every string in the JSON.
    const r = await POST('/api/content/translate', { section: { imageCallouts: texts }, targetLang: lang, kbArticleIds });
    const out = r && r.translated && Array.isArray(r.translated.imageCallouts) ? r.translated.imageCallouts : null;
    if (!ok(r) || !out || out.length !== texts.length) { if (status) status.textContent = '❌ Translation failed — try again.'; return; }
    let k = 0;
    for (const c of list) c.trans = String(out[k++] || '');
    if (status) status.textContent = `✓ Translated to ${lang}. Edit any line below if needed, then Save callouts.`;
    _calRender();
  } catch (e) {
    if (status) status.textContent = '❌ ' + (e.message || 'Translation failed');
  }
}

// Click the image to add a callout; drag a dot or a text box to move it.
function _calBindStage() {
  const stage = document.getElementById('cal-stage');
  if (!stage || stage._calBound) return;
  stage._calBound = true;
  // Map an event to image-percent coordinates. Measured against the IMAGE element (not the
  // stage), and returns null if the image isn't laid out yet (zero size) or the maths isn't
  // finite — otherwise a click before the photo has decoded would divide by zero and drop
  // the dot in the top-left corner.
  const pct = e => {
    const img = document.getElementById('cal-img');
    const r = (img && img.getBoundingClientRect().height > 4) ? img.getBoundingClientRect() : stage.getBoundingClientRect();
    if (!r || r.width < 4 || r.height < 4) return null;
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    if (!isFinite(x) || !isFinite(y)) return null;
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
  };

  stage.addEventListener('click', e => {
    if (!_calTarget || e.target.closest('[data-h]')) return;   // handle clicks select, not add
    const p = pct(e);
    if (!p) return toast('Image is still loading — wait a moment, then click.', 'error');
    const c = { kind: _calKind, xPct: +p.x.toFixed(2), yPct: +p.y.toFixed(2), text: '', trans: '' };
    if (_calKind === 'leader') { const b = _calAutoBox(p.x, p.y); c.lx = b.lx; c.ly = b.ly; }
    _calTarget.list.push(c);
    _calActive = _calTarget.list.length - 1;
    _calRender(true);
  });

  let drag = null;
  stage.addEventListener('pointerdown', e => {
    const h = e.target.closest('[data-h]');
    if (!h || !_calTarget) return;
    drag = { i: +h.dataset.i, handle: h.dataset.h };
    h.classList.add('drag');
    try { h.setPointerCapture(e.pointerId); } catch {}
    _calSetActive(drag.i);
    e.preventDefault();
  });
  stage.addEventListener('pointermove', e => {
    if (!drag || !_calTarget) return;
    const c = _calTarget.list[drag.i];
    if (!c) return;
    const p = pct(e);
    if (!p) return;
    if (drag.handle === 'lb') { c.lx = +p.x.toFixed(2); c.ly = +p.y.toFixed(2); }
    else { c.xPct = +p.x.toFixed(2); c.yPct = +p.y.toFixed(2); }
    const el = stage.querySelector(`[data-h="${drag.handle}"][data-i="${drag.i}"]`);
    if (el) { el.style.left = (drag.handle === 'lb' ? c.lx : c.xPct) + '%'; el.style.top = (drag.handle === 'lb' ? c.ly : c.yPct) + '%'; }
    _calLines();
  });
  const endDrag = () => {
    if (!drag) return;
    stage.querySelectorAll('.drag').forEach(m => m.classList.remove('drag'));
    drag = null;
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
}

// Draw the leader lines (dot → text box) for 'leader' callouts.
function _calLines() {
  if (!_calTarget) return;
  const svg = document.getElementById('cal-lines');
  if (svg) svg.innerHTML = _calTarget.list.filter(c => c.kind === 'leader')
    .map(c => `<line x1="${c.xPct}%" y1="${c.yPct}%" x2="${c.lx}%" y2="${c.ly}%" stroke="#E01B1B" stroke-width="2"/>`).join('');
}

function _calRender(focusLast) {
  _calBindStage();
  if (!_calTarget) return;
  const list = _calTarget.list;
  const nums = _calNums(list);
  const mks = document.getElementById('cal-markers');
  if (mks) mks.innerHTML = list.map((c, i) => {
    const act = i === _calActive ? ' active' : '';
    if (c.kind === 'leader') {
      // Box first, dot second, so the dot is never hidden behind the box.
      return `<div class="cal-lb${act}" data-i="${i}" data-h="lb" style="left:${c.lx}%;top:${c.ly}%" onclick="_calSetActive(${i})" title="${esc(c.text || '')}">${esc(c.text || 'Text')}</div>`
        + `<div class="cal-mk-dot${act}" data-i="${i}" data-h="pt" style="left:${c.xPct}%;top:${c.yPct}%" onclick="_calSetActive(${i})"></div>`;
    }
    return `<div class="cal-mk${act}" data-i="${i}" data-h="pt" style="left:${c.xPct}%;top:${c.yPct}%" onclick="_calSetActive(${i})">${nums[i]}</div>`;
  }).join('');
  _calLines();
  const box = document.getElementById('cal-list');
  const showTrans = list.some(c => c.trans && String(c.trans).trim());
  const trLang = val('cal-trans-lang');
  if (box) box.innerHTML = list.map((c, i) =>
    `<div class="cal-row${i === _calActive ? ' active' : ''}" data-i="${i}" onclick="_calSetActive(${i})">
      <div class="cal-row-n">${c.kind === 'leader' ? '🏷' : nums[i]}</div>
      <div class="cal-row-fields">
        <textarea class="cal-row-txt" data-i="${i}" placeholder="${c.kind === 'leader' ? 'Callout text (shown on the image)' : 'What does this point show?'}" oninput="_calSetText(${i}, this.value)">${esc(c.text)}</textarea>
        ${showTrans ? `<textarea class="cal-row-tr" data-i="${i}" placeholder="Translation${trLang ? ' (' + esc(trLang) + ')' : ''}" oninput="_calSetTrans(${i}, this.value)">${esc(c.trans || '')}</textarea>` : ''}
      </div>
      <select class="cal-row-kind" data-i="${i}" onclick="event.stopPropagation()" onchange="_calSetKindOf(${i}, this.value)" title="Callout style">
        <option value="number"${c.kind !== 'leader' ? ' selected' : ''}>①</option>
        <option value="leader"${c.kind === 'leader' ? ' selected' : ''}>🏷</option>
      </select>
      <button class="btn btn-danger btn-xs btn-icon" onclick="event.stopPropagation();_calRemove(${i})" title="Remove callout">✕</button>
    </div>`).join('');
  const cnt = document.getElementById('cal-count');
  if (cnt) cnt.textContent = list.length;
  document.getElementById('cal-empty')?.classList.toggle('hidden', list.length > 0);
  if (focusLast) box?.querySelector(`.cal-row-txt[data-i="${list.length - 1}"]`)?.focus();
}

// Highlight only — never re-render, or the textarea being typed into would lose focus.
function _calSetActive(i) {
  _calActive = i;
  document.querySelectorAll('#cal-markers .cal-mk, #cal-markers .cal-mk-dot, #cal-markers .cal-lb')
    .forEach(el => el.classList.toggle('active', +el.dataset.i === i));
  document.querySelectorAll('#cal-list .cal-row').forEach(el => el.classList.toggle('active', +el.dataset.i === i));
}
function _calSetText(i, v) {
  if (!_calTarget || !_calTarget.list[i]) return;
  _calTarget.list[i].text = v;
  // Update the on-image text box live (typing in the side list must show on the image),
  // otherwise the box keeps showing the "Text" placeholder until the next re-render.
  const lb = document.querySelector(`#cal-markers .cal-lb[data-i="${i}"]`);
  if (lb) { lb.textContent = v || 'Text'; lb.title = v || ''; }
}
function _calRemove(i) {
  if (!_calTarget) return;
  _calTarget.list.splice(i, 1);
  if (_calActive >= _calTarget.list.length) _calActive = -1;
  _calRender();
}

function _roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// Burn the callouts into a copy of the image: numbered discs for 'number' callouts, and a
// dot + leader line + text box for 'leader' callouts. `tr` selects the translated text for
// leader boxes (canvas renders Thai correctly, unlike the image model). Resolves to a PNG
// data URL, or null on failure — the document then just uses the original image.
function csRenderAnnotatedImage(im, tr) {
  return new Promise(resolve => {
    const marks = Array.isArray(im.callouts) ? im.callouts.filter(c => c && String(c.text || '').trim()) : [];
    if (!marks.length) return resolve(null);
    const img = new Image();
    img.onload = () => {
      try {
        const W = img.naturalWidth || im.width || 800;
        const H = img.naturalHeight || im.height || 600;
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const g = cv.getContext('2d');
        g.drawImage(img, 0, 0, W, H);
        g.textAlign = 'center';
        g.textBaseline = 'middle';

        // Text size is DISPLAY-AWARE: sized so it renders at ~TARGET_PT points once the image
        // is placed at its display width in the document. A fixed fraction of the pixels reads
        // "too big" on a full-page image and "too small" on a half-page image; targeting a
        // point size keeps the callouts readable at whatever size the image is shown.
        const docWin = (im.layout && +im.layout.docWidth) || Math.min(6, W / 96) || 4;  // inches shown at
        const TARGET_PT = 13;
        const FS = Math.max(20, Math.min(120, Math.round((TARGET_PT / 72) * W / docWin)));
        const R = Math.round(FS * 0.8);                    // dots/lines scale with the text
        const fontFor = s => `700 ${s}px Arial, "Segoe UI", Tahoma, sans-serif`;
        g.font = fontFor(FS);
        const mrg = Math.max(4, R * 0.5);
        const pad = FS * 0.55;
        const leaders = marks.filter(c => c.kind === 'leader').map(c => {
          // Bilingual (translated · English, translated first) when the image's option is on
          // (shows on EVERY render), or on the translated render. Otherwise a single segment.
          const bi = c.trans && (im.calBilingual || tr);
          const segs = bi
            ? [{ t: c.trans, color: '#1E3A5F' }, { t: '   ·   ', color: '#9AA0AB' }, { t: (c.text || ''), color: '#5A6072' }]
            : [{ t: ((tr && c.trans) || c.text || ''), color: '#1E3A5F' }];
          let tw = 0; for (const s of segs) tw += g.measureText(s.t).width;
          const bw = Math.max(FS * 2, tw + pad * 2), bh = FS + pad * 1.3;
          let cx = (c.lx / 100) * W, cy = (c.ly / 100) * H;
          cx = Math.min(Math.max(cx, mrg + bw / 2), W - mrg - bw / 2);
          cy = Math.min(Math.max(cy, mrg + bh / 2), H - mrg - bh / 2);
          return { segs, tw, bw, bh, cx, cy, dx: (c.xPct / 100) * W, dy: (c.yPct / 100) * H };
        });
        // Lines from the dot to the (clamped) box — red, matching the dots.
        g.strokeStyle = '#E01B1B'; g.lineWidth = Math.max(1.5, R * 0.18);
        for (const L of leaders) { g.beginPath(); g.moveTo(L.dx, L.dy); g.lineTo(L.cx, L.cy); g.stroke(); }
        // Text boxes — segments drawn left-to-right, the whole run centred in the box.
        g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = fontFor(FS);
        for (const L of leaders) {
          g.fillStyle = '#FFFFFF'; g.strokeStyle = '#1E3A5F'; g.lineWidth = Math.max(1.5, R * 0.16);
          _roundRect(g, L.cx - L.bw / 2, L.cy - L.bh / 2, L.bw, L.bh, Math.max(4, FS * 0.35)); g.fill(); g.stroke();
          let x = L.cx - L.tw / 2;
          for (const s of L.segs) { g.fillStyle = s.color; g.fillText(s.t, x, L.cy + 1); x += g.measureText(s.t).width; }
        }
        // Red dot with white ring ON the selected point — drawn LAST so it is always visible.
        for (const L of leaders) {
          g.beginPath(); g.arc(L.dx, L.dy, Math.max(4, R * 0.38), 0, Math.PI * 2); g.fillStyle = '#E01B1B'; g.fill();
          g.lineWidth = Math.max(1.5, R * 0.18); g.strokeStyle = '#FFFFFF'; g.stroke();
        }
        // Numbered discs (numbered among numbered callouts only).
        let n = 0;
        g.font = `700 ${Math.round(R * 1.15)}px Arial, Helvetica, sans-serif`;
        for (const c of marks) {
          if (c.kind === 'leader') continue;
          n++;
          const x = (c.xPct / 100) * W, y = (c.yPct / 100) * H;
          g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.fillStyle = '#1E3A5F'; g.fill();
          g.lineWidth = Math.max(2, R * 0.2); g.strokeStyle = '#FFFFFF'; g.stroke();
          g.fillStyle = '#FFFFFF'; g.fillText(String(c.n || n), x, y);
        }
        resolve(cv.toDataURL('image/png'));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = im.base64 || '';
  });
}

function _calBadge(card, n) {
  const b = card && card.querySelector('.cs-img-cal-badge');
  if (b) b.textContent = n ? `🏷 ${n} callout${n > 1 ? 's' : ''}` : '';
}

async function csApplyImageCallouts() {
  if (!_calTarget) return closeModal('img-callout-modal');
  const { card, imgData, list } = _calTarget;
  // A callout with no text explains nothing, so it is not carried into the document.
  const kept = list.filter(c => String(c.text || '').trim());
  const dropped = list.length - kept.length;
  let n = 0;
  imgData.callouts = kept.map(c => {
    const base = { kind: c.kind === 'leader' ? 'leader' : 'number', xPct: c.xPct, yPct: c.yPct, text: c.text.trim(), trans: c.trans || '' };
    if (base.kind === 'leader') {
      base.lx = c.lx != null ? c.lx : (c.xPct < 50 ? Math.max(8, c.xPct - 22) : Math.min(92, c.xPct + 22));
      base.ly = c.ly != null ? c.ly : c.yPct;
    } else { base.n = ++n; }
    return base;
  });
  // Bilingual display option (translated · English side by side, translated first).
  imgData.calBilingual = !!(document.getElementById('cal-bilingual') || {}).checked;
  imgData.annotated = await csRenderAnnotatedImage(imgData, false);
  // A translated render is only needed when a leader box carries text (its text is ON the
  // image); numbered callouts translate via the legend, not the image.
  const needTr = imgData.callouts.some(c => c.kind === 'leader' && c.trans);
  imgData.annotatedTr = needTr ? await csRenderAnnotatedImage(imgData, true) : '';
  _calBadge(card, imgData.callouts.length);
  closeModal('img-callout-modal');
  _calTarget = null;
  toast(dropped
    ? `Saved ${imgData.callouts.length} callout(s). ${dropped} empty one(s) were not added — a callout needs text.`
    : (imgData.callouts.length ? `Saved ${imgData.callouts.length} callout(s).` : 'Callouts cleared.'),
    dropped ? 'error' : undefined);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERATE IMAGE FROM PAGE CONTENT — one shared feature used by every page type.
//
// A page wires itself in by mapping its own content into the common shape
// { title, body, keyPoints }. Everything else (prompt review, generation, the
// approve/regenerate loop, and the handoff to the existing image placement) is
// shared here — nothing is duplicated per page type.
// ═══════════════════════════════════════════════════════════════════════════════

// ── The common content interface ──────────────────────────────────────────────
// WORKED EXAMPLE: the Content Studio document section wiring itself in. Any other
// page type just needs its own function returning the same { title, body, keyPoints }.
function csExtractPageContent(sec) {
  const heading = (sec.querySelector('.cs-sec-h') || {}).value || '';
  const raw     = (sec.querySelector('.cs-sec-b') || {}).value || '';
  const docTitle = val('cs-doc-title') || (csDraft && csDraft.data && csDraft.data.title) || '';
  // Key points = bullet lines in the body + any checklist items shown in this section
  const keyPoints = [
    ...raw.split('\n').map(s => s.trim()).filter(s => /^[-•]\s+/.test(s)).map(s => s.replace(/^[-•]\s+/, '')),
    ...[...sec.querySelectorAll('.cs-cl-text')].map(el => el.textContent.trim()).filter(Boolean),
  ];
  return {
    title: [docTitle, heading].filter(Boolean).join(' — '),
    // strip our own image/callout markers so they never leak into the prompt
    body: raw.replace(/\[IMG:[a-z0-9]+\]/gi, '').replace(/\[!(?:DANGER|CAUTION|NOTE|ACTIVITY):[\s\S]*?\]/gi, '').trim(),
    keyPoints,
  };
}

let _ig = null;   // { sec, content, cfg, locale, prompt, caption, attempts[], cur, busy, step }

async function csImageGenOpen(btn) {
  const sec = btn.closest('.cs-sec');
  if (!sec) return;
  const content = csExtractPageContent(sec);
  if (!content.title && !content.body) return toast('Add some content to this section first — the image is generated from it.', 'error');
  let conf;
  try { conf = await GET('/api/imagegen/config'); } catch { conf = null; }
  if (!conf || conf.error) return toast('Image generation is unavailable: ' + ((conf && conf.error) || 'no response'), 'error');
  const dc = conf.defaultCaption || { lines: [], color: '#1E3A5F', align: 'center', box: {} };
  _ig = {
    sec, content, cfg: conf, locale: (conf.locales[0] || {}).code || 'en', styleKey: ((conf.stylePresets||[])[0]||{}).key || 'cartoon', step: 'setup', busy: false,
    prompt: '', attempts: [], cur: -1,
    caption: JSON.parse(JSON.stringify(dc)),
  };
  _igRender();
}

function _igClose() { document.getElementById('ig-modal')?.remove(); _ig = null; }

function _igCaptionLine(code) {
  const l = (_ig.caption.lines || []).find(x => x.locale === code);
  return l ? l.text : '';
}
function _igSetCaptionLine(code, text) {
  _ig.caption.lines = _ig.caption.lines || [];
  const l = _ig.caption.lines.find(x => x.locale === code);
  if (l) l.text = text;
  else _ig.caption.lines.push({ locale: code, text, size: code === 'th' ? 44 : 38, bold: true });
}
function _igSet(k, v) {
  if (k === 'color') _ig.caption.color = v;
  else if (k === 'align') _ig.caption.align = v;
  else if (k === 'yPct') { _ig.caption.box = _ig.caption.box || {}; _ig.caption.box.yPct = parseFloat(v) || 15; }
  else if (k === 'scale') { const s = parseFloat(v) || 1; (_ig.caption.lines || []).forEach(l => { l.size = Math.round((l._base || (l._base = l.size)) * s); }); }
}

function _igRender() {
  if (!_ig) return;
  document.getElementById('ig-modal')?.remove();
  const c = _ig.cfg;
  const el = document.createElement('div');
  el.id = 'ig-modal'; el.className = 'pp-modal-overlay';
  const langOpts = (c.locales || []).map(l => `<option value="${l.code}"${l.code === _ig.locale ? ' selected' : ''}>${esc(l.label)}</option>`).join('');
  const limitNote = `<span class="cell-sub">${c.remaining} of ${c.dailyLimit} image generations left today</span>`;
  const keyNote = (c.engine === 'openai')
    ? `<div class="cell-sub" style="margin:4px 0">Artwork engine: <strong>gpt-image-1</strong></div>`
    : `<div class="cell-sub" style="margin:4px 0">Artwork engine: <strong>Claude vector illustration</strong> (uses the AI key already configured — no extra key needed)</div>`;

  // Attempt history strip
  const history = _ig.attempts.length ? `<div class="ig-history">${_ig.attempts.map((a, i) =>
    `<button type="button" class="ig-hist${i === _ig.cur ? ' active' : ''}" onclick="_igRestore(${i})" title="${esc(a.note || ('Attempt ' + (i + 1)))}">
       <img src="${a.dataUrl}" alt=""><span>${i + 1}</span></button>`).join('')}</div>` : '';

  let body = '';
  if (_ig.step === 'setup') {
    body = `${keyNote}
      <div class="tc-grid">
        <div class="cs-row"><label>Language</label>
          <select id="ig-lang" onchange="_ig.locale=this.value">${langOpts}</select></div>
        <div class="cs-row"><label>Illustration style</label>
          <select id="ig-style" onchange="_ig.styleKey=this.value">${(c.stylePresets || []).map(s =>
            `<option value="${s.key}"${s.key === _ig.styleKey ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}</select></div>
      </div>
      <div class="cs-row"><label>Page content used for the image <span class="cell-sub">(read-only)</span></label>
        <div class="ig-content"><strong>${esc(_ig.content.title || '(untitled)')}</strong>
          <div class="cell-sub" style="margin-top:4px">${esc((_ig.content.body || '').slice(0, 400))}${(_ig.content.body || '').length > 400 ? '…' : ''}</div>
          ${_ig.content.keyPoints.length ? `<div class="cell-sub" style="margin-top:4px">${_ig.content.keyPoints.length} key point(s)</div>` : ''}
        </div></div>
      ${_igCaptionEditor()}
      <div class="flex gap-2" style="margin-top:10px">
        <button class="btn btn-accent" onclick="_igBuildPrompt()">① Build image prompt →</button>${limitNote}
      </div>`;
  } else if (_ig.step === 'prompt') {
    body = `<div class="cs-row"><label>Review the image prompt <span class="cell-sub">(scene only — no text is drawn by the AI; edit freely)</span></label>
        <textarea id="ig-prompt" rows="7" oninput="_ig.prompt=this.value">${esc(_ig.prompt)}</textarea></div>
      ${_igCaptionEditor()}
      <div class="flex gap-2" style="margin-top:10px">
        <button class="btn btn-outline" onclick="_ig.step='setup';_igRender()">← Back</button>
        <button class="btn btn-accent" onclick="_igGenerate()">② Generate image</button>${limitNote}
      </div>`;
  } else if (_ig.step === 'result') {
    const a = _ig.attempts[_ig.cur] || {};
    body = `<div class="ig-result">
        <div class="ig-imgwrap"><img src="${a.dataUrl}" alt="Generated illustration"></div>
        <div class="ig-side">
          <div class="cell-sub"><strong>Prompt used</strong></div>
          <div class="ig-prompt-ro">${esc(a.prompt || '')}</div>
          ${a.note ? `<div class="cell-sub" style="margin-top:6px">Last change: ${esc(a.note)}</div>` : ''}
          ${history}
        </div>
      </div>
      <div class="cs-row" style="margin-top:8px"><label>Request a change <span class="cell-sub">(plain language — e.g. “add gloves”, “less busy background”, “make the caption bigger”)</span></label>
        <div class="flex gap-2"><input id="ig-instr" placeholder="Describe the change…" style="flex:1" onkeydown="if(event.key==='Enter')_igRequestChanges()">
        <button class="btn btn-outline" onclick="_igRequestChanges()">↻ Request changes</button></div></div>
      ${_igCaptionEditor(true)}
      <div class="flex gap-2" style="margin-top:10px">
        <button class="btn btn-success" onclick="_igApprove()">✅ Approve &amp; place in document</button>
        <button class="btn btn-outline" onclick="_ig.step='prompt';_igRender()">✏️ Edit prompt</button>${limitNote}
      </div>`;
  }

  el.innerHTML = `<div class="pp-modal ig-modal-box">
      <div class="pp-modal-head"><h3>🖼 Generate image from page content</h3>
        <button class="btn btn-ghost btn-sm" onclick="_igClose()">✕ Close</button></div>
      <div class="ig-body">${_ig.busy ? `<div class="ig-busy"><div class="spinner"></div><div>${esc(_ig.busyMsg || 'Working…')}</div></div>` : body}</div>
    </div>`;
  document.body.appendChild(el);
}

// Caption editor — text, colour, size, position (all configurable, per page).
function _igCaptionEditor(compact) {
  const cap = _ig.caption, box = cap.box || {};
  return `<details class="cs-meta-block" ${compact ? '' : 'open'}>
    <summary class="cs-meta-summary">✍️ Caption <span class="cs-meta-hint">Thai stacked above English — text is drawn by the server, always spelled correctly</span></summary>
    <div class="cs-meta-grid">
      <div class="cs-meta-row" style="grid-column:1/-1"><label>Thai line</label>
        <input value="${esc(_igCaptionLine('th'))}" oninput="_igSetCaptionLine('th',this.value)"></div>
      <div class="cs-meta-row" style="grid-column:1/-1"><label>English line</label>
        <input value="${esc(_igCaptionLine('en'))}" oninput="_igSetCaptionLine('en',this.value)"></div>
      <div class="cs-meta-row"><label>Colour</label><input type="color" value="${esc(cap.color || '#1E3A5F')}" oninput="_igSet('color',this.value)"></div>
      <div class="cs-meta-row"><label>Align</label><select onchange="_igSet('align',this.value)">
        ${['center', 'left', 'right'].map(a => `<option value="${a}"${(cap.align || 'center') === a ? ' selected' : ''}>${a}</option>`).join('')}</select></div>
      <div class="cs-meta-row"><label>Vertical position (%)</label><input type="number" min="5" max="95" value="${box.yPct != null ? box.yPct : 15}" oninput="_igSet('yPct',this.value)"></div>
      <div class="cs-meta-row"><label>Text size</label><input type="number" step="0.1" min="0.5" max="2" value="1" oninput="_igSet('scale',this.value)"></div>
      ${compact ? `<div class="cs-meta-row" style="grid-column:1/-1"><button class="btn btn-outline btn-sm" onclick="_igReCaption()">↻ Apply caption (no re-generation — free &amp; instant)</button></div>` : ''}
    </div></details>`;
}

async function _igBusy(msg, fn) {
  _ig.busy = true; _ig.busyMsg = msg; _igRender();
  try { return await fn(); }
  finally { _ig.busy = false; _igRender(); }
}

async function _igBuildPrompt() {
  await _igBusy('Reading the page and writing an image prompt…', async () => {
    // §16 — the image adapts to the document's learning profile (simple visual for L1, technical for L4).
    const learningProfile = (csDraft && csDraft.data && csDraft.data.meta && csDraft.data.meta.learningProfile)
      || (val('cs-learning-profile') || undefined);
    const r = await POST('/api/imagegen/prompt', { content: _ig.content, locale: _ig.locale, styleKey: _ig.styleKey, learningProfile });
    if (!ok(r)) return;
    _ig.prompt = r.prompt; _ig.step = 'prompt';
  });
}

async function _igGenerate() {
  await _igBusy('Generating artwork (5–20s) then adding the caption…', async () => {
    const r = await POST('/api/imagegen/generate', {
      prompt: _ig.prompt, caption: _ig.caption, locale: _ig.locale, styleKey: _ig.styleKey,
      pageId: (csDraft && csDraft.tsFileId) || 'draft', attempt: _ig.attempts.length + 1 });
    if (!ok(r)) return;
    _ig.attempts.push({ dataUrl: r.dataUrl, url: r.url, fileId: r.fileId, artworkFileId: r.artworkFileId, prompt: _ig.prompt, caption: JSON.parse(JSON.stringify(_ig.caption)), note: [r.engineNote, r.captionNote].filter(Boolean).join(' ') });
    _ig.cur = _ig.attempts.length - 1;
    _ig.cfg.remaining = r.remaining;
    if (r.engine) _ig.cfg.engine = r.engine;
    if (r.engineNote) toast(r.engineNote, 'error');
    if (r.captionNote) toast(r.captionNote, 'error');
    _ig.step = 'result';
  });
}

// Caption-only change → re-run the overlay on the SAME artwork (no image model call).
async function _igReCaption() {
  const a = _ig.attempts[_ig.cur];
  if (!a || !a.artworkFileId) return toast('Generate an image first.', 'error');
  await _igBusy('Re-drawing the caption…', async () => {
    const r = await POST('/api/imagegen/recaption', {
      artworkFileId: a.artworkFileId, caption: _ig.caption, locale: _ig.locale,
      pageId: (csDraft && csDraft.tsFileId) || 'draft', attempt: _ig.attempts.length + 1 });
    if (!ok(r)) return;
    _ig.attempts.push({ dataUrl: r.dataUrl, url: r.url, fileId: r.fileId, artworkFileId: a.artworkFileId, prompt: a.prompt, caption: JSON.parse(JSON.stringify(_ig.caption)), note: r.captionNote || 'caption updated' });
    _ig.cur = _ig.attempts.length - 1;
    if (r.captionNote) toast(r.captionNote, 'error');
    _ig.step = 'result';
  });
}

// Plain-language change → Claude revises the prompt AND says whether it's a scene or caption change.
async function _igRequestChanges() {
  const instr = (document.getElementById('ig-instr') || {}).value || '';
  if (!instr.trim()) return toast('Describe the change you want.', 'error');
  const a = _ig.attempts[_ig.cur] || {};
  await _igBusy('Revising…', async () => {
    const r = await POST('/api/imagegen/revise', { prompt: a.prompt || _ig.prompt, instruction: instr, caption: _ig.caption });
    if (!ok(r)) return;
    _ig.prompt = r.prompt;
    if (r.caption) {   // merge only the caption fields Claude changed
      const p = r.caption;
      if (p.color) _ig.caption.color = p.color;
      if (p.align) _ig.caption.align = p.align;
      if (p.yPct != null) { _ig.caption.box = _ig.caption.box || {}; _ig.caption.box.yPct = p.yPct; }
      if (p.sizeScale) (_ig.caption.lines || []).forEach(l => { l.size = Math.round(l.size * p.sizeScale); });
      if (Array.isArray(p.lines)) p.lines.forEach(pl => { if (pl && pl.locale && pl.text != null) _igSetCaptionLine(pl.locale, pl.text); });
    }
    _ig.lastNote = r.note || '';
    if (r.kind === 'caption') { toast('Caption change — re-drawing text only (no new artwork).'); await _igReCaption(); }
    else { _ig.step = 'prompt'; toast('Prompt revised — review it, then generate.'); }
  });
}

function _igRestore(i) { if (_ig.attempts[i]) { _ig.cur = i; _ig.caption = JSON.parse(JSON.stringify(_ig.attempts[i].caption || _ig.caption)); _ig.step = 'result'; _igRender(); } }

// ── Handoff to the Content Studio's EXISTING image placement ──────────────────
// We do not position images ourselves: this inserts an [IMG:uid] marker at the
// cursor and registers the image with the normal section-image system, so the
// existing ⚙️ Layout modal, save/reload and Word export all work unchanged.
function _igApprove() {
  const a = _ig.attempts[_ig.cur];
  if (!a) return;
  const sec = _ig.sec;
  const uid = Math.random().toString(36).slice(2, 9);
  const ta = sec.querySelector('.cs-sec-b');
  const marker = `[IMG:${uid}]`;
  const pos = (_csLastCursorSec === sec && _csLastCursorPos >= 0) ? _csLastCursorPos : ta.value.length;
  ta.value = ta.value.slice(0, pos) + marker + ta.value.slice(pos);
  _csLastCursorPos = pos + marker.length;

  const altText = (_igCaptionLine('en') || _ig.content.title || 'Generated illustration').slice(0, 180);
  const imgData = {
    uid, base64: a.dataUrl, mimeType: 'image/png', filename: 'generated-illustration.png',
    width: 1024, height: 1024, caption: altText,
    // extra provenance for the placement handoff
    generated: { imageUrl: a.url, fileId: a.fileId, language: _ig.locale, sourcePageId: (csDraft && csDraft.tsFileId) || 'draft' },
    layout: { wrapping: 'topBottom', hAlign: 'center', hType: 'align', vType: 'align',
              docWidth: 5.5, docHeight: 5.5, lockAspect: true, distTop: 0, distBottom: 0, distLeft: 0.13, distRight: 0.13 },
  };
  const gallery = sec.querySelector('.cs-img-gallery');
  gallery.insertAdjacentHTML('beforeend', csImageCardHtml(imgData));
  csHydrateImages();          // registers the card with the existing image system
  _igClose();
  toast('Image placed in the section — use ⚙️ Layout to size/position it.');
}

// Re-render the "Exact copy" WYSIWYG preview for a Form (copy exactly) draft with the current text edits
// and translations, so what the user sees equals what a save/download produces.
async function csRefreshFormPreview(){
  const holder = document.getElementById('cs-exact-doc');
  if (!holder || !csDraft || !csDraft.data) return;
  const sourceFileId = csDraft.data.sourceFileId;
  if (!sourceFileId) return;
  // Reloading rebuilds the preview from the source — it discards any WYSIWYG layout edits on the page.
  if (!confirm('Reload the preview from the document? Any layout edits you made directly on the page (typed text, inserted fields, moved/deleted rows) will be lost. Download first to keep them.')) return;
  const btn = document.getElementById('cs-exact-refresh');
  const prev = btn ? btn.textContent : '';
  if (btn){ btn.disabled = true; btn.textContent = '⏳ Updating…'; }
  try {
    const data = collectContentEdits('form-doc');
    if (csDraft.data && csDraft.data.formScope) data.formScope = csDraft.data.formScope; // preview only the selected form
    const r = await POST('/api/content/form-preview', { sourceFileId, data });
    if (r && r.html) {
      // The preview is the full fillable HTML document — load it into the iframe (srcdoc) so it matches
      // the download exactly. Keep innerHTML as a fallback for the old (div) preview.
      if ('srcdoc' in holder) holder.srcdoc = r.html; else holder.innerHTML = r.html;
      if (csDraft.data) csDraft.data.exactHtml = r.html; // keep the draft's preview in sync
    }
  } catch(e){ toast('Could not refresh preview: ' + e.message, 'error'); }
  finally { if (btn){ btn.disabled = false; btn.textContent = prev; } }
}

// ── Flowchart builder (editable in the section card) ─────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// FLOW CHART — decision flow charts (terminators, process boxes, decision diamonds
// with labelled Yes/No branches), insertable at the cursor on ANY page being worked on.
//
// This is NOT the older `flowchart` stage pathway (csFlowHtml / stages[] / items[]),
// which draws a straight left→right progression and cannot express a branch. Both are
// kept: the pathway is what the AI generator emits for competency progressions, and this
// is for procedures that branch on a decision.
//
// Like an image, a chart is placed with a [FLOW:uid] marker in the body text, so it lands
// exactly where the cursor was and moves with the text.
//
//   flow = { uid, title, nodes:[Node], png, pngTr }
//   Node = { id, type:'start'|'process'|'decision'|'end', text, trans,
//            mainLabel, branchLabel, branchDir:'left'|'right', branch:[Node] }
//
// A decision has TWO exits: `mainLabel` continues down the spine, `branchLabel` leaves to
// a side column (`branch`), which is itself a sequence and may contain further decisions.
// Layout is recursive, so nesting is not limited by the drawing code.
//
// The chart is rasterised to PNG in the browser (SVG → canvas) for Word — the same
// approach as image callouts — so the document gets exactly what is on screen without any
// server-side drawing.
// ═══════════════════════════════════════════════════════════════════════════════
const _csCardFlows = new WeakMap();     // flow card element → flow object
let _csPendingFlows = {};               // uid → flow, awaiting hydration after a re-render
let _dfcTarget = null;                  // { card, flow } currently open in the builder

const DFC = { W:210, DW:225, GAP:46, COL:265, LH:15, FS:11.5, MARGIN:26,
  NAVY:'#1E3A5F', LINE:'#5A6072', GREEN:'#27AE60', RED:'#C0392B', BORDER:'#1E3A5F' };

const _dfcText = (n, tr) => (tr && n.trans ? n.trans : (n.text || ''));
// Branch labels ("Yes"/"No") are translated too, so a translated chart reads entirely in
// the target language.
const _dfcLabel = (n, key, tr) => {
  const tk = key === 'mainLabel' ? 'transMainLabel' : 'transBranchLabel';
  return (tr && n[tk]) ? n[tk] : (n[key] || '');
};

function _dfcWrap(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function _dfcMeasure(n, tr) {
  const isD = n.type === 'decision';
  const w = isD ? DFC.DW : DFC.W;
  const lines = _dfcWrap(_dfcText(n, tr), Math.floor((w - (isD ? 76 : 26)) / 6.1));
  const th = lines.length * DFC.LH;
  const h = isD ? Math.max(88, th + 54)
    : (n.type === 'process' ? Math.max(50, th + 24) : Math.max(42, th + 20));
  return { w, h, lines };
}

// Place a sequence down a column at `cx`, recursing into each decision's side branch.
function _dfcLayoutSeq(nodes, cx, top, out, tr) {
  let y = top, prev = null, minX = cx, maxX = cx, bottom = top;
  for (const n of nodes) {
    const m = _dfcMeasure(n, tr);
    const box = { n, m, x: cx, y, w: m.w, h: m.h };
    out.boxes.push(box);
    minX = Math.min(minX, cx - m.w / 2);
    maxX = Math.max(maxX, cx + m.w / 2);
    if (prev) out.edges.push({ x1: prev.x, y1: prev.y + prev.h, x2: cx, y2: y,
      label: prev.n.type === 'decision' ? _dfcLabel(prev.n, 'mainLabel', tr) : '' });
    if (n.type === 'decision' && Array.isArray(n.branch) && n.branch.length) {
      const dir = n.branchDir === 'left' ? -1 : 1;
      const bx = cx + dir * DFC.COL;
      const first = _dfcMeasure(n.branch[0], tr);
      // Align the branch's first box on the decision's centre line, so the connector is
      // a straight horizontal arrow rather than an elbow.
      const bTop = y + m.h / 2 - first.h / 2;
      const sub = _dfcLayoutSeq(n.branch, bx, bTop, out, tr);
      out.edges.push({ x1: cx + dir * m.w / 2, y1: y + m.h / 2,
        x2: bx - dir * first.w / 2, y2: bTop + first.h / 2, label: _dfcLabel(n, 'branchLabel', tr) });
      minX = Math.min(minX, sub.minX);
      maxX = Math.max(maxX, sub.maxX);
      bottom = Math.max(bottom, sub.bottom);
    }
    prev = box;
    y += m.h + DFC.GAP;
  }
  return { minX, maxX, bottom: Math.max(bottom, y - DFC.GAP) };
}

function csDfcSvg(flow, tr) {
  if (flow && flow.mode === 'label') return csDfcLabelSvg(flow, tr);
  const nodes = (flow && Array.isArray(flow.nodes)) ? flow.nodes : [];
  if (!nodes.length) return null;
  const title = tr && flow.transTitle ? flow.transTitle : (flow.title || '');
  const titleH = title ? 34 : 0;
  const out = { boxes: [], edges: [] };
  const r = _dfcLayoutSeq(nodes, 0, DFC.MARGIN + titleH, out, tr);
  const dx = DFC.MARGIN - r.minX;
  const W = Math.round((r.maxX - r.minX) + DFC.MARGIN * 2);
  const H = Math.round(r.bottom + DFC.MARGIN);
  const esc2 = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let body = '';
  for (const e of out.edges) {
    const x1 = e.x1 + dx, x2 = e.x2 + dx;
    body += `<line x1="${x1.toFixed(1)}" y1="${e.y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${e.y2.toFixed(1)}" stroke="${DFC.LINE}" stroke-width="1.6" marker-end="url(#dfcArrow)"/>`;
    if (e.label) {
      const mx = (x1 + x2) / 2, my = (e.y1 + e.y2) / 2;
      const tw = e.label.length * 6.4 + 10;
      body += `<rect x="${(mx - tw / 2).toFixed(1)}" y="${(my - 9).toFixed(1)}" width="${tw.toFixed(1)}" height="18" rx="3" fill="#fff" stroke="${DFC.LINE}" stroke-width="0.8"/>`
        + `<text x="${mx.toFixed(1)}" y="${(my + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="${DFC.NAVY}">${esc2(e.label)}</text>`;
    }
  }
  for (const b of out.boxes) {
    const cx = b.x + dx, y = b.y, w = b.w, h = b.h;
    const term = b.n.type === 'start' || b.n.type === 'end';
    const fill = b.n.type === 'start' ? DFC.GREEN : b.n.type === 'end' ? DFC.RED : '#FFFFFF';
    const txt = term ? '#FFFFFF' : DFC.NAVY;
    if (b.n.type === 'decision') {
      body += `<polygon points="${cx},${y} ${cx + w / 2},${y + h / 2} ${cx},${y + h} ${cx - w / 2},${y + h / 2}" fill="#fff" stroke="${DFC.BORDER}" stroke-width="1.6"/>`;
    } else if (term) {
      body += `<rect x="${cx - w / 2}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>`;
    } else {
      body += `<rect x="${cx - w / 2}" y="${y}" width="${w}" height="${h}" rx="4" fill="#fff" stroke="${DFC.BORDER}" stroke-width="1.6"/>`;
    }
    const ls = b.m.lines;
    const startY = y + h / 2 - ((ls.length - 1) * DFC.LH) / 2 + 4;
    ls.forEach((ln, i) => {
      body += `<text x="${cx}" y="${(startY + i * DFC.LH).toFixed(1)}" text-anchor="middle" font-size="${DFC.FS}" font-weight="${term ? 700 : 400}" fill="${txt}">${esc2(ln)}</text>`;
    });
  }
  const titleSvg = title
    ? `<text x="${W / 2}" y="${DFC.MARGIN + 8}" text-anchor="middle" font-size="15" font-weight="700" fill="${DFC.NAVY}">${esc2(title)}</text>` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Arial, Helvetica, sans-serif">`
    + `<defs><marker id="dfcArrow" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">`
    + `<path d="M0,0 L0,6 L8,3 z" fill="${DFC.LINE}"/></marker></defs>`
    + `<rect width="${W}" height="${H}" fill="#FFFFFF"/>${titleSvg}${body}</svg>`;
}

// Rasterise the chart for Word. Resolves to a PNG data URL, or null on failure (the
// document then falls back to a plain numbered list of the steps).
function csDfcPng(flow, tr, scale) {
  return new Promise(resolve => {
    const svg = csDfcSvg(flow, tr);
    if (!svg) return resolve(null);
    const m = svg.match(/width="(\d+)" height="(\d+)"/);
    if (!m) return resolve(null);
    const W = +m[1], H = +m[2], k = scale || 2;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = W * k; cv.height = H * k;
        const g = cv.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(img, 0, 0, cv.width, cv.height);
        resolve({ dataUrl: cv.toDataURL('image/png'), width: W * k, height: H * k });
      } catch { resolve(null); }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ── Flow chart cards on a section ────────────────────────────────────────────
function csFlowChartCardHtml(fl) {
  if (!fl) return '';
  if (!fl.uid) fl.uid = Math.random().toString(36).slice(2, 9);
  _csPendingFlows[fl.uid] = fl;
  const isLabel = fl.mode === 'label';
  const svg = csDfcSvg(fl, false);
  const emptyMsg = isLabel ? 'No diagram' : 'Empty chart';
  const icon = isLabel ? '🏷' : '🔀';
  const title = fl.title || (isLabel ? 'Labelled diagram' : 'Flow chart');
  const count = isLabel
    ? `${(fl.labels || []).length} label${(fl.labels || []).length === 1 ? '' : 's'}`
    : `${(fl.nodes || []).length} step${(fl.nodes || []).length === 1 ? '' : 's'}`;
  return `<div class="cs-fc-card" data-uid="${fl.uid}">
    <div class="cs-fc-card-wrap">
      <div class="cs-fc-card-thumb">${svg || `<span class="cs-fc-empty">${emptyMsg}</span>`}</div>
      <div class="cs-img-card-actions">
        <button class="btn btn-ghost btn-xs" onclick="csOpenFlowChart('${fl.uid}')" title="Edit">✏️</button>
        <button class="btn btn-danger btn-xs btn-icon" onclick="csRemoveFlowChart(this,'${fl.uid}')" title="Remove">✕</button>
      </div>
    </div>
    <div class="cs-img-layout-badge">${icon} ${esc(title)}</div>
    <div class="cs-img-cal-badge">${count}</div></div>`;
}

function csHydrateFlows() {
  const host = document.getElementById('cs-doc-secs');
  if (!host) { _csPendingFlows = {}; return; }
  host.querySelectorAll('.cs-fc-card').forEach(card => {
    const fl = _csPendingFlows[card.dataset.uid];
    if (fl) _csCardFlows.set(card, fl);
  });
  _csPendingFlows = {};
}

// Insert a chart at the cursor in whichever section the button belongs to.
function csAddFlowChart(btn) {
  const sec = btn.closest('.cs-sec');
  const ta = sec.querySelector('.cs-sec-b');
  const uid = Math.random().toString(36).slice(2, 9);
  const marker = `[FLOW:${uid}]`;
  const pos = (_csLastCursorSec === sec && _csLastCursorPos >= 0) ? _csLastCursorPos : ta.value.length;
  const pad = (pos > 0 && ta.value[pos - 1] !== '\n') ? '\n' : '';
  ta.value = ta.value.slice(0, pos) + pad + marker + '\n' + ta.value.slice(pos);
  _csLastCursorPos = pos + pad.length + marker.length + 1;

  const flow = { uid, title: '', mode: 'flow', bgImage: '', labels: [], nodes: [
    { id: 'n1', type: 'start', text: 'Start', branch: [] },
    { id: 'n2', type: 'decision', text: 'Decision?', mainLabel: 'No', branchLabel: 'Yes', branchDir: 'right', branch: [] },
    { id: 'n3', type: 'end', text: 'Commence work', branch: [] },
  ], png: '', pngTr: '' };
  sec.querySelector('.cs-fc-gallery').insertAdjacentHTML('beforeend', csFlowChartCardHtml(flow));
  const card = sec.querySelector(`.cs-fc-card[data-uid="${uid}"]`);
  _csCardFlows.set(card, flow);
  _csPendingFlows = {};
  csOpenFlowChart(uid);
}

function csRemoveFlowChart(btn, uid) {
  const card = btn.closest('.cs-fc-card');
  const sec = card.closest('.cs-sec');
  const ta = sec.querySelector('.cs-sec-b');
  if (uid && ta) ta.value = ta.value.replace(new RegExp(`\\n?\\[FLOW:${uid}\\]\\n?`), '\n');
  card.remove();
}

// ── Builder ──────────────────────────────────────────────────────────────────
function csOpenFlowChart(uid) {
  const card = document.querySelector(`.cs-fc-card[data-uid="${uid}"]`);
  if (!card) return;
  const flow = _csCardFlows.get(card);
  if (!flow) return;
  // Deep copy so Cancel really cancels.
  _dfcTarget = { card, flow, draft: JSON.parse(JSON.stringify(flow)) };
  _dfcTarget.draft.labels = _dfcTarget.draft.labels || [];
  _dfcLabelActive = -1; _dfcLabelDrag = null;
  const ti = document.getElementById('dfc-title');
  if (ti) ti.value = _dfcTarget.draft.title || '';
  showModal('flow-chart-modal');
  _dfcSetMode(_dfcTarget.draft.mode === 'label' ? 'label' : 'flow');
}

// Paths address a node: "2" is the 3rd spine node, "2/0" the 1st node of its branch.
function _dfcAt(path) {
  if (!_dfcTarget) return null;
  const parts = String(path).split('/').map(Number);
  let list = _dfcTarget.draft.nodes, node = null;
  for (const i of parts) {
    if (!list || !list[i]) return null;
    node = list[i];
    list = node.branch;
  }
  return node;
}
function _dfcParent(path) {
  const parts = String(path).split('/');
  const idx = +parts.pop();
  let list = _dfcTarget.draft.nodes;
  for (const p of parts) { const n = list[+p]; if (!n) return null; list = n.branch = n.branch || []; }
  return { list, idx };
}

const DFC_TYPES = [['start', 'Start (terminator)'], ['process', 'Process step'], ['decision', 'Decision'], ['end', 'End (terminator)']];

function _dfcRowHtml(n, path, depth) {
  const opts = DFC_TYPES.map(([v, l]) => `<option value="${v}"${n.type === v ? ' selected' : ''}>${l}</option>`).join('');
  let branch = '';
  if (n.type === 'decision') {
    const kids = (n.branch || []).map((c, i) => _dfcRowHtml(c, `${path}/${i}`, depth + 1)).join('');
    branch = `<div class="dfc-branch">
      <div class="dfc-branch-cfg">
        <label>Branch <input class="dfc-mini" value="${esc(n.branchLabel || '')}" placeholder="Yes" oninput="_dfcSet('${path}','branchLabel',this.value)"></label>
        <label>goes <select class="dfc-mini" onchange="_dfcSet('${path}','branchDir',this.value)">
          <option value="right"${n.branchDir !== 'left' ? ' selected' : ''}>right</option>
          <option value="left"${n.branchDir === 'left' ? ' selected' : ''}>left</option></select></label>
        <label>continue <input class="dfc-mini" value="${esc(n.mainLabel || '')}" placeholder="No" oninput="_dfcSet('${path}','mainLabel',this.value)"></label>
      </div>
      <div class="dfc-branch-kids">${kids}</div>
      <button type="button" class="btn btn-ghost btn-xs" onclick="_dfcAdd('${path}','process',true)">+ branch step</button>
    </div>`;
  }
  return `<div class="dfc-row dfc-d${Math.min(depth, 2)}">
    <div class="dfc-row-main">
      <select class="dfc-type" onchange="_dfcSet('${path}','type',this.value)">${opts}</select>
      <textarea class="dfc-txt" rows="2" placeholder="Text shown in the shape" oninput="_dfcSet('${path}','text',this.value)">${esc(n.text || '')}</textarea>
      <div class="dfc-row-btns">
        <button type="button" class="btn btn-ghost btn-xs" onclick="_dfcMove('${path}',-1)" title="Move up">↑</button>
        <button type="button" class="btn btn-ghost btn-xs" onclick="_dfcMove('${path}',1)" title="Move down">↓</button>
        <button type="button" class="btn btn-danger btn-xs btn-icon" onclick="_dfcDel('${path}')" title="Remove">✕</button>
      </div>
    </div>${branch}</div>`;
}

function _dfcRenderAll() {
  if (!_dfcTarget) return;
  const host = document.getElementById('dfc-nodes');
  if (host) host.innerHTML = _dfcTarget.draft.nodes.map((n, i) => _dfcRowHtml(n, String(i), 0)).join('');
  _dfcPreview();
}
function _dfcPreview() {
  const p = document.getElementById('dfc-preview');
  if (p && _dfcTarget) p.innerHTML = csDfcSvg(_dfcTarget.draft, false) || '<div class="dfc-empty">Add a step to see the chart.</div>';
}
// Text/label edits update the preview only — re-rendering the editor would lose focus.
function _dfcSet(path, key, v) {
  const n = _dfcAt(path);
  if (!n) return;
  n[key] = v;
  if (key === 'type') { n.branch = n.branch || []; _dfcRenderAll(); }
  else _dfcPreview();
}
function _dfcAdd(path, type, intoBranch) {
  if (!_dfcTarget) return;
  const node = { id: 'n' + Math.random().toString(36).slice(2, 7), type: type || 'process', text: '', branch: [],
    mainLabel: type === 'decision' ? 'No' : '', branchLabel: type === 'decision' ? 'Yes' : '', branchDir: 'right' };
  if (intoBranch) {
    const d = _dfcAt(path);
    if (!d) return;
    (d.branch = d.branch || []).push(node);
  } else {
    _dfcTarget.draft.nodes.push(node);
  }
  _dfcRenderAll();
}
function _dfcDel(path) {
  const p = _dfcParent(path);
  if (!p) return;
  p.list.splice(p.idx, 1);
  _dfcRenderAll();
}
function _dfcMove(path, d) {
  const p = _dfcParent(path);
  if (!p) return;
  const j = p.idx + d;
  if (j < 0 || j >= p.list.length) return;
  const [n] = p.list.splice(p.idx, 1);
  p.list.splice(j, 0, n);
  _dfcRenderAll();
}

async function csApplyFlowChart() {
  if (!_dfcTarget) return closeModal('flow-chart-modal');
  const { card, draft } = _dfcTarget;
  draft.title = (document.getElementById('dfc-title') || {}).value || '';
  if (draft.mode === 'label') {
    if (!draft.bgImage) { toast('Upload a diagram first, or switch to Decision flow.', 'error'); return; }
    // Drop callouts with no text — a leader line to nothing is meaningless.
    draft.labels = (draft.labels || []).filter(l => String(l.text || '').trim());
  }
  // Drop empty shapes — a box with no text says nothing in the document.
  const prune = list => (list || []).filter(n => String(n.text || '').trim())
    .map(n => Object.assign({}, n, { branch: prune(n.branch) }));
  draft.nodes = prune(draft.nodes || []);
  const png = await csDfcPng(draft, false);
  draft.png = png ? png.dataUrl : '';
  draft.pngW = png ? png.width : 0;
  draft.pngH = png ? png.height : 0;
  draft.pngTr = '';                          // English changed → any translated render is stale
  _csCardFlows.set(card, draft);
  card.outerHTML = csFlowChartCardHtml(draft);
  const fresh = document.querySelector(`.cs-fc-card[data-uid="${draft.uid}"]`);
  if (fresh) _csCardFlows.set(fresh, draft);
  _csPendingFlows = {};
  closeModal('flow-chart-modal');
  _dfcTarget = null;
  toast(draft.mode === 'label'
    ? `Labelled diagram saved — ${(draft.labels || []).filter(l => String(l.text || '').trim()).length} callout(s).`
    : `Flow chart saved — ${draft.nodes.length} step(s).`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// LABELLED-DIAGRAM MODE — upload a picture, then add point → leader-line → text
// callouts on its parts (like a classic labelled parts diagram). Stored on the same
// flow object so it reuses the flow chart's [FLOW:uid] marker, browser rasterisation
// and translation. label = { px, py, lx, ly, text, trans } — all coordinates are a
// PERCENTAGE of the image, so a callout stays on the part at any render size.
// ═══════════════════════════════════════════════════════════════════════════════
let _dfcLabelActive = -1;
let _dfcLabelDrag = null;    // { i, handle:'pt'|'lb' }

function csDfcLabelSvg(flow, tr) {
  if (!flow || !flow.bgImage) return null;
  const natW = flow.imgW || 1000, natH = flow.imgH || 750;
  const BW = 1000, BH = Math.round(BW * natH / natW);
  const esc2 = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const FS = Math.max(15, Math.round(BW * 0.019));
  const labels = (flow.labels || []).filter(l => l && String((tr && l.trans) ? l.trans : (l.text || '')).trim());
  const title = tr && flow.transTitle ? flow.transTitle : (flow.title || '');
  const topPad = title ? Math.round(FS * 2.2) : 0;
  const H = BH + topPad;

  let body = '';
  for (const l of labels) {
    const txt = (tr && l.trans) ? l.trans : (l.text || '');
    const lines = String(txt).split('\n');
    const px = l.px / 100 * BW, py = l.py / 100 * BH, lx = l.lx / 100 * BW, ly = l.ly / 100 * BH;
    const maxChars = Math.max(1, ...lines.map(s => s.length));
    const pw = maxChars * FS * 0.58 + 16, ph = lines.length * (FS * 1.3) + 8;
    body += `<line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${lx.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="${DFC.NAVY}" stroke-width="${(BW * 0.0022).toFixed(2)}"/>`
      + `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${(BW * 0.007).toFixed(1)}" fill="${DFC.NAVY}" stroke="#fff" stroke-width="1.6"/>`
      + `<rect x="${(lx - pw / 2).toFixed(1)}" y="${(ly - ph / 2).toFixed(1)}" width="${pw.toFixed(1)}" height="${ph.toFixed(1)}" rx="4" fill="#FFFFFF" stroke="${DFC.NAVY}" stroke-width="1.3"/>`;
    const startY = ly - (lines.length - 1) * (FS * 1.3) / 2 + FS * 0.34;
    lines.forEach((ln, i) => { body += `<text x="${lx.toFixed(1)}" y="${(startY + i * FS * 1.3).toFixed(1)}" text-anchor="middle" font-size="${FS}" font-weight="700" fill="${DFC.NAVY}">${esc2(ln)}</text>`; });
  }
  const titleSvg = title ? `<text x="${BW / 2}" y="${Math.round(FS * 1.5)}" text-anchor="middle" font-size="${Math.round(FS * 1.25)}" font-weight="700" fill="${DFC.NAVY}">${esc2(title)}</text>` : '';
  // href + xlink:href for maximum rasteriser compatibility (canvas path needs the image to load).
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${BW}" height="${H}" viewBox="0 0 ${BW} ${H}" font-family="Arial, Helvetica, sans-serif">`
    + `<rect width="${BW}" height="${H}" fill="#FFFFFF"/>`
    + `<image x="0" y="${topPad}" width="${BW}" height="${BH}" preserveAspectRatio="xMidYMid meet" href="${flow.bgImage}" xlink:href="${flow.bgImage}"/>`
    + titleSvg + `<g transform="translate(0,${topPad})">${body}</g></svg>`;
}

function _dfcSetMode(mode) {
  if (!_dfcTarget) return;
  _dfcTarget.draft.mode = mode;
  document.getElementById('dfc-mode-flow').classList.toggle('active', mode !== 'label');
  document.getElementById('dfc-mode-label').classList.toggle('active', mode === 'label');
  document.getElementById('dfc-flow-mode').style.display = mode === 'label' ? 'none' : '';
  document.getElementById('dfc-label-mode').style.display = mode === 'label' ? '' : 'none';
  if (mode === 'label') _dfcLabelRender(); else _dfcRenderAll();
}

function _dfcLabelUpload(input) {
  const f = input.files && input.files[0];
  input.value = '';
  if (!f || !_dfcTarget) return;
  const rd = new FileReader();
  rd.onload = e => {
    const url = e.target.result;
    const im = new Image();
    im.onload = () => {
      _dfcTarget.draft.bgImage = url;
      _dfcTarget.draft.imgW = im.naturalWidth || 1000;
      _dfcTarget.draft.imgH = im.naturalHeight || 750;
      _dfcLabelRender();
    };
    im.src = url;
  };
  rd.readAsDataURL(f);
}

function _dfcLabelLines() {
  if (!_dfcTarget) return;
  const svg = document.getElementById('dfc-label-lines');
  const labels = _dfcTarget.draft.labels || [];
  if (svg) svg.innerHTML = labels.map(l =>
    `<line x1="${l.px}%" y1="${l.py}%" x2="${l.lx}%" y2="${l.ly}%" stroke="#1E3A5F" stroke-width="2"/>`
    + `<circle cx="${l.px}%" cy="${l.py}%" r="3" fill="#1E3A5F"/>`).join('');
}

function _dfcLabelRender() {
  _dfcLabelBindStage();
  if (!_dfcTarget) return;
  const d = _dfcTarget.draft;
  d.labels = d.labels || [];
  const img = document.getElementById('dfc-label-img');
  const frame = document.getElementById('dfc-label-frame');
  const empty = document.getElementById('dfc-label-empty');
  if (d.bgImage) { img.src = d.bgImage; frame.style.display = ''; empty.style.display = 'none'; }
  else { frame.style.display = 'none'; empty.style.display = ''; }

  const mk = document.getElementById('dfc-label-markers');
  if (mk) mk.innerHTML = d.labels.map((l, i) => {
    const act = i === _dfcLabelActive ? ' active' : '';
    return `<div class="dfc-lm${act}" style="left:${l.px}%;top:${l.py}%"><div class="dfc-lm-pt" data-i="${i}" data-h="pt" onmousedown="_dfcLabelDown(event)"></div></div>`
      + `<div class="dfc-lm${act}" style="left:${l.lx}%;top:${l.ly}%"><div class="dfc-lm-lb" data-i="${i}" data-h="lb" onmousedown="_dfcLabelDown(event)" title="${esc(l.text || '')}">${esc(l.text || ('Label ' + (i + 1)))}</div></div>`;
  }).join('');
  _dfcLabelLines();

  const box = document.getElementById('dfc-label-list');
  if (box) box.innerHTML = d.labels.map((l, i) =>
    `<div class="dfc-row${i === _dfcLabelActive ? ' active' : ''}" data-i="${i}" onclick="_dfcLabelActivate(${i})"><div class="dfc-row-main">
       <textarea class="dfc-txt" rows="2" placeholder="Callout text (part name) — use a new line to wrap" oninput="_dfcLabelSetText(${i},this.value)">${esc(l.text || '')}</textarea>
       <button type="button" class="btn btn-danger btn-xs btn-icon" onclick="event.stopPropagation();_dfcLabelDel(${i})" title="Remove callout">✕</button>
     </div></div>`).join('');
}

function _dfcLabelBindStage() {
  const frame = document.getElementById('dfc-label-frame');
  if (!frame || frame._bound) return;
  frame._bound = true;
  const pct = e => {
    const r = frame.getBoundingClientRect();
    return { x: Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)),
             y: Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100)) };
  };
  // Click empty space → new callout: point where clicked, label offset toward nearest side.
  frame.addEventListener('click', e => {
    if (!_dfcTarget || e.target.closest('.dfc-lm')) return;
    const p = pct(e);
    const lx = p.x < 50 ? Math.max(8, p.x - 22) : Math.min(92, p.x + 22);
    _dfcTarget.draft.labels.push({ px: +p.x.toFixed(2), py: +p.y.toFixed(2), lx: +lx.toFixed(2), ly: +p.y.toFixed(2), text: '', trans: '' });
    _dfcLabelActive = _dfcTarget.draft.labels.length - 1;
    _dfcLabelRender();
    document.querySelector(`#dfc-label-list .dfc-txt[data-i]`); // noop keep lints calm
    const ta = document.querySelector(`#dfc-label-list .dfc-row[data-i="${_dfcLabelActive}"] .dfc-txt`);
    if (ta) ta.focus();
  });
  const move = e => {
    if (!_dfcLabelDrag || !_dfcTarget) return;
    const l = _dfcTarget.draft.labels[_dfcLabelDrag.i];
    if (!l) return;
    const p = pct(e);
    if (_dfcLabelDrag.handle === 'pt') { l.px = +p.x.toFixed(2); l.py = +p.y.toFixed(2); }
    else { l.lx = +p.x.toFixed(2); l.ly = +p.y.toFixed(2); }
    // Move just this marker + redraw lines (no full re-render, keeps drag smooth).
    const sel = _dfcLabelDrag.handle === 'pt' ? l.px + '%' : l.lx + '%';
    const wrap = document.querySelectorAll('#dfc-label-markers .dfc-lm')[_dfcLabelDrag.i * 2 + (_dfcLabelDrag.handle === 'pt' ? 0 : 1)];
    if (wrap) { wrap.style.left = (_dfcLabelDrag.handle === 'pt' ? l.px : l.lx) + '%'; wrap.style.top = (_dfcLabelDrag.handle === 'pt' ? l.py : l.ly) + '%'; }
    _dfcLabelLines();
    e.preventDefault();
  };
  const up = () => { _dfcLabelDrag = null; };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function _dfcLabelDown(e) {
  const h = e.target.closest('[data-h]');
  if (!h) return;
  _dfcLabelDrag = { i: +h.dataset.i, handle: h.dataset.h };
  _dfcLabelActivate(+h.dataset.i);
  e.preventDefault();
  e.stopPropagation();
}

function _dfcLabelActivate(i) {
  _dfcLabelActive = i;
  document.querySelectorAll('#dfc-label-markers .dfc-lm').forEach((el, idx) => el.classList.toggle('active', Math.floor(idx / 2) === i));
  document.querySelectorAll('#dfc-label-list .dfc-row').forEach(el => el.classList.toggle('active', +el.dataset.i === i));
}
function _dfcLabelSetText(i, v) {
  if (!_dfcTarget || !_dfcTarget.draft.labels[i]) return;
  _dfcTarget.draft.labels[i].text = v;
  // Update the on-image label chip live (without a full re-render that would blur the textarea).
  const chip = document.querySelectorAll('#dfc-label-markers .dfc-lm-lb')[i];
  if (chip) { chip.textContent = v || ('Label ' + (i + 1)); chip.title = v; }
}
function _dfcLabelDel(i) {
  if (!_dfcTarget) return;
  _dfcTarget.draft.labels.splice(i, 1);
  if (_dfcLabelActive >= _dfcTarget.draft.labels.length) _dfcLabelActive = -1;
  _dfcLabelRender();
}

function csFlowItemHtml(text){
  return `<div class="cs-flow-item"><input class="cs-flow-item-t" value="${esc(text||'')}" placeholder="Step / sub-item"><button type="button" class="cs-flow-x" onclick="this.closest('.cs-flow-item').remove()" title="Remove item">×</button></div>`;
}
function csFlowNoteHtml(text){
  return `<div class="cs-flow-note"><input class="cs-flow-note-t" value="${esc(text||'')}" placeholder="Note / pre-requisite"><button type="button" class="cs-flow-x" onclick="this.closest('.cs-flow-note').remove()" title="Remove note">×</button></div>`;
}
function csFlowStageHtml(st){
  st = st||{};
  const items = (Array.isArray(st.items)?st.items:[]).map(csFlowItemHtml).join('');
  return `<div class="cs-flow-stage">
    <div class="cs-flow-stage-head"><input class="cs-flow-stage-title" value="${esc(st.title||'')}" placeholder="Stage title">
      <button type="button" class="cs-flow-x" onclick="this.closest('.cs-flow-stage').remove()" title="Remove stage">🗑️</button></div>
    <div class="cs-flow-items">${items}</div>
    <button type="button" class="btn btn-ghost btn-sm cs-flow-add-item" onclick="csFlowItemAdd(this)">+ item</button>
  </div>`;
}
function csFlowHtml(fc, landscape){
  if(!fc || !Array.isArray(fc.stages)){
    return `<button type="button" class="btn btn-outline btn-sm cs-flow-addbtn" onclick="csFlowAdd(this)">➡️ Add stage pathway</button>`;
  }
  const stages = (fc.stages.length?fc.stages:[{}]).map(csFlowStageHtml).join('');
  const notes  = (Array.isArray(fc.notes)?fc.notes:[]).map(csFlowNoteHtml).join('');
  return `<div class="cs-flow">
    <div class="cs-flow-top">
      <span class="cs-flow-label">➡️ Stage pathway</span>
      <input class="cs-flow-title" value="${esc(fc.title||'')}" placeholder="Flowchart title">
      <label class="cs-flow-land"><input type="checkbox" class="cs-flow-landscape" ${landscape!==false?'checked':''}> Landscape page</label>
      <button type="button" class="btn btn-danger btn-sm" onclick="csFlowRemove(this)" title="Remove flowchart">Remove</button>
    </div>
    <div class="cs-flow-stages">${stages}</div>
    <button type="button" class="btn btn-outline btn-sm cs-flow-add-stage" onclick="csFlowStageAdd(this)">+ Stage</button>
    <div class="cs-flow-notes-wrap"><div class="cs-flow-notes-label">Notes</div>
      <div class="cs-flow-notes">${notes}</div>
      <button type="button" class="btn btn-ghost btn-sm" onclick="csFlowNoteAdd(this)">+ note</button>
    </div>
  </div>`;
}
function csFlowItemAdd(btn){ btn.previousElementSibling.insertAdjacentHTML('beforeend', csFlowItemHtml('')); }
function csFlowStageAdd(btn){ btn.previousElementSibling.insertAdjacentHTML('beforeend', csFlowStageHtml({items:['']})); }
function csFlowNoteAdd(btn){ btn.previousElementSibling.insertAdjacentHTML('beforeend', csFlowNoteHtml('')); }
function csFlowAdd(btn){ btn.outerHTML = csFlowHtml({ title:'', stages:[{title:'',items:['']}], notes:[] }, true); }
function csFlowRemove(btn){ const fl = btn.closest('.cs-flow'); fl.outerHTML = csFlowHtml(null, false); }
function csCollectFlowchart(secEl){
  const flow = secEl.querySelector('.cs-flow');
  if(!flow) return null;
  const title  = ((flow.querySelector('.cs-flow-title')||{}).value || '').trim();
  const stages = [...flow.querySelectorAll('.cs-flow-stage')].map(st=>({
    title: ((st.querySelector('.cs-flow-stage-title')||{}).value || '').trim(),
    items: [...st.querySelectorAll('.cs-flow-item-t')].map(i=>i.value.trim()).filter(Boolean)
  })).filter(st=>st.title || st.items.length);
  if(!stages.length) return null;
  const notes = [...flow.querySelectorAll('.cs-flow-note-t')].map(i=>i.value.trim()).filter(Boolean);
  return { title: title||undefined, stages, notes: notes.length?notes:undefined };
}

// ── Translation helpers ──────────────────────────────────────────────────────
let _csTransLayout = 'below';
let _csTransSideOrder = 'en-first'; // when Side layout: 'en-first' (English | Translation) or 'lang-first' (Translation | English)

function csTransHtml(t, lang, callouts, flows) {
  const ce = ' contenteditable="true"';
  let extras = '';
  // Translated flow charts — drawn from the same node data with the translated text.
  if (Array.isArray(flows) && flows.length) {
    const svgs = flows.map(fl => csDfcSvg(fl, true)).filter(Boolean);
    if (svgs.length) extras += `<div class="cs-trans-flows">${svgs.map(s => `<div class="cs-trans-flow">${s}</div>`).join('')}</div>`;
  }
  // Translated image callouts — read-only here; the text lives on the image object itself
  // (im.callouts[].trans), which is what gets saved and exported.
  if (Array.isArray(callouts) && callouts.length) {
    extras += `<div class="cs-trans-callouts"><div class="cs-trans-callouts-ttl">🏷 Image callouts</div>`
      + callouts.map(c => `<div class="cs-trans-cal-item"><span class="cs-trans-cal-n">${c.n}</span><span>${esc(c.text || '')}</span></div>`).join('')
      + `</div>`;
  }
  if (t.table && t.table.headers) {
    const riskCols = t.table.headers.map(csIsRiskHeader);
    const hdrs = t.table.headers.map(h=>`<th${ce}>${esc(h)}</th>`).join('');
    const rows = (t.table.rows||[]).map(r=>`<tr>${t.table.headers.map((_,i)=>{
      const v=(r||[])[i]||''; return `<td${ce}${csRiskCellStyle(v,riskCols[i])}>${esc(v)}</td>`;
    }).join('')}</tr>`).join('');
    extras += `<div class="cs-sec-table"><table class="cs-tbl-preview"><thead><tr>${hdrs}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  if (Array.isArray(t.checklist) && t.checklist.length) {
    extras += `<div class="cs-sec-checklist">${t.checklist.map(i=>`<span class="cs-cl-item">☐ <span class="cs-cl-text"${ce}>${esc(i)}</span></span>`).join('')}</div>`;
  }
  if (t.callout) extras += `<div class="cs-sec-callout"${ce}>${esc(t.callout)}</div>`;
  // Translated flowchart — read-only display; JSON persisted in data-flowchart for save round-trip
  let fcAttr = '', fcHtml = '';
  if (t.flowchart && Array.isArray(t.flowchart.stages) && t.flowchart.stages.length) {
    fcAttr = ` data-flowchart="${esc(JSON.stringify(t.flowchart))}"`;
    fcHtml = csFlowMiniHtml(t.flowchart);
  }
  return `<div class="cs-trans-block" data-lang="${esc(lang)}"${fcAttr}>
    <div class="cs-trans-header">
      <span class="cs-trans-badge">🌐 ${esc(lang)}</span>
      <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="this.closest('.cs-trans-block').remove()" title="Remove translation">✕</button>
    </div>
    <input class="cs-trans-h" value="${esc(t.heading||'')}" placeholder="Heading">
    <textarea class="cs-trans-b" rows="3">${esc(t.body||'')}</textarea>
    ${extras}${fcHtml}
  </div>`;
}

// Compact read-only flowchart render (used inside a translation block)
function csFlowMiniHtml(fc) {
  if (!fc || !Array.isArray(fc.stages) || !fc.stages.length) return '';
  let h = `<div class="cs-flow-mini"><div class="cs-flow-mini-h">🔀 ${esc(fc.title||'Flowchart')}</div><div class="cs-flow-mini-row">`;
  fc.stages.forEach((st, i) => {
    h += `<div class="cs-flow-mini-stage"><div class="cs-flow-mini-st-h">${esc(st.title||'')}</div>`;
    if (Array.isArray(st.items) && st.items.length) h += `<ul>${st.items.map(it=>`<li>${esc(String(it))}</li>`).join('')}</ul>`;
    h += `</div>`;
    if (i < fc.stages.length-1) h += `<span class="cs-flow-mini-arr">→</span>`;
  });
  h += `</div>`;
  if (Array.isArray(fc.notes) && fc.notes.length) h += `<div class="cs-flow-mini-notes">${fc.notes.map(n=>`• ${esc(String(n))}`).join('<br>')}</div>`;
  return h + `</div>`;
}

// AI assist for one page/section. Opens a modal where you can write an instruction and
// optionally attach an IMAGE to analyse and a REFERENCE FILE — the AI matches information
// across them (e.g. numbered dashboard items ↔ names in the list) and fills the table / adds
// content. Existing content is never overwritten — only blanks and genuine gaps are filled.
let _aaSec = null, _aaImgFileId = null, _aaRefFileId = null;

function csAssistSection(btn) {
  _aaSec = btn.closest('.cs-sec');
  if (!_aaSec) return;
  const orig = _aaSec.querySelector('.cs-sec-orig') || _aaSec;
  const tblEl = orig.querySelector('.cs-tbl-preview');
  let blanks = 0, cells = 0;
  if (tblEl) tblEl.querySelectorAll('tbody td').forEach(td => { cells++; if (!td.textContent.trim()) blanks++; });
  const heading = (orig.querySelector('.cs-sec-h') || {}).value || '(untitled section)';
  document.getElementById('aa-context').textContent = tblEl
    ? `Page: “${heading}”. This page has a table with ${blanks} blank cell(s) of ${cells}.`
    : `Page: “${heading}”. No table on this page — the AI can still add content.`;
  // Populate the "which rows" picker from the table's identification (first) column.
  const rowsWrap = document.getElementById('aa-rows-wrap');
  const rowsBox = document.getElementById('aa-rows');
  if (tblEl && rowsBox) {
    const trs = [...tblEl.querySelectorAll('tbody tr')];
    rowsBox.innerHTML = trs.map((tr, i) => {
      const first = (tr.querySelector('td') || {}).textContent || '';
      const label = first.trim() || `Row ${i + 1}`;
      return `<label class="aa-row-opt"><input type="checkbox" class="aa-row-cb" value="${i}"> <span>${esc(label)}</span></label>`;
    }).join('');
    rowsWrap.style.display = trs.length ? '' : 'none';
    document.getElementById('aa-mode-wrap').style.display = '';
  } else {
    if (rowsWrap) rowsWrap.style.display = 'none';
    document.getElementById('aa-mode-wrap').style.display = tblEl ? '' : 'none';
  }
  // reset mode + uploads + prompt
  const fillRadio = document.querySelector('input[name="aa-mode"][value="fill"]'); if (fillRadio) fillRadio.checked = true;
  _aaImgFileId = null; _aaRefFileId = null;
  ['aa-prompt'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  aaClear('img'); aaClear('ref');
  document.getElementById('aa-status').textContent = '';
  showModal('ai-assist-modal');
}

// ── AI-assist attachment uploads (image + reference file) ──────────────────────
function aaFileChosen(input, which) { const f = input.files[0]; input.value = ''; if (f) _aaUpload(f, which); }
function aaDrop(e, which) { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) _aaUpload(f, which); }
function aaClear(which) {
  if (which === 'img') _aaImgFileId = null; else _aaRefFileId = null;
  const info = document.getElementById(`aa-${which}-info`); if (info) { info.style.display = 'none'; info.innerHTML = ''; }
  const dz = document.getElementById(`aa-${which}-dz`); if (dz) dz.style.display = '';
}
async function _aaUpload(file, which) {
  const info = document.getElementById(`aa-${which}-info`);
  const dz = document.getElementById(`aa-${which}-dz`);
  const status = document.getElementById('aa-status');
  status.textContent = `⏳ Uploading ${which === 'img' ? 'image' : 'file'}…`;
  dz.style.display = 'none';
  try {
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch('/api/content/upload-source', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) { status.textContent = '❌ ' + (data.error || 'Upload failed'); dz.style.display = ''; return; }
    if (which === 'img') _aaImgFileId = data.fileId; else _aaRefFileId = data.fileId;
    status.textContent = '';
    info.innerHTML = `<span class="badge badge-success" style="font-size:12px">✓ ${esc(data.name)}</span>
      <button class="btn btn-ghost btn-sm" style="margin-left:8px" onclick="aaClear('${which}')">✕ Remove</button>`;
    info.style.display = '';
  } catch { status.textContent = '❌ Upload failed'; dz.style.display = ''; }
}

// Run the assist with the modal's instruction + attachments, and apply the result.
async function csAssistRun() {
  const sec = _aaSec;
  if (!sec) return closeModal('ai-assist-modal');
  const orig = sec.querySelector('.cs-sec-orig') || sec;
  const heading = (orig.querySelector('.cs-sec-h') || {}).value || '';
  const ta = orig.querySelector('.cs-sec-b');
  const body = (ta || {}).value || '';
  const tblEl = orig.querySelector('.cs-tbl-preview');
  let table = null;
  if (tblEl) table = {
    headers: [...tblEl.querySelectorAll('thead th')].map(th => th.textContent.trim()),
    rows: [...tblEl.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim())),
  };
  const prompt = (document.getElementById('aa-prompt') || {}).value || '';
  const updateMode = (document.querySelector('input[name="aa-mode"]:checked') || {}).value || 'fill';
  const targetRows = [...document.querySelectorAll('#aa-rows .aa-row-cb:checked')].map(c => parseInt(c.value, 10)).filter(n => !isNaN(n));
  if (!heading.trim() && !body.trim() && !table && !prompt.trim() && !_aaImgFileId && !_aaRefFileId)
    return toast('Add an instruction, an image/file, or use it on a page with a table.', 'error');
  const kbArticleIds = [...document.querySelectorAll('#cs-kb-list .cs-kb-cb:checked')].map(c => parseInt(c.value, 10)).filter(Boolean);
  const docTitle = val('cs-doc-title') || (csDraft && csDraft.data && csDraft.data.title) || '';
  const runBtn = document.getElementById('aa-run');
  const status = document.getElementById('aa-status');
  runBtn.disabled = true; const old = runBtn.textContent; runBtn.textContent = '⏳ Working…';
  status.textContent = '⏳ The AI is reading the page' + (_aaImgFileId ? ', the image' : '') + (_aaRefFileId ? ' and the reference file' : '') + '…';
  try {
    const r = await POST('/api/content/assist', { heading, body, table, docTitle, kbArticleIds, prompt, updateMode, targetRows, imageFileId: _aaImgFileId, refFileId: _aaRefFileId });
    if (!ok(r)) { status.textContent = ''; return; }
    let filled = 0, updated = 0, addedRows = 0, tableCreated = false;
    if (r.table && tblEl) {
      const tbody = tblEl.querySelector('tbody');
      const nCols = tblEl.querySelectorAll('thead th').length || 1;
      const isTarget = ri => targetRows.length === 0 || targetRows.includes(ri);
      const inRows = table.rows.length;
      (r.table.rows || []).forEach((row, ri) => {
        let tr = tbody.querySelectorAll('tr')[ri];
        if (!tr) {
          // AI returned MORE rows than the table has → add the new row.
          tr = document.createElement('tr');
          for (let i = 0; i < nCols; i++) { const td = document.createElement('td'); td.contentEditable = 'true'; td.setAttribute('onfocus', 'csTblFocus(this)'); tr.appendChild(td); }
          tbody.appendChild(tr);
          if (ri >= inRows) addedRows++;
        }
        const tds = [...tr.querySelectorAll('td')];
        (row || []).forEach((v, ci) => {
          if (!tds[ci]) return;
          const cur = tds[ci].textContent.trim();
          const nv = String(v == null ? '' : v).trim();
          if (ri >= inRows) { if (nv) tds[ci].textContent = nv; }                        // brand-new row → fill all
          else if (!isTarget(ri)) { /* row not selected → leave unchanged */ }
          else if (updateMode === 'update') { if (nv && nv !== cur) { tds[ci].textContent = nv; updated++; } }  // overwrite
          else if (!cur && nv) { tds[ci].textContent = nv; filled++; }                    // fill-blanks mode
        });
      });
    } else if (r.table && !tblEl && Array.isArray(r.table.headers) && r.table.headers.length && ta) {
      // The section had NO table and the AI built one (e.g. the user asked to "change the layout to a
      // table view"). Inject the table block right after the body so it renders and is saved/exported.
      ta.insertAdjacentHTML('afterend', csTableBlockHtml(r.table, true));
      tableCreated = true;
    }
    let added = false, bodyReplaced = false;
    if (typeof r.bodyReplace === 'string' && ta) {
      // The body was converted into the table — replace the prose with the AI's short intro (or clear it)
      // so the same content is not duplicated in both the body and the table.
      ta.value = r.bodyReplace.trim();
      bodyReplaced = true;
    } else if (r.bodyAddition && r.bodyAddition.trim() && ta) {
      ta.value = (ta.value.trim() ? ta.value.trim() + '\n\n' : '') + r.bodyAddition.trim();
      added = true;
    }
    closeModal('ai-assist-modal');
    const bits = [];
    if (tableCreated) bits.push('converted the layout to a table');
    if (filled) bits.push(`filled ${filled} blank cell(s)`);
    if (updated) bits.push(`updated ${updated} cell(s)`);
    if (addedRows) bits.push(`added ${addedRows} row(s)`);
    if (added) bits.push('added content');
    if (bodyReplaced && !tableCreated) bits.push('rewrote the content');
    if (!bits.length) toast('AI assist: nothing was changed — try a clearer instruction, or attach the image/file.', 'error');
    else toast('AI assist — ' + bits.join(', ') + '.');
  } catch (e) {
    status.textContent = '';
    toast('AI assist failed: ' + (e.message || 'try again'), 'error');
  } finally { runBtn.disabled = false; runBtn.textContent = old; }
}

async function csTranslateSection(btn, bulk) {
  const sec = btn.closest('.cs-sec');
  const lang = val('cs-trans-lang');
  if (!lang) { alert('Select a language in the Translate bar first.'); return 0; }
  const orig = sec.querySelector('.cs-sec-orig') || sec;
  const sectionData = {
    heading: (orig.querySelector('.cs-sec-h')||{}).value || null,
    body:    (orig.querySelector('.cs-sec-b')||{}).value || null,
    table: null, checklist: null, callout: null
  };
  const tblEl = orig.querySelector('.cs-tbl-preview');
  if (tblEl) sectionData.table = {
    headers: [...tblEl.querySelectorAll('thead th')].map(th=>th.textContent.trim()),
    rows:    [...tblEl.querySelectorAll('tbody tr')].map(tr=>[...tr.querySelectorAll('td')].map(td=>td.textContent.trim()))
  };
  const clTexts = [...orig.querySelectorAll('.cs-cl-text')].map(el=>el.textContent.trim()).filter(Boolean);
  if (clTexts.length) sectionData.checklist = clTexts;
  const coEl = orig.querySelector('.cs-sec-callout');
  if (coEl) sectionData.callout = coEl.textContent.trim() || null;
  const fc = csCollectFlowchart(sec);
  if (fc) sectionData.flowchart = fc;   // translate the flowchart's titles, items and notes too

  // Image callouts travel with the section so the point explanations are translated too.
  // Only the TEXT is sent — a flat array of strings. Sending the callout objects would let
  // the translator rewrite the uids and coordinates, which would break the markers.
  const calImgs = [];
  const calTexts = [];
  for (const card of orig.querySelectorAll('.cs-img-card')) {
    const im = _csCardImages.get(card);
    const cs = (im && Array.isArray(im.callouts)) ? im.callouts : [];
    if (!cs.length) continue;
    calImgs.push(im);
    cs.forEach(c => calTexts.push(c.text || ''));
  }
  if (calTexts.length) sectionData.imageCallouts = calTexts;

  // Flow charts: send the shape text and the branch labels as a flat array of strings, in
  // a fixed walk order. As with callouts, only text goes — sending the nodes themselves
  // would let the translator rewrite ids, types and directions and break the drawing.
  const flowEls = [...orig.querySelectorAll('.cs-fc-card')].map(c => _csCardFlows.get(c)).filter(Boolean);
  const flowTexts = [];
  const walkFlow = (list, fn) => (list || []).forEach(n => { fn(n); walkFlow(n.branch, fn); });
  for (const fl of flowEls) {
    flowTexts.push(fl.title || '');
    walkFlow(fl.nodes, n => {
      flowTexts.push(n.text || '');
      if (n.type === 'decision') { flowTexts.push(n.branchLabel || ''); flowTexts.push(n.mainLabel || ''); }
    });
    for (const l of (fl.labels || [])) flowTexts.push(l.text || '');   // labelled-diagram callouts
  }
  if (flowTexts.length) sectionData.flowChartText = flowTexts;

  btn.disabled = true; btn.textContent = '⏳';
  try {
    const kbArticleIds = [...document.querySelectorAll('#cs-kb-list .cs-kb-cb:checked')].map(c => parseInt(c.value, 10)).filter(Boolean);
    const r = await POST('/api/content/translate', { section: sectionData, targetLang: lang, kbArticleIds });
    if (!ok(r) || !r.translated) return bulk ? null : 0; // null lets Translate All detect + retry the failure

    // Write the translated callouts back onto the image objects (so they save and export),
    // and collect them for display. Positional match — only applied if the count is intact.
    const calDisp = [];
    const outCal = r.translated.imageCallouts;
    if (calTexts.length && Array.isArray(outCal) && outCal.length === calTexts.length) {
      let k = 0;
      for (const im of calImgs) {
        for (const c of im.callouts) {
          c.trans = String(outCal[k++] || '');
          if (c.kind !== 'leader') calDisp.push({ n: c.n, text: c.trans });   // leader text is on the image
        }
        // Re-burn a translated copy when the image carries leader callouts.
        if (im.callouts.some(c => c.kind === 'leader' && c.trans)) {
          im.annotatedTr = await csRenderAnnotatedImage(im, true);
        }
      }
    }

    // Same for the flow charts — write the translated text back onto each node, then
    // re-rasterise a TRANSLATED copy of the chart for the document's translation side.
    const outFlow = r.translated.flowChartText;
    if (flowTexts.length && Array.isArray(outFlow) && outFlow.length === flowTexts.length) {
      let k = 0;
      for (const fl of flowEls) {
        fl.transTitle = String(outFlow[k++] || '');
        walkFlow(fl.nodes, n => {
          n.trans = String(outFlow[k++] || '');
          if (n.type === 'decision') {
            n.transBranchLabel = String(outFlow[k++] || '');
            n.transMainLabel = String(outFlow[k++] || '');
          }
        });
        for (const l of (fl.labels || [])) l.trans = String(outFlow[k++] || '');
        const png = await csDfcPng(fl, true);
        fl.pngTr = png ? png.dataUrl : '';
        fl.pngTrW = png ? png.width : 0;
        fl.pngTrH = png ? png.height : 0;
      }
    }

    sec.querySelector('.cs-trans-block')?.remove();
    sec.insertAdjacentHTML('beforeend', csTransHtml(r.translated, lang, calDisp, flowEls));
    csApplyTransLayout();
    if (!bulk && r.glossaryTerms) toast(`Applied ${r.glossaryTerms} approved glossary term(s) for ${lang}.`);
    return r.glossaryTerms || 0;
  } finally { btn.disabled = false; btn.textContent = '🌐'; }
}

async function csTranslateAll() {
  const lang = val('cs-trans-lang');
  if (!lang) { alert('Select a language in the Translate bar first.'); return; }
  const allBtn = document.getElementById('cs-trans-all-btn');
  const btns = [...document.querySelectorAll('#cs-doc-secs .cs-sec-trans-btn')];
  if (!btns.length) return;
  if (allBtn) allBtn.disabled = true;
  // Each section translates independently, so run a few in parallel (a worker pool) instead of one at a
  // time. Concurrency is kept modest (3) because the corporate network intermittently RESETS streaming
  // connections under heavy parallelism ("terminated" errors); a failed section is retried once below.
  const CONCURRENCY = 3;
  let next = 0, done = 0, maxTerms = 0;
  const total = btns.length;
  const failedBtns = [];
  const label = (extra) => { if (allBtn) allBtn.textContent = `⏳ Translating… ${done}/${total}${extra || ''}`; };
  label();
  async function attempt(btn) {
    try { const c = await csTranslateSection(btn, true); if (c === null) return false; maxTerms = Math.max(maxTerms, c || 0); return true; }
    catch (e) { return false; }
  }
  async function worker() {
    while (next < btns.length) {
      const btn = btns[next++];
      if (!(await attempt(btn))) failedBtns.push(btn);
      done++; label();
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, btns.length) }, worker));
    // Retry sections that failed (usually a transient network reset) — up to 2 sequential passes, with a
    // short pause between, to ride out a burst of "terminated" / connection errors from the network.
    for (let pass = 1; pass <= 2 && failedBtns.length; pass++) {
      const retry = failedBtns.splice(0);
      label(` · retrying ${retry.length}`);
      await new Promise(r => setTimeout(r, 1500));
      for (const btn of retry) { if (!(await attempt(btn))) failedBtns.push(btn); }
    }
    if (failedBtns.length) toast(`Translated ${total - failedBtns.length}/${total} sections to ${lang}. ${failedBtns.length} still failed (network dropped the connection) — wait a moment and click 🌐 on those sections to retry.`, 'error');
    else toast(maxTerms ? `Translated all ${total} sections — enforced ${maxTerms} approved glossary term(s) for ${lang}.` : `Translated all ${total} sections to ${lang}.`);
  } finally {
    if (allBtn) { allBtn.disabled = false; allBtn.textContent = '🌐 Translate All'; }
    // Form (copy exactly): fold the fresh translations into the exact-copy WYSIWYG preview automatically.
    if (csDraft && csDraft.type === 'form-doc' && document.getElementById('cs-exact-doc')) csRefreshFormPreview();
  }
}

function csSetTransStatus(status) {
  const inp = document.getElementById('cs-meta-trans-status');
  if (inp) inp.value = status;
  document.querySelectorAll('.cs-trs-btn').forEach(btn => {
    const isUnderReview = btn.textContent.includes('Under Review');
    btn.classList.toggle('active', status === 'Under Review' ? isUnderReview : !isUnderReview);
  });
}

function csOnDocStatusChange(sel) {
  const row = document.getElementById('cs-trans-status-row');
  if (!row) return;
  row.style.display = sel.value === 'Approved' ? 'none' : '';
}

function csSetTransLayout(mode) {
  _csTransLayout = mode;
  csApplyTransLayout();
  document.getElementById('cs-tbl-above')?.classList.toggle('active', mode === 'above');
  document.getElementById('cs-tbl-below')?.classList.toggle('active', mode === 'below');
  document.getElementById('cs-tbl-side')?.classList.toggle('active', mode === 'side');
}

// Side layout only: which column comes first — English or the translation.
function csSetTransSideOrder(order) {
  _csTransSideOrder = order;
  csApplyTransLayout();
  document.getElementById('cs-ord-en')?.classList.toggle('active', order === 'en-first');
  document.getElementById('cs-ord-lang')?.classList.toggle('active', order === 'lang-first');
}

function csApplyTransLayout() {
  const secs = document.getElementById('cs-doc-secs');
  if (secs) {
    secs.classList.toggle('trans-side',  _csTransLayout === 'side');
    secs.classList.toggle('trans-above', _csTransLayout === 'above');
    secs.classList.toggle('trans-side-langfirst', _csTransLayout === 'side' && _csTransSideOrder === 'lang-first');
  }
  // The English/Translation column-order toggle only applies to the Side layout.
  const ord = document.getElementById('cs-trans-order');
  if (ord) ord.style.display = (_csTransLayout === 'side') ? 'inline-flex' : 'none';
}
function collectContentEdits(type) {
  if (type === 'exam') {
    return { testName: val('cs-exam-name'), passScore: parseInt(val('cs-exam-pass'))||80,
      questions: [...document.querySelectorAll('#cs-exam-qs .cs-q')].map(q=>({
        question: q.querySelector('.cs-q-text').value, type: q.querySelector('.cs-q-type').value,
        options: [...q.querySelectorAll('.cs-opt')].map(o=>({ text:o.querySelector('.cs-opt-t').value, correct:o.querySelector('.cs-opt-c').checked })).filter(o=>o.text.trim())
      })).filter(q=>q.question.trim()) };
  }
  // Excel register / tracker: collect columns (not vertical fields).
  if (type === 'excel-form' && document.getElementById('cs-reg-mode')) {
    const dashEl = document.getElementById('cs-reg-dashboard');
    return { name: val('cs-form-name'), layout: 'register',
      rowsToProvide: parseInt(val('cs-reg-rows'), 10) || 25,
      description: val('cs-reg-desc') || (csDraft && csDraft.data ? csDraft.data.description : '') || '',
      dashboard: !!(dashEl && dashEl.checked),
      columns: [...document.querySelectorAll('#cs-form-fields .cs-regcol')].map(x => {
        const opts = x.querySelector('.cs-rc-opts').value.split(',').map(s => s.trim()).filter(Boolean);
        return { label: x.querySelector('.cs-rc-label').value, options: opts.length ? opts : undefined };
      }).filter(c => c.label.trim()) };
  }
  if (type === 'form' || type === 'record-form' || type === 'training-request' || type === 'excel-form') {
    const out = { name: val('cs-form-name'),
      fields: [...document.querySelectorAll('#cs-form-fields .cs-field')].map(f=>{
        const opts = f.querySelector('.cs-f-opts').value.split(',').map(s=>s.trim()).filter(Boolean);
        return { type:f.querySelector('.cs-f-type').value, label:f.querySelector('.cs-f-label').value, options:opts.length?opts:undefined };
      }).filter(f=>f.label.trim()) };
    // Preserve record-form options so Save can emit a Word document (risk matrix / no training fields)
    // instead of the Form Builder. These are set at generate time and carried on csDraft.data.
    if (type === 'record-form' && csDraft && csDraft.data) {
      if (csDraft.data.includeRiskMatrix) out.includeRiskMatrix = true;
      if (csDraft.data.removedTraining)   out.removedTraining = true;
      if (csDraft.data.copiedLayout)      out.copiedLayout = true;
    }
    // Record-form: "Submit to" email → a Submit button in the HTML export; page orientation.
    if (type === 'record-form') {
      const se = document.getElementById('cs-rf-submit-email');
      if (se && se.value.trim()) out.submitEmail = se.value.trim();
      const lsEl = document.getElementById('cs-rf-landscape');
      out.orientation = (lsEl && lsEl.checked) ? 'landscape' : 'portrait';
    }
    return out;
  }
  const tocEl = document.getElementById('cs-opt-toc');
  const safetyEl = document.getElementById('cs-opt-safety');
  return { title: val('cs-doc-title'),
    fileName: val('cs-doc-filename') || val('cs-doc-title') || 'Document',
    docNumber: val('cs-doc-number'),
    transLayout: _csTransLayout,
    transSideOrder: _csTransSideOrder,
    // Training-Manual page options (checkboxes shown only for that type); preserve prior value otherwise.
    includeToc: tocEl ? tocEl.checked : (csDraft && csDraft.data ? csDraft.data.includeToc : undefined),
    includeSafetyPrompts: safetyEl ? safetyEl.checked : (csDraft && csDraft.data ? csDraft.data.includeSafetyPrompts : undefined),
    meta: {
      version:    val('cs-meta-version')    || '1.0',
      status:            val('cs-meta-status')      || 'Draft',
      transReviewStatus: val('cs-meta-status') !== 'Approved' && document.getElementById('cs-meta-trans-status')
                         ? (val('cs-meta-trans-status') || undefined) : undefined,
      preparedBy: val('cs-meta-prepared-by'),
      reviewedBy: val('cs-meta-reviewed-by'),
      approvedBy: val('cs-meta-approved-by'),
    },
    sections: [...document.querySelectorAll('#cs-doc-secs .cs-sec')].map(s=>{
      const x = s.dataset.extra ? JSON.parse(s.dataset.extra) : {};
      // Scope queries to original content (not translation block)
      const orig = s.querySelector('.cs-sec-orig') || s;
      const images = [...orig.querySelectorAll('.cs-img-card')].map(card => {
        const d = _csCardImages.get(card);
        const ni = card.querySelector('.cs-img-name-in');
        if (d && ni) d.caption = ni.value.trim();
        return d;
      }).filter(Boolean);
      const flows = [...orig.querySelectorAll('.cs-fc-card')].map(card => _csCardFlows.get(card)).filter(Boolean);
      // Read table/checklist/callout from live DOM within orig
      const tblEl = orig.querySelector('.cs-tbl-preview');
      const tableData = (tblEl && tblEl.querySelectorAll('thead th').length) ? {
        headers: [...tblEl.querySelectorAll('thead th')].map(th=>th.textContent.trim()),
        rows:    [...tblEl.querySelectorAll('tbody tr')].map(tr=>[...tr.querySelectorAll('td')].map(td=>td.textContent.trim()))
      } : (x.table||undefined);
      const clEls = [...orig.querySelectorAll('.cs-cl-text')].map(el=>el.textContent.trim()).filter(Boolean);
      const checklistData = clEls.length ? clEls : (x.checklist||undefined);
      // If a callout wrapper exists (always rendered now), trust the DOM as the source of truth —
      // an admin who deletes the callout intends it gone, so do NOT fall back to the original x.callout.
      const calloutEl = orig.querySelector('.cs-sec-callout');
      const hasWrap = !!orig.querySelector('.cs-sec-callout-wrap');
      const calloutData = calloutEl ? (calloutEl.textContent.trim()||undefined) : (hasWrap ? undefined : (x.callout||undefined));
      // Collect translation block if present
      const tb = s.querySelector('.cs-trans-block');
      let translation = undefined;
      if (tb) {
        const tLang = tb.dataset.lang;
        const tTbl = tb.querySelector('.cs-tbl-preview');
        const tTableData = (tTbl && tTbl.querySelectorAll('thead th').length) ? {
          headers: [...tTbl.querySelectorAll('thead th')].map(th=>th.textContent.trim()),
          rows:    [...tTbl.querySelectorAll('tbody tr')].map(tr=>[...tr.querySelectorAll('td')].map(td=>td.textContent.trim()))
        } : undefined;
        const tClEls = [...tb.querySelectorAll('.cs-cl-text')].map(el=>el.textContent.trim()).filter(Boolean);
        const tCallout = tb.querySelector('.cs-sec-callout');
        let tFlow = undefined;
        if (tb.dataset.flowchart) { try { tFlow = JSON.parse(tb.dataset.flowchart); } catch {} }
        translation = { lang: tLang,
          heading: (tb.querySelector('.cs-trans-h')||{}).value || '',
          body:    (tb.querySelector('.cs-trans-b')||{}).value || '',
          table:     tTableData,
          checklist: tClEls.length ? tClEls : undefined,
          callout:   tCallout ? (tCallout.textContent.trim()||undefined) : undefined,
          flowchart: tFlow };
      }
      const flowEl = s.querySelector('.cs-flow');
      const fcData = csCollectFlowchart(s);
      const landscapeData = flowEl ? !!((flowEl.querySelector('.cs-flow-landscape')||{}).checked) : (x.landscape||undefined);
      return { heading: orig.querySelector('.cs-sec-h').value, body: orig.querySelector('.cs-sec-b').value,
        level: x.level||1, table: tableData, checklist: checklistData,
        callout: calloutData, images: images.length ? images : undefined,
        flows: flows.length ? flows : undefined,
        flowchart: fcData||undefined, landscape: landscapeData||undefined,
        pageBreak: s.classList.contains('cs-sec--pagebreak') || undefined,
        risk: x.risk||undefined,
        translation };
    }).filter(s=>s.heading.trim()||s.body.trim()||s.flowchart||(s.flows&&s.flows.length)||s.table||(Array.isArray(s.checklist)&&s.checklist.length)||s.callout) };
}

const TS_TYPES = ['training-standards','policy','standard','plan','management-plan','strategy-plan','checklist'];

// Re-draw every callout image from its data with the CURRENT rendering code, so styling
// changes (size, side-by-side translation, colours) reach the saved/downloaded document
// without the user having to re-open and re-save each image's callouts.
async function csRebakeCalloutImages() {
  for (const card of document.querySelectorAll('#cs-doc-secs .cs-img-card')) {
    const im = _csCardImages.get(card);
    if (!im || !Array.isArray(im.callouts) || !im.callouts.length) continue;
    im.annotated = await csRenderAnnotatedImage(im, false);
    const needTr = im.callouts.some(c => c.kind === 'leader' && c.trans);
    im.annotatedTr = needTr ? await csRenderAnnotatedImage(im, true) : '';
  }
}

// Rasterise any flow charts that don't yet have a PNG (e.g. a flow the AI recreated from an uploaded
// document's flowchart) so the Word document embeds the drawn diagram rather than a text fallback.
async function csRasterizeFlows() {
  for (const card of document.querySelectorAll('#cs-doc-secs .cs-fc-card')) {
    const fl = _csCardFlows.get(card);
    if (!fl || (fl.png && fl.png.length)) continue;
    try {
      const png = await csDfcPng(fl, false);
      if (png) { fl.png = png.dataUrl; fl.pngW = png.width; fl.pngH = png.height; }
    } catch { /* fall back to the text outline of the flow */ }
  }
}

// Save the CURRENT work-in-progress WITHOUT the pre-save checks, and KEEP the editor open so
// the user can carry on. The first save files the document (to the chosen destination, default
// the Document Library) and remembers it; further saves update that same document in place.
// Resume later via 📝 Edit in the Document Library. The document does not have to be finished.
async function saveDraft() {
  if (!csDraft) return;
  const type = csDraft.type;
  const btn = document.getElementById('cs-savedraft-btn');
  const old = btn ? btn.textContent : '💾 Save progress';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving…'; }
  try {
    await csRebakeCalloutImages();
    await csRasterizeFlows();
    const data = collectContentEdits(type);
    if (csDraft.data && csDraft.data.sourceFileId && !data.sourceFileId) data.sourceFileId = csDraft.data.sourceFileId;
    if (csDraft.data && csDraft.data.isForm && !data.isForm) data.isForm = true;
    data.meta = Object.assign({ status: 'Draft' }, data.meta || {});   // mark in-progress (keeps an existing status)

    let r;
    if (csDraft.tsFileId) {
      r = await fetch(`/api/content/ts-doc/${csDraft.tsFileId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, data })
      }).then(res => res.json());
    } else {
      const destEl = document.getElementById('cs-dest');
      const destination = (destEl && destEl.value) || 'library';
      const materialCategory = (destination === 'training-material') ? (val('cs-dest-cat') || '') : undefined;
      r = await POST('/api/content/save', { type, data, destination, materialCategory });
      if (ok(r) && r.fileId) csDraft.tsFileId = r.fileId;
    }
    if (!ok(r)) return;
    csDraft.data = data;   // keep the in-memory draft in sync
    // Editor stays OPEN. Switch the main button to update-in-place and hide the destination picker.
    const saveBtn = document.getElementById('cs-save-btn');
    if (saveBtn && csDraft.tsFileId) saveBtn.textContent = '💾 Update Document';
    const destBar = document.querySelector('.cs-preview .cs-dest-bar'); if (destBar) destBar.style.display = 'none';
    toast('Progress saved — keep editing, or resume later from the Document Library (📝 Edit).');
    GET('/api/content/history').then(h => renderCSHistory(h || []));
  } catch (e) {
    toast('Could not save progress: ' + (e.message || 'try again'), 'error');
  } finally { if (btn) { btn.disabled = false; btn.textContent = old; } }
}

async function saveContent(skipCheck) {
  if (!csDraft) return;
  const type = csDraft.type;
  await csRebakeCalloutImages();            // refresh baked callouts before collecting
  await csRasterizeFlows();                 // rasterise any un-rendered flow charts for Word
  const data = collectContentEdits(type);
  // Form (exact copy): keep the source file reference AND the form marker so the server re-clones the
  // upload (exact layout, no metadata) and so re-opening it in Content Studio stays in form mode.
  if (csDraft.data && csDraft.data.sourceFileId && !data.sourceFileId) data.sourceFileId = csDraft.data.sourceFileId;
  if (csDraft.data && csDraft.data.isForm && !data.isForm) data.isForm = true;
  if (csDraft.data && csDraft.data.formScope && !data.formScope) data.formScope = csDraft.data.formScope; // copy only the selected form

  // AI layout check before saving/updating TS documents
  if (TS_TYPES.includes(type) && !skipCheck) {
    const proceed = await tsPreSaveCheck(data);
    if (!proceed) return;
  }

  let r;
  if (csDraft.tsFileId) {
    r = await fetch(`/api/content/ts-doc/${csDraft.tsFileId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, data })
    }).then(res => res.json());
  } else {
    const destEl = document.getElementById('cs-dest');
    const destination = destEl ? destEl.value : undefined;
    const materialCategory = (destination === 'training-material') ? (val('cs-dest-cat') || '') : undefined;
    // Replace-on-duplicate guard, scoped to where this content type is filed (exam / form / template form /
    // document library / training standards / training material). Cancel aborts so the user can rename.
    const nm = data.fileName || data.title || data.name || 'Untitled';
    let dupes = [], replace = null;
    if (type === 'exam') {
      const exs = (await GET('/api/exams/tests')) || [];
      dupes = exs.filter(t => _normName(t.TestName) === _normName(data.testName || nm));
      if (!confirmOverwrite(data.testName || nm, dupes, 'exam')) return;
      replace = async () => { for (const t of dupes) { try { await DEL('/api/exams/tests/' + t.TestID); } catch {} } };
    } else if (['form', 'training-request', 'record-form'].includes(type)) {
      const fms = (await GET('/api/forms/templates')) || [];
      dupes = fms.filter(t => _normName(t.Name) === _normName(data.name || nm));
      if (!confirmOverwrite(data.name || nm, dupes, 'form')) return;
      replace = async () => { for (const t of dupes) { try { await DEL('/api/forms/templates/' + t.TemplateID); } catch {} } };
    } else {
      const folder = (type === 'form-doc') ? 'template-forms'
        : (destination || (['training-standards', 'policy', 'standard', 'plan', 'checklist'].includes(type) ? 'training-standards' : 'library'));
      dupes = await fileDupes(nm, folder);
      if (!confirmOverwrite(nm, dupes, type === 'form-doc' ? 'template form' : 'document')) return;
      replace = async () => await deleteFileDupes(dupes, r && r.fileId);
    }
    r = await POST('/api/content/save', { type, data, destination, materialCategory });
    if (ok(r) && dupes.length && replace) await replace();
  }
  if (!ok(r)) return;

  let action = '';
  if (r.page === 'exam-builder') action = `<button class="btn btn-accent btn-sm" onclick="navigateTo('exam-builder')">Open Exam Builder →</button>`;
  else if (r.page === 'forms') action = `<button class="btn btn-accent btn-sm" onclick="navigateTo('forms')">Open Form Builder →</button>`;
  else if (r.fileId) action = `<a class="btn btn-accent btn-sm" href="/api/files/download/${r.fileId}">⬇ Download</a>`;
  if (r.folder === 'training-standards') action += ` <button class="btn btn-outline btn-sm" onclick="navigateTo('training-standards')">Open Training Standards →</button>`;
  else if (r.folder === 'training-material') action += ` <button class="btn btn-outline btn-sm" onclick="navigateTo('training-material')">Open Training Material →</button>`;
  else if (r.folder === 'library') action += ` <button class="btn btn-outline btn-sm" onclick="navigateTo('documents')">Open Document Library →</button>`;

  document.getElementById('cs-result').innerHTML = `<div class="alert alert-success"><span>✅</span><div>${esc(r.message||'Saved.')}<div class="mt-1 flex gap-2">${action}</div></div></div>`;
  document.getElementById('cs-regen').style.display = 'none';
  csDraft = null;
  toast(csDraft === null ? 'Saved.' : 'Updated.');
  GET('/api/content/history').then(h => renderCSHistory(h || []));
}

async function tsPreSaveCheck(data) {
  const summary = buildDocCheckSummary(data, csDraft.type);
  const btn = document.getElementById('cs-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Checking layout…'; }
  let result = null;
  try {
    result = await POST('/api/ai/doc-check', { summary });
  } catch (e) { /* skip check on error */ }
  if (btn) { btn.disabled = false; btn.textContent = csDraft && csDraft.tsFileId ? '💾 Update Document' : '✅ Save to Training Standards'; }

  if (!result || !result.issues || !result.issues.length) return true; // no issues — proceed

  // Normalise: derive sectionIndex from the issue title if the model didn't return one explicitly.
  result.issues.forEach(iss => {
    if (iss.sectionIndex == null) {
      const m = String(iss.title || '').match(/Section\s+(\d+)/i) || String(iss.detail || '').match(/Section\s+(\d+)/i);
      if (m) iss.sectionIndex = parseInt(m[1], 10);
    }
  });

  return new Promise(resolve => {
    const issueList = result.issues.map((iss, i) =>
      `<div data-iss-idx="${i}" data-sec-idx="${iss.sectionIndex || ''}" class="cs-iss-row" style="margin-bottom:8px;padding:9px 12px;background:var(--bg-soft,#f8fafc);border-left:3px solid ${iss.severity==='error'?'#ef4444':'#f59e0b'};border-radius:4px">
        <div style="font-weight:600;font-size:13px">${esc(iss.title)}</div>
        <div style="font-size:12px;color:var(--text-soft);margin-top:2px">${esc(iss.detail)}</div>
      </div>`).join('');
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center';
    el.innerHTML = `<div style="background:var(--bg,#fff);border-radius:10px;width:520px;max-width:92vw;box-shadow:0 8px 32px rgba(0,0,0,.18);overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border,#e5e7eb)">
        <h3 style="font-size:15px;font-weight:700;margin:0">⚠️ Layout Issues Found</h3>
      </div>
      <div style="padding:16px 20px;max-height:50vh;overflow-y:auto">${issueList}
        ${result.summary ? `<p style="margin-top:8px;font-size:12px;color:var(--text-soft)">${esc(result.summary)}</p>` : ''}
      </div>
      <div style="display:flex;gap:10px;padding:14px 20px;border-top:1px solid var(--border,#e5e7eb);justify-content:flex-end">
        <button id="ts-check-fix" class="btn btn-outline">Fix First</button>
        <button id="ts-check-save" class="btn btn-success">Save Anyway</button>
      </div>
    </div>`;
    document.body.appendChild(el);
    el.querySelector('#ts-check-fix').onclick  = () => { el.remove(); csShowFixPanel(result.issues); resolve(false); };
    el.querySelector('#ts-check-save').onclick = () => { el.remove(); resolve(true); };
  });
}

// Render the inline "Layout Issues — Fix These" panel above the preview and jump to the first flagged section.
function csShowFixPanel(issues) {
  const host = document.getElementById('cs-result') || document.body;
  // Remove any previous panel
  document.getElementById('cs-fix-panel')?.remove();

  const rows = issues.map((iss, i) => {
    const sec = iss.sectionIndex ? Number(iss.sectionIndex) : null;
    const tag = sec ? `<span class="cs-fix-tag">Section ${sec}</span>` : `<span class="cs-fix-tag cs-fix-tag-cover">Cover/Footer</span>`;
    const sev = iss.severity === 'error' ? 'err' : 'warn';
    return `<button type="button" class="cs-fix-row cs-fix-${sev}" data-sec="${sec || ''}" data-field="${esc(iss.field || '')}" data-iss="${i}">
      <span class="cs-fix-row-head">${tag}<span class="cs-fix-row-title">${esc(iss.title)}</span></span>
      <span class="cs-fix-row-detail">${esc(iss.detail)}</span>
    </button>`;
  }).join('');

  const panel = document.createElement('div');
  panel.id = 'cs-fix-panel';
  panel.className = 'cs-fix-panel';
  panel.innerHTML = `
    <div class="cs-fix-head">
      <div>
        <strong>⚠️ Layout issues to fix</strong>
        <span class="cs-fix-sub">Click an issue to jump to the section · re-click Save when ready</span>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" id="cs-fix-recheck">🔁 Re-check</button>
      <button type="button" class="btn btn-ghost btn-sm" id="cs-fix-dismiss" aria-label="Dismiss">✕</button>
    </div>
    <div class="cs-fix-list">${rows}</div>`;
  host.parentNode ? host.parentNode.insertBefore(panel, host) : document.body.appendChild(panel);

  panel.querySelectorAll('.cs-fix-row').forEach(btn => {
    btn.onclick = () => {
      const secIdx = parseInt(btn.dataset.sec, 10);
      const field  = btn.dataset.field || '';
      if (secIdx) csJumpToSection(secIdx, field);
      else csJumpToCoverField(field);
    };
  });
  panel.querySelector('#cs-fix-dismiss').onclick = () => panel.remove();
  panel.querySelector('#cs-fix-recheck').onclick = async () => {
    const data = collectContentEdits(csDraft.type);
    panel.remove();
    const proceed = await tsPreSaveCheck(data);
    if (proceed) saveContent(true);
  };

  // Jump to the first actionable section by default
  const firstSec = issues.find(i => i.sectionIndex);
  if (firstSec) setTimeout(() => csJumpToSection(firstSec.sectionIndex, firstSec.field || ''), 80);
  else setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);

  toast(`${issues.length} issue${issues.length===1?'':'s'} flagged — click each to jump to the section.`, 'warning');
}

function csJumpToSection(idx, field) {
  const secs = document.querySelectorAll('#cs-doc-secs .cs-sec');
  const target = secs[idx - 1];
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('cs-fix-flash');
  setTimeout(() => target.classList.remove('cs-fix-flash'), 2400);
  // Focus the relevant editor inside the section
  let focusEl = null;
  if (field === 'body')      focusEl = target.querySelector('.cs-sec-b');
  else if (field === 'table') focusEl = target.querySelector('.cs-tbl-preview td');
  else                        focusEl = target.querySelector('.cs-sec-b') || target.querySelector('.cs-sec-h');
  if (focusEl && focusEl.focus) setTimeout(() => { try { focusEl.focus({ preventScroll: true }); } catch {} }, 500);
}

function csJumpToCoverField(field) {
  const map = {
    approvedBy:     'cs-meta-approved-by',
    preparedBy:     'cs-meta-prepared-by',
    reviewedBy:     'cs-meta-reviewed-by',
    documentTitle:  'cs-doc-title',
    documentNumber: 'cs-doc-number',
  };
  const id = map[field];
  const el = id ? document.getElementById(id) : null;
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('cs-fix-flash');
    setTimeout(() => el.classList.remove('cs-fix-flash'), 2400);
    try { el.focus({ preventScroll: true }); } catch {}
  } else {
    // Generic cover fallback — scroll the cover/meta area into view
    (document.getElementById('cs-doc-title') || document.getElementById('cs-result'))
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ---- Training Standards ----
const TS_TYPE_META = {
  'training-standards': { icon: '📐', label: 'Training Standard', badge: 'badge-info' },
  policy:               { icon: '📜', label: 'Policy',             badge: 'badge-warning' },
  standard:             { icon: '🔧', label: 'Standard',           badge: 'badge-info' },
  plan:                 { icon: '🗓️', label: 'Plan / Program',     badge: 'badge-success' },
  checklist:            { icon: '☑️', label: 'Checklist',          badge: 'badge-info' },
};

async function loadTrainingStandards() {
  const docs = await GET('/api/content/ts-docs');
  const host = document.getElementById('ts-list');
  if (!host) return;
  if (!docs || !docs.length) {
    host.innerHTML = `<div class="alert alert-info"><span>ℹ️</span><div>No training standards documents yet. Use <strong>AI Content Studio</strong> to generate your first Policy, Standard, Plan, or Checklist.</div></div>`;
    return;
  }
  // group by type label (Category)
  const groups = {};
  for (const d of docs) {
    const cat = d.Category || 'Other';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(d);
  }
  const CAT_META = {
    'Training Standards Document': { icon: '📐', label: 'Training Standards', badge: 'badge-info' },
    'Policy':    { icon: '📜', label: 'Policies',    badge: 'badge-warning' },
    'Standard':  { icon: '🔧', label: 'Standards',   badge: 'badge-info' },
    'Plan':      { icon: '🗓️', label: 'Plans',       badge: 'badge-success' },
    'Checklist': { icon: '☑️', label: 'Checklists',  badge: 'badge-info' },
    // legacy names
    'Training Standards Document (AI draft)': { icon: '📐', label: 'Training Standards', badge: 'badge-info' },
    'Policy (AI draft)':    { icon: '📜', label: 'Policies',    badge: 'badge-warning' },
    'Standard (AI draft)':  { icon: '🔧', label: 'Standards',   badge: 'badge-info' },
    'Plan (AI draft)':      { icon: '🗓️', label: 'Plans',       badge: 'badge-success' },
    'Checklist (AI draft)': { icon: '☑️', label: 'Checklists',  badge: 'badge-info' },
  };
  let html = '';
  for (const [cat, items] of Object.entries(groups)) {
    const m = CAT_META[cat] || { icon: '📄', label: cat, badge: 'badge-info' };
    html += `<div class="mb-2"><div class="card-header" style="padding:10px 14px;border-radius:8px 8px 0 0">
      <h4 style="margin:0">${m.icon} ${m.label} <span class="badge ${m.badge}">${items.length}</span></h4></div>
      <div class="table-responsive"><table>
        <thead><tr><th>Document</th><th>Uploaded</th><th>By</th><th>Size</th><th></th></tr></thead>
        <tbody>${items.map(f => {
          const name = esc(f.FileName.replace(/ \(AI draft\)\.docx$/i, ''));
          const date = (f.UploadedDate || '').replace('T',' ').slice(0,16);
          const kb   = f.FileSize ? (f.FileSize / 1024).toFixed(0) + ' KB' : '—';
          const isAdmin = currentUser && currentUser.admin;
          const hasData = !!f.StructuredData;
          const previewBtn = hasData
            ? `<button class="btn btn-outline btn-sm" onclick="tsPreviewDoc(${f.FileID})" title="Preview document">👁 Open</button>`
            : `<button class="btn btn-outline btn-sm" disabled title="No preview — this document was uploaded manually, not generated by AI Content Studio">👁 Open</button>`;
          const editBtn = isAdmin
            ? (hasData
              ? `<button class="btn btn-outline btn-sm" onclick="tsEditDoc(${f.FileID})" title="Edit document">✏️ Edit</button>`
              : `<button class="btn btn-outline btn-sm" disabled title="Edit not available — this document was uploaded manually. Regenerate it via AI Content Studio to enable editing.">✏️ Edit</button>`)
            : '';
          const delBtn = isAdmin
            ? `<button class="btn btn-danger btn-sm btn-icon" onclick="tsDel(${f.FileID})" title="Delete document">🗑️</button>` : '';
          const statusBadge = f.Status ? ` ${csStatusBadge(f.Status)}` : '';
          return `<tr>
            <td><strong>${name}</strong>${statusBadge}${(f.Version && f.Version > 1) ? ` <span class="cs-gov-ver">v${f.Version}</span>` : ''}</td>
            <td class="cell-sub">${esc(date)}</td>
            <td class="cell-sub">${esc(f.UploadedBy || '—')}</td>
            <td class="cell-sub">${kb}</td>
            <td style="white-space:nowrap;display:flex;gap:4px;align-items:center">
              <a class="btn btn-ghost btn-sm" href="/api/files/download/${f.FileID}">⬇ Download</a>
              ${previewBtn}
              ${editBtn}
              ${delBtn}
            </td></tr>`;
        }).join('')}</tbody></table></div></div>`;
  }
  host.innerHTML = html;
}

async function tsDel(fileId) {
  if (!confirm('Delete this document? This cannot be undone.')) return;
  const r = await DEL('/api/files/' + fileId);
  if (ok(r)) { toast('Document deleted.'); loadTrainingStandards(); }
}

// ---- Training Material (folders/categories) ----
async function loadTrainingMaterial() {
  const [docs, cats] = await Promise.all([
    GET('/api/content/trainmat-docs'), GET('/api/content/trainmat-cats')
  ]);
  const host = document.getElementById('tm-list');
  if (!host) return;
  _docLibCache = _docLibCache || {};
  (docs || []).forEach(f => { _docLibCache[f.FileID] = f; }); // enable preview/edit
  const groups = {};
  for (const c of (cats || [])) groups[c.Name] = [];
  for (const d of (docs || [])) { (groups[d.Category] = groups[d.Category] || []).push(d); }
  const names = Object.keys(groups);
  const isAdmin = currentUser && currentUser.admin;
  let html = '';
  for (const cat of names) {
    const items = groups[cat] || [];
    html += `<div class="mb-2"><div class="card-header" style="padding:10px 14px;border-radius:8px 8px 0 0">
      <h4 style="margin:0">🗂️ ${esc(cat)} <span class="badge badge-info">${items.length}</span></h4></div>
      <div class="table-responsive"><table>
        <thead><tr><th>Document</th><th>Uploaded</th><th>By</th><th>Size</th><th></th></tr></thead>
        <tbody>`;
    if (!items.length) html += `<tr><td colspan="5" class="cell-sub">No documents in this folder yet.</td></tr>`;
    html += items.map(f => {
      const name = esc(f.FileName.replace(/ \(AI draft\)\.docx$/i, ''));
      const date = (f.UploadedDate || '').replace('T', ' ').slice(0, 16);
      const kb = f.FileSize ? (f.FileSize / 1024).toFixed(0) + ' KB' : '—';
      const hasData = !!f.StructuredData;
      return `<tr>
        <td><strong>${name}</strong></td>
        <td class="cell-sub">${esc(date)}</td>
        <td class="cell-sub">${esc(f.UploadedBy || '—')}</td>
        <td class="cell-sub">${kb}</td>
        <td style="white-space:nowrap;display:flex;gap:4px;align-items:center">
          <a class="btn btn-ghost btn-sm" href="/api/files/download/${f.FileID}">⬇ Download</a>
          ${hasData ? `<button class="btn btn-outline btn-sm" onclick="docLibPreview(${f.FileID})" title="Preview">👁 Open</button>` : ''}
          ${(isAdmin && hasData) ? `<button class="btn btn-outline btn-sm" onclick="docLibEditContent(${f.FileID})" title="Edit content">✏️ Edit</button>` : ''}
          ${isAdmin ? `<button class="btn btn-danger btn-sm btn-icon" onclick="tmDel(${f.FileID})" title="Delete">🗑️</button>` : ''}
        </td></tr>`;
    }).join('');
    html += `</tbody></table></div></div>`;
  }
  if (!names.length) html = `<div class="alert alert-info"><span>ℹ️</span><div>No Training Material folders yet.</div></div>`;
  if (isAdmin) html += `<button class="btn btn-outline btn-sm" onclick="tmAddFolder()">+ New folder</button>`;
  host.innerHTML = html;
}

async function tmAddFolder() {
  const name = (prompt('New Training Material folder name (e.g. CAT793, Dozer Training Material):') || '').trim();
  if (!name) return;
  const r = await POST('/api/content/trainmat-cats', { name });
  if (!ok(r)) return;
  _csTrainMatCats = r.cats || _csTrainMatCats;
  toast('Folder added.'); loadTrainingMaterial();
}

async function tmDel(fileId) {
  if (!confirm('Delete this document? This cannot be undone.')) return;
  const r = await DEL('/api/files/' + fileId);
  if (ok(r)) { toast('Document deleted.'); loadTrainingMaterial(); }
}

// ---- Training Material Covers ----
let _tcMaterials = [];
// Modern cover styling — shared by the live preview and the print popup
const TCV_STYLE = `
  .tcv-accent{position:absolute;top:0;left:0;right:0;height:10px;background:linear-gradient(90deg,#1E3A5F 0 70%,#FBC02D 70% 100%)}
  .tcv-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:8px}
  .tcv-brand{display:flex;align-items:center;gap:10px}
  .tcv-logo{max-height:58px;max-width:170px;object-fit:contain;display:block}
  .tcv-ref{display:flex;align-items:baseline;gap:12px;white-space:nowrap}
  .tcv-co{font-size:14px;font-weight:700;color:#1E3A5F}
  .tcv-docno{font-size:12px;color:#5A6072;font-weight:600;white-space:nowrap}
  .tcv-label{margin-top:36px;font-size:12px;font-weight:700;letter-spacing:.2em;color:#B7791F}
  .tcv-title{font-size:32px;line-height:1.15;font-weight:800;color:#1E3A5F;margin-top:6px}
  .tcv-sub{font-size:15px;color:#5A6072;margin-top:8px}
  .tcv-hero{margin:22px 0;border-radius:10px;overflow:hidden;background:#F6F7FB;border:1px solid #E3E7EF;text-align:center}
  .tcv-hero img{display:block;width:100%;max-height:330px;object-fit:contain;margin:0 auto}
  .tcv-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
  .tcv-chip{font-size:12px;color:#23272f;background:#EEF2F8;border:1px solid #D7DAE3;border-radius:999px;padding:5px 12px}
  .tcv-chip b{color:#1E3A5F}
  .tcv-overview{margin-top:20px}
  .tcv-oh{font-size:12.5px;font-weight:800;color:#1E3A5F;text-transform:uppercase;letter-spacing:.04em;border-left:4px solid #F58220;padding-left:8px;margin-bottom:6px}
  .tcv-overview p{font-size:13.5px;line-height:1.6;color:#23272f;white-space:pre-wrap}
  .tcv-foot{margin-top:28px;border-top:1px solid #D7DAE3;padding-top:8px;font-size:11px;color:#9CA3AF}
`;
function tcInjectStyle(){ if(!document.getElementById('tcv-style')){ const s=document.createElement('style'); s.id='tcv-style'; s.textContent=TCV_STYLE; document.head.appendChild(s); } }
async function loadTrainingCovers() {
  tcInjectStyle();
  // Covers can be built for any document (Library / Training Material / Training Standards), not just those
  // filed under Training Material — forCovers=1 returns that broader list (existing covers excluded).
  _tcMaterials = (await GET('/api/content/trainmat-docs?forCovers=1')) || [];
  const sel = document.getElementById('tc-material');
  if (!sel) return;
  // Exclude existing covers from the pick list
  const mats = _tcMaterials.filter(m => !/ — Cover\.docx$/i.test(m.FileName));
  sel.innerHTML = '<option value="">— select training material —</option>' +
    mats.map(m => `<option value="${m.FileID}">${esc(m.FileName.replace(/ \(AI draft\)\.docx$/i,'').replace(/\.docx$/i,''))} — ${esc(m.Category||'')}</option>`).join('');
  document.getElementById('tc-builder').style.display = 'none';
  const r = document.getElementById('tc-result'); if (r) r.textContent = '';
}

let _tcHeroImage = '';      // data URL (raster upload OR Claude-drawn SVG)
let _tcHeroIsRaster = false; // only raster images can be embedded in the .docx

function tcSelectMaterial() {
  const id = parseInt(val('tc-material'), 10);
  const builder = document.getElementById('tc-builder');
  if (!id) { builder.style.display = 'none'; return; }
  const mat = _tcMaterials.find(m => m.FileID === id);
  let data = {};
  try { data = mat && mat.StructuredData ? JSON.parse(mat.StructuredData) : {}; } catch {}
  const cleanName = (mat.FileName || '').replace(/ \(AI draft\)\.docx$/i, '').replace(/\.docx$/i, '');
  setVal('tc-title', data.title || cleanName);
  setVal('tc-sub', data.subtitle || (mat.Category ? mat.Category : ''));
  setVal('tc-docno', data.docNumber || '');
  setVal('tc-version', (data.meta && data.meta.version) || '1.0');
  setVal('tc-date', new Date().toISOString().slice(0, 10));
  setVal('tc-audience', '');
  setVal('tc-overview', '');
  setVal('tc-img-prompt', cleanName);
  _tcHeroImage = ''; _tcHeroIsRaster = false;
  builder.style.display = '';
  document.getElementById('tc-result').textContent = '';
  tcRenderPreview();
}

// Shared modern cover markup — used by both the live preview and the print popup
function tcCoverHtml() {
  const co = cache.company || {};
  const logo = co.logo ? `<img src="${co.logo}" class="tcv-logo" alt="">` : '';
  const hero = _tcHeroImage ? `<div class="tcv-hero"><img src="${_tcHeroImage}" alt=""></div>` : '';
  const folder = (_tcMaterials.find(m => m.FileID === parseInt(val('tc-material'), 10)) || {}).Category || '';
  const chips = [];
  if (folder) chips.push(['Folder', folder]);
  if (val('tc-version')) chips.push(['Version', val('tc-version')]);
  if (val('tc-date')) chips.push(['Date', val('tc-date')]);
  if (val('tc-audience')) chips.push(['Audience', val('tc-audience')]);
  return `<div class="tcv-accent"></div>
    <div class="tcv-head">
      <div class="tcv-brand">${logo}</div>
      <div class="tcv-ref">${co.name ? `<span class="tcv-co">${esc(co.name)}</span>` : ''}${val('tc-docno') ? `<span class="tcv-docno">${esc(val('tc-docno'))}</span>` : ''}</div>
    </div>
    <div class="tcv-label">TRAINING MATERIAL</div>
    <div class="tcv-title">${esc(val('tc-title') || 'Cover title')}</div>
    ${val('tc-sub') ? `<div class="tcv-sub">${esc(val('tc-sub'))}</div>` : ''}
    ${hero}
    ${chips.length ? `<div class="tcv-chips">${chips.map(([k, v]) => `<span class="tcv-chip"><b>${esc(k)}:</b> ${esc(v)}</span>`).join('')}</div>` : ''}
    ${val('tc-overview') ? `<div class="tcv-overview"><div class="tcv-oh">About this training material</div><p>${esc(val('tc-overview'))}</p></div>` : ''}
    <div class="tcv-foot">${co.name ? esc(co.name) + ' · ' : ''}Training Material Cover</div>`;
}

function tcRenderPreview() {
  const host = document.getElementById('tc-preview');
  if (host) host.innerHTML = tcCoverHtml();
}

function tcImgUpload(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) { toast('Image too large (max 8 MB).', 'error'); return; }
  const rd = new FileReader();
  rd.onload = () => { _tcHeroImage = rd.result; _tcHeroIsRaster = true; tcRenderPreview(); };
  rd.readAsDataURL(f);
  input.value = '';
}

async function tcGenImage(mode) {
  mode = (mode === 'photo') ? 'photo' : 'svg';
  const prompt = val('tc-img-prompt').trim();
  if (!prompt) { toast('Describe the equipment/image to generate.', 'error'); return; }
  const btnId = mode === 'photo' ? 'tc-img-photo-btn' : 'tc-img-gen-btn';
  const btn = document.getElementById(btnId);
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = mode === 'photo' ? '⏳ Generating photo…' : '⏳ Drawing…'; }
  try {
    const r = await POST('/api/content/cover-image', { prompt, mode });
    if (!ok(r)) return;
    _tcHeroImage = r.image; _tcHeroIsRaster = !!r.raster; // photos are raster (embed in .docx); SVG is not
    tcRenderPreview();
  } finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
}

function tcClearImage() { _tcHeroImage = ''; _tcHeroIsRaster = false; tcRenderPreview(); }

function printCover() {
  if (!val('tc-title').trim()) { toast('Enter a cover title.', 'error'); return; }
  const win = window.open('', '_blank', 'width=900,height=800');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(val('tc-title'))} — Cover</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  @page{size:A4 portrait;margin:0}
  body{font-family:'Inter',Arial,sans-serif;color:#23272f;background:#e8eaed;padding:20px}
  .tcv-page{position:relative;background:#fff;width:210mm;min-height:297mm;margin:0 auto;padding:26mm 24mm;overflow:hidden;box-shadow:0 3px 16px rgba(0,0,0,.3)}
  ${TCV_STYLE}
  @media print{body{background:#fff;padding:0}.tcv-page{box-shadow:none;margin:0}}
</style></head><body><div class="tcv-page">${tcCoverHtml()}</div>
<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},400);});<\/script>
</body></html>`);
  win.document.close(); win.focus();
}

async function tcBuildCover() {
  const title = val('tc-title');
  if (!title.trim()) { toast('Enter a cover title.', 'error'); return; }
  const body = {
    materialFileId: parseInt(val('tc-material'), 10) || null,
    title, subtitle: val('tc-sub'), docNumber: val('tc-docno'),
    version: val('tc-version'), date: val('tc-date'), audience: val('tc-audience'), overview: val('tc-overview'),
    heroImage: _tcHeroIsRaster ? _tcHeroImage : '' // only raster embeds in the .docx
  };
  // Replace-on-duplicate: covers are filed in Training Material as "<title> — Cover.docx".
  const coverName = `${title.replace(/[<>:"/\\|?*]+/g, '').trim() || 'Training Material'} — Cover.docx`;
  const dupes = await fileDupes(coverName, 'training-material');
  if (!confirmOverwrite(coverName.replace(/\.docx$/i, ''), dupes, 'cover')) return;
  const r = await POST('/api/content/cover', body);
  if (!ok(r)) return;
  if (dupes.length) await deleteFileDupes(dupes, r.fileId);
  const svgNote = (_tcHeroImage && !_tcHeroIsRaster) ? ' <span class="cell-sub">(AI illustration is on the printable cover; upload an image to include it in the .docx)</span>' : '';
  document.getElementById('tc-result').innerHTML = `✅ ${esc(r.message||'Cover built.')} <a class="btn btn-accent btn-sm" href="/api/files/download/${r.fileId}">⬇ Download</a> <button class="btn btn-outline btn-sm" onclick="navigateTo('training-material')">Open Training Material →</button>${svgNote}`;
  toast('Cover saved.');
}

// ---- Competency Certificates ----
// Certificate of Achievement — Akara theme (navy + gold), brown decorative ribbon corners, bilingual name/
// statement, two signatories, and an optional user-uploaded background image faded into the bottom-right.
const CERT_STYLE = `
  @import url('https://fonts.googleapis.com/css2?family=Great+Vibes&family=Cinzel:wght@600;700;800&family=Inter:wght@400;600;700;800&display=swap');
  .cert-bg-decor{position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none}
  .cert-userbg{position:absolute;right:0;bottom:0;width:58%;max-width:700px;z-index:0;pointer-events:none;opacity:.68;
    -webkit-mask-image:linear-gradient(135deg,rgba(0,0,0,0) 0%,rgba(0,0,0,0) 30%,#000 100%);mask-image:linear-gradient(135deg,rgba(0,0,0,0) 0%,rgba(0,0,0,0) 30%,#000 100%)}
  .cert-userbg img{width:100%;height:auto;display:block}
  .cert-frame{position:absolute;inset:16px;border:2px solid #123A63;z-index:1;pointer-events:none}
  .cert-frame:before{content:'';position:absolute;inset:5px;border:1px solid #C8912A;opacity:.75}
  .cert-logos{position:absolute;top:30px;right:46px;z-index:3;display:flex;align-items:center;gap:14px}
  .cert-logos img{max-height:74px;max-width:170px;object-fit:contain}
  .cert-body{position:relative;z-index:2;text-align:center;padding:30px 64px 0}
  .cert-title2{font-family:'Cinzel',serif;font-size:38px;font-weight:800;letter-spacing:.05em;color:#123A63;line-height:1.06;text-transform:uppercase}
  .cert-sub2{font-size:15px;color:#B8860B;margin-top:4px}
  .cert-title2-local{font-family:'Cinzel','Sarabun','Noto Sans Thai',serif;font-size:36px;font-weight:800;letter-spacing:.03em;color:#123A63;line-height:1.1;margin-top:4px}
  .cert-certify{font-family:'Cinzel',serif;font-size:13px;letter-spacing:.3em;color:#3a3a3a;text-transform:uppercase;margin-top:18px}
  .cert-orn{color:#C8912A;font-size:15px;letter-spacing:.4em;margin:5px 0 0}
  .cert-name-local{font-family:'Sarabun','Noto Sans Thai','Inter',Arial,sans-serif;font-size:40px;color:#123A63;font-weight:800;margin-top:8px;line-height:1.12}
  .cert-name2{font-family:'Cinzel',serif;font-size:32px;font-weight:800;color:#123A63;line-height:1.1;margin-top:2px;letter-spacing:.02em}
  .cert-bi-side{display:flex;align-items:baseline;justify-content:center;gap:10px;flex-wrap:wrap}
  .cert-bi-side>div{margin-top:0 !important}
  .cert-bi-dot{color:#C8912A;font-weight:700}
  .cert-rule2{height:1.4px;background:linear-gradient(90deg,transparent,#C8912A 20%,#C8912A 80%,transparent);max-width:470px;margin:8px auto 0}
  .cert-date2{font-size:13px;color:#333;margin-top:8px;font-family:'Inter',Arial,sans-serif}
  .cert-stmt2{font-family:'Cinzel',serif;font-size:16px;font-weight:700;color:#1c1c1c;max-width:82%;margin:16px auto 0;line-height:1.45;text-transform:uppercase;letter-spacing:.02em}
  .cert-stmt2-local{font-family:'Inter',Arial,sans-serif;font-size:13px;color:#444;max-width:82%;margin:7px auto 0;line-height:1.5}
  .cert-signs{position:relative;z-index:2;display:flex;justify-content:space-between;gap:48px;margin:22px 96px 0;font-family:'Inter',Arial,sans-serif}
  .cert-sig{flex:1;max-width:290px;text-align:center}
  .cert-sig-img{height:82px;display:flex;align-items:flex-end;justify-content:center;margin-bottom:2px}
  .cert-sig-img img{max-height:82px;max-width:300px;object-fit:contain}
  .cert-sig-line{border-bottom:1.4px solid #123A63}
  .cert-sig-name{font-weight:800;font-size:14px;color:#123A63;margin-top:7px;letter-spacing:.03em}
  .cert-sig-role{font-size:11px;color:#333;margin-top:2px;line-height:1.4}
  .cert-num2{position:absolute;left:0;right:0;bottom:20px;z-index:2;text-align:center;font-family:'Inter',Arial,sans-serif;font-size:10px;font-weight:600;color:#123A63;letter-spacing:.08em}
`;
function certInjectStyle(){ if(!document.getElementById('cert-style')){ const s=document.createElement('style'); s.id='cert-style'; s.textContent=CERT_STYLE; document.head.appendChild(s); } }

function loadCompetencyCerts(){
  certInjectStyle();
  if(!val('cert-issue')) setVal('cert-issue', new Date().toISOString().slice(0,10));
  // Draw-signature pads for the two signatories (draw-or-upload).
  initSigPad('cert1'); initSigPad('cert2');
  certRenderTransItems(); // per-item translate checkboxes + layout
  certLoadNextNumber();  // auto-fill the per-course certificate number
  loadCertLibrary();     // populate the Certificate Library list
  certRenderPreview();
}

// User-uploaded images held as data URLs (background watermark + optional signature images).
let _certBgImage = '', _certSig1 = '', _certSig2 = '';

// Gold + blue decorative ribbon flourishes in the four corners (Akara theme — layered navy blue and gold).
function certDecorSvg(){
  return `<svg class="cert-bg-decor" viewBox="0 0 1000 707" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="certBlue" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#0B2545"/><stop offset="1" stop-color="#1E5A9E"/>
      </linearGradient>
      <linearGradient id="certGold" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#B8860B"/><stop offset=".5" stop-color="#E8A400"/><stop offset="1" stop-color="#F5D98B"/>
      </linearGradient>
    </defs>
    <path d="M0 0 L250 0 C150 20 70 92 40 205 L0 258 Z" fill="url(#certBlue)"/>
    <path d="M0 0 L188 0 C110 18 55 78 34 168 L0 208 Z" fill="url(#certGold)"/>
    <path d="M0 0 L146 0 C88 15 44 62 27 132 L0 164 Z" fill="url(#certBlue)"/>
    <path d="M1000 0 L610 0 C820 18 930 82 980 215 L1000 268 Z" fill="url(#certBlue)"/>
    <path d="M1000 0 L706 0 C858 15 945 66 986 172 L1000 210 Z" fill="url(#certGold)"/>
    <path d="M1000 0 L772 0 C882 13 952 55 988 142 L1000 170 Z" fill="url(#certBlue)"/>
    <path d="M0 707 L232 707 C132 690 62 622 34 520 L0 468 Z" fill="url(#certBlue)"/>
    <path d="M0 707 L176 707 C102 692 50 638 30 556 L0 512 Z" fill="url(#certGold)"/>
    <path d="M0 707 L140 707 C84 694 46 648 28 576 L0 540 Z" fill="url(#certBlue)"/>
    <path d="M1000 707 L690 707 C838 690 928 628 980 512 L1000 460 Z" fill="url(#certBlue)"/>
    <path d="M1000 707 L748 707 C872 692 946 638 986 552 L1000 508 Z" fill="url(#certGold)"/>
    <path d="M1000 707 L800 707 C902 694 958 648 990 580 L1000 548 Z" fill="url(#certBlue)"/>
  </svg>`;
}

function certPrettyDate(s){
  if(!s) return '';
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d)) return s;
  return d.toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
}

// PER-ITEM translation: the user ticks each item to translate and picks where its translation sits
// (above / below / side). Un-ticked items are left English-only. Order (en-first/lang-first) applies to Side.
let _certTransOrder = 'en-first';
let _certRole1Local = '', _certRole2Local = '';  // translated signatory roles (not tied to a form input)
// Each item: key, label, the English text getter, and where its translation is stored (a form input id or
// one of the role vars). `on` = translate this item; `layout` = above|below|side.
const CERT_TRANS_ITEMS = [
  { key: 'title',     label: 'Certificate title',     en: () => val('cert-title'),       localInput: 'cert-sub-local' },
  { key: 'name',      label: 'Recipient name',        en: () => val('cert-trainee'),     localInput: 'cert-trainee-local' },
  { key: 'statement', label: 'Achievement statement', en: () => val('cert-statement'),   localInput: 'cert-statement-local' },
  { key: 'role1',     label: 'Signatory 1 role',      en: () => val('cert-sign1-role'),  localVar: 1 },
  { key: 'role2',     label: 'Signatory 2 role',      en: () => val('cert-sign2-role'),  localVar: 2 },
];
const _certTrans = {
  title:     { on: true,  layout: 'below' },
  name:      { on: false, layout: 'above' },
  statement: { on: true,  layout: 'below' },
  role1:     { on: false, layout: 'below' },
  role2:     { on: false, layout: 'below' },
};
function _certItemLocal(item){ return item.localVar ? (item.localVar === 1 ? _certRole1Local : _certRole2Local) : val(item.localInput); }
function _certSetItemLocal(item, text){
  if (item.localVar) { if (item.localVar === 1) _certRole1Local = text; else _certRole2Local = text; }
  else setVal(item.localInput, text);
}

// Arrange an English + translated line for one item, honouring that item's own layout (and global order for Side).
function certBilingual(itemKey, enClass, enText, localClass){
  const en = `<div class="${enClass}">${esc(enText)}</div>`;
  const cfg = _certTrans[itemKey] || { on: false, layout: 'below' };
  const item = CERT_TRANS_ITEMS.find(i => i.key === itemKey);
  const localText = (cfg.on && item) ? (_certItemLocal(item) || '') : '';
  if (!localText) return en;  // item not selected, or no translation → English only
  const local = `<div class="${localClass}">${esc(localText)}</div>`;
  if (cfg.layout === 'side') {
    const parts = _certTransOrder === 'lang-first' ? [local, en] : [en, local];
    return `<div class="cert-bi-side">${parts.join('<span class="cert-bi-dot">·</span>')}</div>`;
  }
  return cfg.layout === 'above' ? (local + en) : (en + local);
}

// Which signature to show for a signatory: an uploaded image wins; otherwise the drawn pad (if any).
function certSigData(n){
  const up = n === 1 ? _certSig1 : _certSig2;
  if (up) return up;
  const p = faSigPads && faSigPads['cert' + n];
  if (p && !p.isEmpty()) { try { return p.cv.toDataURL('image/png'); } catch { return ''; } }
  return '';
}

function certCertHtml(){
  const co = cache.company || {};
  const logo = co.logo ? `<img src="${co.logo}" alt="${esc(co.name||'Company logo')}">` : '';
  const title = val('cert-title') || 'CERTIFICATE OF ACHIEVEMENT';
  const subLocal = val('cert-sub-local');
  const nameEn = val('cert-trainee') || 'Recipient Name';
  const nameLocal = val('cert-trainee-local');
  const dateStr = certPrettyDate(val('cert-issue'));
  const stmtEn = val('cert-statement');
  const stmtLocal = val('cert-statement-local');
  const certNo = val('cert-number') || '';
  // Signatory block — the role line is bilingual per its own item config (role1 / role2).
  const sig = (roleKey, name, role, org, img) => `<div class="cert-sig">
      <div class="cert-sig-img">${img ? `<img src="${img}" alt="">` : ''}</div>
      <div class="cert-sig-line"></div>
      <div class="cert-sig-name">${esc(name || '')}</div>
      ${certBilingual(roleKey, 'cert-sig-role', role || '', 'cert-sig-role cert-sig-role-local')}
      ${org ? `<div class="cert-sig-role">${esc(org)}</div>` : ''}
    </div>`;
  const userBg = _certBgImage ? `<div class="cert-userbg"><img src="${_certBgImage}" alt=""></div>` : '';
  return `${certDecorSvg()}
   ${userBg}
   <div class="cert-frame"></div>
   ${logo ? `<div class="cert-logos">${logo}</div>` : ''}
   <div class="cert-body">
     ${certBilingual('title', 'cert-title2', title, 'cert-title2-local')}
     <div class="cert-certify">This is to certify that</div>
     <div class="cert-orn">✦ ❖ ✦</div>
     ${certBilingual('name', 'cert-name2', nameEn, 'cert-name-local')}
     <div class="cert-rule2"></div>
     ${dateStr ? `<div class="cert-date2">${esc(dateStr)}</div>` : ''}
     ${certBilingual('statement', 'cert-stmt2', stmtEn || '', 'cert-stmt2-local')}
   </div>
   <div class="cert-signs">
     ${sig('role1', val('cert-sign1-name'), val('cert-sign1-role'), val('cert-sign1-org'), certSigData(1))}
     ${sig('role2', val('cert-sign2-name'), val('cert-sign2-role'), val('cert-sign2-org'), certSigData(2))}
   </div>
   ${certNo ? `<div class="cert-num2">Certificate No: ${esc(certNo)}</div>` : ''}`;
}

// Build the per-item translation rows: [✓ translate] Item name  (Above / Below / Side).
function certRenderTransItems(){
  const host = document.getElementById('cert-trans-items');
  if (!host) return;
  host.innerHTML = CERT_TRANS_ITEMS.map(it => {
    const cfg = _certTrans[it.key];
    const btn = (m, lbl) => `<button type="button" class="btn btn-sm${cfg.layout === m ? ' active' : ''}" onclick="certSetItemLayout('${it.key}','${m}')">${lbl}</button>`;
    return `<div class="cert-trans-item">
      <label class="cert-trans-check"><input type="checkbox" ${cfg.on ? 'checked' : ''} onchange="certToggleItem('${it.key}',this.checked)"> ${esc(it.label)}</label>
      <div class="cert-trans-lay" style="${cfg.on ? '' : 'opacity:.4;pointer-events:none'}">${btn('above','⬆ Above')}${btn('below','⬇ Below')}${btn('side','⇔ Side')}</div>
    </div>`;
  }).join('');
}
function certToggleItem(key, on){ _certTrans[key].on = !!on; certRenderTransItems(); certRenderPreview(); }
function certSetItemLayout(key, layout){ _certTrans[key].layout = layout; certRenderTransItems(); certRenderPreview(); }
function certSetTransOrder(order){
  _certTransOrder = order;
  document.getElementById('cert-ord-en')?.classList.toggle('active', order === 'en-first');
  document.getElementById('cert-ord-lang')?.classList.toggle('active', order === 'lang-first');
  certRenderPreview();
}

// Capture a drawn signature pad into the certificate (draw-or-upload).
function certApplyPad(n){
  const p = faSigPads && faSigPads['cert' + n];
  if (!p || p.isEmpty()) { toast('Draw a signature in the box first, or use Upload image.', 'error'); return; }
  const d = p.cv.toDataURL('image/png');
  if (n === 1) _certSig1 = d; else _certSig2 = d;
  certRenderPreview();
  toast('Signature applied to the certificate.');
}

// Read an <input type=file> image as a data URL and hand it back.
function _certReadImg(input, cb){
  const f = input && input.files && input.files[0];
  if (!f) return;
  if (!/^image\//.test(f.type)) { toast('Please choose an image file (PNG/JPG).', 'error'); return; }
  const rd = new FileReader();
  rd.onload = () => cb(rd.result);
  rd.readAsDataURL(f);
}
function certSetBg(input){ _certReadImg(input, d => { _certBgImage = d; certRenderPreview(); }); }
function certClearBg(){ _certBgImage = ''; const el = document.getElementById('cert-bg-upload'); if (el) el.value = ''; certRenderPreview(); }
function certSetSig(input, n){ _certReadImg(input, d => { if (n === 1) _certSig1 = d; else _certSig2 = d; certRenderPreview(); }); }
function certClearSig(n){ if (n === 1) _certSig1 = ''; else _certSig2 = ''; const el = document.getElementById('cert-sig' + n + '-upload'); if (el) el.value = ''; const p = faSigPads && faSigPads['cert' + n]; if (p) p.clear(); certRenderPreview(); }

// Auto-number: fetch the next per-course sequence number and fill the (read-only) certificate number field.
async function certLoadNextNumber(){
  const course = (val('cert-course') || 'Certificate').trim();
  try {
    const r = await GET('/api/content/cert-next-number?course=' + encodeURIComponent(course));
    if (r && r.number) { setVal('cert-number', r.number); certRenderPreview(); }
  } catch {}
}

// Certificate Library — list saved certificates with download.
async function loadCertLibrary(){
  const tb = document.getElementById('cert-lib-tbody');
  if (!tb) return;
  const rows = (await GET('/api/content/certificates')) || [];
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="6" class="cell-sub">No certificates saved yet.</td></tr>'; return; }
  tb.innerHTML = rows.map(r => {
    let d = {}; try { d = JSON.parse(r.StructuredData || '{}'); } catch {}
    const no = d.docNumber || (d.seq != null ? '#' + d.seq : '');
    return `<tr>
      <td class="cell-strong">${esc((r.FileName || '').replace(/\.docx$/i, ''))}</td>
      <td>${esc(r.Category || '')}</td>
      <td>${esc(no)}</td>
      <td>${esc((r.UploadedDate || '').slice(0, 10))}</td>
      <td>${esc(r.UploadedBy || '')}</td>
      <td class="actions"><a class="btn btn-accent btn-sm" href="/api/files/download/${r.FileID}">⬇ Word</a></td>
    </tr>`;
  }).join('');
}

function certRenderPreview(){ const h=document.getElementById('cert-preview'); if(h) h.innerHTML=certCertHtml(); }

function certPrint(){
  if(!val('cert-trainee').trim() && !confirm('No trainee name entered — print anyway?')) return;
  const win = window.open('', '_blank', 'width=1100,height=800');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(val('cert-title'))}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  @page{size:A4 landscape;margin:0}
  body{font-family:'Inter',Arial,sans-serif;color:#23272f;background:#e8eaed;padding:20px}
  .cert-page{position:relative;background:#fff;width:297mm;min-height:210mm;margin:0 auto;padding:16mm 18mm;overflow:hidden;box-shadow:0 3px 16px rgba(0,0,0,.3)}
  ${CERT_STYLE}
  @media print{body{background:#fff;padding:0}.cert-page{box-shadow:none;margin:0}}
</style></head><body><div class="cert-page">${certCertHtml()}</div>
<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},400);});<\/script></body></html>`);
  win.document.close(); win.focus();
}

// Translate ONLY the ticked items, each into its own local slot, using the shared translation engine
// (approved terminology glossary). Un-ticked items are left untranslated (English only).
async function certTranslate(){
  const lang = val('cert-trans-lang');
  if (!lang) { toast('Select a language first.', 'error'); return; }
  const items = CERT_TRANS_ITEMS.filter(it => _certTrans[it.key].on && (it.en() || '').trim());
  if (!items.length) { toast('Tick at least one item to translate (with some text in it).', 'error'); return; }
  const btn = document.getElementById('cert-trans-btn');
  const status = document.getElementById('cert-trans-status');
  if (btn) btn.disabled = true;
  let done = 0; const total = items.length;
  const setStatus = () => { if (status) status.textContent = `⏳ Translating… ${done}/${total}`; };
  setStatus();
  let glossary = 0;
  try {
    // A small concurrency pool (like the other translators) — each item is one short request.
    await Promise.all(items.map(async it => {
      try {
        const r = await POST('/api/content/translate', { section: { body: (it.en() || '').trim() }, targetLang: lang });
        const tr = r && r.translated && r.translated.body;
        if (r && r.glossaryTerms) glossary = Math.max(glossary, r.glossaryTerms);
        if (tr) _certSetItemLocal(it, tr);
      } catch {}
      done++; setStatus();
    }));
    certRenderPreview();
    if (status) status.textContent = `✅ ${lang} · ${total} item(s)${glossary ? ` · ${glossary} glossary term(s)` : ''}`;
    toast(`Translated ${total} selected item(s) to ${lang}. Review, then Print/Build.`);
  } catch (e) {
    if (status) status.textContent = '';
    toast('Translate failed: ' + ((e && e.message) || e), 'error');
  } finally { if (btn) btn.disabled = false; }
}

async function certBuild(){
  const body = {
    title: val('cert-title'), statement: val('cert-statement'), statementLocal: val('cert-statement-local'),
    subtitleLocal: val('cert-sub-local'), course: val('cert-course') || 'Certificate',
    traineeName: val('cert-trainee'), traineeLocal: val('cert-trainee-local'), outcome: 'COMPETENT',
    issueDate: val('cert-issue'), certNumber: val('cert-number'), certId: val('cert-number'),
    sign1: { name: val('cert-sign1-name'), role: val('cert-sign1-role'), org: val('cert-sign1-org') },
    sign2: { name: val('cert-sign2-name'), role: val('cert-sign2-role'), org: val('cert-sign2-org') },
    // Old layout compatibility so the saved .docx still fills the two signature blocks
    assessor: val('cert-sign1-name'), supervisor: val('cert-sign2-name'),
    bgImage: _certBgImage || undefined, sign1Image: certSigData(1) || undefined, sign2Image: certSigData(2) || undefined
  };
  const r = await POST('/api/content/certificate', body);
  if(!ok(r)) return;
  document.getElementById('cert-result').innerHTML = `✅ ${esc(r.message||'Certificate saved.')} <a class="btn btn-accent btn-sm" href="/api/files/download/${r.fileId}">⬇ Download</a>`;
  toast(r.message || 'Certificate saved to the library.');
  loadCertLibrary();        // show it in the library
  certLoadNextNumber();     // advance the auto-number for the next certificate
}

const TS_CAT_TO_TYPE = {
  'Training Standards Document': 'training-standards',
  'Training Standards Document (AI draft)': 'training-standards',
  'Policy': 'policy', 'Policy (AI draft)': 'policy',
  'Standard': 'standard', 'Standard (AI draft)': 'standard',
  'Plan': 'plan', 'Plan (AI draft)': 'plan',
  'Checklist': 'checklist', 'Checklist (AI draft)': 'checklist',
};

async function tsPreviewDoc(fileId) {
  const docs = await GET('/api/content/ts-docs');
  const doc = docs && docs.find(d => d.FileID === fileId);
  if (!doc || !doc.StructuredData) { toast('No preview data for this document.', 'error'); return; }
  let data;
  try { data = JSON.parse(doc.StructuredData); } catch { toast('Could not parse document data.', 'error'); return; }
  // Temporarily set csDraft so buildDocPreviewHtml and aiPrePrintCheck work
  const prevDraft = csDraft;
  csDraft = { type: TS_CAT_TO_TYPE[doc.Category] || 'training-standards', data, tsFileId: fileId };
  document.getElementById('doc-preview-body').innerHTML = buildDocPreviewHtml(data);
  showModal('doc-preview-modal');
  // Restore draft if there was one active (unlikely but safe)
  if (!prevDraft) csDraft = { type: TS_CAT_TO_TYPE[doc.Category] || 'training-standards', data, tsFileId: fileId };
}

// ══════════════════════════════════════════════════════════════════════════════
// GOVERNANCE UI (R1 versions · R2 approval/publish) — surfaces the backend workflow
// in the Content Studio editor and the document libraries. All actions are also
// enforced server-side; the UI merely hides controls the user cannot use.
// ══════════════════════════════════════════════════════════════════════════════
function csCan(perm) {
  const u = currentUser || {};
  if (u.admin) return true;
  return Array.isArray(u.permissions) && u.permissions.includes(perm);
}
const CS_STATUS_META = {
  'Draft':        { cls: 'draft',    icon: '✏️', label: 'Draft' },
  'Under Review': { cls: 'review',   icon: '🔄', label: 'Under Review' },
  'Approved':     { cls: 'approved', icon: '✅', label: 'Approved' },
  'Published':    { cls: 'published',icon: '📢', label: 'Published' },
};
function csStatusBadge(status) {
  const m = CS_STATUS_META[status] || CS_STATUS_META['Draft'];
  return `<span class="cs-status-badge cs-status-${m.cls}" title="Document status">${m.icon} ${m.label}</span>`;
}
// Load + render the governance bar for the currently-edited saved document.
async function csLoadGovernance() {
  const bar = document.getElementById('cs-gov-bar');
  if (!bar || !csDraft || !csDraft.tsFileId) return;
  try {
    const g = await GET('/api/content/doc/' + csDraft.tsFileId + '/governance');
    if (!g || g.error) { bar.innerHTML = ''; return; }
    csDraft._gov = g;
    const st = g.Status || 'Draft';
    const canWrite = csCan('documents.write');
    const canPublish = csCan('documents.publish');
    const btns = [];
    // Lifecycle actions available from the current state.
    if ((st === 'Draft') && canWrite) btns.push(`<button class="btn btn-outline btn-sm" onclick="csDocStatus('submit')" title="Send for review">📤 Submit for review</button>`);
    if ((st === 'Draft' || st === 'Under Review') && canPublish) btns.push(`<button class="btn btn-success btn-sm" onclick="csDocStatus('approve')" title="Approve this document">✅ Approve</button>`);
    if (st === 'Approved' && canPublish) btns.push(`<button class="btn btn-success btn-sm" onclick="csDocStatus('publish')" title="Publish (release) this document">📢 Publish</button>`);
    if ((st === 'Approved' || st === 'Published' || st === 'Under Review') && canPublish) btns.push(`<button class="btn btn-outline btn-sm" onclick="csDocStatus('reject')" title="Return to Draft">↩ Return to Draft</button>`);
    const nVer = Array.isArray(g.versions) ? g.versions.length : 0;
    const verBtn = `<button class="btn btn-outline btn-sm" onclick="csOpenVersions()" title="View and restore previous versions">🕘 Versions${nVer ? ' (' + nVer + ')' : ''}</button>`;
    // Master / derived controls.
    const nDer = Array.isArray(g.derivatives) ? g.derivatives.length : 0;
    const deriveBtn = canWrite ? `<button class="btn btn-outline btn-sm" onclick="csOpenDerive()" title="Create an audience-adapted derived version linked to this document">🧬 Create derived version</button>` : '';
    // §21 — review changes: available for a derivative (vs its master) or when a source was used.
    const compareBtn = (g.MasterFileID || _csValueSourceId) ? `<button class="btn btn-outline btn-sm" onclick="csOpenCompare()" title="Side-by-side review of what changed vs the original, with accept/revert">🔍 Review changes</button>` : '';
    const derListBtn = nDer ? `<button class="btn btn-outline btn-sm" onclick="csOpenDerivatives()" title="View derived versions of this document">🧬 Derived (${nDer})</button>` : '';
    // Badges for a derivative: what it varies by, and whether its master has since changed.
    const derBadges = [];
    if (g.MasterFileID) {
      const vlabel = [g.DerivedProfile, g.DerivedDepth].filter(Boolean).join(' · ');
      derBadges.push(`<span class="cs-derived-badge" title="This is a derived version of another document">🧬 Derived${vlabel ? ' · ' + esc(vlabel) : ''}</span>`);
      if (g.MasterStale) derBadges.push(`<span class="cs-stale-badge" title="The master document was updated after this version was created — review required">⚠ Master updated — review</span>`);
    }
    const who = [];
    if (g.ApprovedBy) who.push('approved by ' + esc(g.ApprovedBy));
    if (g.PublishedBy) who.push('published by ' + esc(g.PublishedBy));
    bar.innerHTML = `${csStatusBadge(st)}
      <span class="cs-gov-ver">v${g.Version || 1}</span>
      ${derBadges.join(' ')}
      ${who.length ? `<span class="cs-gov-who">${who.join(' · ')}</span>` : ''}
      <span class="cs-gov-actions">${btns.join('')}${verBtn}${derListBtn}${deriveBtn}${compareBtn}</span>`;
  } catch { bar.innerHTML = ''; }
}
async function csDocStatus(action) {
  if (!csDraft || !csDraft.tsFileId) return;
  const labels = { submit: 'submit for review', approve: 'approve', publish: 'publish', reject: 'return to Draft' };
  if ((action === 'approve' || action === 'publish') && !confirm(`Are you sure you want to ${labels[action]} this document?`)) return;
  try {
    const r = await POST('/api/content/doc-status/' + csDraft.tsFileId, { action });
    if (r && r.status) { toast('Status: ' + r.status); await csLoadGovernance(); }
    else toast((r && r.error) || 'Action failed', 'error');
  } catch (e) { toast('Action failed: ' + e.message, 'error'); }
}
async function csOpenVersions() {
  if (!csDraft || !csDraft.tsFileId) return;
  const g = csDraft._gov || await GET('/api/content/doc/' + csDraft.tsFileId + '/governance');
  const vers = (g && g.versions) || [];
  const canWrite = csCan('documents.write');
  const rows = vers.length ? vers.map(v => `
    <tr>
      <td>v${v.Version}</td>
      <td>${esc(v.ChangedBy || '')}</td>
      <td>${esc((v.ChangedDate || '').replace('T', ' ').slice(0, 16))}</td>
      <td>${esc(v.ChangeNote || '')}</td>
      <td class="cs-ver-actions">
        <a class="btn btn-outline btn-sm" href="/api/content/doc-version/${v.VersionID}/download" title="Download this version">⬇</a>
        ${canWrite ? `<button class="btn btn-outline btn-sm" onclick="csRestoreVersion(${v.VersionID})" title="Restore this version as the current document">↺ Restore</button>` : ''}
      </td>
    </tr>`).join('') : `<tr><td colspan="5" class="cs-ver-empty">No previous versions yet. A snapshot is saved each time you update this document.</td></tr>`;
  const html = `<table class="cs-ver-tbl"><thead><tr><th>Version</th><th>By</th><th>When</th><th>Note</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  const bodyEl = document.getElementById('cs-versions-body');
  if (bodyEl) bodyEl.innerHTML = html;
  showModal('cs-versions-modal');
}
async function csRestoreVersion(versionId) {
  if (!confirm('Restore this version as the current document? The current version is snapshotted first, so this is reversible.')) return;
  try {
    const r = await POST('/api/content/doc-version/' + versionId + '/restore', {});
    if (r && r.success) {
      toast('Restored to v' + r.restoredFrom + ' (now v' + r.version + ', status Draft).');
      closeModal('cs-versions-modal');
      // Re-render the editor directly from the restored data returned by the server
      // (avoids stale library caches), then refresh the governance bar.
      if (r.data) {
        csDraft.data = r.data;
        document.getElementById('cs-result').innerHTML = renderContentPreview(csDraft.type, csDraft.data);
        if (typeof csHydrateImages === 'function') csHydrateImages();
        if (typeof csHydrateFlows === 'function') csHydrateFlows();
        if (typeof csApplyTransLayout === 'function') csApplyTransLayout();
      }
      await csLoadGovernance();
    } else toast((r && r.error) || 'Restore failed', 'error');
  } catch (e) { toast('Restore failed: ' + e.message, 'error'); }
}

// Open the "create derived version" dialog (audience-adapted variant linked to this master).
function csOpenDerive() {
  if (!csDraft || !csDraft.tsFileId) return;
  // §9 — multi-select reading levels: one derived version is created per checked level, each at the
  // chosen technical depth. Tick several to generate them all in one action.
  const lpChecks = (_csLearnOpts.learningProfiles || []).map(o =>
    `<label class="cs-derive-check"><input type="checkbox" class="cs-derive-lp" value="${esc(o.key)}"> ${esc(o.label)}</label>`).join('');
  const tdOpts = ['<option value="">— none —</option>'].concat(_csLearnOpts.techDepths ? _csLearnOpts.techDepths.map(o => `<option value="${esc(o.key)}">${esc(o.label)}</option>`) : []).join('');
  const body = document.getElementById('cs-derive-body');
  if (body) body.innerHTML = `
    <p class="text-soft" style="font-size:13px;margin-top:0">Creates a new document per selected audience, linked to this master, with the prose re-written for that audience. Tables, numbers, limits, images and safety facts are copied unchanged. Each saves as a <strong>Draft</strong> for review.</p>
    <div class="cs-derive-grid">
      <div><div class="cs-map-h">Reading / literacy level(s) <span class="text-soft" style="font-weight:400">— tick one or more</span></div>
        <div class="cs-derive-checks">${lpChecks || '<span class="text-soft">none</span>'}</div></div>
      <div><div class="cs-map-h">Technical depth <span class="text-soft" style="font-weight:400">(applies to all)</span></div>
        <select id="cs-derive-depth">${tdOpts}</select></div>
    </div>
    <div class="flex gap-2 mt-2">
      <button class="btn btn-accent" id="cs-derive-go" onclick="csCreateDerivative()">🧬 Create derived version(s)</button>
      <span id="cs-derive-status" class="cell-sub" style="align-self:center"></span>
    </div>`;
  showModal('cs-derive-modal');
}
async function csCreateDerivative() {
  const profiles = [...document.querySelectorAll('.cs-derive-lp:checked')].map(c => c.value);
  const techDepth = val('cs-derive-depth') || undefined;
  if (!profiles.length && !techDepth) { toast('Tick at least one reading level, or choose a technical depth.', 'error'); return; }
  // Build one variant per checked reading level (each with the chosen depth); if none ticked but a
  // depth is chosen, make a single depth-only variant.
  const variants = profiles.length
    ? profiles.map(p => ({ learningProfile: p, techDepth }))
    : [{ techDepth }];
  const st = document.getElementById('cs-derive-status');
  const go = document.getElementById('cs-derive-go');
  if (go) go.disabled = true;
  if (st) st.textContent = `⏳ Creating ${variants.length} version(s)… (~1–2 min each)`;
  try {
    const r = await POST('/api/content/derive-batch/' + csDraft.tsFileId, { variants, type: csDraft.type });
    if (r && r.success) {
      const nFlagged = (r.created || []).filter(c => c.valueCheck && !c.valueCheck.ok && c.valueCheck.critical && c.valueCheck.critical.length).length;
      let msg = `Created ${(r.created || []).length} derived version(s): ${(r.created || []).map(c => c.variant).join(', ')}.`;
      if (nFlagged) msg += ` ⚠ ${nFlagged} need value review.`;
      if (r.errors && r.errors.length) msg += ` ${r.errors.length} failed.`;
      toast(msg, nFlagged || (r.errors && r.errors.length) ? 'error' : 'success');
      closeModal('cs-derive-modal');
      await csLoadGovernance();
    } else { if (st) st.textContent = ''; toast((r && r.error) || 'Derive failed', 'error'); }
  } catch (e) { toast('Derive failed: ' + e.message, 'error'); }
  finally { if (go) go.disabled = false; }
}
async function csOpenDerivatives() {
  if (!csDraft || !csDraft.tsFileId) return;
  const rows = await GET('/api/content/derivatives/' + csDraft.tsFileId) || [];
  const body = document.getElementById('cs-derive-body');
  const list = rows.length ? `<table class="cs-ver-tbl"><thead><tr><th>Variant</th><th>Status</th><th>v</th><th></th></tr></thead><tbody>${rows.map(d => {
    const variant = [d.DerivedProfile, d.DerivedDepth].filter(Boolean).join(' · ') || '—';
    const stale = d.MasterStale ? ' <span class="cs-stale-badge">⚠ review</span>' : '';
    return `<tr><td>${esc(variant)}${stale}</td><td>${csStatusBadge(d.Status || 'Draft')}</td><td>v${d.Version || 1}</td>
      <td class="cs-ver-actions"><a class="btn btn-outline btn-sm" href="/api/files/download/${d.FileID}">⬇</a>
      <button class="btn btn-outline btn-sm" onclick="closeModal('cs-derive-modal');csOpenDocById(${d.FileID})">✏️ Open</button></td></tr>`;
  }).join('')}</tbody></table>` : `<p class="cs-ver-empty">No derived versions yet.</p>`;
  if (body) body.innerHTML = list;
  showModal('cs-derive-modal');
}

// Open any editable document by FileID (used for derivatives / linked docs) via the
// generic doc-data endpoint, so it works regardless of which library it lives in.
async function csOpenDocById(fileId) {
  const r = await GET('/api/content/doc-data/' + fileId);
  if (!r || r.error || !r.data) { toast((r && r.error) || 'Could not open document.', 'error'); return; }
  const type = (typeof docLibType === 'function' ? docLibType(r.category) : null)
            || (typeof TS_CAT_TO_TYPE !== 'undefined' && TS_CAT_TO_TYPE[r.category]) || 'sop';
  csDraft = { type, data: r.data, tsFileId: fileId };
  _csLastEditSource = () => csOpenDocById(fileId);
  navigateTo('content-studio');
}

async function tsEditDoc(fileId) {
  _csLastEditSource = tsEditDoc;
  const docs = await GET('/api/content/ts-docs');
  const doc = docs && docs.find(d => d.FileID === fileId);
  if (!doc || !doc.StructuredData) { toast('No editable data for this document.', 'error'); return; }
  let data;
  try { data = JSON.parse(doc.StructuredData); } catch { toast('Could not parse document data.', 'error'); return; }
  const type = TS_CAT_TO_TYPE[doc.Category] || 'training-standards';
  csDraft = { type, data, tsFileId: fileId };
  // navigateTo triggers loadContentStudio which now checks csDraft and renders the preview
  navigateTo('content-studio');
  toast(`Loaded "${doc.FileName.replace(/ \(AI draft\)\.docx$/i, '')}" for editing.`);
}

// ---- Analytics ----
let _anCharts = {};
function destroyAnChart(id) { if (_anCharts[id]) { _anCharts[id].destroy(); delete _anCharts[id]; } }

async function loadAnalytics() {
  const d = await GET('/api/analytics');
  if (!d) return;

  // Summary tiles
  const { summary } = d;
  const compStr = summary.complianceRate != null ? summary.complianceRate + '%' : '—';
  document.getElementById('an-stats').innerHTML = [
    { n: summary.employees,        l: 'Active Employees',      cls: '' },
    { n: summary.completionsMonth, l: 'Completions This Month', cls: 'green' },
    { n: summary.expiring30,       l: 'Expiring in 30 Days',    cls: summary.expiring30 > 0 ? 'amber' : '' },
    { n: compStr,                  l: 'Compliance Rate',        cls: summary.complianceRate >= 80 ? 'green' : summary.complianceRate != null ? 'amber' : '' }
  ].map(t => `<div class="stat-card${t.cls?' stat-'+t.cls:''}"><div class="stat-num">${t.n}</div><div class="stat-label">${t.l}</div></div>`).join('');

  const PALETTE = ['#4f46e5','#10b981','#f59e0b','#ef4444','#6366f1','#0ea5e9','#ec4899','#84cc16','#f97316','#14b8a6'];

  // Monthly completions bar chart
  destroyAnChart('monthly');
  const mCtx = document.getElementById('chart-an-monthly');
  if (mCtx) {
    _anCharts.monthly = new Chart(mCtx, {
      type: 'bar',
      data: {
        labels: d.monthly.map(m => { const [y,mo] = m.month.split('-'); return new Date(y,mo-1).toLocaleString('default',{month:'short',year:'2-digit'}); }),
        datasets: [{ label: 'Completions', data: d.monthly.map(m => m.completions), backgroundColor: '#4f46e5', borderRadius: 4 }]
      },
      options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
  }

  // Training type doughnut
  destroyAnChart('type');
  const tCtx = document.getElementById('chart-an-type');
  if (tCtx && d.byType.length) {
    _anCharts.type = new Chart(tCtx, {
      type: 'doughnut',
      data: {
        labels: d.byType.map(t => t.TrainType),
        datasets: [{ data: d.byType.map(t => t.completions), backgroundColor: PALETTE }]
      },
      options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { position: 'bottom' } } }
    });
  } else if (tCtx) { tCtx.closest('.chart-box').innerHTML = '<p class="cell-sub" style="padding:16px">No data yet.</p>'; }

  // By dept horizontal bar
  destroyAnChart('dept');
  const dCtx = document.getElementById('chart-an-dept');
  if (dCtx && d.byDept.length) {
    _anCharts.dept = new Chart(dCtx, {
      type: 'bar',
      data: {
        labels: d.byDept.map(r => r.Department),
        datasets: [{ label: 'Completions', data: d.byDept.map(r => r.completions), backgroundColor: '#10b981', borderRadius: 4 }]
      },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
  } else if (dCtx) { dCtx.closest('.chart-box').innerHTML = '<p class="cell-sub" style="padding:16px">No data yet.</p>'; }

  // Top courses horizontal bar
  destroyAnChart('courses');
  const cCtx = document.getElementById('chart-an-courses');
  if (cCtx && d.topCourses.length) {
    _anCharts.courses = new Chart(cCtx, {
      type: 'bar',
      data: {
        labels: d.topCourses.map(r => r.CertName.length > 30 ? r.CertName.slice(0,28)+'…' : r.CertName),
        datasets: [{ label: 'Attendances', data: d.topCourses.map(r => r.attendances), backgroundColor: '#f59e0b', borderRadius: 4 }]
      },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
  } else if (cCtx) { cCtx.closest('.chart-box').innerHTML = '<p class="cell-sub" style="padding:16px">No data yet.</p>'; }

  // Recent completions table
  const recEl = document.getElementById('an-recent');
  if (recEl) {
    if (!d.recentCompletions.length) { recEl.innerHTML = '<p class="cell-sub">No completions recorded yet.</p>'; }
    else recEl.innerHTML = `<div class="table-responsive"><table>
      <thead><tr><th>Employee</th><th>Course</th><th>Completed</th></tr></thead>
      <tbody>${d.recentCompletions.map(r=>`<tr><td>${esc(r.empName)}</td><td>${esc(r.CertName)}</td><td class="cell-sub">${esc(r.Complete||'')}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }
}

// ---- AI Document Translator ----
let trLangs = [];
async function loadTranslator() {
  const [langs, sources, jobs, tmStats, metrics] = await Promise.all([
    GET('/api/translator/languages'), GET('/api/translator/sources'), GET('/api/translator/jobs'), GET('/api/translator/tm-stats'), GET('/api/translator/metrics')
  ]);
  renderTrMetrics(metrics);
  trLangs = langs || [];
  const langOpts = trLangs.map(l => `<option value="${l.code}">${esc(l.name)}</option>`).join('');
  document.getElementById('tr-lang').innerHTML = langOpts;
  document.getElementById('term-lang').innerHTML = langOpts;
  document.getElementById('term-filter').innerHTML = '<option value="">All languages</option>' + langOpts;
  if (sources) document.getElementById('tr-source').innerHTML = '<option value="">-- Select a file --</option>' +
    sources.map(s => `<option value="${s.FileID}">${esc(s.FileName)}</option>`).join('');
  renderTrJobs(jobs || []);
  // Translation memory summary
  const byCode = {}; trLangs.forEach(l => byCode[l.code] = l.name);
  const stats = (tmStats || []).map(s => `${esc(byCode[s.LangCode]||s.LangCode)}: ${s.approved||0}/${s.total}`).join(' · ');
  document.getElementById('tr-tmstats').textContent = stats ? '🧠 Translation memory — ' + stats + ' (approved/total)' : '';
  loadTerms();
}

function renderTrMetrics(m) {
  const host = document.getElementById('tr-metrics');
  if (!host || !m) { if (host) host.innerHTML = ''; return; }
  const tile = (n, l, cls) => `<div class="tr-tile ${cls||''}"><span class="n">${n}</span><span class="l">${l}</span></div>`;
  const rows = (m.byLang || []).map(b => `<tr>
      <td class="cell-strong">${esc(b.language)}</td>
      <td>${b.jobs} <span class="cell-sub">(${b.jobsApproved} approved)</span></td>
      <td>${b.tmApproved}/${b.tmTotal}</td>
      <td>${b.terms}</td></tr>`).join('');
  host.innerHTML = `<div class="card"><div class="card-header"><h3>📊 Translator Metrics</h3></div>
    <div class="card-body">
      <div class="tr-tiles">
        ${tile(m.jobs, 'Translations')}
        ${tile(m.jobsApproved, 'Approved', 'green')}
        ${tile(m.jobsPending, 'Pending', 'amber')}
        ${tile(m.segments, 'Segments translated', 'blue')}
        ${tile(m.tmApproved + '/' + m.tmTotal, 'Memory (approved/total)')}
        ${tile(m.terms, 'Glossary terms')}
      </div>
      ${rows ? `<div class="table-responsive mt-2"><table>
        <thead><tr><th>Language</th><th>Translations</th><th>Memory (appr/total)</th><th>Glossary</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : '<p class="cell-sub mt-1">No translations yet — run one below to populate metrics.</p>'}
    </div></div>`;
}

function renderTrJobs(jobs) {
  document.getElementById('tr-jobs').innerHTML = jobs.length ? jobs.map(j => `
    <tr>
      <td class="cell-strong">${esc(j.FileName)}</td>
      <td>${esc(j.TargetLang||'')}</td>
      <td>${esc(j.UploadedBy||'')}</td>
      <td>${fmtDate(j.UploadedDate)}</td>
      <td>${j.Approved ? `<span class="badge badge-active">Approved</span>` : `<span class="badge badge-pending badge-plain">Pending</span>`}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick="openReview(${j.FileID})">🔍 Review</button>
        <a class="btn btn-outline btn-sm" href="/api/files/download/${j.FileID}">⬇ Download</a>
        ${!j.Approved && currentUser.admin ? `<button class="btn btn-success btn-sm" onclick="approveTranslation(${j.FileID})">✓ Approve</button>` : ''}
      </td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty-state">No translations yet.</td></tr>';
}

async function runTranslation() {
  const fileId = val('tr-source');
  const upload = document.getElementById('tr-upload').files[0];
  const langCode = val('tr-lang');
  const mode = val('tr-mode');
  if (!fileId && !upload) return toast('Select a document or upload a .docx first.', 'error');
  const btn = document.getElementById('tr-go');
  const status = document.getElementById('tr-status');
  btn.disabled = true; status.textContent = '⏳ Translating… this can take a minute for large documents.';
  document.getElementById('tr-result').innerHTML = '';
  try {
    const fd = new FormData();
    fd.append('langCode', langCode); fd.append('mode', mode);
    if (upload) fd.append('file', upload); else fd.append('fileId', fileId);
    const r = await fetch('/api/translator/translate', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok || data.error) { toast(data.error || 'Translation failed.', 'error'); status.textContent = ''; return; }
    status.textContent = '';
    const tmNote = data.tmHits ? ` <strong>${data.tmHits}</strong> reused from translation memory.` : '';
    document.getElementById('tr-result').innerHTML = `
      <div class="alert alert-success"><span>✅</span><div>
        Translated <strong>${data.replaced}</strong> text runs into <strong>${esc(data.language)}</strong> (${esc(data.mode)} mode).${tmNote}
        Saved to the Document Library as <strong>${esc(data.fileName)}</strong> — pending approval.
        <div class="mt-1"><a class="btn btn-accent btn-sm" href="/api/files/download/${data.fileId}">⬇ Download translated document</a></div>
      </div></div>`;
    toast('Document translated and saved.');
    loadTranslator();
  } catch (e) {
    toast('Translation failed: ' + e.message, 'error'); status.textContent = '';
  } finally { btn.disabled = false; }
}

async function approveTranslation(fileId) {
  const r = await POST(`/api/translator/approve/${fileId}`);
  if (!ok(r)) return;
  toast('Translation approved — its terms are now in memory for reuse.');
  loadTranslator();
}

// ---- Translation Review + automated QA / Safety / Final Audit ----
let reviewFileId = null, reviewQA = null;
const QA_ICON = { error:'⛔', empty:'⛔', unchanged:'⚠️', number:'🔢', short:'✂️', safety:'⚠️ SAFETY' };
async function openReview(fileId) {
  const [d, qa] = await Promise.all([GET('/api/translator/review/' + fileId), GET('/api/translator/qa/' + fileId)]);
  if (!d) return;
  reviewFileId = fileId; reviewQA = qa || { flagged:{}, errors:0, warns:0, infos:0, safety:0 };
  document.getElementById('review-title').textContent = `🔍 Review: ${d.fileName}`;
  const q = reviewQA;
  document.getElementById('review-status').innerHTML =
    `${d.segments.length} segments · ${esc(d.language||'')} · ${d.approved ? 'Approved' : 'Pending'} &nbsp; ` +
    `<span class="qa-pill ${q.errors?'qa-err':'qa-ok'}">⛔ ${q.errors} untranslated</span> ` +
    `<span class="qa-pill qa-warn">⚠️ ${q.warns} warnings</span> ` +
    `<span class="qa-pill qa-safe">🛟 ${q.safety} safety</span>`;
  document.getElementById('review-tbody').innerHTML = d.segments.length ? d.segments.map(s => {
    const flags = (q.flagged && q.flagged[s.SegID]) || [];
    const flagHtml = flags.length ? `<div class="rv-flags">${flags.map(f=>`<span class="rv-flag rv-${f.sev}">${QA_ICON[f.type]||'•'} ${esc(f.msg)}</span>`).join('')}</div>` : '';
    return `<tr class="${flags.some(f=>f.sev==='error')?'rv-rowerr':flags.some(f=>f.sev==='warn')?'rv-rowwarn':''}">
      <td class="rv-src">${esc(s.SourceText)}</td>
      <td><textarea class="rv-tgt" data-seg="${s.SegID}" rows="2">${esc(s.TargetText)}</textarea>${flagHtml}</td>
    </tr>`; }).join('') : '<tr><td colspan="2" class="empty-state">No segments recorded for this job.</td></tr>';
  showModal('review-modal');
}

async function saveReview(approve) {
  // Final Audit gate: don't approve while segments are still untranslated
  if (approve) {
    const stillEmpty = [...document.querySelectorAll('#review-tbody .rv-tgt')].filter(t => !t.value.trim()).length;
    if (stillEmpty && !confirm(`Final Audit: ${stillEmpty} segment(s) are still untranslated. Approve anyway?`)) return;
  }
  const corrections = {};
  document.querySelectorAll('#review-tbody .rv-tgt').forEach(t => { corrections[t.dataset.seg] = t.value; });
  const r = await POST('/api/translator/review/' + reviewFileId, { corrections, approve });
  if (!ok(r)) return;
  toast(`Saved ${r.changed} correction${r.changed===1?'':'s'}${r.approved ? ' · approved' : ''}.`);
  closeModal('review-modal');
  loadTranslator();
}

// ---- Terminology glossary ----
async function loadTerms() {
  const lang = val('term-filter');
  const terms = await GET('/api/translator/terms' + (lang ? '?lang=' + lang : ''));
  if (!terms) return;
  const byCode = {}; trLangs.forEach(l => byCode[l.code] = l.name);
  document.getElementById('term-tbody').innerHTML = terms.length ? terms.map(t => `
    <tr>
      <td>${esc(byCode[t.LangCode]||t.LangCode)}</td>
      <td class="cell-strong">${esc(t.SourceTerm)}</td>
      <td>${esc(t.TargetTerm)}</td>
      <td class="cell-sub">${esc(t.Note||'')}</td>
      <td class="actions"><button class="btn btn-danger btn-sm btn-icon" onclick="deleteTerm(${t.TermID})">🗑️</button></td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty-state">No glossary terms yet.</td></tr>';
}

async function termDownloadTemplate() {
  try {
    const resp = await fetch('/api/translator/terms/template', { credentials: 'include' });
    if (!resp.ok) {
      let msg = 'Template download failed (HTTP ' + resp.status + ')';
      try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch {}
      toast(msg, 'error');
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'terminology_template.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    toast('Template downloaded — fill in LangCode, SourceTerm, TargetTerm. Leave Note blank to let AI fill it.');
  } catch (e) {
    toast('Template download failed: ' + (e && e.message ? e.message : 'network error'), 'error');
  }
}

// Export the live terminology glossary as a CSV — honours the "term-filter" dropdown so the user gets
// only the language they're currently viewing (or all languages if the filter is on "All").
async function termDownloadGlossary() {
  try {
    const lang = (document.getElementById('term-filter') || {}).value || '';
    const url  = '/api/translator/terms/export' + (lang ? '?lang=' + encodeURIComponent(lang) : '');
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) {
      let msg = 'Glossary download failed (HTTP ' + resp.status + ')';
      try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch {}
      toast(msg, 'error');
      return;
    }
    const blob = await resp.blob();
    // Pull the filename from Content-Disposition so users get the dated name the server picked
    let filename = 'terminology_glossary.csv';
    const cd = resp.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="([^"]+)"/i);
    if (m) filename = m[1];
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(objUrl); a.remove(); }, 100);
    const scope = lang ? `the ${lang.toUpperCase()} terms` : 'every term in every language';
    toast(`Exported ${scope} to ${filename}.`);
  } catch (e) {
    toast('Glossary download failed: ' + (e && e.message ? e.message : 'network error'), 'error');
  }
}

async function termUploadCsv(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  // Blocking progress overlay (AI note-fill can take ~10-30s)
  document.getElementById('term-import-overlay')?.remove();
  const ov = document.createElement('div');
  ov.id = 'term-import-overlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
  ov.innerHTML = `<div style="background:#fff;padding:22px 26px;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.18);text-align:center;min-width:280px">
    <div style="font-size:30px;margin-bottom:8px">📚</div>
    <strong style="font-size:14px">Importing <span style="color:#1E3A5F">${esc(file.name)}</span></strong>
    <div style="font-size:12px;color:#64748b;margin-top:8px">Validating rows + AI is writing notes for blank entries…<br>This typically takes 10–30 seconds.</div>
  </div>`;
  document.body.appendChild(ov);
  try {
    const fd = new FormData();
    fd.append('file', file);
    const resp = await fetch('/api/translator/terms/import', { method: 'POST', body: fd, credentials: 'include' });
    const r = await resp.json().catch(() => ({ error: 'Server returned non-JSON.' }));
    if (!resp.ok) {
      // Always pop a dialog with the actual reason — the toast alone is too easy to miss
      const lines400 = [`Import failed (HTTP ${resp.status})`];
      if (r.error) lines400.push('', r.error);
      if (r.errors && r.errors.length) {
        lines400.push('', 'Row-level issues:');
        lines400.push(...r.errors.slice(0, 15).map(e => '  • ' + e));
        if (r.errors.length > 15) lines400.push(`  • …and ${r.errors.length - 15} more`);
      }
      toast(r.error || `Import failed (HTTP ${resp.status})`, 'error');
      alert(lines400.join('\n'));
      return;
    }
    const bits = [];
    if (r.inserted) bits.push(`${r.inserted} new`);
    if (r.updated)  bits.push(`${r.updated} overwritten`);
    if (r.aiNotesFilled) bits.push(`${r.aiNotesFilled} AI notes`);
    if (r.autoDetectedLang) bits.push(`${r.autoDetectedLang} languages auto-detected`);
    if (r.duplicatesInFile) bits.push(`${r.duplicatesInFile} duplicates skipped`);
    toast(`Imported ${r.total} term(s) — ${bits.join(' · ') || 'no changes'}.`);
    // Show a single combined dialog with skipped rows AND overwrite warnings, so the user can fix the CSV if needed
    const lines = [];
    if (r.duplicatesInFile) lines.push(`📛 ${r.duplicatesInFile} duplicate row(s) in your file — only the first occurrence of each was imported.`);
    if (r.duplicatesInDb)   lines.push(`♻️ ${r.duplicatesInDb} term(s) already existed in the glossary — their translation was OVERWRITTEN.`);
    if (r.errors && r.errors.length) {
      lines.push(``, `⚠️ Skipped rows:`, ...r.errors.slice(0, 15).map(e => `  • ${e}`));
      if (r.errors.length > 15) lines.push(`  • …and ${r.errors.length - 15} more`);
    }
    if (r.warnings && r.warnings.length) {
      lines.push(``, `🔁 Overwritten translations:`, ...r.warnings.slice(0, 15).map(w => `  • ${w}`));
      if (r.warnings.length > 15) lines.push(`  • …and ${r.warnings.length - 15} more`);
    }
    if (lines.length) alert(lines.join('\n'));
    loadTerms();
  } catch (e) {
    toast('Import failed: ' + (e && e.message ? e.message : 'network error'), 'error');
  } finally {
    ov.remove();
    input.value = '';
  }
}

async function addTerm() {
  const d = { LangCode: val('term-lang'), SourceTerm: val('term-src'), TargetTerm: val('term-tgt'), Note: val('term-note') };
  if (!d.SourceTerm || !d.TargetTerm) return toast('Enter both the source term and its required translation.', 'error');
  const r = await POST('/api/translator/terms', d);
  if (!ok(r)) return;
  toast('Term saved.');
  setVal('term-src',''); setVal('term-tgt',''); setVal('term-note','');
  loadTerms();
}

async function deleteTerm(id) {
  if (!confirm('Delete this glossary term?')) return;
  await DEL('/api/translator/terms/' + id);
  toast('Term deleted.');
  loadTerms();
}

// ---- Training Matrix ----
const MATRIX_LABELS = { current:'✓', expiring:'!', expired:'✕', missing:'–', trained:'✓', na:'' };
async function loadMatrix() {
  const deptID = val('matrix-dept');
  const d = await GET('/api/reports/matrix' + (deptID ? '?deptID=' + deptID : ''));
  if (!d) return;
  if (!d.courses.length) {
    document.getElementById('matrix-container').innerHTML = '<div class="empty-state"><div class="icon">🔲</div><p>No required courses defined yet. Add Training Requirements to build the matrix.</p></div>';
    return;
  }
  let html = '<table class="matrix-table"><thead><tr><th class="sticky-col">Employee</th><th>Dept</th>';
  d.courses.forEach(c => html += `<th class="matrix-coursehead"><span>${esc(c.CertName)}</span></th>`);
  html += '</tr></thead><tbody>';
  d.rows.forEach(r => {
    html += `<tr><td class="sticky-col cell-strong">${esc(r.name)}<div class="cell-sub">${esc(r.FileNum||'')}</div></td><td class="cell-sub">${esc(r.Department||'')}</td>`;
    d.courses.forEach(c => {
      const cell = r.cells[c.CertID] || { status:'na' };
      const tip = cell.complete ? `Completed ${fmtDate(cell.complete)}${cell.exp?' · Exp '+fmtDate(cell.exp):''}` : (cell.required ? 'Required – not completed' : '');
      html += `<td class="mx mx-${cell.status}" title="${tip}">${MATRIX_LABELS[cell.status]||''}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  document.getElementById('matrix-container').innerHTML = html;
}
function exportMatrix() {
  const deptID = val('matrix-dept');
  GET('/api/reports/matrix' + (deptID ? '?deptID=' + deptID : '')).then(d => {
    if (!d || !d.courses.length) return alert('No matrix data to export.');
    const head = ['Employee','File #','Department', ...d.courses.map(c => c.CertName)];
    const lines = [head];
    d.rows.forEach(r => {
      const line = [r.name, r.FileNum||'', r.Department||''];
      d.courses.forEach(c => {
        const cell = r.cells[c.CertID] || {};
        line.push(cell.status === 'na' ? '' : (cell.status||'').toUpperCase());
      });
      lines.push(line);
    });
    downloadCsv(lines, 'training_matrix.csv');
  });
}

// ---- Notifications / Reminders ----
async function loadNotifications() {
  const d = await GET('/api/reports/notifications');
  if (!d) return;
  const card = (icon, cls, num, label) => `
    <div class="stat-card"><div class="stat-top"><div class="stat-icon ${cls}">${icon}</div></div>
    <div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`;
  document.getElementById('notif-stats').innerHTML =
    card('🔴','red', d.expired.length, 'Expired Certifications') +
    card('⚠️','amber', d.expiring.length, 'Expiring within 90 Days') +
    card('❌','indigo', d.missing.length, 'Required – Not Started');

  const mailBtn = (email, subject, body) => email
    ? `<a class="btn btn-outline btn-sm" href="mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}">✉ Email</a>`
    : '<span class="cell-sub">no email</span>';

  document.getElementById('notif-expired').innerHTML = d.expired.length ? d.expired.map(r => `
    <tr><td class="cell-strong">${r.LastName}, ${r.FirstName}</td><td>${r.CertName}</td>
    <td><span class="badge badge-expired">${fmtDate(r.Exp)}</span></td>
    <td>${mailBtn(r.Email, 'Training Expired: ' + r.CertName, `Hello ${r.FirstName},\n\nYour certification "${r.CertName}" expired on ${fmtDate(r.Exp)}. Please arrange to renew it as soon as possible.`)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty-state">✅ Nothing expired</td></tr>';

  document.getElementById('notif-expiring').innerHTML = d.expiring.length ? d.expiring.map(r => `
    <tr><td class="cell-strong">${r.LastName}, ${r.FirstName}</td><td>${r.CertName}</td>
    <td><span class="badge badge-expiring">${fmtDate(r.Exp)}</span></td><td><strong>${r.DaysLeft}</strong> days</td>
    <td>${mailBtn(r.Email, 'Training Renewal Due: ' + r.CertName, `Hello ${r.FirstName},\n\nYour certification "${r.CertName}" expires on ${fmtDate(r.Exp)} (${r.DaysLeft} days). Please schedule your renewal.`)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty-state">✅ Nothing expiring soon</td></tr>';

  document.getElementById('notif-missing').innerHTML = d.missing.length ? d.missing.map(r => `
    <tr><td class="cell-strong">${r.LastName}, ${r.FirstName}</td><td>${r.CertName}</td>
    <td>${mailBtn(r.Email, 'Required Training: ' + r.CertName, `Hello ${r.FirstName},\n\nYou are required to complete "${r.CertName}". Please enroll at your earliest convenience.`)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="empty-state">✅ All required training started</td></tr>';
}

async function refreshNotifBadge() {
  const d = await GET('/api/reports/notifications');
  if (!d) return;
  [['bell-badge', d.total], ['nav-notif-badge', d.total]].forEach(([id, n]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = n > 99 ? '99+' : n;
    el.classList.toggle('hidden', n === 0);
  });
}

// ---- Training Transcript ----
async function viewTranscript(staffID) {
  const [s, training] = await Promise.all([ GET('/api/staff/' + staffID), GET(`/api/staff/${staffID}/training`) ]);
  if (!s) return;
  const rows = (training || []).filter(t => t.Complete);
  document.getElementById('transcript-body').innerHTML = `
    <div id="transcript-print">
      <div class="transcript-head">
        <div>
          <h2>Training Transcript</h2>
          <div class="cell-sub">Generated ${new Date().toLocaleDateString()}</div>
        </div>
        <div class="transcript-mark">${cache.company && cache.company.logo
          ? `<img src="${cache.company.logo}" style="height:36px;max-width:140px;object-fit:contain">`
          : `🎓 ${esc(cache.company && cache.company.name ? cache.company.name : 'TrainTrack')}`}</div>
      </div>
      <div class="transcript-emp">
        <div><strong>${esc(s.LastName)}, ${esc(s.FirstName)}</strong></div>
        <div class="cell-sub">File #: ${esc(s.FileNum||'—')} · ${esc(s.Department||'')} · ${esc(s.JobTitle||'')}</div>
      </div>
      <table><thead><tr><th>Course</th><th>Course #</th><th>Completed</th><th>Expires</th><th>Score</th><th>Result</th></tr></thead>
      <tbody>${rows.length ? rows.map(t => `
        <tr><td>${esc(t.CertName||'')}</td><td>${esc(t.CertNum||'')}</td>
        <td>${fmtDate(t.Complete)}</td><td>${expBadge(t.Exp)}</td>
        <td>${t.Score!=null?t.Score+'%':''}</td>
        <td>${t.Pass!=null?(t.Pass?'<span class="badge badge-active">Pass</span>':'<span class="badge badge-expired">Fail</span>'):'<span class="badge badge-active">Completed</span>'}</td></tr>`).join('')
        : '<tr><td colspan="6" class="empty-state">No completed training on record</td></tr>'}
      </tbody></table>
      <div class="transcript-foot">Total completed courses: <strong>${rows.length}</strong></div>
    </div>`;
  showModal('transcript-modal');
}
function printTranscript() {
  const content = document.getElementById('transcript-print').innerHTML;
  const w = window.open('', '_blank');
  w.document.write(`<html><head><title>Training Transcript</title>
    <style>body{font-family:Arial,sans-serif;padding:40px;color:#1a1d28}
    table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border:1px solid #ddd;padding:8px 10px;text-align:left;font-size:13px}
    th{background:#f3f4f6}.transcript-head{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #4f46e5;padding-bottom:14px}
    .transcript-mark{font-weight:800;color:#4f46e5;font-size:18px}.transcript-emp{margin:18px 0}.cell-sub{color:#777;font-size:12px}
    .badge{padding:2px 8px;border-radius:10px;font-size:11px}.transcript-foot{margin-top:16px;font-size:13px}</style>
    </head><body>${content}</body></html>`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
}

// ---- Exam Certificate ----
let _certHtml = '';
async function generateCertificate(examId, empName) {
  const r = await POST(`/api/exams/certificate/${examId}`, { empName: empName||'' });
  if (!ok(r)) return;
  _certHtml = r.html || '';
  const body = document.getElementById('certificate-body');
  if (body) {
    body.innerHTML = `<div class="cert-preview">${_certHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<button[^>]*>[\s\S]*?<\/button>/gi,'')}</div>`;
  }
  showModal('certificate-modal');
  if (r.fileId) toast(`🏆 Certificate saved to ${esc(r.empName || 'employee')}'s document folder.`);
  else if (r.success) toast('🏆 Certificate generated! Print or save as PDF.');
}
function printCertificate() {
  const w = window.open('', '_blank');
  w.document.write(_certHtml); w.document.close(); w.focus(); setTimeout(() => w.print(), 400);
}

// ---- Employee Full Report ----
async function openEmployeeReport(staffId) {
  navigateTo('emp-report');
  const rc = document.getElementById('report-container');
  rc.innerHTML = '<div class="empty-state"><span class="spinner"></span><p>Loading report…</p></div>';
  const d = await GET('/api/staff/' + staffId + '/full-report');
  if (!d || d.error) { rc.innerHTML = `<div class="alert alert-danger"><span>⚠️</span><div>${d?d.error:'Load failed'}</div></div>`; return; }
  rc.innerHTML = buildReportHtml(d);
}

function buildReportHtml(d) {
  const { emp, completed, required, upcoming, exams, roles, roleHistory, docCount, summary,
          leaveBookings = [], activeLeave = null, attendance30 = {}, onboarding = null,
          leaveBalance = [], disciplinary = [] } = d;
  const fmtD = s => s ? fmtDate(s) : '—';
  const statusBadge = r => {
    if (!r.LastCompleted) return '<span class="badge badge-inactive">Not Started</span>';
    if (r.IsCurrent) { if (r.Expiration && new Date(r.Expiration) <= new Date(new Date().setDate(new Date().getDate()+90))) return '<span class="badge badge-expiring">Expiring</span>'; return '<span class="badge badge-current">Current</span>'; }
    return '<span class="badge badge-expired">Expired</span>';
  };
  const compliance_color = summary.complianceRate >= 90 ? 'var(--success)' : summary.complianceRate >= 70 ? 'var(--warning)' : 'var(--danger)';

  return `<div class="emp-report" id="emp-report-print">
  <!-- Report Header -->
  <div class="rpt-header no-print-margin">
    <div class="flex items-center gap-3" style="flex-wrap:wrap">
      <div class="report-avatar">${(emp.FirstName||'?').charAt(0)}${(emp.LastName||'').charAt(0)}</div>
      <div style="flex:1">
        <h2 class="rpt-name">${esc(emp.FirstName)} ${esc(emp.LastName)}</h2>
        <div class="rpt-sub">${esc(emp.JobTitle||'')}${emp.Department?' · '+esc(emp.Department):''}</div>
      </div>
      ${activeLeave ? `<div class="rpt-stat-pill" style="border-color:${esc(activeLeave.LeaveTypeColor||'#3b82f6')};color:${esc(activeLeave.LeaveTypeColor||'#3b82f6')}" title="On approved leave: ${esc(activeLeave.StartDate)} → ${esc(activeLeave.EndDate)}">🏖️ On ${esc(activeLeave.LeaveTypeName)}</div>` : ''}
      <div class="rpt-stat-pill" style="border-color:${compliance_color};color:${compliance_color}">${summary.complianceRate}% Compliant</div>
      <div class="flex gap-2 no-print">
        <button class="btn btn-outline btn-sm" onclick="window.print()">🖨 Print Report</button>
      </div>
    </div>
  </div>

  <!-- Two-column profile -->
  <div class="rpt-grid-2 mt-2">
    <div class="card">
      <div class="card-header"><h3>👤 Employee Profile</h3></div>
      <div class="card-body">
        <table class="rpt-table"><tbody>
          <tr><td>File / Employee #</td><td><strong>${esc(emp.FileNum||'—')}</strong></td></tr>
          <tr><td>Status</td><td><span class="badge ${emp.Status==='Active'?'badge-active':'badge-inactive'}">${esc(emp.Status||'')}</span></td></tr>
          <tr><td>Gender</td><td>${esc(emp.Gender||'—')}</td></tr>
          <tr><td>Start Date</td><td>${fmtD(emp.StartDate)}</td></tr>
          <tr><td>End Date</td><td>${fmtD(emp.EndDate)}</td></tr>
          <tr><td>Department</td><td>${esc(emp.Department||'—')}</td></tr>
          <tr><td>Job Title</td><td>${esc(emp.JobTitle||'—')}</td></tr>
          <tr><td>Employee Type</td><td>${esc(emp.empType||'—')}</td></tr>
          <tr><td>Location</td><td>${esc(emp.LocName||'—')}</td></tr>
          <tr><td>Shift</td><td>${esc(emp.ShiftName||emp.Shift||'—')}</td></tr>
          <tr><td>Email</td><td>${esc(emp.Email||'—')}</td></tr>
          <tr><td>Phone (Cell)</td><td>${esc(emp.CellPhone||emp.HomePhone||'—')}</td></tr>
          <tr><td>Extension</td><td>${esc(emp.extension||'—')}</td></tr>
          <tr><td>Address</td><td>${esc(emp.Address||'—')}</td></tr>
          ${emp.Note?`<tr><td>Notes</td><td>${esc(emp.Note)}</td></tr>`:''}
        </tbody></table>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:18px">
      <!-- Supervisor -->
      <div class="card">
        <div class="card-header"><h3>👨‍💼 Area Supervisor</h3></div>
        <div class="card-body">
          ${emp.SupFirst ? `<div class="cell-strong">${esc(emp.SupFirst)} ${esc(emp.SupLast)}</div>
          ${emp.SupEmail?`<div class="cell-sub">✉️ ${esc(emp.SupEmail)}</div>`:''}
          ${emp.SupPhone?`<div class="cell-sub">📱 ${esc(emp.SupPhone)}</div>`:''}
          ${emp.Supervisor&&!emp.SupFirst?`<div class="cell-sub">${esc(emp.Supervisor)}</div>`:''}` :
          `<div class="cell-sub">${emp.Supervisor?esc(emp.Supervisor):'No supervisor linked'}</div>`}
        </div>
      </div>
      <!-- Compliance summary -->
      <div class="card">
        <div class="card-header"><h3>📊 Training Compliance</h3></div>
        <div class="card-body">
          <div class="rpt-stat-grid">
            <div class="rpt-mini-stat green">${summary.current}<small>Current</small></div>
            <div class="rpt-mini-stat amber">${summary.expiringSoon}<small>Expiring ≤90d</small></div>
            <div class="rpt-mini-stat red">${summary.expired}<small>Expired</small></div>
            <div class="rpt-mini-stat gray">${summary.notStarted}<small>Not Started</small></div>
          </div>
          <div class="capacity-bar mt-1"><div class="capacity-fill" style="width:${summary.complianceRate}%;background:${compliance_color}"></div></div>
          <div class="cell-sub mt-1">${summary.current} of ${summary.totalRequired} required trainings are current</div>
        </div>
      </div>
      <!-- Job roles -->
      <div class="card">
        <div class="card-header"><h3>🗂️ Job Roles</h3></div>
        <div class="card-body">${roles.length ? roles.map(r=>`<div class="flex items-center gap-2 mb-1">
          ${r.IsPrimary?'<span class="badge badge-active badge-plain">Primary</span>':'<span class="badge badge-pending badge-plain">Secondary</span>'}
          <span class="cell-strong">${esc(r.Title||'Unknown')}</span>
          <span class="cell-sub">(${r.CourseCount||0} courses required)</span>
          <span class="cell-sub ml-auto">${fmtD(r.DateAssigned)}</span>
        </div>`).join('') : '<p class="cell-sub">No roles assigned.</p>'}
        </div>
      </div>
      <!-- Quick stats -->
      <div class="card">
        <div class="card-header"><h3>📁 Records Summary</h3></div>
        <div class="card-body">
          <div class="rpt-stat-grid">
            <div class="rpt-mini-stat blue">${completed.length}<small>Completions</small></div>
            <div class="rpt-mini-stat violet">${exams.length}<small>Exams Taken</small></div>
            <div class="rpt-mini-stat teal">${upcoming.length}<small>Upcoming Classes</small></div>
            <div class="rpt-mini-stat orange">${docCount||0}<small>Documents</small></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Required Training -->
  <div class="card mt-2">
    <div class="card-header"><h3>✅ Required Training</h3></div>
    <div class="card-body">
      <div class="table-responsive"><table>
        <thead><tr><th>Course</th><th>Course #</th><th>Status</th><th>Last Completed</th><th>Expires</th><th>Required Via</th><th>Due By</th></tr></thead>
        <tbody>${required.length ? required.map(r=>`<tr>
          <td class="cell-strong">${esc(r.CertName)}</td>
          <td>${esc(r.CertNum||'')}</td>
          <td>${statusBadge(r)}</td>
          <td>${fmtD(r.LastCompleted)}</td>
          <td>${expBadge(r.Expiration)}</td>
          <td class="cell-sub">${[r.ViaJob&&'Job: '+r.ViaJob, r.ViaDept&&'Dept: '+r.ViaDept, r.ViaEmployee&&'Individual'].filter(Boolean).join(', ')||'—'}</td>
          <td>${fmtD(r.DueByDate)}</td>
        </tr>`).join('') : '<tr><td colspan="7" class="empty-state">No training requirements assigned.</td></tr>'}
        </tbody>
      </table></div>
    </div>
  </div>

  <!-- Training Completed -->
  <div class="card mt-2">
    <div class="card-header"><h3>📋 Training History (All Completions)</h3></div>
    <div class="card-body">
      <div class="table-responsive"><table>
        <thead><tr><th>Course</th><th>Course #</th><th>Completed</th><th>Expires</th><th>Score</th><th>Result</th><th>Signed By</th><th>Class</th></tr></thead>
        <tbody>${completed.length ? completed.map(r=>`<tr>
          <td class="cell-strong">${esc(r.CertName||'')}</td>
          <td>${esc(r.CertNum||'')}</td>
          <td>${fmtD(r.Complete)}</td>
          <td>${expBadge(r.Exp)}</td>
          <td>${r.Score!=null?r.Score+'%':''}</td>
          <td>${r.Pass!=null?(r.Pass?'<span class="badge badge-active badge-plain">Pass</span>':'<span class="badge badge-expired badge-plain">Fail</span>'):'<span class="badge badge-current badge-plain">Done</span>'}</td>
          <td class="cell-sub">${esc(r.SignBy||'')}</td>
          <td class="cell-sub">${r.ClassName?esc(r.ClassName)+' '+fmtD(r.ClassDate):''}</td>
        </tr>`).join('') : '<tr><td colspan="8" class="empty-state">No completed training on record.</td></tr>'}
        </tbody>
      </table></div>
    </div>
  </div>

  <!-- Upcoming Classes -->
  ${upcoming.length ? `<div class="card mt-2">
    <div class="card-header"><h3>📅 Upcoming Scheduled Classes</h3></div>
    <div class="card-body"><div class="table-responsive"><table>
      <thead><tr><th>Class</th><th>Course</th><th>Date</th><th>Time</th><th>Location</th><th>Trainer</th><th>Status</th></tr></thead>
      <tbody>${upcoming.map(c=>`<tr>
        <td class="cell-strong">${esc(c.ClassName||c.CertName||'')}</td>
        <td>${esc(c.CertName||'')}</td>
        <td>${fmtD(c.ClassDate)}</td>
        <td>${esc(c.TimeStart||'')}${c.TimeEnd?' – '+esc(c.TimeEnd):''}</td>
        <td>${esc(c.ClassLoc||c.ClassLocation||'')}</td>
        <td>${esc(c.TrainerFirst?c.TrainerFirst+' '+c.TrainerLast:'')}</td>
        <td><span class="badge badge-pending badge-plain">${esc(c.BookingState||'Registered')}</span></td>
      </tr>`).join('')}
      </tbody>
    </table></div></div>
  </div>` : ''}

  <!-- Exam History -->
  ${exams.length ? `<div class="card mt-2">
    <div class="card-header"><h3>📝 Exam History</h3></div>
    <div class="card-body"><div class="table-responsive"><table>
      <thead><tr><th>Exam</th><th>Date</th><th>Score</th><th>Pass Mark</th><th>Result</th></tr></thead>
      <tbody>${exams.map(e=>`<tr>
        <td class="cell-strong">${esc(e.TestName||'')}</td>
        <td>${fmtD(e.ExamDate)}</td>
        <td>${e.ScorePct}%</td>
        <td>${e.PassScore||80}%</td>
        <td>${e.Passed?'<span class="badge badge-active badge-plain">Passed</span>':'<span class="badge badge-expired badge-plain">Failed</span>'}</td>
      </tr>`).join('')}
      </tbody>
    </table></div></div>
  </div>` : ''}

  <!-- Career / Role History -->
  ${roleHistory.length ? `<div class="card mt-2">
    <div class="card-header"><h3>🕘 Career / Role History</h3></div>
    <div class="card-body"><div class="table-responsive"><table>
      <thead><tr><th>Date</th><th>Action</th><th>Role</th><th>Recorded By</th></tr></thead>
      <tbody>${roleHistory.map(h=>`<tr>
        <td>${fmtD(h.EffectiveDate)}</td>
        <td><span class="badge badge-pending badge-plain">${esc(h.Action||'')}</span></td>
        <td class="cell-strong">${esc(h.Title||'')}</td>
        <td class="cell-sub">${esc(h.ChangedBy||'')}</td>
      </tr>`).join('')}
      </tbody>
    </table></div></div>
  </div>` : ''}

  <!-- Leave Balance (per type, current calendar year) -->
  ${leaveBalance.length ? `<div class="card mt-2">
    <div class="card-header"><h3>📊 Leave Balance — ${new Date().getFullYear()} <small style="font-weight:400;color:#64748b">(per leave type)</small></h3></div>
    <div class="card-body"><div class="table-responsive"><table>
      <thead><tr><th>Leave Type</th><th>Paid</th><th>Entitled</th><th>Used</th><th>Pending</th><th>Remaining</th><th>Status</th></tr></thead>
      <tbody>${leaveBalance.map(b => {
        const overCol = b.overBy > 0 ? '#ef4444' : b.entitled && (b.entitled - b.used <= 2) ? '#f59e0b' : '#10b981';
        const statusLabel = b.overBy > 0
          ? `<span style="color:#ef4444;font-weight:700">⚠ Over by ${b.overBy} days</span>`
          : (b.entitled === 0
              ? `<span class="cell-sub">No entitlement defined</span>`
              : (b.entitled - b.used <= 2 ? `<span style="color:#f59e0b;font-weight:600">Low balance</span>` : `<span style="color:#10b981;font-weight:600">OK</span>`));
        return `<tr>
          <td><span class="badge" style="background:${esc(b.Color)}1a;color:${esc(b.Color)};border:1px solid ${esc(b.Color)}40;padding:3px 9px;border-radius:12px">${esc(b.Name)}</span></td>
          <td>${b.Paid ? '✅' : '❌'}</td>
          <td>${b.entitled || '—'}</td>
          <td>${b.used}</td>
          <td>${b.pending || 0}</td>
          <td><strong style="color:${overCol}">${b.entitled ? (b.entitled - b.used >= 0 ? (b.entitled - b.used) : 0) : '—'}</strong></td>
          <td>${statusLabel}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div></div>
  </div>` : ''}

  <!-- Disciplinary actions -->
  ${disciplinary.length ? `<div class="card mt-2">
    <div class="card-header"><h3>⚖️ Disciplinary Actions <small style="font-weight:400;color:#64748b">(${disciplinary.length})</small></h3></div>
    <div class="card-body"><div class="table-responsive"><table>
      <thead><tr><th>Issued</th><th>Type</th><th>Severity</th><th>Reason</th><th>Status</th><th>Docs</th><th>Auto?</th></tr></thead>
      <tbody>${disciplinary.map(a => {
        const sevCol = a.Severity === 'Critical' ? '#dc2626' : a.Severity === 'Major' ? '#f59e0b' : '#3b82f6';
        const stCol  = a.Status === 'Resolved' ? '#10b981' : a.Status === 'Cancelled' ? '#94a3b8' : a.Status === 'In Progress' ? '#f59e0b' : '#ef4444';
        return `<tr>
          <td>${esc(a.IssuedDate||'—')}</td>
          <td>${esc(a.ActionType||'')}</td>
          <td><span class="badge" style="background:${sevCol}1a;color:${sevCol};border:1px solid ${sevCol}40;padding:3px 9px;border-radius:12px">${esc(a.Severity)}</span></td>
          <td>${esc(a.Reason||'')}</td>
          <td><span class="badge" style="background:${stCol}1a;color:${stCol};border:1px solid ${stCol}40;padding:3px 9px;border-radius:12px">${esc(a.Status)}</span></td>
          <td>${a.DocCount||0} 📎</td>
          <td>${a.AutoGenerated ? '🤖 Yes' : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    <button class="btn btn-ghost btn-sm mt-1 no-print" onclick="navigateTo('disciplinary')">⚖️ Open HR Disciplinary Action page →</button>
    </div>
  </div>` : ''}

  <!-- Leave Bookings -->
  ${leaveBookings.length ? `<div class="card mt-2">
    <div class="card-header"><h3>🏖️ Leave Bookings <small style="font-weight:400;color:#64748b">(${leaveBookings.length})</small></h3></div>
    <div class="card-body"><div class="table-responsive"><table>
      <thead><tr><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th><th>Reason</th></tr></thead>
      <tbody>${leaveBookings.map(b => {
        const stCol = b.Status === 'Approved' ? '#10b981' : b.Status === 'Rejected' ? '#ef4444' : b.Status === 'Cancelled' ? '#94a3b8' : '#f59e0b';
        return `<tr>
          <td><span class="badge" style="background:${esc(b.LeaveTypeColor)}1a;color:${esc(b.LeaveTypeColor)};border:1px solid ${esc(b.LeaveTypeColor)}40;padding:3px 9px;border-radius:12px">${esc(b.LeaveTypeName)}</span></td>
          <td>${esc(b.StartDate)}</td><td>${esc(b.EndDate)}</td><td>${b.Days||0}</td>
          <td><span class="badge" style="background:${stCol}1a;color:${stCol};border:1px solid ${stCol}40;padding:3px 9px;border-radius:12px">${esc(b.Status)}</span></td>
          <td class="cell-sub">${esc(b.Reason||'')}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div></div>
  </div>` : ''}

  <!-- Attendance (last 30 days) -->
  ${attendance30 && attendance30.total ? `<div class="card mt-2">
    <div class="card-header"><h3>✅ Attendance — Last 30 Days <small style="font-weight:400;color:#64748b">(${attendance30.total} day${attendance30.total===1?'':'s'} marked)</small></h3></div>
    <div class="card-body">
      <div class="rpt-stat-grid">
        <div class="rpt-mini-stat green">${attendance30.Present||0}<small>Present</small></div>
        <div class="rpt-mini-stat red">${attendance30.Absent||0}<small>Absent</small></div>
        <div class="rpt-mini-stat amber">${attendance30.Late||0}<small>Late</small></div>
        <div class="rpt-mini-stat blue">${attendance30.Leave||0}<small>Leave</small></div>
        <div class="rpt-mini-stat gray">${(attendance30['No Show']||0) + (attendance30.Excused||0)}<small>No Show / Excused</small></div>
      </div>
      ${attendance30.rows && attendance30.rows.length ? `<div class="table-responsive mt-2"><table>
        <thead><tr><th>Date</th><th>Status</th><th>Shift</th><th>In / Out</th><th>Notes</th></tr></thead>
        <tbody>${attendance30.rows.slice(0,15).map(r => `<tr>
          <td>${esc(r.AttDate)}</td>
          <td>${esc(r.Status)}</td>
          <td>${esc(r.ShiftLabel||'—')}</td>
          <td class="cell-sub">${esc(r.TimeIn||'—')} / ${esc(r.TimeOut||'—')}</td>
          <td class="cell-sub">${esc(r.Notes||'')}</td>
        </tr>`).join('')}</tbody>
      </table>${attendance30.rows.length > 15 ? `<div class="cell-sub mt-1">Showing latest 15 of ${attendance30.rows.length} entries.</div>` : ''}</div>` : ''}
    </div>
  </div>` : ''}

  <!-- Onboarding origin (if this staff was promoted from a candidate) -->
  ${onboarding ? `<div class="card mt-2">
    <div class="card-header"><h3>🧑‍💼 Onboarding Origin</h3></div>
    <div class="card-body">
      <div class="cell-sub">This employee was promoted from candidate <strong>#${onboarding.CandidateID}</strong> on ${esc((onboarding.CreatedAt||'').slice(0,10))}. ${onboarding.approvedReviews||0} review(s) approved, ${onboarding.docCount||0} document(s) on file.</div>
      <button class="btn btn-ghost btn-sm mt-1 no-print" onclick="navigateTo('onboarding');setTimeout(()=>onbOpen(${onboarding.CandidateID}),300)">📂 Open Onboarding Record</button>
    </div>
  </div>` : ''}

  <div class="rpt-footer no-print">Generated ${new Date().toLocaleString()} · TrainingPro · AKARA Resources</div>
</div>`;
}

function downloadCsv(rows, filename) {
  const csv = rows.map(r => r.map(c => {
    const s = c == null ? '' : String(c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- Import / Export ----
let importParsed = null;

function resetImport() {
  importParsed = null;
  setVal('dz-filename', 'Accepted format: .csv');
  const fn = document.getElementById('dz-filename'); if (fn) fn.textContent = 'Accepted format: .csv';
  const f = document.getElementById('import-file'); if (f) f.value = '';
  const btn = document.getElementById('btn-do-import'); if (btn) btn.disabled = true;
  const res = document.getElementById('import-result'); if (res) { res.classList.add('hidden'); res.innerHTML = ''; }
  const dz = document.getElementById('dropzone'); if (dz) dz.classList.remove('drag');
}

function downloadTemplate() {
  const type = val('import-type');
  window.open(`/api/import/template/${type}`, '_blank');
}

function exportData() {
  const type = val('import-type');
  window.open(`/api/import/export/${type}`, '_blank');
}

// Minimal RFC-4180 CSV parser
function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i+1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function handleFilePick(e) {
  const file = e.target.files[0];
  if (file) readImportFile(file);
}

function readImportFile(file) {
  if (!file.name.toLowerCase().endsWith('.csv')) { alert('Please select a .csv file.'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const rows = parseCSV(reader.result);
    if (rows.length < 2) { alert('File has no data rows.'); return; }
    const headers = rows[0].map(h => h.trim());
    const objects = rows.slice(1).map(r => {
      const o = {};
      headers.forEach((h, i) => o[h] = (r[i] || '').trim());
      return o;
    });
    importParsed = objects;
    document.getElementById('dz-filename').textContent = `✓ ${file.name} — ${objects.length} row(s) ready`;
    document.getElementById('btn-do-import').disabled = false;
  };
  reader.readAsText(file);
}

async function doImport() {
  if (!importParsed) return;
  const type = val('import-type');
  const btn = document.getElementById('btn-do-import');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Importing...';
  const r = await POST(`/api/import/${type}`, { rows: importParsed });
  btn.innerHTML = '⬆ Import Data';
  const res = document.getElementById('import-result');
  res.classList.remove('hidden');
  if (!r || r.error) {
    res.innerHTML = `<div class="alert alert-danger"><span>⚠️</span><div>${r ? r.error : 'Import failed'}</div></div>`;
    btn.disabled = false;
    return;
  }
  res.innerHTML = `
    <div class="result-pills">
      <div class="result-pill" style="background:var(--success-soft);color:#047857">${r.inserted}<small>Added</small></div>
      <div class="result-pill" style="background:var(--info-soft);color:#0369a1">${r.updated}<small>Updated</small></div>
      <div class="result-pill" style="background:var(--warning-soft);color:#b45309">${r.skipped}<small>Skipped</small></div>
    </div>
    ${r.errors && r.errors.length ? `<div class="alert alert-warning"><span>⚠️</span><div><strong>${r.errors.length} issue(s):</strong><br>${r.errors.map(esc).join('<br>')}</div></div>` : '<div class="alert alert-success"><span>✅</span><div>Import completed successfully!</div></div>'}
  `;
  // Refresh caches so new data shows everywhere
  await loadLookupCache();
  await populateAllDropdowns();
}

// Drag & drop wiring
(function () {
  document.addEventListener('DOMContentLoaded', setupDropzone);
  setupDropzone();
  function setupDropzone() {
    const dz = document.getElementById('dropzone');
    if (!dz || dz._wired) return;
    dz._wired = true;
    ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', e => { if (e.dataTransfer.files[0]) readImportFile(e.dataTransfer.files[0]); });
  }
})();

// ---- My Training (self-service) ----
async function loadMyTraining() {
  const prof = await GET('/api/me/profile');
  if (!prof) return;
  if (!prof.linked) {
    document.getElementById('my-unlinked').classList.remove('hidden');
    document.getElementById('my-content').classList.add('hidden');
    return;
  }
  document.getElementById('my-unlinked').classList.add('hidden');
  document.getElementById('my-content').classList.remove('hidden');
  const s = prof.staff;
  document.getElementById('my-profile').innerHTML = `
    <div class="flex items-center gap-3">
      <div class="avatar" style="width:52px;height:52px;font-size:22px;border-radius:50%;background:linear-gradient(135deg,#F58220,#c46314);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700">${(s.FirstName||'?').charAt(0)}${(s.LastName||'').charAt(0)}</div>
      <div><div style="font-size:18px;font-weight:700">${esc(s.FirstName)} ${esc(s.LastName)}</div>
      <div class="cell-sub">${esc(s.JobTitle||'')} ${s.Department?'· '+esc(s.Department):''} ${s.LocName?'· '+esc(s.LocName):''}</div></div>
    </div>`;

  const reqs = await GET('/api/me/requirements') || [];
  const current = reqs.filter(r => r.IsCurrent).length;
  const overdue = reqs.length - current;
  const card = (icon,cls,num,label)=>`<div class="stat-card"><div class="stat-top"><div class="stat-icon ${cls}">${icon}</div></div><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`;
  document.getElementById('my-stats').innerHTML =
    card('✅','green', current, 'Up to Date') +
    card('⚠️','red', overdue, 'Action Needed') +
    card('📊', overdue===0?'green':'amber', reqs.length?Math.round(current/reqs.length*100):100, '% Compliant');

  document.getElementById('my-req-tbody').innerHTML = reqs.length ? reqs.map(r => `
    <tr><td class="cell-strong">${esc(r.CertName)}</td>
    <td>${r.IsCurrent ? '<span class="badge badge-current">Current</span>' : (r.Expiration && new Date(r.Expiration)<new Date() ? '<span class="badge badge-expired">Expired</span>' : '<span class="badge badge-inactive">Not Done</span>')}</td>
    <td>${fmtDate(r.LastCompleted)}</td><td>${expBadge(r.Expiration)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty-state">No required training assigned</td></tr>';

  const hist = await GET('/api/me/training') || [];
  const done = hist.filter(h => h.Complete);
  document.getElementById('my-hist-tbody').innerHTML = done.length ? done.map(h => `
    <tr><td class="cell-strong">${esc(h.CertName||'')}</td><td>${fmtDate(h.Complete)}</td><td>${expBadge(h.Exp)}</td>
    <td>${h.Score!=null?h.Score+'%':''}</td>
    <td>${h.Pass!=null?(h.Pass?'<span class="badge badge-active">Pass</span>':'<span class="badge badge-expired">Fail</span>'):'<span class="badge badge-active">Done</span>'}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty-state">No completed training yet</td></tr>';
}
async function viewMyTranscript() {
  if (currentUser.staffID) viewTranscript(currentUser.staffID);
}

// ---- Online Exams (full rebuild) ----
const Q_TYPES = { multi:'Multiple-choice (many correct)', single:'Single-choice (one correct)', truefalse:'True / False', image:'Image Question', video:'Video Question', info:'Info Block (no answer)' };
const Q_ICONS = { multi:'☑️', single:'🔘', truefalse:'✅', image:'🖼️', video:'🎬', info:'📖' };
let examTimer = null, takingExamData = null;

// ---- Online Exams take page ----
let _allExams = [];
async function loadExams() {
  const data = await GET('/api/exams/tests');
  if (!data) return;
  _allExams = data;
  renderExamTakeList(data);
}
function renderExamTakeList(data) {
  const search = (document.getElementById('exam-search')||{}).value || '';
  const filtered = search ? data.filter(t => t.TestName.toLowerCase().includes(search.toLowerCase())) : data;
  document.getElementById('exams-tbody').innerHTML = filtered.length ? filtered.map(t => `
    <tr>
      <td class="cell-strong">${t.Locked?'🔒 ':'' }${esc(t.TestName)}</td>
      <td>${esc(t.CertName||'—')}</td>
      <td>${t.QuestionCount}${t.QPerExam?' (shows '+t.QPerExam+')':''}</td>
      <td>${t.PassScore||80}%</td>
      <td>${t.TimeLimit ? t.TimeLimit+'m' : 'No limit'}</td>
      <td>${t.Locked?'<span class="badge badge-inactive badge-plain">🔒 Locked</span>':'<span class="badge badge-pending badge-plain">Draft</span>'}</td>
      <td class="actions">
        <button class="btn btn-accent btn-sm" onclick="startExam(${t.TestID})" ${t.QuestionCount?'':'disabled title="Add questions first"'}>▶ Take Exam</button>
        <button class="btn btn-outline btn-sm" onclick="examPrintPaper(${t.TestID})" ${t.QuestionCount?'':'disabled'} title="Open a printable paper copy — questions only, no answers shown">📄 Print Paper Copy</button>
        ${currentUser.admin?`<button class="btn btn-outline btn-sm" onclick="examPrintAnswerKey(${t.TestID})" ${t.QuestionCount?'':'disabled'} title="Print paper copy + answer key page (admin only)">🔑 With Key</button>`:''}
        ${currentUser.admin?`<button class="btn btn-primary btn-sm btn-icon" onclick="navigateTo('exam-builder');ebSelectExam(${t.TestID})" title="Edit in builder">🔨</button>`:''}
      </td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty-state">No exams found</td></tr>';
}

// Old modal helpers — kept for backward compat but redirect to builder
function openTestModal() { navigateTo('exam-builder'); ebNewExam(); }
async function editTest(id) { navigateTo('exam-builder'); await ebSelectExam(id); }

// ---- Exam Builder page ----
let ebAllExams = [], ebCurrentId = null;

async function loadExamBuilder() {
  ebCurrentId = null;
  const data = await GET('/api/exams/tests');
  if (!data) return;
  ebAllExams = data;
  ebRenderList();
  document.getElementById('eb-panel').innerHTML = `<div class="eb-empty"><div class="icon" style="font-size:52px;margin-bottom:12px">🔨</div><p>Select an exam from the list, or click <strong>+ New</strong> to create one.</p></div>`;
}

function ebFilterList() { ebRenderList(); }

function ebRenderList() {
  const search = (document.getElementById('eb-search')||{}).value.toLowerCase();
  const filtered = search ? ebAllExams.filter(t => t.TestName.toLowerCase().includes(search)) : ebAllExams;
  document.getElementById('eb-exam-list').innerHTML = filtered.length ? filtered.map(t => `
    <div class="eb-exam-item ${ebCurrentId===t.TestID?'active':''}" onclick="ebSelectExam(${t.TestID})">
      <div class="eb-exam-item-body">
        <div class="eb-exam-name">${t.Locked?'🔒 ':'' }${esc(t.TestName)}</div>
        <div class="eb-exam-meta">${t.QuestionCount} Q · ${t.PassScore||80}% pass ${t.CertName?'· 🎓':''}</div>
      </div>
      <div class="eb-exam-actions" onclick="event.stopPropagation()">
        <button class="eb-act-btn eb-act-edit" onclick="ebSelectExam(${t.TestID})" title="Edit exam">✏️</button>
        ${currentUser.admin ? `<button class="eb-act-btn eb-act-del" onclick="ebDeleteExam(${t.TestID})" title="Delete exam">🗑</button>` : ''}
      </div>
    </div>`) .join('')
    : '<p class="cell-sub" style="padding:14px 16px">No exams yet</p>';
}

async function ebNewExam() {
  ebCurrentId = null;
  document.querySelectorAll('.eb-exam-item').forEach(el => el.classList.remove('active'));
  editingId.test = null;
  ebRenderPanel(null);
}

async function ebSelectExam(id) {
  const t = await GET('/api/exams/tests/' + id);
  if (!t) return;
  ebCurrentId = id;
  editingId.test = id;
  ebRenderList();
  ebRenderPanel(t);
}

// Open the printable (Word-style) exam paper in a new tab. withAnswers=1 shows the answer key
// (admins only — the server also enforces this); 0 prints the blank questions-only paper.
// Prompts for the course title to show in the header (defaults to the linked qualification, else the exam name).
function ebPrintExam(id, withAnswers) {
  const certSel = document.getElementById('eb-CertID');
  const certName = (certSel && certSel.value) ? ((certSel.options[certSel.selectedIndex] || {}).text || '').trim() : '';
  const defTitle = (certName && !/^—/.test(certName)) ? certName : ((val('eb-Name') || '').trim());
  const course = prompt('Course / qualification title to print in the exam header:', defTitle || '');
  if (course === null) return; // cancelled
  const params = new URLSearchParams({ answers: withAnswers ? '1' : '0' });
  if (course.trim()) params.set('course', course.trim());
  const w = window.open(`/api/exams/tests/${id}/print?${params.toString()}`, '_blank');
  if (!w) toast('Allow pop-ups to open the printable exam.', 'error');
}

function ebRenderPanel(t) {
  const isNew = !t;
  const locked = t && t.Locked;
  const certOpts = (cache.certs||[]).map(c => `<option value="${c.CertID}" ${t&&t.CertID==c.CertID?'selected':''}>${esc(c.CertName)}</option>`).join('');
  const coLogo = cache.company && cache.company.logo ? `<img src="${cache.company.logo}" class="eb-co-logo" alt="${esc(cache.company.name||'')}">` : '';
  const coName = cache.company && cache.company.name ? `<span class="eb-co-name">${esc(cache.company.name)}</span>` : '';
  const companyHdr = (coLogo || coName) ? `<div class="eb-company-hdr">${coLogo}${coName}</div>` : '';
  document.getElementById('eb-panel').innerHTML = `
    <div class="eb-editor">
      ${companyHdr}
      <!-- Exam Settings Card -->
      <div class="card eb-settings-card">
        <div class="card-header">
          <h3>${isNew ? '+ New Exam' : (locked?'🔒 ':'✏️ ') + esc(t.TestName)}</h3>
          <div class="flex gap-2">
            ${!isNew ? `<button class="btn btn-outline btn-sm" onclick="ebPrintExam(${t.TestID},0)" title="Print the exam paper (questions only) — looks like a Word document, for trainees to complete">🖨 Print exam</button>` : ''}
            ${!isNew && currentUser.admin ? `<button class="btn btn-outline btn-sm" onclick="ebPrintExam(${t.TestID},1)" title="Print with the correct answers marked (Administrator answer key)">🖨 Print answer key</button>` : ''}
            ${!isNew && !locked ? `<button class="btn btn-success btn-sm" onclick="ebLockExam(${t.TestID})">🔒 Lock &amp; Publish</button>` : ''}
            ${!isNew && locked && currentUser.admin ? `<button class="btn btn-warning btn-sm" onclick="ebUnlockExam(${t.TestID})">🔓 Unlock</button>` : ''}
          </div>
        </div>
        <div class="card-body">
          ${locked ? '<div class="alert alert-success" style="margin-bottom:12px"><span>🔒</span><div>This exam is locked. Unlock to edit settings or questions (Admin only).</div></div>' : ''}
          <div class="eb-settings-grid">
            <div class="form-group eb-col-full"><label>Exam Name *</label><input id="eb-Name" value="${isNew?'':(esc(t.TestName||''))}" placeholder="e.g. Forklift Safety Assessment" ${locked?'disabled':''}></div>
            <div class="form-group"><label>Linked Qualification (auto-records pass)</label><select id="eb-CertID" ${locked?'disabled':''}><option value="">— None —</option>${certOpts}</select></div>
            <div class="form-group"><label>Pass Score (%)</label><input id="eb-PassScore" type="number" min="1" max="100" value="${isNew?80:(t.PassScore||80)}" ${locked?'disabled':''}></div>
            <div class="form-group"><label>Time Limit (min)</label><input id="eb-TimeLimit" type="number" min="0" placeholder="No limit" value="${isNew?'':(t.TimeLimit||'')}" ${locked?'disabled':''}></div>
            <div class="form-group"><label>Questions per attempt</label><input id="eb-QPerExam" type="number" min="1" placeholder="All" value="${isNew?'':(t.QPerExam||'')}" ${locked?'disabled':''} oninput="updateQbSummary(_ebQuestions)"></div>
            <div class="form-group"><label>Randomise questions &amp; answers</label><select id="eb-Randomize" ${locked?'disabled':''}><option value="1" ${(!t||t.Randomize)?' selected':''}>Yes — shuffle each attempt</option><option value="0" ${(t&&!t.Randomize)?'selected':''}>No — fixed order</option></select></div>
            <div class="form-group"><label>Show answers after</label><select id="eb-ShowAnswers" ${locked?'disabled':''}><option value="1" ${(!t||t.ShowAnswers!==0)?'selected':''}>Yes — reveal on finish</option><option value="0" ${(t&&t.ShowAnswers===0)?'selected':''}>No — score only</option></select></div>
            <div class="form-group eb-col-full"><label>Instructions</label><textarea id="eb-Instructions" rows="2" placeholder="Shown to the employee before starting…" ${locked?'disabled':''}>${isNew?'':(esc(t.Instructions||''))}</textarea></div>
          </div>
          ${!locked ? `<div class="flex gap-2 mt-2">
            <button class="btn btn-accent" onclick="ebSaveSettings()">${isNew?'Create Exam':'Save Settings'}</button>
            ${!isNew && currentUser.admin ?`<button class="btn btn-danger btn-sm" onclick="ebDeleteExam(${t.TestID})">🗑 Delete Exam</button>`:''}
          </div>` : ''}
        </div>
      </div>

      <!-- Question Bank -->
      ${!isNew ? `<div class="card mt-2 ${locked?'eb-locked-card':''}">
        <div class="card-header">
          <h3>🗂 Question Bank <span class="cell-sub">(${t.QuestionCount||0} questions)</span></h3>
          ${!locked ? `<div class="eb-q-btns">
            <button class="btn btn-outline btn-sm" onclick="addQuestionRow('multi')">☑️ Multi</button>
            <button class="btn btn-outline btn-sm" onclick="addQuestionRow('single')">🔘 Single</button>
            <button class="btn btn-outline btn-sm" onclick="addQuestionRow('truefalse')">✅ T/F</button>
            <button class="btn btn-outline btn-sm" onclick="addQuestionRow('image')">🖼 Image</button>
            <button class="btn btn-outline btn-sm" onclick="addQuestionRow('video')">🎬 Video</button>
            <button class="btn btn-outline btn-sm" onclick="addQuestionRow('info')">📖 Info</button>
            <span class="eb-q-sep"></span>
            <button class="btn btn-ghost btn-sm" onclick="downloadQuestionTemplate()" title="Download a CSV template to fill in">⬇ Template</button>
            <button class="btn btn-primary btn-sm" onclick="document.getElementById('eb-import-file').click()" title="Import questions from a filled-in CSV">⬆ Import CSV</button>
            <input type="file" id="eb-import-file" accept=".csv" class="hidden" onchange="importQuestionsFile(this)">
            ${currentUser.admin ? `<button class="btn btn-accent btn-sm" onclick="ebAiExtractOpen(${t.TestID})" title="Upload a document (DOCX, PDF, image, or TXT) — AI generates exam questions from it">🤖 AI from Doc</button>` : ''}
            <input type="file" id="eb-ai-extract-file" accept=".docx,.pdf,.pptx,.png,.jpg,.jpeg,.webp,.gif,.txt" class="hidden" onchange="ebAiExtractRun(this, ${t.TestID})">
          </div>` : ''}
        </div>
        <div class="card-body">
          ${locked ? '<div class="alert alert-info" style="margin-bottom:10px"><span>🔒</span><div>Questions are locked. Unlock the exam to add or edit questions.</div></div>' : ''}
          ${(!locked && t.QuestionCount) ? `<div class="eb-trans-bar">
            <span class="eb-trans-lbl">🌐 Translate exam</span>
            <select id="eb-trans-lang"><option value="">— select language —</option>${['Spanish','French','Portuguese','Mandarin Chinese','Indonesian','Bahasa Melayu','Thai','Vietnamese','Tagalog','Hindi','Japanese','Korean','German','Italian','Russian','Arabic'].map(l=>`<option value="${l}">${l}</option>`).join('')}</select>
            <button class="btn btn-accent btn-sm" id="eb-trans-btn" onclick="ebTranslateExam(${t.TestID})">🌐 Translate All</button>
            <button class="btn btn-ghost btn-sm" onclick="ebKbToggle()" title="Pick Knowledge Base articles to use as site reference during translation">📚 Knowledge Base…</button>
            <span class="cell-sub" style="flex-basis:100%;font-size:11px">Appends the translation under each question and answer (bilingual), using the approved terminology glossary and any selected Knowledge Base articles. Or use the 🌐 button on a single question.</span>
            <div id="eb-kb-panel" class="eb-kb-panel" style="display:none;flex-basis:100%"></div>
          </div>` : ''}
          <div id="qb-summary" class="qb-summary"></div>
          <div id="questions-list"></div>
          ${!locked ? '<p class="cell-sub mt-1">Use the buttons above to add questions. The ✨ AI Suggest button appears on each question to generate answers automatically.</p>' : ''}
        </div>
      </div>` : '<div class="alert alert-info mt-2"><span>💡</span><div>Save the exam settings first, then add questions to the question bank.</div></div>'}
    </div>`;

  if (!isNew && t.questions) renderQuestionsList(t.questions);
  else if (!isNew) GET('/api/exams/tests/' + t.TestID).then(full => { if (full) renderQuestionsList(full.questions); });
}

// AI: open a small dialog to collect count/type, then trigger the file picker.
let _ebAiExtractCfg = null;
function ebAiExtractOpen(testId) {
  document.getElementById('eb-ai-extract-dialog')?.remove();
  const el = document.createElement('div');
  el.id = 'eb-ai-extract-dialog';
  el.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
  el.innerHTML = `<div style="background:var(--bg,#fff);border-radius:10px;width:460px;max-width:92vw;box-shadow:0 8px 32px rgba(0,0,0,.18);overflow:hidden">
    <div style="padding:14px 18px;border-bottom:1px solid var(--border,#e5e7eb)">
      <h3 style="margin:0;font-size:15px;font-weight:700">🤖 Generate Exam Questions from Document</h3>
      <p style="margin:6px 0 0;font-size:12px;color:var(--text-soft)">Upload a DOCX, PDF, image, or TXT — Claude will draft questions and answers based on its content.</p>
    </div>
    <div style="padding:14px 18px;display:grid;gap:10px">
      <label style="font-size:13px;font-weight:600">Number of questions
        <input id="ai-x-count" type="number" min="1" max="50" value="10" style="width:100%;margin-top:4px"></label>
      <label style="font-size:13px;font-weight:600">Question types
        <select id="ai-x-mix" style="width:100%;margin-top:4px">
          <option value="mixed" selected>Mixed (recommended)</option>
          <option value="single">Single-choice only</option>
          <option value="multi">Multi-select only</option>
          <option value="truefalse">True / False only</option>
        </select></label>
      <label style="font-size:13px;font-weight:600">Difficulty
        <select id="ai-x-diff" style="width:100%;margin-top:4px">
          <option value="easy">Easy — recall</option>
          <option value="medium" selected>Medium — applied understanding</option>
          <option value="hard">Hard — analysis &amp; edge cases</option>
        </select></label>
    </div>
    <div style="display:flex;gap:10px;padding:12px 18px;border-top:1px solid var(--border,#e5e7eb);justify-content:flex-end">
      <button class="btn btn-outline" id="ai-x-cancel">Cancel</button>
      <button class="btn btn-accent" id="ai-x-pick">📄 Choose Document…</button>
    </div>
  </div>`;
  document.body.appendChild(el);
  el.querySelector('#ai-x-cancel').onclick = () => el.remove();
  el.querySelector('#ai-x-pick').onclick = () => {
    _ebAiExtractCfg = {
      count: parseInt(document.getElementById('ai-x-count').value, 10) || 10,
      typeMix: document.getElementById('ai-x-mix').value,
      difficulty: document.getElementById('ai-x-diff').value,
    };
    el.remove();
    const fi = document.getElementById('eb-ai-extract-file');
    if (fi) { fi.value = ''; fi.click(); }
  };
}

async function ebAiExtractRun(input, testId) {
  const file = input.files && input.files[0];
  if (!file) return;
  const cfg = _ebAiExtractCfg || { count: 10, typeMix: 'mixed', difficulty: 'medium' };
  _ebAiExtractCfg = null;
  // Show a blocking progress overlay (AI calls can take 20–60s)
  document.getElementById('eb-ai-progress')?.remove();
  const ov = document.createElement('div');
  ov.id = 'eb-ai-progress';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
  ov.innerHTML = `<div style="background:#fff;padding:24px 28px;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.18);text-align:center;min-width:280px">
    <div style="font-size:34px;margin-bottom:8px">🤖</div>
    <strong style="font-size:14px">AI is reading <span style="color:#1E3A5F">${esc(file.name)}</span></strong>
    <div style="font-size:12px;color:#64748b;margin-top:8px">Generating ${cfg.count} ${cfg.difficulty} question(s)…<br>This usually takes 20–60 seconds.</div>
  </div>`;
  document.body.appendChild(ov);

  const fd = new FormData();
  fd.append('file', file);
  fd.append('count', String(cfg.count));
  fd.append('typeMix', cfg.typeMix);
  fd.append('difficulty', cfg.difficulty);
  try {
    const resp = await fetch(`/api/exams/tests/${testId}/ai-extract`, { method: 'POST', body: fd, credentials: 'include' });
    const r = await resp.json().catch(() => ({ error: 'Server returned non-JSON response.' }));
    if (!resp.ok) { toast(r.error || ('AI extract failed (HTTP ' + resp.status + ')'), 'error'); return; }
    toast(`Added ${r.inserted} AI-generated question(s) from ${esc(r.source || file.name)}.`);
    const t = await GET('/api/exams/tests/' + testId);
    if (t) ebRenderPanel(t);
  } catch (e) {
    toast('AI extract failed: ' + (e && e.message ? e.message : 'network error'), 'error');
  } finally {
    ov.remove();
    input.value = '';
  }
}

// Knowledge Base picker (mirrors Content Studio) — lets the admin choose KB articles
// to use as site reference during exam translation. Loaded lazily on first toggle.
let _ebKbArticles = null;
async function ebKbToggle() {
  const panel = document.getElementById('eb-kb-panel');
  if (!panel) return;
  if (panel.style.display === 'none' || !panel.style.display) {
    if (!_ebKbArticles) { _ebKbArticles = await GET('/api/content/kb-context') || []; }
    if (!_ebKbArticles.length) {
      panel.innerHTML = '<div class="cell-sub" style="padding:8px 4px">No published Knowledge Base articles available.</div>';
    } else {
      // Group by category, same as Content Studio
      const groups = {};
      for (const a of _ebKbArticles) { const k = a.categoryName || 'General'; (groups[k] = groups[k] || []).push(a); }
      panel.innerHTML = `<div class="eb-kb-head"><strong>📚 Use as site reference for translation</strong>
          <span class="cell-sub">Tick any articles whose facts/terminology should guide the translator.</span>
          <button class="btn btn-ghost btn-sm" onclick="ebKbToggle()" style="margin-left:auto">✕ Close</button></div>
        <div class="eb-kb-list">` + Object.keys(groups).sort().map(g =>
          `<div class="eb-kb-group"><div class="eb-kb-group-h">${g}</div>` +
          groups[g].map(a => `<label class="eb-kb-item"><input type="checkbox" class="eb-kb-cb" value="${a.ArticleID}"><span>${esc(a.Title)}</span></label>`).join('') +
          `</div>`).join('') + `</div>`;
    }
    panel.style.display = 'block';
  } else {
    panel.style.display = 'none';
  }
}
function _ebSelectedKbIds() {
  return [...document.querySelectorAll('#eb-kb-panel .eb-kb-cb:checked')].map(c => parseInt(c.value, 10)).filter(Boolean);
}

async function ebTranslateExam(testId) {
  const lang = val('eb-trans-lang');
  if (!lang) { toast('Select a language first.', 'error'); return; }
  if (!confirm(`Translate this entire exam into ${lang}?\n\nThe ${lang} translation will be appended under each question and answer (bilingual). This updates the saved exam.`)) return;
  const btn = document.getElementById('eb-trans-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Translating…'; }
  try {
    const kbArticleIds = _ebSelectedKbIds();
    const r = await PUT(`/api/exams/tests/${testId}/translate`, { targetLang: lang, kbArticleIds });
    if (!ok(r)) return;
    const bits = [r.glossaryTerms ? `${r.glossaryTerms} glossary term(s)` : '', r.kbArticles ? `${r.kbArticles} KB article(s)` : ''].filter(Boolean).join(', ');
    toast(`Translated ${r.questions} question(s) to ${lang}${bits ? ` — applied ${bits}` : ''}.`);
    const t = await GET('/api/exams/tests/' + testId);
    if (t) ebRenderPanel(t);
  } finally { if (btn) { btn.disabled = false; btn.textContent = '🌐 Translate All'; } }
}

const EB_TRANS_LANGS = ['Spanish','French','Portuguese','Mandarin Chinese','Indonesian','Bahasa Melayu','Thai','Vietnamese','Tagalog','Hindi','Japanese','Korean','German','Italian','Russian','Arabic'];

// Open a small popover next to the clicked button to pick a target language.
// Returns a Promise that resolves to the chosen language string, or null if cancelled.
function _ebPickLanguage(anchorBtn) {
  return new Promise(resolve => {
    document.getElementById('eb-lang-pop')?.remove();
    const rect = anchorBtn.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.id = 'eb-lang-pop';
    pop.className = 'eb-lang-pop';
    pop.style.cssText = `position:fixed;top:${Math.min(rect.bottom + 6, window.innerHeight - 360)}px;left:${Math.min(rect.left - 80, window.innerWidth - 230)}px;z-index:9999;background:#fff;border:1px solid var(--border,#e5e7eb);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.18);min-width:220px;max-height:340px;overflow-y:auto`;
    pop.innerHTML = `<div style="padding:9px 12px;border-bottom:1px solid var(--border,#e5e7eb);font-weight:700;font-size:13px">🌐 Translate to…</div>
      <div style="padding:6px">` +
      EB_TRANS_LANGS.map(l => `<button class="eb-lang-opt" data-lang="${l}" style="display:block;width:100%;text-align:left;padding:7px 10px;border:0;background:transparent;border-radius:6px;cursor:pointer;font-size:13px">${l}</button>`).join('') +
      `</div>`;
    document.body.appendChild(pop);
    pop.querySelectorAll('.eb-lang-opt').forEach(b => {
      b.onmouseenter = () => b.style.background = '#f1f5f9';
      b.onmouseleave = () => b.style.background = 'transparent';
      b.onclick = () => { resolve(b.dataset.lang); pop.remove(); document.removeEventListener('mousedown', away, true); };
    });
    const away = e => { if (!pop.contains(e.target) && e.target !== anchorBtn) { pop.remove(); document.removeEventListener('mousedown', away, true); resolve(null); } };
    setTimeout(() => document.addEventListener('mousedown', away, true), 0);
  });
}

// Translate a single question (with its answers). Triggered by the 🌐 button on each question card.
async function ebTranslateQuestion(qid, btn) {
  let lang = val('eb-trans-lang');
  // If the user didn't pick a language in the top bar, pop up a small language picker right where they clicked.
  if (!lang) lang = await _ebPickLanguage(btn);
  if (!lang) return; // user cancelled
  // Sync the top bar so subsequent clicks are one-touch and Translate All is consistent
  const sel = document.getElementById('eb-trans-lang');
  if (sel && [...sel.options].some(o => o.value === lang)) sel.value = lang;
  const orig = btn ? btn.textContent : '🌐';
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    const kbArticleIds = _ebSelectedKbIds();
    const r = await PUT(`/api/exams/questions/${qid}/translate`, { targetLang: lang, kbArticleIds });
    if (!ok(r)) return;
    const bits = [r.glossaryTerms ? `${r.glossaryTerms} glossary term(s)` : '', r.kbArticles ? `${r.kbArticles} KB article(s)` : ''].filter(Boolean).join(', ');
    toast(`Question translated to ${lang}${bits ? ` (applied ${bits})` : ''}.`);
    if (ebCurrentId) { const t = await GET('/api/exams/tests/' + ebCurrentId); if (t) ebRenderPanel(t); }
  } finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
}

async function ebSaveSettings() {
  const d = {
    TestName: document.getElementById('eb-Name').value.trim(),
    CertID: document.getElementById('eb-CertID').value,
    PassScore: document.getElementById('eb-PassScore').value,
    TimeLimit: document.getElementById('eb-TimeLimit').value,
    QPerExam: document.getElementById('eb-QPerExam').value,
    Randomize: document.getElementById('eb-Randomize').value === '1',
    ShowAnswers: document.getElementById('eb-ShowAnswers').value === '1',
    Instructions: document.getElementById('eb-Instructions').value
  };
  if (!d.TestName) return toast('Exam name is required.', 'error');
  if (editingId.test) {
    const r = await PUT('/api/exams/tests/' + editingId.test, d);
    if (!ok(r)) return;
    toast('Exam settings saved.');
  } else {
    // Replace-on-duplicate: if an exam with this name already exists, confirm then replace it.
    const exs = (await GET('/api/exams/tests')) || [];
    const dupes = exs.filter(t => _normName(t.TestName) === _normName(d.TestName));
    if (!confirmOverwrite(d.TestName, dupes, 'exam')) return;
    const r = await POST('/api/exams/tests', d);
    if (!ok(r)) return;
    for (const t of dupes) { if (t.TestID === r.TestID) continue; try { await DEL('/api/exams/tests/' + t.TestID); } catch {} }
    editingId.test = r.TestID;
    ebCurrentId = r.TestID;
    toast('Exam created — now add questions below.');
  }
  const data = await GET('/api/exams/tests');
  if (data) { ebAllExams = data; _allExams = data; }
  const t = await GET('/api/exams/tests/' + editingId.test);
  if (t) { ebCurrentId = t.TestID; ebRenderList(); ebRenderPanel(t); }
  renderExamTakeList(ebAllExams);
}

async function ebLockExam(id) {
  if (!confirm('Lock this exam? Employees cannot see draft exams. You can unlock later (Admin).')) return;
  const r = await PUT(`/api/exams/tests/${id}/lock`, { locked: true });
  if (!ok(r)) return;
  toast('🔒 Exam locked and published.');
  await ebSelectExam(id);
  const data = await GET('/api/exams/tests'); if (data) { ebAllExams=data; _allExams=data; renderExamTakeList(data); }
}

async function ebUnlockExam(id) {
  if (!confirm('Unlock this exam for editing?')) return;
  const r = await PUT(`/api/exams/tests/${id}/lock`, { locked: false });
  if (!ok(r)) return;
  toast('🔓 Exam unlocked.');
  await ebSelectExam(id);
}

async function ebDeleteExam(id) {
  if (!confirm('Delete this exam and all its questions?')) return;
  const r = await DEL('/api/exams/tests/' + id);
  if (!ok(r)) return;
  toast('Exam deleted.');
  editingId.test = null; ebCurrentId = null;
  const data = await GET('/api/exams/tests'); if (data) { ebAllExams=data; _allExams=data; renderExamTakeList(data); }
  loadExamBuilder();
}

async function saveTest() { await ebSaveSettings(); }
async function deleteTest(id) { await ebDeleteExam(id); }

async function editTest(id) { navigateTo('exam-builder'); await ebSelectExam(id); }

// ---- Exam Builder page ----
let _ebLoaded = false;
// Reuse addField + all question functions — they write to #questions-list which is now on the builder page

// ---------- Question builder ----------
let _ebQuestions = [];
function renderQuestionsList(questions) {
  _ebQuestions = questions || [];
  const host = document.getElementById('questions-list');
  if (!host) return;
  if (!questions.length) { host.innerHTML = '<p class="text-muted">No questions yet — use the buttons above to add to the bank.</p>'; updateQbSummary([]); return; }
  updateQbSummary(questions);
  host.innerHTML = questions.map((q,i) => {
    const isInfo = q.QuestionType === 'info';
    return `
    <div class="qb-card ${q.Mandatory?'qb-mandatory':''}" data-qid="${q.QID}">
      <div class="qb-head">
        <span class="qb-type">${Q_ICONS[q.QuestionType]||'❓'} ${Q_TYPES[q.QuestionType]||q.QuestionType}</span>
        ${q.BankTag?`<span class="badge badge-pending badge-plain">🏷 ${esc(q.BankTag)}</span>`:''}
        ${!isInfo ? `<label class="qb-mand-toggle" title="Mandatory questions appear in every exam attempt. Optional ones are drawn at random from the bank.">
          <input type="checkbox" ${q.Mandatory?'checked':''} onclick="toggleMandatory(${q.QID}, this.checked)">
          <span>${q.Mandatory?'⭐ Mandatory':'Optional (random pool)'}</span>
        </label>` : '<span class="cell-sub">Always shown</span>'}
        <div class="ml-auto flex gap-1">
          ${currentUser.admin ? `<button class="btn btn-ghost btn-sm btn-icon eb-q-trans-btn" data-qid="${q.QID}" onclick="ebTranslateQuestion(${q.QID}, this)" title="Translate this question — select a language in the Translate bar first">🌐</button>` : ''}
          <button class="btn btn-ghost btn-sm btn-icon" onclick="editQuestionCard(this)" title="Edit">✏️</button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteQuestion(${q.QID})" title="Delete">🗑️</button>
        </div>
      </div>
      <div class="qb-body">
        ${q.Qimage?`<img class="qb-preview" src="${esc(q.Qimage)}">`:''}
        ${q.VideoUrl?`<div class="cell-sub">🎬 ${esc(q.VideoUrl)}</div>`:''}
        ${isInfo?`<div class="qb-info">${esc(q.InfoText||q.Question||'')}</div>`:`<strong>${esc(q.Question||'')}</strong>`}
        ${q.answers&&q.answers.length?`<div class="qb-answers">${q.answers.map(a=>`<span class="qb-ans ${a.IsCorrect?'correct':''}">${a.IsCorrect?'✅':'▢'} ${esc(a.Answer)}</span>`).join('')}</div>`:''}
      </div>
    </div>`;}).join('');
}

// Task 1: summary of how many questions are available / used in the exam
function updateQbSummary(questions) {
  const box = document.getElementById('qb-summary');
  if (!box) return;
  const scored = questions.filter(q => q.QuestionType !== 'info');
  const infos = questions.filter(q => q.QuestionType === 'info');
  const mand = scored.filter(q => q.Mandatory).length;
  const pool = scored.length - mand;
  // QPerExam from the settings field if present
  const qpe = parseInt((document.getElementById('eb-QPerExam')||{}).value, 10);
  let perAttempt;
  if (qpe && qpe > 0) perAttempt = Math.max(qpe, mand);
  else perAttempt = scored.length;
  box.innerHTML = `
    <div class="qb-stat"><span class="n">${questions.length}</span><span class="l">Questions in bank</span></div>
    <div class="qb-stat green"><span class="n">${mand}</span><span class="l">⭐ Mandatory (always shown)</span></div>
    <div class="qb-stat blue"><span class="n">${pool}</span><span class="l">Optional pool (random)</span></div>
    <div class="qb-stat amber"><span class="n">${perAttempt}${infos.length?` + ${infos.length} info`:''}</span><span class="l">Shown per attempt</span></div>`;
}

// Task 2: quick toggle mandatory flag
async function toggleMandatory(qid, checked) {
  const r = await PUT('/api/exams/questions/' + qid + '/mandatory', { mandatory: checked });
  if (!ok(r)) return;
  await ebRefreshQuestions();
}

// ---- Bulk question import (CSV template + upload) ----
function downloadQuestionTemplate() {
  const headers = ['Type','Question','Mandatory','Tag','Answer1','Answer2','Answer3','Answer4','Correct'];
  const samples = [
    ['single','What is the maximum safe load for the haul truck?','Yes','Safety','100 tonnes','150 tonnes','200 tonnes','250 tonnes','2'],
    ['multi','Which checks are part of a pre-start inspection?','Yes','Pre-Op','Tyres & wheels','Fluid levels','Lights & horn','Radio station','1,2,3'],
    ['truefalse','You must wear a seatbelt at all times when operating.','No','Safety','','','','','True']
  ];
  const toCsvLine = arr => arr.map(c => /[",\n]/.test(String(c)) ? '"'+String(c).replace(/"/g,'""')+'"' : c).join(',');
  const csv = [toCsvLine(headers), ...samples.map(toCsvLine)].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'exam_questions_template.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Template downloaded. Fill it in, then use ⬆ Import CSV.');
}

async function importQuestionsFile(input) {
  const file = input.files[0];
  input.value = ''; // allow re-selecting the same file later
  if (!file) return;
  if (!editingId.test) return toast('Save the exam first.', 'error');
  if (!file.name.toLowerCase().endsWith('.csv')) return toast('Please select a .csv file.', 'error');
  const reader = new FileReader();
  reader.onload = async () => {
    const rows = parseCSV(reader.result);
    if (rows.length < 2) return toast('That file has no question rows.', 'error');
    const headers = rows[0].map(h => h.trim());
    const objects = rows.slice(1).map(r => {
      const o = {}; headers.forEach((h, i) => o[h] = (r[i] || '').trim()); return o;
    });
    const r = await POST(`/api/exams/tests/${editingId.test}/import-questions`, { rows: objects });
    if (!ok(r)) return;
    let msg = `✓ Imported ${r.imported} question${r.imported===1?'':'s'}.`;
    if (r.skipped) msg += ` ${r.skipped} skipped.`;
    toast(msg, r.skipped ? 'warn' : 'success');
    if (r.errors && r.errors.length) {
      console.warn('Import issues:', r.errors);
      alert('Some rows were skipped:\n\n' + r.errors.join('\n'));
    }
    await ebRefreshQuestions();
  };
  reader.readAsText(file);
}

function addQuestionRow(type) {
  if (!editingId.test) return toast('Save the exam first.', 'error');
  const name = 'nq-' + Date.now();
  const isInfo = type === 'info';
  const hasPic = type === 'image' || type === 'multi' || type === 'single' || type === 'truefalse' || type === 'video';
  const isVideo = type === 'video';
  const tfAnswers = type === 'truefalse';
  const wrap = document.createElement('div');
  wrap.className = 'qb-new-card';
  wrap.innerHTML = `
    <div class="qb-new-header">${Q_ICONS[type]} ${Q_TYPES[type]}</div>
    <input type="hidden" class="nq-type" value="${type}">
    ${isInfo
      ? `<div class="form-group"><label>Information / reading text</label><textarea class="nq-infotext" rows="4" placeholder="Text the employee reads before answering..."></textarea></div>
         <div class="form-group"><label>Optional image URL</label><input class="nq-img-url" placeholder="https://... or upload below"></div>
         <input type="file" class="nq-img-file" accept="image/*" onchange="nqPreviewImg(this)">`
      : `<div class="form-group"><label>Question *</label>
           <div class="ai-q-row">
             <textarea class="nq-text" rows="2" placeholder="Enter the question text..."></textarea>
             <button type="button" class="btn btn-primary btn-sm ai-suggest-btn" onclick="aiSuggestAnswers(this)">✨ AI Suggest Answers</button>
           </div>
         </div>`}
    ${hasPic && !isInfo ? `<div class="qb-media">
        <label>Image (optional) <span class="cell-sub">employee sees this before answering</span></label>
        <div class="flex gap-2">
          <input class="nq-img-url w-full" placeholder="Image URL or upload →">
          <label class="btn btn-outline btn-sm" style="cursor:pointer">📁 Upload<input type="file" class="hidden" accept="image/*" onchange="nqUploadImg(this)"></label>
        </div>
        <img class="nq-img-preview hidden">
      </div>` : ''}
    ${isVideo ? `<div class="form-group"><label>Video URL (YouTube, SharePoint, MP4 link)</label><input class="nq-video" placeholder="https://..."></div>` : ''}
    ${!isInfo ? `<div class="nq-ans-wrap">
      <div class="flex items-center mb-1 gap-2">
        <label class="cell-sub">${tfAnswers?'Answers:':'Answers — tick the correct one(s):'}</label>
        <span class="ai-hint-box hidden"></span>
      </div>
      ${tfAnswers
        ? `<div class="nq-tf">
            <label class="qb-tf-btn"><input type="radio" name="${name}" class="nq-correct" value="0"> ✅ True</label>
            <label class="qb-tf-btn"><input type="radio" name="${name}" class="nq-correct" value="1"> ❌ False</label>
          </div>`
        : `<div class="nq-ans-list" id="anslist-${name}">
            ${[0,1,2,3].map(i=>`<div class="nq-ans-row">
              <input type="${type==='multi'?'checkbox':'radio'}" name="${name}" class="nq-correct" value="${i}">
              <input class="nq-ans w-full" placeholder="Answer ${String.fromCharCode(65+i)}">
              <button type="button" class="grid-del" onclick="this.parentElement.remove()">✕</button>
            </div>`).join('')}
          </div>
          ${type!=='truefalse'?`<button type="button" class="btn btn-ghost btn-sm mt-1" onclick="addAnsRow('anslist-${name}','${type}')">+ Add answer</button>`:''}`}
    </div>` : ''}
    <div class="nq-footer">
      <div class="form-group" style="flex:0 0 200px"><label>Bank tag (optional)</label><input class="nq-tag" placeholder="e.g. Safety, Pre-Op"></div>
      ${!isInfo ? `<label class="nq-mand"><input type="checkbox" class="nq-mandatory"> ⭐ Mandatory — always include in exam</label>` : ''}
      <button class="btn btn-success btn-sm" onclick="saveQuestion(this)">Save Question</button>
      <button class="btn btn-outline btn-sm" onclick="this.closest('.qb-new-card').remove()">Cancel</button>
    </div>`;
  document.getElementById('questions-list').prepend(wrap);
}

// ---- ✨ AI Answer Suggestion ----
async function aiSuggestAnswers(btn) {
  const card = btn.closest('.qb-new-card');
  const type = card.querySelector('.nq-type').value;
  const questionEl = card.querySelector('.nq-text');
  const question = (questionEl ? questionEl.value : '').trim();
  const bankTag = (card.querySelector('.nq-tag') || {}).value || '';

  if (!question) return toast('Enter a question first, then click AI Suggest.', 'error');

  // Disable button and show loading state
  btn.disabled = true;
  const origLabel = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Thinking…';

  // Clear and show hint area
  const hintBox = card.querySelector('.ai-hint-box');
  if (hintBox) { hintBox.textContent = ''; hintBox.classList.add('hidden'); }

  const r = await POST('/api/exams/ai-suggest', { question, questionType: type, bankTag });
  btn.disabled = false;
  btn.innerHTML = origLabel;

  if (!ok(r)) return;

  // Show the AI's reasoning hint + KB sources used
  if (hintBox) {
    let hintHtml = '';
    if (r.hint) hintHtml += `<div>💡 ${esc(r.hint)}</div>`;
    if (r.kbSources && r.kbSources.length) {
      hintHtml += `<div class="ai-kb-sources">📚 Verified against knowledge base: ${r.kbSources.map(s => `<em>${esc(s)}</em>`).join(', ')}</div>`;
    } else {
      hintHtml += `<div class="ai-kb-sources ai-kb-none">ℹ️ No matching knowledge base articles found — answers based on general expertise.</div>`;
    }
    hintBox.innerHTML = hintHtml;
    hintBox.classList.remove('hidden');
  }

  const answers = r.answers || [];
  if (!answers.length) return toast('AI returned no answers — try rephrasing the question.', 'error');

  if (type === 'truefalse') {
    // For true/false just mark the correct radio
    const correctVal = answers.findIndex(a => a.correct);
    const radios = card.querySelectorAll('.nq-correct');
    radios.forEach((radio, i) => { radio.checked = (i === (correctVal >= 0 ? 0 : 0)); });
    toast('AI confirmed True/False — tick the correct one.');
    return;
  }

  // Rebuild the answer list
  const listName = card.querySelector('[id^="anslist-"]') ? card.querySelector('[id^="anslist-"]').id : null;
  const list = listName ? document.getElementById(listName) : card.querySelector('.nq-ans-list');
  if (!list) return;

  list.innerHTML = '';
  const inputType = type === 'multi' ? 'checkbox' : 'radio';
  const groupName = list.id ? list.id.replace('anslist-', 'nq-') : 'nq-ai-' + Date.now();

  answers.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'nq-ans-row ai-populated';
    row.innerHTML = `
      <input type="${inputType}" name="${groupName}" class="nq-correct" value="${i}" ${a.correct ? 'checked' : ''}>
      <input class="nq-ans w-full" value="${esc(a.Answer || '')}">
      <button type="button" class="grid-del" onclick="this.parentElement.remove()">✕</button>`;
    list.appendChild(row);
  });

  toast(`✨ ${answers.length} answers generated — review, adjust if needed, then Save Question.`, 'success');
}

function addAnsRow(listId, type) {
  const list = document.getElementById(listId);
  const name = listId.replace('anslist-', 'nq-');
  const i = list.querySelectorAll('.nq-ans-row').length;
  const row = document.createElement('div'); row.className = 'nq-ans-row';
  row.innerHTML = `<input type="${type==='multi'?'checkbox':'radio'}" name="${name}" class="nq-correct" value="${i}">
    <input class="nq-ans w-full" placeholder="Answer ${String.fromCharCode(65+i)}">
    <button type="button" class="grid-del" onclick="this.parentElement.remove()">✕</button>`;
  list.appendChild(row);
}

function nqPreviewImg(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader(); reader.onload = e => {
    const img = input.closest('.qb-new-card').querySelector('.nq-img-preview') || input.closest('[class^=form]').querySelector('.nq-img-preview');
    if (img) { img.src = e.target.result; img.classList.remove('hidden'); }
    const urlInput = input.closest('.qb-new-card,div').querySelector('.nq-img-url');
    if (urlInput) urlInput.value = e.target.result;
  }; reader.readAsDataURL(file);
}

async function nqUploadImg(input) {
  const file = input.files[0]; if (!file) return;
  const fd = new FormData(); fd.append('image', file);
  const r = await fetch('/api/exams/questions/upload-image', { method: 'POST', body: fd, credentials: 'include' });
  const j = await r.json();
  if (j.error) return toast(j.error, 'error');
  const card = input.closest('.qb-new-card');
  const urlIn = card.querySelector('.nq-img-url'); if (urlIn) urlIn.value = j.url;
  let prev = card.querySelector('.nq-img-preview'); if (!prev) { prev = document.createElement('img'); prev.className='nq-img-preview'; card.querySelector('.qb-media').appendChild(prev); }
  prev.src = j.url; prev.classList.remove('hidden');
}

async function saveQuestion(btn) {
  const card = btn.closest('.qb-new-card');
  const type = card.querySelector('.nq-type').value;
  const mandEl = card.querySelector('.nq-mandatory');
  const data = { QuestionType: type, BankTag: (card.querySelector('.nq-tag')||{}).value || '', Mandatory: mandEl ? mandEl.checked : false };
  if (type === 'info') {
    data.InfoText = (card.querySelector('.nq-infotext')||{}).value || '';
    data.Question = data.InfoText.slice(0, 80);
    data.Qimage = (card.querySelector('.nq-img-url')||{}).value || null;
    data.answers = [];
  } else {
    data.Question = (card.querySelector('.nq-text')||{}).value.trim();
    if (!data.Question) return toast('Enter a question.', 'error');
    data.Qimage = (card.querySelector('.nq-img-url')||{}).value || null;
    data.VideoUrl = (card.querySelector('.nq-video')||{}).value || null;
    if (type === 'truefalse') {
      const checked = card.querySelector('.nq-correct:checked');
      if (!checked) return toast('Select True or False as correct.', 'error');
      data.answers = [{ Answer: 'True', correct: checked.value==='0' }, { Answer: 'False', correct: checked.value==='1' }];
    } else {
      const rows = [...card.querySelectorAll('.nq-ans-row')];
      const inputs = rows.map(r => ({ ans: r.querySelector('.nq-ans').value.trim(), chk: r.querySelector('.nq-correct') })).filter(x => x.ans);
      if (inputs.length < 2) return toast('Enter at least 2 answers.', 'error');
      const hasCorrect = inputs.some(x => x.chk && x.chk.checked);
      if (!hasCorrect) return toast('Mark at least one correct answer.', 'error');
      data.answers = inputs.map(x => ({ Answer: x.ans, correct: x.chk && x.chk.checked }));
    }
  }
  const r = await POST(`/api/exams/tests/${editingId.test}/questions`, data);
  if (!ok(r)) return;
  toast('Question saved to bank.');
  card.remove();
  await ebRefreshQuestions();
}

// Refresh the question list + count badge + sidebar after any question change
async function ebRefreshQuestions() {
  const t = await GET('/api/exams/tests/' + editingId.test);
  if (!t) return;
  renderQuestionsList(t.questions);
  const cnt = (t.questions || []).length;
  const badge = document.querySelector('#eb-panel .card-header h3 .cell-sub');
  if (badge) badge.textContent = `(${cnt} questions)`;
  // refresh sidebar list count
  const idx = ebAllExams.findIndex(e => String(e.TestID) === String(editingId.test));
  if (idx >= 0) { ebAllExams[idx].QuestionCount = cnt; ebRenderList(); }
}

async function editQuestionCard(btn) {
  const card = btn.closest('.qb-card');
  const qid = card.dataset.qid;
  const t = await GET('/api/exams/tests/' + editingId.test);
  const q = t.questions.find(q => String(q.QID) === String(qid));
  if (!q) return;
  card.outerHTML = buildEditRow(q);
}
function buildEditRow(q) {
  const type = q.QuestionType || 'multi';
  return `<div class="qb-new-card">
    <div class="qb-new-header">${Q_ICONS[type]} Editing: ${esc(q.Question||q.InfoText||'').slice(0,60)}</div>
    <input type="hidden" class="nq-type" value="${type}">
    <input type="hidden" class="edit-qid" value="${q.QID}">
    ${type==='info'
      ? `<div class="form-group"><label>Info text</label><textarea class="nq-infotext" rows="4">${esc(q.InfoText||'')}</textarea></div>`
      : `<div class="form-group"><label>Question</label><textarea class="nq-text" rows="2">${esc(q.Question||'')}</textarea></div>`}
    ${(type==='image'||type==='video'||type==='multi'||type==='single'||type==='truefalse')&&type!=='info'?`<div class="form-group"><label>Image URL</label><input class="nq-img-url" value="${esc(q.Qimage||'')}"></div>`:''}
    ${type==='video'?`<div class="form-group"><label>Video URL</label><input class="nq-video" value="${esc(q.VideoUrl||'')}"></div>`:''}
    ${type!=='info'&&type!=='truefalse'?`<div class="nq-ans-wrap"><label class="cell-sub">Answers:</label>
      <div class="nq-ans-list" id="eanslist-${q.QID}">
        ${(q.answers||[]).map((a,i)=>`<div class="nq-ans-row"><input type="${type==='multi'?'checkbox':'radio'}" name="eq-${q.QID}" class="nq-correct" value="${i}" ${a.IsCorrect?'checked':''}><input class="nq-ans w-full" value="${esc(a.Answer)}"><button type="button" class="grid-del" onclick="this.parentElement.remove()">✕</button></div>`).join('')}
      </div>
      <button type="button" class="btn btn-ghost btn-sm mt-1" onclick="addAnsRow('eanslist-${q.QID}','${type}')">+ Add answer</button>
    </div>`:''}
    <div class="form-group"><label>Bank tag</label><input class="nq-tag" value="${esc(q.BankTag||'')}"></div>
    <div class="nq-footer">
      ${type!=='info' ? `<label class="nq-mand"><input type="checkbox" class="nq-mandatory" ${q.Mandatory?'checked':''}> ⭐ Mandatory — always include in exam</label>` : ''}
      <button class="btn btn-success btn-sm" onclick="updateQuestion(this,${q.QID})">Update</button>
      <button class="btn btn-outline btn-sm" onclick="cancelEditQ(this,${q.QID})">Cancel</button>
    </div></div>`;
}
async function updateQuestion(btn, qid) {
  const card = btn.closest('.qb-new-card');
  const type = card.querySelector('.nq-type').value;
  const mandEl = card.querySelector('.nq-mandatory');
  const d = { QuestionType: type, BankTag: (card.querySelector('.nq-tag')||{}).value||'', Question: (card.querySelector('.nq-text')||{}).value||'', Qimage: (card.querySelector('.nq-img-url')||{}).value||null, VideoUrl: (card.querySelector('.nq-video')||{}).value||null, InfoText: (card.querySelector('.nq-infotext')||{}).value||null, Mandatory: mandEl ? mandEl.checked : false };
  if (type !== 'info') {
    const rows = [...card.querySelectorAll('.nq-ans-row')];
    d.answers = rows.map((r,i) => ({ Answer: r.querySelector('.nq-ans').value.trim(), correct: r.querySelector('.nq-correct').checked })).filter(a => a.Answer);
  } else d.answers = [];
  const r = await PUT('/api/exams/questions/' + qid, d);
  if (!ok(r)) return;
  toast('Question updated.');
  await ebRefreshQuestions();
}
async function cancelEditQ(btn, qid) {
  const t = await GET('/api/exams/tests/' + editingId.test);
  renderQuestionsList(t.questions);
}

async function deleteQuestion(qid) {
  if (!confirm('Delete this question?')) return;
  await DEL('/api/exams/questions/' + qid);
  toast('Question deleted.');
  await ebRefreshQuestions();
}

// ---------- Exam Preview / Print (Admin review + printable paper exam) ----------
function _examPrintHtml(test, opts) {
  opts = opts || {};
  const showAnswers = !!opts.showAnswers;    // true → mark correct answers (admin preview)
  const showAnswerKey = !!opts.showAnswerKey; // true → append a separate answer-key page at the end
  const coName = (cache.company && cache.company.name) ? cache.company.name : '';
  const coLogo = (cache.company && cache.company.logo) ? cache.company.logo : '';
  const certName = test.CertName || '';
  const qs = (test.questions || []).filter(q => q); // defensive
  const letters = ['A','B','C','D','E','F','G','H'];
  let qNum = 0;
  const qHtml = qs.map(q => {
    const isInfo = q.QuestionType === 'info';
    const isMulti = q.QuestionType === 'multi';
    if (isInfo) {
      return `<div class="ep-info"><div class="ep-info-lbl">📖 Information</div><div class="ep-info-body">${esc(q.InfoText || q.Question || '').replace(/\n/g,'<br>')}</div></div>`;
    }
    qNum++;
    // Defensive: a True/False question whose options were never saved still shows True / False
    // (preserving any stored correct flag) — prevents blank true/false questions like the MOC Q20.
    let answers = Array.isArray(q.answers) ? q.answers.slice() : [];
    const isTF = /true|false|tf/i.test(q.QuestionType || '');
    if (isTF && answers.length < 2) {
      const hasTrue = answers.find(a => /true/i.test(a.Answer || ''));
      const hasFalse = answers.find(a => /false/i.test(a.Answer || ''));
      answers = [ hasTrue || { Answer: 'True', IsCorrect: 0 }, hasFalse || { Answer: 'False', IsCorrect: 0 } ];
    }
    const ans = answers.map((a, i) => {
      const correct = showAnswers && a.IsCorrect;
      return `<li class="ep-ans${correct?' ep-ans-correct':''}"><span class="ep-box">${isMulti?'☐':'○'}</span><span class="ep-letter">${letters[i]||(i+1)+'.'}</span><span class="ep-ans-txt">${esc(a.Answer || '')}</span>${correct?'<span class="ep-correct">✓ correct</span>':''}</li>`;
    }).join('');
    return `<div class="ep-q">
      <div class="ep-q-head"><span class="ep-q-num">Q${qNum}.</span><span class="ep-q-text">${esc(q.Question || '')}</span>${isMulti?'<span class="ep-q-tag">choose all that apply</span>':''}</div>
      ${q.Qimage ? `<img class="ep-q-img" src="${esc(q.Qimage)}">` : ''}
      ${q.VideoUrl ? `<div class="ep-q-video">🎬 ${esc(q.VideoUrl)}</div>` : ''}
      <ul class="ep-ans-list">${ans}</ul>
    </div>`;
  }).join('');
  // Optional separate answer key at the end (for the print-paper version with a teacher key)
  let keyHtml = '';
  if (showAnswerKey) {
    let n = 0;
    const rows = qs.filter(q => q.QuestionType !== 'info').map(q => {
      n++;
      const correct = (q.answers || []).filter(a => a.IsCorrect).map((a, i) => {
        const idx = (q.answers || []).findIndex(x => x.QAID === a.QAID);
        return `${letters[idx] || (idx+1)+'.'} ${esc(a.Answer || '')}`;
      }).join(' · ');
      return `<tr><td class="ep-key-n">Q${n}</td><td>${correct || '—'}</td></tr>`;
    }).join('');
    keyHtml = `<div class="ep-pgbreak"></div><h2 class="ep-key-h">📋 Answer Key — for marking only</h2><table class="ep-key-tbl"><tbody>${rows}</tbody></table>`;
  }
  const style = `
  <style>
    @page { size:A4 landscape; margin:12mm; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size:11pt; color:#1f2937; margin:0; }
    .ep-questions { column-count:1; page-break-before:always; break-before:page; }
    .ep-hdr { display:flex; align-items:center; gap:14px; border-bottom:2px solid #1E3A5F; padding-bottom:10px; margin-bottom:14px; }
    .ep-logo { max-height:54px; max-width:200px; }
    .ep-hdr-txt { flex:1; }
    .ep-co { font-size:12pt; font-weight:700; color:#1E3A5F; }
    .ep-tt { font-size:18pt; font-weight:700; color:#0f172a; margin-top:2px; }
    .ep-meta { display:flex; flex-wrap:wrap; gap:18px; font-size:10pt; color:#475569; margin:6px 0 14px; }
    .ep-meta b { color:#1E3A5F; }
    .ep-instr { background:#f1f5f9; border-left:4px solid #1E3A5F; padding:8pt 12pt; margin-bottom:14px; font-size:10.5pt; }
    .ep-name-row { display:flex; gap:24px; margin:10px 0 16px; font-size:10.5pt; }
    .ep-name-row > div { flex:1; border-bottom:1px solid #94a3b8; padding-bottom:2px; }
    .ep-name-row label { color:#475569; font-size:9pt; }
    .ep-det { border-collapse:collapse; width:100%; table-layout:fixed; margin:10px 0 14px; font-size:10pt; }
    .ep-det td { border:1px solid #cbd5e1; padding:7pt 8pt; height:24pt; vertical-align:middle; }
    .ep-det .ep-dl { background:#1E3A5F; color:#fff; font-weight:600; width:150px; white-space:nowrap; font-size:9.5pt; }
    .ep-mg { border:1px solid #cbd5e1; border-radius:5pt; padding:7pt 10pt; margin:0 0 14px; }
    .ep-mg-h { font-weight:700; color:#1E3A5F; font-size:10pt; margin-bottom:5pt; }
    .ep-mg-grid { display:flex; flex-wrap:wrap; gap:4pt; }
    .ep-mg-cell { font-size:9pt; padding:2pt 6pt; border-radius:3pt; border:1px solid #e2e8f0; white-space:nowrap; }
    .ep-mg-pass { background:#dcfce7; color:#15803d; border-color:#bbf7d0; }
    .ep-mg-fail { background:#fee2e2; color:#b91c1c; border-color:#fecaca; }
    .ep-q { border:1px solid #e2e8f0; border-radius:6pt; padding:11pt 13pt; margin-bottom:14pt; page-break-inside:avoid; break-inside:avoid; background:#fff; }
    .ep-q-head { display:flex; align-items:baseline; gap:6pt; margin-bottom:6pt; }
    .ep-q-num { font-weight:700; color:#1E3A5F; }
    .ep-q-text { flex:1; font-weight:600; }
    .ep-q-tag { font-size:8pt; background:#fde68a; color:#92400e; padding:1pt 5pt; border-radius:3pt; }
    .ep-q-img { max-width:80%; max-height:140pt; display:block; margin:4pt 0; border:1px solid #e2e8f0; border-radius:4pt; }
    .ep-q-video { font-size:9pt; color:#64748b; margin:2pt 0; }
    .ep-ans-list { list-style:none; margin:0; padding:0; }
    .ep-ans { display:flex; align-items:flex-start; gap:6pt; padding:5pt 4pt; }
    .ep-ans-correct { background:#dcfce7; border-radius:3pt; }
    .ep-box { font-size:13pt; line-height:1; width:14pt; }
    .ep-letter { font-weight:600; color:#475569; width:14pt; }
    .ep-ans-txt { flex:1; }
    .ep-correct { font-size:8.5pt; color:#15803d; font-weight:700; align-self:center; }
    .ep-info { background:#eff6ff; border-left:4px solid #2563EB; padding:8pt 12pt; margin-bottom:10pt; }
    .ep-info-lbl { font-size:9pt; font-weight:700; color:#1e40af; margin-bottom:3pt; }
    .ep-info-body { font-size:10.5pt; }
    .ep-pgbreak { page-break-before:always; }
    .ep-key-h { color:#1E3A5F; border-bottom:2px solid #1E3A5F; padding-bottom:4pt; }
    .ep-key-tbl { width:100%; border-collapse:collapse; font-size:10pt; }
    .ep-key-tbl td { padding:5pt 8pt; border-bottom:1px solid #e2e8f0; }
    .ep-key-n { font-weight:700; color:#1E3A5F; width:50pt; }
    .ep-foot { margin-top:16pt; padding-top:8pt; border-top:1px solid #e2e8f0; text-align:center; font-size:8pt; color:#94a3b8; break-before:avoid; }
    .ep-toolbar { position:fixed; top:10px; right:10px; display:flex; gap:8px; z-index:9999; }
    .ep-toolbar button { padding:8px 14px; font-size:13px; border-radius:6px; border:1px solid #cbd5e1; background:#fff; cursor:pointer; font-weight:600; }
    .ep-toolbar .ep-prim { background:#1E3A5F; color:#fff; border-color:#1E3A5F; }
    @media print { .ep-toolbar { display:none; } body { background:#fff; } }
  </style>`;
  const today = new Date().toISOString().slice(0,10);
  const header = `<div class="ep-hdr">
    ${coLogo ? `<img class="ep-logo" src="${esc(coLogo)}">` : ''}
    <div class="ep-hdr-txt">
      ${coName ? `<div class="ep-co">${esc(coName)}</div>` : ''}
      <div class="ep-tt">${esc(test.TestName || 'Exam')}</div>
    </div>
  </div>`;
  const metaBits = [
    certName ? `<span><b>Qualification:</b> ${esc(certName)}</span>` : '',
    test.PassScore ? `<span><b>Pass score:</b> ${esc(String(test.PassScore))}%</span>` : '',
    test.TimeLimit ? `<span><b>Time limit:</b> ${esc(String(test.TimeLimit))} min</span>` : '',
    `<span><b>Questions:</b> ${qs.filter(q=>q.QuestionType!=='info').length}</span>`,
    showAnswers ? `<span style="color:#15803d"><b>Mode:</b> Preview with answers</span>` : `<span><b>Date:</b> ${today}</span>`,
  ].filter(Boolean).join('');
  const nameRow = showAnswers ? '' : `<table class="ep-det"><tbody>
    <tr><td class="ep-dl">Employee First Name</td><td class="ep-dv"></td><td class="ep-dl">Employee Last Name</td><td class="ep-dv"></td></tr>
    <tr><td class="ep-dl">Employee ID</td><td class="ep-dv"></td><td class="ep-dl">Assigned Shift Crew</td><td class="ep-dv"></td></tr>
    <tr><td class="ep-dl">Employee Supervisor</td><td class="ep-dv"></td><td class="ep-dl">Employee Signature</td><td class="ep-dv"></td></tr>
    <tr><td class="ep-dl">Pass Mark Required</td><td class="ep-dv">${test.PassScore?esc(String(test.PassScore))+'%':''}</td><td class="ep-dl">Pass Mark Obtained</td><td class="ep-dv"></td></tr>
    <tr><td class="ep-dl">Result</td><td class="ep-dv" colspan="3">☐ Competent&nbsp;&nbsp;&nbsp;&nbsp; ☐ Not Yet Competent</td></tr>
    <tr><td class="ep-dl">Trainer Name</td><td class="ep-dv"></td><td class="ep-dl">Trainer ID</td><td class="ep-dv"></td></tr>
    <tr><td class="ep-dl">Trainer Signature</td><td class="ep-dv"></td><td class="ep-dl">Date</td><td class="ep-dv"></td></tr>
  </tbody></table>`;
  const instr = test.Instructions ? `<div class="ep-instr">${esc(test.Instructions).replace(/\n/g,'<br>')}</div>` : '';
  // Score scale / marking guide: number of questions incorrect → score % (each worth 100/total %).
  const totalQ = qs.filter(q => q.QuestionType !== 'info').length;
  let markingGuide = '';
  if (totalQ > 0 && !showAnswers) {
    const pass = Number(test.PassScore) || 80;
    const cells = [];
    for (let w = 0; w <= totalQ; w++) {
      const pctNum = ((totalQ - w) / totalQ) * 100;
      const pct = Math.round(pctNum * 10) / 10;
      cells.push(`<span class="ep-mg-cell ${pctNum >= pass ? 'ep-mg-pass' : 'ep-mg-fail'}"><b>${w}</b> wrong = ${pct % 1 === 0 ? pct : pct.toFixed(1)}%</span>`);
    }
    const perQ = Math.round((100 / totalQ) * 10) / 10;
    markingGuide = `<div class="ep-mg"><div class="ep-mg-h">Marking Guide — ${totalQ} questions · each worth ${perQ % 1 === 0 ? perQ : perQ.toFixed(1)}% · pass mark ${pass}%</div><div class="ep-mg-grid">${cells.join('')}</div></div>`;
  }
  const titleBar = showAnswers ? '🔍 Exam Preview' : '🖨 Print exam';
  const toolbar = `<div class="ep-toolbar">
    <button class="ep-prim" onclick="window.print()">🖨 Print</button>
    <button onclick="window.close()">Close</button>
  </div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(test.TestName || 'Exam')} — ${titleBar}</title>${style}</head>
  <body>${toolbar}${header}<div class="ep-meta">${metaBits}</div>${nameRow}${markingGuide}${instr}<div class="ep-questions">${qHtml}</div>${keyHtml}
  <div class="ep-foot">${esc(coName || '')}${coName?' · ':''}${esc(test.TestName||'')} · Generated ${today}</div></body></html>`;
}

function _examOpenPrintWindow(testId, opts) {
  // Open the window SYNCHRONOUSLY in the click handler with a Loading… placeholder.
  // (If we await first, browsers treat the later window.open as non-user-initiated and block it.)
  const w = window.open('about:blank', 'ttp_exam_print_' + testId, 'width=920,height=1080');
  const loadingHtml = `<!doctype html><meta charset="utf-8"><title>Loading exam…</title>
    <style>body{font:14px/1.5 'Segoe UI',Arial,sans-serif;color:#1f2937;padding:40px;text-align:center}
    .sp{display:inline-block;width:32px;height:32px;border:3px solid #cbd5e1;border-top-color:#1E3A5F;border-radius:50%;animation:s 1s linear infinite;vertical-align:middle;margin-right:10px}
    @keyframes s{to{transform:rotate(360deg)}}</style>
    <body><div class="sp"></div>Loading exam…</body>`;
  if (w) { try { w.document.open(); w.document.write(loadingHtml); w.document.close(); } catch {} }

  return GET('/api/exams/tests/' + testId).then(test => {
    if (!test) { if (w) try { w.close(); } catch {} ; toast('Could not load the exam.', 'error'); return; }
    if (!(test.questions || []).filter(q => q.QuestionType !== 'info').length) {
      if (w) try { w.close(); } catch {} ;
      toast('This exam has no questions to ' + (opts.showAnswers ? 'preview' : 'print') + '.', 'error');
      return;
    }
    const html = _examPrintHtml(test, opts);
    if (w && !w.closed) {
      try {
        w.document.open(); w.document.write(html); w.document.close(); w.focus();
        return;
      } catch (e) { /* fall through to modal fallback */ }
    }
    // Pop-up was blocked or closed — render inline in a full-screen modal as fallback
    _examShowInlineModal(test, opts);
  }).catch(err => {
    if (w) try { w.close(); } catch {} ;
    toast('Preview failed: ' + (err && err.message ? err.message : 'unknown error'), 'error');
  });
}

// Inline fallback when the popup is blocked. Renders the same print HTML inside a full-screen iframe overlay.
function _examShowInlineModal(test, opts) {
  document.getElementById('exam-preview-modal')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'exam-preview-modal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.7);z-index:10000;display:flex;flex-direction:column;padding:24px;';
  wrap.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;background:#fff;padding:10px 14px;border-radius:8px 8px 0 0">
      <strong style="color:#1E3A5F">${esc(test.TestName||'Exam')} — ${opts.showAnswers?'Preview (answers marked)':'Print preview'}</strong>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" id="exam-prev-print">🖨 Print</button>
        <button class="btn btn-outline btn-sm" id="exam-prev-close">✕ Close</button>
      </div>
    </div>
    <iframe id="exam-prev-iframe" style="flex:1;background:#fff;border:0;border-radius:0 0 8px 8px" sandbox="allow-same-origin allow-modals allow-popups"></iframe>`;
  document.body.appendChild(wrap);
  const ifr = wrap.querySelector('#exam-prev-iframe');
  // Inject into the iframe via srcdoc-style direct doc write
  const doc = ifr.contentDocument || ifr.contentWindow.document;
  doc.open(); doc.write(_examPrintHtml(test, opts)); doc.close();
  wrap.querySelector('#exam-prev-close').onclick = () => wrap.remove();
  wrap.querySelector('#exam-prev-print').onclick = () => { try { ifr.contentWindow.focus(); ifr.contentWindow.print(); } catch { window.print(); } };
}

// Admin: review the exam as it will appear, with correct answers marked. Used by the Exam Builder ▶ Preview button.
function ebPreviewExam(testId) { return _examOpenPrintWindow(testId, { showAnswers: true }); }

// Anyone: open a print-ready BLANK paper exam (no answers, no key) — for offline taking.
function examPrintPaper(testId) { return _examOpenPrintWindow(testId, { showAnswers: false, showAnswerKey: false }); }

// Admin only: blank paper PLUS a separate answer-key page at the end for marking.
function examPrintAnswerKey(testId) {
  if (!(currentUser && currentUser.admin)) { toast('Admin only.', 'error'); return; }
  return _examOpenPrintWindow(testId, { showAnswers: false, showAnswerKey: true });
}

// ---------- Take Exam ----------
let takingExam = null;
async function startExam(testId) {
  const empId = currentUser.staffID || '';
  const data = await GET(`/api/exams/tests/${testId}/attempt-questions?empId=${empId}`);
  if (!data || !data.questions.length) return toast('This exam has no questions.', 'error');
  takingExamData = data;
  takingExam = data.test;
  document.getElementById('take-title').textContent = data.test.TestName;
  const empOpts = cache.staff.map(s => `<option value="${s.StaffID}">${esc(s.LastName)}, ${esc(s.FirstName)}</option>`).join('');
  let timerHtml = data.test.TimeLimit ? `<div id="exam-timer" class="exam-timer">⏱ ${data.test.TimeLimit}:00</div>` : '';
  document.getElementById('take-body').innerHTML = `
    ${timerHtml}
    ${data.test.Instructions ? `<div class="alert alert-info"><span>📋</span><div>${esc(data.test.Instructions)}</div></div>` : ''}
    <div class="form-group mb-2"><label>Employee taking this exam</label>
      <select id="take-emp"><option value="">-- Select --</option>${empOpts}</select></div>
    <div id="exam-questions">${data.questions.map((q,i) => renderExamQuestion(q, i)).join('')}</div>`;
  if (empId) setVal('take-emp', empId);
  document.getElementById('take-submit-btn').disabled = false;
  showModal('take-modal');
  if (data.test.TimeLimit) startExamTimer(data.test.TimeLimit);
}

function renderExamQuestion(q, i) {
  const isInfo = q.QuestionType === 'info';
  const isMulti = q.QuestionType === 'multi';
  const isVideo = q.QuestionType === 'video';
  const embedVideo = url => {
    if (!url) return '';
    const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?/]+)/);
    if (yt) return `<iframe class="exam-video" src="https://www.youtube.com/embed/${yt[1]}" frameborder="0" allowfullscreen></iframe>`;
    return `<video class="exam-video" controls><source src="${esc(url)}"></video>`;
  };
  return `<div class="exam-q" id="eq-${q.QID}">
    <div class="exam-q-num">${isInfo?'📖 Read':'Q'+(i+1)}</div>
    ${q.Qimage ? `<img class="exam-img" src="${esc(q.Qimage)}">` : ''}
    ${isVideo ? embedVideo(q.VideoUrl) : ''}
    ${isInfo
      ? `<div class="exam-info-block">${esc(q.InfoText||q.Question||'').replace(/\n/g,'<br>')}</div>`
      : `<div class="exam-q-text">${esc(q.Question||'')}</div>`}
    ${!isInfo ? `<div class="exam-answers">${(q.answers||[]).map((a,ai) => `
      <label class="exam-ans-label">
        <input type="${isMulti?'checkbox':'radio'}" name="eq-${q.QID}" value="${a.QAID}" class="exam-input">
        <span class="exam-ans-text">${esc(a.Answer)}</span>
      </label>`).join('')}</div>` : ''}
  </div>`;
}

function startExamTimer(mins) {
  clearInterval(examTimer);
  let secs = mins * 60;
  examTimer = setInterval(() => {
    secs--;
    const el = document.getElementById('exam-timer');
    if (!el) { clearInterval(examTimer); return; }
    const m = String(Math.floor(secs/60)).padStart(2,'0'), s = String(secs%60).padStart(2,'0');
    el.textContent = `⏱ ${m}:${s}`;
    el.style.color = secs < 60 ? 'var(--danger)' : '';
    if (secs <= 0) { clearInterval(examTimer); toast('Time is up! Submitting now.', 'error'); submitExam(); }
  }, 1000);
}

async function submitExam() {
  clearInterval(examTimer);
  const empId = val('take-emp');
  if (!empId) return toast('Select the employee taking the exam.', 'error');
  const answers = {};
  const questions = takingExamData.questions.filter(q => q.QuestionType !== 'info');
  questions.forEach(q => {
    if (q.QuestionType === 'multi') {
      const checked = [...document.querySelectorAll(`input[name="eq-${q.QID}"]:checked`)].map(i => parseInt(i.value));
      if (checked.length) answers[q.QID] = checked;
    } else {
      const sel = document.querySelector(`input[name="eq-${q.QID}"]:checked`);
      if (sel) answers[q.QID] = [parseInt(sel.value)];
    }
  });
  const unanswered = questions.filter(q => !answers[q.QID]).length;
  if (unanswered && !confirm(`${unanswered} question(s) unanswered. Submit anyway?`)) return;

  document.getElementById('take-submit-btn').disabled = true;
  const r = await POST('/api/exams/submit', { testId: takingExam.TestID, empId, answers });
  if (!r || r.error) { document.getElementById('take-submit-btn').disabled = false; return toast(r?r.error:'Submit failed', 'error'); }

  // Build results screen
  const resultRows = r.showAnswers && r.results ? r.results.map(res => {
    const icon = res.isCorrect ? '✅' : '❌';
    const correctText = res.correctAnswers.map(a => esc(a.Answer)).join(', ');
    return `<div class="exam-result-row ${res.isCorrect?'res-correct':'res-wrong'}">
      <div class="res-q">${icon} ${esc(res.question)}</div>
      ${!res.isCorrect ? `<div class="res-correct-ans">✅ Correct: ${correctText}</div>` : ''}
    </div>`;
  }).join('') : '';

  document.getElementById('take-body').innerHTML = `
    <div style="text-align:center;padding:24px 0">
      <div style="font-size:52px">${r.passed?'🎉':'📋'}</div>
      <h2 style="font-size:36px;color:${r.passed?'var(--success)':'var(--danger)'};margin:8px 0">${r.score}%</h2>
      <p style="font-size:16px">${r.correct} of ${r.total} correct · Pass mark ${r.passScore}%</p>
      <div class="badge ${r.passed?'badge-active':'badge-expired'}" style="font-size:15px;margin:10px auto;padding:6px 18px">${r.passed?'PASSED':'FAILED'}</div>
      ${r.passed&&r.registerId ? '<p class="mt-1 cell-sub">🎓 Qualification recorded automatically.</p>' : ''}
      ${!r.passed ? '<p class="mt-1 cell-sub">Questions you answered incorrectly will be prioritised next time you take this exam.</p>' : ''}
      ${r.passed ? `<button class="btn btn-accent mt-2" onclick="generateCertificate(${r.examId||0},'')">🏆 Generate Certificate</button>` : ''}
    </div>
    ${resultRows ? `<div class="exam-results">${resultRows}</div>` : ''}`;
  if (r.registerId) { await loadLookupCache(); refreshNotifBadge(); }
}

// ---- Digital Sign-Off ----
let signingId = null;
function openSign(regId) {
  signingId = regId;
  setVal('sign-password', ''); setVal('sign-meaning', 'Approved');
  document.getElementById('sign-error').innerHTML = '';
  showModal('sign-modal');
}
async function submitSign() {
  const r = await POST(`/api/register/${signingId}/sign`, { password: val('sign-password'), meaning: val('sign-meaning') });
  if (!r || r.error) { document.getElementById('sign-error').innerHTML = `<div class="alert alert-danger"><span>⚠️</span><div>${r?r.error:'Failed'}</div></div>`; return; }
  closeModal('sign-modal'); loadRecords();
}

// ---- Email Settings ----
async function saveAiKey() {
  const key = document.getElementById('cfg-anthropic-key').value.trim();
  const openaiEl = document.getElementById('cfg-openai-key');
  const openai = openaiEl ? openaiEl.value.trim() : '';
  if (!key && !openai) return toast('Enter an API key.', 'error');
  const payload = {};
  if (key) payload.apiKey = key;
  if (openai) payload.openaiKey = openai;
  const r = await PUT('/api/exams/ai-settings', payload);
  const el = document.getElementById('ai-key-result');
  if (r && r.success) {
    el.innerHTML='<div class="alert alert-success"><span>✅</span><div>API key(s) saved.</div></div>';
    document.getElementById('cfg-anthropic-key').value=''; if (openaiEl) openaiEl.value='';
  } else el.innerHTML=`<div class="alert alert-danger"><span>⚠️</span><div>${r?r.error:'Failed'}</div></div>`;
}
async function testAiKey() {
  const el = document.getElementById('ai-key-result');
  el.innerHTML='<div class="alert alert-info"><span class="spinner"></span><div>Testing connection to Claude AI…</div></div>';
  const r = await POST('/api/exams/ai-suggest', { question:'What colour is the sky?', questionType:'single', bankTag:'Test' });
  if (r && r.answers && r.answers.length) {
    el.innerHTML=`<div class="alert alert-success"><span>✅</span><div>Connection working! Claude generated ${r.answers.length} answers.</div></div>`;
  } else {
    el.innerHTML=`<div class="alert alert-danger"><span>⚠️</span><div>${r&&r.error?r.error:'AI test failed.'}</div></div>`;
  }
}

async function loadEmailSettings() {
  const c = await GET('/api/settings');
  if (!c) return;
  ['smtp_host','smtp_port','smtp_secure','smtp_user','smtp_from','digest_to','digest_enabled'].forEach(k => setVal('cfg-' + k, c[k]));
  document.getElementById('cfg-pass-set').textContent = c.smtp_pass_set ? '(saved)' : '';
}
async function saveEmailSettings() {
  const body = {};
  ['smtp_host','smtp_port','smtp_secure','smtp_user','smtp_pass','smtp_from','digest_to','digest_enabled'].forEach(k => body[k] = val('cfg-' + k));
  await PUT('/api/settings', body);
  document.getElementById('email-result').innerHTML = '<div class="alert alert-success"><span>✅</span><div>Settings saved.</div></div>';
  setVal('cfg-smtp_pass', '');
}
async function testEmail() {
  const to = prompt('Send test email to:');
  if (!to) return;
  const r = await POST('/api/settings/test-email', { to });
  document.getElementById('email-result').innerHTML = r && r.success
    ? '<div class="alert alert-success"><span>✅</span><div>Test email sent!</div></div>'
    : `<div class="alert alert-danger"><span>⚠️</span><div>${r?r.error:'Failed'}</div></div>`;
}
async function sendDigestNow() {
  const r = await POST('/api/settings/send-digest');
  document.getElementById('email-result').innerHTML = r && !r.error
    ? `<div class="alert alert-success"><span>✅</span><div>${r.skipped?'Nothing to report.':'Digest sent ('+r.expired+' expired, '+r.expiring+' expiring).'}</div></div>`
    : `<div class="alert alert-danger"><span>⚠️</span><div>${r?r.error:'Failed'}</div></div>`;
}

// ---- Audit Trail ----
function switchAuditTab(tab, el) {
  if (el) { document.querySelectorAll('#page-admin-audit .tab').forEach(t=>t.classList.remove('active')); el.classList.add('active'); }
  document.getElementById('audit-changes-card').classList.toggle('hidden', tab!=='changes');
  document.getElementById('audit-logins-card').classList.toggle('hidden', tab!=='logins');
  if (tab==='changes') loadAudit(); else loadLogins();
}
async function loadAudit() {
  const data = await GET('/api/audit?user=' + encodeURIComponent(val('audit-search')));
  if (!data) return;
  const actBadge = a => ({CREATE:'badge-active',UPDATE:'badge-pending',DELETE:'badge-expired',SIGN:'badge-current',EXAM:'badge-pending'}[a]||'badge-inactive');
  document.getElementById('audit-tbody').innerHTML = data.length ? data.map(a => `
    <tr><td class="cell-sub">${a.AuditDate}</td><td class="cell-strong">${esc(a.AuditUser||'')}</td>
    <td>${esc((a.AuditTable||'').replace('tbl',''))}</td>
    <td><span class="badge ${actBadge(a.AuditAction)} badge-plain">${a.AuditAction}</span></td>
    <td>${esc(a.AuditRecord||'')}</td><td class="cell-sub">${esc(a.NewValue||'')}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty-state">No audit records</td></tr>';
}
async function loadLogins() {
  const data = await GET('/api/audit/logins');
  if (!data) return;
  document.getElementById('logins-tbody').innerHTML = data.length ? data.map(l => `
    <tr><td class="cell-sub">${l.LoginDate}</td><td class="cell-strong">${esc(l.LoginUser||'')}</td>
    <td><span class="badge badge-active badge-plain">${esc(l.LoginStatus||'')}</span></td></tr>`).join('')
    : '<tr><td colspan="3" class="empty-state">No login history</td></tr>';
}

// ---- File Attachments (reusable) ----
const FILE_ICONS = { pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊', ppt:'📑', pptx:'📑',
  png:'🖼️', jpg:'🖼️', jpeg:'🖼️', gif:'🖼️', csv:'📊', txt:'📃', zip:'🗜️', msg:'✉️', eml:'✉️' };
function fileIcon(name) { const ext = (name||'').split('.').pop().toLowerCase(); return FILE_ICONS[ext] || '📎'; }
function fmtSize(b) { if (b == null) return ''; if (b < 1024) return b + ' B'; if (b < 1048576) return (b/1024).toFixed(0) + ' KB'; return (b/1048576).toFixed(1) + ' MB'; }

async function renderAttachments(entityType, entityId, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `
    <div class="dropzone dz-compact" id="dz-${containerId}">
      <div class="dz-icon">📁</div>
      <p><strong>Drop files here or click to upload</strong></p>
      <p class="cell-sub">PDF, Office docs, images, zip — up to 300 MB each</p>
      <input type="file" id="file-${containerId}" multiple class="hidden">
    </div>
    <div class="flex gap-2 mt-1">
      <select id="cat-${containerId}" class="w-full" style="padding:8px;border:1.5px solid var(--border-strong);border-radius:8px">
        ${(entityType==='staff'
          ? ['Certificate','ID Document','Qualification','Contract','Other']
          : ['Course Material','Handout','Slides','Manual','Reference','Other']
        ).map(c=>`<option>${c}</option>`).join('')}
      </select>
    </div>
    <div id="filelist-${containerId}" class="mt-2"></div>`;

  const input = document.getElementById('file-' + containerId);
  const dz = document.getElementById('dz-' + containerId);
  dz.onclick = () => input.click();
  input.onchange = () => uploadFiles(entityType, entityId, containerId, input.files);
  ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => { if (e.dataTransfer.files.length) uploadFiles(entityType, entityId, containerId, e.dataTransfer.files); });

  await refreshFileList(entityType, entityId, containerId);
}

async function refreshFileList(entityType, entityId, containerId) {
  const files = await GET(`/api/files/${entityType}/${entityId}`);
  const list = document.getElementById('filelist-' + containerId);
  if (!list) return;
  list.innerHTML = (files && files.length) ? files.map(f => `
    <div class="file-row">
      <span class="file-ic">${fileIcon(f.FileName)}</span>
      <div class="file-meta">
        <a href="/api/files/download/${f.FileID}?inline=1" target="_blank" class="file-name">${esc(f.FileName)}</a>
        <div class="cell-sub">${esc(f.Category||'')} · ${fmtSize(f.FileSize)} · ${esc(f.UploadedBy||'')} · ${fmtDate((f.UploadedDate||'').split(' ')[0])}</div>
      </div>
      <a class="btn btn-outline btn-sm btn-icon" href="/api/files/download/${f.FileID}" title="Download">⬇</a>
      <button class="btn btn-danger btn-sm btn-icon" onclick="deleteFile(${f.FileID},'${entityType}',${entityId},'${containerId}')" title="Delete">🗑️</button>
    </div>`).join('') : '<p class="cell-sub">No files attached yet.</p>';
}

async function uploadFiles(entityType, entityId, containerId, fileList) {
  if (!fileList || !fileList.length) return;
  const fd = new FormData();
  for (const f of fileList) fd.append('files', f);
  const cat = document.getElementById('cat-' + containerId);
  if (cat) fd.append('category', cat.value);
  const list = document.getElementById('filelist-' + containerId);
  if (list) list.innerHTML = '<div class="flex items-center gap-2"><span class="spinner"></span> Uploading...</div>';
  const r = await fetch(`/api/files/${entityType}/${entityId}`, { method: 'POST', body: fd, credentials: 'include' });
  const j = await r.json();
  if (j.error) alert(j.error);
  await refreshFileList(entityType, entityId, containerId);
}

async function deleteFile(fileId, entityType, entityId, containerId) {
  if (!confirm('Delete this file?')) return;
  await DEL('/api/files/' + fileId);
  await refreshFileList(entityType, entityId, containerId);
}

// ---- Document Library ----
let _docLibCache = {};
// ---- Training PowerPoint Presentations ----
// Upload existing .pptx · AI-develop new decks from a topic + template · build .pptx via pptxgenjs
let _ppCache = [];
let _ppTemplates = [];
let _ppDeckDraft = null; // last AI-generated slide deck, editable in the preview
let _ppTransLayout = 'below';      // translation placement in preview + built .pptx: above | below | side
let _ppTransSideOrder = 'en-first'; // for side: which language leads — en-first | lang-first

let _ppThemes = [];
async function loadPowerpoints() {
  const [list, tpls, themes] = await Promise.all([
    GET('/api/powerpoints'),
    GET('/api/powerpoints/templates'),
    GET('/api/powerpoints/themes')
  ]);
  _ppCache = Array.isArray(list) ? list : [];
  _ppTemplates = Array.isArray(tpls) ? tpls : [];
  _ppThemes = Array.isArray(themes) ? themes : [];
  const cats = [...new Set(_ppCache.map(t => t.Category || 'General'))].sort();
  const sel = document.getElementById('pp-cat-filter');
  if (sel) {
    const keep = sel.value;
    sel.innerHTML = '<option value="">All categories</option>' + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if (keep) sel.value = keep;
  }
  renderPowerpoints();
}
function renderPowerpoints() {
  const q   = ((document.getElementById('pp-search') || {}).value || '').toLowerCase().trim();
  const cat = (document.getElementById('pp-cat-filter') || {}).value || '';
  const rows = _ppCache.filter(t => {
    if (cat && (t.Category || 'General') !== cat) return false;
    if (q) {
      const blob = (t.FileName + ' ' + (t.Category || '') + ' ' + (t.Description || '')).toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
  const fmtBytes = n => { if (!n) return '—'; if (n < 1024) return n + ' B'; if (n < 1048576) return (n/1024).toFixed(1) + ' KB'; return (n/1048576).toFixed(1) + ' MB'; };
  const host = document.getElementById('pp-tbody');
  if (!host) return;
  host.innerHTML = rows.length ? rows.map(t => `
    <tr>
      <td class="cell-strong">🎞 ${esc(t.FileName)}${t.Description ? `<div class="cell-sub">${esc(t.Description)}</div>` : ''}</td>
      <td>${esc(t.Category || 'General')}</td>
      <td>${t.SlideCount || 0}</td>
      <td>${fmtBytes(t.FileSize)}</td>
      <td>${esc((t.UploadedDate || '').slice(0, 10))} <span class="cell-sub">${esc(t.UploadedBy || '')}</span></td>
      <td class="actions">
        <a class="btn btn-accent btn-sm" href="/api/files/download/${t.FileID}">⬇ Download</a>
        ${(currentUser && currentUser.admin) ? `<button class="btn btn-primary btn-sm btn-icon" onclick="ppOpenDeck(${t.FileID}, 'edit')" title="Edit slides in the developer (only for decks built by AI)">✏️</button>` : ''}
        ${(currentUser && currentUser.admin) ? `<button class="btn btn-outline btn-sm btn-icon" onclick="ppOpenDeck(${t.FileID}, 'preview')" title="Preview slides without editing">👁</button>` : ''}
        ${(currentUser && currentUser.admin) ? `<button class="btn btn-danger btn-sm btn-icon" onclick="deletePowerpoint(${t.FileID})" title="Delete">🗑</button>` : ''}
      </td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No PowerPoint presentations ${q || cat ? 'match your filter' : 'yet'}.${(currentUser && currentUser.admin && !_ppCache.length) ? ' Click <strong>🤖 Develop with AI</strong> or <strong>⬆ Upload PPTX</strong> to add the first one.' : ''}</td></tr>`;
}
function filterPowerpoints() { renderPowerpoints(); }

async function uploadPowerpoint(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const cat = (prompt(`Category for "${file.name}"? (e.g. Safety, Operations, Induction)`, 'Training') || '').trim() || 'Training';
  const desc = prompt('Short description (optional)') || '';
  const fd = new FormData();
  fd.append('file', file);
  fd.append('category', cat);
  fd.append('description', desc);
  try {
    const resp = await fetch('/api/powerpoints', { method: 'POST', body: fd, credentials: 'include' });
    const r = await resp.json().catch(() => ({ error: 'Server returned non-JSON.' }));
    if (!resp.ok) { toast(r.error || ('Upload failed (HTTP ' + resp.status + ')'), 'error'); return; }
    toast(`Uploaded "${file.name}" to ${cat}.`);
    loadPowerpoints();
  } catch (e) {
    toast('Upload failed: ' + (e && e.message ? e.message : 'network error'), 'error');
  } finally { input.value = ''; }
}

// Re-open a previously saved deck in the developer — fetches stored JSON, then opens the editor (or preview-mode straight away)
async function ppOpenDeck(id, mode) {
  try {
    const r = await GET('/api/powerpoints/' + id + '/deck');
    if (!r) return;
    if (r.error) { toast(r.error, 'error'); alert(r.error); return; }
    _ppDeckDraft = r.deck || {};
    _ppDeckDraft.__fileId = id; // so future "Save" can update in place if we wire it
    ppShowPreview(_ppDeckDraft);
    if (mode === 'preview') setTimeout(() => ppSetViewMode('preview'), 80);
  } catch (e) { toast('Could not open deck: ' + (e && e.message ? e.message : 'unknown'), 'error'); }
}

async function deletePowerpoint(id) {
  if (!confirm('Delete this PowerPoint? This cannot be undone.')) return;
  const r = await DEL('/api/powerpoints/' + id);
  if (!ok(r)) return;
  toast('PowerPoint deleted.');
  loadPowerpoints();
}

// AI Develop — brand-themed dialog with template + topic + audience + slide count
// Image-style controls (style / region / gender) baked into every suggested image prompt.
function _ppImgStyleControlsHtml(prefix) {
  return `
    <label style="font-size:13px;font-weight:600;color:var(--primary,#1E3A5F)">Image style
      <select id="${prefix}-img-style" style="width:100%;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        <option value="clean modern flat corporate illustration (Averta style)">Averta — modern flat illustration</option>
        <option value="realistic professional photograph">Realistic photo</option>
        <option value="flat vector illustration">Flat vector illustration</option>
        <option value="clear labelled technical line diagram">Technical line diagram</option>
      </select></label>
    <label style="font-size:13px;font-weight:600;color:var(--primary,#1E3A5F)">People / region
      <select id="${prefix}-img-region" style="width:100%;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        <option value="Thailand">Thailand</option>
        <option value="Southeast Asia">Southeast Asia</option>
        <option value="Australia">Australia</option>
        <option value="">International / generic</option>
      </select></label>
    <label style="font-size:13px;font-weight:600;color:var(--primary,#1E3A5F)">People shown
      <select id="${prefix}-img-gender" style="width:100%;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        <option value="Both">Male &amp; female</option>
        <option value="Male">Male</option>
        <option value="Female">Female</option>
      </select></label>`;
}
function _ppImgStyleValues(prefix) {
  return { imgStyle: val(prefix + '-img-style') || '', imgRegion: val(prefix + '-img-region') || '', imgGender: val(prefix + '-img-gender') || '' };
}

// Copy a slide's suggested image prompt to the clipboard (to paste into ChatGPT / DALL·E).
function ppCopyImgPrompt(i) {
  const el = document.querySelector(`.pp-slide[data-i="${i}"] .pp-img`);
  const txt = el ? (el.value || '') : '';
  if (!txt.trim()) { toast('No image prompt on this slide yet — click ✨ Suggest images first.', 'error'); return; }
  const done = () => toast('Image prompt copied — paste it into ChatGPT / DALL·E.');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done).catch(() => { el.select(); document.execCommand('copy'); done(); });
  else { el.select(); document.execCommand('copy'); done(); }
}

// Per-slide AI assistant — write / improve / expand this slide's content.
async function ppAssistSlide(i) {
  const instruction = prompt('What should the AI do for this slide?\ne.g. "write bullets on the lockout steps", "simplify for operators", "expand with more detail", "add trainer notes"');
  if (instruction === null) return;
  _ppDeckDraft = ppCollectDeck();
  const slide = _ppDeckDraft.slides[i]; if (!slide) return;
  const btn = document.querySelector(`.pp-slide[data-i="${i}"] .pp-assist-btn`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    // Send only the slide's TEXT (never the base64 image data).
    const liteSlide = { heading: slide.heading || '', subheading: slide.subheading || '', bullets: Array.isArray(slide.bullets) ? slide.bullets : [], body: slide.body || '', notes: slide.notes || '' };
    const r = await POST('/api/powerpoints/assist-slide', { slide: liteSlide, instruction: instruction.trim(), deckTitle: _ppDeckDraft.title || '' });
    if (!r || r.error || !r.slide) { toast((r && r.error) || 'AI assist failed.', 'error'); return; }
    Object.assign(slide, r.slide);
    ppShowPreview(_ppDeckDraft);
    toast(`Slide ${i + 1} updated by the AI assistant.`);
  } catch (e) { toast('AI assist failed: ' + (e && e.message ? e.message : 'error'), 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '✨ AI assist'; } }
}

// Upload a REFERENCE image for this slide, then generate the slide image guided by it.
function ppRefImageGenerate(i, input) {
  const f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) { toast('Reference image too large (max 8 MB).', 'error'); return; }
  const r = new FileReader();
  r.onload = e => { ppGenerateImage(i, e.target.result); };
  r.readAsDataURL(f);
}

// Generate the slide's image IN-APP (gpt-image-1) with the REAL company logo printed on the hard hat
// & shirt (brandPpe), then add it to the slide. Optional refImage (data URL) guides the picture.
async function ppGenerateImage(i, refImage) {
  const card = document.querySelector(`.pp-slide[data-i="${i}"]`);
  const ta = card && card.querySelector('.pp-img');
  const prompt = ta ? (ta.value || '').trim() : '';
  if (!prompt) { toast('No image prompt on this slide — type one or click ✨ Suggest images first.', 'error'); return; }
  const btn = card && card.querySelector('.pp-gen-img-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating…'; }
  toast(`Generating the image (gpt-image-1)${refImage ? ' from your reference' : ''} and printing the Akara logo on it — this takes ~20–40s…`);
  try {
    const r = await POST('/api/imagegen/artwork', refImage ? { prompt, refImage } : { prompt });
    if (!r || r.error || !r.dataUrl) { toast((r && r.error) || 'Image generation failed.', 'error'); return; }
    _ppDeckDraft = ppCollectDeck();
    const slide = _ppDeckDraft.slides[i]; if (!slide) return;
    slide.images = Array.isArray(slide.images) ? slide.images : [];
    const defaultPlace = (slide.bullets && slide.bullets.length) || (slide.body && String(slide.body).trim()) ? 'right' : 'full';
    slide.images.push({ data: r.dataUrl, name: 'AI image', placement: defaultPlace, size: 'large' });
    ppShowPreview(_ppDeckDraft);
    const marks = r.ppeMarks ? ` — logo placed on ${r.ppeMarks} spot${r.ppeMarks === 1 ? '' : 's'}` : '';
    const left = (typeof r.remaining === 'number') ? ` (${r.remaining} generations left today)` : '';
    toast(`Image added to slide ${i + 1}${marks}${left}.`);
  } catch (e) { toast('Image generation failed: ' + (e && e.message ? e.message : 'error'), 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '🎨 Generate'; } }
}

// Suggest an image prompt for ONE slide (the one the user is working on) and fill its prompt box.
async function ppSuggestOne(i) {
  const full = ppCollectDeck(); _ppDeckDraft = full;
  const s = full.slides[i]; if (!s) return;
  const lite = { title: full.title || '', slides: [{ type: s.type || 'content', heading: s.heading || '', subheading: s.subheading || '', bullets: Array.isArray(s.bullets) ? s.bullets : [], body: s.body || '', hasImage: false }] };
  const style = _ppImgStyleValues('pp2');
  const card = document.querySelector(`.pp-slide[data-i="${i}"]`);
  const btn = card && card.querySelector('.pp-suggest-one-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    const r = await POST('/api/powerpoints/suggest-images', Object.assign({ deck: lite }, style));
    if (!r || r.error) { toast((r && r.error) || 'Suggest failed.', 'error'); return; }
    const pr = r.deck && r.deck.slides && r.deck.slides[0] && r.deck.slides[0].imagePrompt;
    if (pr) {
      s.imagePrompt = pr;
      const ta = card && card.querySelector('.pp-img');
      if (ta) { ta.value = pr; if (typeof autoGrowTextarea === 'function') autoGrowTextarea(ta); }
      toast(`Image prompt suggested for slide ${i + 1} — edit it, then 🎨 Generate or 📋 Copy.`);
    } else { toast('No suggestion returned — try again, or type your own prompt.', 'error'); }
  } catch (e) { toast('Suggest failed: ' + (e && e.message ? e.message : 'error'), 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '💡 Suggest'; } }
}

// Ask the AI to suggest an image prompt (for ChatGPT / DALL·E) for every slide that has no picture.
async function ppSuggestImages() {
  const full = ppCollectDeck();
  _ppDeckDraft = full;
  const style = _ppImgStyleValues('pp2');
  // Send TEXT ONLY — the endpoint only needs slide text, never the (large) base64 image data.
  const lite = {
    title: full.title || '', subtitle: full.subtitle || '',
    slides: (full.slides || []).map(s => ({
      type: s.type || 'content', heading: s.heading || '', subheading: s.subheading || '',
      bullets: Array.isArray(s.bullets) ? s.bullets : [], body: s.body || '',
      imagePrompt: s.imagePrompt || '',
      hasImage: Array.isArray(s.images) && s.images.some(im => im && im.data)
    }))
  };
  const btn = document.getElementById('pp-suggest-imgs-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Suggesting…'; }
  try {
    const r = await POST('/api/powerpoints/suggest-images', Object.assign({ deck: lite }, style));
    if (!r || r.error) { toast((r && r.error) || 'Suggest images failed.', 'error'); return; }
    if (r.deck && Array.isArray(r.deck.slides)) {
      // Merge ONLY the imagePrompt back into the full draft (keep images/translation/video intact).
      r.deck.slides.forEach((s, i) => { if (full.slides[i] && s && s.imagePrompt) full.slides[i].imagePrompt = s.imagePrompt; });
      ppShowPreview(full);
    }
    toast(r.suggested ? `Suggested images for ${r.suggested} slide${r.suggested === 1 ? '' : 's'} — copy each prompt into ChatGPT / DALL·E (or click 🎨 Generate).` : 'No slides needed an image suggestion.');
  } catch (e) { toast('Suggest images failed: ' + (e && e.message ? e.message : 'error'), 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '✨ Suggest images'; } }
}

function ppOpenDevelop() {
  document.getElementById('pp-develop-dialog')?.remove();
  const el = document.createElement('div');
  el.id = 'pp-develop-dialog';
  el.className = 'pp-modal-overlay';
  const tplOpts = _ppTemplates.map(t => `<option value="${esc(t.key)}">${esc(t.label)}${t.slides ? ' — ~' + t.slides + ' slides' : ''} — ${esc(t.description)}</option>`).join('');
  const themeOpts = (_ppThemes.length ? _ppThemes : [{key:'modern-navy',label:'Modern Navy',description:'Default'}]).map(t => `<option value="${esc(t.key)}">${esc(t.label)} — ${esc(t.description)}</option>`).join('');
  el.innerHTML = `<div class="pp-modal" style="width:620px;max-height:none">
    <div class="pp-modal-head">
      <h3>🤖 Develop PowerPoint with AI</h3>
      <p class="cell-sub" style="margin:6px 0 0;font-size:12px">Pick a template + theme, describe the topic, optionally attach a source document. The AI builds a slide outline you can edit, translate, and download as a real .pptx file.</p>
    </div>
    <div style="padding:14px 18px;display:grid;gap:10px">
      <label style="font-size:13px;font-weight:600;color:var(--primary,#1E3A5F)">Training template
        <select id="pp-tpl" style="width:100%;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px">${tplOpts || '<option value="safety-training">Safety Training</option>'}</select></label>
      <label style="font-size:13px;font-weight:600;color:var(--primary,#1E3A5F)">Background theme
        <select id="pp-theme" style="width:100%;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px">${themeOpts}</select></label>
      <label style="font-size:13px;font-weight:600;color:var(--primary,#1E3A5F)">Topic / course title
        <input id="pp-topic" placeholder="e.g. Working at Heights — Roof &amp; Edge Protection" style="width:100%;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px"></label>
      <label style="font-size:13px;font-weight:600;color:var(--primary,#1E3A5F)">Target audience <span class="cell-sub" style="font-weight:400">(optional)</span>
        <input id="pp-audience" placeholder="e.g. Surface mine operators · supervisors · contractors" style="width:100%;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px"></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label style="font-size:13px;font-weight:600;color:var(--primary,#1E3A5F)">Reading / literacy level
          <select id="pp-learning" style="width:100%;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px">
            <option value="">— Default —</option>
            <option value="L1">Level 1 — Operator (Plain Language)</option>
            <option value="L2">Level 2 — Standard Workforce</option>
            <option value="L3">Level 3 — Supervisor / Leadership</option>
            <option value="L4">Level 4 — Technical / Advanced</option>
          </select></label>
        <label style="font-size:13px;font-weight:600;color:var(--primary,#1E3A5F)">Technical depth
          <select id="pp-techdepth" style="width:100%;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px">
            <option value="">— Default —</option>
            <option value="basic">Basic</option>
            <option value="standard">Standard</option>
            <option value="advanced">Advanced</option>
            <option value="expert">Expert</option>
          </select></label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">${_ppImgStyleControlsHtml('pp')}</div>
      <label style="font-size:13px;font-weight:600;color:var(--primary,#1E3A5F)">Slide count <span class="cell-sub" style="font-weight:400">(3–200)</span>
        <input id="pp-slides" type="number" min="3" max="200" value="12" style="width:100%;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px"></label>
      <label class="cs-opt-check" style="font-size:12.5px" title="When a document is uploaded, the AI analyses it and decides how many slides are needed to cover everything — the slide count above is ignored."><input type="checkbox" id="pp-auto-slides" onchange="var s=document.getElementById('pp-slides'); if(s) s.disabled=this.checked"> ✨ Let the AI decide the number of slides after analysing the uploaded document</label>
      <div>
        <label style="font-size:13px;font-weight:600;color:var(--primary,#1E3A5F);display:block">Source document <span class="cell-sub" style="font-weight:400">(optional — DOCX / PDF / PPTX / TXT / image up to 100 MB)</span></label>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById('pp-src-file').click()">📄 Choose file…</button>
          <input type="file" id="pp-src-file" class="hidden" accept=".docx,.pdf,.pptx,.txt,.png,.jpg,.jpeg,.webp,.gif" onchange="ppSrcChanged(this)">
          <span id="pp-src-label" class="cell-sub" style="font-size:12px">No file chosen — AI uses your topic + template only</span>
          <button type="button" class="btn btn-ghost btn-sm" onclick="ppSrcClear()" style="margin-left:auto">Clear</button>
        </div>
      </div>
      <div>
        <label style="font-size:13px;font-weight:600;color:var(--primary,#1E3A5F);display:block">Knowledge Base reference <span class="cell-sub" style="font-weight:400">(optional — pick KB articles to feed the AI as site context)</span></label>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <button type="button" class="btn btn-outline btn-sm" onclick="ppDevKbToggle()">📚 Pick Knowledge Base articles…</button>
          <span id="pp-dev-kb-count" class="cell-sub" style="font-size:12px">No articles selected</span>
        </div>
        <div id="pp-dev-kb-panel" class="eb-kb-panel" style="display:none;margin-top:6px;max-height:200px;overflow-y:auto"></div>
      </div>
    </div>
    <div class="pp-modal-foot">
      <button class="btn btn-outline" onclick="document.getElementById('pp-develop-dialog').remove()">Cancel</button>
      <button class="btn btn-accent" id="pp-develop-go" onclick="ppDevelopRun()">🤖 Generate Deck</button>
    </div>
  </div>`;
  document.body.appendChild(el);
}

// KB picker on the Develop dialog (separate from the slide-preview KB picker so each can be used independently)
let _ppDevKbArticles = null;
async function ppDevKbToggle() {
  const panel = document.getElementById('pp-dev-kb-panel');
  if (!panel) return;
  if (panel.style.display === 'none' || !panel.style.display) {
    if (!_ppDevKbArticles) _ppDevKbArticles = await GET('/api/content/kb-context') || [];
    if (!_ppDevKbArticles.length) {
      panel.innerHTML = '<div class="cell-sub" style="padding:8px 4px">No published Knowledge Base articles available.</div>';
    } else {
      const groups = {};
      for (const a of _ppDevKbArticles) { const k = a.categoryName || 'General'; (groups[k] = groups[k] || []).push(a); }
      panel.innerHTML = `<div class="eb-kb-head"><strong>📚 KB articles to use as site context</strong>
          <span class="cell-sub">Tick any articles whose facts / terminology the AI should ground the deck content in.</span>
          <button class="btn btn-ghost btn-sm" onclick="ppDevKbToggle()" style="margin-left:auto">✕ Close</button></div>
        <div class="eb-kb-list">` + Object.keys(groups).sort().map(g =>
          `<div class="eb-kb-group"><div class="eb-kb-group-h">${esc(g)}</div>` +
          groups[g].map(a => `<label class="eb-kb-item"><input type="checkbox" class="pp-dev-kb-cb" value="${a.ArticleID}" onchange="ppDevKbUpdateCount()"><span>${esc(a.Title)}</span></label>`).join('') +
          `</div>`).join('') + `</div>`;
    }
    panel.style.display = 'block';
  } else { panel.style.display = 'none'; }
}
function ppDevKbUpdateCount() {
  const n = document.querySelectorAll('#pp-dev-kb-panel .pp-dev-kb-cb:checked').length;
  const el = document.getElementById('pp-dev-kb-count');
  if (el) el.textContent = n ? `${n} article${n===1?'':'s'} selected` : 'No articles selected';
}
function _ppDevSelectedKbIds() {
  return [...document.querySelectorAll('#pp-dev-kb-panel .pp-dev-kb-cb:checked')].map(c => parseInt(c.value, 10)).filter(Boolean);
}

// Save-destination picker — when user picks Training Material, reveal a category dropdown populated from tblTrainMatCat
let _ppTmCats = null;
async function ppDestChange() {
  const dest = (document.getElementById('pp-preview-dest') || {}).value;
  const wrap = document.getElementById('pp-dest-cat-wrap');
  if (!wrap) return;
  if (dest === 'training-material') {
    if (!_ppTmCats) {
      try { _ppTmCats = await GET('/api/content/trainmat-cats') || []; } catch { _ppTmCats = []; }
    }
    const sel = document.getElementById('pp-dest-cat');
    if (sel) {
      const keep = sel.value;
      sel.innerHTML = '<option value="">— pick or add category —</option>' +
        (_ppTmCats || []).map(c => `<option value="${esc(c.Name)}">${esc(c.Name)}</option>`).join('');
      if (keep) sel.value = keep;
    }
    wrap.style.display = 'inline-flex';
  } else {
    wrap.style.display = 'none';
  }
}
async function ppDestAddCat() {
  const name = (prompt('New Training Material category name (e.g. CAT789, Grader Training Material)') || '').trim();
  if (!name) return;
  // Add via the existing Content Studio endpoint if available; otherwise just add to the local list
  try {
    const r = await POST('/api/content/trainmat-cats', { name });
    if (!ok(r)) return;
  } catch {}
  // Refresh and select the new one
  _ppTmCats = null;
  await ppDestChange();
  const sel = document.getElementById('pp-dest-cat');
  if (sel) sel.value = name;
  toast(`Added Training Material category "${name}".`);
}

function ppSrcChanged(input) {
  const f = input.files && input.files[0];
  const lbl = document.getElementById('pp-src-label');
  if (lbl) lbl.textContent = f ? `📄 ${f.name} (${(f.size/1024).toFixed(0)} KB) — AI will base content on this document` : 'No file chosen — AI uses your topic + template only';
}
function ppSrcClear() {
  const i = document.getElementById('pp-src-file'); if (i) i.value = '';
  ppSrcChanged({ files: [] });
}

async function ppDevelopRun() {
  const topic    = (val('pp-topic') || '').trim();
  const audience = (val('pp-audience') || '').trim();
  const slides   = parseInt(val('pp-slides'), 10) || 12;
  const template = val('pp-tpl');
  const theme    = val('pp-theme') || 'modern-navy';
  const fileInp  = document.getElementById('pp-src-file');
  const file     = fileInp && fileInp.files && fileInp.files[0];
  if (!topic) { toast('Enter a topic for the deck.', 'error'); return; }
  const autoSlidesOn = !!(document.getElementById('pp-auto-slides') && document.getElementById('pp-auto-slides').checked);
  const btn = document.getElementById('pp-develop-go');
  const slow = slides > 30 ? `30–${Math.min(8, Math.ceil(slides/20))} min` : '30–90s';
  if (btn) { btn.disabled = true; btn.textContent = autoSlidesOn ? '⏳ AI is analysing the document & designing the deck…' : `⏳ AI is designing ${slides} slides (${slow})…`; }
  if (!autoSlidesOn && slides > 50) toast(`Designing a ${slides}-slide deck — Claude needs a few minutes to keep the quality high. Please don't close the dialog.`);
  else if (autoSlidesOn) toast('The AI is analysing the document to decide how many slides are needed — this can take a few minutes. Please keep the dialog open.');
  try {
    // Always go via fetch+FormData so we can attach the optional file
    const fd = new FormData();
    fd.append('topic', topic);
    fd.append('audience', audience);
    fd.append('slides', String(slides));
    fd.append('template', template);
    fd.append('theme', theme);
    // Let the AI decide the slide count from its analysis of the uploaded document.
    const autoSlides = !!(document.getElementById('pp-auto-slides') && document.getElementById('pp-auto-slides').checked);
    if (autoSlides) fd.append('autoSlides', 'true');
    // Audience dials — reading/literacy level + technical depth (same as the Content Studio).
    const learningProfile = val('pp-learning') || '';
    const techDepth = val('pp-techdepth') || '';
    if (learningProfile) fd.append('learningProfile', learningProfile);
    if (techDepth) fd.append('techDepth', techDepth);
    // Image style (style / region / gender) baked into suggested image prompts.
    const imgStyle = _ppImgStyleValues('pp');
    if (imgStyle.imgStyle) fd.append('imgStyle', imgStyle.imgStyle);
    if (imgStyle.imgRegion) fd.append('imgRegion', imgStyle.imgRegion);
    if (imgStyle.imgGender) fd.append('imgGender', imgStyle.imgGender);
    if (file) fd.append('file', file);
    // Selected Knowledge Base articles, if any — backend reads kbArticleIds and adds the article bodies to the prompt
    const kbIds = (typeof _ppDevSelectedKbIds === 'function') ? _ppDevSelectedKbIds() : [];
    if (kbIds.length) fd.append('kbArticleIds', JSON.stringify(kbIds));
    console.log('[pp-develop] POST /api/powerpoints/develop topic="' + topic + '" slides=' + slides + ' tpl=' + template + ' theme=' + theme + ' file=' + (file ? file.name : 'none') + ' kb=' + kbIds.length);
    const resp = await fetch('/api/powerpoints/develop', { method: 'POST', credentials: 'include', body: fd });
    const r = await resp.json().catch(() => ({ error: 'Server returned non-JSON.' }));
    console.log('[pp-develop] response HTTP ' + resp.status, r);
    if (!resp.ok) {
      const msg = 'Develop failed (HTTP ' + resp.status + '):\n\n' + (r.error || 'unknown error');
      toast(r.error || ('Develop failed (HTTP ' + resp.status + ')'), 'error');
      alert(msg + '\n\nOpen DevTools (F12) → Console for the request details and copy them here if it persists.');
      return;
    }
    _ppDeckDraft = r.deck;
    _ppDeckDraft.__template = r.template || template;
    _ppDeckDraft.__theme = theme;
    document.getElementById('pp-develop-dialog')?.remove();
    ppShowPreview(_ppDeckDraft);
  } catch (e) {
    toast('Develop failed: ' + (e && e.message ? e.message : 'network error'), 'error');
  } finally { if (btn) { btn.disabled = false; btn.textContent = '🤖 Generate Deck'; } }
}

const PP_TRANS_LANGS = ['Spanish','French','Portuguese','Mandarin Chinese','Indonesian','Bahasa Melayu','Thai','Vietnamese','Tagalog','Hindi','Japanese','Korean','German','Italian','Russian','Arabic','Polish','Afrikaans','Zulu','Swahili'];

// Slide preview — editable, with translate bar + KB picker, then build .pptx
function ppShowPreview(deck) {
  document.getElementById('pp-preview-dialog')?.remove();
  const el = document.createElement('div');
  el.id = 'pp-preview-dialog';
  el.className = 'pp-modal-overlay';
  // Keep the chosen language "locked in" across re-renders (was resetting to blank, forcing re-selection).
  const selLang = _ppTransLang || (deck.translation && deck.translation.lang) || '';
  const langOpts = '<option value="">— select language —</option>' + PP_TRANS_LANGS.map(l => `<option value="${l}"${l === selLang ? ' selected' : ''}>${l}</option>`).join('');
  const slidesHtml = (deck.slides || []).map((s, i) => {
    const typeOpts = ['title','content','two-column','bullets','image','quote','section','qa'].map(t => `<option value="${t}"${s.type===t?' selected':''}>${t}</option>`).join('');
    const bullets = Array.isArray(s.bullets) ? s.bullets.join('\n') : '';
    const tr = s.translation || null;
    const trBlock = tr ? `<div class="pp-trans-block">
      <div class="pp-trans-tag">🌐 ${esc(tr.lang || 'Translation')}</div>
      <input class="pp-th" value="${esc(tr.heading||'')}" placeholder="Translated heading">
      <input class="pp-tsub" value="${esc(tr.subheading||'')}" placeholder="Translated subheading">
      <textarea class="pp-tbullets" rows="${Math.max(3, (tr.bullets||[]).length)}" placeholder="One translated bullet per line">${esc((tr.bullets||[]).join('\n'))}</textarea>
    </div>` : '';
    const imgs = Array.isArray(s.images) ? s.images.filter(im => im && im.data) : [];
    const vid = (s.video && s.video.url) ? s.video : null;
    // Embed image data into a hidden JSON store so it round-trips via ppCollectDeck without re-uploading
    const imgsJson = esc(JSON.stringify(imgs));
    const placeOpts = (sel) => `
      <option value="right"${sel==='right'?' selected':''}>↦ Right of text</option>
      <option value="left"${sel==='left'?' selected':''}>↤ Left of text</option>
      <option value="top"${sel==='top'?' selected':''}>↑ Above text</option>
      <option value="bottom"${sel==='bottom'?' selected':''}>↓ Below text</option>
      <option value="full"${sel==='full'?' selected':''}>⛶ Fill slide</option>`;
    const sizeOpts = (sel) => `
      <option value="small"${sel==='small'?' selected':''}>S — 30%</option>
      <option value="medium"${sel==='medium'?' selected':''}>M — 60%</option>
      <option value="large"${(!sel||sel==='large')?' selected':''}>L — 100% (default)</option>
      <option value="xlarge"${sel==='xlarge'?' selected':''}>XL — 130%</option>`;
    const imgThumbs = imgs.map((im, k) => {
      const place = im.placement || 'right';
      const size  = im.size || 'large';
      const calloutCount = (Array.isArray(im.callouts) ? im.callouts.length : 0);
      const calloutLabel = calloutCount ? `🎯 ${calloutCount} callout${calloutCount===1?'':'s'}` : '🎯 Add callouts';
      return `<span class="pp-thumb"><img src="${esc(im.data)}" alt=""><button type="button" class="pp-thumb-x" onclick="ppRemoveImage(${i},${k})" title="Remove image">✕</button>${im.name ? `<span class="pp-thumb-name">${esc((im.name||'').slice(0,18))}</span>` : ''}<select class="pp-thumb-place" onchange="ppSetImagePlacement(${i},${k},this.value)" title="Image placement">${placeOpts(place)}</select><select class="pp-thumb-place pp-thumb-size" onchange="ppSetImageSize(${i},${k},this.value)" title="Image size on the slide">${sizeOpts(size)}</select><button type="button" class="pp-thumb-callouts ${calloutCount?'has':''}" onclick="ppOpenCalloutEditor(${i},${k})" title="Add labeled callouts (text + line + dot) to mark parts of this image">${calloutLabel}</button></span>`;
    }).join('');
    const videoChip = vid ? `<span class="pp-video-chip">🎬 ${esc(vid.url.slice(0, 60))} <select class="pp-thumb-place" onchange="ppSetVideoPlacement(${i},this.value)" title="Video placement">${placeOpts(vid.placement || 'bottom')}</select> <select class="pp-thumb-place pp-thumb-size" onchange="ppSetVideoSize(${i},this.value)" title="Video size on the slide">${sizeOpts(vid.size || 'large')}</select> <button type="button" class="pp-thumb-x" onclick="ppRemoveVideo(${i})" title="Remove video">✕</button></span>` : '';
    return `<div class="pp-slide" data-i="${i}">
      <div class="pp-slide-head">
        <span class="pp-slide-num">Slide ${i+1}</span>
        <button type="button" class="btn btn-ghost btn-sm btn-icon" onclick="ppMoveSlide(${i},-1)" title="Move slide up">↑</button>
        <button type="button" class="btn btn-ghost btn-sm btn-icon" onclick="ppMoveSlide(${i},1)" title="Move slide down">↓</button>
        <button type="button" class="btn btn-ghost btn-sm btn-icon" onclick="ppMoveSlideTo(${i})" title="Move slide to a specific position">⇅</button>
        <select class="pp-type">${typeOpts}</select>
        <button type="button" class="btn btn-outline btn-sm pp-assist-btn" onclick="ppAssistSlide(${i})" title="AI assistant — write, improve or expand this slide's content">✨ AI assist</button>
        <button type="button" class="btn btn-ghost btn-sm btn-icon" onclick="ppTranslateSlide(${i})" title="Translate just this slide">🌐</button>
        <span class="pp-trans-status" data-pp-status="${i}"></span>
        <button type="button" class="btn btn-danger btn-sm btn-icon" onclick="ppRemoveSlide(${i})" title="Remove slide">🗑️</button>
      </div>
      <div class="pp-bilingual">
        <div class="pp-orig">
          <input class="pp-h" value="${esc(s.heading||'')}" placeholder="Heading">
          <input class="pp-sub" value="${esc(s.subheading||'')}" placeholder="Subheading (optional)">
          <textarea class="pp-bullets fa-auto-grow" rows="${Math.max(3, (s.bullets||[]).length)}" placeholder="One bullet per line" oninput="autoGrowTextarea(this)">${esc(bullets)}</textarea>
        </div>
        ${trBlock}
      </div>
      <div class="pp-media-zone">
        <div class="pp-media-toolbar">
          <button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById('pp-img-input-${i}').click()" title="Add an image to this slide (PNG / JPG / GIF / WebP, up to 5 MB)">📷 Add Image</button>
          <input type="file" id="pp-img-input-${i}" class="hidden" accept="image/png,image/jpeg,image/gif,image/webp" multiple onchange="ppAddImage(${i}, this)">
          <button type="button" class="btn btn-outline btn-sm" onclick="ppPromptVideo(${i})" title="Embed a YouTube / Vimeo URL or a direct .mp4 / .webm link">🎬 Add Video</button>
          <button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById('pp-ref-input-${i}').click()" title="Upload a reference image — the AI generates this slide's image guided by it (with the Akara logo), then adds it to the slide">🖼 AI image from reference</button>
          <input type="file" id="pp-ref-input-${i}" class="hidden" accept="image/png,image/jpeg,image/webp,image/gif" onchange="ppRefImageGenerate(${i}, this)">
          <span class="cell-sub pp-media-hint">Images embed in the deck · videos accept YouTube/Vimeo/.mp4 · a reference image guides AI generation</span>
        </div>
        <div class="pp-thumbs" data-pp-thumbs>${imgThumbs}${videoChip}</div>
        <input type="hidden" class="pp-imgs-json" value="${imgsJson}">
        <input type="hidden" class="pp-video-url" value="${esc(vid ? vid.url : '')}">
        <div class="pp-imgsuggest"${imgs.length ? ' style="display:none"' : ''}>
          <div class="pp-imgsuggest-h">💡 Suggested image — copy this prompt into <b>ChatGPT / DALL·E</b>, create the image, then <b>📷 Add Image</b> above</div>
          <div class="pp-imgsuggest-row">
            <textarea class="pp-img fa-auto-grow" rows="2" placeholder="No image suggested yet — click ✨ Suggest images in the toolbar, or type your own prompt here" oninput="autoGrowTextarea(this)">${esc(s.imagePrompt||'')}</textarea>
            <div class="pp-imgsuggest-btns">
              <button type="button" class="btn btn-outline btn-sm pp-suggest-one-btn" onclick="ppSuggestOne(${i})" title="AI: suggest an image prompt for THIS slide">💡 Suggest</button>
              <button type="button" class="btn btn-accent btn-sm pp-gen-img-btn" onclick="ppGenerateImage(${i})" title="Generate this image in-app (gpt-image-1) with the real Akara logo printed on the hard hat & shirt, then add it to the slide">🎨 Generate</button>
              <button type="button" class="btn btn-outline btn-sm" onclick="ppCopyImgPrompt(${i})" title="Copy this image prompt to paste into ChatGPT / DALL·E">📋 Copy</button>
            </div>
          </div>
        </div>
      </div>
      <details class="pp-advanced"><summary>Trainer notes &amp; advanced</summary>
        <textarea class="pp-notes fa-auto-grow" rows="2" placeholder="Trainer speaker notes (not shown on slide)" oninput="autoGrowTextarea(this)">${esc(s.notes||'')}</textarea>
        <textarea class="pp-body fa-auto-grow" rows="2" placeholder="Optional body paragraph" oninput="autoGrowTextarea(this)">${esc(s.body||'')}</textarea>
      </details>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="pp-modal">
    <div class="pp-modal-head">
      <div class="pp-head-row">
        <h3>🎞 Slide Preview — edit, translate, then build .pptx</h3>
        <div class="pp-view-toggle" role="tablist">
          <button type="button" class="pp-view-btn active" id="pp-view-edit" onclick="ppSetViewMode('edit')" title="Edit slide content">📝 Edit</button>
          <button type="button" class="pp-view-btn" id="pp-view-preview" onclick="ppSetViewMode('preview')" title="See each slide as it will render in PowerPoint">👁 Preview</button>
        </div>
        <button class="btn btn-outline btn-sm" onclick="ppAddSlide()">➕ Add slide</button>
        <button class="btn btn-outline btn-sm" id="pp-suggest-imgs-btn" onclick="ppSuggestImages()" title="Let the AI suggest an image (with a ready-to-paste ChatGPT / DALL·E prompt) for each slide that has no picture">✨ Suggest images</button>
        <button class="btn btn-outline btn-sm" onclick="ppPrintWithNotes()" title="Open a printable view that includes speaker notes under each slide">🖨 Print with Notes</button>
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('pp-preview-dialog').remove()">✕ Close</button>
      </div>
      <div class="pp-deck-meta">
        <input id="pp-d-title" value="${esc(deck.title||'')}" placeholder="Deck title" class="pp-d-title-input">
        <input id="pp-d-sub" value="${esc(deck.subtitle||'')}" placeholder="Subtitle / course code">
        <input id="pp-d-presenter" value="${esc(deck.presenter||'')}" placeholder="Presenter" class="pp-d-presenter">
        <label style="font-size:12px;font-weight:600;color:var(--primary,#1E3A5F);grid-column:1/-1;display:flex;align-items:center;gap:6px">🎨 Theme
          <select id="pp-preview-theme" style="flex:1;padding:5px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px">${(_ppThemes.length ? _ppThemes : [{key:'modern-navy',label:'Modern Navy',description:'Default'}]).map(t => `<option value="${esc(t.key)}"${(deck.__theme === t.key) ? ' selected' : ''}>${esc(t.label)} — ${esc(t.description)}</option>`).join('')}</select>
        </label>
        <div style="grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;align-items:end">
          <div style="grid-column:1/-1;font-size:12px;font-weight:600;color:var(--primary,#1E3A5F)">🖼 Suggested-image style <span class="cell-sub" style="font-weight:400">(used by ✨ Suggest images)</span></div>
          ${_ppImgStyleControlsHtml('pp2')}
        </div>
        <label style="font-size:12px;font-weight:600;color:var(--primary,#1E3A5F);grid-column:1/-1;display:flex;align-items:center;gap:6px;flex-wrap:wrap">📁 Save destination
          <select id="pp-preview-dest" onchange="ppDestChange()" style="flex:1;min-width:220px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px">
            <option value="powerpoints" selected>🎞 Training PowerPoint Library</option>
            <option value="library">📎 Document Library</option>
            <option value="training-standards">📐 Training Standards</option>
            <option value="training-material">🗂 Training Material…</option>
          </select>
          <span id="pp-dest-cat-wrap" style="display:none;align-items:center;gap:6px">
            <select id="pp-dest-cat" style="min-width:160px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px">
              <option value="">— pick or add category —</option>
            </select>
            <button type="button" class="btn btn-ghost btn-sm" onclick="ppDestAddCat()" title="Add a new Training Material category">➕</button>
          </span>
        </label>
      </div>
      <div class="cs-trans-bar pp-trans-bar">
        <span class="cs-trans-label">🌐 Translate</span>
        <select id="pp-trans-lang">${langOpts}</select>
        <button type="button" class="btn btn-accent btn-sm" id="pp-trans-all-btn" onclick="ppTranslateAll()">🌐 Translate All Slides</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="ppKbToggle()" title="Pick KB articles to use as site reference during translation">📚 Knowledge Base…</button>
        <span class="pp-langfilter cs-trans-layout"><span class="cell-sub" style="align-self:center">Slides:</span>
          <button type="button" class="btn btn-sm${_ppLangFilter==='both'?' active':''}" id="pp-lf-both" onclick="ppSetLangFilter('both')" title="English slide followed by a translated copy">🅴+🆃 Both (duplicate)</button>
          <button type="button" class="btn btn-sm${_ppLangFilter==='en'?' active':''}" id="pp-lf-en" onclick="ppSetLangFilter('en')" title="English slides only">🅴 English only</button>
          <button type="button" class="btn btn-sm${_ppLangFilter==='lang'?' active':''}" id="pp-lf-lang" onclick="ppSetLangFilter('lang')" title="Translated slides only">🆃 Translation only</button>
        </span>
        <span class="cell-sub pp-trans-hint">Translating duplicates each slide: the English slide is followed by a translated copy (same pictures, translated speaker notes). “Slides” chooses what to keep in the download. Uses the approved terminology glossary.</span>
        <div id="pp-kb-panel" class="eb-kb-panel" style="display:none;flex-basis:100%"></div>
      </div>
    </div>
    <div id="pp-slides" class="pp-slides">${slidesHtml}</div>
    <div class="pp-modal-foot">
      <button class="btn btn-outline" onclick="ppDownload(false)" title="Build .pptx and download without saving to the library">⬇ Download only</button>
      <button class="btn btn-accent" onclick="ppDownload(true)" title="Save to the PowerPoint library and download">💾 Save to Library &amp; Download</button>
    </div>
  </div>`;
  document.body.appendChild(el);
  ppApplyTransLayout(); // reflect the chosen translation placement (above/below/side) in the preview
  ppSetLangFilter(_ppLangFilter); // reflect the language filter (both / English / translation)
  // Size all auto-grow textareas to their content
  setTimeout(() => autoGrowAll(el), 50);
}

// KB picker (mirrors Exam Builder / Content Studio)
let _ppKbArticles = null;
async function ppKbToggle() {
  const panel = document.getElementById('pp-kb-panel');
  if (!panel) return;
  if (panel.style.display === 'none' || !panel.style.display) {
    if (!_ppKbArticles) _ppKbArticles = await GET('/api/content/kb-context') || [];
    if (!_ppKbArticles.length) {
      panel.innerHTML = '<div class="cell-sub" style="padding:8px 4px">No published Knowledge Base articles available.</div>';
    } else {
      const groups = {};
      for (const a of _ppKbArticles) { const k = a.categoryName || 'General'; (groups[k] = groups[k] || []).push(a); }
      panel.innerHTML = `<div class="eb-kb-head"><strong>📚 Use as site reference for translation</strong>
          <span class="cell-sub">Tick any articles whose facts/terminology should guide the translator.</span>
          <button class="btn btn-ghost btn-sm" onclick="ppKbToggle()" style="margin-left:auto">✕ Close</button></div>
        <div class="eb-kb-list">` + Object.keys(groups).sort().map(g =>
          `<div class="eb-kb-group"><div class="eb-kb-group-h">${esc(g)}</div>` +
          groups[g].map(a => `<label class="eb-kb-item"><input type="checkbox" class="pp-kb-cb" value="${a.ArticleID}"><span>${esc(a.Title)}</span></label>`).join('') +
          `</div>`).join('') + `</div>`;
    }
    panel.style.display = 'block';
  } else { panel.style.display = 'none'; }
}
function _ppSelectedKbIds() {
  return [...document.querySelectorAll('#pp-kb-panel .pp-kb-cb:checked')].map(c => parseInt(c.value, 10)).filter(Boolean);
}

// Per-slide status chip — shows a running timer while a slide is being translated and a check when it finishes
function _ppSetStatus(idx, state, text) {
  const el = document.querySelector(`[data-pp-status="${idx}"]`);
  if (!el) return;
  el.className = 'pp-trans-status ' + (state || '');
  el.textContent = text || '';
}
function _ppStartTimer(idx) {
  const el = document.querySelector(`[data-pp-status="${idx}"]`);
  if (!el) return null;
  el.className = 'pp-trans-status running';
  const t0 = Date.now();
  const tick = () => {
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    el.textContent = `⏳ ${s}s`; // hourglass while this slide is translating
  };
  tick();
  const handle = setInterval(tick, 100);
  return { stop: () => clearInterval(handle), elapsed: () => ((Date.now() - t0) / 1000).toFixed(1) };
}

// Translation placement controls (mirror the AI Content Studio): above | below | side, and — for side —
// which language leads. Affects the preview and is sent to the builder so the .pptx matches.
function ppSetTransLayout(mode) {
  _ppTransLayout = mode;
  ppApplyTransLayout();
  document.getElementById('pp-tbl-above')?.classList.toggle('active', mode === 'above');
  document.getElementById('pp-tbl-below')?.classList.toggle('active', mode === 'below');
  document.getElementById('pp-tbl-side')?.classList.toggle('active', mode === 'side');
}
function ppSetTransSideOrder(order) {
  _ppTransSideOrder = order;
  ppApplyTransLayout();
  document.getElementById('pp-ord-en')?.classList.toggle('active', order === 'en-first');
  document.getElementById('pp-ord-lang')?.classList.toggle('active', order === 'lang-first');
}
function ppApplyTransLayout() {
  const wrap = document.getElementById('pp-slides');
  if (wrap) {
    wrap.classList.toggle('trans-side', _ppTransLayout === 'side');
    wrap.classList.toggle('trans-above', _ppTransLayout === 'above');
    wrap.classList.toggle('trans-side-langfirst', _ppTransLayout === 'side' && _ppTransSideOrder === 'lang-first');
  }
  const ord = document.getElementById('pp-trans-order');
  if (ord) ord.style.display = (_ppTransLayout === 'side') ? 'inline-flex' : 'none';
}

// ── Duplicate-slide translation: English slide + translated copy (same pictures, translated notes) ─────
// Language filter for the built/downloaded deck: 'both' (duplicate), 'en' (English only), 'lang' (translated only).
let _ppLangFilter = 'both';
// The locked-in translation language — set on the first Translate All, reused for every retry so the user
// never has to re-pick it (it also survives preview re-renders via ppShowPreview's langOpts).
let _ppTransLang = '';

// A slide counts as "translated" only if its translation is for the current language AND has real content —
// this is how the retry loop checks the AI-translator output to find slides that still need translating.
function ppTransHasContent(s, lang) {
  const t = s && s.translation;
  if (!t || (lang && t.lang !== lang)) return false;
  const anySrc = (s.heading || '') + (s.subheading || '') + (Array.isArray(s.bullets) ? s.bullets.join('') : '') + (s.body || '') + (s.notes || '');
  if (!anySrc.trim()) return true; // nothing to translate on this slide → treat as done
  const anyTr = (t.heading || '') + (t.subheading || '') + (Array.isArray(t.bullets) ? t.bullets.join('') : '') + (t.body || '') + (t.notes || '');
  return !!anyTr.trim();
}

// Build a monolingual translated copy of a slide: translated text where available, English as fallback, and
// the SAME images/video from the original so pictures carry over. No `.translation` → renders single-language.
function ppMakeTranslatedSlide(s, tr, deckTr) {
  const cp = Object.assign({}, s);
  delete cp.translation;
  if (s.type === 'title') {
    if (deckTr && deckTr.title) cp.heading = deckTr.title;
    if (deckTr && deckTr.subtitle) cp.subheading = deckTr.subtitle;
    if (deckTr && deckTr.presenter) cp.presenter = deckTr.presenter;
  }
  if (tr) {
    if (tr.heading) cp.heading = tr.heading;
    if (tr.subheading) cp.subheading = tr.subheading;
    if (Array.isArray(tr.bullets) && tr.bullets.length) cp.bullets = tr.bullets.slice();
    if (tr.body) cp.body = tr.body;
    cp.notes = tr.notes || s.notes || '';   // translated speaker notes
  }
  cp.images = Array.isArray(s.images) ? s.images.map(im => Object.assign({}, im)) : undefined; // same pictures
  cp.video = s.video ? Object.assign({}, s.video) : undefined;
  cp.__lang = (tr && tr.lang) || (deckTr && deckTr.lang) || '';
  return cp;
}

// Expand a deck for the chosen language filter. Slides with a translation become English + translated copies
// ('both'), English only ('en'), or translated only ('lang'); untranslated slides pass through as English.
function ppExpandDeck(deck, filter) {
  const out = Object.assign({}, deck, { slides: [] });
  const deckTr = deck.translation || null;
  for (const s of (deck.slides || [])) {
    const tr = (s.translation && s.translation.lang) ? s.translation : null;
    const hasTr = !!tr || (s.type === 'title' && deckTr && deckTr.title);
    const en = Object.assign({}, s); delete en.translation;
    if (filter === 'en' || !hasTr) { out.slides.push(en); continue; }
    const t = ppMakeTranslatedSlide(s, tr, deckTr);
    if (filter === 'lang') out.slides.push(t);
    else { out.slides.push(en); out.slides.push(t); } // 'both' → duplicate
  }
  return out;
}

// Toggle the language filter and reflect it in the editor (dim/hide the other language's blocks).
function ppSetLangFilter(f) {
  _ppLangFilter = f;
  ['both','en','lang'].forEach(k => document.getElementById('pp-lf-' + k)?.classList.toggle('active', k === f));
  const wrap = document.getElementById('pp-slides');
  if (wrap) {
    wrap.classList.toggle('pp-en-only', f === 'en');
    wrap.classList.toggle('pp-lang-only', f === 'lang');
  }
}

// Open a printable window showing one A4 page per slide, with the slide thumbnail on top
// and the speaker notes below. User then hits Ctrl+P / browser print.
function ppPrintWithNotes() {
  const deck = ppCollectDeck();
  if (!deck.slides || !deck.slides.length) { toast('No slides to print.', 'error'); return; }
  const themeKey = (document.getElementById('pp-preview-theme')||{}).value || (_ppDeckDraft && _ppDeckDraft.__theme) || 'modern-navy';
  const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const pages = deck.slides.map((s, i) => {
    const bullets = Array.isArray(s.bullets) ? s.bullets.filter(Boolean) : [];
    const tr = s.translation || {};
    const tBullets = Array.isArray(tr.bullets) ? tr.bullets.filter(Boolean) : [];
    const notes = String(s.notes || '').trim();
    const trNotes = String(tr.notes || '').trim();
    const head = s.heading || (i === 0 ? deck.title : '');
    return `<section class="pn-page">
      <div class="pn-slide pn-theme-${esc(themeKey)} pn-type-${esc(s.type||'bullets')}">
        ${head ? `<div class="pn-head">${esc(head)}</div>` : ''}
        ${tr.heading ? `<div class="pn-thead">${esc(tr.heading)}</div>` : ''}
        ${s.subheading ? `<div class="pn-sub">${esc(s.subheading)}</div>` : ''}
        ${tr.subheading ? `<div class="pn-tsub">${esc(tr.subheading)}</div>` : ''}
        ${bullets.length ? `<ul class="pn-bullets">${bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
        ${tBullets.length ? `<ul class="pn-tbullets">${tBullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
        ${s.body ? `<div class="pn-body">${esc(s.body)}</div>` : ''}
      </div>
      <div class="pn-notes-wrap">
        <div class="pn-notes-label">Speaker notes — Slide ${i+1}</div>
        <div class="pn-notes">${notes ? esc(notes).replace(/\n/g,'<br>') : '<em style="color:#94a3b8">(No notes for this slide)</em>'}</div>
        ${trNotes ? `<div class="pn-notes-label" style="margin-top:8px;color:#1D4ED8">${esc(tr.lang || 'Translation')}</div><div class="pn-notes pn-tnotes">${esc(trNotes).replace(/\n/g,'<br>')}</div>` : ''}
      </div>
      <div class="pn-foot"><span>${esc(deck.title || '')}</span><span>Slide ${i+1} of ${deck.slides.length}</span></div>
    </section>`;
  }).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(deck.title || 'Deck')} — Print with Notes</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Segoe UI, Calibri, Arial, sans-serif; color: #0F172A; margin: 0; padding: 12px; background: #f8fafc; }
  .pn-toolbar { position: sticky; top: 0; background: #1E3A5F; color: #fff; padding: 10px 14px; display: flex; gap: 12px; align-items: center; border-radius: 8px; margin-bottom: 14px; }
  .pn-toolbar button { background: #FBC02D; color: #1E3A5F; border: 0; padding: 7px 16px; font-weight: 700; border-radius: 5px; cursor: pointer; font-size: 14px; }
  .pn-page { background: #fff; padding: 14mm 12mm; margin: 0 auto 14px; max-width: 190mm; box-shadow: 0 2px 6px rgba(0,0,0,0.08); page-break-after: always; min-height: 270mm; display: flex; flex-direction: column; }
  .pn-page:last-child { page-break-after: auto; }
  .pn-slide { background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 18px 22px; min-height: 105mm; position: relative; }
  .pn-slide.pn-type-title, .pn-slide.pn-type-section { background: #1E3A5F; color: #fff; text-align: center; padding: 32px 22px; }
  .pn-slide.pn-type-title .pn-head, .pn-slide.pn-type-section .pn-head { color: #fff; font-size: 28pt; margin: 24px 0 16px; }
  .pn-slide.pn-type-title .pn-sub, .pn-slide.pn-type-section .pn-sub { color: #cbd5e1; font-style: italic; }
  .pn-head { font-size: 20pt; font-weight: 700; color: #1E3A5F; margin-bottom: 6px; }
  .pn-thead { font-size: 13pt; color: #1D4ED8; font-style: italic; margin-bottom: 8px; }
  .pn-sub { font-size: 12pt; color: #64748b; font-style: italic; margin-bottom: 12px; }
  .pn-tsub { font-size: 11pt; color: #1D4ED8; font-style: italic; margin-bottom: 10px; }
  .pn-bullets { padding-left: 22px; font-size: 12pt; line-height: 1.5; color: #0F172A; }
  .pn-tbullets { padding-left: 22px; font-size: 11pt; line-height: 1.4; color: #1D4ED8; font-style: italic; margin-top: 6px; }
  .pn-body { font-size: 12pt; line-height: 1.5; color: #0F172A; }
  .pn-notes-wrap { background: #fef9c3; border-left: 4px solid #FBC02D; padding: 12px 16px; margin-top: 14px; border-radius: 4px; flex: 1; }
  .pn-notes-label { font-size: 10pt; font-weight: 700; color: #92400e; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 6px; }
  .pn-notes { font-size: 11pt; line-height: 1.5; color: #0F172A; white-space: pre-wrap; }
  .pn-foot { display: flex; justify-content: space-between; font-size: 9pt; color: #94a3b8; margin-top: 10px; border-top: 1px solid #e2e8f0; padding-top: 6px; }
  @media print {
    body { background: #fff; padding: 0; }
    .pn-toolbar { display: none !important; }
    .pn-page { box-shadow: none; margin: 0; max-width: none; padding: 0; min-height: 0; }
    .pn-slide { border: 1px solid #cbd5e1; }
  }
</style></head><body>
<div class="pn-toolbar">
  <strong>${esc(deck.title || 'Deck')}</strong>
  <span style="opacity:0.8">${deck.slides.length} slides · speaker notes included</span>
  <span style="flex:1"></span>
  <button onclick="window.print()">🖨 Print</button>
  <button onclick="window.close()" style="background:#475569;color:#fff">Close</button>
</div>
${pages}
<script>setTimeout(function(){ try { window.focus(); } catch(e){} }, 100);<\/script>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('Pop-ups blocked — allow pop-ups to print with notes.', 'error'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}

async function ppTranslateAll() {
  const lang = val('pp-trans-lang') || _ppTransLang;
  if (!lang) { toast('Pick a language first.', 'error'); return; }
  _ppTransLang = lang;                 // LOCK the language — reused for every retry, survives re-renders
  setVal('pp-trans-lang', lang);
  const btn = document.getElementById('pp-trans-all-btn');
  const total = (ppCollectDeck().slides || []).length;
  if (!total) { toast('No slides to translate.', 'error'); return; }
  document.querySelectorAll('.pp-trans-status').forEach(el => { el.className = 'pp-trans-status'; el.textContent = ''; });
  const overallStart = Date.now();
  for (let i = 0; i < total; i++) _ppSetStatus(i, 'pending', '⏳ queued');

  // Translate a single slide; on retry passes request the full token budget so big slides can't truncate.
  const translateOne = async (i, fullTokens) => {
    const timer = _ppStartTimer(i);
    try {
      const payload = ppCollectDeck();
      payload.__template = _ppDeckDraft && _ppDeckDraft.__template;
      const r = await POST('/api/powerpoints/translate-deck', { deck: payload, targetLang: lang, kbArticleIds: _ppSelectedKbIds(), slideIndex: i, fullTokens: !!fullTokens });
      if (!r || r.error) throw new Error((r && r.error) || 'Translation failed');
      if (r.deck && Array.isArray(r.deck.slides) && r.deck.slides[i]) {
        _ppDeckDraft = _ppDeckDraft || r.deck;
        _ppDeckDraft.slides[i] = r.deck.slides[i];
        if (r.deck.translation) _ppDeckDraft.translation = r.deck.translation;
      }
      if (timer) timer.stop();
      const good = ppTransHasContent(_ppDeckDraft.slides[i], lang);
      _ppSetStatus(i, good ? 'done' : 'failed', good ? `✓ ${timer ? timer.elapsed() : '?'}s` : '✕ empty');
      return good;
    } catch (e) {
      if (timer) timer.stop();
      _ppSetStatus(i, 'failed', '✕ failed');
      console.error('[ppTranslateAll] slide', i, e);
      return false;
    }
  };

  // LOOP: pass 1 translates everything; each further pass re-checks which slides are still untranslated and
  // retries ONLY those, at the full token level, until all are done or we hit the pass cap.
  const MAX_PASSES = 4;
  let pass = 0;
  for (pass = 1; pass <= MAX_PASSES; pass++) {
    if (btn) btn.disabled = true;
    const draft = ppCollectDeck();
    _ppDeckDraft = _ppDeckDraft || draft;
    const todo = [];
    for (let i = 0; i < total; i++) if (!ppTransHasContent(_ppDeckDraft.slides[i] || draft.slides[i], lang)) todo.push(i);
    if (!todo.length) break;
    if (pass > 1) toast(`🔁 Retry pass ${pass}: re-translating ${todo.length} slide(s) at full token level…`);
    else toast(`Translating ${todo.length} slide(s) to ${lang}. Each slide ~5–20s.`);
    let n = 0;
    for (const i of todo) {
      n++;
      if (btn) btn.textContent = pass > 1 ? `🔁 Retry ${n}/${todo.length}…` : `⏳ Translating ${n}/${todo.length}…`;
      await translateOne(i, pass > 1); // full tokens on retry passes
    }
    if (pass < MAX_PASSES) await new Promise(r => setTimeout(r, 800)); // brief pause between passes
  }

  if (btn) { btn.disabled = false; btn.textContent = '🌐 Translate All Slides'; }
  ppShowPreview(_ppDeckDraft);
  let done = 0;
  _ppDeckDraft.slides.forEach((s, i) => { if (ppTransHasContent(s, lang)) { _ppSetStatus(i, 'done', '✓ translated'); done++; } else _ppSetStatus(i, 'failed', '✕ not translated'); });
  const failed = total - done;
  const elapsed = ((Date.now() - overallStart) / 1000).toFixed(1);
  if (failed) toast(`Translated ${done}/${total} to ${lang} in ${elapsed}s after ${pass - 1} pass(es) · ${failed} still failed — click 🌐 Translate All Slides to run another retry loop.`, 'error');
  else        toast(`✅ Translated all ${done} slide(s) to ${lang} in ${elapsed}s (${pass - 1} pass(es)).`);
}

async function ppTranslateSlide(idx) {
  const lang = val('pp-trans-lang') || _ppTransLang;
  if (!lang) { toast('Pick a language in the Translate bar first.', 'error'); return; }
  _ppTransLang = lang; setVal('pp-trans-lang', lang); // lock the language for reuse
  const deck = ppCollectDeck();
  deck.__template = _ppDeckDraft && _ppDeckDraft.__template;
  const timer = _ppStartTimer(idx);
  try {
    const r = await POST('/api/powerpoints/translate-deck', { deck, targetLang: lang, kbArticleIds: _ppSelectedKbIds(), slideIndex: idx });
    if (!ok(r)) { if (timer) timer.stop(); _ppSetStatus(idx, 'failed', '✕ failed'); return; }
    _ppDeckDraft = r.deck;
    if (deck.__template) _ppDeckDraft.__template = deck.__template;
    if (timer) timer.stop();
    _ppSetStatus(idx, 'done', `✓ ${timer ? timer.elapsed() : '?'}s`);
    toast(`Slide ${idx+1} translated to ${lang}.`);
    ppShowPreview(_ppDeckDraft);
    _ppSetStatus(idx, 'done', '✓ translated');
  } catch (e) {
    if (timer) timer.stop();
    _ppSetStatus(idx, 'failed', '✕ failed');
    toast('Translate failed: ' + (e.message || e), 'error');
  }
}
function ppCollectDeck() {
  const slides = [...document.querySelectorAll('#pp-slides .pp-slide')].map(el => {
    const slide = {
      type:       (el.querySelector('.pp-type')||{}).value || 'bullets',
      heading:    (el.querySelector('.pp-h')||{}).value || '',
      subheading: (el.querySelector('.pp-sub')||{}).value || '',
      bullets:    ((el.querySelector('.pp-bullets')||{}).value || '').split('\n').map(s => s.trim()).filter(Boolean),
      notes:      (el.querySelector('.pp-notes')||{}).value || '',
      body:       (el.querySelector('.pp-body')||{}).value || '',
      imagePrompt:(el.querySelector('.pp-img')||{}).value || ''
    };
    // Round-trip embedded images + video (incl. their callouts, placement, size) so re-renders preserve everything
    try {
      const ij = (el.querySelector('.pp-imgs-json')||{}).value || '[]';
      const arr = JSON.parse(ij);
      if (Array.isArray(arr) && arr.length) slide.images = arr;
    } catch {}
    const vu = ((el.querySelector('.pp-video-url')||{}).value || '').trim();
    if (vu) slide.video = { url: vu };
    // Round-trip translation if the block is rendered for this slide
    const tBlock = el.querySelector('.pp-trans-block');
    if (tBlock) {
      const tagTxt = (tBlock.querySelector('.pp-trans-tag')||{}).textContent || '';
      const lang = tagTxt.replace(/^[^\w]+/, '').trim() || (_ppDeckDraft && _ppDeckDraft.translation && _ppDeckDraft.translation.lang) || '';
      slide.translation = {
        lang,
        heading:    (tBlock.querySelector('.pp-th')||{}).value || '',
        subheading: (tBlock.querySelector('.pp-tsub')||{}).value || '',
        bullets:    ((tBlock.querySelector('.pp-tbullets')||{}).value || '').split('\n').map(s => s.trim()).filter(Boolean)
      };
    }
    return slide;
  });
  const out = {
    title:    val('pp-d-title') || (_ppDeckDraft && _ppDeckDraft.title) || 'Training Deck',
    subtitle: val('pp-d-sub') || '',
    presenter:val('pp-d-presenter') || '',
    slides
  };
  // Preserve deck-level translation metadata if present
  if (_ppDeckDraft && _ppDeckDraft.translation) out.translation = _ppDeckDraft.translation;
  return out;
}
// View-mode toggle — flip between the editor (forms) and the visual preview (slide thumbnails)
function ppSetViewMode(mode) {
  const host = document.getElementById('pp-slides');
  if (!host) return;
  document.getElementById('pp-view-edit')?.classList.toggle('active', mode === 'edit');
  document.getElementById('pp-view-preview')?.classList.toggle('active', mode === 'preview');
  if (mode === 'preview') {
    // Capture any in-flight edits, then render the visual preview
    const deck = ppCollectDeck();
    _ppDeckDraft = deck;
    const themeKey = (document.getElementById('pp-preview-theme')||{}).value || (_ppDeckDraft && _ppDeckDraft.__theme) || 'modern-navy';
    host.dataset.mode = 'preview';
    host.classList.add('pp-preview-mode');
    host.innerHTML = `<div class="pp-thumbs-grid pp-theme-${esc(themeKey)}">` +
      (deck.slides || []).map((s, i) => ppRenderSlideThumb(s, i, deck, themeKey)).join('') +
      `</div>`;
  } else {
    // Re-render the editor — ppShowPreview is the canonical edit-mode renderer
    if (_ppDeckDraft) ppShowPreview(_ppDeckDraft);
  }
}

// Visual slide thumbnail — mirrors the backend pptx layout per slide type, using theme colours + master chrome
function ppRenderSlideThumb(s, i, deck, themeKey) {
  s = s || {};
  const type = (s.type || 'bullets').toLowerCase();
  const heading = s.heading || '';
  const subheading = s.subheading || '';
  const bullets = Array.isArray(s.bullets) ? s.bullets.filter(Boolean) : [];
  const body = s.body || '';
  const tr = s.translation || null;
  const tHeading = tr && tr.heading ? tr.heading : '';
  const tBullets = tr && Array.isArray(tr.bullets) ? tr.bullets.filter(Boolean) : [];
  const images = Array.isArray(s.images) ? s.images.filter(im => im && im.data) : [];
  const video = (s.video && s.video.url) ? s.video : null;
  // Master chrome — logo top-left, company name + slide number footer
  const coName = (cache.company && cache.company.name) ? cache.company.name : '';
  const coLogo = (cache.company && cache.company.logo) ? cache.company.logo : '';
  const chrome = `
    <div class="ppt-accent"></div>
    ${coLogo ? `<img class="ppt-logo" src="${esc(coLogo)}" alt="">` : ''}
    <div class="ppt-foot-co">${esc(coName)}</div>
    <div class="ppt-foot-num">Slide ${i+1}</div>`;
  // Slide body — per type
  let inner = '';
  if (type === 'title') {
    inner = `<div class="ppt-title-bg"></div>
      <div class="ppt-title-content">
        <div class="ppt-title-h">${esc(heading || deck.title || 'Training Deck')}</div>
        <div class="ppt-title-rule"></div>
        <div class="ppt-title-sub">${esc(subheading || deck.subtitle || '')}</div>
        ${deck.presenter ? `<div class="ppt-title-presenter">Presented by: ${esc(deck.presenter)}</div>` : ''}
      </div>`;
  } else if (type === 'section') {
    inner = `<div class="ppt-section-bg"></div>
      <div class="ppt-section-content">
        <div class="ppt-section-h">${esc(heading)}</div>
        <div class="ppt-section-rule"></div>
        ${subheading ? `<div class="ppt-section-sub">${esc(subheading)}</div>` : ''}
      </div>`;
  } else if (type === 'qa') {
    inner = `<div class="ppt-qa-bg"></div>
      <div class="ppt-qa-content">
        <div class="ppt-qa-h">${esc(heading || 'Questions?')}</div>
        <div class="ppt-qa-rule"></div>
        <div class="ppt-qa-sub">${esc(subheading || body || 'Thank you for your attention.')}</div>
      </div>`;
  } else if (type === 'two-column') {
    const left = Array.isArray(s.leftBullets) ? s.leftBullets.filter(Boolean) : bullets.slice(0, Math.ceil(bullets.length/2));
    const right = Array.isArray(s.rightBullets) ? s.rightBullets.filter(Boolean) : bullets.slice(Math.ceil(bullets.length/2));
    inner = `<div class="ppt-h">${esc(heading)}</div>
      <div class="ppt-rule"></div>
      <div class="ppt-two-col">
        <ul class="ppt-bullets">${left.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
        <ul class="ppt-bullets">${right.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>`;
  } else if (type === 'quote') {
    inner = `<div class="ppt-quote">"${esc(body || heading)}"</div>
      ${subheading ? `<div class="ppt-quote-sub">— ${esc(subheading)}</div>` : ''}`;
  } else if (type === 'image') {
    const firstImg = images[0];
    inner = `<div class="ppt-h">${esc(heading)}</div>
      <div class="ppt-rule"></div>
      <div class="ppt-image-area">${firstImg ? `<img src="${esc(firstImg.data)}" alt="">` : `<div class="ppt-image-ph">🖼 ${esc(s.imagePrompt || 'Image placeholder')}</div>`}</div>`;
  } else {
    // bullets / content / default
    const mediaSide = (images.length || video) ? true : false;
    const bulletsHtml = bullets.length
      ? `<ul class="ppt-bullets">${bullets.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`
      : (body ? `<div class="ppt-body">${esc(body).replace(/\n/g, '<br>')}</div>` : '');
    const tBulletsHtml = tBullets.length
      ? `<ul class="ppt-bullets ppt-bullets-trans">${tBullets.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '';
    const imageHtml = images.length
      ? `<div class="ppt-media-col">${images.map(im => `<img src="${esc(im.data)}" alt="">`).join('')}${video ? `<div class="ppt-video-chip">🎬 ${esc((video.url||'').slice(0, 40))}</div>` : ''}</div>`
      : (video ? `<div class="ppt-media-col"><div class="ppt-video-chip">🎬 ${esc((video.url||'').slice(0, 40))}</div></div>` : '');
    inner = `<div class="ppt-h">${esc(heading)}</div>
      ${tHeading ? `<div class="ppt-h-trans">${esc(tHeading)}</div>` : ''}
      <div class="ppt-rule"></div>
      ${subheading ? `<div class="ppt-sub">${esc(subheading)}</div>` : ''}
      <div class="ppt-content ${mediaSide ? 'ppt-content-media' : ''} ${tBulletsHtml ? 'ppt-content-trans' : ''}">
        <div class="ppt-bullets-col">${bulletsHtml}${tBulletsHtml}</div>
        ${imageHtml}
      </div>`;
  }
  // Outer wrapper — 16:9 aspect ratio, click to enlarge
  return `<div class="ppt-thumb-wrap"><div class="ppt-thumb ppt-thumb-${type}" data-i="${i}" onclick="ppEnlargeSlide(${i})" title="Click to enlarge">
    ${chrome}
    <div class="ppt-slide-body">${inner}</div>
  </div><div class="ppt-thumb-label">Slide ${i+1} — ${esc(type)}</div></div>`;
}

// Click a thumbnail → full-screen single-slide preview
function ppEnlargeSlide(i) {
  if (!_ppDeckDraft) return;
  const themeKey = (document.getElementById('pp-preview-theme')||{}).value || _ppDeckDraft.__theme || 'modern-navy';
  document.getElementById('pp-enlarge-overlay')?.remove();
  const el = document.createElement('div');
  el.id = 'pp-enlarge-overlay';
  el.className = 'pp-enlarge-overlay';
  const total = (_ppDeckDraft.slides || []).length;
  const renderOne = (idx) => `<div class="pp-enlarge-stage">
    <div class="pp-thumbs-grid pp-theme-${esc(themeKey)} pp-enlarge-grid">
      ${ppRenderSlideThumb(_ppDeckDraft.slides[idx], idx, _ppDeckDraft, themeKey)}
    </div>
    <div class="pp-enlarge-bar">
      <button class="btn btn-outline btn-sm" onclick="ppEnlargeMove(-1)" ${idx===0?'disabled':''}>‹ Prev</button>
      <span class="pp-enlarge-count">Slide <strong>${idx+1}</strong> of ${total}</span>
      <button class="btn btn-outline btn-sm" onclick="ppEnlargeMove(1)" ${idx>=total-1?'disabled':''}>Next ›</button>
      <button class="btn btn-outline btn-sm" style="margin-left:12px" onclick="document.getElementById('pp-enlarge-overlay').remove()">✕ Close</button>
    </div>
  </div>`;
  el.dataset.idx = String(i);
  el.innerHTML = renderOne(i);
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el) el.remove(); });
  // Arrow-key navigation
  const onKey = ev => {
    if (!document.getElementById('pp-enlarge-overlay')) { document.removeEventListener('keydown', onKey); return; }
    if (ev.key === 'ArrowLeft') ppEnlargeMove(-1);
    else if (ev.key === 'ArrowRight') ppEnlargeMove(1);
    else if (ev.key === 'Escape') document.getElementById('pp-enlarge-overlay')?.remove();
  };
  document.addEventListener('keydown', onKey);
}
function ppEnlargeMove(d) {
  const el = document.getElementById('pp-enlarge-overlay');
  if (!el) return;
  const total = (_ppDeckDraft && _ppDeckDraft.slides || []).length;
  let idx = parseInt(el.dataset.idx, 10) + d;
  if (idx < 0) idx = 0; if (idx >= total) idx = total - 1;
  el.dataset.idx = String(idx);
  const themeKey = (document.getElementById('pp-preview-theme')||{}).value || _ppDeckDraft.__theme || 'modern-navy';
  el.innerHTML = `<div class="pp-enlarge-stage">
    <div class="pp-thumbs-grid pp-theme-${esc(themeKey)} pp-enlarge-grid">
      ${ppRenderSlideThumb(_ppDeckDraft.slides[idx], idx, _ppDeckDraft, themeKey)}
    </div>
    <div class="pp-enlarge-bar">
      <button class="btn btn-outline btn-sm" onclick="ppEnlargeMove(-1)" ${idx===0?'disabled':''}>‹ Prev</button>
      <span class="pp-enlarge-count">Slide <strong>${idx+1}</strong> of ${total}</span>
      <button class="btn btn-outline btn-sm" onclick="ppEnlargeMove(1)" ${idx>=total-1?'disabled':''}>Next ›</button>
      <button class="btn btn-outline btn-sm" style="margin-left:12px" onclick="document.getElementById('pp-enlarge-overlay').remove()">✕ Close</button>
    </div>
  </div>`;
}

function ppAddSlide() {
  if (!_ppDeckDraft) return;
  _ppDeckDraft = ppCollectDeck();
  _ppDeckDraft.slides.push({ type: 'bullets', heading: 'New slide', subheading: '', bullets: ['Point 1','Point 2','Point 3'], notes: '' });
  ppShowPreview(_ppDeckDraft);
}

// Add one or more images to slide i — read as base64, embed in deck JSON
async function ppAddImage(i, input) {
  const files = [...(input.files || [])];
  if (!files.length) return;
  const MAX_BYTES = 5 * 1024 * 1024;
  const oversize = files.filter(f => f.size > MAX_BYTES).map(f => f.name);
  const valid = files.filter(f => f.size <= MAX_BYTES);
  if (oversize.length) toast(`Skipped (>5 MB): ${oversize.join(', ')}`, 'error');
  if (!valid.length) { input.value = ''; return; }
  // Pull current deck state first so we don't lose other edits
  _ppDeckDraft = ppCollectDeck();
  const slide = _ppDeckDraft.slides[i]; if (!slide) return;
  slide.images = Array.isArray(slide.images) ? slide.images : [];
  for (const f of valid) {
    const data = await new Promise(res => { const r = new FileReader(); r.onload = e => res(e.target.result); r.readAsDataURL(f); });
    // Default placement = "right" (paired with bullets) when slide has text, else "full" so the image fills the slide
    const defaultPlace = (slide.bullets && slide.bullets.length) || (slide.body && slide.body.trim()) ? 'right' : 'full';
    slide.images.push({ data, name: f.name, size: f.size, placement: defaultPlace });
  }
  ppShowPreview(_ppDeckDraft);
  toast(`Added ${valid.length} image(s) to slide ${i+1}. Use the placement dropdown on each thumbnail to position.`);
  input.value = '';
}

function ppRemoveImage(i, k) {
  _ppDeckDraft = ppCollectDeck();
  const slide = _ppDeckDraft.slides[i]; if (!slide || !Array.isArray(slide.images)) return;
  slide.images.splice(k, 1);
  ppShowPreview(_ppDeckDraft);
}

// Per-image / per-video placement controls — round-tripped into the deck JSON and read by the .pptx builder
function ppSetImagePlacement(i, k, placement) {
  _ppDeckDraft = ppCollectDeck();
  const slide = _ppDeckDraft.slides[i]; if (!slide || !Array.isArray(slide.images) || !slide.images[k]) return;
  slide.images[k].placement = placement || 'right';
  // No re-render needed — the hidden JSON store is rebuilt from DOM by ppCollectDeck on every action
}
function ppSetVideoPlacement(i, placement) {
  _ppDeckDraft = ppCollectDeck();
  const slide = _ppDeckDraft.slides[i]; if (!slide || !slide.video) return;
  slide.video.placement = placement || 'bottom';
}
function ppSetImageSize(i, k, size) {
  _ppDeckDraft = ppCollectDeck();
  const slide = _ppDeckDraft.slides[i]; if (!slide || !Array.isArray(slide.images) || !slide.images[k]) return;
  slide.images[k].size = size || 'large';
}
function ppSetVideoSize(i, size) {
  _ppDeckDraft = ppCollectDeck();
  const slide = _ppDeckDraft.slides[i]; if (!slide || !slide.video) return;
  slide.video.size = size || 'large';
}

// ── Image callout editor — click points on the image to label them ──────────
// Each callout has { label, dotXf, dotYf } where dotXf/Yf are 0..1 fractions of the image.
// The .pptx builder turns each into: rounded label box + connecting line + red dot at the marker.
function ppOpenCalloutEditor(i, k) {
  _ppDeckDraft = ppCollectDeck();
  const slide = _ppDeckDraft.slides[i]; if (!slide) return;
  const img = (slide.images || [])[k]; if (!img) return;
  img.callouts = Array.isArray(img.callouts) ? img.callouts.slice() : [];
  document.getElementById('pp-callout-dialog')?.remove();
  const el = document.createElement('div');
  el.id = 'pp-callout-dialog';
  el.className = 'pp-modal-overlay';
  el.dataset.slide = String(i);
  el.dataset.image = String(k);
  el.innerHTML = `<div class="pp-modal" style="width:1100px;max-width:96vw">
    <div class="pp-modal-head">
      <div class="pp-head-row">
        <h3>🎯 Annotate Image — click anywhere on the image to add a labelled callout</h3>
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('pp-callout-dialog').remove()">✕ Close</button>
      </div>
      <p class="cell-sub" style="margin:6px 0 0;font-size:12px">Each click places a red dot at that point on the image, then prompts for the label text. The .pptx will render the dot, a line, and a rounded label box around the image (like the CAT 745C reference image).</p>
    </div>
    <div class="pp-callout-body">
      <div class="pp-callout-stage" id="pp-callout-stage">
        <img id="pp-callout-img" src="${esc(img.data)}" alt="" draggable="false">
        <div class="pp-callout-overlay" id="pp-callout-overlay"></div>
      </div>
      <div class="pp-callout-side">
        <div class="pp-callout-hdr">Placed callouts (<span id="pp-callout-count">0</span>)</div>
        <ol id="pp-callout-list" class="pp-callout-list"></ol>
        <p class="cell-sub" style="font-size:11px;margin-top:8px"><b>Tip:</b> Click anywhere on the image. The dialog will ask you to type the label. Use the 🗑 next to a placed callout to remove it.</p>
      </div>
    </div>
    <div class="pp-modal-foot">
      <button class="btn btn-outline" onclick="ppCalloutClearAll()">Clear all callouts</button>
      <button class="btn btn-accent" onclick="ppCalloutSave()">💾 Save callouts</button>
    </div>
  </div>`;
  document.body.appendChild(el);
  // Wire click handler — convert click coord to fraction of image bounding box
  const stage = document.getElementById('pp-callout-stage');
  const overlay = document.getElementById('pp-callout-overlay');
  const imgEl = document.getElementById('pp-callout-img');
  stage.addEventListener('click', ev => {
    if (ev.target.classList.contains('pp-callout-dot') || ev.target.classList.contains('pp-callout-label')) return;
    const rect = imgEl.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    const dotXf = Math.max(0, Math.min(1, x / rect.width));
    const dotYf = Math.max(0, Math.min(1, y / rect.height));
    const label = (prompt('Label for this point on the image (e.g. "Dump Body", "Radiator", "Exhaust Stack"):') || '').trim();
    if (!label) return;
    img.callouts.push({ label, dotXf, dotYf });
    ppCalloutRender(i, k);
  });
  ppCalloutRender(i, k);
}

function ppCalloutRender(i, k) {
  const slide = _ppDeckDraft.slides[i]; if (!slide) return;
  const img = (slide.images || [])[k]; if (!img) return;
  const callouts = Array.isArray(img.callouts) ? img.callouts : [];
  const overlay = document.getElementById('pp-callout-overlay'); if (!overlay) return;
  // Draw dots + connection lines via SVG overlay
  overlay.innerHTML = callouts.map((c, idx) => `
    <div class="pp-callout-dot" style="left:${(c.dotXf*100).toFixed(2)}%;top:${(c.dotYf*100).toFixed(2)}%;" data-idx="${idx}" title="${esc(c.label)}">${idx+1}</div>
  `).join('');
  // List on the right side
  const list = document.getElementById('pp-callout-list');
  if (list) list.innerHTML = callouts.map((c, idx) => `
    <li class="pp-callout-item"><span class="pp-callout-num">${idx+1}</span><span class="pp-callout-text">${esc(c.label)}</span><button type="button" class="pp-callout-del" onclick="ppCalloutRemove(${i},${k},${idx})" title="Remove">🗑</button></li>
  `).join('');
  const ct = document.getElementById('pp-callout-count');
  if (ct) ct.textContent = String(callouts.length);
}

function ppCalloutRemove(i, k, idx) {
  const slide = _ppDeckDraft.slides[i]; if (!slide) return;
  const img = (slide.images || [])[k]; if (!img || !Array.isArray(img.callouts)) return;
  img.callouts.splice(idx, 1);
  ppCalloutRender(i, k);
}
function ppCalloutClearAll() {
  const dlg = document.getElementById('pp-callout-dialog'); if (!dlg) return;
  if (!confirm('Remove all callouts on this image?')) return;
  const i = parseInt(dlg.dataset.slide, 10), k = parseInt(dlg.dataset.image, 10);
  const slide = _ppDeckDraft.slides[i]; if (!slide) return;
  const img = (slide.images || [])[k]; if (!img) return;
  img.callouts = [];
  ppCalloutRender(i, k);
}
function ppCalloutSave() {
  // _ppDeckDraft already mutated in-place; close + re-render the editor so the thumbnail's count updates
  document.getElementById('pp-callout-dialog')?.remove();
  ppShowPreview(_ppDeckDraft);
  toast('Callouts saved on the image. They will be drawn into the .pptx when you Save & Download.');
}

function ppPromptVideo(i) {
  _ppDeckDraft = ppCollectDeck();
  const slide = _ppDeckDraft.slides[i]; if (!slide) return;
  const current = (slide.video && slide.video.url) || '';
  const url = (prompt('Paste a YouTube / Vimeo URL, or a direct video URL (.mp4 / .webm):', current) || '').trim();
  if (url === '') {
    slide.video = null;
  } else {
    const prevPlace = (slide.video && slide.video.placement) || ((slide.bullets && slide.bullets.length) ? 'bottom' : 'full');
    slide.video = { url, placement: prevPlace };
  }
  ppShowPreview(_ppDeckDraft);
  toast(url ? `Video set on slide ${i+1}. Use the placement dropdown on the chip to position.` : `Video removed from slide ${i+1}.`);
}

function ppRemoveVideo(i) {
  _ppDeckDraft = ppCollectDeck();
  const slide = _ppDeckDraft.slides[i]; if (!slide) return;
  slide.video = null;
  ppShowPreview(_ppDeckDraft);
}
function ppRemoveSlide(i) {
  if (!_ppDeckDraft || !confirm('Remove this slide?')) return;
  _ppDeckDraft = ppCollectDeck();
  _ppDeckDraft.slides.splice(i, 1);
  ppShowPreview(_ppDeckDraft);
}

// Move a slide up (delta -1) or down (delta +1) in the deck, keeping all its content/images.
function ppMoveSlide(i, delta) {
  _ppDeckDraft = ppCollectDeck();
  const slides = _ppDeckDraft.slides || [];
  const j = i + delta;
  if (j < 0 || j >= slides.length) return;   // already at the top / bottom
  const [s] = slides.splice(i, 1);
  slides.splice(j, 0, s);
  ppShowPreview(_ppDeckDraft);
  // Scroll the moved slide back into view after the re-render.
  setTimeout(() => { const el = document.querySelector(`.pp-slide[data-i="${j}"]`); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 60);
}

// Move a slide to a specific position (1-based) chosen by the user.
function ppMoveSlideTo(i) {
  _ppDeckDraft = ppCollectDeck();
  const slides = _ppDeckDraft.slides || [];
  const pos = prompt(`Move slide ${i + 1} to which position? (1–${slides.length})`, String(i + 1));
  if (pos === null) return;
  let j = parseInt(pos, 10);
  if (!Number.isFinite(j)) { toast('Enter a slide number.', 'error'); return; }
  j = Math.max(1, Math.min(slides.length, j)) - 1;
  if (j === i) return;
  const [s] = slides.splice(i, 1);
  slides.splice(j, 0, s);
  ppShowPreview(_ppDeckDraft);
  setTimeout(() => { const el = document.querySelector(`.pp-slide[data-i="${j}"]`); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 60);
}
// ── Save-time duplicate-name guard (shared by every save flow) ────────────────────────────────────────
// Behaviour: if an item with the same name already exists, ask the user; OK replaces it (the caller saves
// the new one, then deletes the returned dupes), Cancel aborts the save so they can rename.
function confirmOverwrite(name, dupes, label) {
  if (!dupes || !dupes.length) return true;
  return confirm(`A ${label} named “${name}” already exists.\n\nOverwrite it?\n\nOK = replace the existing one.\nCancel = stop (rename to keep both).`);
}
const _normName = s => String(s == null ? '' : s).toLowerCase().replace(/\.(docx|pptx|xlsx|pdf|doc|ppt|txt|csv)$/i, '').trim();
// tblFiles-based dupes (PowerPoint decks, Content Studio documents, template forms, covers) via the server.
async function fileDupes(name, folder) {
  try { const r = await GET(`/api/files/name-check?name=${encodeURIComponent(name || '')}&folder=${encodeURIComponent(folder || '')}`); return (r && r.dupes) || []; }
  catch { return []; }
}
async function deleteFileDupes(dupes, exceptId) {
  for (const d of (dupes || [])) { if (exceptId != null && d.FileID === exceptId) continue; try { await DEL('/api/files/' + d.FileID); } catch {} }
}

async function ppDownload(save) {
  const rawDeck = ppCollectDeck();
  if (!rawDeck.slides.length) { toast('No slides to build.', 'error'); return; }
  // Expand into duplicated / filtered slides per the language filter (English slide + translated copy, etc.).
  const deck = ppExpandDeck(rawDeck, _ppLangFilter);
  const tpl = _ppDeckDraft && _ppDeckDraft.__template;
  // Theme — preview's dropdown wins, else whatever was used at develop time, else default
  const themePicker = document.getElementById('pp-preview-theme');
  const theme = (themePicker && themePicker.value) || (_ppDeckDraft && _ppDeckDraft.__theme) || 'modern-navy';
  // Save destination — defaults to the PowerPoint library
  const destSel = document.getElementById('pp-preview-dest');
  const destination = (destSel && destSel.value) || 'powerpoints';
  let materialCategory = '';
  if (destination === 'training-material') {
    materialCategory = (val('pp-dest-cat') || '').trim();
    if (!materialCategory) { toast('Pick or add a Training Material category.', 'error'); return; }
  }
  if (save) {
    // Replace-on-duplicate: if a deck with this name already lives in the chosen destination, confirm first.
    const dupes = await fileDupes(deck.title, destination);
    if (!confirmOverwrite(deck.title, dupes, 'PowerPoint deck')) return;
    const r = await POST('/api/powerpoints/build', { deck, template: tpl, theme, destination, materialCategory, save: true, transLayout: _ppTransLayout, transSideOrder: _ppTransSideOrder });
    if (!ok(r)) return;
    if (dupes.length) await deleteFileDupes(dupes, r.fileId); // remove the old same-named deck(s)
    toast(`Saved "${r.fileName}" (${r.slideCount} slides, ${(r.size/1024).toFixed(1)} KB) to ${r.destLabel || 'the library'}.`);
    document.getElementById('pp-preview-dialog')?.remove();
    // Reload the right list AND offer a quick jump to the destination
    if (destination === 'powerpoints')        loadPowerpoints();
    else if (destination === 'library')       { /* user can navigate to Document Library themselves */ }
    else if (destination === 'training-standards') { /* user can navigate to Training Standards themselves */ }
    else if (destination === 'training-material')  { /* user can navigate to Training Material themselves */ }
    setTimeout(() => { window.location.href = '/api/files/download/' + r.fileId; }, 200);
  } else {
    try {
      const resp = await fetch('/api/powerpoints/build', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deck, template: tpl, theme, save: false, transLayout: _ppTransLayout, transSideOrder: _ppTransSideOrder })
      });
      if (!resp.ok) { const j = await resp.json().catch(() => ({})); toast(j.error || 'Build failed.', 'error'); return; }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = (deck.title || 'Training Deck') + '.pptx';
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
      toast('PowerPoint downloaded.');
    } catch (e) { toast('Build failed: ' + (e.message || 'network error'), 'error'); }
  }
}

// ---- Template Forms ----
// Reusable blank forms (DOCX/PDF/XLSX/CSV) that the team downloads, fills in, and submits.
let _tfCache = [];
async function loadTemplateForms() {
  const data = await GET('/api/content/template-forms');
  _tfCache = Array.isArray(data) ? data : [];
  // Populate every category filter on the page (the standalone page and the embedded Form Builder switcher)
  const cats = [...new Set(_tfCache.map(t => t.Category || 'General'))].sort();
  const opts = '<option value="">All categories</option>' + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  document.querySelectorAll('.tf-cat-filter').forEach(sel => {
    const keep = sel.value;
    sel.innerHTML = opts;
    if (keep) sel.value = keep;
  });
  renderTemplateForms();
}
function renderTemplateForms() {
  // Read search/filter from the first visible (or first present) instance — both copies stay in sync via input events
  const searches = [...document.querySelectorAll('.tf-search')];
  const cats     = [...document.querySelectorAll('.tf-cat-filter')];
  const active   = searches.find(s => s.offsetParent !== null) || searches[0];
  const activeCat = cats.find(s => s.offsetParent !== null) || cats[0];
  const q   = ((active && active.value) || '').toLowerCase().trim();
  const cat = (activeCat && activeCat.value) || '';
  const rows = _tfCache.filter(t => {
    if (cat && (t.Category || 'General') !== cat) return false;
    if (q) {
      const blob = (t.FileName + ' ' + (t.Category || '') + ' ' + (t.Description || '')).toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
  const fmtBytes = n => {
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  };
  const ext = name => ((name || '').match(/\.([a-z0-9]+)$/i) || [, ''])[1].toUpperCase();
  const html = rows.length ? rows.map(t => `
    <tr>
      <td class="cell-strong">${esc(t.FileName)}</td>
      <td>${esc(t.Category || 'General')}</td>
      <td><span class="badge badge-plain">${esc(ext(t.FileName) || 'FILE')}</span></td>
      <td>${fmtBytes(t.FileSize)}</td>
      <td>${esc((t.UploadedDate || '').slice(0,10))} <span class="cell-sub">${esc(t.UploadedBy || '')}</span></td>
      <td class="actions">
        <a class="btn btn-accent btn-sm" href="/api/files/download/${t.FileID}">⬇ Download</a>
        ${/\.docx$/i.test(t.FileName || '') ? `<button class="btn btn-accent btn-sm" onclick="editTemplateFormInStudio(${t.FileID})" title="Edit with AI, translation and branding in Content Studio — reproduces the document layout">✏️ Edit in Studio</button>` : ''}
        ${/\.docx$/i.test(t.FileName || '') ? `<button class="btn btn-primary btn-sm" onclick="useTemplateFormAsForm(${t.FileID})" title="Turn this document into an editable online form">🧩 Use as online form</button>` : ''}
        ${(currentUser && currentUser.admin) ? `<button class="btn btn-danger btn-sm btn-icon" onclick="deleteTemplateForm(${t.FileID})" title="Delete template">🗑</button>` : ''}
      </td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No template forms ${q || cat ? 'match your filter' : 'uploaded yet'}.${(currentUser && currentUser.admin && !_tfCache.length) ? ' Click <strong>⬆ Upload Template</strong> to add the first one.' : ''}</td></tr>`;
  document.querySelectorAll('.tf-tbody').forEach(host => { host.innerHTML = html; });
}
function filterTemplateForms() {
  // Keep both copies of search/filter in sync, then re-render once
  const searches = [...document.querySelectorAll('.tf-search')];
  const cats = [...document.querySelectorAll('.tf-cat-filter')];
  const evSearch = searches.find(s => document.activeElement === s);
  const evCat    = cats.find(s => document.activeElement === s);
  if (evSearch) searches.forEach(s => { if (s !== evSearch) s.value = evSearch.value; });
  if (evCat)    cats.forEach(s => { if (s !== evCat) s.value = evCat.value; });
  renderTemplateForms();
}

// Form Builder: upload a document → AI generates a new TAR-style form using MPR0003 as the master layout.
// Field types, order, options, signatures, instructions and registers stay byte-identical to MPR0003;
// only variable content (unit code, grid cells, criteria) is replaced based on the uploaded document.
async function fbFromMasterRun(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!confirm(`Generate a new Competency Assessment Record using the MPR0003 master layout, populated from "${file.name}"?\n\nThe new form will appear in the list below and can be edited.`)) {
    input.value = ''; return;
  }
  document.getElementById('fb-master-progress')?.remove();
  const ov = document.createElement('div');
  ov.id = 'fb-master-progress';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
  ov.innerHTML = `<div style="background:#fff;padding:22px 28px;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.18);text-align:center;min-width:320px">
    <div style="font-size:32px;margin-bottom:8px">🤖</div>
    <strong style="font-size:14px">Cloning MPR0003 master template…</strong>
    <div style="font-size:12px;color:#64748b;margin-top:8px">AI is extracting unit-of-competency content from<br><strong>${esc(file.name)}</strong><br>and filling in the master layout.<br>This typically takes 30–90 seconds.</div>
  </div>`;
  document.body.appendChild(ov);
  const fd = new FormData();
  fd.append('file', file);
  try {
    const resp = await fetch('/api/forms/from-master', { method: 'POST', body: fd, credentials: 'include' });
    const r = await resp.json().catch(() => ({ error: 'Server returned non-JSON.' }));
    if (!resp.ok) { toast(r.error || ('Generation failed (HTTP ' + resp.status + ')'), 'error'); return; }
    toast(`✅ Created "${esc(r.Name)}" — ${r.fieldCount} fields, ${r.slotsFilled} AI-filled slots.`);
    // Reload the Field Assessment Forms list and switch the view to it if needed
    fbSwitchMode('assess');
    if (typeof loadForms === 'function') loadForms();
    // Open the new template for review
    setTimeout(() => { if (typeof editForm === 'function' && r.TemplateID) editForm(r.TemplateID); }, 300);
  } catch (e) {
    toast('Generation failed: ' + (e && e.message ? e.message : 'network error'), 'error');
  } finally {
    ov.remove();
    input.value = '';
  }
}

// Form Builder mode switcher — toggles between Field Assessment Forms and Template Forms
function fbSwitchMode(mode) {
  const assess    = document.getElementById('fb-mode-assess');
  const templates = document.getElementById('fb-mode-templates');
  const newBtn    = document.getElementById('fb-new-btn');
  const uploadBtn = document.getElementById('fb-upload-btn');
  const title     = document.getElementById('fb-page-title');
  if (!assess || !templates) return;
  if (mode === 'templates') {
    assess.classList.add('hidden');
    templates.classList.remove('hidden');
    newBtn?.classList.add('hidden');
    if (currentUser && currentUser.admin) uploadBtn?.classList.remove('hidden');
    if (title) title.textContent = '📋 Template Forms';
    loadTemplateForms();
  } else {
    templates.classList.add('hidden');
    assess.classList.remove('hidden');
    newBtn?.classList.remove('hidden');
    uploadBtn?.classList.add('hidden');
    if (title) title.textContent = '🧰 Assessment Form Builder';
  }
}
async function uploadTemplateForm(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  // Ask for a category — keeps the library organised
  const cat = (prompt(`Category for "${file.name}"? (e.g. HSE, Operations, HR, Maintenance)`, 'General') || '').trim() || 'General';
  const desc = prompt('Short description (optional)') || '';
  const fd = new FormData();
  fd.append('file', file);
  fd.append('category', cat);
  fd.append('description', desc);
  const btn = document.querySelector('#page-template-forms button.btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Uploading…'; }
  try {
    const resp = await fetch('/api/content/template-forms', { method: 'POST', body: fd, credentials: 'include' });
    const r = await resp.json().catch(() => ({ error: 'Server returned non-JSON.' }));
    if (!resp.ok) { toast(r.error || ('Upload failed (HTTP ' + resp.status + ')'), 'error'); return; }
    toast(`Template "${file.name}" uploaded to ${cat}.`);
    loadTemplateForms();
  } catch (e) {
    toast('Upload failed: ' + (e && e.message ? e.message : 'network error'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬆ Upload Template'; }
    input.value = '';
  }
}
async function deleteTemplateForm(id) {
  if (!confirm('Delete this template form? This cannot be undone.')) return;
  const r = await DEL('/api/content/template-forms/' + id);
  if (!ok(r)) return;
  toast('Template form deleted.');
  loadTemplateForms();
}

async function loadDocuments() {
  const params = new URLSearchParams({ entityType: val('doc-type'), search: val('doc-search') });
  const data = await GET('/api/files?' + params);
  if (!data) return;
  _docLibCache = {};
  data.forEach(f => { _docLibCache[f.FileID] = f; });
  const typeLabel = { staff:'Employee', cert:'Course', register:'Record', class:'Class', document:'Document' };
  document.getElementById('doc-tbody').innerHTML = data.length ? data.map(f => `
    <tr>
      <td><span class="file-ic">${fileIcon(f.FileName)}</span> <a href="/api/files/download/${f.FileID}?inline=1" target="_blank" class="file-name">${esc(f.FileName)}</a>${(f.EntityType==='document' && f.Status) ? ' '+csStatusBadge(f.Status) : ''}</td>
      <td>${esc((f.Category||'').replace(/ \(AI draft\)/i,''))}</td>
      <td>${typeLabel[f.EntityType]||f.EntityType}: <strong>${esc(f.EntityName||('#'+f.FileID))}</strong></td>
      <td>${fmtSize(f.FileSize)}</td>
      <td>${esc(f.UploadedBy||'')}</td>
      <td>${fmtDate((f.UploadedDate||'').split(' ')[0])}</td>
      <td class="actions">
        <a class="btn btn-outline btn-sm btn-icon" href="/api/files/download/${f.FileID}" title="Download">⬇</a>
        ${f.StructuredData ? `<button class="btn btn-outline btn-sm btn-icon" onclick="docLibPreview(${f.FileID})" title="Preview document">👁</button>` : ''}
        ${(currentUser.admin && f.StructuredData) ? `<button class="btn btn-outline btn-sm btn-icon" onclick="docLibEditContent(${f.FileID})" title="Edit content in AI Content Studio">📝</button>` : ''}
        ${currentUser.admin ? `<button class="btn btn-primary btn-sm btn-icon" onclick="openEditDoc(${f.FileID})" title="Edit file details">✏️</button>` : ''}
        ${currentUser.admin ? `<button class="btn btn-outline btn-sm btn-icon" onclick="moveDocLibFile(${f.FileID})" title="Move to another folder (Training Standards, Training Material, Template Forms)">📂</button>` : ''}
        <button class="btn btn-danger btn-sm btn-icon" onclick="deleteDocLibFile(${f.FileID})" title="Delete">🗑️</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty-state">No documents found</td></tr>';
}

// Document Library content preview / edit — works for any AI-generated doc (has StructuredData)
const DOC_CAT_TO_TYPE = {
  'Exam':'exam','Assessment Form':'form','Training Request Form':'training-request',
  'Course':'course','Training Plan':'training-plan','Induction Pack':'induction',
  'Training Manual':'training-manual','Training Handout':'training-handout','Training Deck':'training-deck',
  'SOP':'sop','Safe Work Procedure':'swp','Job Safety Analysis':'jsa','Safety Alert':'safety-alert',
  'Transfer to Training':'transfer-to-training','Return to Operations':'return-to-ops',
  'Training Standards Document':'training-standards','Policy':'policy','Standard':'standard',
  'Plan':'plan','Record Form':'record-form','Checklist':'checklist'
};
function docLibType(cat) { return DOC_CAT_TO_TYPE[(cat||'').replace(/ \(AI draft\)$/i,'').trim()] || 'sop'; }

function docLibPreview(id) {
  const f = _docLibCache[id];
  if (!f || !f.StructuredData) { toast('No preview data for this document.', 'error'); return; }
  let data;
  try { data = JSON.parse(f.StructuredData); } catch { toast('Could not parse document data.', 'error'); return; }
  // Set csDraft so buildDocPreviewHtml / print honor the saved translation position
  csDraft = { type: docLibType(f.Category), data, tsFileId: id };
  document.getElementById('doc-preview-body').innerHTML = buildDocPreviewHtml(data);
  showModal('doc-preview-modal');
}

function docLibEditContent(id) {
  const f = _docLibCache[id];
  if (!f || !f.StructuredData) { toast('No editable data for this document.', 'error'); return; }
  let data;
  try { data = JSON.parse(f.StructuredData); } catch { toast('Could not parse document data.', 'error'); return; }
  csDraft = { type: docLibType(f.Category), data, tsFileId: id };
  navigateTo('content-studio'); // loadContentStudio renders csDraft and restores translation position
  toast(`Loaded "${(f.FileName||'').replace(/ \(AI draft\)\.docx$/i,'')}" for editing.`);
}

function openEditDoc(id) {
  const f = _docLibCache[id];
  if (!f) return;
  editingId.docLib = id;
  setVal('edit-doc-name', f.FileName || '');
  setVal('edit-doc-category', f.Category || '');
  setVal('edit-doc-desc', f.Description || '');
  document.getElementById('edit-doc-file-label').textContent = 'No replacement file chosen';
  const inp = document.getElementById('edit-doc-file');
  if (inp) inp.value = '';
  showModal('edit-doc-modal');
}

async function saveEditDoc() {
  const id = editingId.docLib;
  if (!id) return;
  const inp = document.getElementById('edit-doc-file');
  const file = inp && inp.files[0];
  let r;
  if (file) {
    const fd = new FormData();
    fd.append('fileName',    val('edit-doc-name'));
    fd.append('category',    val('edit-doc-category'));
    fd.append('description', val('edit-doc-desc'));
    fd.append('file', file);
    const res = await fetch(`/api/files/${id}`, { method: 'PUT', credentials: 'include', body: fd });
    r = await res.json();
  } else {
    r = await api('PUT', `/api/files/${id}`, {
      fileName:    val('edit-doc-name'),
      category:    val('edit-doc-category'),
      description: val('edit-doc-desc'),
    });
  }
  if (!ok(r)) return;
  closeModal('edit-doc-modal');
  toast('Document updated.');
  loadDocuments();
}
// Move a file in the Document Library to another folder (Training Standards / Training Material / Template Forms).
// Opens a small dialog with the destination picker; for training-material, also shows the category dropdown.
async function moveDocLibFile(id) {
  const f = _docLibCache[id];
  if (!f) { toast('File not found in cache — reload the page.', 'error'); return; }
  // Pre-load training-material categories for the dropdown
  let tmCats = [];
  try { tmCats = await GET('/api/content/trainmat-cats') || []; } catch {}
  document.getElementById('move-doc-dialog')?.remove();
  const el = document.createElement('div');
  el.id = 'move-doc-dialog';
  el.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
  const currentFolder = f.Folder || 'library';
  const opt = (v, label, badge) => `<option value="${v}"${currentFolder===v?' disabled':''}>${label}${currentFolder===v?' (current)':''}</option>`;
  el.innerHTML = `<div style="background:var(--bg,#fff);border-radius:10px;width:480px;max-width:92vw;box-shadow:0 8px 32px rgba(0,0,0,.18);overflow:hidden">
    <div style="padding:14px 18px;border-bottom:1px solid var(--border,#e5e7eb)">
      <h3 style="margin:0;font-size:15px;font-weight:700">📂 Move file</h3>
      <p style="margin:6px 0 0;font-size:12.5px;color:var(--text-soft)">${esc(f.FileName||'')}</p>
    </div>
    <div style="padding:14px 18px;display:grid;gap:10px">
      <label style="font-size:13px;font-weight:600">Move to
        <select id="move-doc-folder" style="width:100%;margin-top:4px" onchange="moveDocFolderChange()">
          ${opt('library','📎 Document Library')}
          ${opt('training-standards','📐 Training Standards')}
          ${opt('training-material','🗂️ Training Material')}
          ${opt('template-forms','📋 Template Forms')}
        </select>
      </label>
      <div id="move-doc-cat-wrap" style="display:none">
        <label style="font-size:13px;font-weight:600">Training Material category
          <select id="move-doc-cat" style="width:100%;margin-top:4px">
            <option value="">— pick or add new —</option>
            ${tmCats.map(c => `<option value="${esc(c.Name)}">${esc(c.Name)}</option>`).join('')}
            <option value="__NEW__">➕ Add new category…</option>
          </select>
        </label>
        <input id="move-doc-cat-new" placeholder="New category name (e.g. CAT789, Grader Training Material)" style="width:100%;margin-top:6px;display:none">
      </div>
      <div id="move-doc-tplcat-wrap" style="display:none">
        <label style="font-size:13px;font-weight:600">Template category <span class="cell-sub">(optional — leave blank to keep current)</span>
          <input id="move-doc-tplcat" placeholder="e.g. HSE, Operations, HR" style="width:100%;margin-top:4px">
        </label>
      </div>
      <p class="cell-sub" style="font-size:11px;margin:0">The file stays the same — only its folder changes. Existing previews / downloads keep working.</p>
    </div>
    <div style="display:flex;gap:10px;padding:12px 18px;border-top:1px solid var(--border,#e5e7eb);justify-content:flex-end">
      <button class="btn btn-outline" onclick="document.getElementById('move-doc-dialog').remove()">Cancel</button>
      <button class="btn btn-accent" id="move-doc-go" onclick="moveDocFileGo(${id})">📂 Move</button>
    </div>
  </div>`;
  document.body.appendChild(el);
  // Wire dynamic field visibility based on chosen folder
  setTimeout(moveDocFolderChange, 0);
  // Toggle new-category input visibility
  const sel = document.getElementById('move-doc-cat');
  if (sel) sel.addEventListener('change', () => {
    const input = document.getElementById('move-doc-cat-new');
    if (!input) return;
    input.style.display = sel.value === '__NEW__' ? '' : 'none';
    if (sel.value === '__NEW__') setTimeout(() => input.focus(), 0);
  });
}
function moveDocFolderChange() {
  const folder = (document.getElementById('move-doc-folder')||{}).value;
  const catWrap = document.getElementById('move-doc-cat-wrap');
  const tplWrap = document.getElementById('move-doc-tplcat-wrap');
  if (catWrap) catWrap.style.display = folder === 'training-material' ? '' : 'none';
  if (tplWrap) tplWrap.style.display = folder === 'template-forms' ? '' : 'none';
}
async function moveDocFileGo(id) {
  const folder = (document.getElementById('move-doc-folder')||{}).value;
  if (!folder) return toast('Pick a destination.', 'error');
  let materialCategory = '';
  if (folder === 'training-material') {
    const sel = (document.getElementById('move-doc-cat')||{}).value;
    materialCategory = (sel === '__NEW__') ? (val('move-doc-cat-new') || '').trim() : (sel || '').trim();
    if (!materialCategory) { toast('Pick or enter a Training Material category.', 'error'); return; }
  } else if (folder === 'template-forms') {
    materialCategory = (val('move-doc-tplcat') || '').trim();
  }
  const btn = document.getElementById('move-doc-go');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Moving…'; }
  try {
    const r = await PUT(`/api/files/${id}/move`, { folder, materialCategory });
    if (!ok(r)) return;
    document.getElementById('move-doc-dialog')?.remove();
    toast(r.message || 'File moved.');
    loadDocuments();
  } finally { if (btn) { btn.disabled = false; btn.textContent = '📂 Move'; } }
}

async function deleteDocLibFile(id) {
  if (!confirm('Delete this file?')) return;
  await DEL('/api/files/' + id);
  loadDocuments();
}

// ---- Modal helpers ----
function showModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
});

// ---- Tab helpers ----
function switchTab(tabId, el) {
  const modal = el ? el.closest('.modal') || el.closest('.page') : null;
  const scope = modal || document;
  scope.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
  scope.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const tc = document.getElementById(tabId);
  if (tc) tc.classList.remove('hidden');
  if (el) el.classList.add('active');
}

// ============================================================
// Assessment Form Builder + Field Assessment
// ============================================================
let fbFields = [];
let fbTransLang = '';        // target language for the form translation
let fbTransLayout = 'below'; // above | below | side — where translated label sits
let fbTransSideOrder = 'en-first'; // side layout only: en-first | lang-first (which language shows first)
let fbTransName = '';        // translated form name
let fbTransDescription = ''; // translated form description / instructions

function fbSetTransLayout(mode) {
  fbTransLayout = mode;
  document.getElementById('fb-tbl-above')?.classList.toggle('active', mode === 'above');
  document.getElementById('fb-tbl-below')?.classList.toggle('active', mode === 'below');
  document.getElementById('fb-tbl-side')?.classList.toggle('active', mode === 'side');
  // The English/Translation order toggle only applies to the Side layout (same as Content Studio).
  const ord = document.getElementById('fb-trans-order');
  if (ord) ord.style.display = (mode === 'side') ? 'inline-flex' : 'none';
  renderFbFields();
}

// Side layout only: choose whether English or the translation column comes first.
function fbSetTransSideOrder(order) {
  fbTransSideOrder = order;
  document.getElementById('fb-ord-en')?.classList.toggle('active', order === 'en-first');
  document.getElementById('fb-ord-lang')?.classList.toggle('active', order === 'lang-first');
  renderFbFields();
}

async function fbTranslateAll() {
  const lang = val('fb-trans-lang');
  if (!lang) { toast('Select a language first.', 'error'); return; }
  if (!fbFields.length) { toast('Add some fields first.', 'error'); return; }
  const btn = document.getElementById('fb-trans-all-btn');
  const total = fbFields.length;
  let done = 0;
  // Per-field hourglass status (same idea as Content Studio) — each field shows ⏳ while translating and ✅
  // when done, so progress is visible field-by-field instead of one opaque wait for the whole form.
  const setStat = (i, s) => { const el = document.getElementById('fb-tstat-' + i); if (el) { el.textContent = s; el.classList.toggle('busy', s === '⏳'); } };
  const label = () => { if (btn) btn.textContent = `⏳ Translating… ${done}/${total}`; };
  if (btn) btn.disabled = true;
  for (let i = 0; i < total; i++) setStat(i, '⏳');
  label();

  const formName = val('fb-Name'), formDesc = val('fb-Description');
  let gotHeader = false, transName = '', transDesc = '', glossaryTerms = 0;

  // Translate ONE field per request so each has its own status; the form name+description ride along with
  // the first field so they're translated once. Grids send all their cells in that single field's request.
  const translateOne = async (i) => {
    const includeHeader = (i === 0);
    const r = await POST('/api/forms/translate-fields', {
      fields: [fbFields[i]], targetLang: lang,
      name: includeHeader ? formName : '', description: includeHeader ? formDesc : ''
    });
    if (!r || r.error || !Array.isArray(r.items) || !r.items[0]) throw new Error((r && r.error) || 'no translation returned');
    const it = r.items[0];
    fbFields[i].Translation = {
      label: it.label || '', helpText: it.helpText || '',
      options: Array.isArray(it.options) ? it.options : [],
      grid: (it.grid && (Array.isArray(it.grid.columns) || Array.isArray(it.grid.rows))) ? it.grid : null
    };
    if (includeHeader) { transName = r.name || ''; transDesc = r.description || ''; glossaryTerms = r.glossaryTerms || 0; gotHeader = true; }
  };

  const attempt = async (i) => { setStat(i, '⏳'); try { await translateOne(i); setStat(i, '✅'); return true; } catch { setStat(i, '❌'); return false; } };
  // A small worker pool keeps a few translations in flight (like Content Studio) without hammering the
  // network — the corporate proxy resets connections under heavy parallelism.
  const CONC = 3;
  let next = 0; const failed = [];
  const worker = async () => { while (next < total) { const i = next++; if (!(await attempt(i))) failed.push(i); done++; label(); } };
  try {
    await Promise.all(Array.from({ length: Math.min(CONC, total) }, worker));
    // Retry any failures once — most are transient connection resets that succeed on a second try.
    if (failed.length) {
      const retry = failed.splice(0);
      await new Promise(r => setTimeout(r, 1200));
      for (const i of retry) { done--; if (!(await attempt(i))) failed.push(i); done++; label(); }
    }
    fbTransLang = lang;
    if (gotHeader) { fbTransName = transName; fbTransDescription = transDesc; }
    renderFbFields();
    renderFbFormHeaderTrans();
    if (failed.length) toast(`Translated ${total - failed.length}/${total} fields to ${lang}. ${failed.length} still failed (network) — click 🌐 Translate All again to retry those.`, 'error');
    else toast(`✅ Translated all ${total} fields${gotHeader ? ', name & description' : ''} and grid cells to ${lang}${glossaryTerms ? ` (applied ${glossaryTerms} glossary term(s))` : ''}. Review and Save.`);
  } catch (e) {
    toast('Translate failed: ' + ((e && e.message) || e), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🌐 Translate All'; }
  }
}

// Render the translated form Name / Description below the original inputs so the admin can see + edit them
function renderFbFormHeaderTrans() {
  let host = document.getElementById('fb-trans-header');
  if (!host) {
    const desc = document.getElementById('fb-Description');
    if (!desc) return;
    host = document.createElement('div');
    host.id = 'fb-trans-header';
    host.style.cssText = 'margin:8px 0;display:flex;flex-direction:column;gap:6px';
    desc.parentNode.insertAdjacentElement('afterend', host);
  }
  if (!fbTransLang || (!fbTransName && !fbTransDescription)) { host.innerHTML = ''; return; }
  host.innerHTML = `
    <div class="fb-trans" style="background:var(--surface-2);border-left:3px solid var(--primary);padding:8px 10px;border-radius:6px">
      <div style="font-size:11px;font-weight:700;color:var(--primary);margin-bottom:4px">🌐 ${esc(fbTransLang)} Translation — form name & description</div>
      <input class="fb-label" placeholder="Translated form name" value="${esc(fbTransName||'')}" oninput="fbTransName=this.value" style="margin-bottom:4px">
      <textarea class="fb-label" rows="2" placeholder="Translated description / instructions" oninput="fbTransDescription=this.value">${esc(fbTransDescription||'')}</textarea>
    </div>`;
}

async function loadForms() {
  const data = await GET('/api/forms/templates') || [];
  const isAdmin = currentUser.admin;
  document.getElementById('forms-tbody').innerHTML = data.length ? data.map(t => `
    <tr>
      <td class="cell-strong">${t.Locked?'🔒 ':''}${esc(t.Name)}</td>
      <td>${t.CertName ? '🎓 ' + esc(t.CertName) : '<span class="cell-sub">none</span>'}</td>
      <td>${t.FieldCount}</td><td>${t.SubmissionCount}</td>
      <td>${t.Locked?'<span class="badge badge-inactive badge-plain">🔒 Locked</span>':'<span class="badge badge-pending badge-plain">Draft</span>'}</td>
      <td class="actions">
        <button class="btn btn-accent btn-sm" onclick="startFieldAssessment(${t.TemplateID})" title="Conduct">▶</button>
        <a class="btn btn-outline btn-sm" href="/api/forms/templates/${t.TemplateID}/export" title="Download blank form as a Word document">⬇ Word</a>
        <button class="btn btn-outline btn-sm" onclick="openSaveFormDest('template',${t.TemplateID},'${esc(t.Name)}')" title="Save this form to a destination (Document Library, Training Material…)">💾 Save to…</button>
        <button class="btn btn-outline btn-sm btn-icon" onclick="duplicateForm(${t.TemplateID},'${esc(t.Name)}')" title="Copy / Save as new">⧉</button>
        ${t.Locked
          ? (isAdmin ? `<button class="btn btn-warning btn-sm" onclick="toggleLock(${t.TemplateID},false)" title="Unlock for editing">🔓 Unlock</button>` : '<span class="cell-sub" title="Locked — ask a master admin to unlock">🔒</span>')
          : `<button class="btn btn-primary btn-sm btn-icon" onclick="editForm(${t.TemplateID})" title="Edit">✏️</button>
             <button class="btn btn-success btn-sm" onclick="toggleLock(${t.TemplateID},true)" title="Save & Lock">🔒 Lock</button>`}
        ${(!t.Locked || isAdmin) ? `<button class="btn btn-danger btn-sm btn-icon" onclick="deleteForm(${t.TemplateID})" title="Delete">🗑️</button>` : ''}
      </td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty-state">No assessment forms yet — click "+ New Form"</td></tr>';
}

const FIELD_LABELS = { section:'Section Header', text:'Short Text', textarea:'Notes', number:'Number', date:'Date',
  select:'Dropdown', radio:'Choice', checkbox:'Checkboxes', yesno:'Yes / No', rating:'Rating (1–5)',
  competency:'Competency (Pass/Fail)', materiallink:'Training Material Link',
  grid:'Table / Grid', signature:'Signature Pad', time:'Time', email:'Email', phone:'Phone',
  instructions:'Instructions (static text)', photo:'Photo / Image' };

function openFormBuilder() {
  editingId.form = null; fbFields = []; fbMaterial = []; renderMaterialList();
  clearForm(['fb-Name','fb-Description']); setVal('fb-PassMark', 80); setVal('fb-CertID','');
  populateSelect('fb-CertID', cache.certs, 'CertID', 'CertName');
  document.getElementById('fb-title').textContent = 'New Assessment Form';
  fbResetTrans('', 'below');
  fbTransName = ''; fbTransDescription = '';
  renderFbFields();
  renderFbFormHeaderTrans();
  showModal('form-builder-modal');
}

// Reset the translation bar state (language + layout buttons)
function fbResetTrans(lang, layout, sideOrder) {
  fbTransLang = lang || '';
  fbTransLayout = layout || 'below';
  fbTransSideOrder = sideOrder || 'en-first';
  setVal('fb-trans-lang', fbTransLang);
  ['above','below','side'].forEach(m =>
    document.getElementById('fb-tbl-'+m)?.classList.toggle('active', m === fbTransLayout));
  const ord = document.getElementById('fb-trans-order');
  if (ord) ord.style.display = (fbTransLayout === 'side') ? 'inline-flex' : 'none';
  document.getElementById('fb-ord-en')?.classList.toggle('active', fbTransSideOrder === 'en-first');
  document.getElementById('fb-ord-lang')?.classList.toggle('active', fbTransSideOrder === 'lang-first');
}

async function editForm(id) {
  const t = await GET('/api/forms/templates/' + id);
  if (!t) return;
  editingId.form = id;
  populateSelect('fb-CertID', cache.certs, 'CertID', 'CertName');
  setVal('fb-Name', t.Name); setVal('fb-Description', t.Description); setVal('fb-CertID', t.CertID);
  setVal('fb-PassMark', t.PassMark); fbMaterial = parseMaterial(t.MaterialLink); renderMaterialList();
  fbFields = t.fields.map(f => ({ FieldType: f.FieldType, Label: f.Label, Options: f.Options || [], Required: !!f.Required, Points: f.Points || 0, HelpText: f.HelpText, Translation: f.Translation || null }));
  fbResetTrans(t.TransLang, t.TransLayout, t.TransSideOrder);
  fbTransName = t.TransName || '';
  fbTransDescription = t.TransDescription || '';
  renderFbFormHeaderTrans();
  document.getElementById('fb-title').textContent = 'Edit: ' + t.Name;
  renderFbFields();
  showModal('form-builder-modal');
}

// ---- Training material links / folder locations ----
let fbMaterial = [];
const MATERIAL_TYPES = ['SharePoint', 'Shared Drive', 'Document', 'Video', 'Web Link', 'Other'];
const MATERIAL_ICON = { 'SharePoint':'🔷', 'Shared Drive':'📁', 'Document':'📄', 'Video':'🎬', 'Web Link':'🔗', 'Other':'📎' };

// Parse a stored MaterialLink value into an array of {type,label,url}
function parseMaterial(str) {
  if (!str) return [];
  try {
    const v = JSON.parse(str);
    if (Array.isArray(v)) return v.filter(x => x && (x.url || x.label));
  } catch {}
  return [{ type: 'Web Link', label: 'Training Material', url: str }];
}

function renderMaterialList() {
  const wrap = document.getElementById('fb-material-list');
  if (!wrap) return;
  wrap.innerHTML = fbMaterial.length ? fbMaterial.map((m, i) => `
    <div class="material-row">
      <select onchange="fbMaterial[${i}].type=this.value">${MATERIAL_TYPES.map(t => `<option ${m.type===t?'selected':''}>${t}</option>`).join('')}</select>
      <input placeholder="Label (e.g. Haul Truck SOPs)" value="${esc(m.label||'')}" oninput="fbMaterial[${i}].label=this.value">
      <input placeholder="Link / path (https://sharepoint… or \\\\server\\share\\folder)" value="${esc(m.url||'')}" oninput="fbMaterial[${i}].url=this.value">
      <button class="btn btn-outline btn-sm" onclick="browseFolder(${i})" title="Pick a folder (supported browsers)">📁</button>
      <button class="btn btn-danger btn-sm btn-icon" onclick="fbMaterial.splice(${i},1);renderMaterialList()">✕</button>
    </div>`).join('') : '<p class="cell-sub">No material locations yet. Add SharePoint links, shared-drive folders, documents or videos.</p>';
}
function addMaterialLink() { fbMaterial.push({ type: 'SharePoint', label: '', url: '' }); renderMaterialList(); }

// Folder picker (Chromium/Edge File System Access API) — fills the label with the chosen folder name
async function browseFolder(i) {
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker();
      if (!fbMaterial[i].label) fbMaterial[i].label = dir.name;
      toast('Folder "' + dir.name + '" selected — paste its SharePoint/share URL in the link box so others can open it.', 'info');
      renderMaterialList();
    } catch {}
  } else {
    toast('Your browser can\'t open a folder picker. Paste the SharePoint link or \\\\server\\share path instead.', 'info');
  }
}

// Render material locations on the assessment form (clickable; copy-button for file/UNC paths)
function renderMaterialLinks(stored) {
  const list = parseMaterial(stored);
  if (!list.length) return '';
  const isFilePath = u => /^(\\\\|file:|[a-zA-Z]:\\)/.test(u || '');
  const rows = list.map(m => {
    const icon = MATERIAL_ICON[m.type] || '📎';
    const label = esc(m.label || m.url || '');
    if (isFilePath(m.url)) {
      return `<div class="mat-link">${icon} <strong>${label}</strong>
        <code class="mat-path">${esc(m.url)}</code>
        <button class="btn btn-outline btn-sm" onclick="copyText('${esc(m.url).replace(/'/g,"\\'")}')">📋 Copy path</button></div>`;
    }
    return `<div class="mat-link">${icon} <a href="${esc(m.url)}" target="_blank" rel="noopener"><strong>${label}</strong></a> <span class="cell-sub">${esc(m.type||'')}</span></div>`;
  }).join('');
  return `<div class="alert alert-info"><span>📚</span><div><strong>Training material:</strong>${rows}</div></div>`;
}
function copyText(t) { navigator.clipboard.writeText(t).then(() => toast('Path copied to clipboard.')); }

// Open a stored Template Form (.docx) in the AI Content Studio editor: reproduces the document's layout
// (headings, body, tables) as editable sections, then the full Content Studio applies — edit, AI
// generate/assist, bilingual translation (with the terminology glossary), and company branding. Saving
// with "Update Document" writes the branded, layout-preserving .docx back to this same template form.
async function editTemplateFormInStudio(fileId) {
  toast('Opening in Content Studio…', 'info');
  const r = await GET('/api/content/template-form-to-doc/' + fileId);
  if (!r || r.error) return toast((r && r.error) || 'Could not open this template form.', 'error');
  csDraft = { type: r.type, data: r.data, tsFileId: r.tsFileId };
  navigateTo('content-studio');
}

// Connector: turn a stored Template Form (.docx) into an editable online form. Parses the document into
// form fields (via the same engine as Import Document), opens the Form Builder pre-populated so the user
// can review/edit, then Save Form makes it a live online form (and it can then be downloaded as Word too).
async function useTemplateFormAsForm(fileId) {
  toast('Opening online form…', 'info');
  // Parse the uploaded document into form fields.
  const r = await fetch(`/api/forms/import-template-form/${fileId}`, { method: 'POST', credentials: 'include' });
  const j = await r.json().catch(() => ({ error: 'Unexpected response.' }));
  if (!r.ok || j.error) return toast(j.error || 'Could not open this template form.', 'error');
  if (!Array.isArray(j.fields) || !j.fields.length) return toast('No fillable content could be read from that document.', 'error');
  const name = (j.name || 'Template Form').trim();
  // Reuse the online form already published for this template (by name), else publish it now so it becomes
  // a real, fillable/submittable online form. Then open the FILLABLE view (not the Form Builder editor).
  let templateId = null;
  // Template-form online forms live in their OWN category so they stay OUT of the Field Assessment picker.
  // Look there first; fall back to the legacy assessment list to catch any published before this split (they
  // get reclassified to 'template-form' by the self-heal PUT below).
  const tfList = (await GET('/api/forms/templates?category=template-form')) || [];
  let match = tfList.find(t => (t.Name || '').trim() === name);
  if (!match) { const legacy = (await GET('/api/forms/templates')) || []; match = legacy.find(t => (t.Name || '').trim() === name); }
  const freshFields = j.fields.map(f => ({ FieldType: f.FieldType, Label: f.Label || '', Options: f.Options || [], Required: !!f.Required, Points: f.Points || 0, HelpText: f.HelpText || '' }));
  if (match) {
    templateId = match.TemplateID;
    // Self-heal: while the online form is still a draft (unlocked, no submissions), refresh its fields from
    // a fresh parse so document-layout improvements take effect — otherwise a form published before a parser
    // fix keeps serving the old, stale layout. Also (re)tag it as a template-form so it leaves the Field
    // Assessment picker. Locked or already-submitted forms are left untouched.
    if (!match.Locked && !match.SubmissionCount) {
      await fetch('/api/forms/templates/' + templateId, {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Name: name, Description: match.Description || null, CertID: match.CertID || null,
          PassMark: match.PassMark || 80, Status: match.Status || 'Active', MaterialLink: match.MaterialLink || null,
          TransLang: match.TransLang || null, TransLayout: match.TransLayout || null, TransSideOrder: match.TransSideOrder || null,
          TransName: match.TransName || null, TransDescription: match.TransDescription || null,
          FormCategory: 'template-form', fields: freshFields
        })
      }).catch(() => {});
    }
  } else {
    const created = await POST('/api/forms/templates', {
      Name: name, Description: null, PassMark: 80, Status: 'Active', FormCategory: 'template-form', fields: freshFields
    });
    if (!created || !created.TemplateID) return toast('Could not open the online form.', 'error');
    templateId = created.TemplateID;
  }
  // Open the fillable online form; "‹ Back" returns to Template Forms.
  await startFieldAssessment(templateId, 'template-forms');
}

// Save-to-destination: file a form (blank template or completed submission) as a Word document into a
// chosen folder — Document Library, Training Standards, Training Material, or the reusable Template Forms
// library. The generated .docx preserves the form's tables/grids (same engine as the ⬇ Word download).
let _sfd = { kind: null, id: null };
function openSaveFormDest(kind, id, name) {
  _sfd = { kind, id };
  setVal('sfd-folder', 'library');
  setVal('sfd-cat', '');
  document.getElementById('sfd-cat-wrap').style.display = 'none';
  document.getElementById('sfd-name').textContent = name ? `Saving: ${name}` : '';
  showModal('save-form-dest-modal');
}
function sfdToggleCat() {
  document.getElementById('sfd-cat-wrap').style.display = (val('sfd-folder') === 'training-material') ? '' : 'none';
}
async function confirmSaveFormDest() {
  const folder = val('sfd-folder');
  const materialCategory = val('sfd-cat');
  if (folder === 'training-material' && !materialCategory.trim()) return toast('Enter a Training Material category.', 'error');
  if (!_sfd.id) return;
  const url = _sfd.kind === 'submission' ? `/api/forms/submissions/${_sfd.id}/save-doc` : `/api/forms/templates/${_sfd.id}/save-doc`;
  const r = await POST(url, { folder, materialCategory });
  if (!ok(r)) return;
  closeModal('save-form-dest-modal');
  toast(r.message || 'Form saved.');
  if (folder === 'template-forms' && typeof loadTemplateForms === 'function') { try { loadTemplateForms(); } catch (e) {} }
}

async function importDocToBuilder(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  toast('Reading document…', 'info');
  const fd = new FormData(); fd.append('file', file);
  const r = await fetch('/api/forms/import-doc', { method: 'POST', body: fd, credentials: 'include' });
  const j = await r.json();
  ev.target.value = '';
  if (j.error) return toast(j.error, 'error');
  if (!confirm(`Imported ${j.fields.length} field(s) from "${file.name}". This will replace the current fields — you can then edit, add or delete any of them. Continue?`)) return;
  if (j.name && !val('fb-Name')) setVal('fb-Name', j.name);
  fbFields = j.fields.map(f => ({
    FieldType: f.FieldType, Label: f.Label || '', Options: f.Options || [],
    Required: !!f.Required, Points: f.Points || 0, HelpText: f.HelpText || ''
  }));
  renderFbFields();
  toast('Document imported — review and edit the fields below, then Save Form.');
}

function addField(type) {
  const f = { FieldType: type, Label: '', Options: [], Required: false, Points: type === 'competency' ? 10 : 0, HelpText: '' };
  if (['select','radio','checkbox'].includes(type)) f.Options = ['Option 1', 'Option 2'];
  if (type === 'grid') f.Options = { columns: [{key:'c0',label:'Item',fill:false},{key:'c1',label:'Initials & Date',fill:true}], rows: [] };
  fbFields.push(f);
  renderFbFields();
}

// ---- Grid config <-> text helpers (builder) ----
// Column encoding:  Label   = fixed content,  Label*  = text fill-in,  Label#  = tick-box
function gridColsToText(o) {
  return (o && o.columns ? o.columns : []).map(c => c.label + (c.check ? '#' : c.fill ? '*' : '')).join(', ');
}
function gridSetCols(o, text) {
  o = o && o.columns ? o : { columns: [], rows: [] };
  o.columns = text.split(',').map(s => s.trim()).filter(Boolean).map((s, i) => {
    const check = s.endsWith('#'); const fill = s.endsWith('*');
    const label = (check || fill) ? s.slice(0, -1).trim() : s;
    return { key: 'c' + i, label, fill: fill || check, check };
  });
  return o;
}
function gridRowsToText(o) {
  if (!o || !o.rows) return '';
  const cols = o.columns || [];
  return o.rows.map(r => r.heading ? '## ' + r.heading
    : cols.filter(c => !c.fill).map(c => (r.cells && r.cells[c.key]) || '').join(' | ')).join('\n');
}
// Translated-grid preview inside the Form Builder editor — shows column header / cell / heading translations
// alongside the original textareas, so the admin can SEE and EDIT what 🌐 Translate All produced.
function fbBuilderGridTransHtml(f, i) {
  const tg = f && f.Translation && f.Translation.grid;
  if (!tg || (!Array.isArray(tg.columns) && !Array.isArray(tg.rows))) return '';
  const cols = (f.Options && f.Options.columns) || [];
  const langLabel = fbTransLang || 'Translation';
  // Translated column headers
  const colRows = (tg.columns || []).map((c, ci) => {
    const orig = (cols[ci] && cols[ci].label) || '';
    return `<div class="fb-gtrans-row">
      <span class="fb-gtrans-orig">${esc(orig || ('Col ' + (ci+1)))}</span>
      <input class="fb-gtrans-input" value="${esc(c.label||'')}" placeholder="Translated header" oninput="fbFields[${i}].Translation.grid.columns[${ci}].label=this.value">
    </div>`;
  }).join('');
  // Translated rows (heading rows OR data rows with per-cell translations)
  const srcRows = (f.Options && f.Options.rows) || [];
  const rowRows = (tg.rows || []).map((r, ri) => {
    const srcRow = srcRows[ri] || {};
    if (srcRow.heading != null) {
      return `<div class="fb-gtrans-row">
        <span class="fb-gtrans-orig fb-gtrans-head">## ${esc(srcRow.heading || '')}</span>
        <input class="fb-gtrans-input" value="${esc((r && r.heading) || '')}" placeholder="Translated heading" oninput="fbFields[${i}].Translation.grid.rows[${ri}].heading=this.value">
      </div>`;
    }
    const tCells = (r && r.cells) || {};
    const srcCells = srcRow.cells || {};
    const cellsHtml = cols.filter(c => !c.fill && !c.check).map(c => {
      const orig = (srcCells[c.key] != null) ? String(srcCells[c.key]) : '';
      const tv   = (tCells[c.key] != null) ? String(tCells[c.key]) : '';
      if (!orig && !tv) return '';
      return `<div class="fb-gtrans-cell">
        <div class="fb-gtrans-orig">${esc(c.label)}: <span class="cell-sub">${esc(orig).replace(/\n/g,'<br>')}</span></div>
        <textarea class="fb-gtrans-input" rows="2" placeholder="Translated cell" oninput="fbFields[${i}].Translation.grid.rows[${ri}].cells['${esc(c.key)}']=this.value">${esc(tv)}</textarea>
      </div>`;
    }).filter(Boolean).join('');
    return cellsHtml ? `<div class="fb-gtrans-row fb-gtrans-rowblock"><div class="fb-gtrans-rowtag">Row ${ri+1}</div>${cellsHtml}</div>` : '';
  }).filter(Boolean).join('');
  return `<details class="fb-gtrans" open>
    <summary>🌐 ${esc(langLabel)} — grid translation (edit below)</summary>
    ${colRows ? `<div class="fb-gtrans-sec"><div class="fb-gtrans-h">Column headers</div>${colRows}</div>` : ''}
    ${rowRows ? `<div class="fb-gtrans-sec"><div class="fb-gtrans-h">Row cells</div>${rowRows}</div>` : ''}
  </details>`;
}

function gridSetRows(o, text) {
  o = o && o.columns ? o : { columns: [], rows: [] };
  const contentCols = (o.columns || []).filter(c => !c.fill);
  o.rows = text.split('\n').map(line => {
    line = line.replace(/\r$/, '');
    if (!line.trim()) return null;
    if (line.startsWith('## ')) return { heading: line.slice(3).trim() };
    const parts = line.split('|').map(s => s.trim());
    const cells = {}; contentCols.forEach((c, i) => { if (parts[i]) cells[c.key] = parts[i]; });
    return { cells };
  }).filter(Boolean);
  return o;
}

function renderFbFields() {
  const wrap = document.getElementById('fb-fields');
  if (!fbFields.length) { wrap.innerHTML = '<p class="cell-sub">No fields yet. Use the buttons above to add competency checks, ratings, notes, etc.</p>'; return; }
  wrap.innerHTML = fbFields.map((f, i) => {
    const isChoice = ['select','radio','checkbox'].includes(f.FieldType);
    // Full-content textareas (auto-grow) instead of single-line inputs, so long labels/options wrap and the
    // whole text is visible and editable — never truncated in a scrolling one-line box.
    const labelInput = `<textarea class="fb-label fa-auto-grow" rows="1" placeholder="${f.FieldType==='section'?'Section title':f.FieldType==='materiallink'?'Link text (URL in builder header applies)':'Question / label'}" oninput="fbFields[${i}].Label=this.value;autoGrowTextarea(this)">${esc(f.Label||'')}</textarea>`;
    const tr = f.Translation;
    const transBlock = tr ? `<div class="fb-trans">
        <span class="fb-trans-tag">🌐 ${esc(fbTransLang||'Translation')}</span>
        <textarea class="fb-label fb-trans-label fa-auto-grow" rows="1" placeholder="Translated label" oninput="fbFields[${i}].Translation.label=this.value;autoGrowTextarea(this)">${esc(tr.label||'')}</textarea>
        ${isChoice ? `<textarea class="fb-opts fa-auto-grow" rows="1" placeholder="Translated options (comma separated)" oninput="fbFields[${i}].Translation.options=this.value.split(',').map(s=>s.trim()).filter(Boolean);autoGrowTextarea(this)">${esc((tr.options||[]).join(', '))}</textarea>` : ''}
        ${f.HelpText ? `<textarea class="fb-opts fa-auto-grow" rows="1" placeholder="Translated help text" oninput="fbFields[${i}].Translation.helpText=this.value;autoGrowTextarea(this)">${esc(tr.helpText||'')}</textarea>` : ''}
      </div>` : '';
    const labelArea = !transBlock ? labelInput
      : fbTransLayout==='side'  ? `<div class="fb-labrow fb-side">${fbTransSideOrder==='lang-first' ? `${transBlock}${labelInput}` : `${labelInput}${transBlock}`}</div>`
      : fbTransLayout==='above' ? `${transBlock}${labelInput}`
      : `${labelInput}${transBlock}`;
    return `
    <div class="fb-field">
      <div class="fb-field-head">
        <span class="fb-type">${FIELD_LABELS[f.FieldType]||f.FieldType}</span>
        <span class="fb-trans-status" id="fb-tstat-${i}" title="Translation status">${f.Translation ? '✅' : ''}</span>
        <div class="fb-move">
          <button class="btn btn-ghost btn-sm btn-icon" onclick="moveField(${i},-1)" ${i===0?'disabled':''}>▲</button>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="moveField(${i},1)" ${i===fbFields.length-1?'disabled':''}>▼</button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="removeField(${i})">🗑️</button>
        </div>
      </div>
      ${labelArea}
      ${isChoice ? `
        <textarea class="fb-opts fa-auto-grow" rows="1" placeholder="Comma-separated options"
          oninput="fbFields[${i}].Options=this.value.split(',').map(s=>s.trim()).filter(Boolean);autoGrowTextarea(this)">${esc((f.Options||[]).join(', '))}</textarea>` : ''}
      ${f.FieldType==='materiallink' ? `<input class="fb-opts" placeholder="https://link-to-material" value="${esc((f.Options&&f.Options[0])||'')}" oninput="fbFields[${i}].Options=[this.value]">` : ''}
      ${f.FieldType==='grid' ? `
        <textarea class="fb-opts fa-auto-grow" rows="1" placeholder="Columns (comma separated). Add * = text fill-in, # = tick-box. e.g. Criteria, Content, Covered#, Assessor Initials*" oninput="fbFields[${i}].Options=gridSetCols(fbFields[${i}].Options,this.value);autoGrowTextarea(this)">${esc(gridColsToText(f.Options))}</textarea>
        <textarea class="fb-opts" rows="6" placeholder="One row per line. '## Heading' = section row. Content cells separated by | in column order (fill/tick columns are left for the assessor)." oninput="fbFields[${i}].Options=gridSetRows(fbFields[${i}].Options,this.value)">${esc(gridRowsToText(f.Options))}</textarea>
        <div class="cell-sub">${(f.Options&&f.Options.columns?f.Options.columns.length:0)} columns × ${(f.Options&&f.Options.rows?f.Options.rows.length:0)} rows · * = fill-in, # = tick-box</div>
        ${fbBuilderGridTransHtml(f, i)}` : ''}
      ${!['section','materiallink'].includes(f.FieldType) ? `
        <div class="fb-field-opts">
          <label class="flex items-center gap-2" style="font-size:12px"><input type="checkbox" ${f.Required?'checked':''} onchange="fbFields[${i}].Required=this.checked"> Required</label>
          ${['competency','yesno','rating'].includes(f.FieldType) ? `<label class="flex items-center gap-2" style="font-size:12px">Points <input type="number" min="0" style="width:64px" value="${f.Points||0}" oninput="fbFields[${i}].Points=parseInt(this.value)||0"></label>` : ''}
        </div>` : ''}
    </div>`;
  }).join('');
  autoGrowAll(wrap); // size the label/option textareas to their content so nothing is truncated
}
function moveField(i, dir) { const j=i+dir; if(j<0||j>=fbFields.length) return; [fbFields[i],fbFields[j]]=[fbFields[j],fbFields[i]]; renderFbFields(); }
function removeField(i) { fbFields.splice(i,1); renderFbFields(); }

async function saveForm() {
  const d = { Name: val('fb-Name'), Description: val('fb-Description'), CertID: val('fb-CertID'),
    PassMark: val('fb-PassMark'),
    MaterialLink: fbMaterial.filter(m => (m.url || '').trim() || (m.label || '').trim()).length ? JSON.stringify(fbMaterial.filter(m => (m.url || '').trim())) : '',
    TransLang: fbTransLang || null, TransLayout: fbTransLayout || null, TransSideOrder: fbTransSideOrder || null,
    TransName: fbTransName || null, TransDescription: fbTransDescription || null,
    fields: fbFields };
  if (!d.Name) return toast('Form name is required.', 'error');
  if (!fbFields.length) return toast('Add at least one field.', 'error');
  const editing = editingId.form;
  // Replace-on-duplicate: for a NEW form, if one with the same name exists, confirm then replace it.
  let dupes = [];
  if (!editing) {
    const fms = (await GET('/api/forms/templates')) || [];
    dupes = fms.filter(t => _normName(t.Name) === _normName(d.Name));
    if (!confirmOverwrite(d.Name, dupes, 'form')) return;
  }
  const r = editing ? await PUT('/api/forms/templates/' + editing, d) : await POST('/api/forms/templates', d);
  if (!ok(r)) return;
  if (!editing && dupes.length) { const newId = r.TemplateID; for (const t of dupes) { if (t.TemplateID === newId) continue; try { await DEL('/api/forms/templates/' + t.TemplateID); } catch {} } }
  closeModal('form-builder-modal');
  toast(editing ? 'Form updated.' : 'Form created.');
  loadForms();
}
async function deleteForm(id) {
  if (!confirm('Delete this form? Submitted assessments are kept.')) return;
  const r = await DEL('/api/forms/templates/' + id);
  if (r && r.error) return toast(r.error, 'error');
  loadForms();
}

async function duplicateForm(id, name) {
  const newName = prompt('New assessment form name:', (name || 'Assessment') + ' (Copy)');
  if (!newName) return;
  const r = await POST(`/api/forms/templates/${id}/duplicate`, { Name: newName });
  if (!ok(r)) return;
  toast('Form copied as "' + r.Name + '". You can now edit it.');
  loadForms();
}

async function toggleLock(id, locked) {
  if (locked && !confirm('Save & lock this form? Once locked, assessors can only fill the field boxes. Only a master admin can unlock it for editing.')) return;
  const r = await PUT(`/api/forms/templates/${id}/lock`, { locked });
  if (!ok(r)) return;
  toast(locked ? '🔒 Form saved & locked.' : '🔓 Form unlocked for editing.');
  loadForms();
}

// ---- Field Assessment (tablet fill-out) ----
let faTemplate = null, faSigPads = {}, faLocked = false, faExitTo = null;
// Where the field-assessment "‹ Back" button returns to: the Field Assessment picker by default, or a
// specific page (e.g. Template Forms) when the form was opened from there via "Use as online form".
function faBackNav() { const t = faExitTo; faExitTo = null; if (t) navigateTo(t); else loadFieldAssess(); }
async function loadFieldAssess() {
  document.getElementById('fa-form').classList.add('hidden');
  document.getElementById('fa-picker').classList.remove('hidden');
  const data = await GET('/api/forms/templates') || [];
  const active = data.filter(t => t.Status === 'Active');
  document.getElementById('fa-template-list').innerHTML = active.length ? active.map(t => `
    <div class="fa-pick" onclick="startFieldAssessment(${t.TemplateID})">
      <div><strong>${esc(t.Name)}</strong><div class="cell-sub">${t.FieldCount} items${t.CertName?' · awards 🎓 '+esc(t.CertName):''}</div></div>
      <span class="btn btn-accent btn-sm">Start ▶</span>
    </div>`).join('') : '<div class="empty-state"><div class="icon">📋</div><p>No active assessment forms. Build one under Form Builder.</p></div>';
}

async function startFieldAssessment(id, exitTo) {
  faTemplate = await GET('/api/forms/templates/' + id);
  if (!faTemplate) return;
  faExitTo = exitTo || null;
  faLocked = !!faTemplate.Locked;
  faPhotos = {};
  navigateTo('field-assess');
  document.getElementById('fa-picker').classList.add('hidden');
  const host = document.getElementById('fa-form');
  host.classList.remove('hidden');
  const staffOpts = cache.staff.map(s => `<option value="${s.StaffID}">${esc(s.LastName)}, ${esc(s.FirstName)}</option>`).join('');
  const trainerOpts = (cache.trainers||[]).map(t => `<option value="${t.TrainerID}">${esc(t.LastName)}, ${esc(t.FirstName)}</option>`).join('');
  // Trainee/Trainer/Date/Location + signature blocks are for COMPETENCY ASSESSMENTS only. Hide them
  // for general record/template forms (e.g. an MOC Request Form) — by category, or the template-forms view.
  const faCat = String(faTemplate.FormCategory || 'assessment').toLowerCase();
  const faHideTraining = faExitTo === 'template-forms' || faCat !== 'assessment';
  // Branded header — company logo top-left + name & form title to the right. Shows on screen AND on print.
  const coName = (cache.company && cache.company.name) ? cache.company.name : '';
  const coLogo = (cache.company && cache.company.logo) ? cache.company.logo : '';
  const brandHeader = `<div class="fa-brand">
    ${coLogo ? `<img src="${esc(coLogo)}" alt="${esc(coName || 'Company logo')}" class="fa-brand-logo">` : '<div class="fa-brand-logo fa-brand-logo-placeholder"></div>'}
    <div class="fa-brand-text">
      ${coName ? `<div class="fa-brand-co">${esc(coName)}</div>` : ''}
      <div class="fa-brand-title">${esc(faTemplate.Name || 'Field Assessment')}</div>
      ${(faTemplate.Description && !/generated from[\s\S]*master template/i.test(faTemplate.Description)) ? `<div class="fa-brand-sub">${esc(String(faTemplate.Description).slice(0, 140))}</div>` : ''}
    </div>
  </div>`;
  host.innerHTML = `
    <div class="card" id="fa-printable">
      <div class="card-header no-print"><h3>📋 ${faLocked?'🔒 ':''}${esc(faTemplate.Name)}</h3>
        <div class="flex gap-2">
          <button class="btn btn-outline btn-sm" onclick="duplicateForm(${faTemplate.TemplateID},'${esc(faTemplate.Name)}')">⧉ Save as New Template</button>
          <button class="btn btn-outline btn-sm" onclick="faBackNav()">‹ Back</button>
        </div></div>
      ${brandHeader}
      <div class="card-body">
        ${faLocked
          ? '<div class="alert alert-success"><span>🔒</span><div>This form is locked — only the field boxes can be filled in. A master admin can unlock it in Form Builder to change the layout.</div></div>'
          : '<div class="alert alert-warning no-print"><span>✏️</span><div>Draft form — you can edit the text, add rows and change the layout. Lock it in Form Builder when finalised so assessors only fill the boxes.</div></div>'}
        ${(faTemplate.Description && !/generated from[\s\S]*master template/i.test(faTemplate.Description)) ? `<div class="alert alert-info"><span>ℹ️</span><div>${esc(faTemplate.Description)}</div></div>` : ''}
        ${renderMaterialLinks(faTemplate.MaterialLink)}
        <div class="form-grid mb-2"${faHideTraining ? ' style="display:none"' : ''}>
          <div class="form-group"><label>Trainee *</label><select id="fa-emp"><option value="">-- Select --</option>${staffOpts}</select></div>
          <div class="form-group"><label>Trainer</label><select id="fa-trainer"><option value="">-- Select --</option>${trainerOpts}</select></div>
          <div class="form-group"><label>Date</label><input id="fa-date" type="date" value="${ymd(new Date())}"></div>
          <div class="form-group"><label>Location</label><input id="fa-loc" placeholder="Site / area"></div>
        </div>
        <div id="fa-fields">${faTemplate.fields.map((f,i)=>renderFaField(f,i)).join('')}</div>
        <div class="sig-grid mt-2"${faHideTraining ? ' style="display:none"' : ''}>
          <div><label class="sig-label">Trainee Signature *</label><canvas class="sigpad" id="sig-trainee" width="600" height="180"></canvas>
            <button class="btn btn-outline btn-sm" onclick="clearSig('trainee')">Clear</button></div>
          <div><label class="sig-label">Trainer Signature *</label><canvas class="sigpad" id="sig-trainer" width="600" height="180"></canvas>
            <button class="btn btn-outline btn-sm" onclick="clearSig('trainer')">Clear</button></div>
        </div>
        <div class="flex gap-2 mt-2 no-print">
          ${faHideTraining ? '' : '<button class="btn btn-accent" style="font-size:15px;padding:12px 24px" onclick="submitFieldAssessment()">✅ Submit &amp; Sign Off</button>'}
          <button class="btn btn-outline" style="font-size:15px;padding:12px 24px" onclick="printFieldAssessment()">🖨 Print Document</button>
        </div>
      </div>
    </div>`;
  setTimeout(() => { initSigPad('trainee'); initSigPad('trainer'); (faTemplate.fields||[]).forEach(f => { if (f.FieldType==='signature') initSigPad('f-'+f.FieldID); }); autoGrowAll(document.getElementById('fa-form')); }, 50);
}

// Colour outcome-style options: green for competent/pass, red for not-competent/fail
function optColorClass(o) {
  const s = (o || '').toLowerCase();
  if (/not\s*(yet\s*)?competent|fail|unsatisfactory|not\s+complete/.test(s)) return 'fa-opt-red';
  if (/\bcompetent\b|\bpass\b|satisfactory|\bcomplete\b/.test(s)) return 'fa-opt-green';
  return '';
}

// Bilingual label/option/help helpers — honor the template's translation layout (above|below|side)
function faTransLayout() { return (faTemplate && faTemplate.TransLayout) || 'below'; }
function faTransSideOrder() { return (faTemplate && faTemplate.TransSideOrder) || 'en-first'; }
function faLabel(f, fallback) {
  const en = esc(f.Label || fallback || '');
  const t  = (f.Translation && f.Translation.label) ? esc(f.Translation.label) : '';
  if (!t) return en;
  const lay = faTransLayout();
  if (lay === 'above') return `<span class="fa-trans-label">${t}</span>${en}`;
  if (lay === 'side')  return (faTransSideOrder() === 'lang-first')
    ? `${t} <span class="fa-trans-inline">· ${en}</span>`
    : `${en} <span class="fa-trans-inline">· ${t}</span>`;
  return `${en}<span class="fa-trans-label">${t}</span>`;
}
// True when the chosen order is translation-first — used so EVERY bilingual element (labels, options, help,
// instructions, grid headers/cells) shows the translation first, consistently, not just the labels.
function faLangFirst() { return faTransSideOrder() === 'lang-first'; }
// Order an English fragment and a translation fragment (already-built HTML) per the chosen order.
function faOrder(enHtml, transHtml) {
  if (!transHtml) return enHtml;
  if (!enHtml) return transHtml;
  return faLangFirst() ? (transHtml + enHtml) : (enHtml + transHtml);
}
function faOpt(f, idx, o) {
  const en = esc(o);
  const t  = (f.Translation && Array.isArray(f.Translation.options) && f.Translation.options[idx]) ? esc(f.Translation.options[idx]) : '';
  if (!t) return en;
  // Plain text (used inside <option> too), ordered per the translation-first setting.
  return faLangFirst() ? `${t} / ${en}` : `${en} / ${t}`;
}
function faHelp(f) {
  const en = f.HelpText ? esc(f.HelpText) : '';
  const t  = (f.Translation && f.Translation.helpText) ? esc(f.Translation.helpText) : '';
  if (!en && !t) return '';
  if (!en || !t) return `<div class="cell-sub">${en || t}</div>`;
  const first = faLangFirst() ? t : en, second = faLangFirst() ? en : t;
  return `<div class="cell-sub">${first}<span class="fa-trans-inline"> · ${second}</span></div>`;
}

function renderFaField(f, i) {
  const id = 'fa-f-' + i;
  if (f.FieldType === 'section') return `<h4 class="fa-section">${faLabel(f,'Section')}</h4>`;
  if (f.FieldType === 'materiallink') { const url=(f.Options&&f.Options[0])||faTemplate.MaterialLink||'#'; return `<div class="fa-item">📚 <a href="${esc(url)}" target="_blank" rel="noopener">${faLabel(f,'Open training material')}</a></div>`; }
  if (f.FieldType === 'signature') return `<div class="fa-item"><label class="fa-q">${faLabel(f,'Signature')}${f.Required?' <span style="color:var(--danger)">*</span>':''}</label>
      <canvas class="sigpad" id="sigf-${f.FieldID}" data-fid="${f.FieldID}" data-sig="1" width="600" height="150"></canvas>
      <button type="button" class="btn btn-outline btn-sm" onclick="clearSig('f-${f.FieldID}')">Clear</button></div>`;
  if (f.FieldType === 'grid') return renderFaGrid(f);
  if (f.FieldType === 'instructions') {
    const iEn = esc(f.HelpText||f.Label||'');
    const iT  = (f.Translation && (f.Translation.helpText || f.Translation.label)) ? esc(f.Translation.helpText || f.Translation.label) : '';
    const body = !iT ? iEn : `${faLangFirst()?iT:iEn}<span class="fa-trans-inline"> · ${faLangFirst()?iEn:iT}</span>`;
    return `<div class="fa-instructions">${body}</div>`;
  }
  if (f.FieldType === 'photo') return `<div class="fa-item"><label class="fa-q">${faLabel(f,'Photo')}${f.Required?' <span style="color:var(--danger)">*</span>':''}</label>
      <input type="file" accept="image/*" capture="environment" data-fid="${f.FieldID}" data-photo="1" onchange="previewPhoto(this)">
      <img class="photo-preview hidden" id="photo-${f.FieldID}"></div>`;
  const req = f.Required ? '<span style="color:var(--danger)">*</span>' : '';
  let input = '';
  if (f.FieldType === 'competency') input = `<div class="fa-comp" data-fid="${f.FieldID}">
      <button type="button" class="comp-btn" data-v="Competent" onclick="pickComp(this)">✅ Competent</button>
      <button type="button" class="comp-btn comp-no" data-v="Not Competent" onclick="pickComp(this)">❌ Not Competent</button></div>`;
  else if (f.FieldType === 'yesno') input = `<div class="fa-comp" data-fid="${f.FieldID}">
      <button type="button" class="comp-btn" data-v="Yes" onclick="pickComp(this)">Yes</button>
      <button type="button" class="comp-btn comp-no" data-v="No" onclick="pickComp(this)">No</button></div>`;
  else if (f.FieldType === 'rating') input = `<div class="fa-rating" data-fid="${f.FieldID}">${[1,2,3,4,5].map(n=>`<span class="star" data-v="${n}" onclick="pickStar(this)">★</span>`).join('')}</div>`;
  else if (f.FieldType === 'textarea') input = `<textarea data-fid="${f.FieldID}" rows="2" class="fa-auto-grow" oninput="autoGrowTextarea(this)"></textarea>`;
  else if (f.FieldType === 'select') input = `<select data-fid="${f.FieldID}"><option value="">-- Select --</option>${(f.Options||[]).map((o,oi)=>`<option value="${esc(o)}">${faOpt(f,oi,o)}</option>`).join('')}</select>`;
  else if (f.FieldType === 'radio') input = `<div data-fid="${f.FieldID}" class="fa-radio">${(f.Options||[]).map((o,oi)=>`<label class="fa-opt ${optColorClass(o)}"><input type="radio" name="${id}" value="${esc(o)}"> ${faOpt(f,oi,o)}</label>`).join('')}</div>`;
  else if (f.FieldType === 'checkbox') input = `<div data-fid="${f.FieldID}" class="fa-checks">${(f.Options||[]).map((o,oi)=>`<label class="fa-opt ${optColorClass(o)}"><input type="checkbox" value="${esc(o)}"> ${faOpt(f,oi,o)}</label>`).join('')}</div>`;
  else if (f.FieldType === 'number') input = `<input type="number" data-fid="${f.FieldID}">`;
  else if (f.FieldType === 'date') input = `<input type="date" data-fid="${f.FieldID}">`;
  else if (f.FieldType === 'time') input = `<input type="time" data-fid="${f.FieldID}">`;
  else if (f.FieldType === 'email') input = `<input type="email" data-fid="${f.FieldID}" placeholder="name@company.com">`;
  else if (f.FieldType === 'phone') input = `<input type="tel" data-fid="${f.FieldID}" placeholder="Phone number">`;
  else input = `<input type="text" data-fid="${f.FieldID}">`;
  return `<div class="fa-item"><label class="fa-q">${faLabel(f)} ${req}${f.Points?`<span class="fa-pts">${f.Points} pts</span>`:''}</label>${input}${faHelp(f)}</div>`;
}

// Render a fully-editable table/grid: content cells, headings and fill/tick columns are all editable; rows can be added/removed.
function renderFaGrid(f) {
  const cfg = f.Options && f.Options.columns ? f.Options : { columns: [], rows: [] };
  const cols = cfg.columns || [];
  const tGrid = (f.Translation && f.Translation.grid) || null;
  const tCols = (tGrid && Array.isArray(tGrid.columns)) ? tGrid.columns : [];
  const tRows = (tGrid && Array.isArray(tGrid.rows)) ? tGrid.rows : [];
  const body = (cfg.rows || []).map((row, ri) => gridRowHtml(cols, row, tRows[ri])).join('');
  const actCol = faLocked ? '' : '<th class="gc-act"></th>';
  const addBtns = faLocked ? '' : `
    <button type="button" class="btn btn-outline btn-sm mt-1" onclick="addGridRow(this)">+ Add Row</button>
    <button type="button" class="btn btn-outline btn-sm mt-1" onclick="addGridRow(this,true)">+ Add Heading</button>`;
  const titleTrans = (f.Translation && (f.Translation.label || f.Translation.helpText))
    ? `<div class="fa-trans-inline">${esc(f.Translation.label || f.Translation.helpText)}</div>` : '';
  return `<div class="fa-gridwrap"><div class="fa-gridtitle">${faOrder(esc(f.Label||''), titleTrans)}</div>
    <table class="fa-grid" data-fid="${f.FieldID}" data-grid="1" data-cols='${esc(JSON.stringify(cols))}'>
      <thead><tr>${cols.map((c, i) => {
        const tLab = tCols[i] && tCols[i].label ? `<div class="fa-trans-inline">${esc(tCols[i].label)}</div>` : '';
        return `<th>${faOrder(esc(c.label), tLab)}</th>`;
      }).join('')}${actCol}</tr></thead>
      <tbody class="fa-gridbody">${body}</tbody></table>${addBtns}</div>`;
}
function gridRowHtml(cols, row, tRow) {
  const locked = faLocked;
  const actCell = locked ? '' : `<td class="gc-act"><button type="button" class="grid-del" onclick="this.closest('tr').remove()" title="Remove row">✕</button></td>`;
  if (row.heading != null && row.cells == null) {
    const trans = (tRow && tRow.heading) ? `<div class="fa-trans-inline">${esc(tRow.heading)}</div>` : '';
    const h = locked
      ? `<td colspan="${cols.length}" class="grid-fixed" style="background:var(--primary-soft);font-weight:700">${faOrder(esc(row.heading), trans)}<input type="hidden" class="grid-headin" value="${esc(row.heading)}"></td>`
      : `<td colspan="${cols.length}"><input class="grid-headin" value="${esc(row.heading)}" placeholder="Section heading…">${trans}</td>`;
    return `<tr data-row="head">${h}${actCell}</tr>`;
  }
  const cells = row.cells || {};
  const tCells = (tRow && tRow.cells) || {};
  return '<tr data-row="item">' + cols.map(c => {
    const v = cells[c.key] != null ? cells[c.key] : '';
    const tv = tCells[c.key] != null ? String(tCells[c.key]) : '';
    const transBlock = tv ? `<div class="fa-trans-inline">${esc(tv).replace(/\n/g,'<br>')}</div>` : '';
    // Checklist column (e.g. Observations): every line is its own tickable item
    if (c.checklist) {
      const items = String(v).split('\n').map(s => s.trim()).filter(Boolean);
      const tItems = String(tv).split('\n').map(s => s.trim()).filter(Boolean);
      const inner = items.length ? items.map((it, idx) => {
        const checked = /^☑/.test(it);
        const label = it.replace(/^[☐☑•·‐–—\-]+\s*/, '');
        const trans = tItems[idx] ? `<span class="fa-trans-inline" style="display:block;margin-left:22px">${esc(tItems[idx].replace(/^[☐☑•·‐–—\-]+\s*/, ''))}</span>` : '';
        const enItem = `<label class="gcl-item"><input type="checkbox" class="gcl" value="${esc(label)}" ${checked?'checked':''}> <span>${esc(label)}</span></label>`;
        return faOrder(enItem, trans);
      }).join('') : '';
      return `<td class="grid-checklist" data-c="${esc(c.key)}">${inner}</td>`;
    }
    if (c.check) return `<td class="grid-checkcell"><input type="checkbox" class="gc" data-c="${esc(c.key)}" ${v?'checked':''}></td>`;
    if (c.fill) return `<td class="grid-fillcell"><input class="gc" data-c="${esc(c.key)}" value="${esc(v)}" placeholder="${c.label.includes('Date')?'Initials / Date':''}"></td>`;
    // Reference/content cell: show the full text with bullets & line breaks (expanded, read-only) + keep value
    if (String(v).trim()) return `<td class="grid-fixed grid-content-cell">${faOrder(esc(v).replace(/\n/g,'<br>'), transBlock)}<input type="hidden" class="gc" data-c="${esc(c.key)}" value="${esc(v)}"></td>`;
    return `<td><textarea class="gc gc-content fa-auto-grow" data-c="${esc(c.key)}" rows="2" oninput="autoGrowTextarea(this)">${esc(v)}</textarea>${transBlock}</td>`;
  }).join('') + actCell + '</tr>';
}
function addGridRow(btn, heading) {
  const wrap = btn.closest('.fa-gridwrap');
  const tbl = wrap.querySelector('.fa-grid');
  const cols = JSON.parse(tbl.dataset.cols);
  const row = heading ? { heading: '' } : { cells: {} };
  tbl.querySelector('.fa-gridbody').insertAdjacentHTML('beforeend', gridRowHtml(cols, row));
}

let faPhotos = {};
function previewPhoto(input) {
  const f = input.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { faPhotos[input.dataset.fid] = reader.result; const img = document.getElementById('photo-' + input.dataset.fid); if (img) { img.src = reader.result; img.classList.remove('hidden'); } };
  reader.readAsDataURL(f);
}

// Print the field assessment document (uses the browser print dialog → can Save as PDF)
function printFieldAssessment() {
  document.body.classList.add('printing-fa');
  window.print();
  setTimeout(() => document.body.classList.remove('printing-fa'), 500);
}

// Auto-grow a textarea to fit its content — used by Field Assessment comment/feedback boxes and grid cells.
// Resets height to 'auto' first so it shrinks back down when the user deletes lines.
function autoGrowTextarea(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  // +2px so the bottom line isn't clipped by the browser's internal padding rounding
  ta.style.height = (ta.scrollHeight + 2) + 'px';
}
// Size every existing .fa-auto-grow textarea on the page (for pre-filled content on edit / view).
function autoGrowAll(root) {
  (root || document).querySelectorAll('textarea.fa-auto-grow').forEach(autoGrowTextarea);
}

function pickComp(btn) { btn.parentElement.querySelectorAll('.comp-btn').forEach(b=>b.classList.remove('sel')); btn.classList.add('sel'); btn.parentElement.dataset.value = btn.dataset.v; }
function pickStar(s) { const wrap=s.parentElement; const v=+s.dataset.v; wrap.dataset.value=v; [...wrap.children].forEach(st=>st.classList.toggle('on', +st.dataset.v<=v)); }

function collectFaAnswers() {
  const answers = [];
  document.querySelectorAll('#fa-fields [data-fid]').forEach(el => {
    const fid = parseInt(el.dataset.fid); let value = '';
    if (el.dataset.grid) {
      const rows = [];
      el.querySelectorAll('.fa-gridbody > tr').forEach(tr => {
        if (tr.dataset.row === 'head') { rows.push({ heading: (tr.querySelector('.grid-headin')||{}).value || '' }); return; }
        const cells = {};
        tr.querySelectorAll('.gc').forEach(g => {
          const v = g.type === 'checkbox' ? (g.checked ? '✓' : '') : g.value;
          if (v) cells[g.dataset.c] = v;
        });
        // checklist cells: record which observation items were ticked
        tr.querySelectorAll('td.grid-checklist').forEach(td => {
          const ticked = [...td.querySelectorAll('.gcl:checked')].map(i => '☑ ' + i.value);
          if (ticked.length) cells[td.dataset.c] = ticked.join('\n');
        });
        rows.push({ cells });
      });
      value = JSON.stringify({ rows });
    }
    else if (el.dataset.sig) { const p = faSigPads['f-' + fid]; value = (p && !p.isEmpty()) ? p.cv.toDataURL('image/png') : ''; }
    else if (el.dataset.photo) { value = faPhotos[fid] || ''; }
    else if (el.classList.contains('fa-comp') || el.classList.contains('fa-rating')) value = el.dataset.value || '';
    else if (el.classList.contains('fa-radio')) { const c = el.querySelector('input:checked'); value = c ? c.value : ''; }
    else if (el.classList.contains('fa-checks')) value = [...el.querySelectorAll('input:checked')].map(c=>c.value).join(', ');
    else value = el.value || '';
    answers.push({ fieldId: fid, value });
  });
  return answers;
}

// ---- Signature pad (mouse + touch) ----
function initSigPad(who) {
  const cv = document.getElementById(who.startsWith('f-') ? 'sigf-' + who.slice(2) : 'sig-' + who);
  if (!cv) return;
  const ctx = cv.getContext('2d');
  ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
  let drawing = false, empty = true;
  const pos = e => { const r = cv.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return [ (t.clientX-r.left)*(cv.width/r.width), (t.clientY-r.top)*(cv.height/r.height) ]; };
  const start = e => { drawing = true; empty = false; const [x,y]=pos(e); ctx.beginPath(); ctx.moveTo(x,y); e.preventDefault(); };
  const move = e => { if(!drawing) return; const [x,y]=pos(e); ctx.lineTo(x,y); ctx.stroke(); e.preventDefault(); };
  const end = () => { drawing = false; };
  cv.onmousedown=start; cv.onmousemove=move; window.addEventListener('mouseup',end);
  cv.ontouchstart=start; cv.ontouchmove=move; cv.ontouchend=end;
  faSigPads[who] = { cv, isEmpty: () => empty, clear: () => { ctx.clearRect(0,0,cv.width,cv.height); empty=true; } };
}
function clearSig(who) { faSigPads[who] && faSigPads[who].clear(); }

async function submitFieldAssessment() {
  const empId = val('fa-emp');
  if (!empId) return toast('Select the trainee.', 'error');
  if (!faSigPads.trainee || faSigPads.trainee.isEmpty()) return toast('Trainee signature is required.', 'error');
  if (!faSigPads.trainer || faSigPads.trainer.isEmpty()) return toast('Trainer signature is required.', 'error');
  // required field check
  for (let i = 0; i < faTemplate.fields.length; i++) {
    const f = faTemplate.fields[i];
    if (!f.Required) continue;
    if (f.FieldType === 'grid' || f.FieldType === 'instructions') continue;
    if (f.FieldType === 'signature') { const p = faSigPads['f-'+f.FieldID]; if (!p || p.isEmpty()) return toast(`"${f.Label}" signature is required.`, 'error'); continue; }
    if (f.FieldType === 'photo') { if (!faPhotos[f.FieldID]) return toast(`"${f.Label}" photo is required.`, 'error'); continue; }
    const el = document.querySelector(`#fa-fields [data-fid="${f.FieldID}"]`);
    if (!el) continue;
    let v = (el.classList.contains('fa-comp')||el.classList.contains('fa-rating')) ? el.dataset.value
      : el.classList.contains('fa-radio') ? (el.querySelector('input:checked')||{}).value : el.value;
    if (!v) return toast(`"${f.Label}" is required.`, 'error');
  }
  const trainerSel = document.getElementById('fa-trainer');
  const d = {
    templateId: faTemplate.TemplateID, empId,
    trainerId: val('fa-trainer') || null,
    trainerName: trainerSel.value ? trainerSel.options[trainerSel.selectedIndex].text : '',
    assessDate: val('fa-date'), location: val('fa-loc'),
    answers: collectFaAnswers(),
    traineeSignature: faSigPads.trainee.cv.toDataURL('image/png'),
    trainerSignature: faSigPads.trainer.cv.toDataURL('image/png')
  };
  const r = await POST('/api/forms/submit', d);
  if (!ok(r)) return;
  const host = document.getElementById('fa-form');
  host.innerHTML = `<div class="card"><div class="card-body"><div class="empty-state">
    <div class="icon">${r.passed?'🎉':'📋'}</div>
    <h2 style="font-size:32px;color:${r.passed?'var(--success)':'var(--danger)'}">${r.score}% — ${r.passed?'COMPETENT':'NOT YET COMPETENT'}</h2>
    ${r.qualificationAwarded?'<p class="mt-1">🎓 Qualification awarded and recorded under the trainee.</p>':'<p class="mt-1 text-muted">Assessment stored under the trainee.</p>'}
    ${r.email && r.email.sent ? `<p class="mt-1">📧 Copy emailed to area supervisor <strong>${esc(r.email.supervisor||'')}</strong> (${esc(r.email.to)}) for sign-off.</p>`
      : (r.passed && r.email && r.email.reason && !r.email.skipped ? `<p class="mt-1 text-muted">📧 Supervisor email not sent: ${esc(r.email.reason)}</p>` : '')}
    <div class="flex gap-2 mt-2" style="justify-content:center;flex-wrap:wrap">
      ${r.registerId ? `<button class="btn btn-accent" onclick="generateCertificate(${r.examId||0},'')">🏆 Get Certificate</button>` : ''}
      <button class="btn btn-outline" onclick="viewSubmission(${r.SubmissionID})">View Record</button>
      <button class="btn btn-ghost" onclick="loadFieldAssess()">New Assessment</button>
    </div>
  </div></div></div>`;
  await loadLookupCache(); refreshNotifBadge();
}

// ---- Submission view / print ----
function renderSubmittedGrid(answer, field) {
  const cfg = field && field.Options && field.Options.columns ? field.Options : null;
  if (!cfg) return `<strong>${esc(answer.Label||'')}</strong>`;
  const cols = cfg.columns;
  let parsed = {}; try { parsed = JSON.parse(answer.Value || '{}'); } catch {}
  const rows = parsed.rows || cfg.rows || [];
  let h = `<div style="font-weight:700;margin:6px 0">${esc(answer.Label||'')}</div><table class="rec-grid"><thead><tr>${cols.map(c=>`<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>`;
  rows.forEach(row => {
    if (row.heading != null && row.cells == null) { h += `<tr><td colspan="${cols.length}" style="background:#f1f3f7;font-weight:700">${esc(row.heading)}</td></tr>`; return; }
    const cells = row.cells || {};
    h += '<tr>' + cols.map(c => `<td>${esc(cells[c.key]||'').replace(/\n/g,'<br>')}</td>`).join('') + '</tr>';
  });
  return h + '</tbody></table>';
}

async function viewSubmission(id) {
  const s = await GET('/api/forms/submissions/' + id);
  if (!s) return;
  const fieldMap = {}; (s.templateFields||[]).forEach(f => fieldMap[f.FieldID] = f);
  const ansRows = (s.answers||[]).map(a => {
    if (a.FieldType === 'section' || a.FieldType === 'instructions') return `<tr><td colspan="2" style="background:var(--surface-2);font-weight:700">${esc(a.Label)}</td></tr>`;
    if (a.FieldType === 'signature') return `<tr><td>${esc(a.Label||'')}</td><td>${a.Value?`<img class="sig-img" src="${a.Value}">`:'<span class="cell-sub">not signed</span>'}</td></tr>`;
    if (a.FieldType === 'photo') return `<tr><td>${esc(a.Label||'')}</td><td>${a.Value?`<img class="sig-img" src="${a.Value}">`:'<span class="cell-sub">no photo</span>'}</td></tr>`;
    if (a.FieldType === 'grid') return `<tr><td colspan="2">${renderSubmittedGrid(a, fieldMap[a.FieldID])}</td></tr>`;
    return `<tr><td>${esc(a.Label||'')}</td><td><strong>${esc(a.Value||'')}</strong>${a.Points?` <span class="cell-sub">(${a.Points} pts)</span>`:''}</td></tr>`;
  }).join('');
  // Branded header — company logo top-left, name + assessment title to the right (same block as the live take-form view)
  const subCoName = (cache.company && cache.company.name) ? cache.company.name : '';
  const subCoLogo = (cache.company && cache.company.logo) ? cache.company.logo : '';
  const subBrand = `<div class="fa-brand">
    ${subCoLogo ? `<img src="${esc(subCoLogo)}" alt="${esc(subCoName || 'Company logo')}" class="fa-brand-logo">` : '<div class="fa-brand-logo fa-brand-logo-placeholder"></div>'}
    <div class="fa-brand-text">
      ${subCoName ? `<div class="fa-brand-co">${esc(subCoName)}</div>` : ''}
      <div class="fa-brand-title">${esc(s.TemplateName || 'Assessment Record')}</div>
    </div>
  </div>`;
  document.getElementById('submission-body').innerHTML = `
    <div id="submission-print">
      ${subBrand}
      <div class="flex" style="justify-content:space-between;align-items:flex-start">
        <div><h2 style="font-size:18px">${esc(s.TemplateName||'')}</h2>
          <div class="cell-sub">Trainee: <strong>${esc((s.LastName||'')+', '+(s.FirstName||''))}</strong> ${s.FileNum?'· '+esc(s.FileNum):''}</div>
          <div class="cell-sub">Trainer: ${esc(s.TrainerName||'')} · ${fmtDate(s.AssessDate)} ${s.Location?'· '+esc(s.Location):''}</div></div>
        <div style="text-align:right"><div class="badge ${s.Passed?'badge-active':'badge-expired'}" style="font-size:14px">${s.Score}% ${s.Passed?'PASS':'FAIL'}</div>
          ${s.CertName&&s.Passed?`<div class="cell-sub mt-1">🎓 ${esc(s.CertName)} awarded</div>`:''}</div>
      </div>
      ${parseMaterial(s.MaterialLink).map(m=>`<div class="mt-1 cell-sub">📚 ${esc(m.label||'')}: ${/^(\\\\|file:|[a-zA-Z]:\\)/.test(m.url||'')?`<code>${esc(m.url)}</code>`:`<a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.url)}</a>`}</div>`).join('')}
      <table class="mt-2"><tbody>${ansRows}</tbody></table>
      ${s.Notes?`<p class="mt-1"><strong>Notes:</strong> ${esc(s.Notes)}</p>`:''}
      <div class="sig-grid mt-2">
        <div><div class="cell-sub">Trainee signature</div><img class="sig-img" src="${s.TraineeSignature||''}"><div class="cell-sub">${s.TraineeSignedAt?new Date(s.TraineeSignedAt).toLocaleString():''}</div></div>
        <div><div class="cell-sub">Trainer signature</div><img class="sig-img" src="${s.TrainerSignature||''}"><div class="cell-sub">${s.TrainerSignedAt?new Date(s.TrainerSignedAt).toLocaleString():''}</div></div>
      </div>
    </div>
    <div class="sup-signoff mt-2" data-noprint-edit>
      <div class="cell-sub" style="font-weight:700">Area Supervisor / Manager sign-off</div>
      ${s.SupervisorSignature
        ? `<img class="sig-img" src="${s.SupervisorSignature}"><div class="cell-sub">${esc(s.SupervisorName||'')} · ${s.SupervisorSignedAt?new Date(s.SupervisorSignedAt).toLocaleString():''}</div>`
        : (s.Passed ? `
          <div class="alert alert-warning"><span>✍️</span><div>This competent assessment is awaiting the area supervisor's signature.</div></div>
          <input id="sup-name" placeholder="Supervisor / Manager name" style="max-width:320px;padding:9px 12px;border:1.5px solid var(--border-strong);border-radius:8px;margin-bottom:8px">
          <canvas class="sigpad" id="sig-supervisor" width="600" height="150"></canvas>
          <div class="flex gap-2"><button class="btn btn-outline btn-sm" onclick="clearSig('supervisor')">Clear</button>
            <button class="btn btn-accent btn-sm" onclick="saveSupervisorSign(${s.SubmissionID})">Save Supervisor Signature</button></div>`
          : '<div class="cell-sub">Not applicable (assessment not competent).</div>')}
    </div>`;
  window.subViewId = id;   // remembered for the "Download as Word" button in the modal footer
  showModal('submission-modal');
  if (s.Passed && !s.SupervisorSignature) setTimeout(() => initSigPad('supervisor'), 80);
}

async function saveSupervisorSign(id) {
  if (!faSigPads.supervisor || faSigPads.supervisor.isEmpty()) return toast('Please sign before saving.', 'error');
  const r = await POST(`/api/forms/submissions/${id}/supervisor-sign`, { signature: faSigPads.supervisor.cv.toDataURL('image/png'), name: val('sup-name') });
  if (!ok(r)) return;
  toast('Area supervisor signature saved.');
  viewSubmission(id);
}
function printSubmission() {
  const c = document.getElementById('submission-print').innerHTML;
  const w = window.open('', '_blank');
  w.document.write(`<html><head><title>Assessment Record</title><style>
    body{font-family:Arial,sans-serif;padding:0;color:#1a1d28;margin:0}
    .ps-body{padding:24px 32px}
    table{width:100%;border-collapse:collapse;margin-top:12px}
    td{border:1px solid #ddd;padding:7px 10px;font-size:13px}.cell-sub{color:#666;font-size:12px}
    .badge{padding:3px 10px;border-radius:12px;font-weight:700}.sig-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:18px}
    .sig-img{border:1px solid #ccc;border-radius:6px;max-width:100%;height:120px;object-fit:contain}a{color:#4f46e5}
    /* Branded header — mirrors the in-app .fa-brand block so the print is on-brand */
    .fa-brand{display:flex;align-items:center;gap:18px;padding:14px 32px;border-bottom:3px solid #1E3A5F;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .fa-brand-logo{max-height:72px;max-width:200px;object-fit:contain;flex:0 0 auto}
    .fa-brand-logo-placeholder{width:120px;height:60px;background:#f1f5f9;border:1px dashed #cbd5e1;border-radius:4px}
    .fa-brand-text{flex:1;min-width:0}
    .fa-brand-co{font-size:12px;font-weight:700;color:#1E3A5F;letter-spacing:.4px;text-transform:uppercase}
    .fa-brand-title{font-size:18px;font-weight:700;color:#0f172a;line-height:1.25;margin-top:2px}
    @media print{.fa-brand{padding:6mm 8mm 4mm;page-break-after:avoid}.fa-brand-logo{max-height:18mm;max-width:48mm}.ps-body{padding:6mm 8mm}}
  </style></head>
    <body><div class="ps-body">${c}</div></body></html>`);
  w.document.close(); w.focus(); setTimeout(()=>w.print(), 300);
}

// ---- Shift Roster ----
let rosterView = 'day';
let rosterRef = new Date();
// Shift types are user-defined and loaded from the backend into cache.shiftTypes.
// Fallback colours used until they load.
const SHIFT_COLORS = { Day:'#0ea5e9', Night:'#6366f1', Early:'#10b981', Late:'#f59e0b', Off:'#cbd5e1' };
// Auto-colour palette for Setup List shifts that have no ShiftType entry
const AUTO_PALETTE = ['#0ea5e9','#6366f1','#10b981','#f59e0b','#ec4899','#14b8a6','#8b5cf6','#f97316','#06b6d4','#84cc16'];

function shiftColor(lbl) {
  if (!lbl) return '#aaa';
  const t = (cache.shiftTypes||[]).find(s => (s.Label||'').toLowerCase() === lbl.toLowerCase());
  if (t) return t.Color || '#F58220';
  // Auto-colour from Setup List shifts
  const sl = (cache.setupShifts||[]);
  const idx = sl.findIndex(s => (s.Shift||'').toLowerCase() === lbl.toLowerCase());
  if (idx >= 0) return AUTO_PALETTE[idx % AUTO_PALETTE.length];
  return SHIFT_COLORS[lbl] || '#F58220';
}
function shiftIsOff(lbl) {
  const t = (cache.shiftTypes||[]).find(s => (s.Label||'').toLowerCase() === (lbl||'').toLowerCase());
  if (t) return !!t.IsOff;
  return /^off$/i.test(lbl||'');
}

// Build <option> tags from configured Shift Types only (Off first)
function buildShiftOptions(selected) {
  const used = new Set();
  const opts = [];
  const sel = s => (selected||'').toLowerCase() === s.toLowerCase() ? ' selected' : '';
  opts.push(`<option value="Off"${!selected||selected==='Off'?' selected':''}>Off</option>`);
  used.add('off');
  for (const s of cache.shiftTypes||[]) {
    const key = (s.Label||'').toLowerCase(); if (used.has(key)) continue; used.add(key);
    opts.push(`<option value="${esc(s.Label)}"${sel(s.Label)}>${esc(s.Label)}${s.StartTime?` (${s.StartTime}${s.EndTime?'–'+s.EndTime:''})`:''}</option>`);
  }
  return opts.join('');
}

// Load shift types + Setup List shifts; refresh selects and datalists
async function loadShiftTypes() {
  const [types, setupShifts] = await Promise.all([
    GET('/api/roster/shift-types'),
    GET('/api/lookup/shifts')
  ]);
  cache.shiftTypes   = types || [];
  cache.setupShifts  = setupShifts || [];

  // Populate the entry modal shift select — Shift Types first, then Setup List shifts
  const reShift = document.getElementById('re-Shift');
  if (reShift && reShift.tagName === 'SELECT') {
    const cur = reShift.value;
    const used = new Set();
    let opts = '';
    // Configured shift types (with colour/times)
    for (const s of cache.shiftTypes||[]) {
      const key = (s.Label||'').toLowerCase(); if (used.has(key)) continue; used.add(key);
      opts += `<option value="${esc(s.Label)}"${cur===s.Label?' selected':''}>${esc(s.Label)}${s.StartTime?` (${s.StartTime}${s.EndTime?'–'+s.EndTime:''})`:''}</option>`;
    }
    // Setup List shifts (Panels etc) not already listed
    if (cache.setupShifts.length) {
      opts += `<option disabled>──────────</option>`;
      for (const s of cache.setupShifts||[]) {
        const key = (s.Shift||'').toLowerCase(); if (used.has(key)) continue; used.add(key);
        opts += `<option value="${esc(s.Shift)}"${cur===s.Shift?' selected':''}>${esc(s.Shift)}</option>`;
      }
    }
    reShift.innerHTML = opts;
  }

  // Populate the roster shift filter dropdown — only from configured ShiftTypes, not Setup List
  const sf = document.getElementById('roster-shiftfilter');
  if (sf) {
    const cur = sf.value;
    const used = new Set(['off']);
    let opts = '<option value="">All Shifts</option>';
    for (const s of cache.shiftTypes||[]) {
      if (!s.IsOff && !used.has((s.Label||'').toLowerCase())) {
        used.add((s.Label||'').toLowerCase());
        opts += `<option value="${esc(s.Label)}"${cur===s.Label?' selected':''}>${esc(s.Label)}</option>`;
      }
    }
    sf.innerHTML = opts;
  }

  // Keep datalists working for any other text inputs that use them
  const typeLabels = new Set(cache.shiftTypes.map(s => (s.Label||'').toLowerCase()));
  const dlOpts = cache.shiftTypes.map(s =>
    `<option value="${esc(s.Label)}">${esc(s.Label)}</option>`).join('')
    + cache.setupShifts.filter(s => !typeLabels.has((s.Shift||'').toLowerCase()))
      .map(s => `<option value="${esc(s.Shift)}">${esc(s.Shift)}</option>`).join('');
  document.querySelectorAll('datalist#shift-labels').forEach(dl => dl.innerHTML = dlOpts);

  return cache.shiftTypes;
}
const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

function setRosterView(v) {
  rosterView = v;
  ['day','month','year'].forEach(x => document.getElementById('rv-'+x).classList.toggle('active', x===v));
  loadRoster();
}
function rosterMove(dir) {
  if (dir === 0) rosterRef = new Date();
  else if (rosterView === 'day') rosterRef.setDate(rosterRef.getDate() + dir);
  else if (rosterView === 'month') rosterRef.setMonth(rosterRef.getMonth() + dir);
  else rosterRef.setFullYear(rosterRef.getFullYear() + dir);
  loadRoster();
}

async function loadRoster() {
  if (!cache.shiftTypes) await loadShiftTypes();
  if (rosterView === 'day') return renderRosterDay();
  if (rosterView === 'month') return renderRosterMonth();
  return renderRosterYear();
}

function rosterLegend() {
  const types = cache.shiftTypes && cache.shiftTypes.length ? cache.shiftTypes
    : Object.entries(SHIFT_COLORS).map(([Label,Color]) => ({ Label, Color }));
  document.getElementById('roster-legend').innerHTML = types
    .map(t => `<span class="rl-item"><i style="background:${t.Color||'#F58220'}"></i>${esc(t.Label)}</span>`).join('')
    + ` <button class="btn btn-ghost btn-sm" style="padding:2px 8px" onclick="openShiftTypesModal()">⚙ Manage</button>`;
}

async function renderRosterDay() {
  const ds = ymd(rosterRef);
  document.getElementById('roster-period').textContent = rosterRef.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  rosterLegend();
  const pt = val('roster-persontype');
  const sf = (document.getElementById('roster-shiftfilter')||{}).value || '';
  let rows = await GET(`/api/roster?from=${ds}&to=${ds}${pt?'&personType='+pt:''}`) || [];
  if (sf) rows = rows.filter(r => (r.ShiftLabel||'').toLowerCase() === sf.toLowerCase());
  // Pull approved leave bookings that cover this date — they override the "on duty" status
  const leaveOnDay = await GET(`/api/leave/bookings?status=Approved&from=${ds}&to=${ds}`) || [];
  const leaveByEmp = {};
  leaveOnDay.forEach(b => { leaveByEmp[b.EmpID] = b; });
  // On-duty = not on an IsOff shift AND not on approved leave
  const onduty = rows.filter(r => !shiftIsOff(r.ShiftLabel) && !(r.PersonType === 'employee' && leaveByEmp[r.PersonID]));
  const offRows = rows.filter(r => shiftIsOff(r.ShiftLabel));
  const leaveRows = rows.filter(r => r.PersonType === 'employee' && leaveByEmp[r.PersonID]);
  const classes = await GET(`/api/classes/calendar?from=${ds}&to=${ds}`) || [];
  document.getElementById('roster-view').innerHTML = `
    <div class="dash-grid">
      <div>
        <h4 class="rsec">👥 On Duty (${onduty.length})</h4>
        ${onduty.length ? `<div class="table-responsive"><table><thead><tr><th>Name</th><th>Type</th><th>Shift</th><th>Hours</th><th></th></tr></thead>
        <tbody>${onduty.map(r => `<tr>
          <td class="cell-strong">${esc(r.PersonName||'?')}</td>
          <td>${r.PersonType==='trainer'?'👨‍🏫 Trainer':'👤 '+esc(r.Department||'Employee')}</td>
          <td><span class="shift-chip" style="background:${shiftColor(r.ShiftLabel)}">${esc(r.ShiftLabel||'')}</span></td>
          <td>${r.StartTime||''}${r.EndTime?'–'+r.EndTime:''}</td>
          <td><button class="btn btn-danger btn-sm btn-icon" onclick="delRosterEntry(${r.RosterID})">🗑️</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="cell-sub">No one on duty this day.</p>'}
        ${leaveRows.length ? `<h4 class="rsec" style="margin-top:14px">🏖️ On Leave (${leaveRows.length})</h4>
        <div class="table-responsive"><table><thead><tr><th>Name</th><th>Leave Type</th><th>Period</th></tr></thead>
        <tbody>${leaveRows.map(r => { const lv = leaveByEmp[r.PersonID]; return `<tr>
          <td class="cell-strong">${esc(r.PersonName||'?')}</td>
          <td><span class="shift-chip" style="background:${esc(lv.LeaveTypeColor||'#3b82f6')}">${esc(lv.LeaveTypeName)}</span></td>
          <td class="cell-sub">${esc(lv.StartDate)} → ${esc(lv.EndDate)}</td>
        </tr>`; }).join('')}</tbody></table></div>` : ''}
        ${offRows.length ? `<h4 class="rsec" style="margin-top:14px">💤 Off / Not on duty (${offRows.length})</h4>
        <div class="table-responsive"><table><thead><tr><th>Name</th><th>Status</th></tr></thead>
        <tbody>${offRows.map(r => `<tr>
          <td>${esc(r.PersonName||'?')}</td>
          <td><span class="cell-sub">${esc(r.ShiftLabel||'Off')}</span></td>
        </tr>`).join('')}</tbody></table></div>` : ''}
      </div>
      <div>
        <h4 class="rsec">🎓 Training Scheduled
          <button class="btn btn-accent btn-sm ml-auto" onclick="scheduleTrainingOn('${ds}')">+ Schedule Training</button></h4>
        ${classes.length ? classes.map(c => `<div class="roster-class" onclick="viewRoster(${c.ClassID})">
          <strong>${esc(c.ClassName||c.CertName||'Class')}</strong>
          <div class="cell-sub">${c.TimeStart||''}${c.TimeEnd?'–'+c.TimeEnd:''} ${c.TrainerLast?'· '+esc(c.TrainerFirst+' '+c.TrainerLast):''} · ${c.Enrolled||0} booked</div>
        </div>`).join('') : '<p class="cell-sub">No training scheduled. Use the button above — you can see who is on duty to the left.</p>'}
      </div>
    </div>`;
}

async function renderRosterMonth() {
  const y = rosterRef.getFullYear(), m = rosterRef.getMonth();
  const first = new Date(y, m, 1), last = new Date(y, m+1, 0);
  document.getElementById('roster-period').textContent = first.toLocaleDateString('en-US',{month:'long',year:'numeric'});
  rosterLegend();
  const pt = val('roster-persontype');
  const sf = (document.getElementById('roster-shiftfilter')||{}).value || '';
  // Pull roster + training classes + APPROVED leave bookings overlapping this month, in parallel
  const [rowsRaw, classesArr, leaveRows] = await Promise.all([
    GET(`/api/roster?from=${ymd(first)}&to=${ymd(last)}${pt?'&personType='+pt:''}`),
    GET(`/api/classes/calendar?from=${ymd(first)}&to=${ymd(last)}`),
    GET(`/api/leave/bookings?status=Approved&from=${ymd(first)}&to=${ymd(last)}`)
  ]);
  let rows = rowsRaw || [];
  if (sf) rows = rows.filter(r => (r.ShiftLabel||'').toLowerCase() === sf.toLowerCase());
  // Build a fast EmpID → leave overlay map (one entry per day in the booking range that intersects the month)
  const leaveByEmpDay = {};
  (leaveRows || []).forEach(b => {
    const start = new Date(b.StartDate + 'T00:00:00');
    const end   = new Date(b.EndDate   + 'T00:00:00');
    for (let d = new Date(Math.max(first, start)); d <= end && d <= last; d.setDate(d.getDate()+1)) {
      const key = `${b.EmpID}|${ymd(d)}`;
      leaveByEmpDay[key] = b;
    }
  });
  const byDay = {};
  rows.forEach(r => {
    if (shiftIsOff(r.ShiftLabel)) return;
    const lv = r.PersonType === 'employee' ? leaveByEmpDay[`${r.PersonID}|${r.RosterDate}`] : null;
    if (lv) {
      r = { ...r, _leaveType: lv.LeaveTypeName, _leaveColor: lv.LeaveTypeColor, _leaveBookingId: lv.BookingID };
    }
    (byDay[r.RosterDate] = byDay[r.RosterDate] || []).push(r);
  });
  const clsByDay = {}; (classesArr||[]).forEach(c => { (clsByDay[c.ClassDate]=clsByDay[c.ClassDate]||[]).push(c); });
  const dows = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let html = '<div class="cal-grid">' + dows.map(d=>`<div class="cal-dow">${d}</div>`).join('');
  for (let i=0;i<first.getDay();i++) html += '<div class="cal-cell cal-empty"></div>';
  const todayS = ymd(new Date());
  for (let day=1; day<=last.getDate(); day++) {
    const ds = `${y}-${String(m+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const ppl = byDay[ds]||[]; const cls = clsByDay[ds]||[];
    html += `<div class="cal-cell${ds===todayS?' cal-today':''}">
      <div class="cal-daynum" style="cursor:pointer" onclick="rosterRef=new Date('${ds}T00:00:00');setRosterView('day')">${day}</div>
      <div class="roster-count">${ppl.length?`<span class="rc-badge">👥 ${ppl.length}</span>`:''}${cls.length?`<span class="rc-badge rc-train">🎓 ${cls.length}</span>`:''}</div>
      ${ppl.slice(0,3).map(r => {
        const color = r._leaveColor || shiftColor(r.ShiftLabel);
        const label = r._leaveType ? `🏖️ ${r._leaveType}` : r.ShiftLabel;
        const tip = r._leaveType ? `${r.PersonName} — on ${r._leaveType}` : `${r.PersonName} — ${r.ShiftLabel||''} (click to edit)`;
        return `<div class="roster-mini" style="border-left-color:${color};cursor:pointer" title="${esc(tip)}" onclick="event.stopPropagation();rosterEditEntry(${r.RosterID},'${esc(r.PersonName||'').replace(/'/g,"&#39;")}','${ds}',${r.PersonID||'null'})">${esc(r.PersonName||'')} <span class="cell-sub">${esc(label||'')}</span></div>`;
      }).join('')}
      ${ppl.length>3?`<div class="cell-sub" style="cursor:pointer" onclick="rosterRef=new Date('${ds}T00:00:00');setRosterView('day')">+${ppl.length-3} more</div>`:''}
    </div>`;
  }
  html += '</div>';
  document.getElementById('roster-view').innerHTML = html;
}

// ── Inline editor for a single roster entry from the monthly view ─────────
// Lets the admin swap the shift type (writes tblRoster) or book a single-day leave
// (writes an approved tblLeaveBooking which auto-overlays on attendance + this view).
async function rosterEditEntry(rosterId, personName, dateStr, empId) {
  // Ensure dropdown data is loaded
  if (!cache.shiftTypes || !cache.shiftTypes.length) await loadShiftTypes();
  let leaveTypes = [];
  try { leaveTypes = (await GET('/api/leave/types')) || []; } catch {}
  // Fetch the current row (the roster list gives us label+times but not necessarily fresh)
  const row = (await GET(`/api/roster?from=${dateStr}&to=${dateStr}&personType=employee`) || [])
    .find(r => r.RosterID === rosterId) || {};
  const shiftOpts = (cache.shiftTypes || []).map(t =>
    `<option value="${esc(t.Label)}" data-start="${t.StartTime||''}" data-end="${t.EndTime||''}" ${t.Label===row.ShiftLabel?'selected':''}>${esc(t.Label)}${t.StartTime?` (${t.StartTime}-${t.EndTime||''})`:''}</option>`
  ).join('');
  const leaveOpts = leaveTypes.filter(l => l.Active !== 0).map(l =>
    `<option value="${l.LeaveTypeID}" data-color="${esc(l.Color)}">${esc(l.Name)}</option>`
  ).join('');
  const html = `<div class="modal-overlay" id="rost-edit-modal" onclick="if(event.target===this)this.remove()">
    <div class="modal" style="max-width:540px">
      <div class="modal-header"><h3>Edit roster — ${esc(personName)}</h3><button class="btn btn-ghost btn-sm" onclick="document.getElementById('rost-edit-modal').remove()">✕</button></div>
      <div class="modal-body" style="padding:18px;display:flex;flex-direction:column;gap:14px">
        <div class="cell-sub">Date: <strong>${esc(dateStr)}</strong></div>

        <fieldset style="border:1px solid #e2e8f0;border-radius:8px;padding:12px">
          <legend style="font-size:12px;font-weight:700;color:#1E3A5F;padding:0 6px">SHIFT TYPE</legend>
          <div class="form-row"><label>Shift</label>
            <select id="rost-shift" onchange="rosterSyncShiftHours(this)">${shiftOpts}</select></div>
          <div style="display:flex;gap:10px">
            <div class="form-row" style="flex:1"><label>Start</label><input id="rost-start" type="time" value="${esc(row.StartTime||'')}"></div>
            <div class="form-row" style="flex:1"><label>End</label><input id="rost-end" type="time" value="${esc(row.EndTime||'')}"></div>
          </div>
          <div class="form-row"><label>Note</label><input id="rost-note" value="${esc(row.Note||'')}"></div>
          <div class="flex gap-2 mt-1">
            <button class="btn btn-primary btn-sm" onclick="rosterSaveShift(${rosterId})">💾 Save shift</button>
            <button class="btn btn-danger btn-sm" onclick="rosterDeleteEntry(${rosterId})">🗑 Delete this day</button>
          </div>
        </fieldset>

        ${empId ? `<fieldset style="border:1px solid #e2e8f0;border-radius:8px;padding:12px">
          <legend style="font-size:12px;font-weight:700;color:#1E3A5F;padding:0 6px">OR MARK ON LEAVE</legend>
          <div style="display:flex;gap:10px;align-items:end">
            <div class="form-row" style="flex:2"><label>Leave Type</label>
              <select id="rost-leave-type">${leaveOpts || '<option value="">No leave types defined</option>'}</select></div>
            <div class="form-row" style="flex:1"><label>From</label><input id="rost-leave-from" type="date" value="${esc(dateStr)}"></div>
            <div class="form-row" style="flex:1"><label>To</label><input id="rost-leave-to" type="date" value="${esc(dateStr)}"></div>
          </div>
          <div class="form-row"><label>Reason</label><input id="rost-leave-reason" placeholder="Optional"></div>
          <button class="btn btn-accent btn-sm mt-1" onclick="rosterBookLeave(${empId}, '${esc(dateStr)}')">🏖️ Book approved leave</button>
          <div class="cell-sub" style="margin-top:6px">Leave bookings auto-display as a 🏖️ overlay on this calendar AND on the Attendance page — the underlying shift is preserved.</div>
        </fieldset>` : '<div class="cell-sub">Leave bookings only apply to employees (not trainers).</div>'}
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="document.getElementById('rost-edit-modal').remove()">Close</button>
      </div>
    </div></div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}
window.rosterEditEntry = rosterEditEntry;

// Pre-fill Start/End times when shift type changes (matches the pattern editor's behavior)
window.rosterSyncShiftHours = function(sel) {
  const opt = sel.options[sel.selectedIndex];
  if (!opt) return;
  const startEl = document.getElementById('rost-start');
  const endEl   = document.getElementById('rost-end');
  if (opt.dataset.start) startEl.value = opt.dataset.start;
  if (opt.dataset.end)   endEl.value   = opt.dataset.end;
};

window.rosterSaveShift = async function(rosterId) {
  const body = {
    ShiftLabel: val('rost-shift'),
    StartTime: val('rost-start') || null,
    EndTime: val('rost-end') || null,
    Note: val('rost-note')
  };
  const r = await PUT('/api/roster/' + rosterId, body);
  if (!ok(r)) return;
  toast('Shift updated.');
  document.getElementById('rost-edit-modal')?.remove();
  loadRoster();
};

window.rosterDeleteEntry = async function(rosterId) {
  if (!confirm('Delete this roster entry?')) return;
  const r = await DEL('/api/roster/' + rosterId);
  if (!ok(r)) return;
  toast('Deleted.');
  document.getElementById('rost-edit-modal')?.remove();
  loadRoster();
};

window.rosterBookLeave = async function(empId, dateStr) {
  const leaveTypeId = parseInt(val('rost-leave-type'), 10);
  const from = val('rost-leave-from') || dateStr;
  const to   = val('rost-leave-to')   || dateStr;
  const reason = val('rost-leave-reason');
  if (!leaveTypeId) { toast('Pick a leave type.', 'error'); return; }
  if (!from || !to) { toast('From and To dates required.', 'error'); return; }
  const body = { EmpID: empId, LeaveTypeID: leaveTypeId, StartDate: from, EndDate: to, Status: 'Approved', Reason: reason };
  const r = await POST('/api/leave/bookings', body);
  if (!ok(r)) return;
  toast('Approved leave booked.');
  document.getElementById('rost-edit-modal')?.remove();
  loadRoster();
};

async function renderRosterYear() {
  const y = rosterRef.getFullYear();
  document.getElementById('roster-period').textContent = y;
  document.getElementById('roster-legend').innerHTML = '';
  const data = await GET(`/api/roster/year?year=${y}`) || [];
  const pt = val('roster-persontype');
  const filtered = pt ? data.filter(d => d.PersonType === pt) : data;
  const people = {};
  filtered.forEach(r => { const k = r.PersonType+'_'+r.PersonID; (people[k]=people[k]||{name:r.PersonName,type:r.PersonType,months:{}}); people[k].months[parseInt(r.Mon)] = r.Days; });
  const mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const keys = Object.keys(people);
  document.getElementById('roster-view').innerHTML = keys.length ? `
    <div class="table-responsive"><table><thead><tr><th>Person</th>${mn.map(m=>`<th style="text-align:center">${m}</th>`).join('')}<th style="text-align:center">Total</th></tr></thead>
    <tbody>${keys.map(k=>{ const p=people[k]; let tot=0;
      const cells = mn.map((_,i)=>{ const v=p.months[i+1]||0; tot+=v; return `<td style="text-align:center">${v?`<span class="yr-cell" style="opacity:${0.3+Math.min(1,v/22)*0.7}">${v}</span>`:''}</td>`; }).join('');
      return `<tr><td class="cell-strong">${p.type==='trainer'?'👨‍🏫 ':'👤 '}${esc(p.name||'?')}</td>${cells}<td style="text-align:center"><strong>${tot}</strong></td></tr>`;
    }).join('')}</tbody></table></div>
    <p class="cell-sub mt-1">Numbers are on-duty days per month (excludes Off days).</p>` : '<div class="empty-state"><div class="icon">🗂️</div><p>No roster data for '+y+'. Assign a shift pattern to get started.</p></div>';
}

function scheduleTrainingOn(ds) {
  navigateTo('classes');
  openClassModal();
  setVal('cl-ClassDate', ds);
}

async function delRosterEntry(id) {
  if (!confirm('Remove this shift?')) return;
  await DEL('/api/roster/' + id);
  toast('Shift removed.'); loadRoster();
}

// ---- Shift Types manager (flexible: Day / Night / Afternoon / Late / custom) ----
async function openShiftTypesModal() {
  await loadShiftTypes();
  resetShiftTypeForm();
  renderShiftTypesList();
  showModal('shifttypes-modal');
}
function renderShiftTypesList() {
  const list = document.getElementById('shifttypes-list');
  const types = cache.shiftTypes || [];
  list.innerHTML = types.length ? types.map(s => `
    <div class="file-row">
      <span class="shift-chip" style="background:${s.Color||'#F58220'}">${esc(s.Label)}</span>
      <div class="file-meta"><strong>${esc(s.Label)}</strong>
        <div class="cell-sub">${s.StartTime?`${s.StartTime}${s.EndTime?'–'+s.EndTime:''}`:'No set hours'}${s.IsOff?' · Off day (not on duty)':''}</div></div>
      <button class="btn btn-outline btn-sm" onclick="editShiftType(${s.ShiftTypeID})">Edit</button>
      <button class="btn btn-danger btn-sm btn-icon" onclick="deleteShiftType(${s.ShiftTypeID})">🗑️</button>
    </div>`).join('') : '<p class="cell-sub">No shift types yet — add one below.</p>';
}
function resetShiftTypeForm() {
  editingId.shiftType = null;
  setVal('st-Label',''); setVal('st-Color','#F58220'); setVal('st-Start',''); setVal('st-End','');
  const off = document.getElementById('st-IsOff'); if (off) off.checked = false;
  document.getElementById('shifttype-form-title').textContent = 'Add Shift Type';
}
function editShiftType(id) {
  const s = (cache.shiftTypes||[]).find(x => x.ShiftTypeID === id);
  if (!s) return;
  editingId.shiftType = id;
  setVal('st-Label', s.Label); setVal('st-Color', s.Color||'#F58220');
  setVal('st-Start', s.StartTime||''); setVal('st-End', s.EndTime||'');
  const off = document.getElementById('st-IsOff'); if (off) off.checked = !!s.IsOff;
  document.getElementById('shifttype-form-title').textContent = 'Edit: ' + s.Label;
}
async function saveShiftType() {
  const d = { Label: val('st-Label'), Color: val('st-Color'), StartTime: val('st-Start')||null, EndTime: val('st-End')||null, IsOff: document.getElementById('st-IsOff').checked };
  if (!d.Label) return toast('Shift name is required.', 'error');
  const btn = document.querySelector('#shifttypes-modal .btn-accent');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const editing = editingId.shiftType;
    const r = editing ? await PUT('/api/roster/shift-types/'+editing, d) : await POST('/api/roster/shift-types', d);
    if (!ok(r)) return;
    toast(editing ? 'Shift type updated.' : `"${d.Label}" shift added.`);
    await loadShiftTypes();
    resetShiftTypeForm();
    renderShiftTypesList();
    if (document.getElementById('page-roster').classList.contains('active')) loadRoster();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Shift Type'; }
  }
}
async function deleteShiftType(id) {
  if (!confirm('Delete this shift type? Roster entries already created keep their label.')) return;
  await DEL('/api/roster/shift-types/' + id);
  await loadShiftTypes();
  renderShiftTypesList();
  toast('Shift type deleted.');
}

// When a shift label is chosen in the entry modal, auto-fill its default times
function onEntryShiftChange() {
  const lbl = val('re-Shift');
  const t = (cache.shiftTypes||[]).find(s => (s.Label||'').toLowerCase() === lbl.toLowerCase());
  if (t) { if (t.StartTime) setVal('re-Start', t.StartTime); if (t.EndTime) setVal('re-End', t.EndTime); }
}

// Populate the pattern fill dropdown from Setup List shifts
function refreshPatFillDropdown() {
  const sel = document.getElementById('pat-fill-shift');
  if (!sel) return;
  const used = new Set();
  let opts = '<option value="">— select to fill all days —</option>';
  for (const s of cache.setupShifts||[]) {
    const key = (s.Shift||'').toLowerCase();
    if (used.has(key)) continue; used.add(key);
    opts += `<option value="${esc(s.Shift)}">${esc(s.Shift)}</option>`;
  }
  sel.innerHTML = opts;
}

// Fill every day row with the chosen shift/panel — also propagates the type's default
// Start/End times to rows that aren't in custom-hours mode.
function patFillAllDays() {
  const chosen = (document.getElementById('pat-fill-shift')||{}).value;
  if (!chosen) return toast('Select a shift/panel first.', 'error');
  document.querySelectorAll('#pattern-days .pd-label').forEach(sel => {
    if (![...sel.options].some(o => o.value === chosen)) {
      const opt = document.createElement('option');
      opt.value = chosen; opt.textContent = chosen;
      sel.appendChild(opt);
    }
    sel.value = chosen;
    // Re-trigger the auto-fill handler so each row picks up the type's hours
    pdayLabelChange(sel);
  });
}

// ---- Shift patterns ----
async function openPatternsModal() {
  await loadShiftTypes();
  refreshPatFillDropdown();
  resetPatternForm();
  await loadPatternsList();
  showModal('patterns-modal');
}
async function loadPatternsList() {
  const pats = await GET('/api/roster/patterns') || [];
  cache.patterns = pats;
  document.getElementById('patterns-list').innerHTML = pats.length ? pats.map(p => `
    <div class="file-row">
      <span class="shift-chip" style="background:${p.Color}">${p.CycleLength}d</span>
      <div class="file-meta"><strong>${esc(p.Name)}</strong>
        <div class="cell-sub">${p.days.map(d=>d.ShiftLabel? d.ShiftLabel[0]:'·').join('')} · ${esc(p.Description||'')}</div></div>
      <button class="btn btn-outline btn-sm" onclick="editPattern(${p.PatternID})">Edit</button>
      <button class="btn btn-danger btn-sm btn-icon" onclick="deletePattern(${p.PatternID})">🗑️</button>
    </div>`).join('') : '<p class="cell-sub">No patterns yet — define one below.</p>';
}
function renderPatternDays(existing) {
  const n = parseInt(val('pat-Cycle')) || 7;
  const wrap = document.getElementById('pattern-days');
  let html = '';
  for (let i=0;i<n;i++) {
    const d = (existing && existing[i]) || {};
    // A day is in "custom hours" mode if its saved Start/End differ from the shift-type defaults.
    // Default mode = auto-fill from the picked shift type (cache.shiftTypes lookup).
    const custom = pdayIsCustom(d.ShiftLabel, d.StartTime, d.EndTime);
    html += `<div class="pday" data-day-idx="${i}">
      <div class="pday-num">Day ${i+1}</div>
      <select class="pd-label" onchange="pdayLabelChange(this)">${buildShiftOptions(d.ShiftLabel || 'Off')}</select>
      <input class="pd-start" type="time" value="${d.StartTime||''}" ${custom?'':'readonly'}>
      <input class="pd-end" type="time" value="${d.EndTime||''}" ${custom?'':'readonly'}>
      <label class="pd-custom-toggle" title="Override the default hours for this day only" style="display:flex;align-items:center;gap:4px;font-size:11px;color:#64748b;white-space:nowrap">
        <input type="checkbox" class="pd-custom-cb" ${custom?'checked':''} onchange="pdayCustomToggle(this)">Custom hours
      </label>
    </div>`;
  }
  wrap.innerHTML = html;
}

// Look up a shift-type definition by name (case-insensitive match against cache.shiftTypes).
function pdayShiftTypeFor(label) {
  if (!label) return null;
  const want = String(label).trim().toLowerCase();
  return (cache.shiftTypes || []).find(t => (t.Label||'').toLowerCase() === want) || null;
}

// Decide whether the saved row used custom hours: if Start/End are set AND differ from the
// shift type's defaults, the user overrode them.
function pdayIsCustom(label, start, end) {
  const t = pdayShiftTypeFor(label);
  if (!t) return !!(start || end); // unknown shift type → treat any saved hours as custom
  if (!start && !end) return false;
  return (start || '') !== (t.StartTime || '') || (end || '') !== (t.EndTime || '');
}

// When the shift label changes and the row is NOT in custom mode, refill the times from the type.
window.pdayLabelChange = function(sel) {
  const row = sel.closest('.pday');
  if (!row) return;
  const cb = row.querySelector('.pd-custom-cb');
  const startEl = row.querySelector('.pd-start');
  const endEl = row.querySelector('.pd-end');
  if (cb && cb.checked) return; // user is overriding — leave alone
  const t = pdayShiftTypeFor(sel.value);
  startEl.value = t && t.StartTime ? t.StartTime : '';
  endEl.value = t && t.EndTime ? t.EndTime : '';
  startEl.readOnly = true; endEl.readOnly = true;
};

// Toggle a single day between auto-fill (locked, follows the type) and custom hours (editable).
window.pdayCustomToggle = function(cb) {
  const row = cb.closest('.pday');
  if (!row) return;
  const startEl = row.querySelector('.pd-start');
  const endEl = row.querySelector('.pd-end');
  if (cb.checked) {
    startEl.readOnly = false; endEl.readOnly = false;
    startEl.focus();
  } else {
    // Reset to the shift type's defaults
    const sel = row.querySelector('.pd-label');
    const t = pdayShiftTypeFor(sel ? sel.value : '');
    startEl.value = t && t.StartTime ? t.StartTime : '';
    endEl.value = t && t.EndTime ? t.EndTime : '';
    startEl.readOnly = true; endEl.readOnly = true;
  }
};
function resetPatternForm() {
  editingId.pattern = null;
  setVal('pat-Name',''); setVal('pat-Description',''); setVal('pat-Cycle','7'); setVal('pat-Color','#4f46e5');
  document.getElementById('pattern-form-title').textContent = 'New Pattern';
  renderPatternDays();
}
async function editPattern(id) {
  const p = await GET('/api/roster/patterns/' + id);
  if (!p) return;
  editingId.pattern = id;
  document.getElementById('pattern-form-title').textContent = 'Edit: ' + p.Name;
  setVal('pat-Name', p.Name); setVal('pat-Description', p.Description);
  setVal('pat-Cycle', p.CycleLength); setVal('pat-Color', p.Color || '#4f46e5');
  renderPatternDays(p.days);
}
async function savePattern() {
  const days = [...document.querySelectorAll('#pattern-days .pday')].map(row => ({
    ShiftLabel: row.querySelector('.pd-label').value.trim() || 'Off',
    StartTime: row.querySelector('.pd-start').value || null,
    EndTime: row.querySelector('.pd-end').value || null
  }));
  const d = { Name: val('pat-Name'), Description: val('pat-Description'), CycleLength: parseInt(val('pat-Cycle'))||days.length, Color: val('pat-Color'), days };
  if (!d.Name) return toast('Pattern name is required.', 'error');
  const editing = editingId.pattern;
  const r = editing ? await PUT('/api/roster/patterns/'+editing, d) : await POST('/api/roster/patterns', d);
  if (!ok(r)) return;
  toast(editing ? 'Pattern updated.' : 'Pattern created.');
  resetPatternForm(); loadPatternsList();
}
async function deletePattern(id) {
  if (!confirm('Delete this pattern? Existing roster days already generated are kept.')) return;
  await DEL('/api/roster/patterns/' + id);
  loadPatternsList();
}

// ---- Assign pattern ----
function peopleOptions(type) {
  if (type === 'trainer') return (cache.trainers||[]).map(t => ({ v: t.TrainerID, l: `${t.LastName}, ${t.FirstName}` }));
  return cache.staff.map(s => ({ v: s.StaffID, l: `${s.LastName}, ${s.FirstName}` })).sort((a,b)=>a.l.localeCompare(b.l));
}
async function openAssignModal() {
  const pats = await GET('/api/roster/patterns') || [];
  populateSelect('asg-PatternID', pats.map(p=>({v:p.PatternID,l:`${p.Name} (${p.CycleLength}d)`})), 'v','l');
  fillAssignPeople();
  const today = ymd(new Date());
  // Anchor defaults to the same date as From — that means "Cycle Day 1 = the date the user picked".
  // Auto-sync handler below keeps Anchor following From unless the user opens Advanced and overrides.
  setVal('asg-From', today); setVal('asg-Anchor', today);
  setVal('asg-To', '');
  const noEnd = document.getElementById('asg-NoEnd');
  if (noEnd) { noEnd.checked = true; document.getElementById('asg-To').disabled = true; }
  const clearAll = document.getElementById('asg-ClearAll');
  if (clearAll) clearAll.checked = false;
  // Auto-sync: whenever From changes, push the same value into Anchor — UNLESS the user has
  // explicitly opened Advanced and edited Anchor (we track that with a data flag).
  const fromEl = document.getElementById('asg-From');
  const anchorEl = document.getElementById('asg-Anchor');
  if (fromEl && anchorEl) {
    anchorEl.dataset.userOverride = '0';
    fromEl.oninput = () => { if (anchorEl.dataset.userOverride !== '1') anchorEl.value = fromEl.value; };
    anchorEl.oninput = () => { anchorEl.dataset.userOverride = '1'; };
  }
  showModal('assign-modal');
}
function fillAssignPeople() {
  populateSelect('asg-PersonID', peopleOptions(val('asg-PersonType')), 'v', 'l', false);
}
async function doAssignPattern() {
  const noEnd = (document.getElementById('asg-NoEnd')||{}).checked;
  const clearAll = (document.getElementById('asg-ClearAll')||{}).checked;
  const anchorEl = document.getElementById('asg-Anchor');
  // If user didn't open the Advanced section to override the anchor, force anchor=startDate
  // so "Cycle Day 1 = the chosen From date" — the intuitive default.
  const anchorOverridden = anchorEl && anchorEl.dataset.userOverride === '1';
  const d = {
    personType: val('asg-PersonType'), personId: val('asg-PersonID'), patternId: val('asg-PatternID'),
    startDate: val('asg-From'),
    endDate: noEnd ? '' : val('asg-To'),
    anchorDate: anchorOverridden ? val('asg-Anchor') : val('asg-From'),
    replace: document.getElementById('asg-Replace').checked,
    clearAll
  };
  if (!d.personId || !d.patternId || !d.startDate) return toast('Person, pattern and From date are required.', 'error');
  if (!noEnd && !d.endDate) return toast('Enter a To date or tick "Continue indefinitely".', 'error');
  if (clearAll && !confirm('This will DELETE every existing roster entry for this person (past and future) before generating the new cycle. Continue?')) return;
  const r = await POST('/api/roster/assign', d);
  if (!ok(r)) return;
  closeModal('assign-modal');
  const cleared = r.clearedAll ? ` · cleared ${r.clearedAll} previous shifts` : '';
  toast(`Roster generated — ${r.created} shift${r.created===1?'':'s'} created${r.openEnded ? ` (open-ended, ends ${r.horizonEnd})` : ''}${cleared}.`);
  loadRoster();
}

// ---- Manual roster entry ----
async function openRosterEntryModal() {
  clearForm(['re-PersonID','re-Shift','re-Start','re-End','re-Note']);
  setVal('re-Date', ymd(rosterView==='day'?rosterRef:new Date()));
  await loadShiftTypes();
  fillEntryPeople();
  showModal('roster-entry-modal');
}
function fillEntryPeople() {
  populateSelect('re-PersonID', peopleOptions(val('re-PersonType')), 'v', 'l', false);
}
async function saveRosterEntry() {
  const d = {
    PersonType: val('re-PersonType'), PersonID: val('re-PersonID'), RosterDate: val('re-Date'),
    ShiftLabel: val('re-Shift')||'Day', StartTime: val('re-Start'), EndTime: val('re-End'), Note: val('re-Note')
  };
  if (!d.PersonID || !d.RosterDate) return toast('Person and date are required.', 'error');
  const r = await POST('/api/roster', d);
  if (!ok(r)) return;
  closeModal('roster-entry-modal'); toast('Shift added.'); loadRoster();
}

// ---- Employee Roles / Career ----
async function loadStaffRoles(id) {
  // populate the add-role dropdown
  const sel = document.getElementById('role-add-job');
  if (sel) sel.innerHTML = '<option value="">-- Select a job title --</option>' +
    cache.jobs.map(j => `<option value="${j.JobID}">${esc(j.Title)}</option>`).join('');

  const roles = await GET(`/api/staff/${id}/roles`) || [];
  document.getElementById('staff-roles-list').innerHTML = roles.length ? `
    <div class="table-responsive"><table>
      <thead><tr><th>Job Title</th><th>Required Courses</th><th>Assigned</th><th></th><th></th></tr></thead>
      <tbody>${roles.map(r => `<tr>
        <td class="cell-strong">${esc(r.Title||'')} ${r.IsPrimary?'<span class="badge badge-active badge-plain">Primary</span>':''}</td>
        <td>${r.CourseCount||0}</td>
        <td>${fmtDate(r.DateAssigned)}</td>
        <td>${r.IsPrimary?'':`<button class="btn btn-outline btn-sm" onclick="setPrimaryRole(${id},${r.EmpJobID})">Make Primary</button>`}</td>
        <td><button class="btn btn-danger btn-sm btn-icon" onclick="removeRole(${id},${r.EmpJobID})" title="Remove role">🗑️</button></td>
      </tr>`).join('')}</tbody></table></div>`
    : '<p class="cell-sub">No roles assigned yet.</p>';

  const courses = await GET(`/api/staff/${id}/role-courses`) || [];
  document.getElementById('staff-role-courses').innerHTML = courses.length ? `
    <div class="table-responsive"><table>
      <thead><tr><th>Course</th><th>Required Via Role</th><th>Status</th><th>Completed</th><th>Expires</th></tr></thead>
      <tbody>${courses.map(c => `<tr>
        <td class="cell-strong">${esc(c.CertName)}</td>
        <td>${esc(c.ViaRole||'')}</td>
        <td>${c.IsCurrent ? '<span class="badge badge-current">Current</span>' : (c.Expiration && new Date(c.Expiration)<new Date() ? '<span class="badge badge-expired">Expired</span>' : '<span class="badge badge-inactive">Not Done</span>')}</td>
        <td>${fmtDate(c.LastCompleted)}</td><td>${expBadge(c.Expiration)}</td>
      </tr>`).join('')}</tbody></table></div>`
    : '<p class="cell-sub">No training is mapped to these roles yet. Add requirements to a job title under Requirements.</p>';

  const hist = await GET(`/api/staff/${id}/role-history`) || [];
  document.getElementById('staff-role-history').innerHTML = hist.length ? `
    <div class="table-responsive"><table>
      <thead><tr><th>Date</th><th>Action</th><th>Role</th><th>By</th></tr></thead>
      <tbody>${hist.map(h => `<tr>
        <td class="cell-sub">${fmtDate((h.EffectiveDate||'').split(' ')[0])}</td>
        <td><span class="badge badge-pending badge-plain">${esc(h.Action||'')}</span></td>
        <td>${esc(h.Title||'')}</td><td class="cell-sub">${esc(h.ChangedBy||'')}</td>
      </tr>`).join('')}</tbody></table></div>`
    : '<p class="cell-sub">No history yet.</p>';
}

async function addRole() {
  const id = editingId.staff;
  const JobID = val('role-add-job');
  if (!JobID) return toast('Select a job title.', 'error');
  const makePrimary = document.getElementById('role-add-primary').checked;
  const r = await POST(`/api/staff/${id}/roles`, { JobID, makePrimary });
  if (!ok(r)) return;
  toast('Role assigned — its required training now appears below.');
  document.getElementById('role-add-primary').checked = false;
  loadStaffRoles(id);
}

async function setPrimaryRole(id, empJobId) {
  const r = await PUT(`/api/staff/${id}/roles/${empJobId}/primary`, {});
  if (!ok(r)) return;
  toast('Primary role updated.');
  loadStaffRoles(id);
}

async function removeRole(id, empJobId) {
  if (!confirm('Remove this role from the employee? Their training history is kept.')) return;
  const r = await DEL(`/api/staff/${id}/roles/${empJobId}`);
  if (!ok(r)) return;
  toast('Role removed.');
  loadStaffRoles(id);
}

// ---- Trainers ----
async function loadTrainers() {
  const params = new URLSearchParams({ status: val('trainer-status'), search: val('trainer-search'), certID: val('trainer-cert') });
  const data = await GET('/api/trainers?' + params);
  if (!data) return;
  document.getElementById('trainers-tbody').innerHTML = data.length ? data.map(t => `
    <tr>
      <td class="cell-strong">${esc(t.LastName)}, ${esc(t.FirstName)}</td>
      <td>${esc(t.TrainerType||'')}</td>
      <td>${esc(t.Company||'')}</td>
      <td>${t.CourseCount||0}</td>
      <td>${t.HourlyRate?'$'+t.HourlyRate+'/hr':''}${t.DailyRate?(t.HourlyRate?' · ':'')+'$'+t.DailyRate+'/day':''}</td>
      <td>${esc(t.Email||'')}</td>
      <td><span class="badge ${t.Status==='Active'?'badge-active':'badge-inactive'}">${t.Status||''}</span></td>
      <td class="actions">
        <button class="btn btn-primary btn-sm btn-icon" onclick="editTrainer(${t.TrainerID})" title="Edit">✏️</button>
        <button class="btn btn-danger btn-sm btn-icon" onclick="deleteTrainer(${t.TrainerID})" title="Delete">🗑️</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty-state">No trainers yet</td></tr>';
}

function trainerCourseChecks(selected) {
  const sel = new Set((selected || []).map(Number));
  document.getElementById('tr-courses').innerHTML = cache.certs.length ? cache.certs.map(c =>
    `<label class="course-check"><input type="checkbox" class="tr-course" value="${c.CertID}" ${sel.has(c.CertID)?'checked':''}> ${esc(c.CertName)}</label>`).join('')
    : '<p class="cell-sub">No courses defined yet.</p>';
}

function toggleTrainerType() {
  const ext = val('tr-TrainerType') === 'External';
  document.getElementById('tr-company-wrap').style.display = ext ? '' : 'none';
  document.getElementById('tr-staff-wrap').style.display = ext ? 'none' : '';
}

function openTrainerModal() {
  editingId.trainer = null;
  clearForm(['tr-FirstName','tr-LastName','tr-Email','tr-Phone','tr-Company','tr-HourlyRate','tr-DailyRate','tr-Notes','tr-StaffID']);
  setVal('tr-TrainerType', 'Internal'); setVal('tr-Status', 'Active');
  toggleTrainerType();
  trainerCourseChecks([]);
  document.getElementById('trainer-modal-title').textContent = 'Add Trainer';
  showModal('trainer-modal');
}

async function editTrainer(id) {
  const t = await GET('/api/trainers/' + id);
  if (!t) return;
  editingId.trainer = id;
  document.getElementById('trainer-modal-title').textContent = `Edit: ${t.FirstName} ${t.LastName}`;
  setVal('tr-FirstName', t.FirstName); setVal('tr-LastName', t.LastName);
  setVal('tr-Email', t.Email); setVal('tr-Phone', t.Phone);
  setVal('tr-TrainerType', t.TrainerType); setVal('tr-StaffID', t.StaffID);
  setVal('tr-Company', t.Company); setVal('tr-HourlyRate', t.HourlyRate);
  setVal('tr-DailyRate', t.DailyRate); setVal('tr-Status', t.Status); setVal('tr-Notes', t.Notes);
  toggleTrainerType();
  trainerCourseChecks((t.courses || []).map(c => c.CertID));
  showModal('trainer-modal');
}

async function saveTrainer() {
  const courseIds = [...document.querySelectorAll('.tr-course:checked')].map(c => parseInt(c.value));
  const d = {
    FirstName: val('tr-FirstName'), LastName: val('tr-LastName'), Email: val('tr-Email'), Phone: val('tr-Phone'),
    TrainerType: val('tr-TrainerType'), StaffID: val('tr-StaffID'), Company: val('tr-Company'),
    HourlyRate: val('tr-HourlyRate'), DailyRate: val('tr-DailyRate'), Status: val('tr-Status'), Notes: val('tr-Notes'),
    courseIds
  };
  if (!d.FirstName || !d.LastName) return toast('First and Last name are required.', 'error');
  const editing = editingId.trainer;
  const r = editing ? await PUT('/api/trainers/' + editing, d) : await POST('/api/trainers', d);
  if (!ok(r)) return;
  closeModal('trainer-modal');
  toast(editing ? 'Trainer updated.' : 'Trainer added.');
  cache.trainers = await GET('/api/trainers') || [];
  populateSelect('cl-TrainerID', cache.trainers.map(t => ({ v: t.TrainerID, l: `${t.LastName}, ${t.FirstName}` })), 'v', 'l');
  loadTrainers();
}

async function deleteTrainer(id) {
  if (!confirm('Delete this trainer?')) return;
  await DEL('/api/trainers/' + id);
  cache.trainers = await GET('/api/trainers') || [];
  loadTrainers();
}

// ---- Calendar ----
let calYear, calMonth;
async function loadCalendar() {
  if (calYear === undefined) { const n = new Date(); calYear = n.getFullYear(); calMonth = n.getMonth(); }
  renderCalendar();
}
function calMove(dir) {
  if (dir === 0) { const n = new Date(); calYear = n.getFullYear(); calMonth = n.getMonth(); }
  else { calMonth += dir; if (calMonth < 0) { calMonth = 11; calYear--; } if (calMonth > 11) { calMonth = 0; calYear++; } }
  renderCalendar();
}
async function renderCalendar() {
  const first = new Date(calYear, calMonth, 1);
  const last = new Date(calYear, calMonth + 1, 0);
  const pad = n => String(n).padStart(2, '0');
  const fromStr = `${calYear}-${pad(calMonth+1)}-01`;
  const toStr = `${calYear}-${pad(calMonth+1)}-${pad(last.getDate())}`;
  document.getElementById('cal-title').textContent = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const classes = await GET(`/api/classes/calendar?from=${fromStr}&to=${toStr}`) || [];
  const byDay = {};
  classes.forEach(c => { (byDay[c.ClassDate] = byDay[c.ClassDate] || []).push(c); });

  const dows = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let html = '<div class="cal-grid">' + dows.map(d => `<div class="cal-dow">${d}</div>`).join('');
  const startBlank = first.getDay();
  for (let i = 0; i < startBlank; i++) html += '<div class="cal-cell cal-empty"></div>';
  const todayStr = new Date().toISOString().split('T')[0];
  for (let day = 1; day <= last.getDate(); day++) {
    const ds = `${calYear}-${pad(calMonth+1)}-${pad(day)}`;
    const evs = byDay[ds] || [];
    html += `<div class="cal-cell${ds===todayStr?' cal-today':''}">
      <div class="cal-daynum">${day}</div>
      ${evs.map(e => `<div class="cal-event" title="${esc((e.ClassName||e.CertName||'')+' '+(e.TimeStart||''))}" onclick="viewRoster(${e.ClassID})">
        ${e.TimeStart?`<b>${e.TimeStart}</b> `:''}${esc(e.ClassName||e.CertName||'Class')}
        <span class="cal-ev-sub">${e.Enrolled||0}${(e.MaxSeats||e.ClassCapacity)?'/'+(e.MaxSeats||e.ClassCapacity):''}${e.TrainerLast?' · '+esc(e.TrainerLast):''}</span>
      </div>`).join('')}
    </div>`;
  }
  html += '</div>';
  document.getElementById('calendar-grid').innerHTML = html;
}

// ---- Toast notifications ----
function toast(msg, type = 'success') {
  let wrap = document.getElementById('toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toast-wrap'; document.body.appendChild(wrap); }
  const t = document.createElement('div');
  t.className = 'toast toast-' + type;
  t.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '⚠️' : 'ℹ️'}</span><div>${esc(msg)}</div>`;
  wrap.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3200);
}

// Returns true if the API result is a success; otherwise shows the error and returns false.
function ok(r, errMsg) {
  if (r && r.error) { toast(r.error, 'error'); return false; }
  if (!r) { toast(errMsg || 'Request failed — please try again.', 'error'); return false; }
  return true;
}

// ---- Utility ----
function val(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v != null ? v : ''; }
function clearForm(ids) { ids.forEach(id => setVal(id, '')); }
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
// Escape HTML then render **bold** and *italic* inline markdown
function escMd(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}
function expBadge(d) {
  if (!d) return '';
  const today = new Date(); today.setHours(0,0,0,0);
  const exp = new Date(d + 'T00:00:00');
  const diff = Math.ceil((exp - today) / 86400000);
  if (diff < 0) return `<span class="badge badge-expired">${fmtDate(d)}</span>`;
  if (diff <= 30) return `<span class="badge badge-expiring">${fmtDate(d)}</span>`;
  return `<span class="badge badge-current">${fmtDate(d)}</span>`;
}

// ---- Competency Builder ----
let _compBuilderData = { frameworks: [], competencies: [], reqs: [] };

async function loadCompetencyBuilder() {
  const [fws, comps, reqs] = await Promise.all([
    GET('/api/competency/frameworks'),
    GET('/api/competency/competencies'),
    GET('/api/competency/requirements')
  ]);
  _compBuilderData.frameworks  = fws   || [];
  _compBuilderData.competencies = comps || [];
  _compBuilderData.reqs        = reqs  || [];

  // populate framework filter dropdown
  const fwSel = document.getElementById('comp-filter-fw');
  if (fwSel) fwSel.innerHTML = '<option value="">All Frameworks</option>' +
    _compBuilderData.frameworks.map(f => `<option value="${f.FrameworkID}">${esc(f.Name)}</option>`).join('');

  renderCompFrameworks(_compBuilderData.frameworks);
  renderCompetencies(_compBuilderData.competencies);
  renderCompReqs(_compBuilderData.reqs);
}

function renderCompFrameworks(rows) {
  const el = document.getElementById('comp-frameworks-list');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<p class="cell-sub">No frameworks yet. Add one to get started.</p>'; return; }
  el.innerHTML = `<div class="table-responsive"><table>
    <thead><tr><th>Name</th><th>Competencies</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.map(f => `<tr>
      <td><strong>${esc(f.Name)}</strong>${f.Description ? `<div class="cell-sub">${esc(f.Description)}</div>` : ''}</td>
      <td>${f.competencyCount || 0}</td>
      <td><span class="badge ${f.Status === 'Active' ? 'badge-success' : 'badge-neutral'}">${esc(f.Status)}</span></td>
      <td class="actions">
        <button class="btn btn-ghost btn-sm" onclick="openCompFrameworkModal(${f.FrameworkID})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteCompFramework(${f.FrameworkID})">Delete</button>
      </td></tr>`).join('')}
    </tbody></table></div>`;
}

const COMP_LEVELS = { 1:'Awareness', 2:'Basic', 3:'Competent', 4:'Advanced', 5:'Expert' };
function compLevelBadge(n) {
  if (!n) return '';
  const labels = ['','Awareness','Basic','Competent','Advanced','Expert'];
  const colors = ['','#6b7280','#3b82f6','#10b981','#f59e0b','#8b5cf6'];
  return `<span class="comp-level-badge" style="background:${colors[n]}20;color:${colors[n]};border:1px solid ${colors[n]}40">${n} · ${labels[n]}</span>`;
}

function renderCompetencies(rows) {
  const el = document.getElementById('comp-list');
  if (!el) return;
  const filterId = parseInt(val('comp-filter-fw')) || null;
  const visible = filterId ? rows.filter(c => c.FrameworkID === filterId) : rows;
  if (!visible.length) { el.innerHTML = '<p class="cell-sub">No competencies yet.</p>'; return; }
  const grouped = {};
  visible.forEach(c => { const k = c.Category || 'General'; (grouped[k] = grouped[k] || []).push(c); });
  el.innerHTML = Object.entries(grouped).map(([cat, cs]) =>
    `<div class="comp-cat-group mb-2">
       <div class="comp-cat-hdr">${esc(cat)} <span class="comp-cat-count">${cs.length}</span></div>
       ${cs.map(c => `
         <div class="comp-accordion-item" id="cai-${c.CompetencyID}">
           <div class="comp-accordion-head" onclick="toggleCompItem(${c.CompetencyID})">
             <span class="comp-acc-chevron">›</span>
             <span class="comp-acc-name">${esc(c.Name)}</span>
             <span class="comp-acc-meta">
               <span class="cell-sub">${esc(c.frameworkName || '—')}</span>
               ${c.reqCount ? `<span class="comp-acc-tag">${c.reqCount} role${c.reqCount!==1?'s':''}</span>` : ''}
             </span>
             <span class="comp-acc-actions" onclick="event.stopPropagation()">
               <button class="btn btn-ghost btn-sm" onclick="openCompModal(${c.CompetencyID})">Edit</button>
               <button class="btn btn-danger btn-sm" onclick="deleteCompetency(${c.CompetencyID})">Delete</button>
             </span>
           </div>
           <div class="comp-accordion-body hidden">
             ${c.Description ? `<p class="comp-acc-desc">${esc(c.Description)}</p>` : '<p class="cell-sub">No description.</p>'}
             <div class="comp-acc-stats">
               <span><strong>${c.totalAssessed||0}</strong> assessed</span>
               <span><strong>${c.competentCount||0}</strong> competent</span>
               <span><strong>${c.reqCount||0}</strong> role requirement${c.reqCount!==1?'s':''}</span>
             </div>
           </div>
         </div>`).join('')}
     </div>`
  ).join('');
}

function toggleCompItem(id) {
  const item = document.getElementById('cai-' + id);
  if (!item) return;
  const body = item.querySelector('.comp-accordion-body');
  const chevron = item.querySelector('.comp-acc-chevron');
  const open = !body.classList.contains('hidden');
  body.classList.toggle('hidden', open);
  chevron.classList.toggle('open', !open);
}

function renderCompReqs(rows) {
  const el = document.getElementById('comp-reqs-list');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<p class="cell-sub">No requirements linked yet. Link a competency to a job title or department to enable gap analysis.</p>'; return; }
  // Group by role label
  const groups = {};
  rows.forEach(r => {
    const key = r.jobTitle ? `job:${r.jobTitle}` : r.Department ? `dept:${r.Department}` : 'other:Unspecified';
    const label = r.jobTitle || r.Department || 'Unspecified';
    const type  = r.jobTitle ? '💼 Job Title' : r.Department ? '🏢 Department' : '';
    if (!groups[key]) groups[key] = { label, type, items: [] };
    groups[key].items.push(r);
  });
  el.innerHTML = Object.entries(groups).map(([key, g]) => `
    <div class="comp-accordion-item" id="crg-${btoa(key).replace(/=/g,'')}">
      <div class="comp-accordion-head" onclick="toggleReqGroup('${btoa(key).replace(/=/g,'')}')">
        <span class="comp-acc-chevron">›</span>
        <span class="comp-acc-name">${esc(g.label)}</span>
        <span class="comp-acc-meta">
          <span class="cell-sub">${g.type}</span>
          <span class="comp-acc-tag">${g.items.length} competenc${g.items.length!==1?'ies':'y'}</span>
        </span>
      </div>
      <div class="comp-accordion-body hidden">
        <table class="comp-req-inner-tbl">
          <thead><tr><th>Competency</th><th>Category</th><th>Required Level</th><th></th></tr></thead>
          <tbody>${g.items.map(r => `<tr>
            <td><strong>${esc(r.compName)}</strong></td>
            <td class="cell-sub">${esc(r.Category||'—')}</td>
            <td>${compLevelBadge(r.RequiredLevel||3)}</td>
            <td class="actions"><button class="btn btn-danger btn-sm" onclick="deleteCompReq(${r.ReqID})">Remove</button></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`).join('');
}

function toggleReqGroup(id) {
  const item = document.getElementById('crg-' + id);
  if (!item) return;
  const body = item.querySelector('.comp-accordion-body');
  const chevron = item.querySelector('.comp-acc-chevron');
  const open = !body.classList.contains('hidden');
  body.classList.toggle('hidden', open);
  chevron.classList.toggle('open', !open);
}

function openCompFrameworkModal(id) {
  clearForm(['comp-fw-id','comp-fw-name','comp-fw-desc']);
  const fw = id ? _compBuilderData.frameworks.find(f => f.FrameworkID === id) : null;
  document.getElementById('comp-fw-modal-title').textContent = fw ? 'Edit Framework' : 'Add Framework';
  if (fw) { setVal('comp-fw-id', fw.FrameworkID); setVal('comp-fw-name', fw.Name); setVal('comp-fw-desc', fw.Description); }
  showModal('comp-fw-modal');
}

async function saveCompFramework() {
  const id = val('comp-fw-id'), name = val('comp-fw-name');
  if (!name) return toast('Name is required.', 'error');
  const body = { name, description: val('comp-fw-desc') };
  const r = id ? await PUT('/api/competency/frameworks/' + id, body) : await POST('/api/competency/frameworks', body);
  if (!ok(r)) return;
  closeModal('comp-fw-modal');
  toast(id ? 'Framework updated.' : 'Framework created.');
  loadCompetencyBuilder();
}

async function deleteCompFramework(id) {
  if (!confirm('Mark this framework as inactive?')) return;
  const r = await DEL('/api/competency/frameworks/' + id);
  if (!ok(r)) return;
  toast('Framework removed.');
  loadCompetencyBuilder();
}

function openCompModal(id) {
  clearForm(['comp-id','comp-name','comp-desc','comp-category']);
  const c = id ? _compBuilderData.competencies.find(x => x.CompetencyID === id) : null;
  document.getElementById('comp-modal-title').textContent = c ? 'Edit Competency' : 'Add Competency';
  const fwSel = document.getElementById('comp-framework-sel');
  fwSel.innerHTML = '<option value="">— No Framework —</option>' +
    _compBuilderData.frameworks.map(f => `<option value="${f.FrameworkID}">${esc(f.Name)}</option>`).join('');
  if (c) {
    setVal('comp-id', c.CompetencyID); setVal('comp-name', c.Name);
    setVal('comp-desc', c.Description); setVal('comp-category', c.Category);
    setVal('comp-framework-sel', c.FrameworkID || '');
  }
  showModal('comp-modal');
}

async function saveCompetency() {
  const id = val('comp-id'), name = val('comp-name');
  if (!name) return toast('Name is required.', 'error');
  const body = { name, description: val('comp-desc'), category: val('comp-category'), frameworkId: val('comp-framework-sel') || null };
  const r = id ? await PUT('/api/competency/competencies/' + id, body) : await POST('/api/competency/competencies', body);
  if (!ok(r)) return;
  closeModal('comp-modal');
  toast(id ? 'Competency updated.' : 'Competency created.');
  loadCompetencyBuilder();
}

async function deleteCompetency(id) {
  if (!confirm('Mark this competency as inactive?')) return;
  const r = await DEL('/api/competency/competencies/' + id);
  if (!ok(r)) return;
  toast('Competency removed.');
  loadCompetencyBuilder();
}

async function openCompReqModal() {
  const [jobs, depts, comps] = await Promise.all([GET('/api/lookup/jobs'), GET('/api/lookup/depts'), GET('/api/competency/competencies')]);
  const compSel = document.getElementById('comp-req-comp');
  const jobSel  = document.getElementById('comp-req-job');
  const deptSel = document.getElementById('comp-req-dept');
  compSel.innerHTML = '<option value="">— Select competency —</option>' + (comps||[]).map(c => `<option value="${c.CompetencyID}">${esc(c.Name)}</option>`).join('');
  jobSel.innerHTML  = '<option value="">— Any —</option>' + (jobs||[]).map(j => `<option value="${j.JobID}">${esc(j.Title)}</option>`).join('');
  deptSel.innerHTML = '<option value="">— Any —</option>' + (depts||[]).map(d => `<option value="${d.DeptID}">${esc(d.Department)}</option>`).join('');
  showModal('comp-req-modal');
}

async function saveCompReq() {
  const competencyId = val('comp-req-comp'), jobId = val('comp-req-job'), deptId = val('comp-req-dept');
  if (!competencyId) return toast('Select a competency.', 'error');
  const requiredLevel = parseInt(val('comp-req-level') || '3', 10);
  const r = await POST('/api/competency/requirements', { competencyId, jobId: jobId || null, deptId: deptId || null, requiredLevel });
  if (!ok(r)) return;
  closeModal('comp-req-modal');
  toast('Requirement linked.');
  loadCompetencyBuilder();
}

async function deleteCompReq(id) {
  await DEL('/api/competency/requirements/' + id);
  toast('Requirement removed.');
  loadCompetencyBuilder();
}

async function loadCompetencies() { renderCompetencies(_compBuilderData.competencies); }

// ---- Competency Builder Report ----
async function openCompBuilderReport() {
  const body = document.getElementById('comp-report-body');
  body.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-soft)">⏳ Loading report…</div>';
  showModal('comp-report-modal');
  const d = await GET('/api/competency/report');
  if (!d || d.error) { body.innerHTML = `<div style="padding:32px;color:red">${esc(d?.error||'Failed to load')}</div>`; return; }
  const date = new Date(d.generatedAt).toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'numeric' });
  const pct = (n, t) => t ? Math.round(n / t * 100) : 0;
  const totalComps = d.competencies.length;
  const totalFws   = d.frameworks.length;
  const totalReqs  = d.totalRequirements;
  const covPct = pct(d.assessmentsByStatus.competent, d.totalAssessments || 1);

  // ── KPI bar ──────────────────────────────────────────────────────────────
  const kpi = (val, label, sub='') => `
    <div class="cr-kpi">
      <div class="cr-kpi-val">${val}</div>
      <div class="cr-kpi-label">${label}</div>
      ${sub ? `<div class="cr-kpi-sub">${sub}</div>` : ''}
    </div>`;

  // ── Frameworks table ──────────────────────────────────────────────────────
  const fwRows = d.frameworks.map(f => `
    <tr>
      <td><strong>${esc(f.Name)}</strong>${f.Description ? `<div class="cr-sub">${esc(f.Description)}</div>` : ''}</td>
      <td><span class="cr-badge ${f.Status==='Active'?'cr-badge-green':'cr-badge-grey'}">${esc(f.Status||'Active')}</span></td>
      <td class="cr-num">${f.competencyCount||0}</td>
    </tr>`).join('') || '<tr><td colspan="3" class="cr-empty">No frameworks defined.</td></tr>';

  // ── Competencies by category ──────────────────────────────────────────────
  const catGroups = {};
  d.competencies.forEach(c => { const k = c.Category||'General'; (catGroups[k]=catGroups[k]||[]).push(c); });
  const compSections = Object.entries(catGroups).map(([cat, cs]) => `
    <div class="cr-cat-hdr">${esc(cat)}</div>
    <table class="cr-table">
      <thead><tr><th>Competency</th><th>Framework</th><th>Role Requirements</th><th>Assessed</th><th>Competent</th><th>Not Competent</th></tr></thead>
      <tbody>${cs.map(c => {
        const assessed = c.totalAssessed||0;
        const comp = c.competentCount||0;
        const notComp = c.notCompetentCount||0;
        const pctC = pct(comp, assessed);
        return `<tr>
          <td><strong>${esc(c.Name)}</strong>${c.Description?`<div class="cr-sub">${esc(c.Description)}</div>`:''}</td>
          <td class="cr-sub">${esc(c.frameworkName||'—')}</td>
          <td class="cr-num">${c.reqCount||0}</td>
          <td class="cr-num">${assessed}</td>
          <td class="cr-num"><span class="cr-pill ${pctC>=80?'cr-pill-green':pctC>=50?'cr-pill-amber':'cr-pill-red'}">${comp} <small>(${pctC}%)</small></span></td>
          <td class="cr-num">${notComp}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`).join('') || '<p class="cr-empty">No competencies defined.</p>';

  // ── Requirements by role ──────────────────────────────────────────────────
  const roleEntries = Object.entries(d.requirementsByRole||{});
  const roleSections = roleEntries.length ? roleEntries.map(([role, comps]) => `
    <div class="cr-role-block">
      <div class="cr-role-hdr">${esc(role)} <span class="cr-sub">(${comps.length} competenc${comps.length===1?'y':'ies'})</span></div>
      <div class="cr-tags">${comps.map(c=>`<span class="cr-tag"><strong>${esc(c.name)}</strong>${c.category?` · <em>${esc(c.category)}</em>`:''}</span>`).join('')}</div>
    </div>`).join('')
  : '<p class="cr-empty">No role requirements linked yet.</p>';

  // ── Top gaps ─────────────────────────────────────────────────────────────
  const gapRows = (d.topGaps||[]).map((g, i) => `
    <tr>
      <td>${i+1}</td>
      <td><strong>${esc(g.name)}</strong>${g.category?`<span class="cr-sub ml-1">· ${esc(g.category)}</span>`:''}</td>
      <td class="cr-num"><span class="cr-pill cr-pill-red">${g.count} employee${g.count!==1?'s':''}</span></td>
    </tr>`).join('') || '<tr><td colspan="3" class="cr-empty">No gaps detected.</td></tr>';

  body.innerHTML = `
<div id="comp-report-print" style="padding:28px 32px">
  <!-- Report header -->
  <div class="cr-report-hdr">
    <div>
      <div class="cr-report-title">Competency Framework Report</div>
      <div class="cr-report-meta">Generated ${date} · ${esc(currentUser?.username||'')} · ${d.activeStaffCount} active employees</div>
    </div>
  </div>

  <!-- KPIs -->
  <div class="cr-kpi-row">
    ${kpi(totalFws, 'Frameworks', 'active')}
    ${kpi(totalComps, 'Competencies', 'across all frameworks')}
    ${kpi(totalReqs, 'Role Requirements', 'competency-role links')}
    ${kpi(d.totalAssessments, 'Assessments', 'recorded total')}
    ${kpi(d.assessmentsByStatus.competent, 'Competent', `of ${d.totalAssessments} assessments`)}
    ${kpi(covPct+'%', 'Pass Rate', 'competent / total assessed')}
  </div>

  <!-- Section 1 -->
  <div class="cr-section-title">1. Competency Frameworks</div>
  <table class="cr-table">
    <thead><tr><th>Framework</th><th>Status</th><th>Competencies</th></tr></thead>
    <tbody>${fwRows}</tbody>
  </table>

  <!-- Section 2 -->
  <div class="cr-section-title">2. Competencies by Category</div>
  ${compSections}

  <!-- Section 3 -->
  <div class="cr-section-title">3. Job / Department Requirements</div>
  <div class="cr-sub mb-2">Which competencies are required for each job title or department.</div>
  ${roleSections}

  <!-- Section 4 -->
  <div class="cr-section-title">4. Top Competency Gaps</div>
  <div class="cr-sub mb-2">Competencies most frequently not met by employees in roles that require them.</div>
  <table class="cr-table" style="max-width:640px">
    <thead><tr><th>#</th><th>Competency</th><th>Employees with Gap</th></tr></thead>
    <tbody>${gapRows}</tbody>
  </table>
</div>`;
}

function printCompReport() {
  const content = document.getElementById('comp-report-print');
  if (!content) return;
  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Competency Report</title>
<style>
  body{font-family:Arial,sans-serif;font-size:10pt;color:#1a1a2e;margin:0;padding:24px}
  .cr-report-hdr{margin-bottom:18px;border-bottom:2px solid #1E3A5F;padding-bottom:10px}
  .cr-report-title{font-size:18pt;font-weight:700;color:#1E3A5F}
  .cr-report-meta{font-size:8.5pt;color:#6b7280;margin-top:3px}
  .cr-kpi-row{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0;padding:14px;background:#f6f8fc;border-radius:8px;border:1pt solid #d1d5db}
  .cr-kpi{flex:1;min-width:100px;text-align:center}
  .cr-kpi-val{font-size:20pt;font-weight:700;color:#1E3A5F}
  .cr-kpi-label{font-size:9pt;font-weight:600;color:#374151}
  .cr-kpi-sub{font-size:7.5pt;color:#9ca3af}
  .cr-section-title{font-size:13pt;font-weight:700;color:#1E3A5F;margin:22px 0 8px;padding-bottom:4px;border-bottom:1.5pt solid #1E3A5F}
  .cr-cat-hdr{font-size:10pt;font-weight:700;color:#4f46e5;margin:14px 0 4px}
  .cr-table{width:100%;border-collapse:collapse;margin-bottom:12px;font-size:9pt}
  .cr-table th{background:#1E3A5F;color:#fff;padding:6px 8px;text-align:left;font-weight:600}
  .cr-table td{padding:5px 8px;border-bottom:0.5pt solid #e5e7eb;vertical-align:top}
  .cr-table tr:nth-child(even) td{background:#f9fafb}
  .cr-num{text-align:center}
  .cr-sub{font-size:8pt;color:#6b7280}
  .cr-badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:8pt;font-weight:600}
  .cr-badge-green{background:#d1fae5;color:#065f46}
  .cr-badge-grey{background:#f3f4f6;color:#6b7280}
  .cr-pill{display:inline-block;padding:1px 7px;border-radius:10px;font-size:8pt;font-weight:600}
  .cr-pill-green{background:#d1fae5;color:#065f46}
  .cr-pill-amber{background:#fef3c7;color:#92400e}
  .cr-pill-red{background:#fee2e2;color:#991b1b}
  .cr-role-block{margin-bottom:12px;padding:10px 12px;border:0.5pt solid #e5e7eb;border-radius:6px;break-inside:avoid}
  .cr-role-hdr{font-size:10pt;font-weight:700;color:#1E3A5F;margin-bottom:6px}
  .cr-tags{display:flex;flex-wrap:wrap;gap:6px}
  .cr-tag{font-size:8.5pt;background:#eff6ff;border:0.5pt solid #bfdbfe;border-radius:4px;padding:2px 8px;color:#1e40af}
  .cr-empty{color:#9ca3af;font-style:italic;padding:8px}
  @page{size:A4;margin:15mm}
  @media print{body{padding:0}}
</style></head><body>${content.innerHTML}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); }, 400);
}

// ---- Competency Gap Analysis ----
let _gapRows = [];

async function loadCompetency() {
  // Populate dept/job filters if empty
  const deptSel = document.getElementById('gap-dept');
  const jobSel  = document.getElementById('gap-job');
  if (deptSel && deptSel.options.length === 1) {
    const [depts, jobs] = await Promise.all([GET('/api/lookup/depts'), GET('/api/lookup/jobs')]);
    if (depts) deptSel.innerHTML = '<option value="">All Departments</option>' + depts.map(d => `<option value="${d.DeptID}">${esc(d.Department)}</option>`).join('');
    if (jobs)  jobSel.innerHTML  = '<option value="">All Job Titles</option>'  + jobs.map(j => `<option value="${j.JobID}">${esc(j.Title)}</option>`).join('');
  }
  const deptId = val('gap-dept'), jobId = val('gap-job');
  const qs = new URLSearchParams();
  if (deptId) qs.set('deptId', deptId);
  if (jobId)  qs.set('jobId', jobId);
  const rows = await GET('/api/competency/gap-analysis?' + qs);
  _gapRows = rows || [];
  renderGapSummary(_gapRows);
  filterGapTable();
}

function renderGapSummary(rows) {
  const el = document.getElementById('gap-summary');
  if (!el) return;
  const total = rows.length;
  const fullComp = rows.filter(r => r.required > 0 && r.gaps === 0).length;
  const hasGaps  = rows.filter(r => r.gaps > 0).length;
  const noReqs   = rows.filter(r => r.required === 0).length;
  el.innerHTML = [
    { n: total,    l: 'Employees',       cls: '' },
    { n: fullComp, l: 'Fully Competent', cls: 'green' },
    { n: hasGaps,  l: 'Have Gaps',       cls: hasGaps ? 'amber' : '' },
    { n: noReqs,   l: 'No Requirements', cls: '' }
  ].map(t => `<div class="stat-card${t.cls?' stat-'+t.cls:''}"><div class="stat-num">${t.n}</div><div class="stat-label">${t.l}</div></div>`).join('');
}

function filterGapTable() {
  const q = (val('gap-search') || '').toLowerCase();
  const visible = q ? _gapRows.filter(r => r.empName.toLowerCase().includes(q) || (r.jobTitle||'').toLowerCase().includes(q) || (r.department||'').toLowerCase().includes(q)) : _gapRows;
  const el = document.getElementById('gap-table');
  if (!el) return;
  if (!visible.length) {
    el.innerHTML = _gapRows.length ? '<p class="cell-sub">No matches.</p>' : '<p class="cell-sub">No employees found, or no competency requirements have been linked yet. Use Competency Builder to set up frameworks and link them to job roles.</p>';
    return;
  }
  const STATUS_CLS = { Competent: 'badge-success', 'In Progress': 'badge-expiring', 'Not Yet': 'badge-expired', 'Not Assessed': 'badge-neutral' };
  el.innerHTML = `<div class="table-responsive"><table>
    <thead><tr><th>Employee</th><th>Job Title</th><th>Department</th><th>Required</th><th>Met</th><th>Gaps</th><th>Gap Detail</th></tr></thead>
    <tbody>${visible.map(r => {
      const gapBadges = r.gapList.slice(0,4).map(g =>
        `<span class="badge ${STATUS_CLS[g.status]||'badge-neutral'}" title="${esc(g.status)}">${esc(g.name)}</span>`
      ).join(' ') + (r.gapList.length > 4 ? ` <span class="cell-sub">+${r.gapList.length - 4} more</span>` : '');
      const pct = r.required > 0 ? Math.round((r.met / r.required) * 100) : null;
      return `<tr>
        <td><strong>${esc(r.empName)}</strong></td>
        <td class="cell-sub">${esc(r.jobTitle)}</td>
        <td class="cell-sub">${esc(r.department)}</td>
        <td>${r.required}</td>
        <td>${r.met}${pct!=null?` <span class="cell-sub">(${pct}%)</span>`:''}</td>
        <td>${r.gaps > 0 ? `<span class="badge badge-expired">${r.gaps}</span>` : '<span class="badge badge-success">0</span>'}</td>
        <td>${r.gapList.length ? gapBadges + `<button class="btn btn-ghost btn-sm ml-1" onclick="openAssessForEmp(${r.empId},'${esc(r.empName)}')">Assess →</button>` : '<span class="cell-sub">—</span>'}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

async function openAssessForEmp(empId, empName) {
  const records = await GET('/api/competency/records?empId=' + empId);
  const emp = _gapRows.find(r => r.empId === empId);
  if (!emp || !emp.gapList.length) return toast('No gaps to assess.', 'error');
  // Open modal for first gap; user can cycle through
  const gap = emp.gapList[0];
  openCompAssessModal(empId, gap.id, gap.name, empName, records);
}

function openCompAssessModal(empId, compId, compName, empName, records) {
  setVal('ca-emp-id', empId); setVal('ca-comp-id', compId);
  document.getElementById('comp-assess-title').textContent = `Record: ${empName} — ${compName}`;
  const existing = (records||[]).find(r => r.CompetencyID === compId);
  setVal('ca-status', existing?.Status || 'Competent');
  setVal('ca-level', existing?.AchievedLevel || '3');
  setVal('ca-date', existing?.AssessedDate || new Date().toISOString().slice(0,10));
  setVal('ca-notes', existing?.Notes || '');
  showModal('comp-assess-modal');
}

async function saveCompAssessment() {
  const empId = val('ca-emp-id'), compId = val('ca-comp-id');
  if (!empId || !compId) return;
  const r = await POST('/api/competency/records', {
    empId, competencyId: compId, status: val('ca-status'),
    achievedLevel: parseInt(val('ca-level') || '3', 10),
    assessedDate: val('ca-date'), notes: val('ca-notes')
  });
  if (!ok(r)) return;
  closeModal('comp-assess-modal');
  toast('Competency record saved.');
  loadCompetency();
}

// ---- Knowledge Base ----
let _kbActiveCat = null;
let _kbSearchTimer = null;

async function loadKnowledgeBase() {
  _kbActiveCat = null;
  const [cats, articles] = await Promise.all([
    GET('/api/kb/categories'),
    GET('/api/kb/articles')
  ]);
  renderKBCategories(cats || []);
  renderKBArticles(articles || []);
}

function renderKBCategories(cats) {
  const el = document.getElementById('kb-categories');
  if (!el) return;
  el.innerHTML = `<button class="btn kb-cat-btn ${_kbActiveCat === null ? 'active' : ''}" onclick="filterKBByCat(null)">All</button>` +
    cats.map(c => `<button class="btn kb-cat-btn ${_kbActiveCat === c.CategoryID ? 'active' : ''}" onclick="filterKBByCat(${c.CategoryID})" style="border-color:${c.Color};${_kbActiveCat===c.CategoryID?'background:'+c.Color+';color:#fff;':'color:'+c.Color}">
      ${c.Icon} ${esc(c.Name)} <span class="cell-sub">${c.articleCount||0}</span></button>`
    ).join('') +
    (currentUser?.admin ? `<button class="btn btn-ghost btn-sm" onclick="openKBCatManager()">⚙️ Categories</button>` : '');
}

async function filterKBByCat(catId) {
  _kbActiveCat = catId;
  const qs = catId ? `?categoryId=${catId}` : '';
  const [cats, articles] = await Promise.all([GET('/api/kb/categories'), GET('/api/kb/articles' + qs)]);
  renderKBCategories(cats || []);
  renderKBArticles(articles || []);
}

function searchKB() {
  clearTimeout(_kbSearchTimer);
  _kbSearchTimer = setTimeout(async () => {
    const q = val('kb-search');
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (_kbActiveCat) qs.set('categoryId', _kbActiveCat);
    const articles = await GET('/api/kb/articles?' + qs);
    renderKBArticles(articles || []);
  }, 280);
}

function renderKBArticles(articles) {
  const el = document.getElementById('kb-articles');
  if (!el) return;
  if (!articles.length) {
    el.innerHTML = '<p class="cell-sub mt-2">No articles found. ' + (currentUser?.admin ? 'Click "+ New Article" to create one.' : '') + '</p>';
    return;
  }
  el.innerHTML = `<div class="kb-grid">${articles.map(a => {
    const catStyle = a.catColor ? `border-top:3px solid ${a.catColor}` : '';
    const tags = (a.Tags || '').split(',').map(t => t.trim()).filter(Boolean);
    return `<div class="kb-card" style="${catStyle}" onclick="viewKBArticle(${a.ArticleID})">
      <div class="kb-card-cat">${a.catIcon||'📄'} ${esc(a.categoryName||'Uncategorised')}</div>
      <h4 class="kb-card-title">${esc(a.Title)}</h4>
      ${tags.length ? `<div class="kb-tags">${tags.slice(0,4).map(t=>`<span class="kb-tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="kb-card-meta">
        <span>👁 ${a.ViewCount||0}</span>
        <span>👍 ${a.helpfulCount||0}</span>
        <span class="cell-sub">${esc((a.UpdatedAt||'').slice(0,10))}</span>
        ${currentUser?.admin ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openKBArticleModal(${a.ArticleID})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();deleteKBArticle(${a.ArticleID})">Delete</button>` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

async function viewKBArticle(id) {
  const a = await GET('/api/kb/articles/' + id);
  if (!a) return;
  const body = renderKBMd(a.Body || '');
  const tags = (a.Tags || '').split(',').map(t => t.trim()).filter(Boolean);
  document.getElementById('kb-view-title').textContent = a.Title;
  document.getElementById('kb-view-body').innerHTML = `
    <div class="kb-view-meta cell-sub mb-2">
      ${a.catIcon||'📄'} ${esc(a.categoryName||'')} · By ${esc(a.AuthoredBy||'—')} · Updated ${esc((a.UpdatedAt||'').slice(0,10))} · ${a.ViewCount||0} views
    </div>
    ${tags.length ? `<div class="kb-tags mb-2">${tags.map(t=>`<span class="kb-tag">${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="kb-article-body">${body}</div>
    <div class="kb-helpful mt-3">
      <span>Was this helpful?</span>
      <button class="btn btn-outline btn-sm" id="kb-helpful-yes" onclick="rateKBArticle(${id}, true)">👍 Yes (${a.helpfulCount||0})</button>
      <button class="btn btn-outline btn-sm" onclick="rateKBArticle(${id}, false)">👎 No</button>
    </div>`;
  document.getElementById('kb-view-footer').innerHTML = `
    <button class="btn btn-outline" onclick="closeModal('kb-view-modal')">Close</button>
    ${currentUser?.admin ? `<button class="btn btn-ghost btn-sm" onclick="closeModal('kb-view-modal');openKBArticleModal(${id})">Edit</button>` : ''}`;
  showModal('kb-view-modal');
  // refresh article list in background to update view count
  setTimeout(() => {
    const qs = _kbActiveCat ? `?categoryId=${_kbActiveCat}` : '';
    GET('/api/kb/articles' + qs).then(articles => renderKBArticles(articles || []));
  }, 500);
}

async function rateKBArticle(id, helpful) {
  const r = await POST(`/api/kb/articles/${id}/rate`, { helpful });
  if (!ok(r)) return;
  const btn = document.getElementById('kb-helpful-yes');
  if (btn) btn.textContent = `👍 Yes (${r.helpfulCount||0})`;
  toast('Thanks for your feedback!');
}

async function openKBArticleModal(id) {
  clearForm(['kb-article-id','kb-title','kb-tags','kb-body']);
  const cats = await GET('/api/kb/categories');
  const catSel = document.getElementById('kb-cat-sel');
  catSel.innerHTML = '<option value="">— Uncategorised —</option>' +
    (cats||[]).map(c => `<option value="${c.CategoryID}">${c.Icon} ${esc(c.Name)}</option>`).join('');
  if (id) {
    const a = await GET('/api/kb/articles/' + id);
    if (a) {
      setVal('kb-article-id', a.ArticleID); setVal('kb-title', a.Title);
      setVal('kb-tags', a.Tags); setVal('kb-body', a.Body);
      setVal('kb-cat-sel', a.CategoryID || ''); setVal('kb-status', a.Status);
    }
    document.getElementById('kb-modal-title').textContent = 'Edit Article';
  } else {
    document.getElementById('kb-modal-title').textContent = 'New Article';
    setVal('kb-status', 'Published');
  }
  showModal('kb-article-modal');
}

function toggleKbAI(btn) {
  const panel = document.getElementById('kb-ai-panel');
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : '';
  btn.textContent = open ? '🤖 Write with AI' : '✕ Close AI';
  if (!open) document.getElementById('kb-ai-prompt').focus();
}

async function runKbAI(mode) {
  const prompt = document.getElementById('kb-ai-prompt').value.trim();
  if (!prompt) return toast('Describe what the AI should write.', 'error');
  const status = document.getElementById('kb-ai-status');
  const title = val('kb-title'), tags = val('kb-tags');
  status.textContent = '⏳ Generating…';
  document.querySelectorAll('#kb-ai-panel button').forEach(b => b.disabled = true);
  try {
    const r = await POST('/api/kb/ai-draft', { prompt, title, tags });
    if (!ok(r)) { status.textContent = ''; return; }
    const body = document.getElementById('kb-body');
    body.value = (mode === 'append' && body.value.trim())
      ? body.value.trimEnd() + '\n\n' + r.body
      : r.body;
    status.textContent = '✓ Done';
    setTimeout(() => { status.textContent = ''; }, 3000);
  } catch { status.textContent = '❌ Failed'; }
  finally { document.querySelectorAll('#kb-ai-panel button').forEach(b => b.disabled = false); }
}

async function saveKBArticle() {
  const id = val('kb-article-id'), title = val('kb-title');
  if (!title) return toast('Title is required.', 'error');
  const body = { title, categoryId: val('kb-cat-sel') || null, body: val('kb-body'), tags: val('kb-tags'), status: val('kb-status') };
  const r = id ? await PUT('/api/kb/articles/' + id, body) : await POST('/api/kb/articles', body);
  if (!ok(r)) return;
  closeModal('kb-article-modal');
  toast(id ? 'Article updated.' : 'Article published.');
  loadKnowledgeBase();
}

async function deleteKBArticle(id) {
  if (!confirm('Delete this article?')) return;
  await DEL('/api/kb/articles/' + id);
  toast('Article deleted.');
  loadKnowledgeBase();
}

async function openKBCatManager() {
  kbCatMgrReset();
  showModal('kb-catmgr-modal');
  await kbCatMgrRefresh();
}

async function kbCatMgrRefresh() {
  const cats = await GET('/api/kb/categories');
  const el = document.getElementById('kb-catmgr-list');
  if (!el) return;
  if (!cats || !cats.length) { el.innerHTML = '<p class="cell-sub" style="padding:8px 0">No categories yet.</p>'; return; }
  el.innerHTML = cats.map(c => `
    <div class="kb-catmgr-row">
      <span class="kb-catmgr-icon" style="background:${c.Color||'#4f46e5'}20;color:${c.Color||'#4f46e5'}">${c.Icon||'📄'}</span>
      <span class="kb-catmgr-lbl">${esc(c.Name)}</span>
      <span class="cell-sub">${c.articleCount||0} article${c.articleCount===1?'':'s'}</span>
      <div class="kb-catmgr-actions">
        <button class="btn btn-ghost btn-sm" onclick="kbCatMgrEdit(${c.CategoryID})">✏️</button>
        <button class="btn btn-ghost btn-sm" onclick="kbCatMgrDelete(${c.CategoryID},'${esc(c.Name)}')">🗑</button>
      </div>
    </div>`).join('');
}

async function kbCatMgrEdit(id) {
  const cats = await GET('/api/kb/categories');
  const c = (cats||[]).find(x => x.CategoryID === id);
  if (!c) return;
  setVal('kb-catmgr-id', c.CategoryID);
  setVal('kb-catmgr-name', c.Name);
  setVal('kb-catmgr-icon', c.Icon || '📄');
  setVal('kb-catmgr-color', c.Color || '#4f46e5');
  document.getElementById('kb-catmgr-form-title').textContent = 'Edit Category';
  kbCatMgrUpdatePreview();
}

async function kbCatMgrDelete(id, name) {
  if (!confirm(`Delete category "${name}"? Articles in this category will become uncategorised.`)) return;
  const r = await DEL('/api/kb/categories/' + id);
  if (!ok(r)) return;
  toast('Category deleted.');
  await kbCatMgrRefresh();
  loadKnowledgeBase();
}

function kbCatMgrReset() {
  setVal('kb-catmgr-id', '');
  setVal('kb-catmgr-name', '');
  setVal('kb-catmgr-icon', '📄');
  setVal('kb-catmgr-color', '#4f46e5');
  document.getElementById('kb-catmgr-form-title').textContent = 'Add Category';
  kbCatMgrUpdatePreview();
}

function kbCatMgrUpdatePreview() {
  const icon = val('kb-catmgr-icon') || '📄';
  const color = val('kb-catmgr-color') || '#4f46e5';
  const name = val('kb-catmgr-name') || 'Category Name';
  const p = document.getElementById('kb-catmgr-preview');
  if (p) p.innerHTML = `<span style="border-color:${color};color:${color}">${icon} ${esc(name)}</span>`;
}

async function saveKBCategory() {
  const id = val('kb-catmgr-id');
  const name = val('kb-catmgr-name').trim();
  if (!name) return toast('Name is required.', 'error');
  const body = { name, icon: val('kb-catmgr-icon') || '📄', color: val('kb-catmgr-color') || '#4f46e5' };
  const r = id ? await PUT('/api/kb/categories/' + id, body) : await POST('/api/kb/categories', body);
  if (!ok(r)) return;
  toast(id ? 'Category updated.' : 'Category created.');
  kbCatMgrReset();
  await kbCatMgrRefresh();
  loadKnowledgeBase();
}

function renderKBMd(text) {
  if (!text) return '';
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/^### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^## (.+)$/gm,  '<h4>$1</h4>')
    .replace(/^# (.+)$/gm,   '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^(.+)$/, '<p>$1</p>');
}

// ---- AI Description Draft ----
async function aiDraftDesc(targetId, itemType, contextFn) {
  const ctx = contextFn();
  const parts = Object.entries(ctx).filter(([, v]) => v && String(v).trim()).map(([k, v]) => `${k}: ${v}`);
  if (!parts.length) { toast('Enter a name first so AI has something to work with.', 'error'); return; }
  const btn = document.querySelector(`[onclick*="aiDraftDesc('${targetId}'"]`);
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.textContent = '⏳ Drafting…'; btn.disabled = true; }
  const r = await POST('/api/ai/draft-desc', { itemType, context: parts.join('\n') });
  if (btn) { btn.textContent = orig; btn.disabled = false; }
  if (!ok(r)) return;
  const el = document.getElementById(targetId);
  if (el) { el.value = r.description; el.dispatchEvent(new Event('input')); }
  toast('Description drafted by AI — review before saving.');
}

// ---- Init: check session ----
(async () => {
  const user = await GET('/api/auth/me');
  if (user && !user.error) {
    currentUser = user;
    showApp();
  }
  // Enter key on login
  document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('login-user').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-pass').focus(); });
  // KB category manager live preview
  ['kb-catmgr-name','kb-catmgr-icon','kb-catmgr-color'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', kbCatMgrUpdatePreview);
  });
})();

// ── EMPLOYEE ONBOARDING ────────────────────────────────────────────────────
// Tracks new-hire candidates: CV upload → 3-tier review → medical → contract → promotion to tblStaff.
let _onbList = [];
const ONB_STATUS_COLORS = {
  'New':'#64748b','CV Review':'#3b82f6','Interview':'#8b5cf6','Medical':'#f59e0b',
  'Contract':'#ec4899','Completed':'#10b981','Withdrawn':'#ef4444'
};
const DOC_TYPE_LABELS = { cv:'📄 CV', contract:'📜 Contract', 'role-description':'📋 Role Description', medical:'🏥 Medical', id:'🪪 ID', other:'📎 Other' };

async function loadOnboarding() {
  const r = await GET('/api/onboarding');
  if (!ok(r)) return;
  _onbList = Array.isArray(r) ? r : [];
  onbRenderSummary();
  onbFilter();
}

function onbRenderSummary() {
  const counts = {};
  _onbList.forEach(c => { counts[c.Status] = (counts[c.Status] || 0) + 1; });
  const host = document.getElementById('onb-summary');
  if (!host) return;
  const order = ['New','CV Review','Interview','Medical','Contract','Completed','Withdrawn'];
  host.innerHTML = `<div class="stat-pill" style="background:#f1f5f9;color:#1E3A5F;padding:6px 12px;border-radius:18px;font-weight:600">Total ${_onbList.length}</div>` +
    order.filter(s => counts[s]).map(s => `<div class="stat-pill" style="background:${ONB_STATUS_COLORS[s]}1a;color:${ONB_STATUS_COLORS[s]};padding:6px 12px;border-radius:18px;font-weight:600">${esc(s)} ${counts[s]}</div>`).join('');
}

function onbFilter() {
  const q = (val('onb-search') || '').toLowerCase().trim();
  const status = val('onb-status-filter') || '';
  const filtered = _onbList.filter(c => {
    if (status && c.Status !== status) return false;
    if (!q) return true;
    const hay = `${c.FirstName} ${c.LastName} ${c.Email||''} ${c.Position||''} ${c.JobName||''}`.toLowerCase();
    return hay.includes(q);
  });
  onbRender(filtered);
}

function onbRender(list) {
  const host = document.getElementById('onb-list');
  if (!host) return;
  if (!list.length) { host.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>No candidates found. Click <strong>➕ New Candidate</strong> to start.</p></div>`; return; }
  host.innerHTML = `<table class="data-table"><thead><tr>
    <th>Name</th><th>Position</th><th>Status</th><th>CV</th><th>Reviews</th><th>Medical</th><th>Contract</th><th>Created</th><th></th>
  </tr></thead><tbody>${list.map(c => {
    const reviewsBadge = `${c.ApprovedReviews||0}/${c.TotalReviews||0}`;
    const medical = c.MedicalFit === 1 ? '✅ Fit' : c.MedicalFit === 0 ? '⏳ Pending' : '—';
    const color = ONB_STATUS_COLORS[c.Status] || '#64748b';
    return `<tr style="cursor:pointer" onclick="onbOpen(${c.CandidateID})">
      <td><strong>${esc(c.FirstName)} ${esc(c.LastName)}</strong>${c.Email ? `<br><span class="cell-sub">${esc(c.Email)}</span>` : ''}</td>
      <td>${esc(c.Position || c.JobName || '—')}${c.DeptName ? `<br><span class="cell-sub">${esc(c.DeptName)}</span>` : ''}</td>
      <td><span class="badge" style="background:${color}1a;color:${color};border:1px solid ${color}40">${esc(c.Status)}</span></td>
      <td>${c.HasCV ? '✅' : '❌'}</td>
      <td><span class="badge" style="background:${c.ApprovedReviews >= 3 ? '#10b9811a' : '#f1f5f9'};color:${c.ApprovedReviews >= 3 ? '#10b981' : '#64748b'}">${reviewsBadge}</span></td>
      <td>${medical}</td>
      <td>${c.HasContract ? '✅' : '❌'}</td>
      <td class="cell-sub">${(c.CreatedAt || '').slice(0,10)}</td>
      <td onclick="event.stopPropagation()"><button class="btn btn-ghost btn-sm" onclick="onbOpen(${c.CandidateID})">👁 Open</button></td>
    </tr>`;
  }).join('')}</tbody></table>`;
}

function onbOpenNew() {
  const depts = (cache && cache.depts) || [];
  const jobs  = (cache && cache.jobs)  || [];
  // Inline CSS scoped via #onb-new-modal — self-contained "modern card" form, no global style.css edits required
  const css = `
    #onb-new-modal .modal { max-width: 880px; width: 92%; border-radius: 14px; box-shadow: 0 24px 60px rgba(15,23,42,.25); overflow: hidden; padding: 0; }
    #onb-new-modal .modal-header { background: linear-gradient(135deg, #1E3A5F 0%, #2c5282 100%); color: #fff; padding: 22px 28px; border: 0; display: flex; align-items: flex-start; gap: 12px; }
    #onb-new-modal .modal-header h3 { color: #fff; margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.3px; display: flex; align-items: center; gap: 10px; }
    #onb-new-modal .modal-header .onb-sub { color: #cbd5e1; font-size: 13px; margin-top: 4px; font-weight: 400; }
    #onb-new-modal .modal-header .btn-ghost { color: #fff; opacity: 0.85; }
    #onb-new-modal .modal-header .btn-ghost:hover { opacity: 1; background: rgba(255,255,255,0.12); }
    #onb-new-modal .modal-body { padding: 26px 28px; background: #f8fafc; max-height: 70vh; overflow-y: auto; }
    #onb-new-modal .onb-section { background: #fff; border-radius: 12px; padding: 20px 22px; margin-bottom: 16px; border: 1px solid #e2e8f0; }
    #onb-new-modal .onb-section:last-child { margin-bottom: 0; }
    #onb-new-modal .onb-section-title { font-size: 13px; font-weight: 700; color: #1E3A5F; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }
    #onb-new-modal .onb-section-title .icon { background: #FBC02D; color: #1E3A5F; padding: 5px 8px; border-radius: 6px; font-size: 14px; }
    #onb-new-modal .onb-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 18px; }
    #onb-new-modal .onb-grid .full { grid-column: 1 / -1; }
    #onb-new-modal .onb-field { display: flex; flex-direction: column; gap: 6px; }
    #onb-new-modal .onb-field label { font-size: 12px; font-weight: 600; color: #475569; letter-spacing: 0.3px; }
    #onb-new-modal .onb-field label .req { color: #ef4444; margin-left: 3px; }
    #onb-new-modal .onb-field input, #onb-new-modal .onb-field select { padding: 11px 14px; font-size: 14px; border: 1.5px solid #e2e8f0; border-radius: 8px; background: #fff; color: #0f172a; transition: all 0.15s ease; width: 100%; box-sizing: border-box; font-family: inherit; }
    #onb-new-modal .onb-field input:hover, #onb-new-modal .onb-field select:hover { border-color: #cbd5e1; }
    #onb-new-modal .onb-field input:focus, #onb-new-modal .onb-field select:focus { outline: none; border-color: #1E3A5F; box-shadow: 0 0 0 3px rgba(30,58,95,0.12); }
    #onb-new-modal .modal-footer { padding: 18px 28px; background: #fff; border-top: 1px solid #e2e8f0; display: flex; justify-content: flex-end; gap: 10px; margin: 0; }
    #onb-new-modal .modal-footer .btn { padding: 11px 22px; font-size: 14px; font-weight: 600; border-radius: 8px; }
    #onb-new-modal .modal-footer .btn-primary { background: linear-gradient(135deg, #1E3A5F 0%, #2c5282 100%); border: 0; color: #fff; box-shadow: 0 4px 12px rgba(30,58,95,0.25); }
    #onb-new-modal .modal-footer .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(30,58,95,0.35); }
    @media (max-width: 640px) {
      #onb-new-modal .onb-grid { grid-template-columns: 1fr; }
      #onb-new-modal .modal-body { padding: 18px; }
    }
  `;
  const html = `<style>${css}</style><div id="onb-new-modal" class="modal-overlay" onclick="if(event.target===this)this.remove()">
    <div class="modal">
      <div class="modal-header">
        <div style="flex:1">
          <h3>➕ New Candidate</h3>
          <div class="onb-sub">Start a pre-hire record · CV uploads, three-tier reviews, medical &amp; contract tracking</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()" title="Close">✕</button>
      </div>
      <div class="modal-body">
        <div class="onb-section">
          <div class="onb-section-title"><span class="icon">👤</span> Personal Information</div>
          <div class="onb-grid">
            <div class="onb-field"><label>First Name <span class="req">*</span></label><input id="onb-new-fn" required placeholder="John"></div>
            <div class="onb-field"><label>Last Name <span class="req">*</span></label><input id="onb-new-ln" required placeholder="Smith"></div>
            <div class="onb-field"><label>Email</label><input id="onb-new-email" type="email" placeholder="john.smith@example.com"></div>
            <div class="onb-field"><label>Phone</label><input id="onb-new-phone" placeholder="+66 12 345 6789"></div>
          </div>
        </div>
        <div class="onb-section">
          <div class="onb-section-title"><span class="icon">💼</span> Position &amp; Assignment</div>
          <div class="onb-grid">
            <div class="onb-field full"><label>Position Title</label><input id="onb-new-pos" placeholder="e.g. Haul Truck Operator"></div>
            <div class="onb-field"><label>Department</label><select id="onb-new-dept"><option value="">— select department —</option>${depts.map(d => `<option value="${d.DeptID}">${esc(d.Department)}</option>`).join('')}</select></div>
            <div class="onb-field"><label>Job Role</label><select id="onb-new-job"><option value="">— select job role —</option>${jobs.map(j => `<option value="${j.JobID}">${esc(j.Title || j.Job || '')}</option>`).join('')}</select></div>
            <div class="onb-field full"><label>Proposed Start Date</label><input id="onb-new-start" type="date"></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="onbCreate()">✓ Create Candidate</button>
      </div>
    </div></div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  setTimeout(() => { const fn = document.getElementById('onb-new-fn'); if (fn) fn.focus(); }, 30);
}

async function onbCreate() {
  const body = {
    FirstName: val('onb-new-fn').trim(),
    LastName:  val('onb-new-ln').trim(),
    Email:     val('onb-new-email').trim(),
    Phone:     val('onb-new-phone').trim(),
    Position:  val('onb-new-pos').trim(),
    DeptID:    parseInt(val('onb-new-dept'), 10) || null,
    JobID:     parseInt(val('onb-new-job'), 10) || null,
    StartDate: val('onb-new-start') || null
  };
  if (!body.FirstName || !body.LastName) { toast('First & last name required.', 'error'); return; }
  const r = await POST('/api/onboarding', body);
  if (!ok(r)) return;
  document.querySelector('.modal-overlay')?.remove();
  toast('Candidate created.');
  await loadOnboarding();
  onbOpen(r.CandidateID);
}

async function onbOpen(id) {
  const c = await GET('/api/onboarding/' + id);
  if (!ok(c)) return;
  let depts = (cache && cache.depts) || [];
  let jobs  = (cache && cache.jobs)  || [];
  if (!depts.length && typeof loadLookupCache === 'function') {
    try { await loadLookupCache(); depts = cache.depts || []; jobs = cache.jobs || []; } catch {}
  }
  const docs = c.documents || [];
  const reviews = c.reviews || [];
  const med = c.medical || {};
  const docList = docs.length ? docs.map(d => `<div class="onb-doc-row">
    <span>${DOC_TYPE_LABELS[d.DocType] || d.DocType} — <strong>${esc(d.FileName)}</strong></span>
    <span class="cell-sub">${esc((d.UploadedBy||'')+' · '+(d.UploadedAt||'').slice(0,16))}</span>
    <span style="margin-left:auto">
      <a class="btn btn-ghost btn-sm" href="/api/onboarding/documents/${d.DocID}?inline=1" target="_blank">👁</a>
      <a class="btn btn-ghost btn-sm" href="/api/onboarding/documents/${d.DocID}">⬇</a>
      <button class="btn btn-danger btn-sm" onclick="onbDelDoc(${d.DocID},${id})">🗑</button>
    </span>
  </div>`).join('') : `<div class="cell-sub" style="padding:8px">No documents uploaded yet.</div>`;
  const reviewRows = reviews.map(r => {
    const decisionColor = r.Decision === 'Approved' ? '#10b981' : r.Decision === 'Rejected' ? '#ef4444' : '#64748b';
    return `<div class="onb-review-row">
      <strong>${esc(r.ReviewerRole)}</strong>
      <input id="onb-rev-name-${r.ReviewID}" placeholder="Reviewer name" value="${esc(r.ReviewerName||'')}">
      <select id="onb-rev-dec-${r.ReviewID}" style="background:${decisionColor}1a;color:${decisionColor};border:1px solid ${decisionColor}40">
        <option ${r.Decision==='Pending'?'selected':''}>Pending</option>
        <option ${r.Decision==='Approved'?'selected':''}>Approved</option>
        <option ${r.Decision==='Rejected'?'selected':''}>Rejected</option>
      </select>
      <input id="onb-rev-com-${r.ReviewID}" placeholder="Comments" value="${esc(r.Comments||'')}">
      <button class="btn btn-primary btn-sm" onclick="onbSaveReview(${r.ReviewID},${id})">💾 Save</button>
      ${r.ReviewedAt ? `<span class="cell-sub">Reviewed ${esc(r.ReviewedAt.slice(0,16))}</span>` : ''}
    </div>`;
  }).join('');
  const approvedAll = (c.reviews||[]).filter(r => r.Decision==='Approved').length >= 3;
  const fit = !!med.FitForWork;
  const promotable = approvedAll && fit && !c.PromotedStaffID && c.Status !== 'Withdrawn';
  const html = `<div class="modal-overlay" onclick="if(event.target===this)this.remove()">
    <div class="modal" style="max-width:1100px;max-height:92vh;display:flex;flex-direction:column">
      <div class="modal-header" style="display:flex;align-items:center;gap:10px">
        <h3 style="margin:0">🧑‍💼 ${esc(c.FirstName)} ${esc(c.LastName)}</h3>
        <span class="badge" style="background:${ONB_STATUS_COLORS[c.Status]||'#64748b'}1a;color:${ONB_STATUS_COLORS[c.Status]||'#64748b'};border:1px solid ${ONB_STATUS_COLORS[c.Status]||'#64748b'}40">${esc(c.Status)}</span>
        ${c.PromotedStaffID ? `<span class="badge" style="background:#10b9811a;color:#10b981">✅ Promoted → Staff #${c.PromotedStaffID}</span>` : ''}
        <span style="flex:1"></span>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕ Close</button>
      </div>
      <div class="modal-body" style="overflow-y:auto;display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:14px">
        <!-- Personal info -->
        <div class="card"><div class="card-header"><h4>👤 Personal Information</h4></div><div class="card-body" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div class="form-row"><label>First Name</label><input id="onb-e-fn" value="${esc(c.FirstName||'')}"></div>
          <div class="form-row"><label>Last Name</label><input id="onb-e-ln" value="${esc(c.LastName||'')}"></div>
          <div class="form-row"><label>Email</label><input id="onb-e-email" type="email" value="${esc(c.Email||'')}"></div>
          <div class="form-row"><label>Phone</label><input id="onb-e-phone" value="${esc(c.Phone||'')}"></div>
          <div class="form-row"><label>DOB</label><input id="onb-e-dob" type="date" value="${esc(c.DOB||'')}"></div>
          <div class="form-row"><label>Gender</label><select id="onb-e-gender"><option value="">—</option><option ${c.Gender==='M'?'selected':''}>M</option><option ${c.Gender==='F'?'selected':''}>F</option><option ${c.Gender==='Other'?'selected':''}>Other</option></select></div>
          <div class="form-row" style="grid-column:1/-1"><label>Address</label><textarea id="onb-e-address" rows="2">${esc(c.Address||'')}</textarea></div>
          <div class="form-row"><label>Emergency Contact</label><input id="onb-e-emc" value="${esc(c.EmergencyContact||'')}"></div>
          <div class="form-row"><label>Emergency Phone</label><input id="onb-e-emp" value="${esc(c.EmergencyPhone||'')}"></div>
        </div></div>

        <!-- Position -->
        <div class="card"><div class="card-header"><h4>💼 Position</h4></div><div class="card-body" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div class="form-row" style="grid-column:1/-1"><label>Position Title</label><input id="onb-e-pos" value="${esc(c.Position||'')}"></div>
          <div class="form-row"><label>Department</label><select id="onb-e-dept"><option value="">—</option>${depts.map(d => `<option value="${d.DeptID}" ${d.DeptID===c.DeptID?'selected':''}>${esc(d.Department)}</option>`).join('')}</select></div>
          <div class="form-row"><label>Job Role</label><select id="onb-e-job"><option value="">—</option>${jobs.map(j => `<option value="${j.JobID}" ${j.JobID===c.JobID?'selected':''}>${esc(j.Title || j.Job || '')}</option>`).join('')}</select></div>
          <div class="form-row"><label>Start Date</label><input id="onb-e-start" type="date" value="${esc(c.StartDate||'')}"></div>
          <div class="form-row"><label>Status</label><select id="onb-e-status">${['New','CV Review','Interview','Medical','Contract','Completed','Withdrawn'].map(s=>`<option ${s===c.Status?'selected':''}>${s}</option>`).join('')}</select></div>
          <div class="form-row" style="grid-column:1/-1"><label>Notes</label><textarea id="onb-e-notes" rows="2">${esc(c.Notes||'')}</textarea></div>
          <div style="grid-column:1/-1;display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" onclick="onbSavePersonal(${id})">💾 Save Personal & Position</button>
            <button class="btn btn-accent btn-sm" onclick="onbGenRoleDesc(${id})">🤖 AI Role Description</button>
            <span style="flex:1"></span>
            ${promotable ? `<button class="btn btn-success btn-sm" onclick="onbPromote(${id})" title="All reviews approved + medical fit → create staff record">🚀 Promote to Staff</button>` : ''}
            <button class="btn btn-danger btn-sm" onclick="onbDelete(${id})">🗑 Delete</button>
          </div>
        </div></div>

        <!-- Documents -->
        <div class="card" style="grid-column:1/-1"><div class="card-header" style="display:flex;align-items:center;gap:8px">
          <h4 style="margin:0">📄 Documents</h4>
          <span style="flex:1"></span>
          <select id="onb-doc-type"><option value="cv">📄 CV / Resume</option><option value="contract">📜 Employment Contract</option><option value="role-description">📋 Role Description</option><option value="medical">🏥 Medical Report</option><option value="id">🪪 ID / Passport</option><option value="other">📎 Other</option></select>
          <input type="file" id="onb-doc-file" style="max-width:280px">
          <button class="btn btn-primary btn-sm" onclick="onbUploadDoc(${id})">⬆ Upload</button>
        </div><div class="card-body">${docList}</div></div>

        <!-- Reviews -->
        <div class="card" style="grid-column:1/-1"><div class="card-header"><h4>🔍 CV Reviews (3-tier approval)</h4></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:8px">${reviewRows}</div></div>

        <!-- Medical -->
        <div class="card" style="grid-column:1/-1"><div class="card-header"><h4>🏥 Pre-employment Medical</h4></div>
        <div class="card-body" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
          <div class="form-row"><label>Provider</label><input id="onb-med-prov" value="${esc(med.Provider||'')}"></div>
          <div class="form-row"><label>Appointment Date</label><input id="onb-med-appt" type="date" value="${esc(med.AppointmentDate||'')}"></div>
          <div class="form-row"><label>Completed Date</label><input id="onb-med-done" type="date" value="${esc(med.CompletedDate||'')}"></div>
          <div class="form-row"><label>Result</label><input id="onb-med-res" value="${esc(med.Result||'')}"></div>
          <div class="form-row"><label>Fit for Work?</label><select id="onb-med-fit"><option value="0" ${!fit?'selected':''}>No / Pending</option><option value="1" ${fit?'selected':''}>Yes — Fit</option></select></div>
          <div class="form-row"><label>Restrictions</label><input id="onb-med-rest" value="${esc(med.Restrictions||'')}"></div>
          <div class="form-row" style="grid-column:1/-1"><label>Notes</label><textarea id="onb-med-notes" rows="2">${esc(med.Notes||'')}</textarea></div>
          <div style="grid-column:1/-1"><button class="btn btn-primary btn-sm" onclick="onbSaveMedical(${id})">💾 Save Medical</button></div>
        </div></div>
      </div>
    </div></div>`;
  document.querySelector('.modal-overlay')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);
}

async function onbSavePersonal(id) {
  const body = {
    FirstName: val('onb-e-fn'), LastName: val('onb-e-ln'), Email: val('onb-e-email'),
    Phone: val('onb-e-phone'), DOB: val('onb-e-dob'), Gender: val('onb-e-gender'),
    Address: val('onb-e-address'), EmergencyContact: val('onb-e-emc'), EmergencyPhone: val('onb-e-emp'),
    Position: val('onb-e-pos'), DeptID: parseInt(val('onb-e-dept'),10)||null, JobID: parseInt(val('onb-e-job'),10)||null,
    StartDate: val('onb-e-start'), Status: val('onb-e-status'), Notes: val('onb-e-notes')
  };
  const r = await api('PUT', '/api/onboarding/' + id, body);
  if (!ok(r)) return;
  toast('Saved.');
  await loadOnboarding();
  onbOpen(id);
}

async function onbUploadDoc(id) {
  const file = document.getElementById('onb-doc-file')?.files?.[0];
  if (!file) { toast('Pick a file first.', 'error'); return; }
  const docType = val('onb-doc-type');
  const fd = new FormData();
  fd.append('file', file);
  fd.append('docType', docType);
  const resp = await fetch('/api/onboarding/' + id + '/documents', { method: 'POST', body: fd });
  const r = await resp.json();
  if (!ok(r)) return;
  toast('Document uploaded.');
  onbOpen(id);
  loadOnboarding();
}

async function onbDelDoc(docId, candidateId) {
  if (!confirm('Delete this document?')) return;
  const r = await api('DELETE', '/api/onboarding/documents/' + docId);
  if (!ok(r)) return;
  toast('Deleted.');
  onbOpen(candidateId);
  loadOnboarding();
}

async function onbSaveReview(reviewId, candidateId) {
  const body = {
    ReviewerName: val('onb-rev-name-' + reviewId),
    Decision: val('onb-rev-dec-' + reviewId),
    Comments: val('onb-rev-com-' + reviewId)
  };
  const r = await api('PUT', '/api/onboarding/reviews/' + reviewId, body);
  if (!ok(r)) return;
  toast('Review saved.');
  onbOpen(candidateId);
  loadOnboarding();
}

async function onbSaveMedical(id) {
  const body = {
    Provider: val('onb-med-prov'), AppointmentDate: val('onb-med-appt'), CompletedDate: val('onb-med-done'),
    Result: val('onb-med-res'), FitForWork: val('onb-med-fit') === '1' ? 1 : 0,
    Restrictions: val('onb-med-rest'), Notes: val('onb-med-notes')
  };
  const r = await api('PUT', '/api/onboarding/' + id + '/medical', body);
  if (!ok(r)) return;
  toast('Medical saved.');
  onbOpen(id);
  loadOnboarding();
}

async function onbGenRoleDesc(id) {
  const position = (val('onb-e-pos') || '').trim();
  if (!position) { toast('Enter a Position Title first.', 'error'); return; }
  toast('Drafting role description with AI…');
  const r = await POST('/api/onboarding/' + id + '/role-description', { position });
  if (!ok(r)) return;
  const rd = r.roleDescription || {};
  const html = `<div class="modal-overlay" onclick="if(event.target===this)this.remove()">
    <div class="modal" style="max-width:760px;max-height:90vh;display:flex;flex-direction:column">
      <div class="modal-header"><h3>🤖 AI-Generated Role Description</h3><button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
      <div class="modal-body" style="overflow-y:auto">
        <h2>${esc(rd.title || position)}</h2>
        <p>${esc(rd.summary || '')}</p>
        ${rd.reportsTo ? `<p><strong>Reports to:</strong> ${esc(rd.reportsTo)}</p>` : ''}
        ${rd.responsibilities ? `<h4>Responsibilities</h4><ul>${rd.responsibilities.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        ${rd.requirements ? `<h4>Requirements</h4><ul>${rd.requirements.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        ${rd.qualifications ? `<h4>Qualifications</h4><ul>${rd.qualifications.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        ${rd.competencies ? `<h4>Competencies</h4><ul>${rd.competencies.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Close</button>
        <button class="btn btn-primary" onclick="window.print()">🖨 Print</button>
      </div>
    </div></div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

async function onbPromote(id) {
  if (!confirm('Promote this candidate to active staff? This creates a tblStaff record and marks the onboarding Completed.')) return;
  const r = await POST('/api/onboarding/' + id + '/promote');
  if (!ok(r)) return;
  toast('Promoted to Staff #' + r.StaffID);
  document.querySelector('.modal-overlay')?.remove();
  loadOnboarding();
}

async function onbDelete(id) {
  if (!confirm('Delete this candidate permanently? All documents and reviews will be removed.')) return;
  const r = await api('DELETE', '/api/onboarding/' + id);
  if (!ok(r)) return;
  toast('Candidate deleted.');
  document.querySelector('.modal-overlay')?.remove();
  loadOnboarding();
}

// ── ATTENDANCE ─────────────────────────────────────────────────────────────
// Uses /api/roster/onduty + /api/leave to build a day-view: rostered employees with
// status pills (Present/Absent/Late/Leave/etc.), bulk "Mark All Present", per-row edit.
let _attData = { date: '', rows: [], summary: {} };
const ATT_STATUSES = ['Present','Absent','Late','Leave','No Show','Excused','Unmarked'];
const ATT_STATUS_COLORS = {
  'Present':'#10b981','Absent':'#ef4444','Late':'#f59e0b','Leave':'#3b82f6',
  'No Show':'#dc2626','Excused':'#8b5cf6','Unmarked':'#94a3b8'
};

async function loadAttendance() {
  const today = new Date().toISOString().slice(0,10);
  const el = document.getElementById('att-date');
  if (el && !el.value) el.value = today;
  const date = (el && el.value) || today;
  const r = await GET('/api/attendance/day?date=' + encodeURIComponent(date));
  if (!ok(r)) return;
  _attData = r;
  attRenderSummary();
  attRenderRows();
}

function attShift(delta) {
  const el = document.getElementById('att-date');
  if (!el) return;
  if (delta === 0) { el.value = new Date().toISOString().slice(0,10); }
  else {
    const d = new Date((el.value || new Date().toISOString().slice(0,10)) + 'T00:00:00');
    d.setDate(d.getDate() + delta);
    el.value = d.toISOString().slice(0,10);
  }
  loadAttendance();
}

function attRenderSummary() {
  const host = document.getElementById('att-summary');
  if (!host) return;
  const s = _attData.summary || {};
  host.innerHTML = `<div class="stat-pill" style="background:#f1f5f9;color:#1E3A5F;padding:6px 12px;border-radius:18px;font-weight:600">Rostered ${s.total||0}</div>` +
    ATT_STATUSES.filter(st => s[st]).map(st => `<div class="stat-pill" style="background:${ATT_STATUS_COLORS[st]}1a;color:${ATT_STATUS_COLORS[st]};padding:6px 12px;border-radius:18px;font-weight:600">${esc(st)} ${s[st]}</div>`).join('');
}

function attRenderRows() {
  const host = document.getElementById('att-list');
  if (!host) return;
  const q = ((val('att-search') || '').toLowerCase());
  let rows = _attData.rows || [];
  if (q) rows = rows.filter(r => (`${r.EmpName||''} ${r.DeptName||''} ${r.JobName||''}`).toLowerCase().includes(q));
  if (!rows.length) {
    host.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>No employees rostered for ${esc(_attData.date)}. Assign shifts in the <strong>Shift Roster</strong> first.</p></div>`;
    return;
  }
  host.innerHTML = `<table class="data-table"><thead><tr>
    <th style="width:24%">Employee</th><th>Shift</th><th>Status</th><th>Time In / Out</th><th>Notes</th><th></th>
  </tr></thead><tbody>${rows.map(r => attRowHtml(r)).join('')}</tbody></table>`;
}

function attRowHtml(r) {
  const att = r.attendance || {};
  const leave = r.leave;
  const eff = r.effectiveStatus;
  const col = ATT_STATUS_COLORS[eff] || '#94a3b8';
  // If on approved leave, render the leave badge instead of a status select (immutable from this page)
  const statusCell = leave
    ? `<span class="badge" style="background:${esc(leave.LeaveTypeColor||'#3b82f6')}1a;color:${esc(leave.LeaveTypeColor||'#3b82f6')};border:1px solid ${esc(leave.LeaveTypeColor||'#3b82f6')}40;padding:4px 10px;border-radius:14px;font-weight:600">🏖️ ${esc(leave.LeaveTypeName)}</span><div class="cell-sub">${esc(leave.StartDate)} → ${esc(leave.EndDate)}</div>`
    : `<select class="att-status-sel" data-eid="${r.EmpID}" onchange="attMark(${r.EmpID}, this.value)" style="background:${col}1a;color:${col};border:1.5px solid ${col}40;border-radius:8px;padding:6px 10px;font-weight:600">
        ${['Present','Absent','Late','No Show','Excused'].map(s => `<option ${eff===s?'selected':''} value="${s}">${s}</option>`).join('')}
        <option ${eff==='Unmarked'?'selected':''} value="Unmarked" disabled>— Unmarked —</option>
      </select>`;
  const timeCells = leave ? '<span class="cell-sub">—</span>' :
    `<input type="time" id="att-tin-${r.EmpID}" value="${esc(att.TimeIn||'')}" onblur="attUpdateField(${r.EmpID},'TimeIn',this.value)" style="width:90px"> <input type="time" id="att-tout-${r.EmpID}" value="${esc(att.TimeOut||'')}" onblur="attUpdateField(${r.EmpID},'TimeOut',this.value)" style="width:90px">`;
  const notesCell = leave ? `<span class="cell-sub">${esc(leave.Reason||'')}</span>` :
    `<input id="att-notes-${r.EmpID}" value="${esc(att.Notes||'')}" placeholder="Reason / note" onblur="attUpdateField(${r.EmpID},'Notes',this.value)" style="width:100%">`;
  const clearBtn = (!leave && att.AttendanceID) ? `<button class="btn btn-ghost btn-sm" onclick="attClear(${att.AttendanceID})" title="Clear marking">↺</button>` : '';
  return `<tr>
    <td><strong>${esc(r.EmpName||'')}</strong>${r.DeptName ? `<br><span class="cell-sub">${esc(r.DeptName)}</span>` : ''}</td>
    <td>${esc(r.ShiftLabel||'')}${r.StartTime ? `<br><span class="cell-sub">${esc(r.StartTime)}–${esc(r.EndTime||'')}</span>` : ''}</td>
    <td>${statusCell}</td>
    <td>${timeCells}</td>
    <td>${notesCell}</td>
    <td>${clearBtn}</td>
  </tr>`;
}

async function attMark(empId, status) {
  if (status === 'Unmarked') return;
  const date = _attData.date;
  const r = await POST('/api/attendance/mark', { EmpID: empId, AttDate: date, Status: status });
  if (!ok(r)) return;
  toast(`Marked ${status}.`);
  loadAttendance();
}
async function attUpdateField(empId, field, value) {
  const date = _attData.date;
  const row = (_attData.rows || []).find(x => x.EmpID === empId) || {};
  const att = row.attendance || {};
  const body = { EmpID: empId, AttDate: date, Status: att.Status || 'Present', TimeIn: att.TimeIn, TimeOut: att.TimeOut, Notes: att.Notes };
  body[field] = value;
  const r = await POST('/api/attendance/mark', body);
  if (!ok(r, 'Save failed')) return;
}
async function attClear(attendanceId) {
  if (!confirm('Clear this attendance entry?')) return;
  const r = await api('DELETE', '/api/attendance/' + attendanceId);
  if (!ok(r)) return;
  toast('Cleared.'); loadAttendance();
}
async function attMarkAllPresent() {
  if (!confirm('Mark all unmarked rostered employees as Present?')) return;
  const date = _attData.date;
  const r = await POST('/api/attendance/mark-all-present', { date });
  if (!ok(r)) return;
  toast(`Marked ${r.created} present${r.leaveAutoCount ? ` · ${r.leaveAutoCount} on leave auto-flagged` : ''}.`);
  loadAttendance();
}

// ── MONTHLY REVIEW (workforce planning) ──────────────────────────────────────
// Calendar-grid view: rows = employees, columns = days. Each cell shows colored status.
// Right side: aggregated counts (Present / Absent / Late / Leave / etc.) + attendance %.
let _attMonthData = { year:0, month:0, daysInMonth:0, rows:[], summary:{} };
let _attView = 'day';

function attSetView(view) {
  _attView = view;
  document.getElementById('att-view-day').style.display   = view === 'day'   ? '' : 'none';
  document.getElementById('att-view-month').style.display = view === 'month' ? '' : 'none';
  document.getElementById('att-view-day-btn').className   = view === 'day'   ? 'btn btn-primary' : 'btn btn-ghost';
  document.getElementById('att-view-month-btn').className = view === 'month' ? 'btn btn-primary' : 'btn btn-ghost';
  if (view === 'month') {
    const el = document.getElementById('att-month');
    if (el && !el.value) {
      const n = new Date();
      el.value = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;
    }
    attPopulateDeptFilter();
    loadAttendanceMonth();
  }
}

function attPopulateDeptFilter() {
  const sel = document.getElementById('att-month-dept');
  if (!sel) return;
  const current = sel.value;
  const depts = (cache && cache.depts) || [];
  sel.innerHTML = `<option value="">All departments</option>` + depts.map(d => `<option value="${d.DeptID}">${esc(d.Department||'')}</option>`).join('');
  sel.value = current;
}

function attMonthShift(delta) {
  const el = document.getElementById('att-month');
  if (!el) return;
  const n = new Date();
  if (delta === 0) {
    el.value = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;
  } else {
    const [y, m] = (el.value || `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`).split('-').map(Number);
    const d = new Date(y, (m - 1) + delta, 1);
    el.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  }
  loadAttendanceMonth();
}

async function loadAttendanceMonth() {
  const el = document.getElementById('att-month');
  if (!el || !el.value) return;
  const [year, month] = el.value.split('-').map(Number);
  const deptId = val('att-month-dept') || '';
  const url = `/api/attendance/month?year=${year}&month=${month}${deptId ? '&deptId=' + deptId : ''}`;
  const r = await GET(url);
  if (!ok(r)) return;
  _attMonthData = r;
  attRenderMonthSummary();
  attRenderMonth();
}

function attRenderMonthSummary() {
  const host = document.getElementById('att-month-summary');
  if (!host) return;
  const s = _attMonthData.summary || {};
  const pill = (label, n, color) => `<div class="stat-pill" style="background:${color}1a;color:${color};padding:6px 12px;border-radius:18px;font-weight:600">${esc(label)} ${n||0}</div>`;
  const rateCol = s.attendanceRate >= 95 ? '#10b981' : s.attendanceRate >= 85 ? '#f59e0b' : '#ef4444';
  host.innerHTML =
    pill('Employees', s.employees, '#1E3A5F') +
    pill('Attendance Rate ' + (s.attendanceRate||0) + '%', '', rateCol) +
    pill('Present', s.Present, '#10b981') +
    pill('Absent', s.Absent, '#ef4444') +
    pill('Late', s.Late, '#f59e0b') +
    pill('Leave', s.Leave, '#3b82f6') +
    pill('No Show', s['No Show'], '#dc2626') +
    pill('Excused', s.Excused, '#8b5cf6') +
    pill('Unmarked', s.Unmarked, '#94a3b8');
}

function attRenderMonth() {
  const host = document.getElementById('att-month-grid');
  if (!host) return;
  const q = (val('att-month-search') || '').toLowerCase();
  let rows = _attMonthData.rows || [];
  if (q) rows = rows.filter(r => (`${r.EmpName||''} ${r.DeptName||''} ${r.JobName||''}`).toLowerCase().includes(q));
  if (!rows.length) {
    host.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>No employees were rostered, marked, or on leave in this month${val('att-month-dept')?' for the chosen department':''}.</p></div>`;
    return;
  }
  const days = _attMonthData.daysInMonth || 30;
  const year = _attMonthData.year, month = _attMonthData.month;
  const COLORS = { 'Present':'#10b981','Absent':'#ef4444','Late':'#f59e0b','Leave':'#3b82f6','No Show':'#dc2626','Excused':'#8b5cf6','Unmarked':'#e5e7eb' };
  const LETTERS = { 'Present':'P','Absent':'A','Late':'L','Leave':'V','No Show':'N','Excused':'E','Unmarked':'·' };
  // Build day header showing day-of-month + weekday letter (S/M/T/W/T/F/S)
  const wkLetters = ['S','M','T','W','T','F','S'];
  const dayHeaders = [];
  for (let d = 1; d <= days; d++) {
    const w = new Date(year, month - 1, d).getDay();
    const isWeekend = w === 0 || w === 6;
    dayHeaders.push(`<th style="text-align:center;padding:4px 2px;background:${isWeekend?'#f1f5f9':'#fff'};font-weight:600;font-size:11px;color:${isWeekend?'#94a3b8':'#1E3A5F'};border-bottom:2px solid #e2e8f0"><div>${d}</div><div style="font-size:9px;color:#94a3b8">${wkLetters[w]}</div></th>`);
  }
  const headHtml = `<thead><tr style="position:sticky;top:0;background:#fff;z-index:2">
    <th style="text-align:left;padding:6px 8px;background:#fff;font-weight:600;border-bottom:2px solid #e2e8f0;min-width:180px;position:sticky;left:0;z-index:3">Employee</th>
    ${dayHeaders.join('')}
    <th style="text-align:center;padding:4px 6px;background:#fff;font-weight:600;border-bottom:2px solid #e2e8f0;border-left:2px solid #e2e8f0">P</th>
    <th style="text-align:center;padding:4px 6px;background:#fff;font-weight:600;border-bottom:2px solid #e2e8f0">A</th>
    <th style="text-align:center;padding:4px 6px;background:#fff;font-weight:600;border-bottom:2px solid #e2e8f0">L</th>
    <th style="text-align:center;padding:4px 6px;background:#fff;font-weight:600;border-bottom:2px solid #e2e8f0">V</th>
    <th style="text-align:center;padding:4px 6px;background:#fff;font-weight:600;border-bottom:2px solid #e2e8f0">N</th>
    <th style="text-align:center;padding:4px 6px;background:#fff;font-weight:600;border-bottom:2px solid #e2e8f0">·</th>
    <th style="text-align:center;padding:4px 8px;background:#fff;font-weight:600;border-bottom:2px solid #e2e8f0">%</th>
  </tr></thead>`;
  const bodyHtml = rows.map(r => {
    const cells = [];
    for (let d = 1; d <= days; d++) {
      const cell = r.days[d];
      if (!cell) {
        cells.push(`<td style="padding:0;border:1px solid #f1f5f9;width:22px;height:22px"></td>`);
      } else {
        const col = COLORS[cell.status] || '#94a3b8';
        const letter = LETTERS[cell.status] || '?';
        const tip = cell.status + (cell.leaveType ? ' — ' + cell.leaveType : '') + (cell.shift ? ' (' + cell.shift + ')' : '') + (cell.notes ? ' · ' + cell.notes : '');
        cells.push(`<td title="Day ${d}: ${tip.replace(/"/g,'&quot;')}" style="padding:0;border:1px solid #fff;width:22px;height:22px;background:${col};color:${cell.status==='Unmarked'?'#64748b':'#fff'};font-size:10px;font-weight:700;text-align:center">${letter}</td>`);
      }
    }
    const rate = r.attendanceRate || 0;
    const rateCol = rate >= 95 ? '#10b981' : rate >= 85 ? '#f59e0b' : '#ef4444';
    return `<tr>
      <td style="padding:6px 8px;font-size:12px;border-bottom:1px solid #f1f5f9;min-width:180px;position:sticky;left:0;background:#fff;z-index:1">
        <strong>${esc(r.EmpName||'')}</strong>${r.DeptName ? `<br><span class="cell-sub" style="font-size:10px">${esc(r.DeptName)}${r.JobName?' · '+esc(r.JobName):''}</span>` : ''}
      </td>
      ${cells.join('')}
      <td style="text-align:center;padding:4px 6px;font-size:11px;font-weight:600;color:#10b981;border-left:2px solid #e2e8f0">${r.counts.Present||0}</td>
      <td style="text-align:center;padding:4px 6px;font-size:11px;font-weight:600;color:#ef4444">${r.counts.Absent||0}</td>
      <td style="text-align:center;padding:4px 6px;font-size:11px;font-weight:600;color:#f59e0b">${r.counts.Late||0}</td>
      <td style="text-align:center;padding:4px 6px;font-size:11px;font-weight:600;color:#3b82f6">${r.counts.Leave||0}</td>
      <td style="text-align:center;padding:4px 6px;font-size:11px;font-weight:600;color:#dc2626">${r.counts['No Show']||0}</td>
      <td style="text-align:center;padding:4px 6px;font-size:11px;font-weight:600;color:#94a3b8">${r.counts.Unmarked||0}</td>
      <td style="text-align:center;padding:4px 8px;font-size:12px;font-weight:700;color:${rateCol}">${rate}%</td>
    </tr>`;
  }).join('');
  host.innerHTML = `<div style="overflow:auto;max-height:70vh;border:1px solid #e2e8f0;border-radius:6px"><table style="border-collapse:collapse;font-size:12px;min-width:100%">${headHtml}<tbody>${bodyHtml}</tbody></table></div>`;
}

function attExportMonthCsv() {
  if (!_attMonthData.rows || !_attMonthData.rows.length) { toast('Nothing to export.', 'error'); return; }
  const days = _attMonthData.daysInMonth;
  const headers = ['Employee','Department','Job'];
  for (let d = 1; d <= days; d++) headers.push(String(d));
  headers.push('Present','Absent','Late','Leave','No Show','Excused','Unmarked','Attendance %');
  const escCsv = v => {
    const s = (v == null ? '' : String(v));
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(escCsv).join(',')];
  _attMonthData.rows.forEach(r => {
    const row = [r.EmpName, r.DeptName||'', r.JobName||''];
    for (let d = 1; d <= days; d++) row.push(r.days[d] ? r.days[d].status : '');
    row.push(r.counts.Present||0, r.counts.Absent||0, r.counts.Late||0, r.counts.Leave||0, r.counts['No Show']||0, r.counts.Excused||0, r.counts.Unmarked||0, (r.attendanceRate||0) + '%');
    lines.push(row.map(escCsv).join(','));
  });
  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `attendance-${_attMonthData.year}-${String(_attMonthData.month).padStart(2,'0')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('CSV exported.');
}

// ── LEAVE TYPES & BOOKINGS ─────────────────────────────────────────────────
let _ltTypes = [], _ltBookings = [], _ltActiveTab = 'bookings';

async function loadLeaveTypes() {
  const [types, bookings] = await Promise.all([GET('/api/leave/types?all=1'), GET('/api/leave/bookings')]);
  if (ok(types)) _ltTypes = types || [];
  if (ok(bookings)) _ltBookings = bookings || [];
  ltSetTab(_ltActiveTab);
}

function ltSetTab(tab) {
  _ltActiveTab = tab;
  document.getElementById('lt-tab-bookings').style.display = tab === 'bookings' ? '' : 'none';
  document.getElementById('lt-tab-types').style.display    = tab === 'types' ? '' : 'none';
  const bb = document.getElementById('lt-tab-bookings-btn'), tb = document.getElementById('lt-tab-types-btn');
  if (bb) bb.className = tab === 'bookings' ? 'btn btn-primary' : 'btn btn-ghost';
  if (tb) tb.className = tab === 'types' ? 'btn btn-primary' : 'btn btn-ghost';
  if (tab === 'bookings') ltRenderBookings(); else ltRenderTypes();
}

function ltRenderTypes() {
  const host = document.getElementById('lt-types-list');
  if (!host) return;
  if (!_ltTypes.length) { host.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>No leave types defined yet.</p></div>`; return; }
  host.innerHTML = `<table class="data-table"><thead><tr>
    <th>Name</th><th>Color</th><th>Paid?</th><th>Default Days</th><th>Description</th><th>Active</th><th></th>
  </tr></thead><tbody>${_ltTypes.map(t => `<tr>
    <td><strong style="color:${esc(t.Color)}">${esc(t.Name)}</strong></td>
    <td><span style="display:inline-block;width:24px;height:24px;border-radius:4px;background:${esc(t.Color)};vertical-align:middle"></span> ${esc(t.Color)}</td>
    <td>${t.Paid ? '✅ Paid' : '❌ Unpaid'}</td>
    <td>${t.DefaultDays || 0}</td>
    <td class="cell-sub">${esc(t.Description||'')}</td>
    <td>${t.Active ? '🟢 Active' : '⚪ Inactive'}</td>
    <td><button class="btn btn-ghost btn-sm" onclick="ltEditType(${t.LeaveTypeID})">✏️</button>
        <button class="btn btn-danger btn-sm" onclick="ltDelType(${t.LeaveTypeID})">🗑</button></td>
  </tr>`).join('')}</tbody></table>`;
}

function ltOpenNewType() { ltEditType(null); }
function ltEditType(id) {
  const t = id ? (_ltTypes.find(x => x.LeaveTypeID === id) || {}) : {};
  const html = `<div class="modal-overlay" onclick="if(event.target===this)this.remove()">
    <div class="modal" style="max-width:520px">
      <div class="modal-header"><h3>${id ? '✏️ Edit' : '➕ New'} Leave Type</h3><button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
      <div class="modal-body" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:18px">
        <div class="form-row" style="grid-column:1/-1"><label>Name *</label><input id="lt-t-name" value="${esc(t.Name||'')}" placeholder="e.g. Annual Leave"></div>
        <div class="form-row"><label>Color</label><input id="lt-t-color" type="color" value="${esc(t.Color||'#3b82f6')}"></div>
        <div class="form-row"><label>Default Days</label><input id="lt-t-days" type="number" value="${t.DefaultDays||0}" min="0"></div>
        <div class="form-row"><label>Paid?</label><select id="lt-t-paid"><option value="1" ${t.Paid!==0?'selected':''}>✅ Paid</option><option value="0" ${t.Paid===0?'selected':''}>❌ Unpaid</option></select></div>
        <div class="form-row"><label>Active?</label><select id="lt-t-active"><option value="1" ${t.Active!==0?'selected':''}>🟢 Active</option><option value="0" ${t.Active===0?'selected':''}>⚪ Inactive</option></select></div>
        <div class="form-row" style="grid-column:1/-1"><label>Description</label><textarea id="lt-t-desc" rows="2">${esc(t.Description||'')}</textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="ltSaveType(${id||'null'})">${id ? '💾 Save' : 'Create'}</button>
      </div>
    </div></div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}
async function ltSaveType(id) {
  const body = {
    Name: val('lt-t-name'), Color: val('lt-t-color'),
    Paid: val('lt-t-paid') === '1' ? 1 : 0,
    DefaultDays: parseInt(val('lt-t-days'),10)||0,
    Active: val('lt-t-active') === '1' ? 1 : 0,
    Description: val('lt-t-desc')
  };
  if (!body.Name) { toast('Name required.', 'error'); return; }
  const r = id ? await api('PUT', '/api/leave/types/' + id, body) : await POST('/api/leave/types', body);
  if (!ok(r)) return;
  toast('Saved.'); document.querySelector('.modal-overlay')?.remove(); loadLeaveTypes();
}
async function ltDelType(id) {
  if (!confirm('Delete this leave type? (Will fail if any bookings reference it.)')) return;
  const r = await api('DELETE', '/api/leave/types/' + id);
  if (!ok(r)) return;
  toast('Deleted.'); loadLeaveTypes();
}

function ltRenderBookings() {
  const host = document.getElementById('lt-bookings-list');
  if (!host) return;
  const q = (val('lt-b-search') || '').toLowerCase();
  const st = val('lt-b-status-filter');
  let rows = _ltBookings;
  if (q) rows = rows.filter(b => (b.EmpName||'').toLowerCase().includes(q));
  if (st) rows = rows.filter(b => b.Status === st);
  if (!rows.length) { host.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>No leave bookings yet. Click <strong>➕ Book Leave</strong>.</p></div>`; return; }
  host.innerHTML = `<table class="data-table"><thead><tr>
    <th>Employee</th><th>Leave Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th><th>Reason</th><th></th>
  </tr></thead><tbody>${rows.map(b => {
    const stCol = b.Status === 'Approved' ? '#10b981' : b.Status === 'Rejected' ? '#ef4444' : b.Status === 'Cancelled' ? '#94a3b8' : '#f59e0b';
    return `<tr>
      <td><strong>${esc(b.EmpName||'')}</strong>${b.DeptName?`<br><span class="cell-sub">${esc(b.DeptName)}</span>`:''}</td>
      <td><span class="badge" style="background:${esc(b.LeaveTypeColor)}1a;color:${esc(b.LeaveTypeColor)};border:1px solid ${esc(b.LeaveTypeColor)}40;padding:3px 9px;border-radius:12px">${esc(b.LeaveTypeName)}</span></td>
      <td>${esc(b.StartDate)}</td><td>${esc(b.EndDate)}</td><td>${b.Days||0}</td>
      <td><span class="badge" style="background:${stCol}1a;color:${stCol};border:1px solid ${stCol}40;padding:3px 9px;border-radius:12px">${esc(b.Status)}</span></td>
      <td class="cell-sub">${esc(b.Reason||'')}</td>
      <td>
        ${b.Status === 'Pending' ? `<button class="btn btn-success btn-sm admin-only" onclick="ltDecide(${b.BookingID},'Approved')">✓ Approve</button>
        <button class="btn btn-danger btn-sm admin-only" onclick="ltDecide(${b.BookingID},'Rejected')">✕ Reject</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="ltEditBooking(${b.BookingID})">✏️</button>
        <button class="btn btn-danger btn-sm admin-only" onclick="ltDelBooking(${b.BookingID})">🗑</button>
      </td>
    </tr>`;
  }).join('')}</tbody></table>`;
}

function ltOpenNewBooking() { ltEditBooking(null); }
function ltEditBooking(id) {
  const b = id ? (_ltBookings.find(x => x.BookingID === id) || {}) : {};
  const staff = (cache && cache.staff) || [];
  const types = (_ltTypes || []).filter(t => t.Active !== 0);
  const html = `<div class="modal-overlay" onclick="if(event.target===this)this.remove()">
    <div class="modal" style="max-width:640px">
      <div class="modal-header"><h3>${id ? '✏️ Edit' : '➕ New'} Leave Booking</h3><button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
      <div class="modal-body" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:18px">
        <div class="form-row" style="grid-column:1/-1"><label>Employee *</label>
          <select id="lt-b-emp">${staff.map(s => `<option value="${s.StaffID}" ${s.StaffID===b.EmpID?'selected':''}>${esc((s.FirstName||'')+' '+(s.LastName||''))}</option>`).join('')}</select></div>
        <div class="form-row" style="grid-column:1/-1"><label>Leave Type *</label>
          <select id="lt-b-type">${types.map(t => `<option value="${t.LeaveTypeID}" ${t.LeaveTypeID===b.LeaveTypeID?'selected':''}>${esc(t.Name)}</option>`).join('')}</select></div>
        <div class="form-row"><label>Start Date *</label><input id="lt-b-start" type="date" value="${esc(b.StartDate||'')}"></div>
        <div class="form-row"><label>End Date *</label><input id="lt-b-end" type="date" value="${esc(b.EndDate||'')}"></div>
        <div class="form-row"><label>Days</label><input id="lt-b-days" type="number" step="0.5" value="${b.Days||''}" placeholder="auto"></div>
        <div class="form-row"><label>Status</label><select id="lt-b-status">${['Pending','Approved','Rejected','Cancelled'].map(s=>`<option ${s===(b.Status||'Pending')?'selected':''}>${s}</option>`).join('')}</select></div>
        <div class="form-row" style="grid-column:1/-1"><label>Reason</label><textarea id="lt-b-reason" rows="2">${esc(b.Reason||'')}</textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="ltSaveBooking(${id||'null'})">${id ? '💾 Save' : 'Book Leave'}</button>
      </div>
    </div></div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}
async function ltSaveBooking(id) {
  const body = {
    EmpID: parseInt(val('lt-b-emp'),10), LeaveTypeID: parseInt(val('lt-b-type'),10),
    StartDate: val('lt-b-start'), EndDate: val('lt-b-end'),
    Days: val('lt-b-days') ? parseFloat(val('lt-b-days')) : null,
    Status: val('lt-b-status'), Reason: val('lt-b-reason')
  };
  if (!body.EmpID || !body.LeaveTypeID || !body.StartDate || !body.EndDate) { toast('Employee, type, and dates required.', 'error'); return; }
  const r = id ? await api('PUT', '/api/leave/bookings/' + id, body) : await POST('/api/leave/bookings', body);
  if (!ok(r)) return;
  toast('Saved.'); document.querySelector('.modal-overlay')?.remove(); loadLeaveTypes();
}
async function ltDecide(id, decision) {
  const r = await api('PUT', '/api/leave/bookings/' + id, { Status: decision });
  if (!ok(r)) return;
  toast(decision); loadLeaveTypes();
}
async function ltDelBooking(id) {
  if (!confirm('Delete this leave booking?')) return;
  const r = await api('DELETE', '/api/leave/bookings/' + id);
  if (!ok(r)) return;
  toast('Deleted.'); loadLeaveTypes();
}

// ── MOBILE EQUIPMENT ────────────────────────────────────────────────────────
let _eqUnits = [], _eqTypes = [], _eqServices = [], _eqBreakdowns = [], _eqActiveTab = 'units', _eqStats = {};
const EQ_STATUS_COLORS = { 'Active':'#10b981','Under Repair':'#f59e0b','Decommissioned':'#94a3b8' };
const EQ_SVC_COLORS    = { 'Scheduled':'#3b82f6','Completed':'#10b981','Overdue':'#ef4444','Cancelled':'#94a3b8' };
const EQ_BD_COLORS     = { 'Open':'#ef4444','In Progress':'#f59e0b','Resolved':'#10b981' };
const EQ_SEV_COLORS    = { 'Critical':'#dc2626','Major':'#f59e0b','Minor':'#3b82f6' };

async function loadEquipment() {
  const [units, types, services, breakdowns, stats] = await Promise.all([
    GET('/api/equipment'), GET('/api/equipment/types?all=1'),
    GET('/api/equipment/services/all'), GET('/api/equipment/breakdowns/all'),
    GET('/api/equipment/stats/summary')
  ]);
  if (ok(units)) _eqUnits = units || [];
  if (ok(types)) _eqTypes = types || [];
  if (ok(services)) _eqServices = services || [];
  if (ok(breakdowns)) _eqBreakdowns = breakdowns || [];
  if (ok(stats)) _eqStats = stats || {};
  eqRenderStats();
  eqPopulateTypeFilter();
  eqSetTab(_eqActiveTab);
}

function eqRenderStats() {
  const host = document.getElementById('eq-stats');
  if (!host) return;
  const s = _eqStats;
  const pill = (label, n, color) => `<div class="stat-pill" style="background:${color}1a;color:${color};padding:6px 12px;border-radius:18px;font-weight:600">${esc(label)} ${n||0}</div>`;
  host.innerHTML = pill('Total', s.total, '#1E3A5F') + pill('Active', s.active, '#10b981') +
    pill('Under Repair', s.repair, '#f59e0b') + pill('Decommissioned', s.decom, '#94a3b8') +
    pill('⚠ Overdue Service', s.overdue, '#ef4444') + pill('📅 Due This Week', s.dueWeek, '#f59e0b') +
    pill('⚠ Open Breakdowns', s.openBreakdowns, '#dc2626');
}

function eqPopulateTypeFilter() {
  const sel = document.getElementById('eq-u-type-filter');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">All types</option>` + _eqTypes.map(t => `<option value="${t.EquipTypeID}">${esc(t.Name)}</option>`).join('');
  sel.value = current;
}

function eqSetTab(tab) {
  _eqActiveTab = tab;
  ['units','services','breakdowns','types'].forEach(t => {
    const p = document.getElementById('eq-tab-' + t);
    if (p) p.style.display = t === tab ? '' : 'none';
    const b = document.getElementById('eq-tab-' + t + '-btn');
    if (b) b.className = t === tab ? 'btn btn-primary' : 'btn btn-ghost';
  });
  if (tab === 'units') eqRenderUnits();
  else if (tab === 'services') eqRenderServices();
  else if (tab === 'breakdowns') eqRenderBreakdowns();
  else eqRenderTypes();
}

// ── Units ──
function eqRenderUnits() {
  const host = document.getElementById('eq-units-list');
  if (!host) return;
  const q  = (val('eq-u-search') || '').toLowerCase();
  const st = val('eq-u-status-filter');
  const tp = val('eq-u-type-filter');
  let rows = _eqUnits;
  if (q)  rows = rows.filter(r => (`${r.AssetNumber||''} ${r.SerialNumber||''} ${r.Location||''} ${r.TypeName||''}`).toLowerCase().includes(q));
  if (st) rows = rows.filter(r => r.Status === st);
  if (tp) rows = rows.filter(r => String(r.EquipTypeID) === String(tp));
  if (!rows.length) { host.innerHTML = `<div class="empty-state"><div class="icon">🚜</div><p>No equipment units. Click <strong>➕ New Unit</strong> to add one.</p></div>`; return; }
  host.innerHTML = `<table class="data-table"><thead><tr>
    <th>Asset #</th><th>Type</th><th>Serial / Year</th><th>Location</th><th>Hours</th><th>Status</th><th>Next Service</th><th>Open Issues</th><th></th>
  </tr></thead><tbody>${rows.map(r => {
    const col = EQ_STATUS_COLORS[r.Status] || '#64748b';
    const next = r.NextServiceDate ? `<span class="cell-sub">${esc(r.NextServiceDate)}</span>` : '<span class="cell-sub">—</span>';
    return `<tr style="cursor:pointer" onclick="eqOpenUnit(${r.EquipmentID})">
      <td><strong>${esc(r.AssetNumber)}</strong></td>
      <td><span class="badge" style="background:${esc(r.Color||'#1E3A5F')}1a;color:${esc(r.Color||'#1E3A5F')};border:1px solid ${esc(r.Color||'#1E3A5F')}40;padding:3px 9px;border-radius:12px">${esc(r.TypeName||'—')}</span><br><span class="cell-sub">${esc(r.Category||'')}</span></td>
      <td>${esc(r.SerialNumber||'—')}${r.YearOfManufacture ? `<br><span class="cell-sub">${r.YearOfManufacture}</span>` : ''}</td>
      <td>${esc(r.Location||'—')}</td>
      <td>${r.CurrentHours||0} hr</td>
      <td><span class="badge" style="background:${col}1a;color:${col};border:1px solid ${col}40;padding:3px 9px;border-radius:12px">${esc(r.Status)}</span></td>
      <td>${next}</td>
      <td>${r.OpenBreakdowns ? `<span style="color:#ef4444;font-weight:700">⚠ ${r.OpenBreakdowns}</span>` : '✓'}</td>
      <td onclick="event.stopPropagation()"><button class="btn btn-ghost btn-sm" onclick="eqOpenUnit(${r.EquipmentID})">👁</button></td>
    </tr>`;
  }).join('')}</tbody></table>`;
}

function eqOpenNewUnit() { eqEditUnit(null); }
function eqEditUnit(id) {
  const u = id ? (_eqUnits.find(x => x.EquipmentID === id) || {}) : {};
  const html = `<div class="modal-overlay" onclick="if(event.target===this)this.remove()">
    <div class="modal" style="max-width:680px">
      <div class="modal-header"><h3>${id ? '✏️ Edit' : '➕ New'} Equipment Unit</h3><button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
      <div class="modal-body" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:18px">
        <div class="form-row"><label>Asset Number *</label><input id="eq-u-asset" value="${esc(u.AssetNumber||'')}" placeholder="e.g. HT-001"></div>
        <div class="form-row"><label>Type</label>
          <div style="display:flex;gap:6px;align-items:center">
            <select id="eq-u-type" style="flex:1"><option value="">—</option>${_eqTypes.map(t => `<option value="${t.EquipTypeID}" ${t.EquipTypeID===u.EquipTypeID?'selected':''}>${esc(t.Name)}</option>`).join('')}</select>
            <button type="button" class="btn btn-ghost btn-sm" onclick="eqQuickAddType()" title="Create a new equipment type without leaving this dialog">➕ New</button>
          </div>
        </div>
        <div class="form-row"><label>Serial Number</label><input id="eq-u-serial" value="${esc(u.SerialNumber||'')}"></div>
        <div class="form-row"><label>Year of Manufacture</label><input id="eq-u-year" type="number" value="${u.YearOfManufacture||''}"></div>
        <div class="form-row"><label>Purchase Date</label><input id="eq-u-purch" type="date" value="${esc(u.PurchaseDate||'')}"></div>
        <div class="form-row"><label>Location</label><input id="eq-u-loc" value="${esc(u.Location||'')}" placeholder="e.g. Pit 2"></div>
        <div class="form-row"><label>Current Hours</label><input id="eq-u-hours" type="number" value="${u.CurrentHours||0}"></div>
        <div class="form-row"><label>Status</label><select id="eq-u-status">${['Active','Under Repair','Decommissioned'].map(s=>`<option ${s===(u.Status||'Active')?'selected':''}>${s}</option>`).join('')}</select></div>
        <div class="form-row" style="grid-column:1/-1"><label>Notes</label><textarea id="eq-u-notes" rows="2">${esc(u.Notes||'')}</textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        ${id ? `<button class="btn btn-danger" onclick="eqDelUnit(${id})">🗑 Delete</button>` : ''}
        <button class="btn btn-primary" onclick="eqSaveUnit(${id||'null'})">${id ? '💾 Save' : 'Create'}</button>
      </div>
    </div></div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}
async function eqSaveUnit(id) {
  const body = {
    AssetNumber: val('eq-u-asset'), EquipTypeID: parseInt(val('eq-u-type'),10)||null,
    SerialNumber: val('eq-u-serial'), YearOfManufacture: parseInt(val('eq-u-year'),10)||null,
    PurchaseDate: val('eq-u-purch'), Location: val('eq-u-loc'),
    CurrentHours: parseInt(val('eq-u-hours'),10)||0, Status: val('eq-u-status'), Notes: val('eq-u-notes')
  };
  if (!body.AssetNumber) { toast('Asset Number required.', 'error'); return; }
  const r = id ? await api('PUT', '/api/equipment/' + id, body) : await POST('/api/equipment', body);
  if (!ok(r)) return;
  toast('Saved.'); document.querySelector('.modal-overlay')?.remove(); loadEquipment();
}
async function eqDelUnit(id) {
  if (!confirm('Delete this unit? All services and breakdown records for it will also be removed.')) return;
  const r = await api('DELETE', '/api/equipment/' + id);
  if (!ok(r)) return;
  toast('Deleted.'); document.querySelector('.modal-overlay')?.remove(); loadEquipment();
}
function eqOpenUnit(id) { eqEditUnit(id); }

// ── Services ──
function eqRenderServices() {
  const host = document.getElementById('eq-services-list');
  if (!host) return;
  const st = val('eq-s-status-filter');
  const overdue = document.getElementById('eq-s-overdue-only')?.checked;
  const today = new Date().toISOString().slice(0,10);
  let rows = _eqServices;
  if (st) rows = rows.filter(r => r.Status === st);
  if (overdue) rows = rows.filter(r => r.Status === 'Scheduled' && r.ScheduledDate && r.ScheduledDate < today);
  if (!rows.length) { host.innerHTML = `<div class="empty-state"><div class="icon">🔧</div><p>No services match. Click <strong>➕ Schedule Service</strong>.</p></div>`; return; }
  host.innerHTML = `<table class="data-table"><thead><tr>
    <th>Asset</th><th>Service Type</th><th>Scheduled</th><th>Completed</th><th>Hours</th><th>Performer</th><th>Cost</th><th>Status</th><th></th>
  </tr></thead><tbody>${rows.map(r => {
    const col = EQ_SVC_COLORS[r.Status] || '#64748b';
    const isOverdue = r.Status === 'Scheduled' && r.ScheduledDate && r.ScheduledDate < today;
    return `<tr>
      <td><strong>${esc(r.AssetNumber||'—')}</strong>${r.TypeName ? `<br><span class="cell-sub">${esc(r.TypeName)}</span>` : ''}</td>
      <td>${esc(r.ServiceType||'')}</td>
      <td>${esc(r.ScheduledDate||'—')}${isOverdue ? ' <span style="color:#ef4444;font-weight:700">⚠ OVERDUE</span>' : ''}</td>
      <td>${esc(r.CompletedDate||'—')}</td>
      <td>${r.CompletedHours || r.ScheduledHours ? (r.CompletedHours||r.ScheduledHours)+' hr' : '—'}</td>
      <td>${esc(r.Performer||'—')}</td>
      <td>${r.Cost ? '$'+Number(r.Cost).toFixed(2) : '—'}</td>
      <td><span class="badge" style="background:${col}1a;color:${col};border:1px solid ${col}40;padding:3px 9px;border-radius:12px">${esc(r.Status)}</span></td>
      <td><button class="btn btn-ghost btn-sm" onclick="eqEditService(${r.ServiceID})">✏️</button>
          <button class="btn btn-danger btn-sm admin-only" onclick="eqDelService(${r.ServiceID})">🗑</button></td>
    </tr>`;
  }).join('')}</tbody></table>`;
}
function eqOpenNewService() { eqEditService(null); }
function eqEditService(id) {
  const s = id ? (_eqServices.find(x => x.ServiceID === id) || {}) : {};
  const html = `<div class="modal-overlay" onclick="if(event.target===this)this.remove()">
    <div class="modal" style="max-width:640px">
      <div class="modal-header"><h3>${id ? '✏️ Edit' : '➕ Schedule'} Service</h3><button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
      <div class="modal-body" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:18px">
        <div class="form-row" style="grid-column:1/-1"><label>Equipment *</label>
          <select id="eq-s-eq">${_eqUnits.map(u => `<option value="${u.EquipmentID}" ${u.EquipmentID===s.EquipmentID?'selected':''}>${esc(u.AssetNumber)} — ${esc(u.TypeName||'')}</option>`).join('')}</select></div>
        <div class="form-row" style="grid-column:1/-1"><label>Service Type *</label><input id="eq-s-type" value="${esc(s.ServiceType||'')}" placeholder="e.g. 250-hour PM"></div>
        <div class="form-row"><label>Scheduled Date</label><input id="eq-s-sdate" type="date" value="${esc(s.ScheduledDate||'')}"></div>
        <div class="form-row"><label>Completed Date</label><input id="eq-s-cdate" type="date" value="${esc(s.CompletedDate||'')}"></div>
        <div class="form-row"><label>Scheduled at Hours</label><input id="eq-s-shrs" type="number" value="${s.ScheduledHours||''}"></div>
        <div class="form-row"><label>Completed at Hours</label><input id="eq-s-chrs" type="number" value="${s.CompletedHours||''}"></div>
        <div class="form-row"><label>Performer</label><input id="eq-s-perf" value="${esc(s.Performer||'')}"></div>
        <div class="form-row"><label>Cost</label><input id="eq-s-cost" type="number" step="0.01" value="${s.Cost||''}"></div>
        <div class="form-row"><label>Status</label><select id="eq-s-status">${['Scheduled','Completed','Overdue','Cancelled'].map(o=>`<option ${o===(s.Status||'Scheduled')?'selected':''}>${o}</option>`).join('')}</select></div>
        <div class="form-row" style="grid-column:1/-1"><label>Notes</label><textarea id="eq-s-notes" rows="2">${esc(s.Notes||'')}</textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="eqSaveService(${id||'null'})">${id ? '💾 Save' : 'Schedule'}</button>
      </div>
    </div></div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}
async function eqSaveService(id) {
  const body = {
    EquipmentID: parseInt(val('eq-s-eq'),10), ServiceType: val('eq-s-type'),
    ScheduledDate: val('eq-s-sdate'), CompletedDate: val('eq-s-cdate'),
    ScheduledHours: parseInt(val('eq-s-shrs'),10)||null, CompletedHours: parseInt(val('eq-s-chrs'),10)||null,
    Performer: val('eq-s-perf'), Cost: parseFloat(val('eq-s-cost'))||0,
    Status: val('eq-s-status'), Notes: val('eq-s-notes')
  };
  if (!body.EquipmentID || !body.ServiceType) { toast('Equipment and Service Type required.', 'error'); return; }
  const r = id ? await api('PUT', '/api/equipment/services/' + id, body) : await POST('/api/equipment/services', body);
  if (!ok(r)) return;
  toast('Saved.'); document.querySelector('.modal-overlay')?.remove(); loadEquipment();
}
async function eqDelService(id) {
  if (!confirm('Delete this service record?')) return;
  const r = await api('DELETE', '/api/equipment/services/' + id);
  if (!ok(r)) return;
  toast('Deleted.'); loadEquipment();
}

// ── Breakdowns ──
function eqRenderBreakdowns() {
  const host = document.getElementById('eq-breakdowns-list');
  if (!host) return;
  const st = val('eq-b-status-filter');
  const sv = val('eq-b-severity-filter');
  let rows = _eqBreakdowns;
  if (st) rows = rows.filter(r => r.Status === st);
  if (sv) rows = rows.filter(r => r.Severity === sv);
  if (!rows.length) { host.innerHTML = `<div class="empty-state"><div class="icon">✅</div><p>No breakdowns logged.</p></div>`; return; }
  host.innerHTML = `<table class="data-table"><thead><tr>
    <th>Asset</th><th>Date</th><th>Severity</th><th>Status</th><th>Description</th><th>Downtime</th><th>Cost</th><th></th>
  </tr></thead><tbody>${rows.map(r => {
    const stCol = EQ_BD_COLORS[r.Status] || '#64748b';
    const svCol = EQ_SEV_COLORS[r.Severity] || '#64748b';
    return `<tr>
      <td><strong>${esc(r.AssetNumber||'—')}</strong>${r.TypeName ? `<br><span class="cell-sub">${esc(r.TypeName)}</span>` : ''}</td>
      <td>${esc(r.BreakdownDate||'')}</td>
      <td><span class="badge" style="background:${svCol}1a;color:${svCol};border:1px solid ${svCol}40;padding:3px 9px;border-radius:12px">${esc(r.Severity||'')}</span></td>
      <td><span class="badge" style="background:${stCol}1a;color:${stCol};border:1px solid ${stCol}40;padding:3px 9px;border-radius:12px">${esc(r.Status||'')}</span></td>
      <td>${esc((r.Description||'').slice(0,80))}${(r.Description||'').length>80?'…':''}</td>
      <td>${r.DowntimeHours ? r.DowntimeHours+' hr' : '—'}</td>
      <td>${r.Cost ? '$'+Number(r.Cost).toFixed(2) : '—'}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="eqEditBreakdown(${r.BreakdownID})">✏️</button>
          <button class="btn btn-danger btn-sm admin-only" onclick="eqDelBreakdown(${r.BreakdownID})">🗑</button></td>
    </tr>`;
  }).join('')}</tbody></table>`;
}
function eqOpenNewBreakdown() { eqEditBreakdown(null); }
function eqEditBreakdown(id) {
  const b = id ? (_eqBreakdowns.find(x => x.BreakdownID === id) || {}) : { BreakdownDate: new Date().toISOString().slice(0,10) };
  const html = `<div class="modal-overlay" onclick="if(event.target===this)this.remove()">
    <div class="modal" style="max-width:680px">
      <div class="modal-header"><h3>${id ? '✏️ Edit' : '⚠ Report'} Breakdown</h3><button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
      <div class="modal-body" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:18px">
        <div class="form-row" style="grid-column:1/-1"><label>Equipment *</label>
          <select id="eq-b-eq">${_eqUnits.map(u => `<option value="${u.EquipmentID}" ${u.EquipmentID===b.EquipmentID?'selected':''}>${esc(u.AssetNumber)} — ${esc(u.TypeName||'')}</option>`).join('')}</select></div>
        <div class="form-row"><label>Breakdown Date *</label><input id="eq-b-date" type="date" value="${esc(b.BreakdownDate||'')}"></div>
        <div class="form-row"><label>Reported By</label><input id="eq-b-by" value="${esc(b.ReportedBy||'')}"></div>
        <div class="form-row"><label>Severity</label><select id="eq-b-sev">${['Critical','Major','Minor'].map(s=>`<option ${s===(b.Severity||'Minor')?'selected':''}>${s}</option>`).join('')}</select></div>
        <div class="form-row"><label>Status</label><select id="eq-b-status">${['Open','In Progress','Resolved'].map(s=>`<option ${s===(b.Status||'Open')?'selected':''}>${s}</option>`).join('')}</select></div>
        <div class="form-row" style="grid-column:1/-1"><label>Description *</label><textarea id="eq-b-desc" rows="3" placeholder="What failed?">${esc(b.Description||'')}</textarea></div>
        <div class="form-row" style="grid-column:1/-1"><label>Root Cause</label><textarea id="eq-b-cause" rows="2">${esc(b.RootCause||'')}</textarea></div>
        <div class="form-row"><label>Resolved Date</label><input id="eq-b-rdate" type="date" value="${esc(b.ResolvedDate||'')}"></div>
        <div class="form-row"><label>Downtime (hours)</label><input id="eq-b-down" type="number" step="0.5" value="${b.DowntimeHours||''}"></div>
        <div class="form-row" style="grid-column:1/-1"><label>Cost</label><input id="eq-b-cost" type="number" step="0.01" value="${b.Cost||''}"></div>
        <div class="form-row" style="grid-column:1/-1"><label>Notes</label><textarea id="eq-b-notes" rows="2">${esc(b.Notes||'')}</textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="eqSaveBreakdown(${id||'null'})">${id ? '💾 Save' : 'Report'}</button>
      </div>
    </div></div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}
async function eqSaveBreakdown(id) {
  const body = {
    EquipmentID: parseInt(val('eq-b-eq'),10), BreakdownDate: val('eq-b-date'),
    ReportedBy: val('eq-b-by'), Severity: val('eq-b-sev'),
    Description: val('eq-b-desc'), RootCause: val('eq-b-cause'),
    ResolvedDate: val('eq-b-rdate'), DowntimeHours: parseFloat(val('eq-b-down'))||0,
    Status: val('eq-b-status'), Cost: parseFloat(val('eq-b-cost'))||0, Notes: val('eq-b-notes')
  };
  if (!body.EquipmentID || !body.BreakdownDate || !body.Description) { toast('Equipment, date, and description required.', 'error'); return; }
  const r = id ? await api('PUT', '/api/equipment/breakdowns/' + id, body) : await POST('/api/equipment/breakdowns', body);
  if (!ok(r)) return;
  toast('Saved.'); document.querySelector('.modal-overlay')?.remove(); loadEquipment();
}
async function eqDelBreakdown(id) {
  if (!confirm('Delete this breakdown record?')) return;
  const r = await api('DELETE', '/api/equipment/breakdowns/' + id);
  if (!ok(r)) return;
  toast('Deleted.'); loadEquipment();
}

// ── Types ──
function eqRenderTypes() {
  const host = document.getElementById('eq-types-list');
  if (!host) return;
  if (!_eqTypes.length) { host.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>No equipment types defined.</p></div>`; return; }
  host.innerHTML = `<table class="data-table"><thead><tr>
    <th>Name</th><th>Category</th><th>Manufacturer</th><th>Model</th><th>Service Interval</th><th>Units</th><th>Active</th><th></th>
  </tr></thead><tbody>${_eqTypes.map(t => `<tr>
    <td><strong style="color:${esc(t.Color||'#1E3A5F')}">${esc(t.Name)}</strong></td>
    <td>${esc(t.Category||'—')}</td>
    <td>${esc(t.Manufacturer||'—')}</td>
    <td>${esc(t.ModelNumber||'—')}</td>
    <td>${t.ServiceIntervalHours||0} hr</td>
    <td>${t.UnitCount||0}</td>
    <td>${t.Active ? '🟢' : '⚪'}</td>
    <td><button class="btn btn-ghost btn-sm" onclick="eqEditType(${t.EquipTypeID})">✏️</button>
        <button class="btn btn-danger btn-sm admin-only" onclick="eqDelType(${t.EquipTypeID})">🗑</button></td>
  </tr>`).join('')}</tbody></table>`;
}
function eqOpenNewType() { eqEditType(null); }
function eqEditType(id) {
  const t = id ? (_eqTypes.find(x => x.EquipTypeID === id) || {}) : {};
  const html = `<div class="modal-overlay" onclick="if(event.target===this)this.remove()">
    <div class="modal" style="max-width:560px">
      <div class="modal-header"><h3>${id ? '✏️ Edit' : '➕ New'} Equipment Type</h3><button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
      <div class="modal-body" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:18px">
        <div class="form-row" style="grid-column:1/-1"><label>Name *</label><input id="eq-t-name" value="${esc(t.Name||'')}" placeholder="e.g. Caterpillar 745C"></div>
        <div class="form-row"><label>Category</label><input id="eq-t-cat" value="${esc(t.Category||'')}" placeholder="e.g. Haul Truck"></div>
        <div class="form-row"><label>Manufacturer</label><input id="eq-t-mfr" value="${esc(t.Manufacturer||'')}"></div>
        <div class="form-row"><label>Model Number</label><input id="eq-t-model" value="${esc(t.ModelNumber||'')}"></div>
        <div class="form-row"><label>Service Interval (hr)</label><input id="eq-t-int" type="number" value="${t.ServiceIntervalHours||250}"></div>
        <div class="form-row"><label>Color</label><input id="eq-t-color" type="color" value="${esc(t.Color||'#1E3A5F')}"></div>
        <div class="form-row"><label>Active?</label><select id="eq-t-active"><option value="1" ${t.Active!==0?'selected':''}>🟢 Active</option><option value="0" ${t.Active===0?'selected':''}>⚪ Inactive</option></select></div>
        <div class="form-row" style="grid-column:1/-1"><label>Description</label><textarea id="eq-t-desc" rows="2">${esc(t.Description||'')}</textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="eqSaveType(${id||'null'})">${id ? '💾 Save' : 'Create'}</button>
      </div>
    </div></div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}
async function eqSaveType(id) {
  const body = {
    Name: val('eq-t-name'), Category: val('eq-t-cat'), Manufacturer: val('eq-t-mfr'),
    ModelNumber: val('eq-t-model'), ServiceIntervalHours: parseInt(val('eq-t-int'),10)||250,
    Color: val('eq-t-color'), Active: val('eq-t-active') === '1' ? 1 : 0, Description: val('eq-t-desc')
  };
  if (!body.Name) { toast('Name required.', 'error'); return; }
  const r = id ? await api('PUT', '/api/equipment/types/' + id, body) : await POST('/api/equipment/types', body);
  if (!ok(r)) return;
  toast('Saved.'); document.querySelector('.modal-overlay')?.remove(); loadEquipment();
}
async function eqDelType(id) {
  if (!confirm('Delete this type? (Fails if any units use it.)')) return;
  const r = await api('DELETE', '/api/equipment/types/' + id);
  if (!ok(r)) return;
  toast('Deleted.'); loadEquipment();
}

// Quick-add an equipment type from inside the Unit dialog — keeps the parent open,
// refreshes the Type dropdown, and auto-selects the newly created type.
function eqQuickAddType() {
  const html = `<div class="modal-overlay" id="eq-qtype-modal" onclick="if(event.target===this)this.remove()" style="z-index:10010">
    <div class="modal" style="max-width:480px">
      <div class="modal-header"><h3>➕ Quick Add Equipment Type</h3><button class="btn btn-ghost btn-sm" onclick="document.getElementById('eq-qtype-modal').remove()">✕</button></div>
      <div class="modal-body" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:18px">
        <div class="form-row" style="grid-column:1/-1"><label>Name *</label><input id="eq-qt-name" placeholder="e.g. Caterpillar 992K" autofocus></div>
        <div class="form-row"><label>Category</label><input id="eq-qt-cat" placeholder="e.g. Wheel Loader"></div>
        <div class="form-row"><label>Manufacturer</label><input id="eq-qt-mfr" placeholder="e.g. Caterpillar"></div>
        <div class="form-row"><label>Model Number</label><input id="eq-qt-model"></div>
        <div class="form-row"><label>Service Interval (hr)</label><input id="eq-qt-int" type="number" value="250"></div>
        <div class="form-row" style="grid-column:1/-1"><label>Color</label><input id="eq-qt-color" type="color" value="#1E3A5F"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="document.getElementById('eq-qtype-modal').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="eqQuickSaveType()">Create &amp; Select</button>
      </div>
    </div></div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  setTimeout(() => document.getElementById('eq-qt-name')?.focus(), 30);
}

async function eqQuickSaveType() {
  const body = {
    Name: val('eq-qt-name'), Category: val('eq-qt-cat'), Manufacturer: val('eq-qt-mfr'),
    ModelNumber: val('eq-qt-model'), ServiceIntervalHours: parseInt(val('eq-qt-int'),10)||250,
    Color: val('eq-qt-color'), Active: 1
  };
  if (!body.Name) { toast('Name required.', 'error'); return; }
  const r = await POST('/api/equipment/types', body);
  if (!ok(r)) return;
  // Refresh the types cache, repopulate the Unit dialog's Type dropdown, auto-select the new one
  const types = await GET('/api/equipment/types?all=1');
  if (types) _eqTypes = types;
  const sel = document.getElementById('eq-u-type');
  if (sel) {
    const u = { EquipTypeID: r.EquipTypeID };
    sel.innerHTML = `<option value="">—</option>` + _eqTypes.map(t => `<option value="${t.EquipTypeID}" ${t.EquipTypeID===u.EquipTypeID?'selected':''}>${esc(t.Name)}</option>`).join('');
    sel.value = String(r.EquipTypeID);
  }
  document.getElementById('eq-qtype-modal')?.remove();
  toast(`Type "${body.Name}" added and selected.`);
}

// ── EMPLOYEE ASSIGNMENT ────────────────────────────────────────────────────
// Bridges the Roster (who's scheduled), Attendance/Leave (effective status),
// Equipment (the unit being assigned), and Setup Lists (job / loc / dept).
let _asgData = { date: '', rows: [], summary: {}, equipInUse: {} };
let _asgEquipUnits = []; // cached Active equipment for the picker

async function loadAssignment() {
  const today = new Date().toISOString().slice(0,10);
  const el = document.getElementById('asg-date');
  if (el && !el.value) el.value = today;
  const date = (el && el.value) || today;
  // Pull rostered employees + their assignments AND equipment list in parallel
  const [day, units] = await Promise.all([
    GET('/api/assignment/day?date=' + encodeURIComponent(date)),
    GET('/api/equipment?status=Active')
  ]);
  if (!ok(day)) return;
  _asgData = day;
  if (ok(units)) _asgEquipUnits = units || [];
  asgRenderSummary();
  asgRenderRows();
}

function asgShift(delta) {
  const el = document.getElementById('asg-date');
  if (!el) return;
  if (delta === 0) el.value = new Date().toISOString().slice(0,10);
  else {
    const d = new Date((el.value || new Date().toISOString().slice(0,10)) + 'T00:00:00');
    d.setDate(d.getDate() + delta);
    el.value = d.toISOString().slice(0,10);
  }
  loadAssignment();
}

function asgRenderSummary() {
  const host = document.getElementById('asg-summary');
  if (!host) return;
  const s = _asgData.summary || {};
  const pill = (label, n, color) => `<div class="stat-pill" style="background:${color}1a;color:${color};padding:6px 12px;border-radius:18px;font-weight:600">${esc(label)} ${n||0}</div>`;
  host.innerHTML =
    pill('Rostered', s.total, '#1E3A5F') +
    pill('Assigned', s.assigned, '#10b981') +
    pill('Unassigned', s.unassigned, '#f59e0b') +
    pill('🏖️ On Leave', s.onLeave, '#3b82f6');
}

function asgRenderRows() {
  const host = document.getElementById('asg-list');
  if (!host) return;
  const q = (val('asg-search') || '').toLowerCase();
  let rows = _asgData.rows || [];
  if (q) rows = rows.filter(r => (`${r.EmpName||''} ${r.DeptName||''} ${r.JobName||''}`).toLowerCase().includes(q));
  if (!rows.length) {
    host.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>No employees rostered for ${esc(_asgData.date)}. Assign shifts in the <strong>Shift Roster</strong> first.</p></div>`;
    return;
  }
  host.innerHTML = `<table class="data-table"><thead><tr>
    <th style="width:22%">Employee</th><th>Shift</th><th>Status</th><th style="width:42%">Assignments</th><th></th>
  </tr></thead><tbody>${rows.map(r => asgRowHtml(r)).join('')}</tbody></table>`;
}

function asgRowHtml(r) {
  const leave = r.leave;
  const onLeavePill = leave
    ? `<span class="badge" style="background:${esc(leave.LeaveTypeColor||'#3b82f6')}1a;color:${esc(leave.LeaveTypeColor||'#3b82f6')};border:1px solid ${esc(leave.LeaveTypeColor||'#3b82f6')}40;padding:3px 9px;border-radius:12px">🏖️ ${esc(leave.LeaveTypeName)}</span>`
    : (r.attendance ? `<span class="badge" style="background:#10b9811a;color:#10b981;border:1px solid #10b98140;padding:3px 9px;border-radius:12px">${esc(r.attendance.Status)}</span>` : `<span class="cell-sub">Unmarked</span>`);
  const assignments = (r.assignments || []).filter(a => a.Status !== 'Cancelled');
  const asgCells = assignments.length ? assignments.map(a => asgChip(a)).join('') : `<span class="cell-sub">— No assignment —</span>`;
  const addBtn = leave
    ? `<button class="btn btn-ghost btn-sm" disabled title="On approved leave">+ Add</button>`
    : `<button class="btn btn-primary btn-sm" onclick="asgOpenNew(${r.EmpID})">➕ Assign</button>`;
  return `<tr>
    <td><strong>${esc(r.EmpName||'')}</strong>${r.DeptName ? `<br><span class="cell-sub">${esc(r.DeptName)}${r.JobName?' · '+esc(r.JobName):''}</span>` : ''}</td>
    <td>${esc(r.ShiftLabel||'—')}${r.StartTime ? `<br><span class="cell-sub">${esc(r.StartTime)}–${esc(r.EndTime||'')}</span>` : ''}</td>
    <td>${onLeavePill}</td>
    <td><div style="display:flex;flex-direction:column;gap:4px">${asgCells}</div></td>
    <td>${addBtn}</td>
  </tr>`;
}

function asgChip(a) {
  // Build a one-line description of what this assignment is + an edit/delete control
  let label, color;
  if (a.AssignmentType === 'equipment') {
    label = `🚜 ${esc(a.AssetNumber||'?')}` + (a.EquipTypeName ? ` <span class="cell-sub">(${esc(a.EquipTypeName)})</span>` : '');
    color = a.EquipTypeColor || '#1E3A5F';
  } else {
    const parts = [];
    if (a.JobTitle) parts.push('🛠️ ' + esc(a.JobTitle));
    if (a.LocationName) parts.push('📍 ' + esc(a.LocationName));
    if (a.DeptName) parts.push('🏢 ' + esc(a.DeptName));
    if (a.TaskDescription) parts.push('📝 ' + esc(a.TaskDescription));
    label = parts.join(' · ') || '— duty —';
    color = '#8b5cf6';
  }
  const timeBit = (a.StartTime || a.EndTime) ? ` <span class="cell-sub">${esc(a.StartTime||'')}–${esc(a.EndTime||'')}</span>` : '';
  return `<div style="display:flex;align-items:center;gap:6px">
    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${esc(color)}"></span>
    <span>${label}${timeBit}</span>
    <button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:11px" onclick="asgEdit(${a.AssignmentID})" title="Edit">✏️</button>
    <button class="btn btn-danger btn-sm" style="padding:2px 6px;font-size:11px" onclick="asgDelete(${a.AssignmentID})" title="Delete">✕</button>
  </div>`;
}

function asgOpenNew(empId) { asgEdit(null, empId); }

function asgEdit(assignmentId, empIdHint) {
  // Find the existing assignment (when editing) or build a blank shell
  const existing = assignmentId
    ? (_asgData.rows.flatMap(r => r.assignments || []).find(a => a.AssignmentID === assignmentId) || null)
    : null;
  const empId   = existing ? existing.EmpID : empIdHint;
  const empRow  = _asgData.rows.find(r => r.EmpID === empId);
  const empName = empRow ? empRow.EmpName : (empId ? 'Employee #' + empId : '—');

  const depts = (cache && cache.depts) || [];
  const jobs  = (cache && cache.jobs)  || [];
  const locs  = (cache && cache.locs)  || [];
  const equipInUse = _asgData.equipInUse || {};

  // Equipment options — pre-mark anything already taken today (except the one this row uses)
  const equipOptions = _asgEquipUnits.map(u => {
    const taken = equipInUse[u.EquipmentID] && (!existing || existing.EquipmentID !== u.EquipmentID);
    return `<option value="${u.EquipmentID}" ${existing && existing.EquipmentID===u.EquipmentID?'selected':''} ${taken?'disabled':''}>${esc(u.AssetNumber)} — ${esc(u.TypeName||'')}${taken?` (assigned to ${esc(equipInUse[u.EquipmentID])})`:''}</option>`;
  }).join('');

  const a = existing || {};
  const type = a.AssignmentType || 'equipment';

  const html = `<div class="modal-overlay" onclick="if(event.target===this)this.remove()">
    <div class="modal" style="max-width:720px">
      <div class="modal-header"><h3>${assignmentId ? '✏️ Edit' : '➕ New'} Assignment — ${esc(empName)}</h3><button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
      <div class="modal-body" style="padding:18px">
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button type="button" id="asg-type-equip" class="btn ${type==='equipment'?'btn-primary':'btn-ghost'}" onclick="asgSwitchType('equipment')">🚜 Equipment</button>
          <button type="button" id="asg-type-duty"  class="btn ${type==='duty'?'btn-primary':'btn-ghost'}" onclick="asgSwitchType('duty')">🛠️ Generic Duty</button>
          <span style="flex:1"></span>
        </div>

        <div id="asg-pane-equipment" style="display:${type==='equipment'?'block':'none'}">
          <div class="form-row"><label>Equipment Unit *</label>
            <select id="asg-equip">${equipOptions || '<option value="">— No active equipment —</option>'}</select>
            <div class="cell-sub" style="margin-top:4px">Disabled rows are already assigned to someone else today.</div></div>
        </div>

        <div id="asg-pane-duty" style="display:${type==='duty'?'block':'none'};display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="form-row"><label>Job Title</label>
            <select id="asg-job"><option value="">—</option>${jobs.map(j => `<option value="${j.JobID}" ${j.JobID===a.JobID?'selected':''}>${esc(j.Title||j.Job||'')}</option>`).join('')}</select></div>
          <div class="form-row"><label>Location</label>
            <select id="asg-loc"><option value="">—</option>${locs.map(l => `<option value="${l.LocID}" ${l.LocID===a.LocID?'selected':''}>${esc(l.Location||'')}</option>`).join('')}</select></div>
          <div class="form-row"><label>Department</label>
            <select id="asg-dept"><option value="">—</option>${depts.map(d => `<option value="${d.DeptID}" ${d.DeptID===a.DeptID?'selected':''}>${esc(d.Department||'')}</option>`).join('')}</select></div>
          <div class="form-row"><label>Status</label>
            <select id="asg-status">${['Active','Completed','Cancelled'].map(s=>`<option ${s===(a.Status||'Active')?'selected':''}>${s}</option>`).join('')}</select></div>
          <div class="form-row" style="grid-column:1/-1"><label>Task / Activity</label>
            <textarea id="asg-task" rows="2" placeholder="What specifically? e.g. Site cleanup, equipment inspection, traffic control…">${esc(a.TaskDescription||'')}</textarea></div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:14px">
          <div class="form-row"><label>Start Time</label><input id="asg-start" type="time" value="${esc(a.StartTime||'')}"></div>
          <div class="form-row"><label>End Time</label><input id="asg-end" type="time" value="${esc(a.EndTime||'')}"></div>
          <div class="form-row"><label>Status (equipment)</label>
            <select id="asg-status-eq">${['Active','Completed','Cancelled'].map(s=>`<option ${s===(a.Status||'Active')?'selected':''}>${s}</option>`).join('')}</select></div>
          <div class="form-row" style="grid-column:1/-1"><label>Notes</label><textarea id="asg-notes" rows="2">${esc(a.Notes||'')}</textarea></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="asgSave(${assignmentId||'null'}, ${empId})">${assignmentId ? '💾 Save' : 'Assign'}</button>
      </div>
    </div></div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

function asgSwitchType(type) {
  document.getElementById('asg-pane-equipment').style.display = type === 'equipment' ? 'block' : 'none';
  document.getElementById('asg-pane-duty').style.display      = type === 'duty' ? 'grid' : 'none';
  document.getElementById('asg-type-equip').className = type === 'equipment' ? 'btn btn-primary' : 'btn btn-ghost';
  document.getElementById('asg-type-duty').className  = type === 'duty'      ? 'btn btn-primary' : 'btn btn-ghost';
}

async function asgSave(assignmentId, empId) {
  const type = document.getElementById('asg-pane-equipment').style.display !== 'none' ? 'equipment' : 'duty';
  const body = {
    EmpID: empId,
    AssignDate: _asgData.date,
    AssignmentType: type,
    StartTime: val('asg-start'),
    EndTime: val('asg-end'),
    Notes: val('asg-notes')
  };
  if (type === 'equipment') {
    body.EquipmentID = parseInt(val('asg-equip'), 10) || null;
    body.Status = val('asg-status-eq');
    if (!body.EquipmentID) { toast('Pick an equipment unit.', 'error'); return; }
  } else {
    body.JobID = parseInt(val('asg-job'), 10) || null;
    body.LocID = parseInt(val('asg-loc'), 10) || null;
    body.DeptID = parseInt(val('asg-dept'), 10) || null;
    body.TaskDescription = val('asg-task');
    body.Status = val('asg-status');
    if (!body.JobID && !body.LocID && !body.DeptID && !(body.TaskDescription || '').trim()) {
      toast('A duty needs at least one of: job title, location, department, or task description.', 'error');
      return;
    }
  }
  const url = assignmentId ? '/api/assignment/' + assignmentId : '/api/assignment';
  const r = assignmentId ? await api('PUT', url, body) : await POST(url, body);
  if (!ok(r)) return;
  toast('Assignment saved.');
  document.querySelector('.modal-overlay')?.remove();
  loadAssignment();
}

async function asgDelete(id) {
  if (!confirm('Remove this assignment?')) return;
  const r = await api('DELETE', '/api/assignment/' + id);
  if (!ok(r)) return;
  toast('Removed.');
  loadAssignment();
}

// ── HR DISCIPLINARY ACTION ──────────────────────────────────────────────────
let _discList = [], _discStats = {};
const DISC_STATUS_COLORS   = { 'Open':'#ef4444','In Progress':'#f59e0b','Resolved':'#10b981','Cancelled':'#94a3b8' };
const DISC_SEVERITY_COLORS = { 'Critical':'#dc2626','Major':'#f59e0b','Minor':'#3b82f6' };

async function loadDisciplinary() {
  const [list, stats] = await Promise.all([GET('/api/disciplinary'), GET('/api/disciplinary/stats/summary')]);
  if (ok(list)) _discList = list || [];
  if (ok(stats)) _discStats = stats || {};
  discRenderStats();
  discFilter();
}

function discRenderStats() {
  const host = document.getElementById('disc-stats');
  if (!host) return;
  const s = _discStats;
  const pill = (label, n, c) => `<div class="stat-pill" style="background:${c}1a;color:${c};padding:6px 12px;border-radius:18px;font-weight:600">${esc(label)} ${n||0}</div>`;
  host.innerHTML =
    pill('Total', s.total, '#1E3A5F') +
    pill('Open', s.open, '#ef4444') +
    pill('In Progress', s.inProgress, '#f59e0b') +
    pill('Resolved', s.resolved, '#10b981') +
    pill('⚠ Critical Open', s.criticalOpen, '#dc2626') +
    pill('🤖 Auto-Generated', s.auto, '#8b5cf6');
}

function discFilter() {
  const q = (val('disc-search') || '').toLowerCase();
  const st = val('disc-status-filter');
  const sv = val('disc-severity-filter');
  let rows = _discList;
  if (q) rows = rows.filter(a => (`${a.EmpName||''} ${a.Reason||''} ${a.ActionType||''}`).toLowerCase().includes(q));
  if (st) rows = rows.filter(a => a.Status === st);
  if (sv) rows = rows.filter(a => a.Severity === sv);
  const host = document.getElementById('disc-list');
  if (!host) return;
  if (!rows.length) { host.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>No disciplinary actions match.</p></div>`; return; }
  host.innerHTML = `<table class="data-table"><thead><tr>
    <th>Employee</th><th>Issued</th><th>Type</th><th>Severity</th><th>Status</th><th>Reason</th><th>Docs</th><th>Auto?</th><th></th>
  </tr></thead><tbody>${rows.map(a => {
    const sCol = DISC_STATUS_COLORS[a.Status] || '#64748b';
    const vCol = DISC_SEVERITY_COLORS[a.Severity] || '#64748b';
    return `<tr style="cursor:pointer" onclick="discOpen(${a.ActionID})">
      <td><strong>${esc(a.EmpName||'?')}</strong>${a.DeptName ? `<br><span class="cell-sub">${esc(a.DeptName)}</span>` : ''}</td>
      <td>${esc(a.IssuedDate||'')}</td>
      <td>${esc(a.ActionType||'')}</td>
      <td><span class="badge" style="background:${vCol}1a;color:${vCol};border:1px solid ${vCol}40;padding:3px 9px;border-radius:12px">${esc(a.Severity)}</span></td>
      <td><span class="badge" style="background:${sCol}1a;color:${sCol};border:1px solid ${sCol}40;padding:3px 9px;border-radius:12px">${esc(a.Status)}</span></td>
      <td>${esc((a.Reason||'').slice(0,60))}${(a.Reason||'').length>60?'…':''}</td>
      <td>${a.DocCount||0} 📎</td>
      <td>${a.AutoGenerated ? '🤖' : ''}</td>
      <td onclick="event.stopPropagation()"><button class="btn btn-ghost btn-sm" onclick="discOpen(${a.ActionID})">👁</button></td>
    </tr>`;
  }).join('')}</tbody></table>`;
}

function discOpenNew() { discOpen(null); }

async function discOpen(actionId) {
  const a = actionId ? (await GET('/api/disciplinary/' + actionId)) : { Status:'Open', Severity:'Minor', ActionType:'Verbal Warning', IssuedDate: new Date().toISOString().slice(0,10), documents:[] };
  if (actionId && !ok(a)) return;
  const staff = (cache && cache.staff) || [];
  const hrForms = await GET('/api/forms/templates?category=hr') || [];
  const docList = (a.documents || []).map(d => `<div class="onb-doc-row" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid #f1f5f9">
    <span>📎 <strong>${esc(d.FileName)}</strong></span>
    <span class="cell-sub">${esc((d.UploadedBy||'')+' · '+(d.UploadedAt||'').slice(0,16))}</span>
    <span style="margin-left:auto">
      <a class="btn btn-ghost btn-sm" href="/api/disciplinary/documents/${d.DocID}?inline=1" target="_blank">👁</a>
      <a class="btn btn-ghost btn-sm" href="/api/disciplinary/documents/${d.DocID}">⬇</a>
      <button class="btn btn-danger btn-sm" onclick="discDelDoc(${d.DocID},${actionId})">🗑</button>
    </span></div>`).join('') || `<div class="cell-sub" style="padding:8px">No documents attached yet.</div>`;
  const html = `<div class="modal-overlay" id="disc-modal" onclick="if(event.target===this)this.remove()">
    <div class="modal" style="max-width:880px;max-height:92vh;display:flex;flex-direction:column">
      <div class="modal-header"><h3>${actionId?'✏️ Edit':'➕ New'} Disciplinary Action${a.AutoGenerated?' <span style="background:#8b5cf61a;color:#8b5cf6;padding:2px 9px;border-radius:10px;font-size:12px;font-weight:600">🤖 Auto-Generated</span>':''}</h3>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('disc-modal').remove()">✕</button></div>
      <div class="modal-body" style="overflow-y:auto;padding:18px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-row" style="grid-column:1/-1"><label>Employee *</label>
          <select id="disc-emp" ${actionId?'disabled':''}>${staff.map(s => `<option value="${s.StaffID}" ${s.StaffID===a.EmpID?'selected':''}>${esc((s.FirstName||'')+' '+(s.LastName||''))}</option>`).join('')}</select></div>
        <div class="form-row"><label>Action Type</label>
          <select id="disc-type">${['Verbal Warning','Written Warning','Final Warning','Performance Improvement Plan','Leave Over-Entitlement','Suspension','Termination','Other'].map(t=>`<option ${t===a.ActionType?'selected':''}>${t}</option>`).join('')}</select></div>
        <div class="form-row"><label>Severity</label>
          <select id="disc-severity">${['Minor','Major','Critical'].map(s=>`<option ${s===a.Severity?'selected':''}>${s}</option>`).join('')}</select></div>
        <div class="form-row"><label>Issued Date</label><input id="disc-issued" type="date" value="${esc(a.IssuedDate||'')}"></div>
        <div class="form-row"><label>Issued By</label><input id="disc-by" value="${esc(a.IssuedBy||'')}" placeholder="Manager / HR"></div>
        <div class="form-row" style="grid-column:1/-1"><label>Reason *</label><input id="disc-reason" value="${esc(a.Reason||'')}" placeholder="Short reason / heading"></div>
        <div class="form-row" style="grid-column:1/-1">
          <label style="display:flex;align-items:center;gap:8px">Description
            <button type="button" class="btn btn-accent btn-sm" style="padding:3px 10px;font-size:12px" onclick="discAiDraft(${actionId||'null'})" title="Use AI to draft the description based on this employee's leave usage, attendance history and prior actions">✨ AI Draft</button>
            <span id="disc-ai-status" class="cell-sub" style="font-size:11px"></span>
          </label>
          <textarea id="disc-desc" rows="5" placeholder="Detailed description of the incident, behavior, or breach. Click ✨ AI Draft for a context-aware draft.">${esc(a.Description||'')}</textarea>
        </div>
        <div class="form-row"><label>Status</label>
          <select id="disc-status">${['Open','In Progress','Resolved','Cancelled'].map(s=>`<option ${s===a.Status?'selected':''}>${s}</option>`).join('')}</select></div>
        <div class="form-row"><label>Follow-up Date</label><input id="disc-fu" type="date" value="${esc(a.FollowUpDate||'')}"></div>
        <div class="form-row" style="grid-column:1/-1"><label>Resolution / Outcome</label><textarea id="disc-resolution" rows="2">${esc(a.Resolution||'')}</textarea></div>
        <div class="form-row" style="grid-column:1/-1"><label>Linked HR Form Template (optional)</label>
          <select id="disc-form"><option value="">— none —</option>${hrForms.map(t => `<option value="${t.TemplateID}" ${t.TemplateID===a.FormTemplateID?'selected':''}>${esc(t.Name)}</option>`).join('')}</select>
          <div class="cell-sub" style="margin-top:4px">Create HR templates in the <strong>HR Form Builder</strong> page first.</div></div>
        <div class="form-row" style="grid-column:1/-1"><label>Notes</label><textarea id="disc-notes" rows="2">${esc(a.Notes||'')}</textarea></div>

        ${actionId ? `<fieldset style="grid-column:1/-1;border:1px solid #e2e8f0;border-radius:8px;padding:12px">
          <legend style="font-size:12px;font-weight:700;color:#1E3A5F;padding:0 6px">📎 SUPPORTING DOCUMENTS</legend>
          <div class="flex gap-2 mb-1" style="align-items:center">
            <input type="file" id="disc-doc-file" style="flex:1">
            <button class="btn btn-primary btn-sm" onclick="discUploadDoc(${actionId})">⬆ Upload</button>
          </div>
          <div>${docList}</div>
        </fieldset>` : `<div class="cell-sub" style="grid-column:1/-1">Save the action first to attach documents.</div>`}
      </div>
      <div class="modal-footer" style="padding:14px 18px;border-top:1px solid #e2e8f0;display:flex;gap:8px">
        <button class="btn btn-ghost" onclick="document.getElementById('disc-modal').remove()">Close</button>
        ${actionId ? `<button class="btn btn-danger" onclick="discDelete(${actionId})">🗑 Delete</button>` : ''}
        <span style="flex:1"></span>
        <button class="btn btn-primary" onclick="discSave(${actionId||'null'})">${actionId?'💾 Save':'Create Action'}</button>
      </div>
    </div></div>`;
  document.getElementById('disc-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);
}

async function discSave(actionId) {
  const body = {
    EmpID: parseInt(val('disc-emp'),10),
    ActionType: val('disc-type'), Severity: val('disc-severity'),
    IssuedDate: val('disc-issued'), IssuedBy: val('disc-by'),
    Reason: val('disc-reason'), Description: val('disc-desc'),
    Status: val('disc-status'), FollowUpDate: val('disc-fu'),
    Resolution: val('disc-resolution'),
    FormTemplateID: parseInt(val('disc-form'),10) || null,
    Notes: val('disc-notes')
  };
  if (!body.EmpID || !body.Reason) { toast('Employee and Reason are required.', 'error'); return; }
  const r = actionId ? await api('PUT', '/api/disciplinary/' + actionId, body) : await POST('/api/disciplinary', body);
  if (!ok(r)) return;
  toast('Saved.');
  document.getElementById('disc-modal')?.remove();
  loadDisciplinary();
}

async function discUploadDoc(actionId) {
  const file = document.getElementById('disc-doc-file')?.files?.[0];
  if (!file) { toast('Pick a file first.', 'error'); return; }
  const fd = new FormData(); fd.append('file', file);
  const resp = await fetch('/api/disciplinary/' + actionId + '/documents', { method:'POST', body: fd });
  const r = await resp.json();
  if (!ok(r)) return;
  toast('Document uploaded.');
  discOpen(actionId);
}

async function discDelDoc(docId, actionId) {
  if (!confirm('Delete this document?')) return;
  const r = await api('DELETE', '/api/disciplinary/documents/' + docId);
  if (!ok(r)) return;
  toast('Deleted.');
  discOpen(actionId);
}

async function discDelete(actionId) {
  if (!confirm('Delete this action and all its documents?')) return;
  const r = await api('DELETE', '/api/disciplinary/' + actionId);
  if (!ok(r)) return;
  toast('Deleted.');
  document.getElementById('disc-modal')?.remove();
  loadDisciplinary();
}

// Ask the server's AI endpoint to draft a context-aware Description from the
// currently-selected Employee + Action Type + Reason. Confirms before overwriting non-empty text.
async function discAiDraft(actionId) {
  const empId = parseInt(val('disc-emp'),10);
  const type  = val('disc-type');
  const reason = val('disc-reason');
  if (!empId) { toast('Pick an employee first.', 'error'); return; }
  if (!type)  { toast('Pick an action type first.', 'error'); return; }
  const existing = val('disc-desc');
  if (existing && !confirm('This will replace the current description text. Continue?')) return;
  const statusEl = document.getElementById('disc-ai-status');
  if (statusEl) statusEl.textContent = '⏳ Drafting (reading leave + attendance + history)…';
  try {
    const r = await POST('/api/disciplinary/ai-draft', { EmpID: empId, ActionType: type, Reason: reason });
    if (!ok(r)) { if (statusEl) statusEl.textContent = ''; return; }
    const ta = document.getElementById('disc-desc');
    if (ta) ta.value = r.description || '';
    const ctx = r.contextUsed || {};
    if (statusEl) statusEl.textContent = `✓ Drafted · ${ctx.leaveOverEntitlement||0} leave breaches · ${ctx.recentActions||0} prior actions · ${ctx.recentAttendanceIssues||0} attendance exceptions used as context`;
  } catch (e) {
    if (statusEl) statusEl.textContent = '✕ AI draft failed';
  }
}

// ── HR FORM BUILDER ─────────────────────────────────────────────────────────
// Reuses the existing Form Builder pipeline via category=hr on /api/forms/templates.
// Listing + create-new live here; opening an existing template hands off to the
// main Form Builder UI with the FormCategory pinned to 'hr'.
let _hrfList = [];
async function loadHrForms() {
  const list = await GET('/api/forms/templates?category=hr');
  if (!ok(list)) return;
  _hrfList = list || [];
  hrfRender();
}
function hrfRender() {
  const host = document.getElementById('hrf-list');
  if (!host) return;
  const q = (val('hrf-search') || '').toLowerCase();
  let rows = _hrfList;
  if (q) rows = rows.filter(t => (t.Name||'').toLowerCase().includes(q));
  if (!rows.length) { host.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>No HR form templates yet. Click <strong>➕ New HR Form Template</strong>.</p></div>`; return; }
  host.innerHTML = `<table class="data-table"><thead><tr>
    <th>Name</th><th>Description</th><th>Fields</th><th>Submissions</th><th>Status</th><th></th>
  </tr></thead><tbody>${rows.map(t => `<tr>
    <td><strong>${esc(t.Name||'')}</strong></td>
    <td class="cell-sub">${esc(t.Description||'')}</td>
    <td>${t.FieldCount||0}</td>
    <td>${t.SubmissionCount||0}</td>
    <td><span class="badge ${t.Status==='Active'?'badge-active':'badge-inactive'}">${esc(t.Status||'')}</span></td>
    <td>
      <button class="btn btn-ghost btn-sm" onclick="hrfEdit(${t.TemplateID})">✏️ Edit</button>
      <button class="btn btn-danger btn-sm" onclick="hrfDelete(${t.TemplateID},'${esc(t.Name||'').replace(/'/g,"&#39;")}')">🗑</button>
    </td>
  </tr>`).join('')}</tbody></table>`;
}

// Tracks the calling page when we hand off to the Assessment Form Builder, so we can
// (a) show an HR banner and (b) provide a "← Back to HR Form Builder" link.
let _fbHrContext = null;

function hrfOpenNew() {
  const html = `<div class="modal-overlay" id="hrf-new-modal" onclick="if(event.target===this)this.remove()">
    <div class="modal" style="max-width:640px">
      <div class="modal-header"><h3>➕ New HR Form Template</h3><button class="btn btn-ghost btn-sm" onclick="document.getElementById('hrf-new-modal').remove()">✕</button></div>
      <div class="modal-body" style="padding:18px;display:flex;flex-direction:column;gap:12px">
        <div class="form-row"><label>Template Name *</label>
          <input id="hrf-new-name" placeholder='e.g. "Verbal Warning", "Performance Improvement Plan", "Exit Interview"'></div>
        <div class="form-row"><label>Description (optional)</label>
          <textarea id="hrf-new-desc" rows="2"></textarea></div>
        <fieldset style="border:1px solid #e2e8f0;border-radius:8px;padding:12px">
          <legend style="font-size:12px;font-weight:700;color:#1E3A5F;padding:0 6px">✨ AI ASSIST (OPTIONAL)</legend>
          <div class="form-row"><label>What action type / use case does this form support?</label>
            <select id="hrf-new-action">
              <option value="">— pick to enable AI field generation —</option>
              <option>Verbal Warning</option>
              <option>Written Warning</option>
              <option>Final Warning</option>
              <option>Performance Improvement Plan</option>
              <option>Leave Over-Entitlement</option>
              <option>Suspension</option>
              <option>Termination</option>
              <option>Exit Interview</option>
              <option>Performance Review</option>
              <option>Return-to-Work Interview</option>
              <option>Grievance</option>
              <option>Other</option>
            </select></div>
          <div class="form-row"><label>Extra requirements (optional)</label>
            <textarea id="hrf-new-prompt" rows="2" placeholder='e.g. "Include a section for witness statements and supervisor sign-off"'></textarea></div>
          <div class="cell-sub">When you click <strong>✨ Create with AI Fields</strong>, Claude drafts 8–15 logically-ordered fields (text / select / signature / etc.) based on the action type. The Assessment Form Builder opens with them pre-filled — edit / reorder / save.</div>
        </fieldset>
      </div>
      <div class="modal-footer" style="display:flex;gap:8px">
        <button class="btn btn-ghost" onclick="document.getElementById('hrf-new-modal').remove()">Cancel</button>
        <span style="flex:1"></span>
        <button class="btn btn-outline" onclick="hrfCreate(false)">📝 Create (Empty)</button>
        <button class="btn btn-accent" onclick="hrfCreate(true)">✨ Create with AI Fields</button>
      </div>
    </div></div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  setTimeout(() => document.getElementById('hrf-new-name')?.focus(), 30);
}

async function hrfCreate(useAi) {
  const name = (val('hrf-new-name') || '').trim();
  if (!name) { toast('Template name is required.', 'error'); return; }
  const description = val('hrf-new-desc');
  let aiFields = [];
  if (useAi) {
    const actionType = val('hrf-new-action');
    const prompt = val('hrf-new-prompt');
    toast('Drafting form fields with AI…');
    const r = await POST('/api/disciplinary/ai-form-fields', { formName: name, actionType, prompt });
    if (!ok(r)) return;
    aiFields = (r.fields || []).map((f, i) => ({
      FieldType: (f.FieldType || 'text').toLowerCase(),
      Label: f.Label || '',
      Required: f.Required ? 1 : 0,
      Options: Array.isArray(f.Options) ? f.Options : [],
      Points: 0,
      HelpText: f.HelpText || '',
      OrderNum: f.OrderNum != null ? f.OrderNum : (i + 1)
    }));
  }
  const body = { Name: name, Description: description, Status: 'Active', PassMark: 0, FormCategory: 'hr', fields: aiFields };
  const r = await POST('/api/forms/templates', body);
  if (!ok(r)) return;
  toast(`HR template created${aiFields.length?` with ${aiFields.length} AI-drafted fields`:''}. Opening builder…`);
  document.getElementById('hrf-new-modal')?.remove();
  await loadHrForms();
  hrfEdit(r.TemplateID);
}

async function hrfEdit(templateId) {
  // Stash context so the form-builder modal can show an HR banner + "back to HR" link
  _fbHrContext = { templateId, returnedAt: Date.now() };
  navigateTo('forms');
  // editForm is the existing Assessment Form Builder opener — same modal, full reuse
  if (typeof editForm === 'function') {
    await editForm(templateId);
    fbInjectHrBannerIfNeeded();
  } else {
    toast('Form Builder unavailable.', 'error');
  }
}

// Inject a one-line banner at the top of the form-builder modal body when an HR template is open.
// The banner has a "← Back to HR Form Builder" link and a chip identifying the template as HR.
function fbInjectHrBannerIfNeeded() {
  if (!_fbHrContext) return;
  const modal = document.getElementById('form-builder-modal');
  if (!modal) return;
  // Remove any prior banner from a previous edit
  modal.querySelector('.fb-hr-banner')?.remove();
  const body = modal.querySelector('.modal-body') || modal;
  const banner = document.createElement('div');
  banner.className = 'fb-hr-banner';
  banner.style.cssText = 'background:linear-gradient(135deg,#1E3A5F 0%,#2c5282 100%);color:#fff;padding:10px 14px;border-radius:8px;margin-bottom:12px;display:flex;align-items:center;gap:10px';
  banner.innerHTML = `<span style="background:#FBC02D;color:#1E3A5F;padding:3px 10px;border-radius:14px;font-weight:700;font-size:12px">🏷️ HR FORM</span>
    <span>This template lives in <strong>HR Form Builder</strong> — saving keeps it categorised as HR.</span>
    <span style="flex:1"></span>
    <button class="btn btn-ghost btn-sm" style="color:#fff;border:1px solid rgba(255,255,255,0.4)" onclick="hrfReturnToBuilder()">← Back to HR Form Builder</button>`;
  body.insertBefore(banner, body.firstChild);
}

function hrfReturnToBuilder() {
  // Close the form-builder modal then jump back to the HR list
  closeModal && closeModal('form-builder-modal');
  document.querySelector('#form-builder-modal')?.classList.remove('active');
  _fbHrContext = null;
  navigateTo('hr-forms');
}

async function hrfDelete(templateId, name) {
  if (!confirm(`Delete HR form template "${name}"? Existing submissions are kept.`)) return;
  const r = await api('DELETE', '/api/forms/templates/' + templateId);
  if (!ok(r)) return;
  toast('Deleted.');
  loadHrForms();
}
