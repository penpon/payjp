/**
 * Phase A admin UI — read-only. No mutation calls.
 * API base: same origin (nginx /admin/*) or VITE_ADMIN_API_BASE.
 */
import './admin.css';

const API_BASE = (import.meta.env.VITE_ADMIN_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

async function apiGet<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

type Overview = {
  ok: true;
  membersByStatus: Record<string, number>;
  unresolvedImpactCount: number;
  inflightMemberCount: number;
};

type MemberRow = {
  id: string;
  email: string;
  discord_user_id: string | null;
  subscription_status: string | null;
  payjp_plan_id: string | null;
  role_state: string;
  created_at: string;
  last_synced_at: string;
  inflight_operation_id: string | null;
  unresolved_impact_count: number;
};

type MembersResponse = { ok: true; members: MemberRow[]; total: number; page: number; limit: number };

type MemberDetailResponse = {
  ok: true;
  member: MemberRow & {
    payjp_customer_id: string | null;
    payjp_subscription_id: string | null;
    access_end_at: string | null;
    next_billing_at: string | null;
    cancel_requested_at: string | null;
    inflight_operation_type: string | null;
    inflight_operation_started_at: string | null;
    inflight_subscribe_plan_id: string | null;
    privacy_consented_at: string | null;
    updated_at: string;
  };
};

type ImpactResponse = {
  ok: true;
  impactLogs: Array<{
    id: string;
    issue_code: string;
    operation_id: string | null;
    resolved_at: string | null;
    created_at: string;
    detail: unknown;
  }>;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> | null,
  children: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === 'className') node.className = v;
      else node.setAttribute(k, v);
    }
  }
  for (const c of children) {
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function parseHash(): { route: 'overview' | 'members' | 'member'; id?: string } {
  const h = window.location.hash.replace(/^#/, '') || 'overview';
  if (h === 'overview' || h === '') return { route: 'overview' };
  if (h === 'members') return { route: 'members' };
  const m = /^member\/([0-9a-f-]+)$/i.exec(h);
  if (m) return { route: 'member', id: m[1] };
  return { route: 'overview' };
}

function navLink(label: string, hash: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = `#${hash}`;
  a.textContent = label;
  return a;
}

async function renderOverview(root: HTMLElement): Promise<void> {
  const data = await apiGet<Overview>('/admin/overview');
  const statusList = el('ul', null, []);
  for (const [k, v] of Object.entries(data.membersByStatus)) {
    statusList.appendChild(el('li', null, [`${k}: ${String(v)}`]));
  }
  root.replaceChildren(
    el('main', null, [
      el('h2', null, ['概要']),
      statusList,
      el('p', { className: 'row-muted' }, [
        `未解決影響ログ: ${data.unresolvedImpactCount} / inflight 会員: ${data.inflightMemberCount}`,
      ]),
    ]),
  );
}

async function renderMembers(root: HTMLElement): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const q = params.get('q') ?? '';
  const subscription_status = params.get('subscription_status') ?? '';
  const role_state = params.get('role_state') ?? '';
  const has_inflight = params.get('has_inflight') ?? '';

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (subscription_status) qs.set('subscription_status', subscription_status);
  if (role_state) qs.set('role_state', role_state);
  if (has_inflight) qs.set('has_inflight', has_inflight);
  qs.set('limit', '50');
  qs.set('page', '1');

  const data = await apiGet<MembersResponse>(`/admin/members?${qs.toString()}`);

  const form = document.createElement('form');
  form.className = 'toolbar';
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const p = new URLSearchParams();
    for (const [k, v] of fd.entries()) {
      if (typeof v === 'string' && v.length > 0) p.set(k, v);
    }
    const qs = p.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}#members`);
    void render();
  });
  const qIn = document.createElement('input');
  qIn.name = 'q';
  qIn.placeholder = '検索';
  qIn.value = q;
  form.appendChild(qIn);
  const st = document.createElement('select');
  st.name = 'subscription_status';
  st.innerHTML =
    '<option value="">status (all)</option><option>active</option><option>trial</option><option>canceled</option><option>paused</option>';
  st.value = subscription_status;
  form.appendChild(st);
  const rs = document.createElement('select');
  rs.name = 'role_state';
  rs.innerHTML =
    '<option value="">role (all)</option><option>granted</option><option>revoked</option><option>unknown</option>';
  rs.value = role_state;
  form.appendChild(rs);
  const inf = document.createElement('select');
  inf.name = 'has_inflight';
  inf.innerHTML =
    '<option value="">inflight (all)</option><option value="true">あり</option><option value="false">なし</option>';
  inf.value = has_inflight;
  form.appendChild(inf);
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'primary';
  submit.textContent = '検索';
  form.appendChild(submit);

  const headRow = el('tr', null, []);
  for (const t of ['メール', 'member_id', 'Discord', 'status', 'plan', 'role', 'inflight', '未解決', '']) {
    headRow.appendChild(el('th', null, [t]));
  }
  const tbody = el('tbody', null, []);
  for (const m of data.members) {
    const tr = el('tr', null, [
      el('td', null, [m.email]),
      el('td', { className: 'row-muted' }, [`${m.id.slice(0, 8)}…`]),
      el('td', { className: 'row-muted' }, [m.discord_user_id ?? '—']),
      el('td', null, [m.subscription_status ?? '—']),
      el('td', null, [m.payjp_plan_id ?? '—']),
      el('td', null, [m.role_state]),
      el('td', null, [m.inflight_operation_id ? 'あり' : '—']),
      el('td', null, [String(m.unresolved_impact_count)]),
      el('td', null, [navLink('詳細', `member/${m.id}`)]),
    ]);
    tbody.appendChild(tr);
  }
  const table = el('table', null, [el('thead', null, [headRow]), tbody]);

  root.replaceChildren(
    el('main', null, [
      el('h2', null, ['会員一覧']),
      el('p', { className: 'row-muted' }, [`total: ${data.total}（read-only）`]),
      form,
      table,
    ]),
  );
}

async function renderMember(root: HTMLElement, id: string): Promise<void> {
  const [detail, impacts] = await Promise.all([
    apiGet<MemberDetailResponse>(`/admin/members/${id}`),
    apiGet<ImpactResponse>(`/admin/members/${id}/impact-logs?resolved=all`),
  ]);
  const m = detail.member;
  const dl = el('dl', { className: 'grid' }, []);
  const rows: [string, string][] = [
    ['member_id', m.id],
    ['email', m.email],
    ['discord_user_id', m.discord_user_id ?? '—'],
    ['subscription_status', m.subscription_status ?? '—'],
    ['payjp_plan_id', m.payjp_plan_id ?? '—'],
    ['payjp_customer_id', m.payjp_customer_id ?? '—'],
    ['payjp_subscription_id', m.payjp_subscription_id ?? '—'],
    ['access_end_at', m.access_end_at ?? '—'],
    ['next_billing_at', m.next_billing_at ?? '—'],
    ['cancel_requested_at', m.cancel_requested_at ?? '—'],
    ['role_state', m.role_state],
    ['last_synced_at', m.last_synced_at],
    ['inflight_operation_id', m.inflight_operation_id ?? '—'],
    ['inflight_operation_type', m.inflight_operation_type ?? '—'],
    ['inflight_operation_started_at', m.inflight_operation_started_at ?? '—'],
    ['inflight_subscribe_plan_id', m.inflight_subscribe_plan_id ?? '—'],
    ['未解決影響件数', String(m.unresolved_impact_count)],
  ];
  for (const [k, v] of rows) {
    dl.appendChild(el('dt', null, [k]));
    dl.appendChild(el('dd', null, [v]));
  }

  const ihead = el('tr', null, []);
  for (const t of ['created', 'issue', 'operationId', 'resolved']) {
    ihead.appendChild(el('th', null, [t]));
  }
  const ibody = el('tbody', null, []);
  for (const r of impacts.impactLogs) {
    ibody.appendChild(
      el('tr', null, [
        el('td', { className: 'row-muted' }, [r.created_at]),
        el('td', null, [r.issue_code]),
        el('td', { className: 'row-muted' }, [r.operation_id ?? '—']),
        el('td', null, [r.resolved_at ?? '—']),
      ]),
    );
  }
  const impactTable = el('table', null, [el('thead', null, [ihead]), ibody]);

  root.replaceChildren(
    el('main', null, [
      el('p', null, [navLink('← 一覧', 'members')]),
      el('h2', null, ['会員詳細']),
      dl,
      el('h3', null, ['影響ログ（直近500件）']),
      impactTable,
    ]),
  );
}

async function render(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;
  const { route, id } = parseHash();
  app.replaceChildren(
    el('header', null, [
      el('strong', null, ['Admin（読取専用）']),
      el('span', { className: 'badge' }, ['Phase A']),
      el('nav', null, [navLink('概要', 'overview'), document.createTextNode(' '), navLink('会員', 'members')]),
    ]),
  );
  const mainWrap = el('div', { id: 'main-root' }, []);
  app.appendChild(mainWrap);
  try {
    if (route === 'overview') await renderOverview(mainWrap);
    else if (route === 'members') await renderMembers(mainWrap);
    else if (route === 'member' && id) await renderMember(mainWrap, id);
    else await renderOverview(mainWrap);
  } catch (e) {
    mainWrap.replaceChildren(el('p', { className: 'error' }, [e instanceof Error ? e.message : String(e)]));
  }
}

window.addEventListener('hashchange', () => {
  void render();
});
void render();
